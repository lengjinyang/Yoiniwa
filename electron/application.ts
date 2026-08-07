import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, nativeImage, protocol, screen, shell } from 'electron';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { fork as forkChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as osConstants, setPriority } from 'node:os';
import sharp from 'sharp';
import unzipper from 'unzipper';
import { createDerivedCache } from './services/derived-cache.js';
import { createImageJobQueue, ImageJobCanceledError } from './services/image-jobs.js';
import { createRecoveringQueue } from './services/persistence-queue.js';
import { createScenePackages } from './services/scene-packages.js';
import { parseRuntimeFlags } from './runtime/runtime-flags.js';
import { runPerformanceBenchmark } from './benchmarks/performance-benchmark.js';
import { runProjectZoomBenchmark } from './benchmarks/project-zoom-benchmark.js';
import { appendRendererLogs, flushLogs, getLogDirectory, getLogPath, initializeLogger, log, logError, logInfo, logSessionId, logWarn } from './services/logger.js';
import { createIpcHandlerRegistrar } from './ipc/register-handler.js';
import { createImageCachePathResolver } from './services/image-cache-paths.js';
import { WorkerGeneration } from './services/worker-generation.js';
import { IMAGE_CACHE_FORMAT_VERSION, IMAGE_IMPORT_STAGE_WEIGHTS, IMAGE_MIP_EDGES } from '../src/shared/imagePipelineConfig.js';
import { closestManifestLevel, readImagePyramidManifest } from './services/image-pyramid-manifest.js';
import { trimImagePyramidCache } from './services/image-cache-cleaner.js';
import { WorkerAssetRegistrations } from './services/worker-asset-registrations.js';
import { collectRecentAssetIds, hydrateRecentAssetIds } from './services/recent-assets.js';
import type { ImportedImage, PhotoshopColorSyncResult } from '../src/types.js';
import { createDirtyRevisionState, markRevisionSaved, updateDirtyRevision } from '../src/shared/dirtyRevision.js';
import { PhotoshopColorBridge } from './services/photoshop-color-bridge.js';
import { shouldAutoPhotoshopRoundTrip, shouldUseFocuslessPhotoshopPicker } from '../src/shared/photoshopIntegration.js';
import { createPhotoshopSyncQueue } from './services/photoshop-sync-queue.js';

process.on('uncaughtExceptionMonitor', (error, origin) => logError('process.uncaught-exception', error, { origin }));
process.on('unhandledRejection', (reason) => logError('process.unhandled-rejection', reason));

// A detached benchmark/dev terminal may close its output pipe while Electron is
// still running. Debug logging must never turn that harmless EPIPE into a main
// process crash dialog.
process.stdout?.on?.('error', (error) => {
  if (error?.code !== 'EPIPE') process.exitCode = 1;
});
process.stderr?.on?.('error', (error) => {
  if (error?.code !== 'EPIPE') process.exitCode = 1;
});

const electronRuntimeDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = app.getAppPath();
const runtimeFlags = parseRuntimeFlags(process.env, process.argv);
const pixiCanvasSmoke = process.env.REFCANVAS_PIXI_SMOKE === '1';
const photoshopRoundTripSmoke = process.env.REFCANVAS_PHOTOSHOP_SMOKE === '1';
const {
  stressTest, performanceBenchmark, projectZoomBenchmark, devSmokeTest, realImageTest,
  forceThumbnailFailure, smokeTest, cleanTestSession,
} = runtimeFlags;
const sceneFilters = [{ name: 'Yoiniwa 画板', extensions: ['refcanvas'] }];
const imageFilters = [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }];
const mimeByExt = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp', '.gif': 'image/gif' };
const extByMime = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/bmp': '.bmp', 'image/gif': '.gif' };

protocol.registerSchemesAsPrivileged([{ scheme: 'refcanvas-asset', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
} }]);

let mainWindow;
let dirtyRevisionState = createDirtyRevisionState();
let currentScenePath;
const enqueuePersistence = createRecoveringQueue();
let startupScenePath = process.env.REFCANVAS_PROJECT_BENCH_PATH || process.argv.find((value) => /\.refcanvas$/i.test(value));
// Temporary manual-verification hook. Keep explicit CLI/file-association paths
// authoritative, otherwise open the desktop fixture on every normal launch.
const TEMPORARY_DESKTOP_SCENE_NAME = '未命名画板.refcanvas';
let windowState = { alwaysOnTop: false, clickThrough: false, locked: false, collaborationMode: false, opacity: 1 };
let windowMoveSession;
let windowMoveTimer;
const WINDOW_MOVE_FRAME_MS = 1000 / 60;
let nativeWindowMoveHelper;
let nativeWindowMoveReady = false;
let nativeWindowMoveOutput = '';
let nonActivatingWindowReady = false;
let nativeKeyRequestId = 0;
const pendingNativeKeyQueries = new Map<string, { resolve(value: boolean): void; timer: NodeJS.Timeout }>();
let nativeLayerRequestId = 0;
let nativeLayerTransition = Promise.resolve();
let nativeLayerRepairTimer;
const pendingNativeLayerRequests = new Map<string, {
  enabled: boolean;
  resolve(value: boolean): void;
  timer: NodeJS.Timeout;
}>();
const photoshopColorBridge = new PhotoshopColorBridge();
let imageWorker;
let imageWorkerPaused = false;
let imageWorkerRequest = 0;
const imageWorkerRequests = new Map();
const imageWorkerAssets = new WorkerAssetRegistrations();
const imageWorkerGeneration = new WorkerGeneration();
const assetRegistry = new Map();
const archiveDirectoryCache = new Map();
const prewarmRequests = new Map();
const imagePerformanceStats = {
  metadataCount: 0,
  metadataMs: 0,
  thumbnailCount: 0,
  thumbnailMs: 0,
  thumbnailFailures: 0,
};

let cacheRootOverride;
let sessionCachePath;
const smokeCacheRoot = smokeTest && process.env.REFCANVAS_TEST_CACHE_ROOT && path.isAbsolute(process.env.REFCANVAS_TEST_CACHE_ROOT)
  ? process.env.REFCANVAS_TEST_CACHE_ROOT : undefined;
const cacheRootDir = () => smokeCacheRoot ?? (cacheRootOverride ? path.join(cacheRootOverride, 'RefCanvas') : app.getPath('userData'));
const imageCachePaths = createImageCachePathResolver(cacheRootDir);
const assetCacheDir = () => path.join(cacheRootDir(), 'asset-cache');
const sessionCacheDir = () => path.join(cacheRootDir(), 'session-cache');
const ASSET_CACHE_BUDGET = 2 * 1024 * 1024 * 1024;
const DERIVED_CACHE_BUDGET = 4 * 1024 * 1024 * 1024;
const createAppDerivedCache = () => createDerivedCache(cacheRootDir(), 'v2', DERIVED_CACHE_BUDGET);
let derivedCache = createAppDerivedCache();
// Keep derivative generation serialized. The worker retains decoded pyramid
// levels, so parallel full-image decodes no longer buy throughput and can steal
// enough CPU from wheel rendering to make the canvas unusable.
const imageJobs = createImageJobQueue({ concurrency: 2 });
const assetCachePath = (record) => path.join(assetCacheDir(), `${record.hash}${extByMime[record.mimeType] ?? '.bin'}`);

function cacheRelativePath(filePath) {
  const relative = path.relative(cacheRootDir(), filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('图片 Worker 路径不在当前缓存目录');
  return relative;
}

async function archiveDirectory(filePath) {
  const stat = await fs.stat(filePath);
  const signature = `${stat.size}:${stat.mtimeMs}`;
  const cached = archiveDirectoryCache.get(filePath);
  if (cached?.signature === signature) return cached.promise;
  const promise = unzipper.Open.file(filePath);
  archiveDirectoryCache.set(filePath, { signature, promise });
  try {
    return await promise;
  } catch (error) {
    if (archiveDirectoryCache.get(filePath)?.promise === promise) archiveDirectoryCache.delete(filePath);
    throw error;
  }
}

async function trimAssetCache() {
  let entries;
  try { entries = await fs.readdir(assetCacheDir(), { withFileTypes: true }); }
  catch { return; }
  const active = new Set([...assetRegistry.values()].map((entry) => entry.cachePath));
  const files = (await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
    const filePath = path.join(assetCacheDir(), entry.name);
    try { const stat = await fs.stat(filePath); return { path: filePath, size: stat.size, usedAt: Math.max(stat.atimeMs, stat.mtimeMs) }; }
    catch { return undefined; }
  }))).filter(Boolean);
  let bytes = files.reduce((total, file) => total + file.size, 0);
  for (const file of files.filter((file) => !active.has(file.path)).sort((left, right) => left.usedAt - right.usedAt)) {
    if (bytes <= ASSET_CACHE_BUDGET) break;
    await fs.rm(file.path, { force: true });
    bytes -= file.size;
  }
}

async function retainAssetRegistry(assetIds) {
  const activeIds = new Set<string>(assetIds as string[]);
  for (const [id, entry] of assetRegistry.entries()) {
    if (activeIds.has(id)) continue;
    const identities = new Set([id, entry.record.hash]);
    imageJobs.cancel((key) => [...identities].some((identity) => key.includes(identity)));
    identities.forEach((identity) => imageWorkerAssets.deleteAsset(identity));
    if (imageWorker && !imageWorkerPaused) {
      void runImageWorker({ type: 'unregister', assetId: id, assetKey: entry.record.hash }, 5000)
        .catch((error) => logWarn('image-worker.unregister-failed', { id, error: String(error) }));
    }
    assetRegistry.delete(id);
  }
  await trimAssetCache();
  void trimImageCacheForActive(activeIds);
}

async function trimImageCacheForActive(activeIds: ReadonlySet<string>) {
  try {
    const state = await readState();
    await trimImagePyramidCache({
      assetsRoot: imageCachePaths.assetsRoot(),
      protectedAssetIds: activeIds,
      recentAssetIds: collectRecentAssetIds(state.recent ?? []),
    });
  } catch (error) {
    logWarn('image-cache.trim-failed', { error: String(error) });
  }
}

function mimeFromName(name, fallback = 'application/octet-stream') {
  return mimeByExt[path.extname(name).toLowerCase()] ?? fallback;
}

async function mapWithConcurrency(values, mapper, concurrency = 4) {
  if (!values.length) return [];
  const results = new Array(values.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

async function registerAssetBuffer(name, buffer, sourcePath, sourceType = 'drop') {
  const mimeType = mimeFromName(name);
  const hash = createHash('sha256').update(buffer).digest('hex');
  const baseRecord = {
    id: hash, assetId: hash, hash, contentHash: hash, mimeType,
    byteLength: buffer.length, sourceSize: buffer.length, sourceMtimeMs: Date.now(),
    originalName: name, sourcePath, cacheVersion: IMAGE_CACHE_FORMAT_VERSION,
  };
  const cachePath = assetCachePath(baseRecord);
  await fs.mkdir(assetCacheDir(), { recursive: true });
  const metadataStartedAt = performance.now();
  try {
    const existing = await fs.stat(cachePath);
    if (existing.size !== buffer.length) await fs.writeFile(cachePath, buffer);
  } catch { await fs.writeFile(cachePath, buffer); }
  let bitmapSize;
  let metadataTimer;
  try {
    const metadata: any = await Promise.race([
      sharp(cachePath, { sequentialRead: true }).metadata(),
      new Promise((_, reject) => { metadataTimer = setTimeout(() => reject(new Error('图片尺寸读取超时')), 8000); }),
    ]);
    bitmapSize = { width: metadata.width, height: metadata.height };
    if (!Number.isInteger(bitmapSize.width) || bitmapSize.width < 1 || !Number.isInteger(bitmapSize.height) || bitmapSize.height < 1) {
      throw new Error('图片尺寸无效');
    }
  } catch (error) {
    imageWorkerAssets.deleteAsset(hash);
    await fs.rm(cachePath, { force: true }).catch(() => undefined);
    throw new Error(`图片无法解码：${name} (${String(error)})`);
  } finally {
    if (metadataTimer) clearTimeout(metadataTimer);
    imagePerformanceStats.metadataCount += 1;
    imagePerformanceStats.metadataMs += performance.now() - metadataStartedAt;
  }
  const metadata = await sharp(cachePath, { sequentialRead: true }).metadata();
  const swapsAxes = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
  const record = {
    ...baseRecord,
    naturalWidth: swapsAxes ? bitmapSize.height : bitmapSize.width,
    naturalHeight: swapsAxes ? bitmapSize.width : bitmapSize.height,
    orientation: metadata.orientation ?? 1,
    hasAlpha: Boolean(metadata.hasAlpha),
  };
  assetRegistry.set(record.id, { record, cachePath });
  await trimAssetCache();
  return { name, path: sourcePath, assetId: record.id, asset: record, sourceType };
}

async function registerAssetPath(filePath, sourceType = 'drop', onProgress = undefined) {
  const name = path.basename(filePath);
  const mimeType = mimeFromName(name);
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size < 1 || stat.size > 200 * 1024 * 1024) throw new Error('图片文件大小无效');
  await fs.mkdir(assetCacheDir(), { recursive: true });
  const temporaryPath = path.join(assetCacheDir(), `.import-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  const hash = createHash('sha256');
  const hashStream = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      onProgress?.('hash', chunk.length);
      callback(undefined, chunk);
    },
  });
  try {
    await pipeline(createReadStream(filePath), hashStream, createWriteStream(temporaryPath, { flags: 'wx' }));
    const digest = hash.digest('hex');
    const baseRecord = {
      id: digest, assetId: digest, hash: digest, contentHash: digest, mimeType,
      byteLength: stat.size, sourceSize: stat.size, sourceMtimeMs: stat.mtimeMs,
      originalName: name, sourcePath: filePath, cacheVersion: IMAGE_CACHE_FORMAT_VERSION,
    };
    const cachePath = assetCachePath(baseRecord);
    try {
      const cached = await fs.stat(cachePath);
      if (cached.size !== stat.size) { await fs.rm(cachePath, { force: true }); await fs.rename(temporaryPath, cachePath); }
      else await fs.rm(temporaryPath, { force: true });
    } catch { await fs.rename(temporaryPath, cachePath); }
    const metadataStartedAt = performance.now();
    onProgress?.('metadata', 0);
    const metadata: any = await sharp(cachePath, { sequentialRead: true }).metadata();
    onProgress?.('metadata', 1);
    imagePerformanceStats.metadataCount += 1;
    imagePerformanceStats.metadataMs += performance.now() - metadataStartedAt;
    if (!Number.isInteger(metadata.width) || metadata.width < 1 || !Number.isInteger(metadata.height) || metadata.height < 1) {
      throw new Error('图片尺寸无效');
    }
    const swapsAxes = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
    const record = {
      ...baseRecord,
      naturalWidth: swapsAxes ? metadata.height : metadata.width,
      naturalHeight: swapsAxes ? metadata.width : metadata.height,
      orientation: metadata.orientation ?? 1,
      hasAlpha: Boolean(metadata.hasAlpha),
    };
    assetRegistry.set(record.id, { record, cachePath });
    return { name, path: filePath, assetId: record.id, asset: record, sourceType };
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function ensureAssetBuffer(id) {
  const registered = assetRegistry.get(id);
  if (!registered) throw new Error(`资源不存在：${id}`);
  try {
    const cached = await fs.readFile(registered.cachePath);
    if (cached.length === registered.record.byteLength) {
      void fs.utimes(registered.cachePath, new Date(), new Date()).catch(() => undefined);
      return cached;
    }
    await fs.rm(registered.cachePath, { force: true });
  } catch { /* Load from the current scene package below. */ }
  if (!registered.archivePath || !registered.entryPath) throw new Error(`资源缓存缺失：${id}`);
  const directory = await archiveDirectory(registered.archivePath);
  const entry = directory.files.find((value) => value.path === registered.entryPath);
  if (!entry) throw new Error(`场景包缺少资源：${id}`);
  const buffer = await entry.buffer();
  await fs.mkdir(assetCacheDir(), { recursive: true });
  await fs.writeFile(registered.cachePath, buffer);
  return buffer;
}

async function ensureAssetFile(id) {
  const registered = assetRegistry.get(id);
  if (!registered) throw new Error(`资源不存在：${id}`);
  try { await fs.access(registered.cachePath); } catch { await ensureAssetBuffer(id); }
  return registered.cachePath;
}

const { writeScenePackage, readScenePackage, readSceneAssetIds } = createScenePackages({
  assetRegistry, assetCachePath, ensureAssetFile, extByMime,
});

function ensureImageWorker(allowWhilePaused = false) {
  if (imageWorkerPaused && !allowWhilePaused) throw new Error('图片缓存正在迁移，请稍后重试');
  if (imageWorker) return imageWorker;
  const logImageWorker = process.env.REFCANVAS_IMAGE_WORKER_LOG === '1';
  const worker = forkChildProcess(path.join(electronRuntimeDir, 'workers', 'image-worker.js'), [], {
    execPath: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: logImageWorker ? ['ignore', 'inherit', 'inherit', 'ipc'] : ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  imageWorker = worker;
  worker.send({
    type: 'configure', generation: imageWorkerGeneration.current(), cacheRoot: cacheRootDir(),
  });
  try {
    if (worker.pid) setPriority(worker.pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
  } catch { /* Process priority is best-effort on restricted Windows accounts. */ }
  worker.on('message', (message: any) => {
    if (logImageWorker && message?.debug) console.error(`RefCanvas image worker: ${message.debug}`);
    const request = imageWorkerRequests.get(message?.id);
    if (!request) return;
    if (!imageWorkerGeneration.accepts(message)) {
      imageWorkerRequests.delete(message.id);
      request.reject(new Error('已丢弃旧图片 Worker 结果'));
      return;
    }
    if (message.progress) {
      request.onProgress?.(message.progress);
      return;
    }
    imageWorkerRequests.delete(message.id);
    if (message.ok) request.resolve(message.result);
    else request.reject(new Error(message.error || '后台图像任务失败'));
  });
  worker.on('exit', (code) => {
    logWarn('image-worker.exit', { code, pendingRequests: imageWorkerRequests.size });
    if (logImageWorker) console.error(`RefCanvas image worker exited (${code})`);
    const requests = [...imageWorkerRequests.values()];
    imageWorkerRequests.clear();
    if (imageWorker === worker) imageWorker = undefined;
    imageWorkerAssets.clear();
    requests.forEach((request) => request.reject(new Error('后台图像进程已退出')));
  });
  worker.on('error', (error) => {
    logError('image-worker.error', error);
    worker.kill();
  });
  return worker;
}

async function suspendImageWorkerForCacheMigration() {
  imageWorkerPaused = true;
  imageWorkerGeneration.advance();
  imageWorkerAssets.clear();
  prewarmRequests.forEach((request) => { request.canceled = true; });
  imageJobs.cancel(() => true);
  const worker = imageWorker;
  if (worker) {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new Error('停止后台图像进程超时，缓存位置未更改')), 5000);
      worker.once('exit', () => finish());
      worker.once('error', (error) => finish(error));
      if (!worker.kill()) finish(new Error('无法停止后台图像进程，缓存位置未更改'));
    });
    if (imageWorker === worker) imageWorker = undefined;
  }
  await Promise.race([
    imageJobs.whenIdle(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('等待后台图像任务结束超时，缓存位置未更改')), 8000)),
  ]);
  imageWorkerAssets.clear();
}

function runImageWorker(payload, timeoutMs = 30000, allowWhilePaused = false, onProgress = undefined, signal?: AbortSignal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ImageJobCanceledError());
      return;
    }
    const id = ++imageWorkerRequest;
    let settled = false;
    const child = ensureImageWorker(allowWhilePaused);
    const timer = setTimeout(() => {
      finish(reject, new Error('后台图像任务超时'));
      child.kill();
    }, timeoutMs);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      imageWorkerRequests.delete(id);
      callback(value);
    };
    const abort = () => {
      try { child.send({ type: 'cancel', requestId: id, generation: imageWorkerGeneration.current() }); }
      catch { /* A terminated worker has already canceled the native work. */ }
      finish(reject, new ImageJobCanceledError());
    };
    signal?.addEventListener('abort', abort, { once: true });
    imageWorkerRequests.set(id, {
      onProgress,
      resolve: (value) => finish(resolve, value),
      reject: (error) => finish(reject, error),
    });
    try {
      child.send({ id, ...imageWorkerGeneration.stamp(payload) }, (error) => { if (error) finish(reject, error); });
    } catch (error) {
      finish(reject, error);
      imageWorker = undefined;
    }
  });
}

async function ensureImageWorkerAsset(assetKey, buffer, assetPath, allowWhilePaused = false) {
  const registration = imageWorkerAssets.getOrCreate(imageWorkerGeneration.current(), assetKey, () => runImageWorker({
      type: 'register', assetId: assetKey, assetKey, buffer,
      sourceRelativePath: assetPath ? cacheRelativePath(assetPath) : undefined,
    }, 30000, allowWhilePaused));
  await registration;
}

async function runRegisteredImageWorker(assetKey, buffer, payload, timeoutMs, assetPath, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await ensureImageWorkerAsset(assetKey, buffer, assetPath);
  signal?.throwIfAborted();
  return runImageWorker({ ...payload, assetKey }, timeoutMs, false, undefined, signal);
}

function resizeThumbnailInWorker(assetKey, size, assetPath, outputPath, signal?: AbortSignal) {
  return runRegisteredImageWorker(assetKey, undefined, {
    type: 'thumbnail', size, outputRelativePath: cacheRelativePath(outputPath),
  }, size <= 128 ? 8000 : 15000, assetPath, signal);
}

async function readCachedThumbnail(id, size) {
  const registered = assetRegistry.get(id);
  if (!registered) throw new Error(`资源不存在：${id}`);
  const key = `${registered.record.hash}:thumb:${size}`;
  try {
    const cached = await derivedCache.read(key);
    // Derived images are written by sharp through an atomic rename. Decoding
    // every cached PNG synchronously with nativeImage here blocks Electron's
    // main thread during a large scene open, so validate the trusted cache with
    // the PNG signature and let the renderer perform the actual async decode.
    if (isPngBuffer(cached)) return cached;
    await derivedCache.remove(key);
  } catch { /* The cache entry is absent or corrupt. */ }
  return undefined;
}

async function readPyramidLevel(id, requestedEdge) {
  const registered = assetRegistry.get(id);
  if (!registered) throw new Error(`资源不存在：${id}`);
  const manifest = await readImagePyramidManifest(imageCachePaths, registered.record);
  const level = closestManifestLevel(manifest, requestedEdge);
  if (!level) throw new Error('图片金字塔缺少可用层级');
  const target = path.resolve(imageCachePaths.assetRoot(id), level.file);
  const relative = path.relative(path.resolve(imageCachePaths.assetRoot(id)), target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('图片 Mip 路径越界');
  const buffer = await fs.readFile(target);
  if (!isWebpBuffer(buffer)) throw new Error('图片 Mip 已损坏');
  return buffer;
}

async function readPyramidTile(id, level, column, row) {
  const registered = assetRegistry.get(id);
  if (!registered) throw new Error(`资源不存在：${id}`);
  const manifest = await readImagePyramidManifest(imageCachePaths, registered.record);
  const tileLevel = manifest.tileLevels.find((entry) => entry.level === level);
  if (!tileLevel || column >= tileLevel.columns || row >= tileLevel.rows) throw new Error('图片 Tile 缓存缺失');
  const target = path.resolve(imageCachePaths.assetRoot(id), tileLevel.directory, `${column}-${row}.webp`);
  const relative = path.relative(path.resolve(imageCachePaths.assetRoot(id)), target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('图片 Tile 路径越界');
  const buffer = await fs.readFile(target);
  if (!isWebpBuffer(buffer)) throw new Error('图片 Tile 已损坏');
  return buffer;
}

async function ensureImagePyramid(id, onProgress = undefined) {
  const registered = assetRegistry.get(id);
  if (!registered) throw new Error(`资源不存在：${id}`);
  try { return await readImagePyramidManifest(imageCachePaths, registered.record); }
  catch { /* Build a complete versioned cache transaction below. */ }
  const jobKey = `disk-pyramid:${id}:v${IMAGE_CACHE_FORMAT_VERSION}`;
  return imageJobs.enqueue(jobKey, async (signal) => {
    try { return await readImagePyramidManifest(imageCachePaths, registered.record); }
    catch { /* Another process has not committed it. */ }
    await ensureAssetFile(id);
    await ensureImageWorkerAsset(id, undefined, registered.cachePath);
    const manifest = await runImageWorker({
      type: 'buildPyramid', assetId: id, assetKey: id, record: registered.record,
    }, 15 * 60 * 1000, false, onProgress, signal);
    notifyThumbnailReady(id, 128);
    notifyThumbnailReady(id, 256);
    notifyThumbnailReady(id, 512);
    notifyThumbnailReady(id, 1024);
    return manifest;
  }, 20);
}

function isPngBuffer(buffer) {
  return buffer?.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a;
}

function isWebpBuffer(buffer) {
  return buffer?.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
}

function encodedImageContentType(buffer, fallback = 'application/octet-stream') {
  if (isWebpBuffer(buffer)) return 'image/webp';
  if (isPngBuffer(buffer)) return 'image/png';
  return fallback;
}

function thumbnailVariantForSize(size) {
  return size === 128 ? 'thumb128' : size === 256 ? 'thumb256' : size === 512 ? 'thumb512' : size === 768 ? 'thumb768'
    : size === 1024 ? 'thumb1024' : undefined;
}

function notifyThumbnailReady(id, size) {
  const variant = thumbnailVariantForSize(size);
  if (!variant) return;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('images:thumbnail-ready', { assetId: id, variant });
  }
}

async function generateEmergencyThumbnail(id, size) {
  const registered = assetRegistry.get(id);
  if (!registered) throw new Error(`资源不存在：${id}`);
  const source = nativeImage.createFromBuffer(await ensureAssetBuffer(id));
  if (source.isEmpty()) throw new Error(`系统解码器无法读取图片：${registered.record.originalName}`);
  const sourceSize = source.getSize();
  const scale = Math.min(size / Math.max(1, sourceSize.width), size / Math.max(1, sourceSize.height));
  const width = Math.max(1, Math.round(sourceSize.width * scale));
  const height = Math.max(1, Math.round(sourceSize.height * scale));
  const fallback = source.resize({ width, height, quality: 'good' }).toPNG();
  if (!isPngBuffer(fallback)) throw new Error(`系统解码器无法生成预览：${registered.record.originalName}`);
  return fallback;
}

async function generateThumbnail(id, size, requestedPriority?: number) {
  if (imageWorkerPaused) throw new Error('图片缓存正在迁移，请稍后重试');
  const registered = assetRegistry.get(id);
  if (!registered) throw new Error(`资源不存在：${id}`);
  const pyramidCached = await readPyramidLevel(id, size).catch(() => undefined);
  if (pyramidCached) return pyramidCached;
  const cached = await readCachedThumbnail(id, size);
  if (cached) return cached;
  return imageJobs.enqueue(`thumbnail:${registered.record.hash}:${size}`, async (signal) => {
    const queuedCached = await readCachedThumbnail(id, size);
    if (queuedCached) return queuedCached;
    await ensureAssetFile(id);
    const key = `${registered.record.hash}:thumb:${size}`;
    const startedAt = performance.now();
    try {
      await resizeThumbnailInWorker(registered.record.hash, size, registered.cachePath, derivedCache.pathFor(key), signal);
      derivedCache.noteExternalWrite();
      const generated = await derivedCache.read(key);
      notifyThumbnailReady(id, size);
      return generated;
    } catch (error) {
      if (signal.aborted) throw new ImageJobCanceledError();
      imagePerformanceStats.thumbnailFailures += 1;
      // A supported source must still get a bounded preview when libvips fails.
      // Returning the original here used to upload multi-megapixel images into
      // the permanent preview plane and exhaust the WebGL atlas.
      const fallback = await generateEmergencyThumbnail(id, size);
      await derivedCache.writeAtomic(key, fallback);
      notifyThumbnailReady(id, size);
      logWarn('thumbnail.worker-failed-using-emergency-preview', {
        id, size, name: registered.record.originalName, error: String(error),
      });
      return fallback;
    } finally {
      imagePerformanceStats.thumbnailCount += 1;
      imagePerformanceStats.thumbnailMs += performance.now() - startedAt;
    }
  }, Number.isFinite(requestedPriority) ? requestedPriority : size <= 128 ? 3 : size <= 256 ? 2 : 1);
}

async function prewarmImages(ids, sender, requestId) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 2000) throw new Error('预热图片数量无效');
  const request = {
    canceled: false,
    ids: new Set(ids),
    hashes: new Set(ids.map((id) => assetRegistry.get(id)?.record.hash).filter(Boolean)),
  };
  prewarmRequests.set(requestId, request);
  if (sessionCachePath) void fs.writeFile(path.join(sessionCachePath, `prewarm-${requestId}.json`), JSON.stringify({ ids, startedAt: new Date().toISOString() })).catch(() => undefined);
  let completed = 0;
  let failed = 0;
  const detailFailed = 0;
  let lastFailedName;
  const previewFailedIds = new Set();
  const prewarmStartedAt = performance.now();
  logInfo('images.prewarm-start', { requestId, count: ids.length });
  const report = (stage, stageCompleted, stageTotal) => sender.send('images:prewarm-progress', {
    requestId, completed, total: ids.length, stage, stageCompleted, stageTotal, failed, detailFailed, lastFailedName,
  });
  const finish = () => {
    logInfo('images.prewarm-finish', {
      requestId, count: ids.length, completed, failed, detailFailed, canceled: request.canceled,
      durationMs: performance.now() - prewarmStartedAt,
    });
    prewarmRequests.delete(requestId);
    if (sessionCachePath) void fs.rm(path.join(sessionCachePath, `prewarm-${requestId}.json`), { force: true }).catch(() => undefined);
    void trimImageCacheForActive(new Set(assetRegistry.keys()));
  };
  const pixelWeights = new Map(ids.map((id) => {
    const record = assetRegistry.get(id)?.record;
    return [id, Math.max(1, (record?.naturalWidth ?? 1) * (record?.naturalHeight ?? 1))];
  }));
  const totalPixels = [...pixelWeights.values()].reduce((total, value) => total + value, 0);
  const progressById = new Map(ids.map((id) => [id, 0]));
  const reportPyramid = (id, stage, progress) => {
    const registeredBase = IMAGE_IMPORT_STAGE_WEIGHTS.metadata + IMAGE_IMPORT_STAGE_WEIGHTS.hash;
    const stageBase = stage === 'decode' ? registeredBase
      : stage === 'mip' ? registeredBase + IMAGE_IMPORT_STAGE_WEIGHTS.decode
        : registeredBase + IMAGE_IMPORT_STAGE_WEIGHTS.decode + IMAGE_IMPORT_STAGE_WEIGHTS.mip;
    const stageWeight = stage === 'decode' ? IMAGE_IMPORT_STAGE_WEIGHTS.decode
      : stage === 'mip' ? IMAGE_IMPORT_STAGE_WEIGHTS.mip : IMAGE_IMPORT_STAGE_WEIGHTS.commit;
    progressById.set(id, Math.min(0.95, stageBase + progress * stageWeight));
    const weighted = ids.reduce((total, assetId) => total
      + (progressById.get(assetId) ?? 0) * (pixelWeights.get(assetId) ?? 1), 0) / totalPixels;
    sender.send('images:prewarm-progress', {
      requestId, completed, total: ids.length, stage, stageCompleted: Math.round(weighted * 1000),
      stageTotal: 1000, fraction: weighted, failed, detailFailed, lastFailedName,
    });
  };
  sender.send('images:prewarm-progress', {
    requestId, completed: 0, total: ids.length, stage: 'decode',
    stageCompleted: 150, stageTotal: 1000, fraction: 0.15, failed, detailFailed,
  });
  try {
    await mapWithConcurrency(ids, async (id) => {
      if (request.canceled) return;
      try {
        await ensureImagePyramid(id, ({ stage, progress }) => reportPyramid(id, stage, progress));
        progressById.set(id, 0.95);
      } catch {
        if (!request.canceled) {
          failed += 1;
          previewFailedIds.add(id);
          lastFailedName = assetRegistry.get(id)?.record.originalName;
          await generateThumbnail(id, 128).catch(() => undefined);
        }
      } finally {
        completed += 1;
        progressById.set(id, 1);
        report('scene', completed, ids.length);
      }
    }, 1);
    if (request.canceled) {
      finish();
      return { canceled: true, completed, total: ids.length, failed, detailFailed };
    }
    finish();
    return { canceled: false, completed, total: ids.length, failed, detailFailed: 0 };
  } catch (error) {
    finish();
    throw error;
  }
}

async function generateTile(id, level, column, row, tileSize = 512, gutter = 1, priority = 3) {
  if (imageWorkerPaused) throw new Error('图片缓存正在迁移，请稍后重试');
  const registered = assetRegistry.get(id);
  if (!registered) throw new Error(`资源不存在：${id}`);
  if (![level, column, row, tileSize, gutter].every(Number.isInteger) || level < 0 || column < 0 || row < 0 || tileSize < 1 || gutter < 0) {
    throw new Error('分块参数无效');
  }
  const pyramidCached = await readPyramidTile(id, level, column, row).catch(() => undefined);
  if (pyramidCached) return pyramidCached;
  const key = `${registered.record.hash}:tile:${level}:${column}:${row}:${tileSize}:${gutter}`;
  try {
    const cached = await derivedCache.read(key);
    if (isPngBuffer(cached)) return cached;
    await derivedCache.remove(key);
  } catch { /* Create the requested tile below. */ }
  // Never wait for another imageJobs task while holding a queue slot. Two
  // simultaneous tiles used to occupy both slots and then wait forever for
  // their pyramid jobs to start.
  let levelPath;
  if (level === 0) levelPath = await ensureAssetFile(id);
  else {
    await generatePyramidLevel(id, level, priority);
    levelPath = derivedCache.pathFor(`${registered.record.hash}:pyramid:${level}`);
  }
  return imageJobs.enqueue(`tile:${key}`, async (signal) => {
    try {
      const cached = await derivedCache.read(key);
      if (isPngBuffer(cached)) return cached;
      await derivedCache.remove(key);
    } catch { /* The cache entry is absent or corrupt. */ }
    await runRegisteredImageWorker(`${registered.record.hash}:level:${level}`, undefined, {
      type: 'tile', level: 0, column, row, tileSize, gutter,
      outputRelativePath: cacheRelativePath(derivedCache.pathFor(key)),
    }, 30000, levelPath, signal);
    derivedCache.noteExternalWrite();
    return derivedCache.read(key);
  }, priority);
}

async function generatePyramidLevel(id, level, priority = 3) {
  if (imageWorkerPaused) throw new Error('图片缓存正在迁移，请稍后重试');
  const registered = assetRegistry.get(id);
  if (!registered) throw new Error(`资源不存在：${id}`);
  if (!Number.isInteger(level) || level < 0) throw new Error('分层参数无效');
  if (level === 0) return ensureAssetBuffer(id);
  const key = `${registered.record.hash}:pyramid:${level}`;
  try {
    const cached = await derivedCache.read(key);
    if (isPngBuffer(cached)) return cached;
    await derivedCache.remove(key);
  } catch { /* Generate the pyramid level below. */ }
  return imageJobs.enqueue(`pyramid:${key}`, async (signal) => {
    try {
      const cached = await derivedCache.read(key);
      if (isPngBuffer(cached)) return cached;
      await derivedCache.remove(key);
    } catch { /* The cache entry is absent or corrupt. */ }
    await ensureAssetFile(id);
    await runRegisteredImageWorker(registered.record.hash, undefined, {
      type: 'pyramid', level, outputRelativePath: cacheRelativePath(derivedCache.pathFor(key)),
    }, 30000, registered.cachePath, signal);
    derivedCache.noteExternalWrite();
    return derivedCache.read(key);
  }, priority);
}

async function assetResponse(request) {
  try {
    const url = new URL(request.url);
    const id = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const registered = assetRegistry.get(id);
    if (!registered) return new Response('Not found', { status: 404 });
    const variant = url.searchParams.get('variant') ?? 'original';
    if (variant === 'mip') {
      const edge = Number(url.searchParams.get('edge'));
      if (!IMAGE_MIP_EDGES.some((candidate) => candidate === edge)
        && edge !== Math.max(registered.record.naturalWidth, registered.record.naturalHeight)) {
        return new Response('Invalid mip edge', { status: 400 });
      }
      // A scene package carries its source assets, but the derived cache is
      // intentionally machine-local. Reopening on a new machine must rebuild
      // a missing/corrupt pyramid before answering the renderer request.
      const buffer = await readPyramidLevel(id, edge).catch(async () => {
        await ensureImagePyramid(id);
        return readPyramidLevel(id, edge);
      });
      return new Response(buffer, { headers: {
        'Content-Type': encodedImageContentType(buffer),
        'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*',
      } });
    }
    if (variant === 'tile') {
      const level = Number(url.searchParams.get('level'));
      const column = Number(url.searchParams.get('column'));
      const row = Number(url.searchParams.get('row'));
      const requestedPriority = Number(url.searchParams.get('priority'));
      const priority = Number.isFinite(requestedPriority) ? Math.max(0, Math.min(10, requestedPriority)) : 3;
      const buffer = await generateTile(id, level, column, row, 512, 1, priority);
      return new Response(buffer, { headers: {
        'Content-Type': encodedImageContentType(buffer), 'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*',
      } });
    }
    const thumbnailSize = variant === 'thumb128' ? 128 : variant === 'thumb256' ? 256
      : variant === 'thumb512' ? 512 : variant === 'thumb768' ? 768 : variant === 'thumb1024' ? 1024 : undefined;
    if (thumbnailSize) {
      if (thumbnailSize === 128) {
        // The 128px resource is the renderer's permanent safety plane. Never
        // answer this URL with the original file: its natural dimensions would
        // make WebGL reserve an original-sized atlas slot for every preview.
        const preview = forceThumbnailFailure
          ? await generateEmergencyThumbnail(id, thumbnailSize)
          : await generateThumbnail(id, thumbnailSize, 10);
        return new Response(new Uint8Array(preview), { headers: {
          'Content-Type': encodedImageContentType(preview),
          'Cache-Control': forceThumbnailFailure ? 'no-store, max-age=0' : 'public, max-age=31536000, immutable',
          'Access-Control-Allow-Origin': '*',
        } });
      }
      if (!forceThumbnailFailure) {
        const cached = await readPyramidLevel(id, thumbnailSize).catch(() => undefined)
          ?? await readCachedThumbnail(id, thumbnailSize);
        if (cached) return new Response(cached, { headers: {
          'Content-Type': encodedImageContentType(cached), 'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*',
        } });
        // Higher LODs are optional upgrades. Generate them asynchronously while
        // the always-resident 128px preview remains visible.
        void generateThumbnail(id, thumbnailSize, 8).catch((error) => {
          logWarn('thumbnail.background-generation-failed', { id, size: thumbnailSize, error: String(error) });
        });
      }
      return new Response('Thumbnail is being prepared', { status: 404, headers: {
        'Cache-Control': 'no-store, max-age=0', 'Access-Control-Allow-Origin': '*',
      } });
    }
    if (variant === 'original') {
      const cached = await readPyramidLevel(id, Math.min(4096, Math.max(
        registered.record.naturalWidth, registered.record.naturalHeight,
      ))).catch(() => undefined);
      if (cached) return new Response(cached, { headers: {
        'Content-Type': encodedImageContentType(cached),
        'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*',
      } });
    }
    return new Response('Committed image cache is unavailable', { status: 404, headers: {
      'Cache-Control': 'no-store, max-age=0', 'Access-Control-Allow-Origin': '*',
    } });
  } catch (error) {
    logError('asset-protocol.failure', error, { url: request.url });
    return new Response(String(error), { status: 500 });
  }
}

function normalizedColor(value) {
  if (!value || !['r', 'g', 'b'].every((key) => Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 255)) return;
  const hex = `#${[value.r, value.g, value.b].map((channel) => channel.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  return { r: value.r, g: value.g, b: value.b, hex };
}

async function applyPhotoshopForeground(color, returnFocus: boolean): Promise<PhotoshopColorSyncResult> {
  const startedAt = performance.now();
  const result = (
    syncStatus: PhotoshopColorSyncResult['syncStatus'],
    focusStatus: PhotoshopColorSyncResult['focusStatus'],
    copied: boolean,
    message?: string,
  ): PhotoshopColorSyncResult => ({
    ok: syncStatus === 'synced', status: syncStatus, syncStatus, focusStatus, copied,
    syncLatencyMs: performance.now() - startedAt, message,
  });
  const fakeMode = process.env.REFCANVAS_FAKE_PHOTOSHOP;
  if (smokeTest || fakeMode) {
    const mode = fakeMode || 'synced';
    if (mode === 'synced' || mode === '1') return result('synced', returnFocus ? 'activated' : 'skipped', false);
    clipboard.writeText(color.hex);
    if (mode === 'not-running') return result('not-running', returnFocus ? 'not-found' : 'skipped', true, 'Photoshop 未运行，颜色已复制');
    if (mode === 'timeout') return result('automation-error', returnFocus ? 'automation-error' : 'skipped', true, 'Photoshop 同步超时，颜色已复制');
    if (mode === 'automation-error') return result('automation-error', returnFocus ? 'automation-error' : 'skipped', true, 'Photoshop 自动化失败，颜色已复制');
    return result('synced', returnFocus ? 'activated' : 'skipped', false);
  }
  if (process.platform !== 'win32') {
    clipboard.writeText(color.hex);
    return result('unsupported', 'skipped', true, '当前平台不支持 Photoshop COM，颜色已复制');
  }
  const bridgeResult = await photoshopColorBridge.commit(color, returnFocus);
  if (bridgeResult.syncStatus === 'synced') {
    return result('synced', bridgeResult.focusStatus, false,
      returnFocus && bridgeResult.focusStatus !== 'activated' ? '颜色已同步，但未能自动返回 Photoshop' : undefined);
  }
  clipboard.writeText(color.hex);
  if (bridgeResult.syncStatus === 'not-running') {
    return result('not-running', bridgeResult.focusStatus, true, 'Photoshop 未运行，颜色已复制');
  }
  return result('automation-error', bridgeResult.focusStatus, true, 'Photoshop 自动化失败，颜色已复制');
}

const photoshopSyncQueue = createPhotoshopSyncQueue(async ({ color, returnFocus }) => {
  try { return await applyPhotoshopForeground(color, returnFocus); }
  catch {
    clipboard.writeText(color.hex);
    return {
      ok: false, status: 'automation-error', syncStatus: 'automation-error',
      focusStatus: returnFocus ? 'automation-error' : 'skipped', copied: true,
      syncLatencyMs: 0, message: 'Photoshop 自动化失败，颜色已复制',
    };
  }
});

const statePath = () => path.join(app.getPath('userData'), 'state.json');

function enqueueSceneSave(filePath, scene, revision) {
  dirtyRevisionState = updateDirtyRevision(dirtyRevisionState, true, revision);
  const savedScene = { ...scene, name: path.basename(filePath, '.refcanvas'), savedAt: new Date().toISOString() };
  return enqueuePersistence(async () => {
    const startedAt = performance.now();
    try {
      await writeScenePackage(filePath, savedScene);
      currentScenePath = filePath;
      dirtyRevisionState = markRevisionSaved(dirtyRevisionState, revision);
      const savedAssetIds: string[] = (savedScene.items ?? []).flatMap((item: { assetId?: unknown }) => (
        typeof item.assetId === 'string' ? [item.assetId] : []
      ));
      await addRecent(filePath, [...new Set(savedAssetIds)]);
      logInfo('scene.saved', {
        name: path.basename(filePath), items: scene.items?.length ?? 0, assets: Object.keys(scene.assets ?? {}).length,
        durationMs: performance.now() - startedAt,
      });
      return { canceled: false, path: filePath, scene: savedScene, revision };
    } catch (error) {
      logError('scene.save-failed', error, { name: path.basename(filePath), durationMs: performance.now() - startedAt });
      throw error;
    }
  });
}

async function readState() {
  try { return JSON.parse(await fs.readFile(statePath(), 'utf8')); }
  catch { return { recent: [] }; }
}

async function writeState(state) {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(statePath(), JSON.stringify(state, null, 2), 'utf8');
}

async function directorySize(directory) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch { return 0; }
  return (await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return directorySize(target);
    if (!entry.isFile()) return 0;
    try { return (await fs.stat(target)).size; } catch { return 0; }
  }))).reduce((total, bytes) => total + bytes, 0);
}

function cacheLocationInfo() {
  const root = cacheRootDir();
  return Promise.all([directorySize(assetCacheDir()), directorySize(path.join(root, 'derived-cache'))]).then(([assetBytes, derivedBytes]) => ({
    root,
    isDefault: !cacheRootOverride,
    assetBytes,
    derivedBytes,
    warning: cacheRootOverride && /(?:onedrive|dropbox|google drive|\\\\)/i.test(cacheRootOverride)
      ? '此位置可能是同步或网络目录，缓存性能可能不稳定。' : undefined,
  }));
}

async function validateCacheParent(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('缓存位置无效');
  await fs.mkdir(directory, { recursive: true });
  const probe = path.join(directory, `.refcanvas-write-test-${process.pid}-${Date.now()}`);
  await fs.writeFile(probe, '');
  await fs.rm(probe, { force: true });
}

async function setCacheLocation(directory = undefined) {
  const nextOverride = directory || undefined;
  if (nextOverride) await validateCacheParent(nextOverride);
  const sourceRoot = cacheRootDir();
  const targetRoot = nextOverride ? path.join(nextOverride, 'RefCanvas') : app.getPath('userData');
  if (path.resolve(sourceRoot) === path.resolve(targetRoot)) return cacheLocationInfo();
  const sourceAsset = assetCacheDir();
  const sourceDerived = path.join(sourceRoot, 'derived-cache');
  const sourceImage = imageCachePaths.cacheRoot();
  const targetAsset = path.join(targetRoot, 'asset-cache');
  const targetDerived = path.join(targetRoot, 'derived-cache');
  const targetImage = path.join(targetRoot, 'image-cache', `v${IMAGE_CACHE_FORMAT_VERSION}`);
  const pyramidIdsToVerify = [];
  for (const entry of assetRegistry.values()) {
    try {
      await readImagePyramidManifest(imageCachePaths, entry.record);
      pyramidIdsToVerify.push(entry.record.id);
    } catch { /* No committed pyramid existed before migration. */ }
  }
  const targetIsInside = (source) => {
    const relative = path.relative(source, targetRoot);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  if (targetIsInside(sourceAsset) || targetIsInside(sourceDerived) || targetIsInside(sourceImage)) {
    throw new Error('新缓存位置不能位于当前缓存目录内部');
  }
  try {
    await suspendImageWorkerForCacheMigration();
    await fs.mkdir(targetRoot, { recursive: true });
    try {
      await fs.cp(sourceAsset, targetAsset, { recursive: true, force: false, errorOnExist: false });
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    try {
      await fs.cp(sourceDerived, targetDerived, { recursive: true, force: false, errorOnExist: false });
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    try {
      await fs.cp(sourceImage, targetImage, { recursive: true, force: true, errorOnExist: false });
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const state = await readState();
    if (nextOverride) state.cacheRoot = nextOverride; else delete state.cacheRoot;
    await writeState(state);
    cacheRootOverride = nextOverride;
    derivedCache = createAppDerivedCache();
    if (sessionCachePath) await fs.rm(sessionCachePath, { recursive: true, force: true });
    await initializeSessionCache();
    assetRegistry.forEach((entry) => { entry.cachePath = assetCachePath(entry.record); });
    imageWorkerAssets.clear();
    await runImageWorker({ type: 'ping' }, 5000, true);
    await mapWithConcurrency([...assetRegistry.values()], async (entry) => {
      await ensureAssetFile(entry.record.id);
      await ensureImageWorkerAsset(entry.record.id, undefined, entry.cachePath, true);
      await runImageWorker({ type: 'verify', assetId: entry.record.id, assetKey: entry.record.id }, 5000, true);
    }, 4);
    await mapWithConcurrency(pyramidIdsToVerify, async (id) => {
      const entry = assetRegistry.get(id);
      if (!entry) throw new Error(`迁移后资源登记缺失：${id}`);
      await readImagePyramidManifest(imageCachePaths, entry.record);
    }, 4);
    await fs.rm(sourceAsset, { recursive: true, force: true });
    await fs.rm(sourceDerived, { recursive: true, force: true });
    await fs.rm(sourceImage, { recursive: true, force: true });
    return cacheLocationInfo();
  } finally {
    imageWorkerPaused = false;
  }
}

async function loadCacheLocation() {
  const state = await readState();
  if (typeof state.cacheRoot !== 'string' || !path.isAbsolute(state.cacheRoot)) return;
  try {
    await validateCacheParent(state.cacheRoot);
    cacheRootOverride = state.cacheRoot;
    derivedCache = createAppDerivedCache();
  } catch {
    delete state.cacheRoot;
    await writeState(state);
  }
}

async function initializeSessionCache() {
  const root = sessionCacheDir();
  await fs.mkdir(root, { recursive: true });
  const entries = await fs.readdir(root, { withFileTypes: true });
  await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => fs.rm(path.join(root, entry.name), { recursive: true, force: true })));
  sessionCachePath = path.join(root, `${process.pid}-${Date.now()}`);
  await fs.mkdir(sessionCachePath, { recursive: true });
  await fs.writeFile(path.join(sessionCachePath, 'session.json'), JSON.stringify({ startedAt: new Date().toISOString() }), 'utf8');
  const staleTemporaryRoot = path.join(imageCachePaths.cacheRoot(), 'tmp');
  const cleanupTimer = setTimeout(() => { void fs.rm(staleTemporaryRoot, { recursive: true, force: true }); }, 1000);
  cleanupTimer.unref?.();
}

async function addRecent(filePath, assetIds: string[] = []) {
  const state = await readState();
  const item = {
    path: filePath,
    name: path.basename(filePath, path.extname(filePath)),
    openedAt: new Date().toISOString(),
    assetIds: [...new Set(assetIds)],
  };
  state.recent = [item, ...(state.recent ?? []).filter((entry) => entry.path !== filePath)].slice(0, 12);
  await writeState(state);
}

async function hydrateLegacyRecentAssetIndexes() {
  const state = await readState();
  const current = state.recent ?? [];
  if (!current.some((entry) => !Array.isArray(entry.assetIds))) return;
  state.recent = await hydrateRecentAssetIds(current, readSceneAssetIds);
  await writeState(state);
}

function disableClickThrough() {
  if (!mainWindow || !windowState.clickThrough) return;
  windowState.clickThrough = false;
  mainWindow.setIgnoreMouseEvents(false);
  mainWindow.webContents.send('window:click-through-disabled');
}

function updateWindowMove() {
  if (!mainWindow || !windowMoveSession?.active || windowState.locked || mainWindow.isMaximized()) return;
  const cursor = screen.getCursorScreenPoint();
  const nextX = Math.round(windowMoveSession.x + cursor.x - windowMoveSession.cursorX);
  const nextY = Math.round(windowMoveSession.y + cursor.y - windowMoveSession.cursorY);
  if (windowMoveSession.lastX === nextX && windowMoveSession.lastY === nextY) return;
  windowMoveSession.lastX = nextX;
  windowMoveSession.lastY = nextY;
  mainWindow.setPosition(nextX, nextY, false);
}

function scheduleWindowMoveFrame(delay = WINDOW_MOVE_FRAME_MS) {
  if (windowMoveTimer || !windowMoveSession?.active) return;
  windowMoveTimer = setTimeout(() => {
    windowMoveTimer = undefined;
    if (!windowMoveSession?.active) return;
    const startedAt = performance.now();
    updateWindowMove();
    const elapsed = performance.now() - startedAt;
    scheduleWindowMoveFrame(Math.max(0, WINDOW_MOVE_FRAME_MS - elapsed));
  }, delay);
}

function notifyNativeWindowMoveFinished() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('window:move-finished');
}

function handleNativeWindowMoveOutput(chunk) {
  nativeWindowMoveOutput += chunk.toString();
  const lines = nativeWindowMoveOutput.split(/\r?\n/);
  nativeWindowMoveOutput = lines.pop() ?? '';
  for (const line of lines) {
    if (line.startsWith('KEY|')) {
      const [, requestId, value] = line.split('|');
      const pending = requestId ? pendingNativeKeyQueries.get(requestId) : undefined;
      if (pending) {
        clearTimeout(pending.timer);
        pendingNativeKeyQueries.delete(requestId);
        pending.resolve(value === '1');
      }
      continue;
    }
    if (line.startsWith('LAYER|')) {
      const [, requestId, status] = line.split('|');
      const pending = requestId ? pendingNativeLayerRequests.get(requestId) : undefined;
      if (pending) {
        clearTimeout(pending.timer);
        pendingNativeLayerRequests.delete(requestId);
        nonActivatingWindowReady = pending.enabled && status === 'READY';
        pending.resolve(status === 'READY');
      }
      continue;
    }
    if (line === 'READY') {
      logInfo('window.native-helper-output', { line });
    }
    if (line === 'READY') {
      nativeWindowMoveReady = true;
      setImmediate(() => setMainWindowFlatAppearance());
    }
    else if (line === 'APPEARANCE_DONE') logInfo('window.flat-appearance-applied');
    else if (line === 'APPEARANCE_SKIPPED') logWarn('window.flat-appearance-unavailable');
    else if (line.startsWith('ERROR ')) {
      logWarn('window.native-helper-command-failed', { message: line });
      notifyNativeWindowMoveFinished();
    } else if (line === 'DONE' || line === 'SKIPPED') {
      notifyNativeWindowMoveFinished();
    }
  }
}

function startNativeWindowMoveHelper() {
  if (process.platform !== 'win32' || nativeWindowMoveHelper) return;
  nativeWindowMoveReady = false;
  nonActivatingWindowReady = false;
  nativeWindowMoveHelper = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(rootDir, 'electron', 'native', 'native-window-move.ps1'),
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  nativeWindowMoveHelper.stdout.on('data', handleNativeWindowMoveOutput);
  nativeWindowMoveHelper.stderr.setEncoding('utf8');
  nativeWindowMoveHelper.stderr.on('data', (chunk: string) => {
    logWarn('window.native-helper-stderr', { message: chunk.trim() });
  });
  nativeWindowMoveHelper.stdin.on('error', (error) => {
    logWarn('window.native-move-stdin-failed', { code: error?.code, message: error?.message });
    nativeWindowMoveHelper?.kill();
    nativeWindowMoveHelper = undefined;
    nativeWindowMoveReady = false;
  });
  nativeWindowMoveHelper.on('exit', () => {
    nativeWindowMoveHelper = undefined;
    nativeWindowMoveReady = false;
    nonActivatingWindowReady = false;
    nativeWindowMoveOutput = '';
    pendingNativeLayerRequests.forEach((pending) => {
      clearTimeout(pending.timer);
      pending.resolve(false);
    });
    pendingNativeLayerRequests.clear();
  });
  nativeWindowMoveHelper.on('error', () => {
    nativeWindowMoveHelper = undefined;
    nativeWindowMoveReady = false;
  });
}

function beginNativeWindowMove() {
  if (!nativeWindowMoveReady || !nativeWindowMoveHelper?.stdin.writable || !mainWindow || mainWindow.isDestroyed()) return false;
  const handleBuffer = mainWindow.getNativeWindowHandle();
  const handle = handleBuffer.length >= 8 ? handleBuffer.readBigUInt64LE(0) : BigInt(handleBuffer.readUInt32LE(0));
  nativeWindowMoveHelper.stdin.write(`${handle}\n`, (error) => {
    if (!error) return;
    logWarn('window.native-move-write-failed', { code: error.code, message: error.message });
    nativeWindowMoveHelper?.kill();
    nativeWindowMoveHelper = undefined;
    nativeWindowMoveReady = false;
  });
  return true;
}

function nativeWindowHandleValue() {
  if (!mainWindow || mainWindow.isDestroyed()) return undefined;
  const handleBuffer = mainWindow.getNativeWindowHandle();
  return handleBuffer.length >= 8 ? handleBuffer.readBigUInt64LE(0) : BigInt(handleBuffer.readUInt32LE(0));
}

function waitForNativeWindowMoveHelper(timeoutMs = 1500) {
  if (process.platform !== 'win32' || nativeWindowMoveReady) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (nativeWindowMoveReady) { resolve(true); return; }
      if (Date.now() >= deadline) { resolve(false); return; }
      setTimeout(poll, 15).unref?.();
    };
    poll();
  });
}

function requestNativeWindowLayer(enabled: boolean, timeoutMs = 1500) {
  if (process.platform !== 'win32') return Promise.resolve(true);
  return waitForNativeWindowMoveHelper(timeoutMs).then((ready) => {
    if (!ready) {
      nonActivatingWindowReady = false;
      return !enabled;
    }
    const helper = nativeWindowMoveHelper;
    const handle = nativeWindowHandleValue();
    if (!helper?.stdin.writable || handle === undefined) return !enabled;
    const requestId = String(++nativeLayerRequestId);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        pendingNativeLayerRequests.delete(requestId);
        nonActivatingWindowReady = false;
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      pendingNativeLayerRequests.set(requestId, { enabled, resolve, timer });
      helper.stdin.write(`LAYER|${requestId}|${handle}|${enabled ? '1' : '0'}\n`, (error) => {
        if (!error) return;
        const pending = pendingNativeLayerRequests.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingNativeLayerRequests.delete(requestId);
        nonActivatingWindowReady = false;
        pending.resolve(false);
      });
    });
  });
}

function transitionNativeWindowLayer(enabled: boolean) {
  const transition = nativeLayerTransition.then(() => requestNativeWindowLayer(enabled));
  nativeLayerTransition = transition.then(() => undefined, () => undefined);
  return transition;
}

function scheduleNativeWindowLayerRepair() {
  if (!mainWindow || mainWindow.isDestroyed() || !shouldUseFocuslessPhotoshopPicker(windowState)) return;
  if (nativeLayerRepairTimer) return;
  nativeLayerRepairTimer = setTimeout(() => {
    nativeLayerRepairTimer = undefined;
    if (!mainWindow || mainWindow.isDestroyed() || !shouldUseFocuslessPhotoshopPicker(windowState)) return;
    void transitionNativeWindowLayer(true).then((ready) => {
      if (!ready) logWarn('window.collaboration-layer-repair-failed');
    });
  }, 80);
  nativeLayerRepairTimer.unref?.();
}

function setMainWindowFlatAppearance() {
  if (!nativeWindowMoveReady || !nativeWindowMoveHelper?.stdin.writable) return;
  const handle = nativeWindowHandleValue();
  if (handle === undefined) return;
  nativeWindowMoveHelper.stdin.write(`APPEARANCE|${handle}\n`, (error) => {
    if (!error) return;
    logWarn('window.flat-appearance-write-failed', { code: error.code, message: error.message });
  });
}

function queryNativeKeyDown(virtualKey: number) {
  if (!nativeWindowMoveReady || !nativeWindowMoveHelper?.stdin.writable) return Promise.resolve(false);
  const requestId = String(++nativeKeyRequestId);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pendingNativeKeyQueries.delete(requestId);
      resolve(false);
    }, 120);
    timer.unref?.();
    pendingNativeKeyQueries.set(requestId, { resolve, timer });
    nativeWindowMoveHelper?.stdin.write(`KEY|${requestId}|${virtualKey}\n`, (error) => {
      if (!error) return;
      const pending = pendingNativeKeyQueries.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingNativeKeyQueries.delete(requestId);
      pending.resolve(false);
    });
  });
}

function finishWindowMove() {
  if (windowMoveTimer) clearTimeout(windowMoveTimer);
  windowMoveTimer = undefined;
  windowMoveSession = undefined;
}

function createWindow() {
  logInfo('window.create', { width: 1280, height: 820, smokeTest, projectZoomBenchmark });
  mainWindow = new BrowserWindow({
    title: '未命名画板 · Yoiniwa',
    icon: path.join(rootDir, app.isPackaged ? 'dist' : 'public', 'yoiniwa-icon.png'),
    width: 1280,
    height: 820,
    minWidth: 1,
    minHeight: 1,
    frame: false,
    hasShadow: false,
    roundedCorners: false,
    transparent: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(electronRuntimeDir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  // Explicitly repeat this after construction because the native focus/taskbar
  // helper may later trigger a non-client frame refresh on Windows.
  mainWindow.setHasShadow(false);

  mainWindow.once('ready-to-show', () => {
    // requestAnimationFrame is visibility-throttled in a hidden BrowserWindow.
    // The stress harness must be composited like the real application or its FPS
    // measurements only describe Chromium's hidden-page timer policy.
    if (smokeTest || stressTest || performanceBenchmark || projectZoomBenchmark || realImageTest) mainWindow.showInactive();
    else if (!smokeTest) mainWindow.show();
  });
  mainWindow.webContents.on('did-finish-load', () => logInfo('renderer.loaded', { url: mainWindow?.webContents.getURL() }));
  mainWindow.webContents.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
    logError('renderer.load-failed', new Error(description), { code, validatedURL, isMainFrame });
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => logError('renderer.process-gone', new Error(details.reason), details));
  mainWindow.webContents.on('console-message', (details) => {
    if (!details || !['warning', 'error'].includes(details.level)) return;
    log(details.level === 'error' ? 'error' : 'warn', 'renderer.console', {
      message: details.message, line: details.lineNumber, source: details.sourceId,
    });
  });
  mainWindow.on('unresponsive', () => logWarn('window.unresponsive'));
  mainWindow.on('responsive', () => logInfo('window.responsive'));
  if (photoshopRoundTripSmoke) mainWindow.webContents.once('did-finish-load', () => setTimeout(async () => {
    try {
      const results = await mainWindow.webContents.executeJavaScript(`(async () => {
        const api = window.refCanvas;
        const combinations = [
          { locked: false, alwaysOnTop: false },
          { locked: true, alwaysOnTop: false },
          { locked: false, alwaysOnTop: true },
          { locked: true, alwaysOnTop: true },
        ];
        const outcomes = [];
        for (const mode of combinations) {
          await api.setWindowMode(mode);
          outcomes.push(await api.syncPhotoshopForeground({ r: 12, g: 34, b: 56, hex: '#0C2238' }, true));
        }
        const optedOut = await api.syncPhotoshopForeground({ r: 65, g: 43, b: 21, hex: '#412B15' }, false);
        return { outcomes, optedOut };
      })()`);
      // WS_EX_NOACTIVATE makes Electron report isFocusable() as false even
      // though WS_EX_APPWINDOW preserves the taskbar entry and clicks are
      // still delivered to the window. Verify the native style acknowledgement
      // instead of Electron's derived focusable flag.
      // PowerShell needs longer than one frame to compile its native bridge
      // on a cold start, so wait for that bridge rather than guessing.
      const focuslessDeadline = Date.now() + 3000;
      while (process.platform === 'win32' && !nonActivatingWindowReady && Date.now() < focuslessDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const expectedFocus = ['skipped', 'skipped', 'skipped', 'skipped'];
      const focuslessWindowReady = mainWindow.isAlwaysOnTop()
        && (process.platform !== 'win32' || nonActivatingWindowReady);
      const valid = results.outcomes.every((result, index) => result.syncStatus === 'synced'
        && result.focusStatus === expectedFocus[index] && result.copied === false)
        && results.optedOut.syncStatus === 'synced' && results.optedOut.focusStatus === 'skipped'
        && focuslessWindowReady;
      console.log(`Yoiniwa Photoshop round-trip smoke: ${JSON.stringify({
        ...results, focuslessWindowReady,
      })}`);
      if (!valid) process.exitCode = 1;
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
    dirtyRevisionState = createDirtyRevisionState();
    app.exit(Number(process.exitCode) || 0);
  }, 300));
  else if (pixiCanvasSmoke) mainWindow.webContents.once('did-finish-load', () => setTimeout(async () => {
    try {
      const canvasReady = await mainWindow.webContents.executeJavaScript(
        `Boolean(document.querySelector('[data-canvas-runtime="pixi-v8"] canvas.pixi-canvas'))`,
      );
      const smokePng = nativeImage.createFromDataURL(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      ).toPNG();
      const smokeAsset = await registerAssetBuffer(`pixi-smoke-${Date.now()}.png`, smokePng, undefined, 'clipboard');
      await mainWindow.webContents.executeJavaScript(
        `window.dispatchEvent(new CustomEvent('refcanvas-smoke-add-paths', { detail: [${JSON.stringify(assetCachePath(smokeAsset.asset))}] }))`,
      );
      let imageReady = false;
      for (let attempt = 0; attempt < 50 && !imageReady; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        imageReady = await mainWindow.webContents.executeJavaScript(`(() => {
          const canvas = document.querySelector('canvas.pixi-canvas');
          return Number(canvas?.dataset.totalImages || 0) === 1 && Number(canvas?.dataset.gpuTextures || 0) >= 1;
        })()`);
      }
      if (!canvasReady || !imageReady) {
        const state = await mainWindow.webContents.executeJavaScript(`(() => {
          const canvas = document.querySelector('canvas.pixi-canvas');
          return { total: canvas?.dataset.totalImages, visible: canvas?.dataset.visibleImages,
            gpu: canvas?.dataset.gpuTextures, decode: canvas?.dataset.decodeQueue,
            upload: canvas?.dataset.uploadQueue, misses: canvas?.dataset.cacheMisses,
            textureError: canvas?.dataset.textureError,
            status: document.querySelector('.status-toast')?.textContent };
        })()`);
        console.error('Pixi canvas smoke did not become ready', { canvasReady, imageReady, state });
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
    dirtyRevisionState = createDirtyRevisionState();
    app.exit(Number(process.exitCode) || 0);
  }, 500));
  else if (projectZoomBenchmark) mainWindow.webContents.once('did-finish-load', () => setTimeout(async () => {
    try {
      await runProjectZoomBenchmark({
        mainWindow, rootDir, app, writeScenePackage, readScenePackage,
        projectPath: process.env.REFCANVAS_PROJECT_BENCH_PATH,
        cycles: Number(process.env.REFCANVAS_PROJECT_BENCH_CYCLES || 1),
      });
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
    dirtyRevisionState = createDirtyRevisionState();
    app.exit(Number(process.exitCode) || 0);
  }, 150));
  else if (performanceBenchmark) mainWindow.webContents.once('did-finish-load', () => setTimeout(async () => {
    try {
      await runPerformanceBenchmark({
        mainWindow, rootDir, app, writeScenePackage, readScenePackage,
        phase: process.env.REFCANVAS_PERF_PHASE || 'before',
      });
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
    dirtyRevisionState = createDirtyRevisionState();
    app.exit(Number(process.exitCode) || 0);
  }, 500));
  else if (realImageTest) mainWindow.webContents.once('did-finish-load', () => setTimeout(async () => {
    try {
      const requestedRoot = process.env.REFCANVAS_REAL_IMAGE_DIR;
      const imageRoot = requestedRoot && path.isAbsolute(requestedRoot) ? requestedRoot : path.join(rootDir, 'res');
      const imagePaths = (await fs.readdir(imageRoot, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && mimeByExt[path.extname(entry.name).toLowerCase()])
        .map((entry) => path.join(imageRoot, entry.name));
      const startedAt = Date.now();
      await mainWindow.webContents.executeJavaScript(
        `window.dispatchEvent(new CustomEvent('refcanvas-smoke-add-paths', { detail: ${JSON.stringify(imagePaths)} }))`,
      );
      let state: { total: number; visible: number; gpu: number; decode: number; upload: number;
        peakGpuBytes?: number; peakCpuBytes?: number; peakDecode?: number; peakUpload?: number; peakFrameUploadBytes?: number } = {
        total: 0, visible: 0, gpu: 0, decode: 0, upload: 0,
      };
      // Full pyramid import is intentionally completed before Scene commit.
      // The 620-asset acceptance corpus needs a pixel-workload budget rather
      // than the old thumbnail-era 400 ms/file timeout.
      const deadline = Date.now() + Math.max(12_000, imagePaths.length * 1_500);
      while (Date.now() < deadline) {
        state = await mainWindow.webContents.executeJavaScript(`(() => {
          const canvas = document.querySelector('canvas.pixi-canvas');
          return {
            total: Number(canvas?.dataset.totalImages || 0),
            visible: Number(canvas?.dataset.visibleImages || 0),
            gpu: Number(canvas?.dataset.gpuTextures || 0),
            decode: Number(canvas?.dataset.decodeQueue || 0),
            upload: Number(canvas?.dataset.uploadQueue || 0),
            peakGpuBytes: Number(canvas?.dataset.peakGpuBytes || 0),
            peakCpuBytes: Number(canvas?.dataset.peakCpuImageBytes || 0),
            peakDecode: Number(canvas?.dataset.peakDecodeQueue || 0),
            peakUpload: Number(canvas?.dataset.peakUploadQueue || 0),
            peakFrameUploadBytes: Number(canvas?.dataset.peakFrameUploadBytes || 0),
          };
        })()`);
        if (state.total === imagePaths.length && state.gpu >= Math.min(state.visible, imagePaths.length)
          && state.decode === 0 && state.upload === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const capturePath = path.join(app.getPath('temp'), 'refcanvas-real-images.png');
      await fs.writeFile(capturePath, (await mainWindow.webContents.capturePage()).toPNG());
      console.log(`RefCanvas Pixi real image diagnostic: ${JSON.stringify({
        ...state, imageCount: imagePaths.length, elapsedMs: Date.now() - startedAt, capturePath,
      })}`);
      if (state.total !== imagePaths.length || state.gpu < Math.min(state.visible, imagePaths.length)) process.exitCode = 1;
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
    dirtyRevisionState = createDirtyRevisionState();
    app.exit(Number(process.exitCode) || 0);
  }, 500));
  else if (stressTest) mainWindow.webContents.once('did-finish-load', () => setTimeout(async () => {
    try {
      const result = await mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
        const canvas = document.querySelector('canvas.pixi-canvas');
        const intervals = [];
        let previous;
        let frame = 0;
        const startedAt = performance.now();
        const step = (timestamp) => {
          if (previous !== undefined) intervals.push(timestamp - previous);
          previous = timestamp;
          canvas?.dispatchEvent(new WheelEvent('wheel', {
            bubbles: true, cancelable: true, clientX: innerWidth / 2, clientY: innerHeight / 2,
            deltaY: frame < 90 ? -3 : 3,
          }));
          frame += 1;
          if (frame < 180) return requestAnimationFrame(step);
          const sorted = [...intervals].sort((left, right) => left - right);
          const percentile = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] || 0;
          setTimeout(() => resolve({
            runtime: document.querySelector('[data-canvas-runtime="pixi-v8"]')?.dataset.canvasRuntime,
            total: Number(canvas?.dataset.totalImages || 0),
            visible: Number(canvas?.dataset.visibleImages || 0),
            gpuTextures: Number(canvas?.dataset.gpuTextures || 0),
            gpuBytes: Number(canvas?.dataset.gpuBytes || 0),
            cpuBytes: Number(canvas?.dataset.cpuImageBytes || 0),
            decodeQueue: Number(canvas?.dataset.decodeQueue || 0),
            uploadQueue: Number(canvas?.dataset.uploadQueue || 0),
            durationMs: performance.now() - startedAt,
            frameP95Ms: percentile(0.95),
            frameP99Ms: percentile(0.99),
          }), 400);
        };
        requestAnimationFrame(step);
      })`);
      console.log(`RefCanvas Pixi stress: ${JSON.stringify(result)}`);
      const hardwarePerformanceRun = process.env.REFCANVAS_HARDWARE_PERF === '1';
      if (result.runtime !== 'pixi-v8' || result.durationMs > 15_000
        || (hardwarePerformanceRun && result.frameP95Ms > 25)) process.exitCode = 1;
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
    dirtyRevisionState = createDirtyRevisionState();
    app.exit(Number(process.exitCode) || 0);
  }, 1200));
  else if (smokeTest) mainWindow.webContents.once('did-finish-load', () => setTimeout(async () => {
    try {
      const ready = await mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
        const root = document.querySelector('[data-canvas-runtime="pixi-v8"]');
        const canvas = root?.querySelector('canvas.pixi-canvas');
        const bounds = root?.getBoundingClientRect();
        canvas?.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, clientX: 40, clientY: 40, button: 2,
        }));
        setTimeout(() => {
          const menuOpened = Boolean(document.querySelector('.context-menu-root'));
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          resolve(Boolean(window.refCanvas && canvas && menuOpened && bounds
            && Math.abs(bounds.width - innerWidth) < 1 && Math.abs(bounds.height - innerHeight) < 1));
        }, 80);
      })`);
      const smokePng = nativeImage.createFromDataURL(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      ).toPNG();
      const smokeAsset = await registerAssetBuffer(`pixi-smoke-${Date.now()}.png`, smokePng, undefined, 'clipboard');
      const registered = await mainWindow.webContents.executeJavaScript(
        `window.refCanvas.registerImagePaths([${JSON.stringify(assetCachePath(smokeAsset.asset))}], 'drop')
          .then((items) => items.length === 1 && Boolean(items[0].assetId))`,
      );
      await mainWindow.webContents.executeJavaScript(
        `window.dispatchEvent(new CustomEvent('refcanvas-smoke-add-paths', { detail: [${JSON.stringify(assetCachePath(smokeAsset.asset))}] }))`,
      );
      let imageReady = false;
      for (let attempt = 0; attempt < 60 && !imageReady; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        imageReady = await mainWindow.webContents.executeJavaScript(`(() => {
          const canvas = document.querySelector('canvas.pixi-canvas');
          return Number(canvas?.dataset.totalImages || 0) === 1
            && Number(canvas?.dataset.gpuTextures || 0) >= 1;
        })()`);
      }
      const waitForRenderer = (milliseconds = 100) => new Promise((resolve) => setTimeout(resolve, milliseconds));
      const setup = imageReady ? await mainWindow.webContents.executeJavaScript(`(async () => {
        const api = window.__refCanvasPerf;
        if (!api) return undefined;
        const scene = structuredClone(api.getScene());
        const first = scene.items[0];
        if (!first) return undefined;
        Object.assign(first, { id: 'acceptance-a', x: 0, y: 0, width: 100, height: 100, rotation: 0, locked: false, zIndex: 0 });
        scene.items = [first, { ...first, id: 'acceptance-b', name: 'second.png', x: 150, zIndex: 1 }];
        scene.viewport = { x: 220, y: 220, scale: 1 };
        api.loadScene(scene);
        await new Promise((resolve) => setTimeout(resolve, 120));
        return { first: { x: 270, y: 270 }, second: { x: 420, y: 270 }, empty: { x: 205, y: 205 }, boxEnd: { x: 530, y: 350 } };
      })()`) : undefined;
      let interactionReady = false;
      let lifecycleResult: Record<string, unknown> | undefined;
      let interactionChecks: Record<string, boolean> | undefined;
      let zoomDiagnostic: Record<string, unknown> | undefined;
      if (setup) {
        const click = async (point: { x: number; y: number }, modifiers?: ('control')[]) => {
          mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1, modifiers });
          mainWindow.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1, modifiers });
          await waitForRenderer(60);
        };
        await click(setup.first);
        const selectionAfterFirst = await mainWindow.webContents.executeJavaScript(
          `Number(document.querySelector('canvas.pixi-canvas')?.dataset.selectedImages || 0)`,
        );
        mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Control' });
        await click(setup.second, ['control']);
        mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Control' });
        const selectionAfterSecond = await mainWindow.webContents.executeJavaScript(
          `Number(document.querySelector('canvas.pixi-canvas')?.dataset.selectedImages || 0)`,
        );
        const multiSelected = selectionAfterFirst === 1 && selectionAfterSecond === 2;
        mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x: setup.first.x, y: setup.first.y, button: 'left', clickCount: 1 });
        mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: setup.first.x + 30, y: setup.first.y + 20, button: 'left' });
        mainWindow.webContents.sendInputEvent({ type: 'mouseUp', x: setup.first.x + 30, y: setup.first.y + 20, button: 'left', clickCount: 1 });
        await waitForRenderer(120);
        const moved = await mainWindow.webContents.executeJavaScript(`(() => {
          const items = window.__refCanvasPerf?.getScene().items;
          return items?.[0].x === 30 && items?.[0].y === 20 && items?.[1].x === 180 && items?.[1].y === 20;
        })()`);
        mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] });
        mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] });
        await waitForRenderer(100);
        const undoneOnce = await mainWindow.webContents.executeJavaScript(`(() => {
          const items = window.__refCanvasPerf?.getScene().items;
          return items?.[0].x === 0 && items?.[1].x === 150;
        })()`);
        mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Y', modifiers: ['control'] });
        mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Y', modifiers: ['control'] });
        await waitForRenderer(100);
        const redoneOnce = await mainWindow.webContents.executeJavaScript(`(() => {
          const items = window.__refCanvasPerf?.getScene().items;
          return items?.[0].x === 30 && items?.[1].x === 180;
        })()`);
        await mainWindow.webContents.executeJavaScript(`(() => {
          const api = window.__refCanvasPerf; const scene = structuredClone(api.getScene());
          scene.items[1].locked = true; scene.viewport = { x: 220, y: 220, scale: 1 }; api.loadScene(scene);
        })()`);
        await waitForRenderer(100);
        mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x: setup.second.x + 30, y: setup.second.y + 20, button: 'left', clickCount: 1 });
        mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: setup.second.x + 60, y: setup.second.y + 40, button: 'left' });
        mainWindow.webContents.sendInputEvent({ type: 'mouseUp', x: setup.second.x + 60, y: setup.second.y + 40, button: 'left', clickCount: 1 });
        await waitForRenderer(100);
        const lockedStable = await mainWindow.webContents.executeJavaScript(
          `window.__refCanvasPerf?.getScene().items[1].x === 180 && window.__refCanvasPerf?.getScene().items[1].y === 20`,
        );
        await mainWindow.webContents.executeJavaScript(`(() => {
          const api = window.__refCanvasPerf; const scene = structuredClone(api.getScene());
          scene.items.forEach((item) => { item.locked = false; }); scene.viewport = { x: 220, y: 220, scale: 1 }; api.loadScene(scene);
        })()`);
        await waitForRenderer(100);
        await click(setup.empty);
        mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x: setup.empty.x, y: setup.empty.y, button: 'left', clickCount: 1 });
        mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: setup.boxEnd.x, y: setup.boxEnd.y, button: 'left' });
        mainWindow.webContents.sendInputEvent({ type: 'mouseUp', x: setup.boxEnd.x, y: setup.boxEnd.y, button: 'left', clickCount: 1 });
        await waitForRenderer(100);
        const selectionAfterBox = await mainWindow.webContents.executeJavaScript(
          `Number(document.querySelector('canvas.pixi-canvas')?.dataset.selectedImages || 0)`,
        );
        const boxSelected = selectionAfterBox === 2;
        const anchor = { x: 350, y: 280 };
        const viewportBefore = await mainWindow.webContents.executeJavaScript(`(() => {
          const canvas = document.querySelector('canvas.pixi-canvas');
          return { x: Number(canvas.dataset.viewportX), y: Number(canvas.dataset.viewportY), scale: Number(canvas.dataset.viewportScale) };
        })()`);
        for (let index = 0; index < 24; index += 1) {
          mainWindow.webContents.sendInputEvent({ type: 'mouseWheel', x: anchor.x, y: anchor.y, deltaX: 0, deltaY: -20 });
        }
        await waitForRenderer(180);
        const zoomResult = await mainWindow.webContents.executeJavaScript(`(async () => {
          const deadline = performance.now() + 2000;
          while (performance.now() < deadline) {
            const canvas = document.querySelector('canvas.pixi-canvas'); const scene = window.__refCanvasPerf?.getScene();
            const runtime = { x: Number(canvas.dataset.viewportX), y: Number(canvas.dataset.viewportY), scale: Number(canvas.dataset.viewportScale) };
            if (Math.abs(runtime.scale - scene.viewport.scale) < .0001) return { runtime, persisted: scene.viewport };
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          const canvas = document.querySelector('canvas.pixi-canvas'); const scene = window.__refCanvasPerf?.getScene();
          return { runtime: { x: Number(canvas.dataset.viewportX), y: Number(canvas.dataset.viewportY), scale: Number(canvas.dataset.viewportScale) }, persisted: scene.viewport };
        })()`);
        const worldBefore = { x: (anchor.x - viewportBefore.x) / viewportBefore.scale, y: (anchor.y - viewportBefore.y) / viewportBefore.scale };
        const worldAfter = { x: (anchor.x - zoomResult.runtime.x) / zoomResult.runtime.scale, y: (anchor.y - zoomResult.runtime.y) / zoomResult.runtime.scale };
        zoomDiagnostic = { viewportBefore, zoomResult, worldBefore, worldAfter };
        const anchorStable = Math.hypot(worldBefore.x - worldAfter.x, worldBefore.y - worldAfter.y) < 0.01
          && Math.abs(zoomResult.runtime.scale - zoomResult.persisted.scale) < 0.0001;
        const zoomLimits = await mainWindow.webContents.executeJavaScript(`(async () => {
          const canvas = document.querySelector('canvas.pixi-canvas');
          for (let index = 0; index < 100; index += 1) canvas.dispatchEvent(new WheelEvent('wheel', {
            bubbles: true, cancelable: true, clientX: 350, clientY: 280, deltaY: -1,
          }));
          await new Promise((resolve) => setTimeout(resolve, 180));
          const maximum = Number(canvas.dataset.viewportScale);
          for (let index = 0; index < 200; index += 1) canvas.dispatchEvent(new WheelEvent('wheel', {
            bubbles: true, cancelable: true, clientX: 350, clientY: 280, deltaY: 1,
          }));
          await new Promise((resolve) => setTimeout(resolve, 180));
          const minimum = Number(canvas.dataset.viewportScale);
          return { maximum, minimum, valid: maximum <= 32 && maximum >= 31.99 && minimum >= .02 && minimum <= .0201 };
        })()`);
        lifecycleResult = await mainWindow.webContents.executeJavaScript(`(async () => {
          const api = window.__refCanvasPerf; const populated = structuredClone(api.getScene());
          const empty = { ...structuredClone(populated), items: [], groups: [] };
          const heap = []; let allReleased = true; let singleCanvas = true;
          for (let cycle = 0; cycle < 10; cycle += 1) {
            api.loadScene(populated); await new Promise((resolve) => setTimeout(resolve, 60));
            api.loadScene(empty);
            const deadline = performance.now() + 1000;
            while (performance.now() < deadline) {
              const current = document.querySelector('canvas.pixi-canvas');
              if (Number(current?.dataset.totalImages || 0) === 0 && Number(current?.dataset.gpuTextures || 0) === 0) break;
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            const canvas = document.querySelector('canvas.pixi-canvas');
            allReleased &&= Number(canvas?.dataset.totalImages || 0) === 0 && Number(canvas?.dataset.gpuTextures || 0) === 0;
            singleCanvas &&= document.querySelectorAll('canvas.pixi-canvas').length === 1;
            heap.push(performance.memory?.usedJSHeapSize ?? 0);
          }
          api.loadScene(populated); await new Promise((resolve) => setTimeout(resolve, 100));
          return { allReleased, singleCanvas, heapStart: heap[0], heapEnd: heap.at(-1), cycles: 10 };
        })()`);
        zoomDiagnostic = { ...zoomDiagnostic, zoomLimits };
        interactionChecks = { multiSelected, moved, undoneOnce, redoneOnce, lockedStable, boxSelected, anchorStable, zoomLimits: zoomLimits.valid,
          selectionAfterFirst: selectionAfterFirst === 1, selectionAfterSecond: selectionAfterSecond === 2,
          selectionAfterBox: selectionAfterBox === 2 };
        interactionReady = Boolean(multiSelected && moved && undoneOnce && redoneOnce && lockedStable && boxSelected && anchorStable && zoomLimits.valid
          && lifecycleResult?.allReleased && lifecycleResult?.singleCanvas);
      }
      const contextRecoveryReady = await mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
        const canvas = document.querySelector('canvas.pixi-canvas');
        const gl = canvas?.getContext('webgl2') || canvas?.getContext('webgl');
        const extension = gl?.getExtension('WEBGL_lose_context');
        if (!extension) return resolve(true);
        extension.loseContext();
        setTimeout(() => extension.restoreContext(), 50);
        const deadline = performance.now() + 4000;
        const check = () => {
          if (Number(canvas?.dataset.gpuTextures || 0) >= 1 && !gl.isContextLost()) return resolve(true);
          if (performance.now() >= deadline) return resolve(false);
          setTimeout(check, 50);
        };
        setTimeout(check, 100);
      })`);
      const packagePath = path.join(app.getPath('temp'), `refcanvas-smoke-${process.pid}.refcanvas`);
      const packageScene = {
        format: 'refcanvas', version: 3, name: 'smoke', savedAt: new Date().toISOString(),
        viewport: { x: 0, y: 0, scale: 1 },
        canvas: { background: '#202124', padding: 20, snap: true, includeBackgroundOnExport: true },
        assets: { [smokeAsset.assetId]: smokeAsset.asset },
        items: [{
          id: 'smoke-item', name: 'smoke.png', assetId: smokeAsset.assetId, sourceType: 'clipboard',
          naturalWidth: 1, naturalHeight: 1, x: 0, y: 0, width: 1, height: 1, rotation: 0,
          flipX: false, flipY: false, opacity: 1, zIndex: 0, locked: false,
          crop: { x: 0, y: 0, width: 1, height: 1 },
        }], groups: [], visualNotes: { visible: true, nextNumber: 1, marks: [], localTags: [] },
      };
      await writeScenePackage(packagePath, packageScene);
      const reopened = await readScenePackage(packagePath);
      await fs.rm(packagePath, { force: true });
      const packageReady = reopened.version === 3 && Boolean(reopened.assets[smokeAsset.assetId]);
      let cacheMigrationReady = true;
      let cacheMigrationDiagnostic: Record<string, unknown> | undefined;
      if (process.env.REFCANVAS_CACHE_MIGRATION_SMOKE === '1') {
        const previousRoot = cacheRootDir();
        const targetParent = path.join(app.getPath('temp'), `refcanvas-cache-migration-${process.pid}-${Date.now()}`);
        const info = await setCacheLocation(targetParent);
        const migratedThumbnail = await generateThumbnail(smokeAsset.assetId, 128);
        const oldAssetExists = await fs.stat(path.join(previousRoot, 'asset-cache')).then(() => true).catch(() => false);
        cacheMigrationReady = path.resolve(info.root) === path.resolve(targetParent, 'RefCanvas')
          && migratedThumbnail.byteLength > 8 && !oldAssetExists;
        cacheMigrationDiagnostic = { previousRoot, targetParent, infoRoot: info.root,
          thumbnailBytes: migratedThumbnail.byteLength, oldAssetExists, cacheMigrationReady };
      }
      console.log(`RefCanvas acceptance smoke: ${JSON.stringify({ interactionReady, interactionChecks, lifecycleResult, zoomDiagnostic, cacheMigrationDiagnostic })}`);
      if (!ready || !registered || !imageReady || !interactionReady || !contextRecoveryReady || !packageReady || !cacheMigrationReady) process.exitCode = 1;
      dirtyRevisionState = createDirtyRevisionState();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
    app.exit(Number(process.exitCode) || 0);
  }, 350));
  const devServerUrl = process.env.REFCANVAS_DEV_SERVER_URL;
  const devMode = !app.isPackaged && Boolean(devServerUrl);
  const rendererQuery: Record<string, string> = {};
  if (pixiCanvasSmoke || devSmokeTest || (smokeTest && !stressTest)) rendererQuery.smoke = '1';
  if (smokeTest && !stressTest && !performanceBenchmark && !projectZoomBenchmark && !realImageTest) rendererQuery['perf-bench'] = 'acceptance';
  if (stressTest) rendererQuery.stress = '2000';
  if (performanceBenchmark) { rendererQuery.perf = '1'; rendererQuery['perf-bench'] = process.env.REFCANVAS_PERF_PHASE || 'before'; }
  if (projectZoomBenchmark) { rendererQuery.perf = '1'; rendererQuery['perf-bench'] = 'project'; rendererQuery['project-bench'] = '1'; }
  if (runtimeFlags.manualInputRecording) rendererQuery['manual-input-record'] = '1';
  if (devMode) {
    const target = new URL(devServerUrl);
    Object.entries(rendererQuery).forEach(([key, value]) => target.searchParams.set(key, value));
    mainWindow.loadURL(target.toString());
  } else mainWindow.loadFile(path.join(rootDir, 'dist', 'index.html'), Object.keys(rendererQuery).length ? { query: rendererQuery } : undefined);
  mainWindow.on('close', (event) => {
    if (!dirtyRevisionState.dirty || smokeTest) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['取消', '仍然关闭'],
      defaultId: 0,
      cancelId: 0,
      title: '尚未保存',
      message: '当前画板有尚未保存的更改。',
      detail: '关闭后，未手动保存的更改将会丢失。确定要关闭吗？',
    });
    if (choice === 0) event.preventDefault();
  });
  mainWindow.on('closed', () => { mainWindow = undefined; });
  mainWindow.on('blur', finishWindowMove);
  mainWindow.on('show', scheduleNativeWindowLayerRepair);
  mainWindow.on('restore', scheduleNativeWindowLayerRepair);
  mainWindow.on('always-on-top-changed', scheduleNativeWindowLayerRepair);
}

app.setName('Yoiniwa');
app.setAppUserModelId('com.yoiniwa.app');
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();
else app.whenReady().then(async () => {
  await initializeLogger(path.join(app.getPath('userData'), 'logs'), {
    version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome,
    node: process.versions.node, platform: process.platform, arch: process.arch, packaged: app.isPackaged,
  });
  await loadCacheLocation();
  await initializeSessionCache();
  protocol.handle('refcanvas-asset', assetResponse);
  startNativeWindowMoveHelper();
  photoshopColorBridge.start();
  createWindow();
  screen.on('display-added', scheduleNativeWindowLayerRepair);
  screen.on('display-removed', scheduleNativeWindowLayerRepair);
  screen.on('display-metrics-changed', scheduleNativeWindowLayerRepair);
  const recentIndexTimer = setTimeout(() => {
    void hydrateLegacyRecentAssetIndexes().catch((error) => logWarn('recent-assets.hydrate-failed', { error: String(error) }));
  }, 1500);
  recentIndexTimer.unref?.();
  globalShortcut.register('Control+Alt+Shift+T', disableClickThrough);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch((error) => {
  logError('app.startup-failed', error);
  console.error('Yoiniwa startup failed:', error);
  app.exit(1);
});

app.on('second-instance', (_event, argv) => {
  const filePath = argv.find((value) => /\.refcanvas$/i.test(value));
  if (filePath && mainWindow) mainWindow.webContents.send('scene:external-open', filePath);
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.focus();
});

app.on('will-quit', () => {
  logInfo('app.will-quit');
  void flushLogs();
  globalShortcut.unregisterAll();
  nativeWindowMoveHelper?.kill();
  photoshopColorBridge.stop();
  if (sessionCachePath) void fs.rm(sessionCachePath, { recursive: true, force: true });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  imageWorkerGeneration.advance();
  imageJobs.cancel(() => true);
  imageWorkerAssets.clear();
  prewarmRequests.forEach((request) => { request.canceled = true; });
  imageWorker?.kill();
  imageWorker = undefined;
});
app.on('child-process-gone', (_event, details) => logError('app.child-process-gone', new Error(details.reason), details));

const handleIpc = createIpcHandlerRegistrar(ipcMain);

handleIpc('images:import', async (event, requestId) => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'], filters: imageFilters });
  if (result.canceled) return [];
  const sizes = await Promise.all(result.filePaths.map(async (filePath) => (await fs.stat(filePath)).size));
  const totalBytes = Math.max(1, sizes.reduce((total, size) => total + size, 0));
  const hashedBytes = new Array(result.filePaths.length).fill(0);
  const metadataDone = new Array(result.filePaths.length).fill(0);
  const reportRegistration = (index, stage, delta) => {
    if (!requestId) return;
    if (stage === 'hash') hashedBytes[index] += delta;
    else metadataDone[index] = delta;
    const hashFraction = hashedBytes.reduce((total, value) => total + value, 0) / totalBytes;
    const metadataFraction = metadataDone.reduce((total, value) => total + value, 0) / result.filePaths.length;
    event.sender.send('images:prewarm-progress', {
      requestId, completed: metadataDone.filter(Boolean).length, total: result.filePaths.length,
      stage, stageCompleted: Math.round((stage === 'hash' ? hashFraction : metadataFraction) * 1000), stageTotal: 1000,
      fraction: Math.min(
        IMAGE_IMPORT_STAGE_WEIGHTS.hash + IMAGE_IMPORT_STAGE_WEIGHTS.metadata,
        hashFraction * IMAGE_IMPORT_STAGE_WEIGHTS.hash + metadataFraction * IMAGE_IMPORT_STAGE_WEIGHTS.metadata,
      ),
    });
  };
  const imported = (await mapWithConcurrency(result.filePaths, async (filePath, index) => {
    try {
      return await registerAssetPath(filePath, 'file', (stage, delta) => reportRegistration(index, stage, delta));
    } catch { return undefined; }
  }, 2)).filter(Boolean);
  await trimAssetCache();
  return imported;
});

handleIpc('images:register-paths', async (_event, paths, sourceType = 'drop') => {
  if (!Array.isArray(paths) || paths.length > 2000) throw new Error('一次拖入的图片数量无效');
  const imported = (await mapWithConcurrency(paths, async (filePath) => {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !mimeByExt[path.extname(filePath).toLowerCase()]) throw new Error('拖入的文件不是支持的图片');
    try {
      return await registerAssetPath(filePath, sourceType);
    } catch { return undefined; }
  }, 2)).filter(Boolean);
  await trimAssetCache();
  return imported;
});

handleIpc('images:register-urls', async (_event, urls) => {
  if (!Array.isArray(urls) || urls.length > 100) throw new Error('一次拖入的网络图片数量无效');
  return (await mapWithConcurrency(urls, async (rawUrl) => {
    try {
      const url = new URL(rawUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只支持 HTTP 或 HTTPS 图片地址');
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`);
      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength > 200 * 1024 * 1024) throw new Error('网络图片超过 200MB');
      const mimeType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 200 * 1024 * 1024 || (!mimeType.startsWith('image/') && !mimeFromName(url.pathname).startsWith('image/'))) throw new Error('拖入的地址不是支持的图片');
      let name = path.basename(decodeURIComponent(url.pathname)) || `网络图片-${Date.now()}`;
      if (!mimeFromName(name).startsWith('image/')) name += extByMime[mimeType] ?? '.png';
      return await registerAssetBuffer(name, bytes, rawUrl, 'drop');
    } catch { return undefined; }
  })).filter(Boolean);
});

handleIpc('images:register-clipboard', async () => {
  const image = clipboard.readImage();
  if (image.isEmpty()) return [];
  const buffer = image.toPNG();
  if (!buffer.length || buffer.length > 200 * 1024 * 1024) throw new Error('剪贴板图片大小无效');
  return [await registerAssetBuffer(`clipboard-${Date.now()}.png`, buffer, undefined, 'clipboard')] as ImportedImage[];
});

handleIpc('images:prewarm', async (event, ids, requestId) => {
  if (typeof requestId !== 'string' || !requestId) throw new Error('预热请求无效');
  return prewarmImages(ids, event.sender, requestId);
});
handleIpc('images:performance-stats', () => ({ ...imagePerformanceStats }));
handleIpc('images:sample-pixel', async (_event, assetId, x, y) => {
  const registered = assetRegistry.get(assetId);
  if (!registered) throw new Error('取色资源不存在');
  if (![x, y].every(Number.isInteger) || x < 0 || y < 0
    || x >= registered.record.naturalWidth || y >= registered.record.naturalHeight) {
    throw new Error('取色坐标无效');
  }
  const prefix = `sample:${assetId}:`;
  const key = `${prefix}${x}:${y}`;
  imageJobs.cancel((jobKey) => jobKey.startsWith(prefix) && jobKey !== key);
  return imageJobs.enqueue<{ r: number; g: number; b: number; a: number }>(key, async (signal) => {
    await ensureAssetFile(assetId);
    return await runRegisteredImageWorker(registered.record.hash, undefined, {
      type: 'samplePixel', x, y,
    }, 15_000, registered.cachePath, signal) as { r: number; g: number; b: number; a: number };
  }, 30);
});
handleIpc('logs:write', (_event, entries) => { appendRendererLogs(entries); });
handleIpc('logs:open-folder', async () => {
  const directory = getLogDirectory();
  if (!directory) throw new Error('日志目录尚未初始化');
  await fs.mkdir(directory, { recursive: true });
  const error = await shell.openPath(directory);
  if (error) throw new Error(error);
  logInfo('logs.folder-opened');
  return { path: directory };
});
handleIpc('logs:copy-diagnostics', async () => {
  const gpu = await app.getGPUInfo('basic').catch((error) => ({ error: String(error) }));
  const diagnostics = {
    generatedAt: new Date().toISOString(), sessionId: logSessionId, logPath: getLogPath(),
    app: { version: app.getVersion(), packaged: app.isPackaged },
    runtime: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    system: { platform: process.platform, arch: process.arch, memoryBytes: process.getSystemMemoryInfo?.().total ? process.getSystemMemoryInfo().total * 1024 : undefined },
    gpu, gpuFeatureStatus: app.getGPUFeatureStatus(), imagePipeline: { ...imagePerformanceStats }, imageJobs: imageJobs.stats(),
    cache: await cacheLocationInfo().catch((error) => ({ error: String(error) })),
  };
  clipboard.writeText(JSON.stringify(diagnostics, null, 2));
  logInfo('logs.diagnostics-copied', { gpuFeatureStatus: diagnostics.gpuFeatureStatus, imageJobs: diagnostics.imageJobs });
  return { sessionId: logSessionId, path: getLogPath() };
});
handleIpc('performance:record-manual-wheel', async (_event, payload) => {
  const serialized = JSON.stringify(payload);
  if (serialized.length > 1024 * 1024) throw new Error('滚轮性能记录过大');
  const directory = path.join(rootDir, 'performance-results');
  await fs.mkdir(directory, { recursive: true });
  const stampedPath = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}-manual-wheel.json`);
  const latestPath = path.join(directory, 'manual-wheel-latest.json');
  await fs.writeFile(stampedPath, serialized, 'utf8');
  await fs.writeFile(latestPath, serialized, 'utf8');
  logInfo('performance.manual-wheel', payload);
  return { path: stampedPath };
});
ipcMain.on('images:cancel-prewarm', (_event, requestId) => {
  const request = prewarmRequests.get(requestId);
  if (!request) return;
  request.canceled = true;
  imageJobs.cancel((key) => [...request.hashes].some((hash) => key.includes(hash)));
});
ipcMain.on('images:boost-resource', (_event, resourceKey, requestedPriority) => {
  try {
    const url = new URL(String(resourceKey));
    if (url.protocol !== 'refcanvas-asset:') return;
    const id = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const registered = assetRegistry.get(id);
    if (!registered) return;
    const priority = Math.max(0, Math.min(10, Number(requestedPriority) || 0));
    const variant = url.searchParams.get('variant');
    if (variant === 'tile') {
      const level = Number(url.searchParams.get('level'));
      const column = Number(url.searchParams.get('column'));
      const row = Number(url.searchParams.get('row'));
      const tileKey = `tile:${registered.record.hash}:tile:${level}:${column}:${row}:512:1`;
      imageJobs.boost((key) => key === tileKey || key === `pyramid:${registered.record.hash}:pyramid:${level}`, priority);
      return;
    }
    const size = variant === 'thumb128' ? 128 : variant === 'thumb256' ? 256
      : variant === 'thumb512' ? 512 : variant === 'thumb768' ? 768 : variant === 'thumb1024' ? 1024 : undefined;
    if (size) imageJobs.boost((key) => key === `thumbnail:${registered.record.hash}:${size}`, priority);
  } catch { /* Ignore malformed renderer hints. */ }
});

handleIpc('scene:save', async (_event, scene, saveAs = false, revision) => {
  const targetPath = !saveAs ? currentScenePath : undefined;
  if (targetPath) return enqueueSceneSave(targetPath, scene, revision);
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `${scene.name || '未命名画板'}.refcanvas`,
    filters: sceneFilters,
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const filePath = result.filePath.endsWith('.refcanvas') ? result.filePath : `${result.filePath}.refcanvas`;
  return enqueueSceneSave(filePath, scene, revision);
});

handleIpc('scene:autosave', async (_event, scene, revision) => {
  if (!currentScenePath) return { skipped: true };
  return enqueueSceneSave(currentScenePath, scene, revision);
});

handleIpc('scene:open', async (_event, requestedPath) => {
  let filePath = requestedPath;
  if (!filePath) {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: sceneFilters });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    [filePath] = result.filePaths;
  }
  return enqueuePersistence(async () => {
    const startedAt = performance.now();
    try {
      const scene = await readScenePackage(filePath);
      await retainAssetRegistry(Object.keys(scene.assets ?? {}));
      currentScenePath = filePath;
      dirtyRevisionState = createDirtyRevisionState();
      await addRecent(filePath, Object.keys(scene.assets ?? {}));
      logInfo('scene.opened', {
        name: path.basename(filePath), items: scene.items?.length ?? 0, assets: Object.keys(scene.assets ?? {}).length,
        durationMs: performance.now() - startedAt,
      });
      return { canceled: false, path: filePath, scene };
    } catch (error) {
      logError('scene.open-failed', error, { name: path.basename(filePath), durationMs: performance.now() - startedAt });
      throw error;
    }
  });
});

handleIpc('scene:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: sceneFilters });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const [filePath] = result.filePaths;
  const scene = await readScenePackage(filePath, { registerAssets: true });
  return { canceled: false, path: filePath, scene };
});

handleIpc('scene:recent', async () => cleanTestSession ? [] : (await readState()).recent ?? []);
handleIpc('cache:info', () => cacheLocationInfo());
handleIpc('cache:choose-location', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择缓存位置', properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  return { canceled: false, info: await setCacheLocation(result.filePaths[0]) };
});
handleIpc('cache:reset-location', async () => setCacheLocation());
ipcMain.on('scene:reset-path', () => {
  dirtyRevisionState = createDirtyRevisionState();
  void enqueuePersistence(async () => {
    currentScenePath = undefined;
    await retainAssetRegistry([]);
  }).catch(() => undefined);
});
handleIpc('scene:startup-path', async () => {
  let result = startupScenePath ?? null;
  startupScenePath = undefined;
  if (!result) {
    const desktopScenePath = path.join(app.getPath('desktop'), TEMPORARY_DESKTOP_SCENE_NAME);
    try {
      await fs.access(desktopScenePath);
      result = desktopScenePath;
    } catch {
      // The fixture is optional; absence must not block normal startup.
    }
  }
  return result;
});
handleIpc('image:export', async (_event, data, suggestedName) => {
  const wantsJpeg = /\.jpe?g$/i.test(suggestedName);
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: suggestedName,
    filters: [wantsJpeg ? { name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] } : { name: 'PNG 图片', extensions: ['png'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const image = nativeImage.createFromBuffer(Buffer.from(data));
  await fs.writeFile(result.filePath, wantsJpeg ? image.toJPEG(92) : image.toPNG());
  return { canceled: false, path: result.filePath };
});
handleIpc('image:copy', async (_event, data) => clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(data))));
handleIpc('image:show-source', async (_event, requestedPath) => {
  if (typeof requestedPath !== 'string' || !path.isAbsolute(requestedPath)) return { ok: false, message: '这张图片没有可用的本地源文件' };
  try { await fs.access(requestedPath); shell.showItemInFolder(requestedPath); return { ok: true }; }
  catch { return { ok: false, message: '源文件已经移动或不存在' }; }
});
handleIpc('photoshop:set-foreground', async (_event, rawColor, requestedReturnFocus) => {
  const color = normalizedColor(rawColor);
  if (!color) return {
    ok: false, status: 'automation-error', syncStatus: 'automation-error', focusStatus: 'skipped',
    copied: false, syncLatencyMs: 0, message: '颜色数据无效',
  };
  const requestedRoundTrip = shouldAutoPhotoshopRoundTrip(windowState, Boolean(requestedReturnFocus));
  const focuslessPicker = process.platform === 'win32' && shouldUseFocuslessPhotoshopPicker(windowState);
  const returnFocus = requestedRoundTrip && !focuslessPicker;
  return new Promise<PhotoshopColorSyncResult>((resolve) => {
    setImmediate(() => { void photoshopSyncQueue.enqueue({ color, returnFocus }).then(resolve); });
  });
});

handleIpc('window:set-mode', async (_event, patch) => {
  const previousState = windowState;
  const wasFocusless = process.platform === 'win32' && shouldUseFocuslessPhotoshopPicker(windowState);
  const wasCollaborationMode = windowState.collaborationMode;
  windowState = { ...windowState, ...patch };
  const focuslessPicker = process.platform === 'win32' && shouldUseFocuslessPhotoshopPicker(windowState);
  const enteringCollaborationMode = !wasCollaborationMode && windowState.collaborationMode;
  const leavingFocuslessPicker = wasFocusless && !focuslessPicker;
  const needsNativeLayerTransition = focuslessPicker !== wasFocusless || enteringCollaborationMode;
  if (previousState.alwaysOnTop !== windowState.alwaysOnTop) mainWindow.setAlwaysOnTop(windowState.alwaysOnTop);
  mainWindow.setOpacity(Math.max(0.25, Math.min(1, windowState.opacity)));
  mainWindow.setMovable(!windowState.locked);
  mainWindow.setIgnoreMouseEvents(windowState.clickThrough, { forward: true });
  // Keep Electron focusable so it remains visible in the Windows taskbar and
  // its buttons always receive pointer events. The native helper adds only
  // WS_EX_NOACTIVATE during reference picking, which prevents mouse/pen input
  // from stealing Photoshop's foreground ownership.
  mainWindow.setFocusable(true);
  mainWindow.setSkipTaskbar(false);
  if (needsNativeLayerTransition) {
    const layerReady = await transitionNativeWindowLayer(focuslessPicker);
    if (focuslessPicker && !layerReady) {
      logWarn('window.collaboration-layer-unavailable');
      windowState = previousState;
      mainWindow.setAlwaysOnTop(previousState.alwaysOnTop);
      mainWindow.setOpacity(Math.max(0.25, Math.min(1, previousState.opacity)));
      mainWindow.setMovable(!previousState.locked);
      mainWindow.setIgnoreMouseEvents(previousState.clickThrough, { forward: true });
      void transitionNativeWindowLayer(wasFocusless);
      return windowState;
    }
  }
  if (focuslessPicker && (enteringCollaborationMode || !wasFocusless)) {
    void photoshopColorBridge.warm().then(() => photoshopColorBridge.captureFocus(300))
      .then(() => photoshopColorBridge.activate()).catch(() => undefined);
  }
  if (leavingFocuslessPicker && !mainWindow.isDestroyed()) {
    setImmediate(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !shouldUseFocuslessPhotoshopPicker(windowState)) mainWindow.focus();
    });
  }
  return windowState;
});
handleIpc('window:get-mode', () => windowState);
handleIpc('window:is-key-down', (_event, key) => key === 'Space' ? queryNativeKeyDown(0x20) : false);
handleIpc('window:set-title', (_event, title) => {
  if (!mainWindow || mainWindow.isDestroyed() || typeof title !== 'string') return;
  const normalized = title.trim().slice(0, 260);
  if (normalized) mainWindow.setTitle(normalized);
});
ipcMain.on('window:minimize', () => mainWindow.minimize());
ipcMain.on('window:maximize', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('window:move-start', () => {
  finishWindowMove();
  if (!mainWindow || windowState.locked || mainWindow.isMaximized()) return;
  const cursor = screen.getCursorScreenPoint();
  const bounds = mainWindow.getBounds();
  windowMoveSession = { cursorX: cursor.x, cursorY: cursor.y, ...bounds, lastX: bounds.x, lastY: bounds.y, active: false };
});
ipcMain.on('window:move-update', () => {
  if (!mainWindow || !windowMoveSession || windowState.locked || mainWindow.isMaximized()) return;
  if (beginNativeWindowMove()) {
    finishWindowMove();
    return;
  }
  windowMoveSession.active = true;
  updateWindowMove();
  scheduleWindowMoveFrame();
});
ipcMain.on('window:move-end', finishWindowMove);
ipcMain.on('window:close', () => mainWindow.close());
ipcMain.on('window:dirty', (_event, value) => {
  if (typeof value === 'boolean') {
    dirtyRevisionState = updateDirtyRevision(dirtyRevisionState, value);
    return;
  }
  dirtyRevisionState = updateDirtyRevision(dirtyRevisionState, Boolean(value?.dirty), value?.revision);
});
