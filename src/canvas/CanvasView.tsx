import { useEffect, useRef } from 'react';
import type { AnnotationItem, AnnotationTool, ImageItem, PickedColor, Scene, Viewport } from '../types';
import { CanvasRuntime } from './runtime/CanvasRuntime';

interface CanvasViewProps {
  background: string;
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
  projectEpoch: number;
  annotationMode: boolean;
  annotationTool: AnnotationTool;
  annotationColor: string;
  annotationWidth: number;
  colorPickerHeld: boolean;
  onColorPicked(color: PickedColor): void;
  onAddAnnotation(annotation: AnnotationItem): void;
  onEraseStart(): void;
  onEraseAt(x: number, y: number, radius: number): void;
  onEraseEnd(): void;
  onFocusItem(item: ImageItem): void;
  onContextMenu(position: { x: number; y: number }): void;
  windowLocked: boolean;
  onWindowMoveStart(): void;
  onWindowMove(): void;
  onWindowMoveEnd(): void;
}

export function CanvasView({
  background, scene, viewport, selectedIds, selectedAnnotationIds, selectedGroupId, projectEpoch,
  onViewportCommit, onSelectionChange, onAnnotationSelectionChange, onGroupSelectionChange,
  onItemsChanged, onAnnotationsChanged, onGroupMoved,
  annotationMode, annotationTool, annotationColor, annotationWidth, colorPickerHeld,
  onColorPicked, onAddAnnotation, onEraseStart, onEraseAt, onEraseEnd, onFocusItem, onContextMenu,
  windowLocked, onWindowMoveStart, onWindowMove, onWindowMoveEnd,
}: CanvasViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<CanvasRuntime | undefined>(undefined);
  const initialOptionsRef = useRef({
    background, viewport, selectedIds, selectedAnnotationIds, selectedGroupId, colorPickerHeld,
    annotationState: { enabled: annotationMode, tool: annotationTool, color: annotationColor, width: annotationWidth },
    windowLocked,
  });
  const viewportCommitRef = useRef(onViewportCommit);
  const selectionChangeRef = useRef(onSelectionChange);
  const itemsChangedRef = useRef(onItemsChanged);
  const annotationSelectionRef = useRef(onAnnotationSelectionChange);
  const groupSelectionRef = useRef(onGroupSelectionChange);
  const annotationsChangedRef = useRef(onAnnotationsChanged);
  const groupMovedRef = useRef(onGroupMoved);
  const colorPickedRef = useRef(onColorPicked); const addAnnotationRef = useRef(onAddAnnotation);
  const eraseStartRef = useRef(onEraseStart); const eraseAtRef = useRef(onEraseAt); const eraseEndRef = useRef(onEraseEnd);
  const focusItemRef = useRef(onFocusItem); const contextMenuRef = useRef(onContextMenu);
  const windowMoveStartRef = useRef(onWindowMoveStart); const windowMoveRef = useRef(onWindowMove); const windowMoveEndRef = useRef(onWindowMoveEnd);
  viewportCommitRef.current = onViewportCommit;
  selectionChangeRef.current = onSelectionChange;
  itemsChangedRef.current = onItemsChanged;
  annotationSelectionRef.current = onAnnotationSelectionChange;
  groupSelectionRef.current = onGroupSelectionChange;
  annotationsChangedRef.current = onAnnotationsChanged;
  groupMovedRef.current = onGroupMoved;
  colorPickedRef.current = onColorPicked; addAnnotationRef.current = onAddAnnotation;
  eraseStartRef.current = onEraseStart; eraseAtRef.current = onEraseAt; eraseEndRef.current = onEraseEnd;
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
      onColorPicked: (color) => colorPickedRef.current(color), onAddAnnotation: (annotation) => addAnnotationRef.current(annotation),
      onEraseStart: () => eraseStartRef.current(), onEraseAt: (x, y, radius) => eraseAtRef.current(x, y, radius),
      onEraseEnd: () => eraseEndRef.current(), onFocusItem: (item) => focusItemRef.current(item),
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
  useEffect(() => { runtimeRef.current?.setProjectEpoch(projectEpoch); }, [projectEpoch]);
  useEffect(() => { runtimeRef.current?.setAnnotationState({ enabled: annotationMode, tool: annotationTool, color: annotationColor, width: annotationWidth }); }, [annotationColor, annotationMode, annotationTool, annotationWidth]);
  useEffect(() => { runtimeRef.current?.setColorPickerHeld(colorPickerHeld); }, [colorPickerHeld]);
  useEffect(() => { runtimeRef.current?.setWindowLocked(windowLocked); }, [windowLocked]);
  useEffect(() => { runtimeRef.current?.setBackground(background); }, [background]);
  return <div ref={containerRef} className="canvas-runtime-root" data-canvas-runtime="pixi-v8" />;
}
