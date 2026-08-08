import fs from 'node:fs/promises';
import path from 'node:path';
import { percentile, percentileSorted } from '../../src/shared/statistics.js';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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
        'disabled-by-default-devtools.timeline.frame', 'gpu', 'renderer.scheduler', 'toplevel', 'v8',
      ],
    },
  });
  let result;
  try { result = await action(); }
  finally { await debuggerClient.sendCommand('Tracing.end'); }
  const stream = await completed;
  await fs.writeFile(outputPath, await readProtocolStream(debuggerClient, stream));
  return result;
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

const rendererScript = `
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const host = () => document.querySelector('canvas.pixi-canvas');
  const stageCanvas = () => host();
  const numberAttr = (name) => Number(host()?.getAttribute(name) || 0);
  const renderedViewportAttr = (name) => Number(host()?.getAttribute(name) || 0);
  const snapshot = () => ({
    ...(window.__refCanvasPerformanceSnapshot?.() || {}),
    backend: host()?.getAttribute('data-render-backend'),
    viewportX: numberAttr('data-viewport-x'),
    viewportY: numberAttr('data-viewport-y'),
    viewportScale: numberAttr('data-viewport-scale'),
    renderedViewportX: renderedViewportAttr('data-rendered-viewport-x'),
    renderedViewportY: renderedViewportAttr('data-rendered-viewport-y'),
    renderedViewportScale: renderedViewportAttr('data-rendered-viewport-scale'),
    renderedImages: numberAttr('data-rendered-images'),
    totalImages: numberAttr('data-total-images'),
    renderCommands: numberAttr('data-render-commands'),
    loadedCommands: numberAttr('data-loaded-commands'),
    gpuTextures: numberAttr('data-gpu-textures'),
    gpuBytes: numberAttr('data-gpu-bytes'),
    cpuImageBytes: numberAttr('data-cpu-image-bytes'),
    decodeQueueLength: numberAttr('data-decode-queue'),
    uploadQueueLength: numberAttr('data-upload-queue'),
    longTasks: numberAttr('data-long-tasks'),
    peakGpuBytes: numberAttr('data-peak-gpu-bytes'),
    peakCpuImageBytes: numberAttr('data-peak-cpu-image-bytes'),
    peakDecodeQueue: numberAttr('data-peak-decode-queue'),
    peakUploadQueue: numberAttr('data-peak-upload-queue'),
    peakFrameUploadBytes: numberAttr('data-peak-frame-upload-bytes'),
  });
  const waitFor = async (predicate, timeout = 30000) => {
    const deadline = performance.now() + timeout;
    while (!predicate()) {
      if (performance.now() >= deadline) return false;
      await wait(50);
    }
    return true;
  };
`;

async function execute(webContents, body) {
  return webContents.executeJavaScript(`new Promise((resolve, reject) => { void (async () => {
    try { ${rendererScript}\n${body} } catch (error) { reject(String(error?.stack || error)); }
  })(); })`, true);
}

export async function runProjectZoomBenchmark({
  mainWindow, rootDir, app, projectPath, cycles = 5, writeScenePackage, readScenePackage,
}) {
  const phase = process.env.REFCANVAS_PROJECT_BENCH_PHASE || 'cold';
  const requestedFocusScale = Number(process.env.REFCANVAS_PROJECT_BENCH_FOCUS_SCALE || 0);
  const skipWarmup = process.env.REFCANVAS_PROJECT_BENCH_SKIP_WARM === '1';
  const requestedWheelDelta = Number(process.env.REFCANVAS_PROJECT_BENCH_WHEEL_DELTA || 14);
  const requestedWheelInterval = Number(process.env.REFCANVAS_PROJECT_BENCH_WHEEL_INTERVAL_MS || 0);
  const readyTimeoutMs = Math.max(60000, Number(process.env.REFCANVAS_PROJECT_READY_TIMEOUT_MS || 600000));
  const outputDirectory = path.join(rootDir, 'performance-results', `${new Date().toISOString().replace(/[:.]/g, '-')}-project-${phase}`);
  await fs.mkdir(outputDirectory, { recursive: true });
  const consoleMessages = [];
  const consoleListener = (details) => {
    const message = typeof details === 'object' ? details : { message: String(details) };
    consoleMessages.push(message);
  };
  mainWindow.webContents.on('console-message', consoleListener);
  const debuggerClient = mainWindow.webContents.debugger;
  debuggerClient.attach('1.3');
  const benchmarkStartedAt = performance.now();
  try {
    const ready = await execute(mainWindow.webContents, `
      const sceneReady = await waitFor(() => numberAttr('data-total-images') > 0, ${readyTimeoutMs});
      const backendReady = await waitFor(() => host()?.getAttribute('data-render-backend') === 'pixi-webgl', 15000);
      const firstImageReady = await waitFor(() => numberAttr('data-loaded-commands') > 0, ${readyTimeoutMs});
      const workingSetReady = await waitFor(() => {
        const required = Math.min(numberAttr('data-rendered-images'), numberAttr('data-render-commands'));
        return required > 0 && numberAttr('data-loaded-commands') >= required
          && numberAttr('data-gpu-textures') > 0
          && numberAttr('data-decode-queue') === 0
          && numberAttr('data-upload-queue') === 0;
      }, ${readyTimeoutMs});
      await wait(350);
      resolve({ sceneReady, backendReady, firstImageReady, workingSetReady, elapsedMs: performance.now(), initial: snapshot() });
    `);
    if (!ready.sceneReady || !ready.backendReady || !ready.firstImageReady || !ready.workingSetReady) {
      throw new Error(`Project did not become fully drawable: ${JSON.stringify(ready)}`);
    }
    const firstUsableMs = performance.now() - benchmarkStartedAt;
    await fs.writeFile(path.join(outputDirectory, '01-open.png'), (await mainWindow.webContents.capturePage()).toPNG());
    const zoom = await traceOperation(mainWindow.webContents, path.join(outputDirectory, '02-repeat-zoom.trace.json'), () => execute(mainWindow.webContents, `
      const scene = window.__refCanvasPerf?.getScene();
      if (!scene?.items?.length) throw new Error('project scene is unavailable');
      const items = scene.items.filter((item) => item.width > 0 && item.height > 0);
      const minX = Math.min(...items.map((item) => item.x));
      const minY = Math.min(...items.map((item) => item.y));
      const maxX = Math.max(...items.map((item) => item.x + item.width));
      const maxY = Math.max(...items.map((item) => item.y + item.height));
      const boundsCenter = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
      const focusItem = items.reduce((best, item) => {
        const distance = Math.hypot(item.x + item.width / 2 - boundsCenter.x, item.y + item.height / 2 - boundsCenter.y);
        return !best || distance < best.distance ? { item, distance } : best;
      }, undefined).item;
      const width = host().clientWidth;
      const height = host().clientHeight;
      const focusCenter = { x: focusItem.x + focusItem.width / 2, y: focusItem.y + focusItem.height / 2 };
      const fitFocusScale = Math.min((width - 40) / focusItem.width, (height - 40) / focusItem.height);
      const focusScale = ${Number.isFinite(requestedFocusScale) ? Math.max(0, requestedFocusScale) : 0} > 0
        ? Math.max(fitFocusScale, ${Number.isFinite(requestedFocusScale) ? Math.max(0, requestedFocusScale) : 0})
        : fitFocusScale;
      const extentX = Math.max(focusCenter.x - minX, maxX - focusCenter.x);
      const extentY = Math.max(focusCenter.y - minY, maxY - focusCenter.y);
      const overviewScale = Math.min((width - 60) / Math.max(1, extentX * 2), (height - 60) / Math.max(1, extentY * 2));
      const focusViewport = {
        x: width / 2 - focusCenter.x * focusScale,
        y: height / 2 - focusCenter.y * focusScale,
        scale: focusScale,
      };
      const overviewViewport = {
        x: width / 2 - focusCenter.x * overviewScale,
        y: height / 2 - focusCenter.y * overviewScale,
        scale: overviewScale,
      };
      const setViewport = (viewport) => window.dispatchEvent(new CustomEvent('refcanvas-stress-viewport', { detail: viewport }));
      const cycleResults = [];
      const longTasks = [];
      const observer = typeof PerformanceObserver === 'undefined' ? undefined : new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => longTasks.push(entry.duration));
      });
      try { observer?.observe({ entryTypes: ['longtask'] }); } catch {}
      const runWheel = (deltaY, reached) => new Promise((done) => {
        const intervals = [];
        const samples = [];
        let previous;
        const dispatch = () => stageCanvas()?.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: true, clientX: width / 2, clientY: height / 2, deltaY,
        }));
        if (${Number.isFinite(requestedWheelInterval) ? Math.max(0, requestedWheelInterval) : 0} > 20) {
          let finished = false;
          let frame = 0;
          let events = 0;
          const collectFrame = (timestamp) => {
            if (previous !== undefined) intervals.push(timestamp - previous);
            previous = timestamp;
            if (frame % 4 === 0) samples.push(snapshot());
            frame += 1;
            if (finished) done({ intervals, samples });
            else requestAnimationFrame(collectFrame);
          };
          const pulse = () => {
            dispatch();
            events += 1;
            if (reached() || events >= 300) {
              finished = true;
              return;
            }
            setTimeout(pulse, ${Number.isFinite(requestedWheelInterval) ? Math.max(0, requestedWheelInterval) : 0});
          };
          pulse();
          requestAnimationFrame(collectFrame);
          return;
        }
        // Dispatch the first input as a task, like a real OS wheel event. Starting
        // inside rAF let an older background upload callback run before the test's
        // first wheel callback and falsely attribute that upload to interaction.
        dispatch();
        samples.push(snapshot());
        let frame = 1;
        const step = (timestamp) => {
          if (previous !== undefined) intervals.push(timestamp - previous);
          previous = timestamp;
          dispatch();
          if (frame % 4 === 0) samples.push(snapshot());
          frame += 1;
          if (!reached() && frame < 300) requestAnimationFrame(step);
          else done({ intervals, samples });
        };
        requestAnimationFrame(step);
      });
      const percentileSorted = ${percentileSorted.toString()};
      const percentile = ${percentile.toString()};
      const summarizeFrames = (frames) => ({
        frames: frames.intervals.length,
        frameAverageMs: frames.intervals.reduce((total, value) => total + value, 0) / Math.max(1, frames.intervals.length),
        frameP50Ms: percentile(frames.intervals, .5),
        frameP95Ms: percentile(frames.intervals, .95),
        frameP99Ms: percentile(frames.intervals, .99),
        onePercentLow: 1000 / Math.max(.001, percentile(frames.intervals, .99)),
        samples: frames.samples,
      });

      if (!${skipWarmup}) {
        // Warm the Pixi texture working set once, then use only wheel input for
        // every measured overview -> focus -> overview cycle.
        await waitFor(() => numberAttr('data-loaded-commands') >= numberAttr('data-render-commands'), 60000);
        setViewport(focusViewport);
        await waitFor(() => Math.abs(numberAttr('data-viewport-scale') - focusScale) / focusScale < .01, 5000);
        await wait(250);
        const focusReady = await waitFor(() => numberAttr('data-loaded-commands') >= numberAttr('data-render-commands')
          && numberAttr('data-gpu-textures') > 0
          && numberAttr('data-decode-queue') === 0
          && numberAttr('data-upload-queue') === 0, 60000);
        if (!focusReady) throw new Error('focused Pixi texture working set did not become resident: ' + JSON.stringify(snapshot()));
        await wait(500);
        await runWheel(${Number.isFinite(requestedWheelDelta) ? Math.max(1, Math.abs(requestedWheelDelta)) : 14}, () => numberAttr('data-viewport-scale') <= overviewScale * 1.015);
        // Wheel viewport commits after a 400 ms idle window. Issuing the
        // overview command earlier races that commit and lets the stale wheel
        // viewport overwrite the benchmark command.
        await wait(500);
        setViewport(overviewViewport);
        await waitFor(() => numberAttr('data-loaded-commands') >= numberAttr('data-render-commands')
          && numberAttr('data-decode-queue') === 0
          && numberAttr('data-upload-queue') === 0, 60000);
        await wait(200);
        let stableGpuTextures = -1;
        let stableUploadPasses = 0;
        while (stableUploadPasses < 3) {
          const current = numberAttr('data-gpu-textures');
          stableUploadPasses = current === stableGpuTextures && numberAttr('data-upload-queue') === 0
            ? stableUploadPasses + 1 : 0;
          stableGpuTextures = current;
          await wait(100);
        }
      } else {
        setViewport(overviewViewport);
        await wait(50);
      }

      for (let cycle = 0; cycle < ${cycles}; cycle += 1) {
        const before = snapshot();
        const zoomIn = await runWheel(-${Number.isFinite(requestedWheelDelta) ? Math.max(1, Math.abs(requestedWheelDelta)) : 14}, () => numberAttr('data-viewport-scale') >= focusScale * .985);
        if (${skipWarmup}) await wait(180);
        const atFocus = snapshot();
        const zoomOut = await runWheel(${Number.isFinite(requestedWheelDelta) ? Math.max(1, Math.abs(requestedWheelDelta)) : 14}, () => numberAttr('data-viewport-scale') <= overviewScale * 1.015);
        await wait(${skipWarmup ? 180 : 220});
        const after = snapshot();
        const interactionSamples = [...zoomIn.samples, ...zoomOut.samples];
        const zoomInSummary = summarizeFrames(zoomIn);
        const zoomOutSummary = summarizeFrames(zoomOut);
        cycleResults.push({
          cycle: cycle + 1,
          before, atFocus, after,
          zoomIn: zoomInSummary,
          zoomOut: zoomOutSummary,
          frameAverageMs: (zoomInSummary.frameAverageMs * zoomInSummary.frames + zoomOutSummary.frameAverageMs * zoomOutSummary.frames)
            / Math.max(1, zoomInSummary.frames + zoomOutSummary.frames),
          frameP95Ms: Math.max(zoomInSummary.frameP95Ms, zoomOutSummary.frameP95Ms),
          frameP99Ms: Math.max(zoomInSummary.frameP99Ms, zoomOutSummary.frameP99Ms),
          onePercentLow: Math.min(zoomInSummary.onePercentLow, zoomOutSummary.onePercentLow),
          peakFrameUploadBytes: Math.max(before.frameUploadBytes || 0,
            ...interactionSamples.map((sample) => sample.frameUploadBytes || 0)),
          gpuTextureDelta: after.gpuTextures - before.gpuTextures,
        });
      }
      setViewport(overviewViewport);
      await wait(100);
      const runAltPan = async (startOverride) => {
        const canvas = stageCanvas();
        if (!canvas) throw new Error('Pixi input canvas is unavailable');
        const start = startOverride || { x: Math.round(width * .48), y: Math.round(height * .52) };
        const before = snapshot();
        const intervals = [];
        const handlerTimes = [];
        let previousFrame;
        let finalPhase = 0;
        canvas.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0, buttons: 1, altKey: true,
          pointerId: 21, pointerType: 'mouse', clientX: start.x, clientY: start.y,
        }));
        canvas.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, button: 0, buttons: 1, altKey: true,
          pointerId: 21, pointerType: 'mouse', clientX: start.x + 2, clientY: start.y + 1,
        }));
        await new Promise(requestAnimationFrame);
        const firstMove = snapshot();
        const firstMoveError = Math.max(
          Math.abs((firstMove.renderedViewportX - before.renderedViewportX) - 2),
          Math.abs((firstMove.renderedViewportY - before.renderedViewportY) - 1),
        );
        await new Promise((done) => {
          let frame = 0;
          const step = (timestamp) => {
            if (previousFrame !== undefined) intervals.push(timestamp - previousFrame);
            previousFrame = timestamp;
            for (let eventIndex = 0; eventIndex < 12; eventIndex += 1) {
              finalPhase = (frame + eventIndex / 12) / 18;
              const handlerStarted = performance.now();
              canvas.dispatchEvent(new PointerEvent('pointermove', {
                bubbles: true, cancelable: true, button: 0, buttons: 1, altKey: true,
                pointerId: 21, pointerType: 'mouse', clientX: start.x + Math.sin(finalPhase) * 180,
                clientY: start.y + Math.cos(finalPhase * .73) * 110,
              }));
              handlerTimes.push(performance.now() - handlerStarted);
            }
            frame += 1;
            if (frame < 180) requestAnimationFrame(step); else done();
          };
          requestAnimationFrame(step);
        });
        // The last mousemove queues the GPU camera draw for the next frame.
        // Let it become the visible release baseline before mouseup.
        await new Promise(requestAnimationFrame);
        const during = snapshot();
        canvas.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, button: 0, buttons: 0, altKey: true,
          pointerId: 21, pointerType: 'mouse', clientX: start.x + Math.sin(finalPhase) * 180,
          clientY: start.y + Math.cos(finalPhase * .73) * 110,
        }));
        const releaseSamples = [snapshot()];
        for (let frame = 0; frame < 6; frame += 1) {
          await new Promise(requestAnimationFrame);
          releaseSamples.push(snapshot());
        }
        const rollbackFrames = releaseSamples.filter((sample) => (
          Math.abs(sample.renderedViewportX - during.renderedViewportX) > .5
          || Math.abs(sample.renderedViewportY - during.renderedViewportY) > .5
          || Math.abs(sample.renderedViewportScale - during.renderedViewportScale) > .0001
        )).length;
        return {
          before, firstMove, firstMoveError, during, releaseSamples, rollbackFrames,
          frameP95Ms: percentile(intervals, .95), frameP99Ms: percentile(intervals, .99),
          onePercentLow: 1000 / Math.max(.001, percentile(intervals, .99)),
          handlerP95Ms: percentile(handlerTimes, .95), handlerMaxMs: Math.max(...handlerTimes),
        };
      };
      const altPan = await runAltPan();
      setViewport(overviewViewport);
      await wait(100);
      await runWheel(-${Number.isFinite(requestedWheelDelta) ? Math.max(1, Math.abs(requestedWheelDelta)) : 14}, () => numberAttr('data-viewport-scale') >= focusScale * .985);
      // The wheel loop resolves after dispatching its last event. Let that
      // camera frame render before measuring the first independent pan delta.
      await new Promise(requestAnimationFrame);
      const highZoomAltPan = await runAltPan();
      const selectedItem = items[0];
      const selectedScale = Math.min((width - 80) / selectedItem.width, (height - 80) / selectedItem.height);
      const selectedViewport = {
        x: width / 2 - (selectedItem.x + selectedItem.width / 2) * selectedScale,
        y: height / 2 - (selectedItem.y + selectedItem.height / 2) * selectedScale,
        scale: selectedScale,
      };
      setViewport(selectedViewport);
      window.__refCanvasPerf?.selectImages(1);
      await wait(100);
      const selectionAnchorAltPan = await runAltPan({
        x: selectedViewport.x + selectedItem.x * selectedScale,
        y: selectedViewport.y + selectedItem.y * selectedScale,
      });
      window.__refCanvasPerf?.clearSelection();
      if (${skipWarmup}) await wait(2000);
      const settledAfterLoading = snapshot();
      observer?.disconnect();
      resolve({
        focusItem: { id: focusItem.id, name: focusItem.name, naturalWidth: focusItem.naturalWidth, naturalHeight: focusItem.naturalHeight },
        focusScale, overviewScale, focusViewport, overviewViewport,
        bounds: { minX, minY, maxX, maxY }, cycleResults, altPan, highZoomAltPan, selectionAnchorAltPan,
        settledAfterLoading, longTasks, final: snapshot(),
      });
    `));
    for (const [label, pan] of [
      ['overview', zoom.altPan], ['high-zoom', zoom.highZoomAltPan], ['selection-anchor', zoom.selectionAnchorAltPan],
    ]) {
      if (pan.rollbackFrames) {
        throw new Error(`${label} Alt-pan release rolled the rendered viewport back for ${pan.rollbackFrames} sampled frame(s)`);
      }
      if (pan.firstMoveError > 1) {
        throw new Error(`${label} Alt-pan first move jumped by ${pan.firstMoveError.toFixed(2)}px`);
      }
      // Acceptance is based on sustained P95 frame time, while P99 is allowed
      // bounded scheduling jitter as long as it stays below a long-task frame.
      if (pan.frameP95Ms > 25 || pan.frameP99Ms > 50) {
        throw new Error(`${label} Alt-pan performance failed: p95 ${pan.frameP95Ms.toFixed(1)}ms, p99 ${pan.frameP99Ms.toFixed(1)}ms`);
      }
    }
    const migratedScene = await mainWindow.webContents.executeJavaScript('structuredClone(window.__refCanvasPerf.getScene())', true);
    if (migratedScene.version !== 3) throw new Error(`Renderer did not migrate project to version 3 (got ${migratedScene.version})`);
    const migratedPath = path.join(outputDirectory, 'migrated-roundtrip.refcanvas');
    const saveStartedAt = performance.now();
    await writeScenePackage(migratedPath, migratedScene);
    const saveMs = performance.now() - saveStartedAt;
    const reopenStartedAt = performance.now();
    const { scene: reopenedScene } = await readScenePackage(migratedPath);
    const reopenMs = performance.now() - reopenStartedAt;
    const projectShape = (scene) => ({
      version: scene.version, viewport: scene.viewport,
      assets: Object.keys(scene.assets ?? {}).sort(),
      items: scene.items.map((item) => ({
        id: item.id, assetId: item.assetId, x: item.x, y: item.y, width: item.width, height: item.height,
        rotation: item.rotation, zIndex: item.zIndex, opacity: item.opacity, crop: item.crop,
      })),
    });
    if (JSON.stringify(projectShape(reopenedScene)) !== JSON.stringify(projectShape(migratedScene))) {
      throw new Error('Migrated project changed geometry, ordering, viewport, or asset identity after save/reopen');
    }
    const rendererReopen = await execute(mainWindow.webContents, `
      window.__refCanvasPerf.loadScene(${JSON.stringify(reopenedScene)});
      const reopenedReady = await waitFor(() => numberAttr('data-total-images') === ${reopenedScene.items.length}
        && numberAttr('data-loaded-commands') >= numberAttr('data-render-commands')
        && numberAttr('data-decode-queue') === 0
        && numberAttr('data-upload-queue') === 0, 60000);
      resolve({ reopenedReady, snapshot: snapshot() });
    `);
    if (!rendererReopen.reopenedReady) throw new Error(`Migrated project did not redraw after reopen: ${JSON.stringify(rendererReopen)}`);
    await execute(mainWindow.webContents, `
      window.dispatchEvent(new CustomEvent('refcanvas-stress-viewport', { detail: ${JSON.stringify(zoom.focusViewport)} }));
      resolve(snapshot());
    `);
    await wait(450);
    await fs.writeFile(path.join(outputDirectory, '03-pixel-focus.png'), (await mainWindow.webContents.capturePage()).toPNG());
    await execute(mainWindow.webContents, `
      window.dispatchEvent(new CustomEvent('refcanvas-stress-viewport', { detail: ${JSON.stringify(zoom.overviewViewport)} }));
      resolve(snapshot());
    `);
    await wait(350);
    await fs.writeFile(path.join(outputDirectory, '04-overview.png'), (await mainWindow.webContents.capturePage()).toPNG());
    if (process.env.REFCANVAS_PROJECT_BENCH_HEAP === '1') {
      await takeHeapSnapshot(mainWindow.webContents, path.join(outputDirectory, '05-after-zoom.heapsnapshot'));
    }
    const rendererMetric = app.getAppMetrics().find((metric) => metric.pid === mainWindow.webContents.getOSProcessId());
    const results = {
      projectPath,
      phase,
      outputDirectory,
      firstUsableMs,
      ready,
      zoom,
      migrationRoundtrip: { migratedPath, saveMs, reopenMs, rendererReopen },
      consoleMessages,
      environment: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        platform: process.platform,
        window: mainWindow.getContentBounds(),
        devicePixelRatio: await mainWindow.webContents.executeJavaScript('window.devicePixelRatio'),
        gpuInfo: await app.getGPUInfo('complete').catch(() => undefined),
        rendererPrivateKb: rendererMetric?.memory?.privateBytes ?? 0,
      },
    };
    await fs.writeFile(path.join(outputDirectory, 'summary.json'), JSON.stringify(results, null, 2), 'utf8');
    console.log(`RefCanvas project zoom benchmark: ${JSON.stringify({
      outputDirectory,
      firstUsableMs,
      cycles: zoom.cycleResults.map((cycle) => ({
        average: cycle.frameAverageMs, p95: cycle.frameP95Ms,
        p99: cycle.frameP99Ms,
        peakFrameUploadBytes: cycle.peakFrameUploadBytes,
        gpuTextureDelta: cycle.gpuTextureDelta,
        loaded: cycle.after.loadedCommands,
        commands: cycle.after.renderCommands,
        mips: cycle.after.currentMip,
      })),
      altPan: {
        p95: zoom.altPan.frameP95Ms, p99: zoom.altPan.frameP99Ms,
        onePercentLow: zoom.altPan.onePercentLow, handlerP95: zoom.altPan.handlerP95Ms,
        rollbackFrames: zoom.altPan.rollbackFrames, firstMoveError: zoom.altPan.firstMoveError,
      },
      highZoomAltPan: {
        p95: zoom.highZoomAltPan.frameP95Ms, p99: zoom.highZoomAltPan.frameP99Ms,
        onePercentLow: zoom.highZoomAltPan.onePercentLow, handlerP95: zoom.highZoomAltPan.handlerP95Ms,
        rollbackFrames: zoom.highZoomAltPan.rollbackFrames, firstMoveError: zoom.highZoomAltPan.firstMoveError,
      },
      selectionAnchorAltPan: {
        p95: zoom.selectionAnchorAltPan.frameP95Ms, p99: zoom.selectionAnchorAltPan.frameP99Ms,
        onePercentLow: zoom.selectionAnchorAltPan.onePercentLow, handlerP95: zoom.selectionAnchorAltPan.handlerP95Ms,
        rollbackFrames: zoom.selectionAnchorAltPan.rollbackFrames,
        firstMoveError: zoom.selectionAnchorAltPan.firstMoveError,
      },
      longTasks: zoom.longTasks,
      consoleMessages: consoleMessages.length,
    })}`);
    return results;
  } finally {
    mainWindow.webContents.removeListener('console-message', consoleListener);
    if (debuggerClient.isAttached()) debuggerClient.detach();
  }
}
