import { useEffect, useRef } from 'react';
import type { ImageItem, PickedColor, Scene, Viewport } from '../types';
import { CanvasRuntime } from './runtime/CanvasRuntime';
import type { GroupFrameBounds } from './selection/GroupResizeController';
import type { VisualNotesToolState } from './interaction/VisualNotesController';
import type { VisualNotesState } from '../types';
import type { ColorPickerShortcut } from '../interactions';

interface CanvasViewProps {
  background: string;
  backgroundOpacity: number;
  scene: Scene;
  viewport: Viewport;
  onViewportCommit?(viewport: Viewport): void;
  selectedIds: string[];
  selectedGroupId?: string;
  onSelectionChange(ids: string[]): void;
  onGroupSelectionChange(id?: string): void;
  onItemsChanged(changes: Array<Partial<ImageItem> & { id: string }>): void;
  onGroupMoved(id: string, deltaX: number, deltaY: number): void;
  onGroupResized(id: string, bounds: GroupFrameBounds): void;
  onRenameGroup(id: string): void;
  onOpenGroupMenu(id: string, position: { x: number; y: number }): void;
  onExpandGroup(id: string): void;
  groupMenuOpen: boolean;
  onGroupPreviewAnchor(id: string, position: { x: number; y: number }): void;
  projectEpoch: number;
  colorPickerHeld: boolean;
  colorPickerShortcut: ColorPickerShortcut;
  drawingCollaborationMode: boolean;
  onColorPicked(color: PickedColor): void;
  onFocusItem(item: ImageItem): void;
  onContextMenu(position: { x: number; y: number }): void;
  windowLocked: boolean;
  onWindowMoveStart(): void;
  onWindowMove(): void;
  onWindowMoveEnd(): void;
  visualNotesState: VisualNotesToolState;
  visualNotesTemporaryHidden: boolean;
  onVisualNotesChanged(notes: VisualNotesState): void;
  onVisualNoteSelectionChange(id?: string): void;
}

export function CanvasView({
  background, backgroundOpacity, scene, viewport, selectedIds, selectedGroupId, projectEpoch,
  onViewportCommit, onSelectionChange, onGroupSelectionChange,
  onItemsChanged, onGroupMoved, onGroupResized,
  onRenameGroup,
  onOpenGroupMenu, onExpandGroup, groupMenuOpen, onGroupPreviewAnchor,
  colorPickerHeld, colorPickerShortcut, onColorPicked, onFocusItem, onContextMenu,
  windowLocked, onWindowMoveStart, onWindowMove, onWindowMoveEnd,
  drawingCollaborationMode,
  visualNotesState, visualNotesTemporaryHidden, onVisualNotesChanged, onVisualNoteSelectionChange,
}: CanvasViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<CanvasRuntime | undefined>(undefined);
  const initialOptionsRef = useRef({
    background, backgroundOpacity, viewport, selectedIds, selectedGroupId, colorPickerHeld, colorPickerShortcut,
    windowLocked, drawingCollaborationMode, visualNotesState,
  });
  const viewportCommitRef = useRef(onViewportCommit);
  const selectionChangeRef = useRef(onSelectionChange);
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
  const windowMoveStartRef = useRef(onWindowMoveStart); const windowMoveRef = useRef(onWindowMove); const windowMoveEndRef = useRef(onWindowMoveEnd);
  const visualNotesChangedRef = useRef(onVisualNotesChanged);
  const visualNoteSelectionRef = useRef(onVisualNoteSelectionChange);
  viewportCommitRef.current = onViewportCommit;
  selectionChangeRef.current = onSelectionChange;
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
  windowMoveStartRef.current = onWindowMoveStart; windowMoveRef.current = onWindowMove; windowMoveEndRef.current = onWindowMoveEnd;
  visualNotesChangedRef.current = onVisualNotesChanged;
  visualNoteSelectionRef.current = onVisualNoteSelectionChange;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const runtime = new CanvasRuntime(container, {
      ...initialOptionsRef.current,
      onViewportCommit: (nextViewport) => viewportCommitRef.current?.(nextViewport),
      onSelectionChange: (ids) => selectionChangeRef.current(ids),
      onGroupSelectionChange: (id) => groupSelectionRef.current(id),
      onItemsChanged: (changes) => itemsChangedRef.current(changes),
      onGroupMoved: (id, deltaX, deltaY) => groupMovedRef.current(id, deltaX, deltaY),
      onGroupResized: (id, bounds) => groupResizedRef.current(id, bounds),
      onRenameGroup: (id) => renameGroupRef.current(id),
      onOpenGroupMenu: (id, position) => openGroupMenuRef.current(id, position),
      onExpandGroup: (id) => expandGroupRef.current(id),
      onGroupPreviewAnchor: (id, position) => groupPreviewAnchorRef.current(id, position),
      onColorPicked: (color) => colorPickedRef.current(color), onFocusItem: (item) => focusItemRef.current(item),
      onContextMenu: (position) => contextMenuRef.current(position),
      onWindowMoveStart: () => windowMoveStartRef.current(), onWindowMove: () => windowMoveRef.current(),
      onWindowMoveEnd: () => windowMoveEndRef.current(),
      onVisualNotesChanged: (notes) => visualNotesChangedRef.current(notes),
      onVisualNoteSelectionChange: (id) => visualNoteSelectionRef.current(id),
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
  useEffect(() => { runtimeRef.current?.setGroupSelection(selectedGroupId); }, [selectedGroupId]);
  useEffect(() => { runtimeRef.current?.setGroupMenuOpen(groupMenuOpen); }, [groupMenuOpen]);
  useEffect(() => { runtimeRef.current?.setProjectEpoch(projectEpoch); }, [projectEpoch]);
  useEffect(() => { runtimeRef.current?.setColorPickerHeld(colorPickerHeld); }, [colorPickerHeld]);
  useEffect(() => { runtimeRef.current?.setColorPickerShortcut(colorPickerShortcut); }, [colorPickerShortcut]);
  useEffect(() => { runtimeRef.current?.setWindowLocked(windowLocked); }, [windowLocked]);
  useEffect(() => { runtimeRef.current?.setDrawingCollaborationMode(drawingCollaborationMode); }, [drawingCollaborationMode]);
  useEffect(() => { runtimeRef.current?.setVisualNotesState(visualNotesState); }, [visualNotesState]);
  useEffect(() => { runtimeRef.current?.setVisualNotesTemporaryHidden(visualNotesTemporaryHidden); }, [visualNotesTemporaryHidden]);
  useEffect(() => { runtimeRef.current?.setBackground(background, backgroundOpacity); }, [background, backgroundOpacity]);
  useEffect(() => {
    const api = window.refCanvas;
    if (!api) return undefined;
    let pointerActive = false;
    const pointerId = 0x594f;
    return api.onNativePointer((input) => {
      const container = containerRef.current;
      if (!container) return;
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
  return <div ref={containerRef} className="canvas-runtime-root" data-canvas-runtime="pixi-v8" />;
}
