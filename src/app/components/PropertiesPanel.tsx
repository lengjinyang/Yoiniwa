import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ColorPickerShortcut } from '../../interactions';
import type { CacheInfo } from '../../types';
import { SHORTCUT_LABELS, type ShortcutId, type ShortcutPreferences } from '../../keyboardShortcuts';
import { Button, formatBytes } from './CommonControls';
import { UiIcon } from './UiIcon';

interface PropertiesPanelProps {
  open: boolean;
  settingsShortcut: string;
  colorPickerShortcut: ColorPickerShortcut;
  shortcuts: ShortcutPreferences;
  shortcutCaptureId?: ShortcutId;
  drawingCollaborationMode: boolean;
  cacheInfo?: CacheInfo;
  cacheChanging: boolean;
  nativeAvailable: boolean;
  onClose(): void;
  onColorPickerShortcutChange(shortcut: ColorPickerShortcut): void;
  onBeginShortcutCapture(id: ShortcutId, label: string): void;
  onCaptureShortcut(id: ShortcutId, event: ReactKeyboardEvent<HTMLButtonElement>): void;
  onShortcutCaptureBlur(): void;
  onResetShortcuts(): void;
  onChooseCacheLocation(): void;
  onResetCacheLocation(): void;
  onOpenLogsFolder(): void;
  onCopyDiagnostics(): void;
}

export function PropertiesPanel({
  open, settingsShortcut, colorPickerShortcut, shortcuts, shortcutCaptureId, drawingCollaborationMode,
  cacheInfo, cacheChanging, nativeAvailable, onClose, onColorPickerShortcutChange, onBeginShortcutCapture,
  onCaptureShortcut, onShortcutCaptureBlur, onResetShortcuts, onChooseCacheLocation, onResetCacheLocation,
  onOpenLogsFolder, onCopyDiagnostics,
}: PropertiesPanelProps) {
  if (!open) return null;
  return <aside className="property-panel no-drag">
    <div className="property-header"><div><strong>设置</strong><span>应用</span></div><button title={`关闭设置面板 (${settingsShortcut})`} onClick={onClose}><UiIcon name="close" /></button></div>
    <section>
      <h3>交互设置</h3>
      <div className="selection-summary">Alt 模式适合 Photoshop + 数位板：锁定后 Alt + 笔尖点击取色，并自动返回 Photoshop</div>
      <div className="button-grid">
        <Button active={colorPickerShortcut === 's'} onClick={() => onColorPickerShortcutChange('s')}>S</Button>
        <Button active={colorPickerShortcut === 'alt'} onClick={() => onColorPickerShortcutChange('alt')}>Alt（PS / 数位板）</Button>
      </div>
    </section>
    <section>
      <h3>快捷键</h3>
      <div className="shortcut-list">
        {SHORTCUT_LABELS.map(({ id, label }) => {
          const capturing = shortcutCaptureId === id;
          const disabled = id === 'collaboration' && drawingCollaborationMode;
          return <div className="shortcut-row" key={id}>
            <span>{label}</span>
            <button className={capturing ? 'active shortcut-capture' : 'shortcut-capture'}
              title={disabled ? '请先退出协作模式' : '点击后按下快捷键'} disabled={disabled}
              onClick={() => onBeginShortcutCapture(id, label)} onKeyDown={(event) => onCaptureShortcut(id, event)}
              onBlur={() => { if (capturing) onShortcutCaptureBlur(); }}>{capturing ? '请按键…' : shortcuts[id]}</button>
          </div>;
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
        <Button disabled={!nativeAvailable || cacheChanging} onClick={onChooseCacheLocation}>{cacheChanging ? '正在迁移…' : '更改位置…'}</Button>
        <Button disabled={!nativeAvailable || cacheChanging || !cacheInfo || cacheInfo.isDefault} onClick={onResetCacheLocation}>恢复默认位置</Button>
        <Button disabled={!nativeAvailable} onClick={onOpenLogsFolder}>打开日志文件夹</Button>
        <Button disabled={!nativeAvailable} onClick={onCopyDiagnostics}>复制诊断信息</Button>
      </div>
    </section>
  </aside>;
}
