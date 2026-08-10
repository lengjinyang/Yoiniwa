import { useCallback, useEffect, useMemo, useState } from 'react';
import { memberBounds, reconcileMemberBounds } from '../../scene';
import type {
  EraserSize,
  Scene,
  VisualNotesState,
  VisualNoteTool,
  VisualNoteWidth,
} from '../../types';
import type { VisualNotesToolState } from '../../canvas/interaction/VisualNotesController';

interface UseVisualNotesOptions {
  notes: VisualNotesState;
  projectEpoch: number;
  commit(updater: (scene: Scene) => void): void;
  preview(updater: (scene: Scene) => void): void;
  beginTransaction(): void;
  commitTransaction(): void;
}

export function useVisualNotes({
  notes,
  projectEpoch,
  commit,
  preview,
  beginTransaction,
  commitTransaction,
}: UseVisualNotesOptions) {
  const [enabled, setEnabled] = useState(false);
  const [tool, setTool] = useState<VisualNoteTool>('brush');
  const [color, setColor] = useState('#c6a15b');
  const [opacity, setOpacity] = useState(0.82);
  const [width, setWidth] = useState<VisualNoteWidth>('medium');
  const [pressureEnabled, setPressureEnabled] = useState(true);
  const [eraserSize, setEraserSize] = useState<EraserSize>('medium');
  const [temporaryHidden, setTemporaryHidden] = useState(false);
  const [selectedMarkId, setSelectedMarkId] = useState<string>();

  useEffect(() => {
    setSelectedMarkId(undefined);
    setTemporaryHidden(false);
  }, [projectEpoch]);

  useEffect(() => {
    if (!enabled) return undefined;
    const closeFolds = (event: PointerEvent) => {
      document.querySelectorAll<HTMLDetailsElement>('.visual-note-fold[open]').forEach((details) => {
        if (!details.contains(event.target as Node)) details.removeAttribute('open');
      });
    };
    window.addEventListener('pointerdown', closeFolds, true);
    return () => window.removeEventListener('pointerdown', closeFolds, true);
  }, [enabled]);

  const toolState = useMemo<VisualNotesToolState>(() => ({
    enabled,
    tool,
    color,
    opacity,
    width,
    pressureEnabled,
    eraserSize,
    selectedMarkId,
  }), [color, enabled, eraserSize, opacity, pressureEnabled, selectedMarkId, tool, width]);

  const updateSelectedMarkStyle = useCallback((patch: { color?: string; opacity?: number; width?: VisualNoteWidth }) => {
    if (!selectedMarkId) return;
    commit((scene) => {
      const mark = scene.visualNotes.marks.find((value) => value.id === selectedMarkId);
      if (!mark) return;
      Object.assign(mark.style, patch);
      if (patch.width) mark.style.baseWidth = ({ thin: 1.6, medium: 3.2, thick: 6 } as const)[patch.width]
        / Math.max(0.001, scene.viewport.scale);
    });
  }, [commit, selectedMarkId]);

  const deleteSelectedMark = useCallback(() => {
    if (!selectedMarkId) return false;
    commit((scene) => {
      scene.visualNotes.marks = scene.visualNotes.marks.filter((mark) => mark.id !== selectedMarkId);
      scene.groups.forEach((group) => {
        group.members = group.members.filter((member) => member.type !== 'mark' || member.id !== selectedMarkId);
      });
    });
    setSelectedMarkId(undefined);
    return true;
  }, [commit, selectedMarkId]);

  const commitNotes = useCallback((nextNotes: VisualNotesState) => {
    commit((scene) => {
      scene.visualNotes = structuredClone(nextNotes);
      const markIds = new Set(nextNotes.marks.map((mark) => mark.id));
      scene.groups.forEach((group) => {
        group.members = group.members.filter((member) => member.type !== 'mark' || markIds.has(member.id));
      });
      nextNotes.marks.filter((mark) => mark.anchor.type === 'scene').forEach((mark) => {
        const bounds = memberBounds(scene, { type: 'mark', id: mark.id });
        if (bounds) reconcileMemberBounds(scene, { type: 'mark', id: mark.id }, bounds);
      });
    });
  }, [commit]);

  const getRenderNotes = useCallback((imageIds?: ReadonlySet<string>) => {
    if (temporaryHidden) return { ...notes, visible: false };
    if (!imageIds) return notes;
    return {
      ...notes,
      marks: notes.marks.filter((mark) => mark.anchor.type === 'image' && imageIds.has(mark.anchor.imageId)),
    };
  }, [notes, temporaryHidden]);

  const clearSelection = useCallback(() => setSelectedMarkId(undefined), []);
  const exit = useCallback(() => setEnabled(false), []);
  const toggle = useCallback(() => setEnabled((value) => !value), []);
  const beginTemporaryHide = useCallback(() => setTemporaryHidden(true), []);
  const endTemporaryHide = useCallback(() => setTemporaryHidden(false), []);
  const selectBrush = useCallback(() => setTool('brush'), []);
  const selectArrow = useCallback(() => setTool('arrow'), []);
  const selectEraser = useCallback(() => setTool('eraser'), []);
  const changeWidth = useCallback((nextWidth: VisualNoteWidth) => {
    setWidth(nextWidth);
    updateSelectedMarkStyle({ width: nextWidth });
  }, [updateSelectedMarkStyle]);
  const changeColor = useCallback((nextColor: string) => {
    setColor(nextColor);
    updateSelectedMarkStyle({ color: nextColor });
  }, [updateSelectedMarkStyle]);
  const beginOpacityInteraction = useCallback(() => {
    if (selectedMarkId) beginTransaction();
  }, [beginTransaction, selectedMarkId]);
  const changeOpacity = useCallback((nextOpacity: number) => {
    setOpacity(nextOpacity);
    if (!selectedMarkId) return;
    preview((scene) => {
      const mark = scene.visualNotes.marks.find((value) => value.id === selectedMarkId);
      if (mark) mark.style.opacity = nextOpacity;
    });
  }, [preview, selectedMarkId]);
  const endOpacityInteraction = useCallback(() => {
    if (selectedMarkId) commitTransaction();
  }, [commitTransaction, selectedMarkId]);
  const toggleNotesVisible = useCallback(() => {
    commit((scene) => { scene.visualNotes.visible = !scene.visualNotes.visible; });
  }, [commit]);

  const canvas = useMemo(() => ({
    state: toolState,
    temporaryHidden,
    onChanged: commitNotes,
    onSelectionChange: setSelectedMarkId,
  }), [commitNotes, temporaryHidden, toolState]);

  const toolbarProps = useMemo(() => ({
    enabled,
    tool,
    color,
    opacity,
    width,
    pressureEnabled,
    eraserSize,
    selectedMarkId,
    notesVisible: notes.visible,
    onToolChange: setTool,
    onColorChange: changeColor,
    onOpacityChange: changeOpacity,
    onWidthChange: changeWidth,
    onEraserSizeChange: setEraserSize,
    onPressureToggle: () => setPressureEnabled((value) => !value),
    onOpacityInteractionStart: beginOpacityInteraction,
    onOpacityInteractionEnd: endOpacityInteraction,
    onDeleteSelected: deleteSelectedMark,
    onToggleNotesVisible: toggleNotesVisible,
    onExit: exit,
  }), [beginOpacityInteraction, changeColor, changeOpacity, changeWidth, color, deleteSelectedMark, enabled,
    endOpacityInteraction, eraserSize, exit, notes.visible, opacity, pressureEnabled, selectedMarkId, toggleNotesVisible, tool, width]);

  return {
    enabled,
    temporaryHidden,
    selectedMarkId,
    canvas,
    toolbarProps,
    getRenderNotes,
    deleteSelectedMark,
    clearSelection,
    exit,
    toggle,
    beginTemporaryHide,
    endTemporaryHide,
    selectBrush,
    selectArrow,
    selectEraser,
  };
}
