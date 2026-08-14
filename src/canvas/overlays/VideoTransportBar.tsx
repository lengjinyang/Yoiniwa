import { useRef, type CSSProperties } from 'react';
import type { VideoTransportState } from '../renderer/VideoRenderer';

const RATES = [0.25, 0.5, 1, 1.5, 2] as const;

function TransportIcon({ kind }: { kind: string }) {
  const common = {
    width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true,
  };
  switch (kind) {
    case 'play':
      return <svg {...common}><path d="M5 3.2 12.2 8 5 12.8Z" fill="currentColor" stroke="none" /></svg>;
    case 'pause':
      return <svg {...common}><path d="M5 3.5h2.2v9H5Zm3.8 0H11v9H8.8Z" fill="currentColor" stroke="none" /></svg>;
    case 'mute':
      return <svg {...common}><path d="M2.5 6.2h2.2L8 3.8v8.4L4.7 9.8H2.5Z" /><path d="m10.2 6.2 3.1 3.1m0-3.1-3.1 3.1" /></svg>;
    case 'unmute':
      return <svg {...common}><path d="M2.5 6.2h2.2L8 3.8v8.4L4.7 9.8H2.5Z" /><path d="M10 6.4a2.8 2.8 0 0 1 0 3.2M11.6 5a4.4 4.4 0 0 1 0 6" /></svg>;
    case 'lock':
      return <svg {...common}><rect x="3.2" y="7" width="9.6" height="6.2" rx="1.4" /><path d="M5.4 7V5.4a2.6 2.6 0 0 1 5.2 0V7" /></svg>;
    case 'unlock':
      return <svg {...common}><rect x="3.2" y="7" width="9.6" height="6.2" rx="1.4" /><path d="M5.4 7V5.4A2.6 2.6 0 0 1 10.4 4.2" /></svg>;
    default:
      return null;
  }
}

export interface VideoTransportBarProps {
  visible: boolean;
  locked: boolean;
  resolutionLabel: string;
  barStyle?: CSSProperties;
  resolutionStyle?: CSSProperties;
  transport?: VideoTransportState;
  preparing?: boolean;
  onPlayPause(): void;
  onTimelineSeekStart(): void;
  onTimelineSeek(time: number): void;
  onTimelineSeekEnd(): void;
  onToggleMute(): void;
  onRateChange(rate: number): void;
  onToggleLock(): void;
}

function stopCanvasSteal(event: { stopPropagation(): void }) {
  event.stopPropagation();
}

function formatTime(seconds: number) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(safe / 60);
  const remaining = Math.floor(safe % 60);
  return `${minutes}:${String(remaining).padStart(2, '0')}`;
}

export function VideoTransportBar({
  visible, locked, resolutionLabel, barStyle, resolutionStyle, transport, preparing,
  onPlayPause, onTimelineSeekStart, onTimelineSeek, onTimelineSeekEnd,
  onToggleMute, onRateChange, onToggleLock,
}: VideoTransportBarProps) {
  const timelineActive = useRef(false);
  if (!visible) return null;
  const muted = transport?.muted !== false;
  const rate = transport?.rate || 1;
  const playing = Boolean(transport?.playing);
  const loading = Boolean(transport?.loading);
  const currentTime = transport?.currentTime ?? 0;
  const duration = transport?.duration ?? 0;
  const beginTimeline = () => {
    if (timelineActive.current) return;
    timelineActive.current = true;
    onTimelineSeekStart();
  };
  const endTimeline = () => {
    if (!timelineActive.current) return;
    timelineActive.current = false;
    onTimelineSeekEnd();
  };

  return <>
    <div className="video-transport-bar no-drag" role="toolbar" aria-label="Yoiniwa 视频控制"
      aria-busy={loading || preparing} style={barStyle}
      onPointerDown={stopCanvasSteal} onPointerUp={stopCanvasSteal} onPointerMove={stopCanvasSteal}
      onWheel={stopCanvasSteal} onContextMenu={stopCanvasSteal} onDoubleClick={stopCanvasSteal}>
      <div className="video-transport-cluster">
        <button type="button" className={`compact play${playing ? ' active' : ''}`}
          title={playing ? '暂停' : loading || preparing ? '准备中…（点击取消）' : '播放'}
          aria-label={playing ? '暂停' : loading || preparing ? '取消加载' : '播放'} onClick={onPlayPause}>
          <TransportIcon kind={playing ? 'pause' : 'play'} />
        </button>
      </div>
      <label className="video-transport-timeline" title="Timeline Scrub：拖动到视频中的绝对位置">
        <input type="range" min={0} max={Math.max(duration, 0.001)} step="any"
          value={Math.min(Math.max(currentTime, 0), Math.max(duration, 0.001))}
          aria-label="视频时间轴"
          onPointerDown={(event) => { stopCanvasSteal(event); beginTimeline(); }}
          onPointerUp={(event) => { stopCanvasSteal(event); endTimeline(); }}
          onPointerCancel={(event) => { stopCanvasSteal(event); endTimeline(); }}
          onKeyDown={(event) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) beginTimeline();
          }}
          onKeyUp={endTimeline} onBlur={endTimeline}
          onInput={(event) => onTimelineSeek(event.currentTarget.valueAsNumber)} />
        <span className="video-transport-time" title="Canvas Jog：在视频画面上按住左键左右拖动（8 px/帧）">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
      </label>
      <div className="video-transport-cluster">
        <button type="button" className={`compact${muted ? ' active' : ''}`}
          title={muted ? '取消静音' : '静音'} aria-label={muted ? '取消静音' : '静音'} onClick={onToggleMute}>
          <TransportIcon kind={muted ? 'mute' : 'unmute'} />
        </button>
        <label className="video-transport-rate" title="播放速度">
          <select aria-label="播放速度" value={String(rate)}
            onChange={(event) => onRateChange(Number(event.target.value))}>
            {RATES.map((value) => <option key={value} value={value}>{value}x</option>)}
          </select>
        </label>
        <button type="button" className={`compact${locked ? ' active' : ''}`}
          title={locked ? '解锁' : '锁定'} aria-label={locked ? '解锁' : '锁定'} onClick={onToggleLock}>
          <TransportIcon kind={locked ? 'lock' : 'unlock'} />
        </button>
      </div>
      {(loading || preparing) && <span className="video-transport-status" aria-live="polite">
        {preparing ? '准备可播放版本…' : transport?.phase === 'loading' ? '载入中…' : '缓冲中…'}
      </span>}
    </div>
    {resolutionLabel && <div className="video-resolution-pill no-drag" style={resolutionStyle}>{resolutionLabel}</div>}
  </>;
}
