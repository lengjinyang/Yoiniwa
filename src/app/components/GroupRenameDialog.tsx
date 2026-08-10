import { useRef } from 'react';

interface GroupRenameDialogProps {
  draft: string;
  onDraftChange(value: string): void;
  onCancel(): void;
  onSubmit(): void;
}

export function GroupRenameDialog({ draft, onDraftChange, onCancel, onSubmit }: GroupRenameDialogProps) {
  const composingRef = useRef(false);
  return <div className="group-rename-overlay no-drag" onMouseDown={onSubmit}>
    <div className="group-rename-card" onMouseDown={(event) => event.stopPropagation()}>
      <span>重命名分组框</span>
      <input autoFocus value={draft} onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => onDraftChange(event.target.value)}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { window.setTimeout(() => { composingRef.current = false; }, 0); }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !composingRef.current && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onSubmit();
          }
          if (event.key === 'Escape') onCancel();
        }} />
      <small>Enter 或点击外部保存 · Esc 取消</small>
    </div>
  </div>;
}
