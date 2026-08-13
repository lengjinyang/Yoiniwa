import { useEffect, useMemo, useRef, useState } from 'react';
import type { ImageItem, PickedColor, Scene, Viewport } from '../types';
import { CanvasRuntime } from './runtime/CanvasRuntime';
import type { GroupFrameBounds } from './selection/GroupResizeController';
import type { VisualNotesToolState } from './interaction/VisualNotesController';
import type { VisualNotesState } from '../types';
import type { ColorPickerShortcut } from '../interactions';
import type { LassoPoint } from './selection/SelectionController';
import { isVideoItem } from '../media';
import { isVideoProxyPending, rememberVideoProxy, rememberVideoTiming } from '../videoUrl';
import { invalidateVideoScrubIndex } from '../videoScrub';
import { VideoTransportBar } from '../app/components/VideoTransportBar';
import type { VideoTransportState } from './renderer/VideoRenderer';

interface CanvasVisualNotesProps {
  state: VisualNotesToolState;
  temporaryHidden: boolean;
  onChanged(notes: VisualNotesState): void;
  onSelectionChange(id?: string): void;
}

interface CanvasSceneProps {
  background: string;
  backgroundOpacity: number;
  scene: Scene;
  viewport: Viewport;
  onViewportCommit?(viewport: Viewport): void;
  projectEpoch: number;
}

interface CanvasSelectionProps {
  selectedIds: string[];
  selectedGroupId?: string;
  lassoClearRequest: number;
  onSelectionChange(ids: string[], source?: 'lasso'): void;
  onLassoSelectionChange(points?: LassoPoint[]): void;
  onGroupSelectionChange(id?: string): void;
  onItemsChanged(changes: Array<Partial<ImageItem> & { id: string }>, snap?: boolean): void;
  onFocusItem(item: ImageItem): void;
}

interface CanvasGroupsProps {
  onGroupMoved(id: string, deltaX: number, deltaY: number): void;
  onGroupResized(id: string, bounds: GroupFrameBounds): void;
  onRenameGroup(id: string): void;
  onOpenGroupMenu(id: string, position: { x: number; y: number }): void;
  onExpandGroup(id: string): void;
  groupMenuOpen: boolean;
  onGroupPreviewAnchor(id: string, position: { x: number; y: number }): void;
}

interface CanvasColorPickerProps {
  colorPickerHeld: boolean;
  colorPickerShortcut: ColorPickerShortcut;
  onColorPicked(color: PickedColor): void;
}

interface CanvasWindowInteractionProps {
  drawingCollaborationMode: boolean;
  onContextMenu(position: { x: number; y: number }): void;
  onExternalImageDrag?(items: ImageItem[]): (() => void) | undefined;
  windowLocked: boolean;
  onWindowMoveStart(): void;
  onWindowMove(): void;
  onWindowMoveEnd(): void;
}

interface CanvasViewProps {
  canvas: CanvasSceneProps;
  selection: CanvasSelectionProps;
  groups: CanvasGroupsProps;
  colorPicker: CanvasColorPickerProps;
  windowInteraction: CanvasWindowInteractionProps;
  visualNotes: CanvasVisualNotesProps;
  videoScrubPixelsPerFrame?: number;
}

export function CanvasView({
  canvas,
  selection,
  groups,
  colorPicker,
  windowInteraction,
  visualNotes,
  videoScrubPixelsPerFrame,
}: CanvasViewProps) {
  const { background, backgroundOpacity, scene, viewport, projectEpoch, onViewportCommit } = canvas;
  const {
    selectedIds,
    selectedGroupId,
    lassoClearRequest,
    onSelectionChange,
    onLassoSelectionChange,
    onGroupSelectionChange,
    onItemsChanged,
    onFocusItem,
  } = selection;
  const {
    onGroupMoved,
    onGroupResized,
    onRenameGroup,
    onOpenGroupMenu,
    onExpandGroup,
    groupMenuOpen,
    onGroupPreviewAnchor,
  } = groups;
  const { colorPickerHeld, colorPickerShortcut, onColorPicked } = colorPicker;
  const {
    drawingCollaborationMode,
    onContextMenu,
    onExternalImageDrag,
    windowLocked,
    onWindowMoveStart,
    onWindowMove,
    onWindowMoveEnd,
  } = windowInteraction;
  const containerRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<CanvasRuntime | undefined>(undefined);
  const [startupError, setStartupError] = useState<string>();
  const [runtimeAttempt, setRuntimeAttempt] = useState(0);
  const [transport, setTransport] = useState<VideoTransportState>();
  const [preparing, setPreparing] = useState(false);
  const selectedVideo = useMemo(() => {
    if (selectedIds.length !== 1) return undefined;
    const item = scene.items.find((candidate) => candidate.id === selectedIds[0]);
    return item && isVideoItem(item, scene.assets) ? item : undefined;
  }, [scene.assets, scene.items, selectedIds]);
  const selectedVideoAssetId = selectedVideo?.assetId;
  const selectedVideoIdRef = useRef<string | undefined>(undefined);
  const selectedVideoAssetIdRef = useRef<string | undefined>(undefined);
  selectedVideoIdRef.current = selectedVideo?.id;
  selectedVideoAssetIdRef.current = selectedVideoAssetId;
  const initialOptionsRef = useRef({
    background, backgroundOpacity, viewport, selectedIds, selectedGroupId, colorPickerHeld, colorPickerShortcut,
    windowLocked, drawingCollaborationMode, visualNotesState: visualNotes.state,
  });
  const runtimeStateRef = useRef({
    background, backgroundOpacity, scene, viewport, selectedIds, selectedGroupId, groupMenuOpen, projectEpoch,
    colorPickerHeld, colorPickerShortcut, windowLocked, drawingCollaborationMode,
    visualNotesState: visualNotes.state, visualNotesTemporaryHidden: visualNotes.temporaryHidden,
  });
  const viewportCommitRef = useRef(onViewportCommit);
  const selectionChangeRef = useRef(onSelectionChange);
  const lassoSelectionChangeRef = useRef(onLassoSelectionChange);
  const itemsChangedRef = useRef(onItemsChanged);
  const groupSelectionRef = useRef(onGroupSelectionChange);
  const groupMovedRef = useRef(onGroupMoved);
  const groupResizedRef = useRef(onGroupResized);
  const renameGroupRef = useRef(onRenameGroup);
  const openGroupMenuRef = useRef(onOpenGroupMenu);
  const expandGroupRef = useRef(onExpandGroup);
  const groupPreviewAnchorRef = useRef(onGroupPreviewAnchor);
  const colorPickedRef = useRef(onColorPicked);
  const focusItemRef = useRef(onFocusItem); const contextMenuRef = useRef(onContextMenu);
  const externalImageDragRef = useRef(onExternalImageDrag);
  const windowMoveStartRef = useRef(onWindowMoveStart); const windowMoveRef = useRef(onWindowMove); const windowMoveEndRef = useRef(onWindowMoveEnd);
  const visualNotesChangedRef = useRef(visualNotes.onChanged);
  const visualNoteSelectionRef = useRef(visualNotes.onSelectionChange);
  const videoScrubPixelsRef = useRef(videoScrubPixelsPerFrame);
  videoScrubPixelsRef.current = videoScrubPixelsPerFrame;
  viewportCommitRef.current = onViewportCommit;
  selectionChangeRef.current = onSelectionChange;
  lassoSelectionChangeRef.current = onLassoSelectionChange;
  itemsChangedRef.current = onItemsChanged;
  groupSelectionRef.current = onGroupSelectionChange;
  groupMovedRef.current = onGroupMoved;
  groupResizedRef.current = onGroupResized;
  renameGroupRef.current = onRenameGroup;
  openGroupMenuRef.current = onOpenGroupMenu;
  expandGroupRef.current = onExpandGroup;
  groupPreviewAnchorRef.current = onGroupPreviewAnchor;
  colorPickedRef.current = onColorPicked;
  focusItemRef.current = onFocusItem; contextMenuRef.current = onContextMenu;
  externalImageDragRef.current = onExternalImageDrag;
  windowMoveStartRef.current = onWindowMoveStart; windowMoveRef.current = onWindowMove; windowMoveEndRef.current = onWindowMoveEnd;
  visualNotesChangedRef.current = visualNotes.onChanged;
  visualNoteSelectionRef.current = visualNotes.onSelectionChange;
  runtimeStateRef.current = {
    background, backgroundOpacity, scene, viewport, selectedIds, selectedGroupId, groupMenuOpen, projectEpoch,
    colorPickerHeld, colorPickerShortcut, windowLocked, drawingCollaborationMode,
    visualNotesState: visualNotes.state, visualNotesTemporaryHidden: visualNotes.temporaryHidden,
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    let active = true;
    const runtime = new CanvasRuntime(container, {
      ...initialOptionsRef.current,
      onViewportCommit: (nextViewport) => viewportCommitRef.current?.(nextViewport),
      onSelectionChange: (ids, source) => selectionChangeRef.current(ids, source),
      onLassoSelectionChange: (points) => lassoSelectionChangeRef.current(points),
      onGroupSelectionChange: (id) => groupSelectionRef.current(id),
      onItemsChanged: (changes, snap) => itemsChangedRef.current(changes, snap),
      onGroupMoved: (id, deltaX, deltaY) => groupMovedRef.current(id, deltaX, deltaY),
      onGroupResized: (id, bounds) => groupResizedRef.current(id, bounds),
      onRenameGroup: (id) => renameGroupRef.current(id),
      onOpenGroupMenu: (id, position) => openGroupMenuRef.current(id, position),
      onExpandGroup: (id) => expandGroupRef.current(id),
      onGroupPreviewAnchor: (id, position) => groupPreviewAnchorRef.current(id, position),
      onColorPicked: (color) => colorPickedRef.current(color), onFocusItem: (item) => focusItemRef.current(item),
      onContextMenu: (position) => contextMenuRef.current(position),
      onExternalImageDrag: (items) => externalImageDragRef.current?.(items),
      onWindowMoveStart: () => windowMoveStartRef.current(), onWindowMove: () => windowMoveRef.current(),
      onWindowMoveEnd: () => windowMoveEndRef.current(),
      onVisualNotesChanged: (notes) => visualNotesChangedRef.current(notes),
      onVisualNoteSelectionChange: (id) => visualNoteSelectionRef.current(id),
    });
    runtimeRef.current = runtime;
    setStartupError(undefined);
    void runtime.start().then(() => {
      if (!active) return;
      const state = runtimeStateRef.current;
      runtime.setViewport(state.viewport);
      runtime.setScene(state.scene);
      runtime.setSelection(state.selectedIds);
      runtime.setGroupSelection(state.selectedGroupId);
      runtime.setGroupMenuOpen(state.groupMenuOpen);
      runtime.setProjectEpoch(state.projectEpoch);
      runtime.setColorPickerHeld(state.colorPickerHeld);
      runtime.setColorPickerShortcut(state.colorPickerShortcut);
      runtime.setWindowLocked(state.windowLocked);
      runtime.setDrawingCollaborationMode(state.drawingCollaborationMode);
      runtime.setVisualNotesState(state.visualNotesState);
      runtime.setVisualNotesTemporaryHidden(state.visualNotesTemporaryHidden);
      runtime.setBackground(state.background, state.backgroundOpacity);
      if (videoScrubPixelsRef.current !== undefined) {
        runtime.setVideoScrubPixelsPerFrame(videoScrubPixelsRef.current);
      }
      runtime.onVideoTransportChange((next) => {
        if (!active || next.id !== selectedVideoIdRef.current) return;
        setTransport(next);
      });
      runtime.setSelectedVideo(selectedVideoIdRef.current);
    }).catch((error: unknown) => {
      console.error('Failed to start Pixi canvas runtime', error);
      if (active) setStartupError('画布渲染初始化失败，请检查显卡驱动或图形加速设置。');
    });
    return () => {
      active = false;
      runtime.onVideoTransportChange(undefined);
      runtimeRef.current = undefined;
      runtime.destroy();
    };
  }, [runtimeAttempt]); // Runtime owns high-frequency state for each mounted attempt.

  useEffect(() => {
    if (!selectedVideo) {
      setTransport(undefined);
      setPreparing(false);
      runtimeRef.current?.setSelectedVideo(undefined);
      return;
    }
    runtimeRef.current?.setSelectedVideo(selectedVideo.id);
    setTransport(runtimeRef.current?.getVideoTransport(selectedVideo.id));
    setPreparing(false);
    const assetId = selectedVideo.assetId;
    const api = window.refCanvas;
    if (assetId && api?.ensureVideoScrub) {
      // The original file is the normal scrub source. Indexing only adds exact
      // frame/PTS mapping; it never starts proxy generation or blocks playback.
      void api.ensureVideoScrub(assetId).then((result) => {
        rememberVideoTiming(assetId, result.fps || 30, result.frameCount ?? undefined);
        runtimeRef.current?.setVideoPreparation(
          assetId,
          result.indexReady ? 'ready' : result.state,
          result.indexReady ? 1 : 0,
        );
        if (selectedVideoIdRef.current === selectedVideo.id) {
          runtimeRef.current?.setSelectedVideo(selectedVideo.id);
        }
        if (result.unsupportedReason) {
          window.dispatchEvent(new CustomEvent('refcanvas-status', {
            detail: result.scrubReady
              ? result.unsupportedReason
              : `原片逐帧解码不可用：${result.unsupportedReason}`,
          }));
        }
        if (result.indexReady) runtimeRef.current?.refreshVideoScrubIndex(assetId);
      }).catch(() => { /* Original HTMLVideo playback remains available. */ });
    }
  }, [selectedVideo]);

  useEffect(() => {
    if (!selectedVideo) return undefined;
    const videoId = selectedVideo.id;
    let frame = 0;
    let running = true;
    const updatePosition = () => {
      if (!running) return;
      const rect = runtimeRef.current?.itemScreenRect(videoId);
      const shell = containerRef.current?.parentElement;
      const hud = hudRef.current;
      if (rect && shell && hud) {
        const shellWidth = shell.clientWidth;
        // Screen-space controls keep a stable size while canvas zoom only moves the anchor.
        const barWidth = Math.max(1, Math.min(520, shellWidth - 16));
        const centerX = rect.left + rect.width / 2;
        const clampedLeft = Math.min(
          shellWidth - barWidth / 2 - 8,
          Math.max(barWidth / 2 + 8, centerX),
        );
        const above = rect.top - 10;
        const top = above >= 48 ? above : rect.top + Math.min(rect.height, 56) + 8;
        hud.style.setProperty('--video-bar-left', `${clampedLeft}px`);
        hud.style.setProperty('--video-bar-top', `${top}px`);
        hud.style.setProperty('--video-bar-transform', above >= 48 ? 'translate(-50%, -100%)' : 'translate(-50%, 0)');
        hud.style.setProperty('--video-resolution-left', `${centerX}px`);
        hud.style.setProperty('--video-resolution-top', `${rect.top + rect.height + 8}px`);
      }
      frame = requestAnimationFrame(updatePosition);
    };
    frame = requestAnimationFrame(updatePosition);
    return () => {
      running = false;
      cancelAnimationFrame(frame);
    };
  }, [selectedVideo?.id]);

  useEffect(() => {
    const api = window.refCanvas;
    if (!api?.onVideoProxyReady) return undefined;
    const disposeReady = api.onVideoProxyReady(({ assetId, path, fps, frameCount }) => {
      rememberVideoProxy(assetId, path, fps || 30, frameCount);
      runtimeRef.current?.resumeVideoWhenProxyReady(assetId);
      runtimeRef.current?.setVideoPreparation(assetId, 'ready', 1);
      if (assetId === selectedVideoAssetIdRef.current) setPreparing(false);
      window.dispatchEvent(new CustomEvent('refcanvas-status', { detail: '视频可播放版本已就绪' }));
    });
    const disposeFailed = api.onVideoProxyFailed?.(({ assetId, message, indexReady, unsupportedReason }) => {
      invalidateVideoScrubIndex(assetId);
      runtimeRef.current?.failVideoProxy(assetId);
      runtimeRef.current?.setVideoPreparation(assetId, indexReady ? 'index-ready' : 'failed', indexReady ? 0.18 : 0);
      if (assetId === selectedVideoAssetIdRef.current) setPreparing(false);
      window.dispatchEvent(new CustomEvent('refcanvas-status', {
        detail: unsupportedReason
          ? `不支持无损 Scrub 保证：${unsupportedReason}；将使用原片准确回退`
          : `视频代理准备失败，将使用原片准确回退：${message}`,
      }));
    });
    const disposeProgress = api.onVideoPreparationProgress?.(({
      assetId, stage, fraction, fps, frameCount,
    }) => {
      if (stage === 'index-ready' || stage === 'ready') invalidateVideoScrubIndex(assetId);
      if ((stage === 'index-ready' || stage === 'ready') && fps) {
        rememberVideoTiming(assetId, fps, frameCount);
        runtimeRef.current?.refreshVideoScrubIndex(assetId);
      }
      runtimeRef.current?.setVideoPreparation(assetId, stage, fraction);
      if (assetId === selectedVideoAssetIdRef.current && stage === 'failed') setPreparing(false);
    });
    return () => {
      disposeReady();
      disposeFailed?.();
      disposeProgress?.();
    };
  }, []);

  useEffect(() => {
    const onPreparing = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; assetId?: string }>).detail;
      if (!selectedVideo) return;
      if (detail?.id === selectedVideo.id || detail?.assetId === selectedVideo.assetId) setPreparing(true);
    };
    window.addEventListener('refcanvas-video-preparing', onPreparing);
    return () => window.removeEventListener('refcanvas-video-preparing', onPreparing);
  }, [selectedVideo]);

  useEffect(() => { runtimeRef.current?.setViewport(viewport); }, [viewport]);
  useEffect(() => { runtimeRef.current?.setScene(scene); }, [scene]);
  useEffect(() => { runtimeRef.current?.setSelection(selectedIds); }, [selectedIds]);
  useEffect(() => { runtimeRef.current?.clearLasso(); }, [lassoClearRequest]);
  useEffect(() => { runtimeRef.current?.setGroupSelection(selectedGroupId); }, [selectedGroupId]);
  useEffect(() => { runtimeRef.current?.setGroupMenuOpen(groupMenuOpen); }, [groupMenuOpen]);
  useEffect(() => { runtimeRef.current?.setProjectEpoch(projectEpoch); }, [projectEpoch]);
  useEffect(() => { runtimeRef.current?.setColorPickerHeld(colorPickerHeld); }, [colorPickerHeld]);
  useEffect(() => { runtimeRef.current?.setColorPickerShortcut(colorPickerShortcut); }, [colorPickerShortcut]);
  useEffect(() => { runtimeRef.current?.setWindowLocked(windowLocked); }, [windowLocked]);
  useEffect(() => { runtimeRef.current?.setDrawingCollaborationMode(drawingCollaborationMode); }, [drawingCollaborationMode]);
  useEffect(() => { runtimeRef.current?.setVisualNotesState(visualNotes.state); }, [visualNotes.state]);
  useEffect(() => { runtimeRef.current?.setVisualNotesTemporaryHidden(visualNotes.temporaryHidden); }, [visualNotes.temporaryHidden]);
  useEffect(() => { runtimeRef.current?.setBackground(background, backgroundOpacity); }, [background, backgroundOpacity]);
  useEffect(() => {
    if (videoScrubPixelsPerFrame !== undefined) {
      runtimeRef.current?.setVideoScrubPixelsPerFrame(videoScrubPixelsPerFrame);
    }
  }, [videoScrubPixelsPerFrame]);
  useEffect(() => {
    const api = window.refCanvas;
    if (!api) return undefined;
    let pointerActive = false;
    const pointerId = 0x594f;
    return api.onNativePointer((input) => {
      const container = containerRef.current;
      if (!container) return;
      const hit = document.elementFromPoint(input.clientX, input.clientY);
      if (hit && hudRef.current?.contains(hit)) return;
      if (input.kind === 'wheel' || input.kind === 'hwheel') {
        container.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: true, clientX: input.clientX, clientY: input.clientY,
          deltaX: input.kind === 'hwheel' ? -input.delta : 0,
          deltaY: input.kind === 'wheel' ? -input.delta : 0,
          altKey: input.altKey,
        }));
        return;
      }
      const eventName = input.kind === 'down' ? 'pointerdown'
        : input.kind === 'up' ? 'pointerup'
          : input.kind === 'cancel' ? 'pointercancel' : 'pointermove';
      if (input.kind === 'down') pointerActive = true;
      const pressed = pointerActive && input.kind !== 'up' && input.kind !== 'cancel';
      const pointerEvent = new PointerEvent(eventName, {
        bubbles: true, cancelable: true, pointerId, pointerType: input.pointerType,
        isPrimary: true, button: input.kind === 'down' || input.kind === 'up' ? 0 : -1,
        buttons: pressed ? 1 : 0, pressure: pressed ? 0.5 : 0,
        clientX: input.clientX, clientY: input.clientY, altKey: input.altKey,
      });
      Object.defineProperty(pointerEvent, 'spaceKey', { value: input.spaceKey, enumerable: false });
      if (input.visibleBounds) {
        Object.defineProperty(pointerEvent, 'visibleBounds', { value: input.visibleBounds, enumerable: false });
      }
      container.dispatchEvent(pointerEvent);
      if (input.kind === 'up' || input.kind === 'cancel') pointerActive = false;
    });
  }, []);
  useEffect(() => {
    const setBenchmarkViewport = (event: Event) => {
      const next = (event as CustomEvent<Viewport>).detail;
      if (!next || !Number.isFinite(next.x) || !Number.isFinite(next.y) || !Number.isFinite(next.scale)) return;
      runtimeRef.current?.setViewport(next);
      viewportCommitRef.current?.(next);
    };
    window.addEventListener('refcanvas-stress-viewport', setBenchmarkViewport);
    return () => window.removeEventListener('refcanvas-stress-viewport', setBenchmarkViewport);
  }, []);

  const videoId = selectedVideo?.id;
  return <div className="canvas-shell">
    <div ref={containerRef} className="canvas-runtime-root" data-canvas-runtime="pixi-v8">
      {startupError && <div className="canvas-startup-error" role="alert">
        <p>{startupError}</p>
        <button type="button" onClick={() => setRuntimeAttempt((attempt) => attempt + 1)}>重试</button>
      </div>}
    </div>
    {videoId && selectedVideo && <div ref={hudRef} className="canvas-video-hud">
      <VideoTransportBar
        key={videoId}
        visible={!drawingCollaborationMode && !windowLocked}
        itemId={videoId}
        locked={Boolean(selectedVideo.locked)}
        resolutionLabel={`${Math.round(selectedVideo.naturalWidth)} × ${Math.round(selectedVideo.naturalHeight)}`}
        transport={transport?.id === videoId ? transport : undefined}
        preparing={preparing}
        pixelsPerFrame={videoScrubPixelsPerFrame}
        onPlayPause={() => {
          const toggled = runtimeRef.current?.toggleVideoPlayback(videoId);
          if (toggled && selectedVideo.assetId) {
            setPreparing(isVideoProxyPending(selectedVideo.assetId));
          }
        }}
        onScrubStart={() => {
          runtimeRef.current?.beginVideoScrub(videoId);
          const assetId = selectedVideo.assetId;
          const api = window.refCanvas;
          if (assetId && api?.ensureVideoScrub) {
            void api.ensureVideoScrub(assetId).then((result) => {
              rememberVideoTiming(assetId, result.fps || 30, result.frameCount ?? undefined);
              if (result.indexReady) runtimeRef.current?.refreshVideoScrubIndex(assetId);
            }).catch(() => {});
          }
        }}
        onScrubEnd={() => { runtimeRef.current?.endVideoScrub(videoId); }}
        onSeekFrame={(frameIndex, sequential, final) => {
          runtimeRef.current?.seekVideoFrame(videoId, frameIndex, sequential, final);
        }}
        onStep={(frames) => {
          runtimeRef.current?.pauseVideo(videoId);
          runtimeRef.current?.stepVideoFrames(videoId, frames);
        }}
        onToggleMute={() => {
          const currentMuted = runtimeRef.current?.getVideoTransport(videoId)?.muted
            ?? (selectedVideo.muted !== false);
          const muted = !currentMuted;
          runtimeRef.current?.setVideoMuted(videoId, muted);
          onItemsChanged([{ id: videoId, muted }]);
        }}
        onRateChange={(rate) => { runtimeRef.current?.setVideoRate(videoId, rate); }}
        onToggleLock={() => { onItemsChanged([{ id: videoId, locked: !selectedVideo.locked }]); }}
      />
    </div>}
  </div>;
}
