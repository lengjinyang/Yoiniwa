import { describe, expect, it, vi } from 'vitest';
import { appCommand, createAppCommandRegistry } from './AppCommand';

describe('AppCommand registry', () => {
  it('exposes one shared enabled state and execute function', () => {
    const execute = vi.fn();
    const registry = createAppCommandRegistry([{ id: 'edit.copy', enabled: false, execute }]);
    expect(appCommand(registry, 'edit.copy').enabled).toBe(false);
    appCommand(registry, 'edit.copy').execute();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects duplicate command ids', () => {
    const command = { id: 'edit.undo' as const, enabled: true, execute: vi.fn() };
    expect(() => createAppCommandRegistry([command, command])).toThrow('Duplicate app command');
  });
});
