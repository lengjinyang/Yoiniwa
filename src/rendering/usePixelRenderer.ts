import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import Konva from 'konva';
import { Canvas2DImageRenderer } from './Canvas2DImageRenderer';
import { emptyImageSyncResult, type ImageRenderBackend } from './ImageRenderBackend';
import { applyCompactGesture, applyImagePreview, compactGestureMatrix, type CompactImageGesture } from './previewTransforms';
import type { ImageRenderCommand } from './renderPlan';
import { WebGL2ImageRenderer } from './WebGL2ImageRenderer';
import type { ImageItem, Viewport } from '../types';
import { performanceMonitor } from '../performanceMonitor';
import { rendererError } from '../logger';
import { readyCachedImage } from '../imageResources';
import { commandsWithCompleteTileSets } from './completeTileSets';
import { percentileSorted } from '../shared/statistics';
import { areFinalRenderCommandsResident, commandsWithResidentFallback } from './stableRenderCommands';
import { nextViewportCommitPending, sameViewport } from './viewportCommitGuard';

type PixelBackend = 'webgl2' | 'canvas2d' | 'konva';
const MAX_PENDING_IMAGES_PER_FRAME = 16;
const PENDING_IMAGE_FLUSH_BUDGET_MS = 1.5;

export function resourcePriorityIds(commands: readonly ImageRenderCommand[]) {
  const groups = new Map<string, ImageRenderCommand[]>();
  commands.forEach((command) => {
    const id = command.imageId ?? command.id;
    const group = groups.get(id);
    if (group) group.push(command);
    else groups.set(id, [command]);
  });
  const preferred: string[] = [];
  const fallback: string[] = [];
  groups.forEach((group) => {
    const final = group.filter((command) => command.id.endsWith(':detail') || command.id.includes(':tile:'));
    if (final.length) {
      preferred.push(...final.map((command) => command.id));
      fallback.push(...group.filter((command) => command.id.endsWith(':preview')).map((command) => command.id));
    } else preferred.push(...group.map((command) => command.id));
  });
  return { preferred, fallback };
}

export function resourceSyncIds(
  commands: readonly ImageRenderCommand[],
  lastDrawableIds: readonly string[],
  prewarmIds: readonly string[],
  visibleFinalIds: readonly string[] = [],
) {
  const priority = resourcePriorityIds(commands);
  const protectedIds = lastDrawableIds.length
    ? new Set([...lastDrawableIds, ...visibleFinalIds])
    : new Set([...priority.fallback, ...priority.preferred, ...visibleFinalIds]);
  return {
    activeIds: new Set([
      // A bounded screen-safe resource must be admitted before optional detail.
      // Otherwise a cold board can consume the atlas with a few large images
      // and leave the remaining visible images blank.
      ...priority.fallback,
      ...lastDrawableIds,
      ...visibleFinalIds,
      ...priority.preferred,
      ...prewarmIds,
    ]),
    protectedIds,
  };
}

interface Options {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  commands: readonly ImageRenderCommand[];
  prewarmCommandIds?: readonly string[];
  protectedCommandIds?: readonly string[];
  itemsById: ReadonlyMap<string, ImageItem>;
  selectedIds?: readonly string[];
  viewport: Viewport;
  size: { width: number; height: number };
  stageRef: RefObject<Konva.Stage | null>;
  backend: PixelBackend;
  setBackend(backend: PixelBackend): void;
  interactionActive: boolean;
  setInteractionActive(active: boolean): void;
  enabled?: boolean;
}

export function usePixelRenderer({
  canvasRef, commands, prewarmCommandIds = [], protectedCommandIds = [], itemsById, selectedIds = [], viewport, size, stageRef, backend, setBackend, interactionActive,
  setInteractionActive, enabled = true,
}: Options) {
  const imagesRef = useRef(new Map<string, HTMLImageElement>());
  const pendingImagesRef = useRef(new Map<string, HTMLImageElement>());
  const imageFlushFrameRef = useRef<number | undefined>(undefined);
  const imageFlushTimerRef = useRef<number | undefined>(undefined);
  const resourceSyncFrameRef = useRef<number | undefined>(undefined);
  const resourceSyncTimerRef = useRef<number | undefined>(undefined);
  const resourceRetryDelayRef = useRef(250);
  const resourceRetryCountRef = useRef(0);
  const lastSyncResultRef = useRef(emptyImageSyncResult());
  const resourceSyncChainActiveRef = useRef(false);
  const renderFrameRef = useRef<((
    nextCommands: readonly ImageRenderCommand[],
    nextViewport: Viewport,
    syncResources?: boolean,
  ) => void) | undefined>(undefined);
  const uploadResumeAtRef = useRef(0);
  const interactionActiveRef = useRef(interactionActive);
  const rendererRef = useRef<ImageRenderBackend | undefined>(undefined);
  const enabledRef = useRef(true);
  const commandsRef = useRef(commands);
  const prewarmCommandIdsRef = useRef(prewarmCommandIds);
  const protectedCommandIdsRef = useRef(protectedCommandIds);
  const itemsRef = useRef(itemsById);
  const selectedIdsRef = useRef(selectedIds);
  const viewportRef = useRef(viewport);
  const previewFrameRef = useRef<number | undefined>(undefined);
  const gesturePreviewRef = useRef<CompactImageGesture | undefined>(undefined);
  const gestureSelectionInitializedRef = useRef(false);
  const viewportFrameRef = useRef<number | undefined>(undefined);
  const liveViewportRef = useRef(viewport);
  const previousInteractionActiveRef = useRef(interactionActive);
  const viewportCommitPendingRef = useRef(false);
  const pendingViewportBaseRef = useRef<Viewport | undefined>(undefined);
  const pendingViewportTargetRef = useRef<Viewport | undefined>(undefined);
  const frameTimesRef = useRef<number[]>([]);
  const longTasksRef = useRef(0);
  const lastDrawableCommandsRef = useRef<readonly ImageRenderCommand[]>([]);
  const frozenLodTransitionRef = useRef(false);
  const interactionUploadStartRef = useRef(0);
  const interactionImagesChangedRef = useRef(false);
  const [imageEpoch, setImageEpoch] = useState(0);
  const [rendererEpoch, setRendererEpoch] = useState(0);

  commandsRef.current = commands;
  prewarmCommandIdsRef.current = prewarmCommandIds;
  protectedCommandIdsRef.current = protectedCommandIds;
  itemsRef.current = itemsById;
  selectedIdsRef.current = selectedIds;
  viewportRef.current = viewport;
  interactionActiveRef.current = interactionActive;
  if (previousInteractionActiveRef.current && !interactionActive) {
    pendingViewportBaseRef.current = { ...viewport };
    pendingViewportTargetRef.current = { ...liveViewportRef.current };
  }
  viewportCommitPendingRef.current = nextViewportCommitPending(
    viewportCommitPendingRef.current,
    previousInteractionActiveRef.current,
    interactionActive,
    viewport,
    liveViewportRef.current,
  );
  if (viewportCommitPendingRef.current
    && pendingViewportBaseRef.current
    && pendingViewportTargetRef.current
    && !sameViewport(viewport, pendingViewportBaseRef.current)
    && !sameViewport(viewport, pendingViewportTargetRef.current)) {
    // A command such as fit-to-board arrived while the previous gesture commit
    // was pending. It is authoritative and must not be mistaken for the stale
    // pre-gesture Scene value.
    viewportCommitPendingRef.current = false;
  }
  if (!viewportCommitPendingRef.current) {
    pendingViewportBaseRef.current = undefined;
    pendingViewportTargetRef.current = undefined;
  }
  previousInteractionActiveRef.current = interactionActive;

  // Import resources are decoded while the progress overlay is still open.
  // Seed cached non-tile resources directly into the renderer map when the
  // scene appears instead of waiting for one React state/effect cycle each.
  commands.forEach((command) => {
    if (!command.resourceUrl || command.resourceUrl.includes('variant=tile')) return;
    const cached = readyCachedImage(command.resourceUrl);
    const existing = imagesRef.current.get(command.id);
    if (cached && (!existing
      || existing.naturalWidth * existing.naturalHeight < cached.naturalWidth * cached.naturalHeight)) {
      imagesRef.current.set(command.id, cached);
    }
  });

  useEffect(() => {
    if (!interactionActive && !viewportCommitPendingRef.current) liveViewportRef.current = viewport;
  }, [interactionActive, viewport]);

  useEffect(() => {
    const observer = typeof PerformanceObserver === 'undefined' ? undefined : new PerformanceObserver((list) => {
      longTasksRef.current += list.getEntries().filter((entry) => entry.duration >= 50).length;
    });
    try { observer?.observe({ entryTypes: ['longtask'] }); } catch { /* Unsupported by this Chromium build. */ }
    return () => observer?.disconnect();
  }, []);

  useEffect(() => {
    if (interactionActive) interactionUploadStartRef.current = rendererRef.current?.getStats().textureUploads ?? 0;
  }, [interactionActive]);

  useEffect(() => {
    rendererRef.current?.setSelection?.(new Set(selectedIds));
  }, [selectedIds]);

  const recordRenderedViewport = useCallback((nextViewport: Viewport) => {
    if (!performanceMonitor.enabled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.dataset.renderedViewportX = String(nextViewport.x);
    canvas.dataset.renderedViewportY = String(nextViewport.y);
    canvas.dataset.renderedViewportScale = String(nextViewport.scale);
  }, [canvasRef]);

  const recordLiveRendererStats = useCallback((stats: ReturnType<ImageRenderBackend['getStats']>) => {
    if (!performanceMonitor.enabled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.dataset.renderInstances = String(stats.instances);
    canvas.dataset.textureUploads = String(stats.textureUploads);
  }, [canvasRef]);

  const disableRenderer = useCallback(() => {
    rendererRef.current = undefined;
    setInteractionActive(false);
    setBackend('konva');
  }, []);

  useEffect(() => {
    if (!enabled || !enabledRef.current || !canvasRef.current) {
      setBackend('konva');
      return;
    }
    let renderer: ImageRenderBackend | undefined;
    try {
      renderer = new WebGL2ImageRenderer(canvasRef.current, () => {
        enabledRef.current = false;
        disableRenderer();
      }, () => {
        enabledRef.current = true;
        setRendererEpoch((value) => value + 1);
      });
      rendererRef.current = renderer;
      renderer.setSelection?.(new Set(selectedIdsRef.current));
      setBackend('webgl2');
    } catch (error) {
      rendererError('webgl.initialize-failed', error);
      try {
        renderer = new Canvas2DImageRenderer(canvasRef.current);
        rendererRef.current = renderer;
        setBackend('canvas2d');
      } catch (fallbackError) {
        rendererError('canvas2d.initialize-failed', fallbackError);
        setBackend('konva');
      }
    }
    return () => {
      if (rendererRef.current === renderer) rendererRef.current = undefined;
      renderer?.destroy();
    };
  }, [canvasRef, disableRenderer, enabled, rendererEpoch, setBackend]);

  const flushPendingImages = useCallback(() => {
    imageFlushFrameRef.current = undefined;
    if (interactionActiveRef.current || !pendingImagesRef.current.size) return;
    const startedAt = performance.now();
    let changed = false;
    let processed = 0;
    for (const [id, image] of pendingImagesRef.current) {
      pendingImagesRef.current.delete(id);
      const existing = imagesRef.current.get(id);
      if (!existing || existing.naturalWidth * existing.naturalHeight < image.naturalWidth * image.naturalHeight) {
        imagesRef.current.set(id, image);
        changed = true;
      }
      processed += 1;
      // Publishing one decoded image per frame made a 70-image cold import
      // spend almost a full second merely transferring references between two
      // maps. Batch this cheap work while retaining a strict CPU budget; actual
      // GPU uploads remain separately limited by the renderer.
      if (processed >= MAX_PENDING_IMAGES_PER_FRAME
        || performance.now() - startedAt >= PENDING_IMAGE_FLUSH_BUDGET_MS) break;
    }
    if (changed) setImageEpoch((value) => value + 1);
    if (pendingImagesRef.current.size) imageFlushFrameRef.current = requestAnimationFrame(flushPendingImages);
  }, []);

  const scheduleImageFlush = useCallback(() => {
    if (interactionActiveRef.current || imageFlushFrameRef.current !== undefined
      || imageFlushTimerRef.current !== undefined || !pendingImagesRef.current.size) return;
    const delay = uploadResumeAtRef.current - performance.now();
    if (delay > 0) {
      imageFlushTimerRef.current = window.setTimeout(() => {
        imageFlushTimerRef.current = undefined;
        rendererRef.current?.setUploadsPaused?.(false);
        scheduleImageFlush();
      }, delay);
      return;
    }
    rendererRef.current?.setUploadsPaused?.(false);
    imageFlushFrameRef.current = requestAnimationFrame(flushPendingImages);
  }, [flushPendingImages]);

  const setPixelImage = useCallback((id: string, image: HTMLImageElement) => {
    const existing = imagesRef.current.get(id);
    if (existing === image) return;
    // A late low-LOD request must never replace a sharper image that is already
    // resident under the same logical command during a zoom reversal.
    if (existing && existing.naturalWidth * existing.naturalHeight >= image.naturalWidth * image.naturalHeight) return;
    if (interactionActiveRef.current) {
      const pending = pendingImagesRef.current.get(id);
      if (!pending || pending.naturalWidth * pending.naturalHeight < image.naturalWidth * image.naturalHeight) {
        pendingImagesRef.current.set(id, image);
      }
      return;
    }
    const pending = pendingImagesRef.current.get(id);
    if (!pending || pending.naturalWidth * pending.naturalHeight < image.naturalWidth * image.naturalHeight) {
      pendingImagesRef.current.set(id, image);
    }
    scheduleImageFlush();
  }, [scheduleImageFlush]);

  const setUploadPause = useCallback((paused: boolean) => {
    interactionActiveRef.current = paused;
    if (paused) interactionUploadStartRef.current = rendererRef.current?.getStats().textureUploads ?? 0;
    // A wheel or pan gesture is camera-only. Decoded upgrades remain queued
    // until the pointer settles, preventing texture uploads from producing the
    // visible one-frame hitch reported on large multi-image boards.
    rendererRef.current?.setUploadsPaused?.(paused);
    if (paused) {
      if (imageFlushFrameRef.current !== undefined) cancelAnimationFrame(imageFlushFrameRef.current);
      if (imageFlushTimerRef.current !== undefined) window.clearTimeout(imageFlushTimerRef.current);
      if (resourceSyncFrameRef.current !== undefined) cancelAnimationFrame(resourceSyncFrameRef.current);
      if (resourceSyncTimerRef.current !== undefined) window.clearTimeout(resourceSyncTimerRef.current);
      imageFlushFrameRef.current = undefined;
      imageFlushTimerRef.current = undefined;
      resourceSyncFrameRef.current = undefined;
      resourceSyncTimerRef.current = undefined;
      resourceSyncChainActiveRef.current = false;
      return;
    }
    uploadResumeAtRef.current = performance.now();
    if (interactionImagesChangedRef.current) {
      interactionImagesChangedRef.current = false;
      setImageEpoch((value) => value + 1);
    }
    scheduleImageFlush();
  }, [scheduleImageFlush]);

  useEffect(() => {
    if (!interactionActive) scheduleImageFlush();
  }, [interactionActive, scheduleImageFlush]);

  const render = useCallback((nextCommands: readonly ImageRenderCommand[], nextViewport: Viewport, syncResources = true) => {
    const renderer = rendererRef.current;
    if (!renderer || backend === 'konva') return;
    try {
      const started = performance.now();
      if (syncResources && performance.now() >= uploadResumeAtRef.current) {
        // Protect the last visible frame until its replacement is fully resident.
        // Otherwise atlas pressure may evict the fallback between sync and draw,
        // producing a one-frame blank or unrelated recycled slot.
        // A bounded preview is the non-negotiable safety plane. Upload it
        // before optional detail so a cold multi-image scene can never spend
        // the complete atlas budget on original-sized resources.
        const { activeIds, protectedIds } = resourceSyncIds(
          nextCommands,
          frozenLodTransitionRef.current
            ? []
            : lastDrawableCommandsRef.current.map((command) => command.id),
          prewarmCommandIdsRef.current,
          // Visible final resources outrank speculative prewarm allocations.
          protectedCommandIdsRef.current,
        );
        const syncResult = renderer.syncImages(imagesRef.current, activeIds, protectedIds);
        lastSyncResultRef.current = syncResult;
        if (syncResult.uploadedIds.length || syncResult.evictedIds.length) resourceRetryDelayRef.current = 250;
        if (syncResult.uploadedIds.length && !syncResult.needsRetry && resourceSyncFrameRef.current === undefined) {
          // Publish completed uploads at the next frame boundary. This also
          // guarantees that a last upload in a chain cannot leave the stable
          // fallback selected merely because no further resource event fires.
          resourceSyncFrameRef.current = requestAnimationFrame(() => {
            resourceSyncFrameRef.current = undefined;
            renderFrameRef.current?.(commandsRef.current, liveViewportRef.current, false);
          });
        }
        if (syncResult.pendingIds.length && resourceSyncFrameRef.current === undefined && !interactionActiveRef.current) {
          resourceSyncChainActiveRef.current = true;
          resourceSyncFrameRef.current = requestAnimationFrame(() => {
            resourceSyncFrameRef.current = undefined;
            if (!interactionActiveRef.current) {
              renderFrameRef.current?.(commandsRef.current, liveViewportRef.current, true);
            }
          });
        } else if (syncResult.blockedIds.length && resourceSyncTimerRef.current === undefined && !interactionActiveRef.current) {
          resourceSyncChainActiveRef.current = true;
          const delay = resourceRetryDelayRef.current;
          resourceRetryDelayRef.current = Math.min(5000, delay < 1000 ? 1000 : 5000);
          resourceSyncTimerRef.current = window.setTimeout(() => {
            resourceSyncTimerRef.current = undefined;
            resourceRetryCountRef.current += 1;
            if (!interactionActiveRef.current) renderFrameRef.current?.(commandsRef.current, liveViewportRef.current, true);
          }, delay);
        } else if (!syncResult.needsRetry && resourceSyncChainActiveRef.current) {
          resourceSyncChainActiveRef.current = false;
          resourceRetryDelayRef.current = 250;
          // Publish counters and loader gating once after the renderer finishes
          // the complete upload chain, not after every four textures.
          setImageEpoch((value) => value + 1);
        }
      }
      const residentCandidates = new Set([
        ...nextCommands.map((command) => command.id),
        ...lastDrawableCommandsRef.current.map((command) => command.id),
      ]);
      const residentIds = new Set([...residentCandidates].filter((id) => renderer.isImageResident?.(id) ?? imagesRef.current.has(id)));
      const drawableCommands = renderer.kind === 'webgl2'
        ? commandsWithResidentFallback(nextCommands, residentIds, lastDrawableCommandsRef.current)
        : commandsWithCompleteTileSets(nextCommands, residentIds);
      if (frozenLodTransitionRef.current && !areFinalRenderCommandsResident(nextCommands, residentIds)) {
        lastDrawableCommandsRef.current = [];
        return;
      }
      if (frozenLodTransitionRef.current) frozenLodTransitionRef.current = false;
      lastDrawableCommandsRef.current = drawableCommands;
      renderer.render(drawableCommands.map((command) => ({ ...command, image: imagesRef.current.get(command.id) })), nextViewport);
      recordRenderedViewport(nextViewport);
      const rendererStats = renderer.getStats();
      recordLiveRendererStats(rendererStats);
      const frameTime = performance.now() - started;
      performanceMonitor.recordRendererFrame(frameTime, rendererStats, renderer.kind);
      frameTimesRef.current.push(frameTime);
      if (frameTimesRef.current.length > 240) frameTimesRef.current.splice(0, frameTimesRef.current.length - 240);
      if (lastSyncResultRef.current.blockedIds.length && !interactionActiveRef.current && drawableCommands.length) {
        // Preserve this complete frame while dropping the old LOD from the next
        // active set. The target is published only after every final resource
        // is resident, preventing both blurry fallback and partial tile flashes.
        frozenLodTransitionRef.current = true;
        lastDrawableCommandsRef.current = [];
        const targetResources = resourceSyncIds(
          nextCommands,
          [],
          prewarmCommandIdsRef.current,
          protectedCommandIdsRef.current,
        );
        renderer.setActiveResources?.(targetResources.activeIds);
        if (resourceSyncTimerRef.current !== undefined) window.clearTimeout(resourceSyncTimerRef.current);
        resourceSyncTimerRef.current = undefined;
        if (resourceSyncFrameRef.current === undefined) resourceSyncFrameRef.current = requestAnimationFrame(() => {
          resourceSyncFrameRef.current = undefined;
          renderFrameRef.current?.(commandsRef.current, liveViewportRef.current, true);
        });
      }
    } catch (error) {
      rendererError('pixel-render.failed', error, { commandCount: nextCommands.length, backend });
      disableRenderer();
    }
  }, [backend, disableRenderer, recordLiveRendererStats, recordRenderedViewport]);
  renderFrameRef.current = render;

  const schedulePreviewRender = useCallback((gesture?: CompactImageGesture) => {
    gesturePreviewRef.current = gesture;
    if (backend === 'konva' || previewFrameRef.current !== undefined) return;
    previewFrameRef.current = requestAnimationFrame(() => {
      previewFrameRef.current = undefined;
      const compactGesture = gesturePreviewRef.current;
      const gpuRenderer = rendererRef.current;
      if (compactGesture && gpuRenderer?.kind === 'webgl2' && gpuRenderer.setSelection && gpuRenderer.setGesture) {
        const transform = compactGestureMatrix(compactGesture);
        if (!gestureSelectionInitializedRef.current) {
          gpuRenderer.setSelection(compactGesture.imageIds);
          gestureSelectionInitializedRef.current = true;
        }
        gpuRenderer.setGesture(transform.matrix, transform.opacity);
        gpuRenderer.renderViewport?.(liveViewportRef.current);
        const stats = gpuRenderer.getStats();
        recordLiveRendererStats(stats);
        performanceMonitor.recordRendererFrame(0, stats, gpuRenderer.kind);
        return;
      }
      if (compactGesture) {
        render(commandsRef.current.map((command) => applyCompactGesture(command, compactGesture)), liveViewportRef.current, false);
        return;
      }
      gpuRenderer?.clearGesture?.();
      gestureSelectionInitializedRef.current = false;
      const stage = stageRef.current;
      const previewCommands = commandsRef.current.map((command) => {
        const item = itemsRef.current.get(command.imageId ?? command.id);
        const node = item ? stage?.findOne(`#${item.id}`) : undefined;
        if (!item || !node) return command;
        const previewOpacity = node.getAttr('pixelPreviewOpacity');
        return applyImagePreview(command, item, {
          x: node.x(), y: node.y(), scaleX: node.scaleX(), scaleY: node.scaleY(), rotation: node.rotation(),
          opacity: typeof previewOpacity === 'number' ? previewOpacity : undefined,
        });
      });
      render(previewCommands, liveViewportRef.current, false);
    });
  }, [backend, recordLiveRendererStats, render, stageRef]);

  const scheduleViewportRender = useCallback((nextViewport: Viewport) => {
    liveViewportRef.current = nextViewport;
    if (backend === 'konva' || viewportFrameRef.current !== undefined) return;
    viewportFrameRef.current = requestAnimationFrame(() => {
      viewportFrameRef.current = undefined;
      const renderer = rendererRef.current;
      if (!renderer?.renderViewport) {
        render(commandsRef.current, liveViewportRef.current);
        return;
      }
      try {
        const started = performance.now();
        let rebuiltScene = false;
        if (interactionImagesChangedRef.current) {
          const { activeIds, protectedIds } = resourceSyncIds(
            commandsRef.current,
            frozenLodTransitionRef.current
              ? []
              : lastDrawableCommandsRef.current.map((command) => command.id),
            prewarmCommandIdsRef.current,
            protectedCommandIdsRef.current,
          );
          const uploadsBefore = renderer.getStats().textureUploads;
          renderer.syncImages(imagesRef.current, activeIds, protectedIds);
          if (renderer.getStats().textureUploads > uploadsBefore) {
            render(commandsRef.current, liveViewportRef.current, false);
            rebuiltScene = true;
          } else interactionImagesChangedRef.current = false;
        }
        if (!rebuiltScene) renderer.renderViewport(liveViewportRef.current);
        recordRenderedViewport(liveViewportRef.current);
        const rendererStats = renderer.getStats();
        recordLiveRendererStats(rendererStats);
        const frameTime = performance.now() - started;
        frameTimesRef.current.push(frameTime);
        if (frameTimesRef.current.length > 240) frameTimesRef.current.splice(0, frameTimesRef.current.length - 240);
        performanceMonitor.recordRendererFrame(frameTime, rendererStats, renderer.kind);
      } catch (error) {
        rendererError('viewport-render.failed', error, { backend });
        disableRenderer();
      }
    });
  }, [backend, disableRenderer, recordLiveRendererStats, recordRenderedViewport, render]);

  const settleViewportForPointerGesture = useCallback(() => {
    const hadPendingFrame = viewportFrameRef.current !== undefined;
    if (viewportFrameRef.current !== undefined) cancelAnimationFrame(viewportFrameRef.current);
    viewportFrameRef.current = undefined;
    if (!hadPendingFrame) return { viewport: { ...liveViewportRef.current }, discardedPendingFrame: false };
    const stats = rendererRef.current?.getStats();
    const rendered = stats && stats.renderedViewportScale > 0 ? {
      x: stats.renderedViewportX,
      y: stats.renderedViewportY,
      scale: stats.renderedViewportScale,
    } : { ...liveViewportRef.current };
    liveViewportRef.current = rendered;
    return { viewport: { ...rendered }, discardedPendingFrame: true };
  }, []);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || backend === 'konva') return;
    try {
      renderer.resize(size.width, size.height, window.devicePixelRatio || 1);
      if (interactionActive) schedulePreviewRender(gesturePreviewRef.current);
      else {
        // The final live gesture frame is already on screen. Keep its camera,
        // but do not skip the scene/resource sync: a tiny camera mismatch can
        // otherwise leave the commit guard pending forever and strand the old
        // LOD working set in the atlas.
        if (viewportCommitPendingRef.current) {
          render(commands, liveViewportRef.current);
          return;
        }
        gesturePreviewRef.current = undefined;
        gestureSelectionInitializedRef.current = false;
        renderer.clearGesture?.();
        liveViewportRef.current = viewport;
        render(commands, viewport);
      }
    } catch (error) {
      rendererError('renderer-resize-or-sync.failed', error, { backend, commandCount: commands.length });
      disableRenderer();
    }
  }, [backend, commands, disableRenderer, imageEpoch, interactionActive, render, schedulePreviewRender, size, viewport]);

  useEffect(() => {
    const ids = new Set([...commands.map((command) => command.id), ...prewarmCommandIds]);
    for (const id of imagesRef.current.keys()) {
      if (!ids.has(id)) imagesRef.current.delete(id);
    }
    for (const id of pendingImagesRef.current.keys()) {
      if (!ids.has(id)) pendingImagesRef.current.delete(id);
    }
  }, [commands, prewarmCommandIds]);

  useEffect(() => () => {
    imagesRef.current.clear();
    pendingImagesRef.current.clear();
    lastDrawableCommandsRef.current = [];
    frozenLodTransitionRef.current = false;
    if (previewFrameRef.current !== undefined) cancelAnimationFrame(previewFrameRef.current);
    if (viewportFrameRef.current !== undefined) cancelAnimationFrame(viewportFrameRef.current);
    if (imageFlushFrameRef.current !== undefined) cancelAnimationFrame(imageFlushFrameRef.current);
    if (imageFlushTimerRef.current !== undefined) window.clearTimeout(imageFlushTimerRef.current);
    if (resourceSyncFrameRef.current !== undefined) cancelAnimationFrame(resourceSyncFrameRef.current);
    if (resourceSyncTimerRef.current !== undefined) window.clearTimeout(resourceSyncTimerRef.current);
    resourceSyncChainActiveRef.current = false;
  }, []);

  const getStats = useCallback(() => {
    const rendererStats = rendererRef.current?.getStats() ?? {
      drawCalls: 0, instances: 0, gpuBytes: 0, textureUploads: 0, textureCount: 0,
      bindTextureCalls: 0, bufferDataCalls: 0, bufferSubDataCalls: 0,
      texImage2DCalls: 0, texSubImage2DCalls: 0, textureUploadMs: 0,
      renderedViewportX: 0, renderedViewportY: 0, renderedViewportScale: 0,
    };
    const sortedFrames = [...frameTimesRef.current].sort((left, right) => left - right);
    const uniqueImages = new Set(imagesRef.current.values());
    const cpuBytes = [...uniqueImages].reduce((total, image) => total + image.naturalWidth * image.naturalHeight * 4, 0);
    const viewportScale = Math.max(0.00001, liveViewportRef.current.scale);
    const viewportLeft = -liveViewportRef.current.x / viewportScale;
    const viewportTop = -liveViewportRef.current.y / viewportScale;
    const viewportRight = (size.width - liveViewportRef.current.x) / viewportScale;
    const viewportBottom = (size.height - liveViewportRef.current.y) / viewportScale;
    const pixelRatio = window.devicePixelRatio || 1;
    let minimumLodCoverage = Number.POSITIVE_INFINITY;
    let minimumLodCommandId = '';
    let minimumLodResidentSize = '';
    const drawableCommands = lastDrawableCommandsRef.current;
    const tiledImageIds = new Set<string>();
    for (const command of drawableCommands) {
      const marker = command.id.indexOf(':tile:');
      if (marker > 0 && rendererRef.current?.isImageResident?.(command.id)) tiledImageIds.add(command.id.slice(0, marker));
    }
    for (const command of drawableCommands) {
      const radians = command.rotation * Math.PI / 180;
      const rotatedWidth = Math.abs(command.width * Math.cos(radians)) + Math.abs(command.height * Math.sin(radians));
      const rotatedHeight = Math.abs(command.width * Math.sin(radians)) + Math.abs(command.height * Math.cos(radians));
      const centerX = command.x + command.width / 2;
      const centerY = command.y + command.height / 2;
      if (centerX - rotatedWidth / 2 > viewportRight || centerX + rotatedWidth / 2 < viewportLeft
        || centerY - rotatedHeight / 2 > viewportBottom || centerY + rotatedHeight / 2 < viewportTop) continue;
      if (command.id.endsWith(':preview') && command.imageId && tiledImageIds.has(command.imageId)) continue;
      const residentSize = rendererRef.current?.getResidentImageSize?.(command.id);
      if (!residentSize || command.width <= 0 || command.height <= 0) continue;
      const coverageX = command.sourceRect.width * residentSize.width / Math.max(1, command.naturalWidth)
        / (command.width * viewportScale * pixelRatio);
      const coverageY = command.sourceRect.height * residentSize.height / Math.max(1, command.naturalHeight)
        / (command.height * viewportScale * pixelRatio);
      const coverage = Math.min(coverageX, coverageY);
      if (coverage < minimumLodCoverage) {
        minimumLodCoverage = coverage;
        minimumLodCommandId = command.id;
        minimumLodResidentSize = `${residentSize.width}x${residentSize.height}`;
      }
    }
    const uploadsDuringGesture = interactionActive
      ? Math.max(0, rendererStats.textureUploads - interactionUploadStartRef.current) : 0;
    const prewarmResidentCount = prewarmCommandIdsRef.current.reduce(
      (total, id) => total + (rendererRef.current?.isImageResident?.(id) ? 1 : 0), 0,
    );
    return {
      ...rendererStats,
      cpuBytes,
      frameP95Ms: percentileSorted(sortedFrames, 0.95),
      frameP99Ms: percentileSorted(sortedFrames, 0.99),
      minimumLodCoverage: Number.isFinite(minimumLodCoverage) ? minimumLodCoverage : 0,
      minimumLodCommandId,
      minimumLodResidentSize,
      minimumLodPlan: minimumLodCommandId ? commandsRef.current
        .filter((command) => (command.imageId ?? command.id) === minimumLodCommandId.split(':preview')[0])
        .map((command) => command.id).join('|') : '',
      minimumLodResidency: minimumLodCommandId ? commandsRef.current
        .filter((command) => (command.imageId ?? command.id) === minimumLodCommandId.split(':preview')[0])
        .map((command) => `${command.id}=${rendererRef.current?.isImageResident?.(command.id) ? 1 : 0}`).join('|') : '',
      minimumLodLoaded: minimumLodCommandId ? commandsRef.current
        .filter((command) => (command.imageId ?? command.id) === minimumLodCommandId.split(':preview')[0])
        .map((command) => `${command.id}=${imagesRef.current.has(command.id) ? 1 : 0}`).join('|') : '',
      uploadsDuringGesture,
      prewarmCommandCount: prewarmCommandIdsRef.current.length,
      prewarmResidentCount,
      pendingResourceCount: lastSyncResultRef.current.pendingIds.length,
      blockedResourceCount: lastSyncResultRef.current.blockedIds.length,
      resourceRetryCount: resourceRetryCountRef.current,
      gestureUniformUpdates: rendererStats.gestureUniformUpdates ?? 0,
      fullInstanceUploads: rendererStats.fullInstanceUploads ?? 0,
      longTasks: longTasksRef.current,
    };
  }, [interactionActive, size.height, size.width]);

  const previewResourcesReady = useMemo(() => commands.every((command) => (
    !command.id.endsWith(':preview')
    || imagesRef.current.has(command.id)
    || pendingImagesRef.current.has(command.id)
  )), [commands, imageEpoch]);

  return {
    setPixelImage,
    setUploadPause,
    schedulePreviewRender,
    scheduleViewportRender,
    settleViewportForPointerGesture,
    getStats,
    previewResourcesReady,
    loadedCommandCount: imagesRef.current.size,
    loadedTileCommandCount: [...imagesRef.current.keys()].filter((id) => id.includes(':tile:')).length,
  };
}
