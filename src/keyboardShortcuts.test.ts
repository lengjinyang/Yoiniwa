import { describe, expect, it } from 'vitest';
import { DEFAULT_SHORTCUTS, loadShortcutPreferences, shortcutConflict, shortcutFromKeyboardEvent, shortcutMatchesEvent } from './keyboardShortcuts';

describe('keyboard shortcuts', () => {
  it('normalizes browser keyboard events into reusable shortcut labels', () => {
    expect(shortcutFromKeyboardEvent({ key: 's', code: 'KeyS', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }))
      .toBe('Ctrl+S');
    expect(shortcutFromKeyboardEvent({ key: ' ', code: 'Space', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }))
      .toBe('Ctrl+Space');
    expect(shortcutFromKeyboardEvent({ key: 'Alt', code: 'AltLeft', ctrlKey: false, metaKey: false, altKey: true, shiftKey: false }))
      .toBeUndefined();
  });

  it('matches the configured value and reports conflicts before applying a change', () => {
    const event = { key: 'z', code: 'KeyZ', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false };
    expect(shortcutMatchesEvent(DEFAULT_SHORTCUTS.undo, event)).toBe(true);
    expect(shortcutConflict(DEFAULT_SHORTCUTS, 'save', 'Ctrl+C')).toBe('已用于复制');
    expect(shortcutConflict(DEFAULT_SHORTCUTS, 'save', 'Ctrl+Z')).toBe('已用于撤销');
  });

  it('falls back to defaults when persisted preferences are malformed', () => {
    expect(loadShortcutPreferences('{not json')).toEqual(DEFAULT_SHORTCUTS);
    expect(loadShortcutPreferences(JSON.stringify({ save: 'Ctrl+J' }))).toEqual({ ...DEFAULT_SHORTCUTS, save: 'Ctrl+J' });
    expect(loadShortcutPreferences(JSON.stringify({ save: 'not a shortcut' }))).toEqual(DEFAULT_SHORTCUTS);
  });
});
