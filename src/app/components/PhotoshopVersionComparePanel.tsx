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
  baseVersion?: PhotoshopVersionRecord;
  version: PhotoshopVersionRecord;
  versions: PhotoshopVersionRecord[];
  mode: ComparisonMode;
  split: number;
  opacity: number;
  onModeChange(mode: ComparisonMode): void;
  onSplitChange(value: number): void;
  onOpacityChange(value: number): void;
  onBaseVersionChange(versionId?: string): void;
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
  baseVersion, version, versions, mode, split, opacity, onModeChange, onSplitChange, onOpacityChange,
  onBaseVersionChange, onVersionChange, onRefreshCurrent, onClose,
}: PhotoshopVersionComparePanelProps) {
  const [abSide, setAbSide] = useState<AbSide>('current');
  const [baseHistoricalState, setBaseHistoricalState] = useState<ComparisonPreviewState>('loading');
  const [historicalState, setHistoricalState] = useState<ComparisonPreviewState>('loading');
  const baseHistoricalPreviewUrl = useMemo(() => baseVersion
    ? imageSource({ assetId: baseVersion.previewAssetId }, 'original') : undefined, [baseVersion]);
  const historicalPreviewUrl = useMemo(() => imageSource({ assetId: version.previewAssetId }, 'original'), [version.previewAssetId]);

  useEffect(() => {
    setAbSide('current');
  }, [baseVersion?.id, version.id]);

  useEffect(() => {
    setBaseHistoricalState('loading');
  }, [baseVersion?.id]);

  useEffect(() => {
    setHistoricalState('loading');
  }, [version.id]);

  const currentDocumentImage = currentPreviewState === 'ready' && currentPreviewUrl
    ? <img className="version-compare-image" src={currentPreviewUrl} alt="Photoshop 当前文档快照" draggable={false} /> : null;
  const baseHistoricalImage = baseVersion && baseHistoricalPreviewUrl && baseHistoricalState !== 'error'
    ? <img key={`base-preview-${baseVersion.id}`} className="version-compare-image" src={baseHistoricalPreviewUrl}
      alt={`历史版本 ${baseVersion.name}`} draggable={false} onLoad={() => setBaseHistoricalState('ready')}
      onError={() => setBaseHistoricalState('error')} /> : null;
  const baseImage = baseVersion ? baseHistoricalImage : currentDocumentImage;
  const historicalImage = historicalState !== 'error'
    ? <img key={`historical-preview-${version.id}`} className="version-compare-image" src={historicalPreviewUrl} alt={`历史版本 ${version.name}`}
      draggable={false} onLoad={() => setHistoricalState('ready')} onError={() => setHistoricalState('error')} /> : null;

  const currentNotice = baseVersion
    ? baseHistoricalState === 'loading' ? '正在读取版本 A 预览…'
      : baseHistoricalState === 'error' ? '版本 A 预览不可用' : undefined
    : currentPreviewState === 'loading' ? '正在捕获 Photoshop 当前文档…'
      : currentPreviewState === 'error' ? (currentPreviewError ?? 'Photoshop 当前文档预览生成失败') : undefined;
  const historyNotice = historicalState === 'loading' ? '正在读取历史版本预览…'
    : historicalState === 'error' ? '历史版本预览不可用' : undefined;

  const currentStatus = currentNotice && <div className="version-compare-state current">
    <span>{currentNotice}</span>
    {!baseVersion && currentPreviewState === 'error' && <button type="button" onClick={onRefreshCurrent}>重试</button>}
  </div>;
  const historyStatus = historyNotice && <div className="version-compare-state history"><span>{historyNotice}</span></div>;

  const sharedStage = mode === 'ab'
    ? <div className="version-compare-stage mode-ab">
      {abSide === 'current' ? baseImage : historicalImage}
      {abSide === 'current' ? currentStatus : historyStatus}
    </div>
    : mode === 'slider'
      ? <div className="version-compare-stage mode-slider">
        {historicalImage}
        <div className="version-compare-wipe-current" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>{baseImage}</div>
        <i className="version-compare-divider" style={{ left: `${split}%` }} />
        <input className="version-compare-wipe-input" type="range" min="0" max="100" value={split}
          aria-label="版本 A 显示比例" onChange={(event) => onSplitChange(Number(event.currentTarget.value))} />
        {currentStatus}{historyStatus}
      </div>
      : mode === 'overlay'
        ? <div className="version-compare-stage mode-overlay">
          {baseImage}
          <div className="version-compare-overlay-history" style={{ opacity: opacity / 100 }}>{historicalImage}</div>
          {currentStatus}{historyStatus}
        </div>
        : <div className="version-compare-side-by-side">
          <div className="version-compare-stage side-current">{baseImage}{currentStatus}</div>
          <div className="version-compare-stage side-history">{historicalImage}{historyStatus}</div>
        </div>;

  return <aside className="version-compare-panel no-drag" role="dialog" aria-modal="true" aria-label="Photoshop 版本对比">
    <header className="version-compare-header">
      <div><strong>版本对比</strong><span>{baseVersion?.name ?? 'Photoshop 当前文档'} ↔ {version.name}</span></div>
      <button type="button" title="关闭版本对比" aria-label="关闭版本对比" onClick={onClose}><UiIcon name="close" /></button>
    </header>
    <section className="version-compare-toolbar">
      <label className="version-compare-version-select base"><span>版本 A</span>
        <select value={baseVersion?.id ?? ''} onChange={(event) => onBaseVersionChange(event.currentTarget.value || undefined)}>
          <option value="">当前 Photoshop 文档</option>
          {versions.map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}
        </select>
        <small>{baseVersion
          ? `${baseVersion.format.toUpperCase()} · ${baseVersion.width}×${baseVersion.height} · ${new Date(baseVersion.createdAt).toLocaleString()}`
          : `${currentLabel} · ${formatCapturedAt(currentCapturedAt)}`}</small>
      </label>
      <button type="button" className="version-compare-refresh" disabled={Boolean(baseVersion) || currentPreviewState === 'loading'} onClick={onRefreshCurrent}>
        <UiIcon name="reset" size={14} />刷新当前
      </button>
      <label className="version-compare-version-select"><span>版本 B</span>
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
        <button type="button" className={abSide === 'current' ? 'active' : ''} onClick={() => setAbSide('current')}>A {baseVersion?.name ?? '当前文档'}</button>
        <button type="button" className={abSide === 'history' ? 'active' : ''} onClick={() => setAbSide('history')}>B {version.name}</button>
      </div>}
      {mode === 'overlay' && <label className="version-compare-range-control"><span>版本 B 透明度 {opacity}%</span>
        <input type="range" min="0" max="100" value={opacity} aria-label="版本 B 透明度"
          onChange={(event) => onOpacityChange(Number(event.currentTarget.value))} />
      </label>}
      {mode === 'slider' && <div className="version-compare-direction"><span>A · {baseVersion?.name ?? '当前文档'}</span><span>B · {version.name}</span></div>}
      {mode === 'side-by-side' && <div className="version-compare-direction"><span>A · {baseVersion?.name ?? '当前文档'}</span><span>B · {version.name}</span></div>}
    </section>
  </aside>;
}
