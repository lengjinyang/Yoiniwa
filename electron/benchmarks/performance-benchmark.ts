import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { percentile } from '../../src/shared/statistics.js';

async function readProtocolStream(debuggerClient, handle) {
  const chunks = [];
  while (true) {
    const result = await debuggerClient.sendCommand('IO.read', { handle });
    chunks.push(result.base64Encoded ? Buffer.from(result.data, 'base64') : Buffer.from(result.data));
    if (result.eof) break;
  }
  await debuggerClient.sendCommand('IO.close', { handle }).catch(() => undefined);
  return Buffer.concat(chunks);
}

async function traceOperation(webContents, outputPath, action) {
  const debuggerClient = webContents.debugger;
  const completed = new Promise((resolve, reject) => {
    const handler = (_event, method, params) => {
      if (method !== 'Tracing.tracingComplete') return;
      debuggerClient.removeListener('message', handler);
      if (!params?.stream) reject(new Error('Chrome trace did not return a stream'));
      else resolve(params.stream);
    };
    debuggerClient.on('message', handler);
  });
  await debuggerClient.sendCommand('Tracing.start', {
    transferMode: 'ReturnAsStream',
    traceConfig: {
      recordMode: 'recordContinuously',
      includedCategories: [
        'blink.user_timing', 'devtools.timeline', 'disabled-by-default-devtools.timeline',
        'disabled-by-default-devtools.timeline.frame', 'disabled-by-default-v8.cpu_profiler',
        'gpu', 'renderer.scheduler', 'toplevel', 'v8',
      ],
    },
  });
  const startedAt = performance.now();
  let result;
  try { result = await action(); }
  finally { await debuggerClient.sendCommand('Tracing.end'); }
  const stream = await completed;
  await fs.writeFile(outputPath, await readProtocolStream(debuggerClient, stream));
  const traceDurationMs = performance.now() - startedAt;
  return result && typeof result === 'object' ? { ...result, traceDurationMs } : { result, traceDurationMs };
}

async function takeHeapSnapshot(webContents, outputPath) {
  const debuggerClient = webContents.debugger;
  const chunks = [];
  const handler = (_event, method, params) => {
    if (method === 'HeapProfiler.addHeapSnapshotChunk' && typeof params?.chunk === 'string') chunks.push(params.chunk);
  };
  debuggerClient.on('message', handler);
  try {
    await debuggerClient.sendCommand('HeapProfiler.enable');
    await debuggerClient.sendCommand('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: true });
  } finally {
    debuggerClient.removeListener('message', handler);
  }
  await fs.writeFile(outputPath, chunks.join(''), 'utf8');
}

async function generate4kImages(directory, count, runId) {
  await fs.mkdir(directory, { recursive: true });
  const files = new Array(count);
  let cursor = 0;
  const worker = async () => {
    while (cursor < count) {
      const index = cursor++;
      const hue = index * 47 % 360;
      const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="3840" height="2160">
        <defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="hsl(${hue} 68% 43%)"/><stop offset="1" stop-color="hsl(${(hue + 110) % 360} 72% 24%)"/></linearGradient>
        <pattern id="p" width="96" height="96" patternUnits="userSpaceOnUse"><path d="M0 0L96 96M96 0L0 96" stroke="white" stroke-opacity=".22" stroke-width="3"/></pattern></defs>
        <rect width="3840" height="2160" fill="url(#g)"/><rect width="3840" height="2160" fill="url(#p)"/>
        <circle cx="${300 + index * 31 % 3200}" cy="${260 + index * 53 % 1600}" r="${140 + index % 9 * 34}" fill="none" stroke="white" stroke-width="18"/>
        <text x="120" y="2040" fill="white" font-family="sans-serif" font-size="96">RefCanvas ${runId} / ${index + 1}</text>
      </svg>`);
      const target = path.join(directory, `generated-4k-${String(index).padStart(3, '0')}.jpg`);
      await sharp(svg, { density: 72 }).jpeg({ quality: 86, chromaSubsampling: '4:2:0' }).toFile(target);
      files[index] = target;
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return files;
}

const rendererHelpers = `
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (predicate, timeout = 120000) => {
    const deadline = performance.now() + timeout;
    while (!predicate()) {
      if (performance.now() >= deadline) throw new Error('renderer benchmark wait timed out');
      await wait(50);
    }
  };
  const host = () => document.querySelector('canvas.pixi-canvas');
  const stageCanvas = () => host();
  const snapshot = () => ({
    ...(window.__refCanvasPerformanceSnapshot?.() || {}),
    backend: host()?.getAttribute('data-render-backend'),
    renderedImages: Number(host()?.getAttribute('data-rendered-images') || 0),
    totalImages: Number(host()?.getAttribute('data-total-images') || 0),
    selectedImages: Number(host()?.getAttribute('data-selected-images') || 0),
    renderCommands: Number(host()?.getAttribute('data-render-commands') || 0),
    loadedCommands: Number(host()?.getAttribute('data-loaded-commands') || 0),
    drawCalls: Number(host()?.getAttribute('data-draw-calls') || 0),
    bindTextureCalls: Number(host()?.getAttribute('data-bind-texture-calls') || 0),
    bufferDataCalls: Number(host()?.getAttribute('data-buffer-data-calls') || 0),
    bufferSubDataCalls: Number(host()?.getAttribute('data-buffer-sub-data-calls') || 0),
    texImage2DCalls: Number(host()?.getAttribute('data-tex-image-2d-calls') || 0),
    texSubImage2DCalls: Number(host()?.getAttribute('data-tex-sub-image-2d-calls') || 0),
    textureUploadMs: Number(host()?.getAttribute('data-texture-upload-ms') || 0),
    gpuBytes: Number(host()?.getAttribute('data-gpu-bytes') || 0),
    cpuImageBytes: Number(host()?.getAttribute('data-cpu-image-bytes') || 0),
    frameP95Ms: Number(host()?.getAttribute('data-frame-p95-ms') || 0),
    longTasks: Number(host()?.getAttribute('data-long-tasks') || 0),
  });
  const runFrames = (durationMs, dispatch) => new Promise((resolve) => {
    const intervals = []; const longTasks = []; let previous; let started;
    const observer = typeof PerformanceObserver === 'undefined' ? undefined : new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => longTasks.push(entry.duration));
    });
    try { observer?.observe({ entryTypes: ['longtask'] }); } catch {}
    const step = (timestamp) => {
      if (started === undefined) started = timestamp;
      if (previous !== undefined) intervals.push(timestamp - previous);
      previous = timestamp;
      dispatch(timestamp - started, intervals.length);
      if (timestamp - started < durationMs) requestAnimationFrame(step);
      else {
        observer?.disconnect();
        const sorted = [...intervals].sort((a, b) => a - b);
        const p = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] || 0;
        resolve({ durationMs: timestamp - started, frames: intervals.length, frameP95Ms: p(.95), frameP99Ms: p(.99), onePercentLow: 1000 / Math.max(.001, p(.99)), longTasks });
      }
    };
    requestAnimationFrame(step);
  });
`;

async function execute(webContents, body, _timeout = 150000) {
  return webContents.executeJavaScript(`new Promise((resolve, reject) => { void (async () => { try { ${rendererHelpers}\n${body} } catch (error) { reject(String(error?.stack || error)); } })(); })`, true);
}

export async function runPerformanceBenchmark({ mainWindow, rootDir, app, writeScenePackage, readScenePackage, phase = 'before' }) {
  const interactionDurationMs = Math.max(1_000, Number(process.env.REFCANVAS_PERF_INTERACTION_MS || 10_000));
  const runId = `${Date.now()}-${process.pid}`;
  const outputDirectory = path.join(rootDir, 'performance-results', `${new Date().toISOString().replace(/[:.]/g, '-')}-${phase}`);
  const sourceDirectory = path.join(app.getPath('temp'), `refcanvas-perf-${runId}`);
  await fs.mkdir(outputDirectory, { recursive: true });
  const generatedFiles = await generate4kImages(sourceDirectory, 100, runId);
  const debuggerClient = mainWindow.webContents.debugger;
  debuggerClient.attach('1.3');
  const results: Record<string, any> = { phase, runId, outputDirectory, generated: { count: generatedFiles.length, width: 3840, height: 2160 } };
  try {
    results.import100x4k = await traceOperation(mainWindow.webContents, path.join(outputDirectory, '01-import-100x4k.trace.json'), () => execute(mainWindow.webContents, `
      window.dispatchEvent(new CustomEvent('refcanvas-smoke-add-paths', { detail: ${JSON.stringify(generatedFiles)} }));
      await waitFor(() => Number(host()?.getAttribute('data-total-images') || 0) === 100, 600000);
      await waitFor(() => !document.querySelector('.import-progress'), 600000);
      await wait(1000);
      resolve(snapshot());
    `, 310000));
    await takeHeapSnapshot(mainWindow.webContents, path.join(outputDirectory, 'memory-after-import.heapsnapshot'));

    await execute(mainWindow.webContents, `
      window.__refCanvasPerf.expandScene(500);
      await waitFor(() => Number(host()?.getAttribute('data-total-images') || 0) === 500, 30000);
      await waitFor(() => {
        const commands = Number(host()?.getAttribute('data-render-commands') || 0);
        return commands > 0 && Number(host()?.getAttribute('data-loaded-commands') || 0) >= commands;
      }, 60000);
      let stableUploads = Number(host()?.getAttribute('data-tex-sub-image-2d-calls') || 0);
      for (let stable = 0; stable < 3;) {
        await wait(250);
        const uploads = Number(host()?.getAttribute('data-tex-sub-image-2d-calls') || 0);
        if (uploads === stableUploads) stable += 1; else { stable = 0; stableUploads = uploads; }
      }
      resolve(snapshot());
    `);

    results.pan10s = await traceOperation(mainWindow.webContents, path.join(outputDirectory, '02-pan-10s.trace.json'), () => execute(mainWindow.webContents, `
      const before = snapshot();
      const canvas = stageCanvas(); const x = innerWidth / 2; const y = innerHeight / 2;
      canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 1, buttons: 4, pointerId: 11, pointerType: 'mouse', clientX: x, clientY: y }));
      const frames = await runFrames(${interactionDurationMs}, (elapsed) => {
        const px = x + Math.sin(elapsed / 620) * 110; const py = y + Math.cos(elapsed / 770) * 75;
        canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 1, buttons: 4, pointerId: 11, pointerType: 'mouse', clientX: px, clientY: py }));
      });
      const duringMetrics = snapshot();
      canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 1, pointerId: 11, pointerType: 'mouse', clientX: x, clientY: y }));
      await wait(250); const metrics = snapshot(); resolve({ ...frames, metrics,
        duringMetrics, texSubImage2DDelta: duringMetrics.texSubImage2DCalls - before.texSubImage2DCalls,
        textureUploadMsDelta: duringMetrics.textureUploadMs - before.textureUploadMs });
    `, 20000));

    results.zoom10s = await traceOperation(mainWindow.webContents, path.join(outputDirectory, '03-zoom-10s.trace.json'), () => execute(mainWindow.webContents, `
      const before = snapshot();
      const canvas = stageCanvas(); const x = innerWidth / 2; const y = innerHeight / 2;
      const frames = await runFrames(${interactionDurationMs}, (elapsed) => {
        canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaY: Math.sin(elapsed / 900) * 2.8 }));
      });
      const duringMetrics = snapshot();
      await wait(300); const metrics = snapshot(); resolve({ ...frames, metrics,
        duringMetrics, texSubImage2DDelta: duringMetrics.texSubImage2DCalls - before.texSubImage2DCalls,
        textureUploadMsDelta: duringMetrics.textureUploadMs - before.textureUploadMs });
    `, 20000));

    results.drag20 = await traceOperation(mainWindow.webContents, path.join(outputDirectory, '04-drag-20.trace.json'), () => execute(mainWindow.webContents, `
      const before = snapshot();
      window.__refCanvasPerf.selectImages(20); await wait(250);
      const canvas = stageCanvas(); const x = Number(host()?.getAttribute('data-stress-hit-x') || innerWidth / 2); const y = Number(host()?.getAttribute('data-stress-hit-y') || innerHeight / 2);
      canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1, pointerId: 12, pointerType: 'mouse', clientX: x, clientY: y }));
      const frames = await runFrames(${interactionDurationMs}, (elapsed) => {
        const px = x + elapsed / 100; const py = y + Math.sin(elapsed / 500) * 36;
        canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, buttons: 1, pointerId: 12, pointerType: 'mouse', clientX: px, clientY: py }));
      });
      const duringMetrics = snapshot();
      canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 12, pointerType: 'mouse', clientX: x + 100, clientY: y }));
      await wait(400); const metrics = snapshot(); resolve({ ...frames, metrics,
        duringMetrics, texSubImage2DDelta: duringMetrics.texSubImage2DCalls - before.texSubImage2DCalls,
        textureUploadMsDelta: duringMetrics.textureUploadMs - before.textureUploadMs });
    `, 20000));

    results.boxSelect500 = await traceOperation(mainWindow.webContents, path.join(outputDirectory, '05-box-select-500.trace.json'), () => execute(mainWindow.webContents, `
      const before = snapshot();
      window.__refCanvasPerf.clearSelection(); await wait(200);
      const canvas = stageCanvas(); const startX = 3; const startY = 3;
      canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1, pointerId: 13, pointerType: 'mouse', clientX: startX, clientY: startY }));
      const frames = await runFrames(1600, (elapsed) => {
        const t = Math.min(1, elapsed / 1500); const x = startX + (innerWidth - 6) * t; const y = startY + (innerHeight - 6) * t;
        canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, buttons: 1, pointerId: 13, pointerType: 'mouse', clientX: x, clientY: y }));
      });
      canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 13, pointerType: 'mouse', clientX: innerWidth - 3, clientY: innerHeight - 3 }));
      await wait(500); const metrics = snapshot(); resolve({ ...frames, metrics,
        texSubImage2DDelta: metrics.texSubImage2DCalls - before.texSubImage2DCalls,
        textureUploadMsDelta: metrics.textureUploadMs - before.textureUploadMs });
    `, 10000));

    const scene = await mainWindow.webContents.executeJavaScript('window.__refCanvasPerf.getScene()', true);
    const packagePath = path.join(outputDirectory, 'benchmark-scene.refcanvas');
    results.saveReopen = await traceOperation(mainWindow.webContents, path.join(outputDirectory, '06-save-reopen.trace.json'), async () => {
      const saveStartedAt = performance.now();
      await writeScenePackage(packagePath, scene);
      const saveMs = performance.now() - saveStartedAt;
      const openStartedAt = performance.now();
      const reopened = await readScenePackage(packagePath);
      const reopenMs = performance.now() - openStartedAt;
      const rendererResult = await mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
        window.__refCanvasPerf.loadScene(${JSON.stringify(reopened)});
        const started = performance.now();
        const poll = () => Number(document.querySelector('canvas.pixi-canvas')?.getAttribute('data-total-images') || 0) === 500
          ? setTimeout(() => resolve(window.__refCanvasPerformanceSnapshot?.() || {}), 500)
          : performance.now() - started > 30000 ? resolve({ timeout: true }) : setTimeout(poll, 50);
        poll();
      })`, true);
      return { saveMs, reopenMs, rendererResult };
    });
    await takeHeapSnapshot(mainWindow.webContents, path.join(outputDirectory, 'memory-after-reopen.heapsnapshot'));

    const rendererMetric = app.getAppMetrics().find((metric) => metric.pid === mainWindow.webContents.getOSProcessId());
    const gpuInfo = await app.getGPUInfo('complete').catch(() => undefined);
    results.environment = {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      platform: process.platform,
      window: mainWindow.getContentBounds(),
      devicePixelRatio: await mainWindow.webContents.executeJavaScript('window.devicePixelRatio'),
      gpuInfo,
      rendererPrivateKb: rendererMetric?.memory?.privateBytes ?? 0,
      coldCache: true,
    };
    results.summary = {
      panFrameP95Ms: results.pan10s.frameP95Ms,
      zoomFrameP95Ms: results.zoom10s.frameP95Ms,
      drag20FrameP95Ms: results.drag20.frameP95Ms,
      boxSelectFrameP95Ms: results.boxSelect500.frameP95Ms,
      maxLongTaskMs: Math.max(0, ...results.pan10s.longTasks, ...results.zoom10s.longTasks, ...results.drag20.longTasks, ...results.boxSelect500.longTasks),
      saveMs: results.saveReopen.saveMs,
      reopenMs: results.saveReopen.reopenMs,
    };
    await fs.writeFile(path.join(outputDirectory, 'summary.json'), JSON.stringify(results, null, 2), 'utf8');
    console.log(`RefCanvas performance benchmark: ${JSON.stringify({ outputDirectory, ...results.summary })}`);
    return results;
  } finally {
    if (debuggerClient.isAttached()) debuggerClient.detach();
    await fs.rm(sourceDirectory, { recursive: true, force: true });
  }
}

export { percentile };
