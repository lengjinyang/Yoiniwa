import {
  Fragment,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { CacheInfo } from '../../types';
import { SHORTCUT_LABELS, shortcutDisplayName, type ShortcutId, type ShortcutPreferences } from '../keyboardShortcuts';
import { Button, formatBytes } from './CommonControls';
import { UiIcon } from './UiIcon';

interface PropertiesPanelProps {
  open: boolean;
  settingsShortcut: string;
  shortcuts: ShortcutPreferences;
  shortcutCaptureId?: ShortcutId;
  drawingCollaborationMode: boolean;
  cacheInfo?: CacheInfo;
  cacheChanging: boolean;
  nativeAvailable: boolean;
  onClose(): void;
  onBeginShortcutCapture(id: ShortcutId, label: string): void;
  onCaptureShortcut(id: ShortcutId, event: ReactKeyboardEvent<HTMLButtonElement>): void;
  onCaptureShortcutKeyUp(id: ShortcutId, event: ReactKeyboardEvent<HTMLButtonElement>): void;
  onShortcutCaptureBlur(): void;
  onResetShortcuts(): void;
  onChooseCacheLocation(): void;
  onResetCacheLocation(): void;
  onClearCache(): void;
  onOpenLogsFolder(): void;
  onCopyDiagnostics(): void;
}

export function PropertiesPanel({
  open, settingsShortcut, shortcuts, shortcutCaptureId, drawingCollaborationMode,
  cacheInfo, cacheChanging, nativeAvailable, onClose, onBeginShortcutCapture,
  onCaptureShortcut, onCaptureShortcutKeyUp,
  onShortcutCaptureBlur, onResetShortcuts, onChooseCacheLocation, onResetCacheLocation,
  onClearCache, onOpenLogsFolder, onCopyDiagnostics,
}: PropertiesPanelProps) {
  const [confirmingCacheClear, setConfirmingCacheClear] = useState(false);
  if (!open) return null;
  return <aside className="property-panel no-drag">
    <div className="property-header"><div><strong>设置</strong><span>应用</span></div><button title={`关闭设置面板 (${shortcutDisplayName(settingsShortcut)})`} onClick={() => {
      setConfirmingCacheClear(false);
      onClose();
    }}><UiIcon name="close" /></button></div>
    <section>
      <h3>快捷键</h3>
      <div className="shortcut-list">
        {SHORTCUT_LABELS.map(({ id, label, group }, index) => {
          const capturing = shortcutCaptureId === id;
          const disabled = id === 'collaboration' && drawingCollaborationMode;
          return <Fragment key={id}>
            {(index === 0 || SHORTCUT_LABELS[index - 1].group !== group) && <div className="shortcut-category">{group}</div>}
            <div className="shortcut-row">
              <span>{label}</span>
              <button className={capturing ? 'active shortcut-capture' : 'shortcut-capture'}
                title={disabled ? '请先退出协作模式' : '点击后按下快捷键'}
                disabled={disabled}
                onClick={() => onBeginShortcutCapture(id, label)} onKeyDown={(event) => onCaptureShortcut(id, event)}
                onKeyUp={(event) => onCaptureShortcutKeyUp(id, event)}
                onBlur={() => { if (capturing) onShortcutCaptureBlur(); }}>
                {capturing ? '请按键…' : shortcutDisplayName(shortcuts[id])}
              </button>
            </div>
          </Fragment>;
        })}
      </div>
      <Button onClick={onResetShortcuts}>恢复默认快捷键</Button>
    </section>
    <section>
      <h3>性能与缓存</h3>
      <div className="cache-location" title={cacheInfo?.root ?? '正在读取缓存位置'}>{cacheInfo?.root ?? '正在读取…'}</div>
      <div className="selection-summary">缓存占用 {cacheInfo ? formatBytes(cacheInfo.assetBytes + cacheInfo.derivedBytes) : '—'} · 原图与预览资源</div>
      <div className="cache-notice">建议放在 SSD 或其他高速本地硬盘。避免使用 U 盘、移动硬盘、网络磁盘及云同步目录，以免影响导入和缩放性能。</div>
      {cacheInfo?.warning && <div className="cache-warning">{cacheInfo.warning}</div>}
      <div className="button-grid" style={{ marginTop: 9 }}>
        <Button disabled={!nativeAvailable || cacheChanging} onClick={onChooseCacheLocation}>{cacheChanging ? '正在处理…' : '更改位置…'}</Button>
        <Button disabled={!nativeAvailable || cacheChanging || !cacheInfo || cacheInfo.isDefault} onClick={onResetCacheLocation}>恢复默认位置</Button>
        <Button disabled={!nativeAvailable} onClick={onOpenLogsFolder}>打开日志文件夹</Button>
        <Button disabled={!nativeAvailable} onClick={onCopyDiagnostics}>复制诊断信息</Button>
      </div>
      {!confirmingCacheClear ? <button type="button" className="cache-clear-button"
        disabled={!nativeAvailable || cacheChanging} onClick={() => setConfirmingCacheClear(true)}>
        {cacheChanging ? '正在处理…' : '清除预览缓存'}
      </button> : <div className="cache-clear-confirm" role="group" aria-label="确认清除预览缓存">
        <span>删除可重新生成的预览与缩放缓存，不影响当前画板和原图。</span>
        <div>
          <button type="button" disabled={cacheChanging} onClick={() => setConfirmingCacheClear(false)}>取消</button>
          <button type="button" className="danger" disabled={cacheChanging} onClick={() => {
            setConfirmingCacheClear(false);
            onClearCache();
          }}>确认清除</button>
        </div>
      </div>}
    </section>
  </aside>;
}
