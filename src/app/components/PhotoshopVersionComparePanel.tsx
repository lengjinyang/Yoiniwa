import { useEffect, useMemo, useState } from 'react';
import { imageSource } from '../../imageResources';
import type { PhotoshopVersionRecord } from '../../types';
import { UiIcon } from './UiIcon';

export type ComparisonMode = 'ab' | 'slider' | 'overlay' | 'side-by-side';
export type ComparisonPreviewState = 'loading' | 'ready' | 'error';

export interface PhotoshopVersionComparePanelProps {
  currentPreviewUrl?: string;
  currentPreviewState: ComparisonPreviewState;
  currentPreviewError?: string;
  currentCapturedAt?: string;
  currentLabel: string;
  version: PhotoshopVersionRecord;
  versions: PhotoshopVersionRecord[];
  mode: ComparisonMode;
  split: number;
  opacity: number;
  onModeChange(mode: ComparisonMode): void;
  onSplitChange(value: number): void;
  onOpacityChange(value: number): void;
  onVersionChange(versionId: string): void;
  onRefreshCurrent(): void;
  onClose(): void;
}

type AbSide = 'current' | 'history';

const MODE_OPTIONS: ReadonlyArray<{ id: ComparisonMode; label: string }> = [
  { id: 'ab', label: 'A/B' },
  { id: 'slider', label: '滑杆' },
  { id: 'overlay', label: '透明叠加' },
  { id: 'side-by-side', label: '左右并排' },
];

function formatCapturedAt(value: string | undefined) {
  if (!value) return '正在捕获当前快照';
  return `捕获于 ${new Date(value).toLocaleString()} · 冻结快照`;
}

export function PhotoshopVersionComparePanel({
  currentPreviewUrl, currentPreviewState, currentPreviewError, currentCapturedAt, currentLabel,
  version, versions, mode, split, opacity, onModeChange, onSplitChange, onOpacityChange,
  onVersionChange, onRefreshCurrent, onClose,
}: PhotoshopVersionComparePanelProps) {
  const [abSide, setAbSide] = useState<AbSide>('current');
  const [historicalState, setHistoricalState] = useState<ComparisonPreviewState>('loading');
  const historicalPreviewUrl = useMemo(() => imageSource({ assetId: version.previewAssetId }, 'original'), [version.previewAssetId]);

  useEffect(() => {
    setAbSide('current');
    setHistoricalState('loading');
  }, [version.id]);

  const currentImage = currentPreviewState === 'ready' && currentPreviewUrl
    ? <img className="version-compare-image" src={currentPreviewUrl} alt="Photoshop 当前文档快照" draggable={false} /> : null;
  const historicalImage = historicalState !== 'error'
    ? <img key={`historical-preview-${version.id}`} className="version-compare-image" src={historicalPreviewUrl} alt={`历史版本 ${version.name}`}
      draggable={false} onLoad={() => setHistoricalState('ready')} onError={() => setHistoricalState('error')} /> : null;

  const currentNotice = currentPreviewState === 'loading' ? '正在捕获 Photoshop 当前文档…'
    : currentPreviewState === 'error' ? (currentPreviewError ?? 'Photoshop 当前文档预览生成失败') : undefined;
  const historyNotice = historicalState === 'loading' ? '正在读取历史版本预览…'
    : historicalState === 'error' ? '历史版本预览不可用' : undefined;

  const currentStatus = currentNotice && <div className="version-compare-state current">
    <span>{currentNotice}</span>
    {currentPreviewState === 'error' && <button type="button" onClick={onRefreshCurrent}>重试</button>}
  </div>;
  const historyStatus = historyNotice && <div className="version-compare-state history"><span>{historyNotice}</span></div>;

  const sharedStage = mode === 'ab'
    ? <div className="version-compare-stage mode-ab">
      {abSide === 'current' ? currentImage : historicalImage}
      {abSide === 'current' ? currentStatus : historyStatus}
    </div>
    : mode === 'slider'
      ? <div className="version-compare-stage mode-slider">
        {historicalImage}
        <div className="version-compare-wipe-current" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>{currentImage}</div>
        <i className="version-compare-divider" style={{ left: `${split}%` }} />
        <input className="version-compare-wipe-input" type="range" min="0" max="100" value={split}
          aria-label="当前画板显示比例" onChange={(event) => onSplitChange(Number(event.currentTarget.value))} />
        {currentStatus}{historyStatus}
      </div>
      : mode === 'overlay'
        ? <div className="version-compare-stage mode-overlay">
          {currentImage}
          <div className="version-compare-overlay-history" style={{ opacity: opacity / 100 }}>{historicalImage}</div>
          {currentStatus}{historyStatus}
        </div>
        : <div className="version-compare-side-by-side">
          <div className="version-compare-stage side-current">{currentImage}{currentStatus}</div>
          <div className="version-compare-stage side-history">{historicalImage}{historyStatus}</div>
        </div>;

  return <aside className="version-compare-panel no-drag" role="dialog" aria-modal="true" aria-label="Photoshop 版本对比">
    <header className="version-compare-header">
      <div><strong>版本对比</strong><span>Photoshop 当前文档 ↔ 历史版本</span></div>
      <button type="button" title="关闭版本对比" aria-label="关闭版本对比" onClick={onClose}><UiIcon name="close" /></button>
    </header>
    <section className="version-compare-toolbar">
      <div className="version-compare-meta">
        <span>Photoshop 当前文档</span><strong title={currentLabel}>{currentLabel}</strong><small>{formatCapturedAt(currentCapturedAt)}</small>
      </div>
      <button type="button" className="version-compare-refresh" disabled={currentPreviewState === 'loading'} onClick={onRefreshCurrent}>
        <UiIcon name="reset" size={14} />刷新当前
      </button>
      <label className="version-compare-version-select"><span>历史版本</span>
        <select value={version.id} onChange={(event) => onVersionChange(event.currentTarget.value)}>
          {versions.map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}
        </select>
      </label>
      <div className="version-compare-meta history">
        <span>{version.format.toUpperCase()} · {version.width}×{version.height}</span>
        <small>{new Date(version.createdAt).toLocaleString()}</small>
      </div>
    </section>
    <nav className="version-compare-modes" aria-label="对比模式">
      {MODE_OPTIONS.map((option) => <button type="button" key={option.id} className={mode === option.id ? 'active' : ''}
        aria-pressed={mode === option.id} onClick={() => onModeChange(option.id)}>{option.label}</button>)}
    </nav>
    <section className="version-compare-content">
      {sharedStage}
      {mode === 'ab' && <div className="version-compare-ab-controls" role="group" aria-label="A/B 版本选择">
        <button type="button" className={abSide === 'current' ? 'active' : ''} onClick={() => setAbSide('current')}>A 当前文档</button>
        <button type="button" className={abSide === 'history' ? 'active' : ''} onClick={() => setAbSide('history')}>B 历史版本</button>
      </div>}
      {mode === 'overlay' && <label className="version-compare-range-control"><span>历史版本透明度 {opacity}%</span>
        <input type="range" min="0" max="100" value={opacity} aria-label="历史版本透明度"
          onChange={(event) => onOpacityChange(Number(event.currentTarget.value))} />
      </label>}
      {mode === 'slider' && <div className="version-compare-direction"><span>当前文档</span><span>历史版本</span></div>}
      {mode === 'side-by-side' && <div className="version-compare-direction"><span>当前文档</span><span>历史版本</span></div>}
    </section>
  </aside>;
}
