export type AppCommandId =
  | 'edit.undo'
  | 'edit.redo'
  | 'edit.copy'
  | 'edit.cut'
  | 'edit.paste'
  | 'edit.duplicate'
  | 'edit.delete'
  | 'group.create';

export interface AppCommand {
  id: AppCommandId;
  enabled: boolean;
  execute(): void;
}

export type AppCommandRegistry = ReadonlyMap<AppCommandId, AppCommand>;

export function createAppCommandRegistry(commands: AppCommand[]): AppCommandRegistry {
  const registry = new Map<AppCommandId, AppCommand>();
  for (const command of commands) {
    if (registry.has(command.id)) throw new Error(`Duplicate app command: ${command.id}`);
    registry.set(command.id, command);
  }
  return registry;
}

export function appCommand(registry: AppCommandRegistry, id: AppCommandId): AppCommand {
  const command = registry.get(id);
  if (!command) throw new Error(`Unknown app command: ${id}`);
  return command;
}
