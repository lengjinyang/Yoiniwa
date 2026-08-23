import type { useAppUpdater } from '../hooks/useAppUpdater';
import { UiIcon } from './UiIcon';

interface AppUpdateNoticeProps {
  updater: ReturnType<typeof useAppUpdater>;
}

export function AppUpdateNotice({ updater }: AppUpdateNoticeProps) {
  if (!updater.visible || !updater.update) return null;
  const { update } = updater;
  return <aside className="app-update-notice no-drag" aria-live="polite">
    <header>
      <span className="app-update-icon"><UiIcon name="arrow-down" size={16} /></span>
      <div><strong>Yoiniwa {update.version} 可用</strong><small>当前版本 {update.currentVersion}</small></div>
      <button type="button" title="稍后提醒" aria-label="关闭更新提醒" disabled={updater.installing}
        onClick={updater.dismiss}><UiIcon name="close" size={13} /></button>
    </header>
    {update.notes && <p>{update.notes}</p>}
    {updater.error && <small className="app-update-error">{updater.error}</small>}
    {updater.dirty && <small className="app-update-hint">保存当前画板后即可安装。</small>}
    <footer>
      <button type="button" disabled={updater.installing} onClick={updater.dismiss}>稍后</button>
      <button className="app-update-install" type="button" disabled={updater.installing || updater.dirty}
        onClick={() => { void updater.install(); }}>
        {updater.installing ? '正在下载并安装…' : '更新并重启'}
      </button>
    </footer>
  </aside>;
}
