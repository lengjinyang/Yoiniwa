import { useCallback, useEffect, useState } from 'react';
import { logInfo } from '../../runtime/logger';
import type { AppUpdateInfo } from '../../types';

interface UseAppUpdaterOptions {
  api: Window['refCanvas'];
  dirty: boolean;
  collaborationMode: boolean;
  setStatus(message: string): void;
}

export function useAppUpdater({ api, dirty, collaborationMode, setStatus }: UseAppUpdaterOptions) {
  const [update, setUpdate] = useState<AppUpdateInfo>();
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!api) return undefined;
    let active = true;
    const timer = window.setTimeout(() => {
      void api.checkForUpdates().then((result) => {
        if (active && result.available) setUpdate(result);
      }).catch((reason) => {
        logInfo('updater.check-unavailable', { reason: String(reason) });
      });
    }, 5000);
    return () => { active = false; window.clearTimeout(timer); };
  }, [api]);

  const install = useCallback(async () => {
    if (!api || installing) return;
    if (collaborationMode) {
      setStatus('请先退出 Photoshop 协作模式，再安装更新');
      return;
    }
    if (dirty) {
      setStatus('请先保存当前画板，再安装更新');
      return;
    }
    setError(undefined);
    setInstalling(true);
    try {
      await api.installUpdate();
    } catch (reason) {
      const message = String(reason);
      setError(`更新安装失败：${message}`);
      setInstalling(false);
    }
  }, [api, collaborationMode, dirty, installing, setStatus]);

  return {
    update,
    visible: Boolean(update?.available) && !dismissed && !collaborationMode,
    dirty,
    installing,
    error,
    dismiss: () => setDismissed(true),
    install,
  };
}
