import { useMemo, type Dispatch, type SetStateAction } from 'react';
import { resetImageTransform } from '../../scene';
import type { WindowState } from '../../types';
import type { useSceneHistory } from '../../useSceneHistory';
import { appCommand, createAppCommandRegistry } from '../AppCommand';
import { buildAppMenuEntries } from '../appMenuEntries';
import type { useAppPreferences } from './useAppPreferences';
import type { useContextMenu } from './useContextMenu';
import type { useImageImport } from './useImageImport';
import type { usePhotoshopVersionController } from './usePhotoshopVersionController';
import type { useProjectLifecycle } from './useProjectLifecycle';
import type { useSceneDelivery } from './useSceneDelivery';
import type { useSceneWorkspaceController } from './useSceneWorkspaceController';
import type { useVisualNotes } from './useVisualNotes';
import { createAppShortcutCommandRegistry, useAppShortcutRegistry, useAppShortcuts } from './useAppShortcuts';

interface UseAppCommandsOptions {
  api: Window['refCanvas'];
  history: ReturnType<typeof useSceneHistory>;
  preferences: ReturnType<typeof useAppPreferences>;
  workspace: ReturnType<typeof useSceneWorkspaceController>;
  visualNotes: ReturnType<typeof useVisualNotes>;
  imageImport: ReturnType<typeof useImageImport>;
  project: ReturnType<typeof useProjectLifecycle>;
  delivery: ReturnType<typeof useSceneDelivery>;
  versions: ReturnType<typeof usePhotoshopVersionController>;
  context: ReturnType<typeof useContextMenu>;
  panels: {
    propertiesOpen: boolean;
    setPropertiesOpen: Dispatch<SetStateAction<boolean>>;
    outlineOpen: boolean;
    setOutlineOpen: Dispatch<SetStateAction<boolean>>;
  };
  window: {
    mode: WindowState;
    drawingCollaborationMode: boolean;
    setMode(patch: Partial<WindowState>): Promise<WindowState | undefined>;
    toggleDrawingCollaborationMode(): Promise<void>;
  };
  photoshopDocumentBlocked: boolean;
  setColorPickerHeld: Dispatch<SetStateAction<boolean>>;
  setStatus(message: string): void;
}

export function useAppCommands({
  api,
  history,
  preferences,
  workspace,
  visualNotes,
  imageImport,
  project,
  delivery,
  versions,
  context,
  panels,
  window: windowController,
  photoshopDocumentBlocked,
  setColorPickerHeld,
  setStatus,
}: UseAppCommandsOptions) {
  const commands = useMemo(() => createAppCommandRegistry([
    { id: 'edit.undo', enabled: history.canUndo, execute: history.undo },
    { id: 'edit.redo', enabled: history.canRedo, execute: history.redo },
    {
      id: 'edit.copy',
      enabled: workspace.selectedIds.length > 0 || Boolean(workspace.selectedGroup),
      execute: workspace.copySelection,
    },
    {
      id: 'edit.cut',
      enabled: workspace.selectedIds.length > 0 || Boolean(workspace.selectedGroup),
      execute: workspace.cutSelection,
    },
    { id: 'edit.paste', enabled: true, execute: () => {
      if (workspace.hasClipboard) workspace.pasteClipboard();
      else void imageImport.pasteSystemClipboard();
    } },
    {
      id: 'edit.duplicate',
      enabled: workspace.selectedIds.length > 0 || Boolean(workspace.selectedGroup),
      execute: workspace.duplicate,
    },
    {
      id: 'edit.delete',
      enabled: workspace.selectedIds.length > 0 || Boolean(workspace.selectedGroup),
      execute: () => workspace.selectedGroup ? workspace.deleteGroup(false) : workspace.deleteSelected(),
    },
    { id: 'group.create', enabled: workspace.selectedIds.length >= 2, execute: workspace.createGroup },
  ]), [history.canRedo, history.canUndo, history.redo, history.undo, imageImport, workspace]);

  const shortcutCommands = createAppShortcutCommandRegistry([
    { id: 'colorPicker.press', execute: () => setColorPickerHeld(true) },
    { id: 'colorPicker.release', execute: () => setColorPickerHeld(false) },
    {
      id: 'settings.toggle',
      execute: () => {
        context.close();
        panels.setPropertiesOpen((value) => !value);
      },
    },
    { id: 'file.saveAs', execute: () => { void project.save(true); } },
    { id: 'file.save', execute: () => { void project.save(false); } },
    { id: 'file.open', execute: () => { void project.open(); } },
    { id: 'file.new', execute: project.newScene },
    { id: 'file.importImages', execute: () => { void imageImport.importImages(); } },
    {
      id: 'file.openLatest',
      execute: () => {
        if (project.recent[0]) void project.open(project.recent[0].path);
        else setStatus('没有最近打开的画板');
      },
    },
    { id: 'file.export', execute: () => { void delivery.exportItems(false); } },
    { id: 'file.exportSelected', execute: () => { void delivery.exportItems(true); } },
    { id: 'edit.undo', execute: appCommand(commands, 'edit.undo').execute },
    { id: 'edit.redo', execute: appCommand(commands, 'edit.redo').execute },
    { id: 'edit.copy', execute: appCommand(commands, 'edit.copy').execute },
    { id: 'edit.cut', execute: appCommand(commands, 'edit.cut').execute },
    { id: 'edit.paste', execute: appCommand(commands, 'edit.paste').execute },
    { id: 'edit.duplicate', execute: appCommand(commands, 'edit.duplicate').execute },
    {
      id: 'edit.delete',
      execute: () => {
        if (!visualNotes.deleteSelectedMark()) appCommand(commands, 'edit.delete').execute();
      },
    },
    { id: 'edit.selectAll', execute: workspace.selectAll },
    { id: 'group.create', execute: appCommand(commands, 'group.create').execute },
    {
      id: 'group.detachOrUngroup',
      execute: () => {
        if (workspace.selectedIds.length) workspace.detachSelectedImages();
        else workspace.ungroupSelected();
      },
    },
    { id: 'group.rename', execute: workspace.renameGroup },
    { id: 'image.restoreCrop', execute: workspace.restoreFullImages },
    { id: 'image.resetTransform', execute: () => workspace.mutateSelected(resetImageTransform) },
    { id: 'image.flipHorizontal', execute: () => workspace.mutateSelected((item) => { item.flipX = !item.flipX; }) },
    { id: 'image.flipVertical', execute: () => workspace.mutateSelected((item) => { item.flipY = !item.flipY; }) },
    { id: 'image.toggleLock', execute: () => workspace.mutateSelected((item) => { item.locked = !item.locked; }) },
    { id: 'image.moveFront', execute: () => workspace.moveLayer(true) },
    { id: 'image.moveBack', execute: () => workspace.moveLayer(false) },
    { id: 'layout.pack', execute: () => workspace.layout('pack') },
    { id: 'layout.packAndFit', execute: workspace.packAndFit },
    { id: 'layout.alignLeft', execute: () => workspace.layout('align-left') },
    { id: 'layout.alignRight', execute: () => workspace.layout('align-right') },
    { id: 'layout.alignTop', execute: () => workspace.layout('align-top') },
    { id: 'layout.alignBottom', execute: () => workspace.layout('align-bottom') },
    { id: 'layout.distributeHorizontal', execute: () => workspace.layout('distribute-horizontal') },
    { id: 'layout.distributeVertical', execute: () => workspace.layout('distribute-vertical') },
    { id: 'layout.normalizeWidth', execute: () => workspace.layout('normalize-width') },
    { id: 'layout.normalizeHeight', execute: () => workspace.layout('normalize-height') },
    { id: 'layout.normalizeSize', execute: () => workspace.layout('normalize-size') },
    {
      id: 'view.openMenu',
      execute: () => context.open({ x: window.innerWidth / 2, y: window.innerHeight / 2 }),
    },
    { id: 'view.fitCanvas', execute: workspace.fitCanvas },
    { id: 'view.resetZoom', execute: workspace.resetZoom },
    { id: 'view.toggleFocus', execute: () => workspace.toggleFocus(workspace.selectedItems) },
    { id: 'view.focusNext', execute: () => workspace.focusStep(1) },
    { id: 'view.focusPrevious', execute: () => workspace.focusStep(-1) },
    { id: 'view.zoomIn', execute: () => workspace.zoomBy(1.15) },
    { id: 'view.zoomOut', execute: () => workspace.zoomBy(1 / 1.15) },
    {
      id: 'window.toggleAlwaysOnTop',
      execute: () => { void windowController.setMode({ alwaysOnTop: !windowController.mode.alwaysOnTop }); },
    },
    {
      id: 'window.toggleLock',
      execute: () => { void windowController.setMode({ locked: !windowController.mode.locked }); },
    },
    {
      id: 'window.toggleClickThrough',
      execute: () => { void windowController.setMode({ clickThrough: !windowController.mode.clickThrough }); },
    },
    {
      id: 'window.opacityUp',
      execute: () => { void windowController.setMode({ opacity: Math.min(1, windowController.mode.opacity + 0.1) }); },
    },
    {
      id: 'window.opacityDown',
      execute: () => { void windowController.setMode({ opacity: Math.max(0.3, windowController.mode.opacity - 0.1) }); },
    },
    { id: 'window.maximize', execute: () => api?.toggleMaximize() },
    { id: 'window.minimize', execute: () => api?.minimize() },
    { id: 'window.close', execute: () => api?.close() },
    { id: 'visualNotes.toggle', execute: visualNotes.toggle },
    { id: 'visualNotes.hide.press', execute: visualNotes.beginTemporaryHide },
    { id: 'visualNotes.hide.release', execute: visualNotes.endTemporaryHide },
    { id: 'visualNotes.brush', execute: visualNotes.selectBrush },
    { id: 'visualNotes.arrow', execute: visualNotes.selectArrow },
    { id: 'visualNotes.eraser', execute: visualNotes.selectEraser },
    {
      id: 'ui.escape',
      execute: () => {
        setColorPickerHeld(false);
        if (workspace.renamingGroupId) workspace.cancelGroupRename();
        else if (context.position) context.close();
        else if (versions.comparisonVersionId) versions.closeVersionComparison();
        else if (versions.versionsOpen) versions.closeVersionsPanel();
        else if (panels.outlineOpen) panels.setOutlineOpen(false);
        else if (panels.propertiesOpen) panels.setPropertiesOpen(false);
        else if (visualNotes.selectedMarkId) visualNotes.clearSelection();
        else if (visualNotes.enabled) visualNotes.exit();
        else workspace.clearSelection();
      },
    },
  ]);
  const shortcutRegistry = useAppShortcutRegistry({
    shortcuts: preferences.shortcuts,
    activeColorPickerShortcut: windowController.mode.locked ? 'Alt' : preferences.shortcuts.colorPicker,
    collaborationSpaceActive: windowController.drawingCollaborationMode,
    hasInternalClipboard: workspace.hasClipboard,
    visualNotesEnabled: visualNotes.enabled,
    commands: shortcutCommands,
  });
  useAppShortcuts(shortcutRegistry);

  return buildAppMenuEntries({
    scene: history.scene,
    dirty: history.dirty,
    shortcuts: preferences.shortcuts,
    commands,
    panels: {
      outlineOpen: panels.outlineOpen,
      versionsOpen: versions.versionsOpen,
      propertiesOpen: panels.propertiesOpen,
      toggleOutline: () => {
        if (!panels.outlineOpen) {
          versions.closeVersionsPanel();
          versions.closeVersionComparison();
        }
        panels.setOutlineOpen((value) => !value);
      },
      toggleVersions: () => {
        if (!versions.versionsOpen) panels.setOutlineOpen(false);
        versions.toggleVersionsPanel();
      },
      toggleProperties: () => panels.setPropertiesOpen((value) => !value),
    },
    file: {
      recent: project.recent,
      open: (path) => { void project.open(path); },
      importScene: () => { void project.importScene(); },
      save: (saveAs) => { void project.save(saveAs); },
    },
    selection: {
      selectedIds: workspace.selectedIds,
      selectedItems: workspace.selectedItems,
      selectedGroup: workspace.selectedGroup,
      primary: workspace.primary,
      selectAll: workspace.selectAll,
    },
    groups: {
      create: workspace.createGroup,
      addImages: workspace.addImagesToGroup,
      detachSelected: workspace.detachSelectedImages,
      renameSelected: workspace.renameGroup,
      change: workspace.changeGroup,
      ungroupSelected: workspace.ungroupSelected,
      deleteSelected: workspace.deleteGroup,
    },
    images: {
      mutate: workspace.mutateSelected,
      resetTransform: () => workspace.mutateSelected(resetImageTransform),
      moveLayer: workspace.moveLayer,
      restoreFull: workspace.restoreFullImages,
      showSource: () => { void workspace.showPrimarySource(); },
    },
    photoshop: {
      blocked: photoshopDocumentBlocked,
      sendSelected: (mode) => { void delivery.sendSelectedToPhotoshop(mode); },
      saveVersion: () => { void versions.openPhotoshopVersionSaveDialog(); },
    },
    layout: { targetCount: workspace.targetIds.length, run: workspace.layout, packAndFit: workspace.packAndFit },
    view: {
      hasContent: workspace.hasContent,
      focusSelected: workspace.toggleFocus,
      fitCanvas: workspace.fitCanvas,
      resetZoom: workspace.resetZoom,
    },
    window: {
      mode: windowController.mode,
      collaborationMode: windowController.drawingCollaborationMode,
      toggleCollaboration: () => { void windowController.toggleDrawingCollaborationMode(); },
      setMode: (patch) => { void windowController.setMode(patch); },
      minimize: () => api?.minimize(),
      toggleMaximize: () => api?.toggleMaximize(),
    },
    export: {
      render: (onlySelected, copy, format) => { void delivery.exportItems(onlySelected, copy, format); },
    },
    application: { newScene: project.newScene, close: () => api?.close() },
  });
}
