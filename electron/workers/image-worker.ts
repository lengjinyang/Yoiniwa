import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { buildImagePyramidCache } from './mip-generator.js';

// Derivative preparation must yield CPU time to the renderer. libvips otherwise
// uses several threads per job, so two large tile requests can saturate the
// machine even though decoding happens outside Electron's renderer process.
sharp.concurrency(1);

const debugWorker = process.env.REFCANVAS_IMAGE_WORKER_LOG === '1';
if (debugWorker) console.error('RefCanvas image worker ready');

const assetSources = new Map();
let cacheRoot;
let workerGeneration = 0;
const MAX_REGISTERED_BYTES = 512 * 1024 * 1024;
let registeredBytes = 0;
const decodedAssets = new Map();
const MAX_DECODED_BYTES = 512 * 1024 * 1024;
let decodedBytes = 0;
const canceledRequests = new Set();

function requestCanceled(id) {
  return canceledRequests.has(id);
}

function throwIfCanceled(id) {
  if (!requestCanceled(id)) return;
  const error = new Error('图像任务已取消');
  error.name = 'ImageJobCanceledError';
  throw error;
}

function retainAsset(key, value) {
  if (!key || !value) return;
  const buffer = Buffer.from(value);
  const previous = assetSources.get(key);
  if (previous?.buffer) registeredBytes -= previous.buffer.length;
  assetSources.set(key, { buffer, lastUsed: Date.now() });
  registeredBytes += buffer.length;
  for (const [assetKey, entry] of [...assetSources.entries()].filter(([, value]) => value.buffer)
    .sort((left, right) => left[1].lastUsed - right[1].lastUsed)) {
    if (registeredBytes <= MAX_REGISTERED_BYTES) break;
    if (assetKey === key) continue;
    registeredBytes -= entry.buffer.length;
    assetSources.delete(assetKey);
  }
}

function sourceInput(assetKey, inlineBuffer) {
  if (inlineBuffer) {
    retainAsset(assetKey, inlineBuffer);
    return assetSources.get(assetKey)?.buffer ?? Buffer.from(inlineBuffer);
  }
  const entry = assetSources.get(assetKey);
  if (!entry) throw new Error('后台图片资源尚未注册');
  entry.lastUsed = Date.now();
  if (entry.relativePath) {
    if (!cacheRoot) throw new Error('后台图片缓存根目录尚未配置');
    const resolved = path.resolve(cacheRoot, entry.relativePath);
    const relative = path.relative(path.resolve(cacheRoot), resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('后台图片资源路径越界');
    return resolved;
  }
  return entry.buffer;
}

async function decodedAsset(assetKey, encodedInput) {
  const existing = decodedAssets.get(assetKey);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.promise;
  }
  const entry = { lastUsed: Date.now(), bytes: 0, promise: undefined };
  entry.promise = sharp(encodedInput, { sequentialRead: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
    .then(({ data, info }) => {
      entry.bytes = data.length;
      decodedBytes += entry.bytes;
      for (const [key, value] of [...decodedAssets.entries()].sort((left, right) => left[1].lastUsed - right[1].lastUsed)) {
        if (decodedBytes <= MAX_DECODED_BYTES) break;
        if (key === assetKey || value.bytes === 0) continue;
        decodedBytes -= value.bytes;
        decodedAssets.delete(key);
      }
      return { buffer: data, width: info.width, height: info.height };
    })
    .catch((error) => {
      decodedAssets.delete(assetKey);
      throw error;
    });
  decodedAssets.set(assetKey, entry);
  return entry.promise;
}

const png = (pipeline) => pipeline.png({ compressionLevel: 3, adaptiveFiltering: false }).toBuffer();

function resolveCachePath(relativePath) {
  if (!cacheRoot || !relativePath) throw new Error('图像任务缺少缓存相对路径');
  const resolved = path.resolve(cacheRoot, relativePath);
  const relative = path.relative(path.resolve(cacheRoot), resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('图像任务缓存路径越界');
  return resolved;
}

async function writeOutput(outputRelativePath, buffer, requestId) {
  const outputPath = resolveCachePath(outputRelativePath);
  const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  try {
    await fs.writeFile(temporaryPath, buffer);
    throwIfCanceled(requestId);
    try { await fs.rename(temporaryPath, outputPath); }
    catch {
      await fs.rm(outputPath, { force: true });
      await fs.rename(temporaryPath, outputPath);
    }
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function processWithSharp(input, job) {
  if (job.type === 'thumbnail' && Number.isFinite(job.size)) {
    return png(sharp(input, { sequentialRead: true }).resize({
      width: job.size, height: job.size, fit: 'inside', withoutEnlargement: false,
    }));
  }
  if (job.type === 'pyramid' && Number.isFinite(job.level)) {
    const metadata = await sharp(input, { sequentialRead: true }).metadata();
    const width = Math.max(1, Math.ceil((metadata.width ?? 1) / 2 ** job.level));
    const height = Math.max(1, Math.ceil((metadata.height ?? 1) / 2 ** job.level));
    return png(sharp(input, { sequentialRead: true }).resize({ width, height, fit: 'fill' }));
  }
  if (job.type === 'tile' && [job.level, job.column, job.row, job.tileSize, job.gutter].every(Number.isFinite)) {
    // The main process registers the already selected pyramid level and sends
    // level=0 here. Decode that level once, then crop every requested tile from
    // the retained RGBA buffer instead of decoding the complete JPEG/PNG again
    // for every tile around the viewport.
    const decoded = await decodedAsset(job.assetKey, input);
    const width = Math.max(1, Math.ceil(decoded.width / 2 ** job.level));
    const height = Math.max(1, Math.ceil(decoded.height / 2 ** job.level));
    const left = Math.max(0, job.column * job.tileSize - job.gutter);
    const top = Math.max(0, job.row * job.tileSize - job.gutter);
    const right = Math.min(width, (job.column + 1) * job.tileSize + job.gutter);
    const bottom = Math.min(height, (job.row + 1) * job.tileSize + job.gutter);
    if (left >= right || top >= bottom) throw new Error('分块坐标无效');
    const tileWidth = right - left;
    const tileHeight = bottom - top;
    const rowBytes = tileWidth * 4;
    const tileBuffer = Buffer.allocUnsafe(rowBytes * tileHeight);
    for (let row = 0; row < tileHeight; row += 1) {
      const sourceStart = ((top + row) * width + left) * 4;
      decoded.buffer.copy(tileBuffer, row * rowBytes, sourceStart, sourceStart + rowBytes);
    }
    return png(sharp(tileBuffer, { raw: { width: tileWidth, height: tileHeight, channels: 4 } }));
  }
  throw new Error('图像任务无效');
}

const parentPort = process.parentPort;
const sendToParent = (message) => {
  if (parentPort) parentPort.postMessage(message);
  else process.send?.(message);
};
const onParentMessage = (listener) => {
  if (parentPort) parentPort.on('message', (event) => listener(event.data ?? {}));
  else process.on('message', (message) => listener(message ?? {}));
};

onParentMessage(async (job) => {
  if (job.type === 'cancel') {
    if (Number.isInteger(job.requestId)) canceledRequests.add(job.requestId);
    return;
  }
  if (debugWorker) console.error(`RefCanvas image worker job: ${job.type}`);
  if (debugWorker) sendToParent({ debug: `job ${job.type}` });
  try {
    if (job.type === 'configure') {
      if (!Number.isInteger(job.generation) || !path.isAbsolute(job.cacheRoot)) throw new Error('后台图片配置无效');
      workerGeneration = job.generation;
      cacheRoot = job.cacheRoot;
      canceledRequests.clear();
      assetSources.clear();
      decodedAssets.clear();
      registeredBytes = 0;
      decodedBytes = 0;
      sendToParent({ id: job.id, generation: workerGeneration, ok: true });
      return;
    }
    if (job.generation !== workerGeneration) {
      sendToParent({ id: job.id, generation: job.generation, ok: false, stale: true, error: '图片任务 generation 已过期' });
      return;
    }
    if (job.type === 'ping') {
      sendToParent({ id: job.id, generation: workerGeneration, ok: true, result: { cacheRoot } });
      return;
    }
    if (job.type === 'register') {
      if (job.sourceRelativePath) assetSources.set(job.assetKey, { relativePath: job.sourceRelativePath, lastUsed: Date.now() });
      else retainAsset(job.assetKey, job.buffer);
      sendToParent({ id: job.id, generation: workerGeneration, ok: true });
      return;
    }
    if (job.type === 'unregister') {
      const keys = new Set([job.assetId, job.assetKey].filter(Boolean));
      for (const key of keys) {
        const source = assetSources.get(key);
        if (source?.buffer) registeredBytes -= source.buffer.length;
        assetSources.delete(key);
        const decoded = decodedAssets.get(key);
        if (decoded) decodedBytes -= decoded.bytes;
        decodedAssets.delete(key);
      }
      sendToParent({ id: job.id, generation: workerGeneration, ok: true });
      return;
    }
    if (job.type === 'verify') {
      const input = sourceInput(job.assetKey ?? job.assetId, job.buffer);
      const stat = typeof input === 'string' ? await fs.stat(input) : undefined;
      if (stat && (!stat.isFile() || stat.size < 1)) throw new Error('后台图片资源无法读取');
      sendToParent({ id: job.id, generation: workerGeneration, ok: true });
      return;
    }
    if (job.type === 'buildPyramid') {
      const input = sourceInput(job.assetKey ?? job.assetId, job.buffer);
      const result = await buildImagePyramidCache({
        cacheRoot,
        assetId: job.assetId,
        input,
        record: job.record,
        isCanceled: () => requestCanceled(job.id),
        report: (stage, progress) => sendToParent({
          id: job.id, generation: workerGeneration, progress: { stage, progress },
        }),
      });
      sendToParent({ id: job.id, generation: workerGeneration, ok: true, result });
      return;
    }
    const input = sourceInput(job.assetKey, job.buffer);
    if (job.type === 'samplePixel') {
      throwIfCanceled(job.id);
      const pixel = await sharp(input, { sequentialRead: true }).rotate().ensureAlpha()
        .extract({ left: job.x, top: job.y, width: 1, height: 1 }).raw().toBuffer();
      throwIfCanceled(job.id);
      sendToParent({
        id: job.id, generation: workerGeneration, ok: true,
        result: { r: pixel[0], g: pixel[1], b: pixel[2], a: pixel[3] },
      });
      return;
    }
    const result = await processWithSharp(input, job);
    throwIfCanceled(job.id);
    await writeOutput(job.outputRelativePath, result, job.id);
    throwIfCanceled(job.id);
    sendToParent({ id: job.id, generation: workerGeneration, ok: true });
  } catch (error) {
    if (debugWorker) console.error(`RefCanvas image worker error: ${String(error)}`);
    sendToParent({ id: job.id, generation: job.generation, ok: false, error: String(error) });
  } finally {
    canceledRequests.delete(job.id);
  }
});

if (debugWorker) sendToParent({ debug: 'ready' });
