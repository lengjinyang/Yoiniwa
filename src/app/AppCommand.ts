interface AppCommand {
  enabled: boolean;
  execute(): void;
}

export type AppCommandRegistry = Readonly<Record<
  | 'edit.undo'
  | 'edit.redo'
  | 'edit.copy'
  | 'edit.cut'
  | 'edit.paste'
  | 'edit.duplicate'
  | 'edit.delete'
  | 'group.create',
  AppCommand
>>;
