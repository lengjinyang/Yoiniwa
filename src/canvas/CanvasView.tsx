import { useEffect, useRef } from 'react';
import type { AnnotationItem, AnnotationTool, ImageItem, PickedColor, Scene, Viewport } from '../types';
import { CanvasRuntime } from './runtime/CanvasRuntime';
import type { EraserSample } from './interaction/AnnotationToolController';
import type { GroupFrameBounds } from './selection/GroupResizeController';

interface CanvasViewProps {
  background: string;
  backgroundOpacity: number;
  scene: Scene;
  viewport: Viewport;
  onViewportCommit?(viewport: Viewport): void;
  selectedIds: string[];
  selectedAnnotationIds: string[];
  selectedGroupId?: string;
  onSelectionChange(ids: string[]): void;
  onAnnotationSelectionChange(ids: string[]): void;
  onGroupSelectionChange(id?: string): void;
  onItemsChanged(changes: Array<Partial<ImageItem> & { id: string }>): void;
  onAnnotationsChanged(changes: Array<{ id: string; deltaX: number; deltaY: number }>): void;
  onGroupMoved(id: string, deltaX: number, deltaY: number): void;
  onGroupResized(id: string, bounds: GroupFrameBounds): void;
  onRenameGroup(id: string): void;
  onOpenGroupMenu(id: string, position: { x: number; y: number }): void;
  onExpandGroup(id: string): void;
  groupMenuOpen: boolean;
  onGroupPreviewAnchor(id: string, position: { x: number; y: number }): void;
  projectEpoch: number;
  annotationMode: boolean;
  annotationTool: AnnotationTool;
  annotationColor: string;
  annotationOpacity: number;
  annotationWidth: number;
  colorPickerHeld: boolean;
  onColorPicked(color: PickedColor): void;
  onAddAnnotation(annotation: AnnotationItem): void;
  onErase(samples: readonly EraserSample[]): void;
  onFocusItem(item: ImageItem): void;
  onContextMenu(position: { x: number; y: number }): void;
  windowLocked: boolean;
  onWindowMoveStart(): void;
  onWindowMove(): void;
  onWindowMoveEnd(): void;
}

export function CanvasView({
  background, backgroundOpacity, scene, viewport, selectedIds, selectedAnnotationIds, selectedGroupId, projectEpoch,
  onViewportCommit, onSelectionChange, onAnnotationSelectionChange, onGroupSelectionChange,
  onItemsChanged, onAnnotationsChanged, onGroupMoved, onGroupResized,
  onRenameGroup,
  onOpenGroupMenu, onExpandGroup, groupMenuOpen, onGroupPreviewAnchor,
  annotationMode, annotationTool, annotationColor, annotationOpacity, annotationWidth, colorPickerHeld,
  onColorPicked, onAddAnnotation, onErase, onFocusItem, onContextMenu,
  windowLocked, onWindowMoveStart, onWindowMove, onWindowMoveEnd,
}: CanvasViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<CanvasRuntime | undefined>(undefined);
  const initialOptionsRef = useRef({
    background, backgroundOpacity, viewport, selectedIds, selectedAnnotationIds, selectedGroupId, colorPickerHeld,
    annotationState: { enabled: annotationMode, tool: annotationTool, color: annotationColor, opacity: annotationOpacity, width: annotationWidth },
    windowLocked,
  });
  const viewportCommitRef = useRef(onViewportCommit);
  const selectionChangeRef = useRef(onSelectionChange);
  const itemsChangedRef = useRef(onItemsChanged);
  const annotationSelectionRef = useRef(onAnnotationSelectionChange);
  const groupSelectionRef = useRef(onGroupSelectionChange);
  const annotationsChangedRef = useRef(onAnnotationsChanged);
  const groupMovedRef = useRef(onGroupMoved);
  const groupResizedRef = useRef(onGroupResized);
  const renameGroupRef = useRef(onRenameGroup);
  const openGroupMenuRef = useRef(onOpenGroupMenu);
  const expandGroupRef = useRef(onExpandGroup);
  const groupPreviewAnchorRef = useRef(onGroupPreviewAnchor);
  const colorPickedRef = useRef(onColorPicked); const addAnnotationRef = useRef(onAddAnnotation);
  const eraseRef = useRef(onErase);
  const focusItemRef = useRef(onFocusItem); const contextMenuRef = useRef(onContextMenu);
  const windowMoveStartRef = useRef(onWindowMoveStart); const windowMoveRef = useRef(onWindowMove); const windowMoveEndRef = useRef(onWindowMoveEnd);
  viewportCommitRef.current = onViewportCommit;
  selectionChangeRef.current = onSelectionChange;
  itemsChangedRef.current = onItemsChanged;
  annotationSelectionRef.current = onAnnotationSelectionChange;
  groupSelectionRef.current = onGroupSelectionChange;
  annotationsChangedRef.current = onAnnotationsChanged;
  groupMovedRef.current = onGroupMoved;
  groupResizedRef.current = onGroupResized;
  renameGroupRef.current = onRenameGroup;
  openGroupMenuRef.current = onOpenGroupMenu;
  expandGroupRef.current = onExpandGroup;
  groupPreviewAnchorRef.current = onGroupPreviewAnchor;
  colorPickedRef.current = onColorPicked; addAnnotationRef.current = onAddAnnotation;
  eraseRef.current = onErase;
  focusItemRef.current = onFocusItem; contextMenuRef.current = onContextMenu;
  windowMoveStartRef.current = onWindowMoveStart; windowMoveRef.current = onWindowMove; windowMoveEndRef.current = onWindowMoveEnd;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const runtime = new CanvasRuntime(container, {
      ...initialOptionsRef.current,
      onViewportCommit: (nextViewport) => viewportCommitRef.current?.(nextViewport),
      onSelectionChange: (ids) => selectionChangeRef.current(ids),
      onAnnotationSelectionChange: (ids) => annotationSelectionRef.current(ids),
      onGroupSelectionChange: (id) => groupSelectionRef.current(id),
      onItemsChanged: (changes) => itemsChangedRef.current(changes),
      onAnnotationsChanged: (changes) => annotationsChangedRef.current(changes),
      onGroupMoved: (id, deltaX, deltaY) => groupMovedRef.current(id, deltaX, deltaY),
      onGroupResized: (id, bounds) => groupResizedRef.current(id, bounds),
      onRenameGroup: (id) => renameGroupRef.current(id),
      onOpenGroupMenu: (id, position) => openGroupMenuRef.current(id, position),
      onExpandGroup: (id) => expandGroupRef.current(id),
      onGroupPreviewAnchor: (id, position) => groupPreviewAnchorRef.current(id, position),
      onColorPicked: (color) => colorPickedRef.current(color), onAddAnnotation: (annotation) => addAnnotationRef.current(annotation),
      onErase: (samples) => eraseRef.current(samples), onFocusItem: (item) => focusItemRef.current(item),
      onContextMenu: (position) => contextMenuRef.current(position),
      onWindowMoveStart: () => windowMoveStartRef.current(), onWindowMove: () => windowMoveRef.current(),
      onWindowMoveEnd: () => windowMoveEndRef.current(),
    });
    runtimeRef.current = runtime;
    void runtime.start().catch((error: unknown) => {
      console.error('Failed to start Pixi canvas runtime', error);
    });
    return () => {
      runtimeRef.current = undefined;
      runtime.destroy();
    };
  }, []); // Runtime owns high-frequency state for its complete mounted lifetime.

  useEffect(() => { runtimeRef.current?.setViewport(viewport); }, [viewport]);
  useEffect(() => { runtimeRef.current?.setScene(scene); }, [scene]);
  useEffect(() => { runtimeRef.current?.setSelection(selectedIds); }, [selectedIds]);
  useEffect(() => { runtimeRef.current?.setAnnotationSelection(selectedAnnotationIds); }, [selectedAnnotationIds]);
  useEffect(() => { runtimeRef.current?.setGroupSelection(selectedGroupId); }, [selectedGroupId]);
  useEffect(() => { runtimeRef.current?.setGroupMenuOpen(groupMenuOpen); }, [groupMenuOpen]);
  useEffect(() => { runtimeRef.current?.setProjectEpoch(projectEpoch); }, [projectEpoch]);
  useEffect(() => { runtimeRef.current?.setAnnotationState({ enabled: annotationMode, tool: annotationTool, color: annotationColor, opacity: annotationOpacity, width: annotationWidth }); }, [annotationColor, annotationMode, annotationOpacity, annotationTool, annotationWidth]);
  useEffect(() => { runtimeRef.current?.setColorPickerHeld(colorPickerHeld); }, [colorPickerHeld]);
  useEffect(() => { runtimeRef.current?.setWindowLocked(windowLocked); }, [windowLocked]);
  useEffect(() => { runtimeRef.current?.setBackground(background, backgroundOpacity); }, [background, backgroundOpacity]);
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
  return <div ref={containerRef} className="canvas-runtime-root" data-canvas-runtime="pixi-v8" />;
}
