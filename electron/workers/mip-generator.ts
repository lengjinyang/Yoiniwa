import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { AssetRecord } from '../../src/types.js';
import {
  IMAGE_CACHE_DIRECTORY, IMAGE_CACHE_FORMAT_VERSION, IMAGE_MIP_EDGES, IMAGE_TILE_GUTTER, IMAGE_TILE_SIZE, IMAGE_TILE_THRESHOLD_EDGE,
  LARGE_IMAGE_TILE_EDGE, MIP_ALGORITHM_VERSION,
} from '../../src/shared/imagePipelineConfig.js';
import type { DiskMipLevel, DiskTileLevel, ImagePyramidManifest } from '../services/image-pyramid-manifest.js';

interface BuildOptions {
  cacheRoot: string;
  assetId: string;
  input: string | Buffer;
  record: AssetRecord;
  report(stage: 'decode' | 'mip' | 'commit', progress: number): void;
  isCanceled?(): boolean;
}

const MAX_SINGLE_DECODE_BYTES = 512 * 1024 * 1024;

function dimensionsForEdge(width: number, height: number, edge: number) {
  const scale = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function encodeWebp(pipeline: sharp.Sharp) {
  return pipeline.webp({ quality: 88, alphaQuality: 100, smartSubsample: true, effort: 4 }).toBuffer();
}

async function writeVerifiedWebp(filePath: string, encoded: Buffer, expected: { width: number; height: number }) {
  const metadata = await sharp(encoded).metadata();
  if (metadata.format !== 'webp' || metadata.width !== expected.width || metadata.height !== expected.height) {
    throw new Error(`Mip 校验失败：${path.basename(filePath)}`);
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, encoded);
  return encoded.length;
}

async function replaceDirectoryAtomic(temporaryRoot: string, targetRoot: string) {
  const backupRoot = `${targetRoot}.old-${process.pid}-${Date.now()}`;
  let hadTarget = false;
  try {
    await fs.rename(targetRoot, backupRoot);
    hadTarget = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await fs.mkdir(path.dirname(targetRoot), { recursive: true });
    await fs.rename(temporaryRoot, targetRoot);
    if (hadTarget) await fs.rm(backupRoot, { recursive: true, force: true });
  } catch (error) {
    if (hadTarget) await fs.rename(backupRoot, targetRoot).catch(() => undefined);
    throw error;
  }
}

export async function buildImagePyramidCache({ cacheRoot, assetId, input, record, report, isCanceled }: BuildOptions) {
  const throwIfCanceled = () => {
    if (!isCanceled?.()) return;
    const error = new Error('图像任务已取消');
    error.name = 'ImageJobCanceledError';
    throw error;
  };
  const targetRoot = path.join(cacheRoot, IMAGE_CACHE_DIRECTORY, 'assets', assetId);
  const temporaryRoot = path.join(
    cacheRoot, IMAGE_CACHE_DIRECTORY, 'tmp', `${assetId}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await fs.mkdir(temporaryRoot, { recursive: true });
  try {
    throwIfCanceled();
    report('decode', 0);
    const metadata = await sharp(input, { sequentialRead: true }).metadata();
    const swapsAxes = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
    const sourceWidth = swapsAxes ? metadata.height ?? 0 : metadata.width ?? 0;
    const sourceHeight = swapsAxes ? metadata.width ?? 0 : metadata.height ?? 0;
    if (sourceWidth < 1 || sourceHeight < 1) throw new Error('图片尺寸无效');
    // Very large sources use libvips' demand-driven region pipeline. A single
    // RGBA decode would otherwise exceed the explicit 512 MiB CPU budget.
    const decoded = sourceWidth * sourceHeight * 4 <= MAX_SINGLE_DECODE_BYTES
      ? await sharp(input, { sequentialRead: true }).rotate().ensureAlpha().raw()
        .toBuffer({ resolveWithObject: true })
      : undefined;
    throwIfCanceled();
    report('decode', 1);
    const sourceEdge = Math.max(sourceWidth, sourceHeight);
    if (sourceWidth !== record.naturalWidth || sourceHeight !== record.naturalHeight) {
      throw new Error('方向修正后的图片尺寸与 AssetRecord 不一致');
    }
    const edges = [...IMAGE_MIP_EDGES.filter((edge) => edge <= sourceEdge), sourceEdge]
      .filter((edge, index, values) => values.indexOf(edge) === index)
      .sort((left, right) => left - right);
    const pyramidDimensions: Array<{ level: number; width: number; height: number }> = [];
    let levelWidth = sourceWidth;
    let levelHeight = sourceHeight;
    let pyramidLevel = 0;
    while (true) {
      pyramidDimensions.push({ level: pyramidLevel, width: levelWidth, height: levelHeight });
      if (levelWidth <= IMAGE_TILE_SIZE && levelHeight <= IMAGE_TILE_SIZE) break;
      levelWidth = Math.max(1, Math.ceil(levelWidth / 2));
      levelHeight = Math.max(1, Math.ceil(levelHeight / 2));
      pyramidLevel += 1;
    }
    const fixedWork = edges.length;
    const tileWork = sourceEdge > IMAGE_TILE_THRESHOLD_EDGE
      ? pyramidDimensions.reduce((total, level) => total
        + Math.ceil(level.width / IMAGE_TILE_SIZE) * Math.ceil(level.height / IMAGE_TILE_SIZE), 0)
      : 0;
    const totalWork = Math.max(1, fixedWork + tileWork);
    let completedWork = 0;
    const raw = { width: sourceWidth, height: sourceHeight, channels: 4 as const };
    const levels: DiskMipLevel[] = [];
    for (const edge of edges) {
      throwIfCanceled();
      const size = dimensionsForEdge(sourceWidth, sourceHeight, edge);
      // Ultra-large levels are represented by tiles; a monolithic GPU candidate is never written.
      if (edge > LARGE_IMAGE_TILE_EDGE) {
        completedWork += 1;
        report('mip', completedWork / totalWork);
        continue;
      }
      const file = `level-${edge}.webp`;
      const pipeline = decoded
        ? sharp(decoded.data, { raw }).resize({
          width: size.width, height: size.height, fit: 'fill', kernel: sharp.kernel.lanczos3,
        })
        : sharp(input, { sequentialRead: true }).rotate().resize({
          width: size.width, height: size.height, fit: 'fill', kernel: sharp.kernel.lanczos3,
        });
      const encoded = await encodeWebp(pipeline);
      const byteLength = await writeVerifiedWebp(path.join(temporaryRoot, file), encoded, size);
      throwIfCanceled();
      levels.push({ edge, ...size, file, byteLength });
      completedWork += 1;
      report('mip', completedWork / totalWork);
    }
    const tileLevels: DiskTileLevel[] = [];
    if (sourceEdge > IMAGE_TILE_THRESHOLD_EDGE) for (const level of pyramidDimensions) {
      throwIfCanceled();
      const columns = Math.ceil(level.width / IMAGE_TILE_SIZE);
      const rows = Math.ceil(level.height / IMAGE_TILE_SIZE);
      const directory = `tiles/${level.level}`;
      const resized = !decoded ? undefined : level.level === 0 ? decoded : await sharp(decoded.data, { raw }).resize({
        width: level.width, height: level.height, fit: 'fill', kernel: sharp.kernel.lanczos3,
      }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const levelRaw = { width: level.width, height: level.height, channels: 4 as const };
      for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
        throwIfCanceled();
        const left = Math.max(0, column * IMAGE_TILE_SIZE - IMAGE_TILE_GUTTER);
        const top = Math.max(0, row * IMAGE_TILE_SIZE - IMAGE_TILE_GUTTER);
        const right = Math.min(level.width, (column + 1) * IMAGE_TILE_SIZE + IMAGE_TILE_GUTTER);
        const bottom = Math.min(level.height, (row + 1) * IMAGE_TILE_SIZE + IMAGE_TILE_GUTTER);
        const width = right - left;
        const height = bottom - top;
        const pipeline = resized
          ? sharp(resized.data, { raw: levelRaw }).extract({ left, top, width, height })
          : sharp(input, { sequentialRead: true }).rotate().resize({
            width: level.width, height: level.height, fit: 'fill', kernel: sharp.kernel.lanczos3,
          }).extract({ left, top, width, height });
        const encoded = await encodeWebp(pipeline);
        await writeVerifiedWebp(path.join(temporaryRoot, directory, `${column}-${row}.webp`), encoded, { width, height });
        throwIfCanceled();
        completedWork += 1;
        report('mip', completedWork / totalWork);
      }
      tileLevels.push({ level: level.level, width: level.width, height: level.height, columns, rows, directory });
    }
    report('commit', 0);
    const manifest: ImagePyramidManifest = {
      assetId,
      contentHash: record.contentHash ?? record.hash,
      sourceSize: record.sourceSize ?? record.byteLength,
      sourceMtimeMs: record.sourceMtimeMs,
      width: sourceWidth,
      height: sourceHeight,
      orientation: record.orientation ?? 1,
      hasAlpha: Boolean(record.hasAlpha),
      cacheVersion: IMAGE_CACHE_FORMAT_VERSION,
      mipAlgorithmVersion: MIP_ALGORITHM_VERSION,
      tileSize: IMAGE_TILE_SIZE,
      createdAt: new Date().toISOString(),
      levels,
      tileLevels,
    };
    // Manifest is the commit marker and is deliberately written last.
    throwIfCanceled();
    await fs.writeFile(path.join(temporaryRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    throwIfCanceled();
    await replaceDirectoryAtomic(temporaryRoot, targetRoot);
    report('commit', 1);
    return manifest;
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
