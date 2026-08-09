import { useEffect, useMemo, useRef } from 'react';
import {
  shortcutMatchesKeyboardEvent,
  shortcutReleasedByKeyboardEvent,
  type ShortcutId,
  type ShortcutPreferences,
} from '../../keyboardShortcuts';

export type AppShortcutCommandId =
  | 'colorPicker.press' | 'colorPicker.release' | 'settings.toggle'
  | 'file.saveAs' | 'file.save' | 'file.open' | 'file.new' | 'file.importImages' | 'file.openLatest'
  | 'file.export' | 'file.exportSelected'
  | 'edit.undo' | 'edit.redo' | 'edit.copy' | 'edit.cut' | 'edit.paste' | 'edit.duplicate'
  | 'edit.delete' | 'edit.selectAll'
  | 'group.create' | 'group.detachOrUngroup' | 'group.rename'
  | 'image.restoreCrop' | 'image.resetTransform' | 'image.flipHorizontal' | 'image.flipVertical'
  | 'image.toggleLock' | 'image.moveFront' | 'image.moveBack'
  | 'layout.pack' | 'layout.packAndFit' | 'layout.alignLeft' | 'layout.alignRight' | 'layout.alignTop'
  | 'layout.alignBottom' | 'layout.distributeHorizontal' | 'layout.distributeVertical'
  | 'layout.normalizeWidth' | 'layout.normalizeHeight' | 'layout.normalizeSize'
  | 'view.openMenu' | 'view.fitCanvas' | 'view.resetZoom' | 'view.toggleFocus'
  | 'view.focusNext' | 'view.focusPrevious' | 'view.zoomIn' | 'view.zoomOut'
  | 'window.toggleAlwaysOnTop' | 'window.toggleLock' | 'window.toggleClickThrough'
  | 'window.opacityUp' | 'window.opacityDown' | 'window.maximize' | 'window.minimize' | 'window.close'
  | 'visualNotes.toggle' | 'visualNotes.hide.press' | 'visualNotes.hide.release'
  | 'visualNotes.brush' | 'visualNotes.arrow' | 'visualNotes.eraser'
  | 'ui.escape';

export interface AppShortcutCommand {
  id: AppShortcutCommandId;
  execute(): void;
}

export type AppShortcutCommandRegistry = ReadonlyMap<AppShortcutCommandId, AppShortcutCommand>;

export function createAppShortcutCommandRegistry(commands: AppShortcutCommand[]): AppShortcutCommandRegistry {
  const registry = new Map<AppShortcutCommandId, AppShortcutCommand>();
  for (const command of commands) {
    if (registry.has(command.id)) throw new Error(`Duplicate shortcut command: ${command.id}`);
    registry.set(command.id, command);
  }
  return registry;
}

export interface AppShortcutState {
  shortcuts: ShortcutPreferences;
  activeColorPickerShortcut: string;
  collaborationSpaceActive: boolean;
  hasInternalClipboard: boolean;
  visualNotesEnabled?: boolean;
  commands: AppShortcutCommandRegistry;
}

export interface StableAppShortcutRegistry {
  current(): AppShortcutState;
}

export function useAppShortcutRegistry(state: AppShortcutState): StableAppShortcutRegistry {
  const stateRef = useRef(state);
  stateRef.current = state;
  return useMemo(() => ({ current: () => stateRef.current }), []);
}

function executeCommand(registry: AppShortcutCommandRegistry, id: AppShortcutCommandId) {
  const command = registry.get(id);
  if (!command) throw new Error(`Unknown shortcut command: ${id}`);
  command.execute();
}

const APP_SHORTCUT_BINDINGS: ReadonlyArray<{
  shortcut: ShortcutId;
  command: AppShortcutCommandId;
  visualNotesOnly?: boolean;
  ignoreRepeat?: boolean;
}> = [
  { shortcut: 'settings', command: 'settings.toggle' },
  { shortcut: 'saveAs', command: 'file.saveAs' },
  { shortcut: 'save', command: 'file.save' },
  { shortcut: 'open', command: 'file.open' },
  { shortcut: 'openLatest', command: 'file.openLatest' },
  { shortcut: 'newScene', command: 'file.new' },
  { shortcut: 'importImages', command: 'file.importImages' },
  { shortcut: 'exportBoard', command: 'file.export' },
  { shortcut: 'exportSelected', command: 'file.exportSelected' },
  { shortcut: 'undo', command: 'edit.undo' },
  { shortcut: 'redo', command: 'edit.redo' },
  { shortcut: 'redoAlternate', command: 'edit.redo' },
  { shortcut: 'copy', command: 'edit.copy' },
  { shortcut: 'cut', command: 'edit.cut' },
  { shortcut: 'paste', command: 'edit.paste' },
  { shortcut: 'duplicate', command: 'edit.duplicate' },
  { shortcut: 'deleteSelection', command: 'edit.delete' },
  { shortcut: 'selectAll', command: 'edit.selectAll' },
  { shortcut: 'createGroup', command: 'group.create' },
  { shortcut: 'detachGroup', command: 'group.detachOrUngroup' },
  { shortcut: 'renameGroup', command: 'group.rename' },
  { shortcut: 'restoreCrop', command: 'image.restoreCrop' },
  { shortcut: 'resetTransform', command: 'image.resetTransform' },
  { shortcut: 'flipHorizontal', command: 'image.flipHorizontal' },
  { shortcut: 'flipVertical', command: 'image.flipVertical' },
  { shortcut: 'toggleImageLock', command: 'image.toggleLock' },
  { shortcut: 'moveFront', command: 'image.moveFront' },
  { shortcut: 'moveBack', command: 'image.moveBack' },
  { shortcut: 'pack', command: 'layout.pack' },
  { shortcut: 'packAndFit', command: 'layout.packAndFit' },
  { shortcut: 'alignLeft', command: 'layout.alignLeft' },
  { shortcut: 'alignRight', command: 'layout.alignRight' },
  { shortcut: 'alignTop', command: 'layout.alignTop' },
  { shortcut: 'alignBottom', command: 'layout.alignBottom' },
  { shortcut: 'distributeHorizontal', command: 'layout.distributeHorizontal' },
  { shortcut: 'distributeVertical', command: 'layout.distributeVertical' },
  { shortcut: 'normalizeWidth', command: 'layout.normalizeWidth' },
  { shortcut: 'normalizeHeight', command: 'layout.normalizeHeight' },
  { shortcut: 'normalizeSize', command: 'layout.normalizeSize' },
  { shortcut: 'normalizeSizeAlternate', command: 'layout.normalizeSize' },
  { shortcut: 'openMenu', command: 'view.openMenu' },
  { shortcut: 'fitCanvas', command: 'view.fitCanvas' },
  { shortcut: 'fitCanvasAlternate', command: 'view.fitCanvas' },
  { shortcut: 'resetZoom', command: 'view.resetZoom' },
  { shortcut: 'toggleFocus', command: 'view.toggleFocus', ignoreRepeat: true },
  { shortcut: 'focusNext', command: 'view.focusNext' },
  { shortcut: 'focusPrevious', command: 'view.focusPrevious' },
  { shortcut: 'zoomIn', command: 'view.zoomIn' },
  { shortcut: 'zoomOut', command: 'view.zoomOut' },
  { shortcut: 'alwaysOnTop', command: 'window.toggleAlwaysOnTop' },
  { shortcut: 'lockWindow', command: 'window.toggleLock' },
  { shortcut: 'clickThrough', command: 'window.toggleClickThrough' },
  { shortcut: 'opacityUp', command: 'window.opacityUp' },
  { shortcut: 'opacityDown', command: 'window.opacityDown' },
  { shortcut: 'maximize', command: 'window.maximize' },
  { shortcut: 'minimize', command: 'window.minimize' },
  { shortcut: 'closeWindow', command: 'window.close' },
  { shortcut: 'visualNotesToggle', command: 'visualNotes.toggle', ignoreRepeat: true },
  { shortcut: 'visualNotesHide', command: 'visualNotes.hide.press', visualNotesOnly: true, ignoreRepeat: true },
  { shortcut: 'visualNotesBrush', command: 'visualNotes.brush', visualNotesOnly: true },
  { shortcut: 'visualNotesBrushAlternate', command: 'visualNotes.brush', visualNotesOnly: true },
  { shortcut: 'visualNotesArrow', command: 'visualNotes.arrow', visualNotesOnly: true },
  { shortcut: 'visualNotesEraser', command: 'visualNotes.eraser', visualNotesOnly: true },
  { shortcut: 'visualNotesEraserAlternate', command: 'visualNotes.eraser', visualNotesOnly: true },
  { shortcut: 'escape', command: 'ui.escape' },
];

export function dispatchAppShortcutKeyDown(state: AppShortcutState, event: KeyboardEvent) {
  const input = typeof HTMLInputElement !== 'undefined'
    && (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement);
  if (input) return;
  if (state.collaborationSpaceActive && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
    && event.code === 'Space') {
    event.preventDefault();
    return;
  }
  if (shortcutMatchesKeyboardEvent(state.activeColorPickerShortcut, event)) {
    event.preventDefault();
    if (!event.repeat) executeCommand(state.commands, 'colorPicker.press');
    return;
  }
  if (!state.collaborationSpaceActive && shortcutMatchesKeyboardEvent(state.shortcuts.panCanvas, event)) {
    event.preventDefault();
    return;
  }
  for (const binding of APP_SHORTCUT_BINDINGS) {
    if (binding.visualNotesOnly && !state.visualNotesEnabled) continue;
    if (!shortcutMatchesKeyboardEvent(state.shortcuts[binding.shortcut], event)) continue;
    // Ctrl+V must reach the native paste event so image/file clipboard imports
    // keep working. Other user-assigned paste keys call the Electron clipboard
    // fallback directly through the command registry.
    if (binding.command === 'edit.paste' && !state.hasInternalClipboard && state.shortcuts.paste === 'Ctrl+V') return;
    event.preventDefault();
    if (!binding.ignoreRepeat || !event.repeat) executeCommand(state.commands, binding.command);
    return;
  }
}

export function dispatchAppShortcutKeyUp(state: AppShortcutState, event: KeyboardEvent) {
  if (shortcutReleasedByKeyboardEvent(state.activeColorPickerShortcut, event)) {
    executeCommand(state.commands, 'colorPicker.release');
  }
  if (shortcutReleasedByKeyboardEvent(state.shortcuts.visualNotesHide, event)) {
    executeCommand(state.commands, 'visualNotes.hide.release');
  }
}

export function useAppShortcuts(registry: StableAppShortcutRegistry) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => dispatchAppShortcutKeyDown(registry.current(), event);
    const onKeyUp = (event: KeyboardEvent) => dispatchAppShortcutKeyUp(registry.current(), event);
    const onBlur = () => {
      executeCommand(registry.current().commands, 'colorPicker.release');
      executeCommand(registry.current().commands, 'visualNotes.hide.release');
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [registry]);
}
