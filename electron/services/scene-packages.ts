import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import unzipper from 'unzipper';
import type { PhotoshopProjectMetadata, PhotoshopVersionRecord } from '../../src/types.js';
import { EMPTY_PHOTOSHOP_PROJECT_METADATA, normalizePhotoshopProjectMetadata } from '../../src/shared/photoshopVersions.js';

interface ScenePackageServices {
  assetRegistry: Map<string, any>;
  assetCachePath(record: any): string;
  ensureAssetFile(id: string): Promise<string>;
  extByMime: Record<string, string>;
  limits?: Partial<ScenePackageLimits>;
}

export interface ScenePackageLimits {
  manifestBytes: number;
  assetCount: number;
  singleAssetBytes: number;
  totalAssetBytes: number;
}

const DEFAULT_SCENE_PACKAGE_LIMITS: ScenePackageLimits = {
  manifestBytes: 16 * 1024 * 1024,
  assetCount: 10_000,
  singleAssetBytes: 200 * 1024 * 1024,
  totalAssetBytes: 4 * 1024 * 1024 * 1024,
};

export function createScenePackages({ assetRegistry, assetCachePath, ensureAssetFile, extByMime, limits }: ScenePackageServices) {
  const packageLimits = { ...DEFAULT_SCENE_PACKAGE_LIMITS, ...limits };
  async function mapWithConcurrency<T>(values: T[], mapper: (value: T) => Promise<void>, concurrency = 2) {
    let cursor = 0;
    let failure: unknown;
    const run = async () => {
      while (cursor < values.length && !failure) {
        const index = cursor++;
        try { await mapper(values[index]); }
        catch (error) { failure ??= error; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, run));
    if (failure) throw failure;
  }

  async function readEntryBuffer(entry: any, maximumBytes: number, label: string) {
    if (Number.isFinite(entry.uncompressedSize) && entry.uncompressedSize > maximumBytes) {
      throw new Error(`${label}超过大小限制`);
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of entry.stream()) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maximumBytes) throw new Error(`${label}超过大小限制`);
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, bytes);
  }

  async function fileDigest(filePath: string, maximumBytes: number) {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(filePath)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maximumBytes) return undefined;
      hash.update(buffer);
    }
    return { bytes, hash: hash.digest('hex') };
  }

  async function installVerifiedAsset(temporaryPath: string, cachePath: string, expectedHash: string, bytes: number) {
    try {
      const existing = await fileDigest(cachePath, bytes);
      if (existing?.bytes === bytes && existing.hash === expectedHash) {
        await fs.rm(temporaryPath, { force: true });
        return;
      }
    } catch { /* Missing or unreadable cache entries are replaced below. */ }
    const backupPath = `${cachePath}.${process.pid}.${Date.now()}.bak`;
    let hasBackup = false;
    try {
      try { await fs.rename(cachePath, backupPath); hasBackup = true; }
      catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
      await fs.rename(temporaryPath, cachePath);
    } catch (error) {
      if (hasBackup) await fs.rename(backupPath, cachePath).catch(() => undefined);
      throw error;
    }
    if (hasBackup) await fs.rm(backupPath, { force: true }).catch(() => undefined);
  }
  function serializableScene(scene: any, metadata: PhotoshopProjectMetadata = EMPTY_PHOTOSHOP_PROJECT_METADATA) {
    const normalizedMetadata = normalizePhotoshopProjectMetadata(metadata);
    const usedAssets = new Set([
      ...scene.items.flatMap((item) => item.assetId ? [item.assetId] : []),
      ...normalizedMetadata.versions.map((version) => version.previewAssetId),
    ]);
    const availableAssets = { ...scene.assets };
    normalizedMetadata.versions.forEach((version) => { availableAssets[version.previewAssetId] = version.previewAsset; });
    return {
      ...scene, version: 3,
      photoshopProject: normalizedMetadata,
      assets: Object.fromEntries(Object.entries(availableAssets).filter(([id]) => usedAssets.has(id))),
      items: scene.items.map(({ dataUrl: _dataUrl, ...item }) => item),
    };
  }

  async function writeScenePackage(
    filePath: string,
    scene: any,
    metadata: PhotoshopProjectMetadata = EMPTY_PHOTOSHOP_PROJECT_METADATA,
    versionFiles: ReadonlyMap<string, string> = new Map(),
    versionSourcePath = filePath,
  ) {
    const manifest = serializableScene(scene, metadata);
    const tempPath = `${filePath}.${process.pid}.tmp`;
    const output = createWriteStream(tempPath);
    const archive = new ZipArchive({ zlib: { level: 0 }, forceZip64: true } as any);
    const completed = new Promise<void>((resolve, reject) => {
      output.once('close', resolve); output.once('error', reject); archive.once('error', reject);
    });
    try {
      archive.pipe(output);
      archive.append(JSON.stringify(manifest), { name: 'manifest.json' });
      for (const record of Object.values(manifest.assets ?? {}) as any[]) {
        const assetPath = await ensureAssetFile(record.id);
        archive.file(assetPath, { name: `assets/${record.id}${extByMime[record.mimeType] ?? '.bin'}`, store: true } as any);
      }
      let existingDirectory: Awaited<ReturnType<typeof unzipper.Open.file>> | undefined;
      if ((manifest.photoshopProject?.versions.length ?? 0) > versionFiles.size) {
        try { existingDirectory = await unzipper.Open.file(versionSourcePath); } catch { /* A new project has no previous archive. */ }
      }
      for (const version of manifest.photoshopProject?.versions ?? []) {
        const sourcePath = versionFiles.get(version.id);
        if (sourcePath) {
          archive.file(sourcePath, { name: version.archiveEntry, store: true } as any);
          continue;
        }
        const entry = existingDirectory?.files.find((value) => value.path === version.archiveEntry);
        if (!entry) throw new Error(`画板缺少 Photoshop 版本数据：${version.name}`);
        archive.append(entry.stream(), { name: version.archiveEntry, store: true } as any);
      }
      await archive.finalize();
      await completed;
    } catch (error) {
      void completed.catch(() => undefined);
      archive.abort();
      output.destroy();
      // On Windows the stream may still create/hold the file after destroy().
      // Wait for its close event before removing the incomplete package.
      await completed.catch(() => undefined);
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
    const backupPath = `${filePath}.bak`;
    let hadOriginal = false;
    try { await fs.rename(filePath, backupPath); hadOriginal = true; } catch { /* New file. */ }
    try {
      await fs.rename(tempPath, filePath);
      if (hadOriginal) await fs.rm(backupPath, { force: true });
    } catch (error) {
      if (hadOriginal) await fs.rename(backupPath, filePath).catch(() => undefined);
      await fs.rm(tempPath, { force: true });
      throw error;
    }
  }

  async function readScenePackage(filePath: string, options: { registerAssets?: boolean } = {}) {
    const registerAssets = options.registerAssets !== false;
    let directory;
    try { directory = await unzipper.Open.file(filePath); }
    catch { throw new Error('该文件不是新版 Yoiniwa 画板，旧版场景格式已不受支持'); }
    const manifestEntry = directory.files.find((entry) => entry.path === 'manifest.json');
    if (!manifestEntry) throw new Error('场景包缺少 manifest.json');
    const manifestBuffer = await readEntryBuffer(manifestEntry, packageLimits.manifestBytes, '场景清单');
    let scene;
    try { scene = JSON.parse(manifestBuffer.toString('utf8')); }
    catch { throw new Error('场景清单不是有效的 JSON'); }
    if (scene?.format !== 'refcanvas' || ![1, 2, 3].includes(scene?.version)) throw new Error('该场景版本不受支持');
    if (!scene.assets || typeof scene.assets !== 'object' || Array.isArray(scene.assets)) scene.assets = {};
    const records = Object.values(scene.assets ?? {}) as any[];
    if (records.length > packageLimits.assetCount) throw new Error('场景资源数量超过限制');
    let declaredTotalBytes = 0;
    records.forEach((record) => {
      if (!record || !Number.isSafeInteger(record.byteLength) || record.byteLength < 1) throw new Error('场景包含无效的资源大小');
      if (record.byteLength > packageLimits.singleAssetBytes) throw new Error(`场景资源超过单项大小限制：${record.id ?? 'unknown'}`);
      declaredTotalBytes += record.byteLength;
      if (!Number.isSafeInteger(declaredTotalBytes) || declaredTotalBytes > packageLimits.totalAssetBytes) {
        throw new Error('场景资源总大小超过限制');
      }
    });
    const verifiedAssets: Array<{ record: any; entryPath: string; cachePath: string }> = [];
    let actualTotalBytes = 0;
    await mapWithConcurrency(records, async (record) => {
      if (!/^[a-f0-9]{64}$/i.test(record.id) || record.id !== record.hash) throw new Error('场景包含无效的资源标识');
      const entryPath = `assets/${record.id}${extByMime[record.mimeType] ?? '.bin'}`;
      const entry = directory.files.find((value) => value.path === entryPath);
      if (!entry) throw new Error(`场景包缺少资源：${record.id}`);
      if (Number.isFinite((entry as any).uncompressedSize) && (entry as any).uncompressedSize > packageLimits.singleAssetBytes) {
        throw new Error(`场景资源超过单项大小限制：${record.id}`);
      }
      const cachePath = assetCachePath(record);
      const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      const hash = createHash('sha256');
      let bytes = 0;
      const verify = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        actualTotalBytes += chunk.length;
        if (bytes > packageLimits.singleAssetBytes || bytes > record.byteLength) {
          callback(new Error(`场景资源解压大小超过声明：${record.id}`)); return;
        }
        if (actualTotalBytes > packageLimits.totalAssetBytes) {
          callback(new Error('场景资源实际解压总大小超过限制')); return;
        }
        hash.update(chunk); callback(undefined, chunk);
      } });
      try {
        await pipeline(entry.stream(), verify, createWriteStream(temporaryPath, { flags: 'wx' }));
        if (bytes !== record.byteLength || hash.digest('hex') !== record.hash) throw new Error(`场景资源校验失败：${record.id}`);
        await installVerifiedAsset(temporaryPath, cachePath, record.hash, bytes);
        verifiedAssets.push({ record, entryPath, cachePath });
      } finally {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    }, 2);
    if (registerAssets) {
      verifiedAssets.forEach(({ record }) => {
        const existing = assetRegistry.get(record.id)?.record;
        if (existing && (
          existing.hash !== record.hash
          || existing.byteLength !== record.byteLength
          || existing.mimeType !== record.mimeType
          || existing.naturalWidth !== record.naturalWidth
          || existing.naturalHeight !== record.naturalHeight
        )) throw new Error(`资源元数据冲突：${record.id}`);
      });
      verifiedAssets.forEach(({ record, entryPath, cachePath }) => {
        assetRegistry.set(record.id, { record, cachePath, archivePath: filePath, entryPath });
      });
    }
    const metadata = normalizePhotoshopProjectMetadata(scene.photoshopProject);
    delete scene.photoshopProject;
    for (const version of metadata.versions) {
      const previewRecord = scene.assets?.[version.previewAssetId];
      if (!previewRecord || previewRecord.hash !== version.previewAsset.hash
        || previewRecord.byteLength !== version.previewAsset.byteLength
        || previewRecord.mimeType !== version.previewAsset.mimeType) {
        throw new Error(`场景包缺少 Photoshop 版本预览：${version.name}`);
      }
      const entry = directory.files.find((value) => value.path === version.archiveEntry);
      if (!entry) throw new Error(`场景包缺少 Photoshop 版本：${version.name}`);
      const declared = Number((entry as any).uncompressedSize);
      if (Number.isFinite(declared) && declared !== version.byteLength) throw new Error(`Photoshop 版本大小不匹配：${version.name}`);
    }
    return { scene, metadata };
  }

  async function readSceneAssetIds(filePath: string) {
    let directory;
    try { directory = await unzipper.Open.file(filePath); }
    catch { throw new Error('无法读取最近工程资源索引'); }
    const manifestEntry = directory.files.find((entry) => entry.path === 'manifest.json');
    if (!manifestEntry) throw new Error('场景包缺少 manifest.json');
    const manifestBuffer = await readEntryBuffer(manifestEntry, packageLimits.manifestBytes, '场景清单');
    let scene: any;
    try { scene = JSON.parse(manifestBuffer.toString('utf8')); }
    catch { throw new Error('场景清单不是有效的 JSON'); }
    if (scene?.format !== 'refcanvas' || ![1, 2, 3].includes(scene?.version)) throw new Error('该场景版本不受支持');
    const ids = Object.keys(scene.assets ?? {});
    if (ids.length > packageLimits.assetCount || ids.some((id) => !/^[a-f0-9]{64}$/i.test(id))) {
      throw new Error('场景资源索引无效');
    }
    return ids;
  }

  async function registerRecoveredSceneAssets(scene: any) {
    const records = Object.values(scene?.assets ?? {}) as any[];
    await Promise.all(records.map(async (record) => {
      if (!record || !/^[a-f0-9]{64}$/i.test(record.id) || record.id !== record.hash) return;
      const cachePath = assetCachePath(record);
      try {
        const stat = await fs.stat(cachePath);
        if (stat.size !== record.byteLength) return;
        assetRegistry.set(record.id, { record, cachePath });
      } catch { /* Missing cache entries are handled as unavailable individual images. */ }
    }));
  }

  async function extractPhotoshopVersion(filePath: string, version: PhotoshopVersionRecord, targetPath: string) {
    const directory = await unzipper.Open.file(filePath);
    const entry = directory.files.find((value) => value.path === version.archiveEntry);
    if (!entry) throw new Error(`画板缺少 Photoshop 版本：${version.name}`);
    const hash = createHash('sha256');
    let bytes = 0;
    const verify = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > version.byteLength) { callback(new Error(`Photoshop 版本大小超过记录：${version.name}`)); return; }
      hash.update(chunk); callback(undefined, chunk);
    } });
    try {
      await pipeline(entry.stream(), verify, createWriteStream(targetPath, { flags: 'wx' }));
      if (bytes !== version.byteLength || hash.digest('hex') !== version.sha256) throw new Error(`Photoshop 版本校验失败：${version.name}`);
      return targetPath;
    } catch (error) {
      await fs.rm(targetPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  return { serializableScene, writeScenePackage, readScenePackage, readSceneAssetIds, registerRecoveredSceneAssets, extractPhotoshopVersion };
}
