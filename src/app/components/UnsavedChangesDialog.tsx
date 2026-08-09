import { useEffect } from 'react';
import { UiIcon } from './UiIcon';

interface UnsavedChangesDialogProps {
  open: boolean;
  saving: boolean;
  sceneName: string;
  onCancel(): void;
  onDiscard(): void;
  onSave(): void;
}

export function UnsavedChangesDialog({
  open,
  saving,
  sceneName,
  onCancel,
  onDiscard,
  onSave,
}: UnsavedChangesDialogProps) {
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
    <section className="close-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="close-confirm-title">
      <header>
        <span className="close-confirm-icon"><UiIcon name="warning" size={21} /></span>
        <div><strong id="close-confirm-title">保存更改后再退出？</strong><span title={sceneName}>{sceneName}</span></div>
      </header>
      <div className="close-confirm-copy">
        <p>当前画板还有尚未保存的更改。</p>
        <small>不保存并退出将丢失这些更改，此操作无法撤销。</small>
      </div>
      <footer>
        <button className="close-confirm-cancel" type="button" disabled={saving} onClick={onCancel}>取消</button>
        <button className="close-confirm-discard" type="button" disabled={saving} onClick={onDiscard}>不保存</button>
        <button className="close-confirm-save" type="button" autoFocus disabled={saving} onClick={onSave}>
          <UiIcon name="file" size={14} />{saving ? '正在保存…' : '保存并退出'}
        </button>
      </footer>
    </section>
  </div>;
}
