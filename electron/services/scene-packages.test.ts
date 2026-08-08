import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ZipArchive } from 'archiver';
import { createScenePackages, type ScenePackageLimits } from './scene-packages';

const temporaryDirectories: string[] = [];
const defaultLimits: ScenePackageLimits = {
  manifestBytes: 4096,
  assetCount: 3,
  singleAssetBytes: 8,
  totalAssetBytes: 12,
};

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'refcanvas-scene-package-'));
  temporaryDirectories.push(directory);
  return directory;
}

function assetRecord(buffer: Buffer) {
  const hash = createHash('sha256').update(buffer).digest('hex');
  return { id: hash, hash, mimeType: 'application/octet-stream', byteLength: buffer.length, naturalWidth: 1, naturalHeight: 1, originalName: 'asset.bin' };
}

async function writePackage(filePath: string, manifest: any, assets: Array<{ record: any; buffer: Buffer }> = []) {
  const output = createWriteStream(filePath);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const done = new Promise<void>((resolve, reject) => {
    output.once('close', resolve);
    output.once('error', reject);
    archive.once('error', reject);
  });
  archive.pipe(output);
  archive.append(JSON.stringify(manifest), { name: 'manifest.json' });
  assets.forEach(({ record, buffer }) => archive.append(buffer, { name: `assets/${record.id}.bin` }));
  await archive.finalize();
  await done;
}

function packageReader(cacheDirectory: string, limits: Partial<ScenePackageLimits> = {}) {
  return createScenePackages({
    assetRegistry: new Map(),
    assetCachePath: (record) => path.join(cacheDirectory, `${record.id}.bin`),
    ensureAssetFile: async () => { throw new Error('not used'); },
    extByMime: { 'application/octet-stream': '.bin' },
    limits: { ...defaultLimits, ...limits },
  }).readScenePackage;
}

function manifest(records: any[] = [], extra: Record<string, unknown> = {}) {
  return {
    format: 'refcanvas', version: 2, items: [],
    assets: Object.fromEntries(records.map((record, index) => [`asset-${index}`, record])),
    ...extra,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('scene package extraction limits', () => {
  it('accepts a version-one package so the renderer migration boundary can upgrade it', async () => {
    const directory = await temporaryDirectory();
    const filePath = path.join(directory, 'version-one.refcanvas');
    await writePackage(filePath, manifest([], { version: 1 }));
    await expect(packageReader(path.join(directory, 'cache'))(filePath)).resolves.toMatchObject({ scene: { version: 1 }, metadata: { versions: [] } });
  });

  it('reads the recent-project asset index without extracting source images', async () => {
    const directory = await temporaryDirectory();
    const cacheDirectory = path.join(directory, 'cache');
    const filePath = path.join(directory, 'recent.refcanvas');
    const buffer = Buffer.from('asset');
    const record = assetRecord(buffer);
    await writePackage(filePath, {
      format: 'refcanvas', version: 2, items: [], assets: { [record.id]: record },
    }, [{ record, buffer }]);
    const packages = createScenePackages({
      assetRegistry: new Map(),
      assetCachePath: (value) => path.join(cacheDirectory, `${value.id}.bin`),
      ensureAssetFile: async () => { throw new Error('not used'); },
      extByMime: { 'application/octet-stream': '.bin' },
      limits: defaultLimits,
    });
    await expect(packages.readSceneAssetIds(filePath)).resolves.toEqual([record.id]);
    await expect(fs.stat(cacheDirectory)).rejects.toThrow();
  });

  it('rejects a manifest whose expanded content exceeds the limit', async () => {
    const directory = await temporaryDirectory();
    const filePath = path.join(directory, 'large-manifest.refcanvas');
    await writePackage(filePath, manifest([], { padding: 'x'.repeat(512) }));
    await expect(packageReader(path.join(directory, 'cache'), { manifestBytes: 128 })(filePath)).rejects.toThrow('场景清单超过大小限制');
  });

  it('rejects excessive asset counts and declared single or total sizes', async () => {
    const directory = await temporaryDirectory();
    const countPath = path.join(directory, 'count.refcanvas');
    const records = Array.from({ length: 4 }, () => assetRecord(Buffer.from('a')));
    await writePackage(countPath, manifest(records));
    await expect(packageReader(path.join(directory, 'cache'))(countPath)).rejects.toThrow('资源数量超过限制');

    const singlePath = path.join(directory, 'single.refcanvas');
    await writePackage(singlePath, manifest([{ ...records[0], byteLength: 9 }]));
    await expect(packageReader(path.join(directory, 'cache'))(singlePath)).rejects.toThrow('单项大小限制');

    const totalPath = path.join(directory, 'total.refcanvas');
    await writePackage(totalPath, manifest([{ ...records[0], byteLength: 7 }, { ...records[0], id: 'b'.repeat(64), hash: 'b'.repeat(64), byteLength: 7 }]));
    await expect(packageReader(path.join(directory, 'cache'))(totalPath)).rejects.toThrow('总大小超过限制');
  });

  it('stops streaming when actual resource data exceeds its declaration', async () => {
    const directory = await temporaryDirectory();
    const filePath = path.join(directory, 'expanded.refcanvas');
    const buffer = Buffer.from('four');
    const record = { ...assetRecord(buffer), byteLength: 3 };
    await writePackage(filePath, manifest([record]), [{ record, buffer }]);
    await expect(packageReader(path.join(directory, 'cache'))(filePath)).rejects.toThrow('解压大小超过声明');
  });

  it('accepts a valid boundary-sized resource', async () => {
    const directory = await temporaryDirectory();
    const filePath = path.join(directory, 'valid.refcanvas');
    const buffer = Buffer.from('12345678');
    const record = assetRecord(buffer);
    await writePackage(filePath, manifest([record]), [{ record, buffer }]);
    await expect(packageReader(path.join(directory, 'cache'))(filePath)).resolves.toMatchObject({ scene: { format: 'refcanvas', version: 2 } });
  });

  it('replaces a same-sized corrupt cache entry with the verified package asset', async () => {
    const directory = await temporaryDirectory();
    const cacheDirectory = path.join(directory, 'cache');
    await fs.mkdir(cacheDirectory);
    const filePath = path.join(directory, 'repair.refcanvas');
    const buffer = Buffer.from('good');
    const record = assetRecord(buffer);
    const cachePath = path.join(cacheDirectory, `${record.id}.bin`);
    await fs.writeFile(cachePath, Buffer.from('evil'));
    await writePackage(filePath, manifest([record]), [{ record, buffer }]);
    await packageReader(cacheDirectory)(filePath);
    await expect(fs.readFile(cachePath)).resolves.toEqual(buffer);
  });

  it('preserves an existing project and removes temporary output when packaging fails', async () => {
    const directory = await temporaryDirectory();
    const filePath = path.join(directory, 'existing.refcanvas');
    const original = Buffer.from('original-project');
    await fs.writeFile(filePath, original);
    const record = assetRecord(Buffer.from('asset'));
    const packages = createScenePackages({
      assetRegistry: new Map(),
      assetCachePath: (value) => path.join(directory, `${value.id}.bin`),
      ensureAssetFile: async () => { throw new Error('source unavailable'); },
      extByMime: { 'application/octet-stream': '.bin' }, limits: defaultLimits,
    });
    const failingScene = manifest([record], { items: [{ id: 'image', assetId: 'asset-0' }] });
    await expect(packages.writeScenePackage(filePath, failingScene)).rejects.toThrow('source unavailable');
    await expect(fs.readFile(filePath)).resolves.toEqual(original);
    await expect(fs.stat(`${filePath}.${process.pid}.tmp`)).rejects.toThrow();
  });

  it('embeds, verifies and preserves a layered Photoshop version across ordinary saves', async () => {
    const directory = await temporaryDirectory();
    const filePath = path.join(directory, 'versions.refcanvas');
    const cacheDirectory = path.join(directory, 'cache');
    await fs.mkdir(cacheDirectory);
    const previewBuffer = Buffer.from('preview');
    const preview = assetRecord(previewBuffer);
    const previewPath = path.join(cacheDirectory, `${preview.id}.bin`);
    await fs.writeFile(previewPath, previewBuffer);
    const layeredBuffer = Buffer.from('layered-photoshop-document');
    const layeredPath = path.join(directory, 'source.psd');
    await fs.writeFile(layeredPath, layeredBuffer);
    const id = '12345678-1234-1234-1234-123456789012';
    const metadata = { versions: [{
      id, name: 'v001', createdAt: '2026-08-08T00:00:00.000Z', documentName: 'painting.psd',
      width: 10, height: 20, colorMode: 'RGB', bitDepth: 8, layerCount: 4, format: 'psd' as const,
      byteLength: layeredBuffer.length, sha256: createHash('sha256').update(layeredBuffer).digest('hex'),
      archiveEntry: `photoshop-versions/${id}.psd`, previewAssetId: preview.id, previewAsset: preview,
    }] };
    const packages = createScenePackages({
      assetRegistry: new Map(), assetCachePath: (value) => path.join(cacheDirectory, `${value.id}.bin`),
      ensureAssetFile: async (assetId) => path.join(cacheDirectory, `${assetId}.bin`),
      extByMime: { 'application/octet-stream': '.bin' }, limits: defaultLimits,
    });
    const scene = manifest([preview], { assets: { [preview.id]: preview } });
    await packages.writeScenePackage(filePath, scene, metadata, new Map([[id, layeredPath]]));
    const opened = await packages.readScenePackage(filePath);
    expect(opened.metadata.versions).toHaveLength(1);
    await packages.writeScenePackage(filePath, opened.scene, opened.metadata);
    const extractedPath = path.join(directory, 'extracted.psd');
    await packages.extractPhotoshopVersion(filePath, opened.metadata.versions[0], extractedPath);
    await expect(fs.readFile(extractedPath)).resolves.toEqual(layeredBuffer);

    const saveAsPath = path.join(directory, 'versions-copy.refcanvas');
    await packages.writeScenePackage(saveAsPath, opened.scene, opened.metadata, new Map(), filePath);
    const copiedVersionPath = path.join(directory, 'copied.psd');
    await packages.extractPhotoshopVersion(saveAsPath, opened.metadata.versions[0], copiedVersionPath);
    await expect(fs.readFile(copiedVersionPath)).resolves.toEqual(layeredBuffer);

    const missingPreviewPath = path.join(directory, 'missing-preview.refcanvas');
    await writePackage(missingPreviewPath, manifest([], { version: 3, photoshopProject: metadata }));
    await expect(packages.readScenePackage(missingPreviewPath)).rejects.toThrow('缺少 Photoshop 版本预览');
  });
});
