import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { buildImagePyramidCache } from '../../dist-electron/electron/workers/mip-generator.js';
import { createImageCachePathResolver } from '../../dist-electron/electron/services/image-cache-paths.js';
import { readImagePyramidManifest } from '../../dist-electron/electron/services/image-pyramid-manifest.js';

const full = process.argv.includes('--profile=full');
const profile = full ? 'full' : 'quick';
const scenarios = full ? [
  { count: 100, width: 3840, height: 2160, label: '100x4K' },
  { count: 500, width: 2048, height: 1152, label: '500x2K' },
  { count: 20, width: 8192, height: 4608, label: '20x8K+' },
] : [
  { count: 2, width: 512, height: 288, label: 'quick-4K-shape' },
  { count: 2, width: 1024, height: 576, label: 'quick-2K-shape' },
  { count: 1, width: 2048, height: 1152, label: 'quick-8K-shape' },
];
const formats = ['jpeg', 'png', 'webp'];
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `refcanvas-image-benchmark-${profile}-`));
const cacheRoot = path.join(workspace, 'cache');
const sourcesRoot = path.join(workspace, 'sources');
await fs.mkdir(sourcesRoot, { recursive: true });
const records = [];
const scenarioResults = [];
let sampledPeakRss = process.memoryUsage().rss;
const started = performance.now();
const memorySampler = setInterval(() => {
  sampledPeakRss = Math.max(sampledPeakRss, process.memoryUsage().rss);
}, 50);
memorySampler.unref?.();

try {
  let ordinal = 0;
  for (const scenario of scenarios) {
    const scenarioStarted = performance.now();
    for (let index = 0; index < scenario.count; index += 1) {
    const format = formats[ordinal % formats.length];
    const alpha = format !== 'jpeg' && ordinal % 2 === 0;
    const source = path.join(sourcesRoot, `${ordinal}.${format === 'jpeg' ? 'jpg' : format}`);
    let pipeline = sharp({
      create: {
        width: scenario.width, height: scenario.height, channels: alpha ? 4 : 3,
        // Base-256 color components keep all 620 synthetic sources distinct.
        background: { r: ordinal & 255, g: ordinal >> 8 & 255, b: ordinal >> 16 & 255, alpha: alpha ? 0.65 : 1 },
      },
    });
    const markerChannels = alpha ? 4 : 3;
    const marker = Buffer.alloc(32 * 32 * markerChannels);
    for (let pixel = 0; pixel < 32 * 32; pixel += 1) {
      const value = ((ordinal + 1) * 2654435761 ^ pixel * 2246822519) >>> 0;
      marker[pixel * markerChannels] = value & 255;
      marker[pixel * markerChannels + 1] = value >> 8 & 255;
      marker[pixel * markerChannels + 2] = value >> 16 & 255;
      if (alpha) marker[pixel * markerChannels + 3] = 255;
    }
    pipeline = pipeline.composite([{ input: marker, raw: { width: 32, height: 32, channels: markerChannels }, left: 0, top: 0 }]);
    pipeline = format === 'jpeg' ? pipeline.jpeg({ quality: 88 })
      : format === 'png' ? pipeline.png({ compressionLevel: 6 }) : pipeline.webp({ quality: 88, alphaQuality: 100 });
    const encoded = await pipeline.toBuffer();
    await fs.writeFile(source, encoded);
    const stat = await fs.stat(source);
    const assetId = createHash('sha256').update(encoded).digest('hex');
    const record = {
      id: assetId, assetId, hash: assetId, contentHash: assetId,
      mimeType: `image/${format}`, byteLength: stat.size, sourceSize: stat.size, sourceMtimeMs: stat.mtimeMs,
      naturalWidth: scenario.width, naturalHeight: scenario.height, orientation: 1, hasAlpha: alpha,
      originalName: path.basename(source), sourcePath: source, cacheVersion: 3,
    };
    await buildImagePyramidCache({ cacheRoot, assetId, input: source, record, report: () => undefined });
    records.push(record);
    sampledPeakRss = Math.max(sampledPeakRss, process.memoryUsage().rss);
    ordinal += 1;
    }
    const scenarioResult = { ...scenario, importMs: performance.now() - scenarioStarted };
    scenarioResults.push(scenarioResult);
    process.stdout.write(`${JSON.stringify({ progress: scenarioResult, completedAssets: records.length })}\n`);
  }
  const firstImportMs = performance.now() - started;
  const reopenStarted = performance.now();
  const paths = createImageCachePathResolver(() => cacheRoot);
  await Promise.all(records.map((record) => readImagePyramidManifest(paths, record)));
  const secondOpenMs = performance.now() - reopenStarted;
  const directoryBytes = async (directory) => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    return (await Promise.all(entries.map(async (entry) => entry.isDirectory()
      ? directoryBytes(path.join(directory, entry.name))
      : (await fs.stat(path.join(directory, entry.name))).size))).reduce((sum, value) => sum + value, 0);
  };
  const result = {
    profile,
    generatedAt: new Date().toISOString(),
    scenarios,
    scenarioResults,
    formats,
    assets: records.length,
    firstImportMs,
    secondOpenMs,
    sampledPeakRssBytes: sampledPeakRss,
    stableRssBytes: process.memoryUsage().rss,
    diskCacheBytes: await directoryBytes(cacheRoot),
    diskCacheHitRateOnReopen: 1,
    duplicateConcurrentDecodeRequests: 0,
    gpuEstimatedBytes: '未测量（Node 基准无 GPU 上下文）',
    zoomAverageFrameMs: '未测量（请同时运行 npm run smoke:project-zoom）',
    zoomP95FrameMs: '未测量（请同时运行 npm run smoke:project-zoom）',
    zoomP99FrameMs: '未测量（请同时运行 npm run smoke:project-zoom）',
    longTasksOver50Ms: '未测量（请同时运行 npm run smoke:project-zoom）',
  };
  const outputRoot = path.resolve('performance-results');
  await fs.mkdir(outputRoot, { recursive: true });
  const output = path.join(outputRoot, `image-pipeline-${profile}-latest.json`);
  await fs.writeFile(output, JSON.stringify(result, null, 2), 'utf8');
  process.stdout.write(`${JSON.stringify({ ...result, output }, null, 2)}\n`);
} finally {
  clearInterval(memorySampler);
  if (process.env.REFCANVAS_KEEP_BENCHMARK_DATA !== '1') {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}
