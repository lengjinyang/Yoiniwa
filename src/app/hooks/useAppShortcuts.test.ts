import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SHORTCUTS } from '../../keyboardShortcuts';
import {
  createAppShortcutCommandRegistry,
  dispatchAppShortcutKeyDown,
  dispatchAppShortcutKeyUp,
  type AppShortcutCommandId,
  type AppShortcutState,
} from './useAppShortcuts';

function keyboardEvent(key: string, code: string, modifiers: Partial<KeyboardEvent> = {}) {
  return {
    key,
    code,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    target: null,
    preventDefault: vi.fn(),
    ...modifiers,
  } as unknown as KeyboardEvent;
}

function shortcutState(commandIds: AppShortcutCommandId[], collaborationSpaceActive = false) {
  const executed: AppShortcutCommandId[] = [];
  const commands = createAppShortcutCommandRegistry(commandIds.map((id) => ({
    id,
    execute: () => executed.push(id),
  })));
  const state: AppShortcutState = {
    shortcuts: DEFAULT_SHORTCUTS,
    activeColorPickerShortcut: 's',
    collaborationSpaceActive,
    commands,
  };
  return { state, executed };
}

describe('useAppShortcuts dispatch boundary', () => {
  it('dispatches configured shortcuts through the command registry', () => {
    const { state, executed } = shortcutState(['file.save']);
    const event = keyboardEvent('s', 'KeyS', { ctrlKey: true });
    dispatchAppShortcutKeyDown(state, event);
    expect(executed).toEqual(['file.save']);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('keeps picker press and release as separate commands', () => {
    const { state, executed } = shortcutState(['colorPicker.press', 'colorPicker.release']);
    dispatchAppShortcutKeyDown(state, keyboardEvent('s', 'KeyS'));
    dispatchAppShortcutKeyUp(state, keyboardEvent('s', 'KeyS'));
    expect(executed).toEqual(['colorPicker.press', 'colorPicker.release']);
  });

  it('absorbs collaboration Space without running focus commands', () => {
    const { state, executed } = shortcutState(['view.toggleFocus'], true);
    const event = keyboardEvent(' ', 'Space');
    dispatchAppShortcutKeyDown(state, event);
    expect(executed).toEqual([]);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('routes Escape through the shared close-order command', () => {
    const { state, executed } = shortcutState(['ui.escape']);
    dispatchAppShortcutKeyDown(state, keyboardEvent('Escape', 'Escape'));
    expect(executed).toEqual(['ui.escape']);
  });
});
