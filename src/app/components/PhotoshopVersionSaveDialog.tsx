import { UiIcon } from './UiIcon';

interface PhotoshopVersionSaveDialogProps {
  open: boolean;
  name: string;
  note: string;
  onNameChange(value: string): void;
  onNoteChange(value: string): void;
  onCancel(): void;
  onSubmit(): void;
}

export function PhotoshopVersionSaveDialog({
  open,
  name,
  note,
  onNameChange,
  onNoteChange,
  onCancel,
  onSubmit,
}: PhotoshopVersionSaveDialogProps) {
  if (!open) return null;
  return <div className="photoshop-version-dialog-backdrop no-drag" onPointerDown={(event) => {
    if (event.target === event.currentTarget) onCancel();
  }}>
    <form className="photoshop-version-dialog" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <header>
        <span className="photoshop-version-dialog-icon"><UiIcon name="version" size={20} /></span>
        <div className="photoshop-version-dialog-heading"><strong>保存 Photoshop 版本</strong><span>完整分层 PSD/PSB 将嵌入当前 .yoi</span></div>
        <button className="photoshop-version-dialog-close" type="button" title="取消" onClick={onCancel}><UiIcon name="close" /></button>
      </header>
      <label><span>版本名称</span><input autoFocus maxLength={160} value={name}
        onChange={(event) => onNameChange(event.target.value)} /></label>
      <label><span>备注（可选）</span><textarea maxLength={4000} rows={4} value={note}
        onChange={(event) => onNoteChange(event.target.value)} /></label>
      <footer><button className="photoshop-version-dialog-cancel" type="button" onClick={onCancel}>取消</button>
        <button className="photoshop-version-dialog-submit" type="submit" disabled={!name.trim()}><UiIcon name="version" size={14} />保存版本</button></footer>
    </form>
  </div>;
}
