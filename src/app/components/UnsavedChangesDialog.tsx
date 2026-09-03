import { useEffect, useId } from 'react';
import { UiIcon } from './UiIcon';

interface UnsavedChangesDialogProps {
  open: boolean;
  saving: boolean;
  sceneName: string;
  title?: string;
  description?: string;
  warning?: string;
  discardLabel?: string;
  saveLabel?: string;
  onCancel(): void;
  onDiscard(): void;
  onSave(): void;
}

export function UnsavedChangesDialog({
  open,
  saving,
  sceneName,
  title = '保存更改后再退出？',
  description = '当前画板还有尚未保存的更改。',
  warning = '不保存并退出将丢失这些更改，此操作无法撤销。',
  discardLabel = '不保存',
  saveLabel = '保存并退出',
  onCancel,
  onDiscard,
  onSave,
}: UnsavedChangesDialogProps) {
  const titleId = useId();
  useEffect(() => {
    if (!open) return undefined;
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || saving) return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener('keydown', keyDown, true);
    return () => window.removeEventListener('keydown', keyDown, true);
  }, [onCancel, open, saving]);

  if (!open) return null;
  return <div className="close-confirm-backdrop no-drag" onPointerDown={(event) => {
    if (event.target === event.currentTarget && !saving) onCancel();
  }}>
    <section className="close-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header>
        <span className="close-confirm-icon"><UiIcon name="warning" size={21} /></span>
        <div><strong id={titleId}>{title}</strong><span title={sceneName}>{sceneName}</span></div>
      </header>
      <div className="close-confirm-copy">
        <p>{description}</p>
        <small>{warning}</small>
        {saving && <progress className="save-progress" aria-label="正在保存画板" />}
      </div>
      <footer>
        <button className="close-confirm-cancel" type="button" disabled={saving} onClick={onCancel}>取消</button>
        <button className="close-confirm-discard" type="button" disabled={saving} onClick={onDiscard}>{discardLabel}</button>
        <button className="close-confirm-save" type="button" autoFocus disabled={saving} onClick={onSave}>
          <UiIcon name="file" size={14} />{saving ? '正在保存…' : saveLabel}
        </button>
      </footer>
    </section>
  </div>;
}
