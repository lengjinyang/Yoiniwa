import { useEffect, useMemo, useRef } from 'react';
import { matchesColorPickerShortcut, type ColorPickerShortcut } from '../../interactions';
import { shortcutMatchesEvent, type ShortcutPreferences } from '../../keyboardShortcuts';

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
  activeColorPickerShortcut: ColorPickerShortcut;
  collaborationSpaceActive: boolean;
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

export function dispatchAppShortcutKeyDown(state: AppShortcutState, event: KeyboardEvent) {
  const input = typeof HTMLInputElement !== 'undefined'
    && (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement);
  if (input) return;
  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  const alt = event.altKey;
  const shift = event.shiftKey;
  const run = (id: AppShortcutCommandId) => {
    event.preventDefault();
    executeCommand(state.commands, id);
  };

  if (state.collaborationSpaceActive && !ctrl && !alt && !shift && event.code === 'Space') {
    event.preventDefault();
    return;
  }
  if (matchesColorPickerShortcut(state.activeColorPickerShortcut, event)) {
    event.preventDefault();
    if (!event.repeat) executeCommand(state.commands, 'colorPicker.press');
    return;
  }

  if (shortcutMatchesEvent(state.shortcuts.settings, event)) return run('settings.toggle');
  if (shortcutMatchesEvent(state.shortcuts.saveAs, event)) return run('file.saveAs');
  if (shortcutMatchesEvent(state.shortcuts.save, event)) return run('file.save');
  if (shortcutMatchesEvent(state.shortcuts.undo, event)) return run('edit.undo');
  if (shortcutMatchesEvent(state.shortcuts.redo, event)) return run('edit.redo');
  if (shortcutMatchesEvent(state.shortcuts.open, event)) return run('file.open');
  if (shortcutMatchesEvent(state.shortcuts.newScene, event)) return run('file.new');
  if (shortcutMatchesEvent(state.shortcuts.fitCanvas, event)) return run('view.fitCanvas');
  if (shortcutMatchesEvent(state.shortcuts.resetZoom, event)) return run('view.resetZoom');
  if (shortcutMatchesEvent(state.shortcuts.alwaysOnTop, event)) return run('window.toggleAlwaysOnTop');
  if (shortcutMatchesEvent(state.shortcuts.lockWindow, event)) return run('window.toggleLock');
  if (shortcutMatchesEvent(state.shortcuts.clickThrough, event)) return run('window.toggleClickThrough');

  if (ctrl && alt && shift && event.key === 'ArrowUp') return run('layout.distributeHorizontal');
  if (ctrl && alt && shift && event.key === 'ArrowDown') return run('layout.distributeVertical');
  if (ctrl && alt && !shift && event.key === 'ArrowLeft') return run('layout.normalizeHeight');
  if (ctrl && alt && !shift && event.key === 'ArrowRight') return run('layout.normalizeWidth');
  if (ctrl && alt && !shift && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) return run('layout.normalizeSize');
  if (ctrl && !alt && !shift && event.key === 'ArrowLeft') return run('layout.alignLeft');
  if (ctrl && !alt && !shift && event.key === 'ArrowRight') return run('layout.alignRight');
  if (ctrl && !alt && !shift && event.key === 'ArrowUp') return run('layout.alignTop');
  if (ctrl && !alt && !shift && event.key === 'ArrowDown') return run('layout.alignBottom');

  if (ctrl && !alt && shift && key === 'p') return run('view.openMenu');
  if (ctrl && !alt && shift && key === 'c') return run('image.restoreCrop');
  if (ctrl && !alt && shift && key === 't') return run('image.resetTransform');
  if (ctrl && !alt && shift && key === 'g') return run('group.detachOrUngroup');
  if (ctrl && !alt && shift && (key === '+' || key === '=')) return run('window.opacityUp');
  if (ctrl && !alt && shift && key === '-') return run('window.opacityDown');

  if (ctrl && alt && !shift && key === 'p') return run('layout.packAndFit');
  if (ctrl && !alt && !shift && key === 'c') return run('edit.copy');
  if (ctrl && !alt && !shift && key === 'x') return run('edit.cut');
  if (ctrl && !alt && !shift && key === 'v') return run('edit.paste');
  if (ctrl && !alt && !shift && key === 'i') return run('file.importImages');
  if (ctrl && !alt && shift && key === 'l') return run('file.openLatest');
  if (ctrl && !alt && !shift && key === 'y') return run('edit.redo');
  if (ctrl && !alt && !shift && key === 'd') return run('edit.duplicate');
  if (ctrl && !alt && !shift && key === 'g') return run('group.create');
  if (ctrl && !alt && !shift && key === 'a') return run('edit.selectAll');
  if (ctrl && !alt && !shift && key === 'p') return run('layout.pack');
  if (ctrl && !alt && !shift && key === 'o') return run('view.fitCanvas');
  if (ctrl && !alt && key === 'e') return run(shift ? 'file.exportSelected' : 'file.export');
  if (ctrl && !alt && !shift && key === 'f') return run('window.maximize');
  if (ctrl && !alt && !shift && key === 'm') return run('window.minimize');
  if (ctrl && !alt && !shift && key === 'q') return run('window.close');
  if (ctrl && !alt && !shift && (key === '+' || key === '=')) return run('view.zoomIn');
  if (ctrl && !alt && !shift && key === '-') return run('view.zoomOut');

  if (!ctrl && alt && shift && key === 'h') return run('image.flipHorizontal');
  if (!ctrl && alt && shift && key === 'v') return run('image.flipVertical');
  if (!ctrl && alt && !shift && key === 'l') return run('image.toggleLock');
  if (!ctrl && !alt && !shift && event.key === 'F2') return run('group.rename');
  if (!ctrl && !alt && !shift && event.code === 'Space' && !event.repeat) return run('view.toggleFocus');
  if (!ctrl && !alt && !shift && event.key === 'ArrowRight') return run('view.focusNext');
  if (!ctrl && !alt && !shift && event.key === 'ArrowLeft') return run('view.focusPrevious');
  if (!ctrl && !alt && !shift && event.key === 'ArrowUp') return run('image.moveFront');
  if (!ctrl && !alt && !shift && event.key === 'ArrowDown') return run('image.moveBack');
  if (!ctrl && !alt && event.key === 'Delete') run('edit.delete');
  if (event.key === 'Escape') run('ui.escape');
}

export function dispatchAppShortcutKeyUp(state: AppShortcutState, event: KeyboardEvent) {
  const releasedPickerKey = state.activeColorPickerShortcut === 's'
    ? event.key.toLowerCase() === 's' || event.code === 'KeyS'
    : event.key === 'Alt' || event.code === 'AltLeft' || event.code === 'AltRight';
  if (releasedPickerKey) executeCommand(state.commands, 'colorPicker.release');
}

export function useAppShortcuts(registry: StableAppShortcutRegistry) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => dispatchAppShortcutKeyDown(registry.current(), event);
    const onKeyUp = (event: KeyboardEvent) => dispatchAppShortcutKeyUp(registry.current(), event);
    const onBlur = () => executeCommand(registry.current().commands, 'colorPicker.release');
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
