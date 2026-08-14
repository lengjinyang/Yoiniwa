import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { VideoTransportState } from '../../canvas/renderer/VideoRenderer';
import {
  VIDEO_SCRUB_CLICK_SLOP_PX,
  VIDEO_SCRUB_IDLE_RESET_MS,
  VIDEO_SCRUB_PIXELS_PER_FRAME,
  videoFrameScrubState,
  videoScrubFrameAtDelta,
} from '../../canvas/renderer/VideoPerformancePolicy';

const RATES = [0.25, 0.5, 1, 1.5, 2] as const;

interface ScrubSession {
  pointerId: number;
  targetFrame: number;
  startFrame: number;
  startX: number;
  clickFrame: number;
  duration: number;
  fps: number;
  frameCount: number;
  maxFrame: number;
  dragging: boolean;
  moved: boolean;
  latestX: number;
  trackLeft: number;
  trackWidth: number;
  frameRequest?: number;
  idleTimer?: number;
}

function TransportIcon({ kind }: { kind: string }) {
  const common = {
    width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true,
  };
  switch (kind) {
    case 'prev':
      return <svg {...common}><path d="M10.8 3.5 4.5 8l6.3 4.5Z" fill="currentColor" stroke="none" /><path d="M3.5 3.5v9" /></svg>;
    case 'next':
      return <svg {...common}><path d="M5.2 3.5 11.5 8 5.2 12.5Z" fill="currentColor" stroke="none" /><path d="M12.5 3.5v9" /></svg>;
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
  itemId: string;
  locked: boolean;
  resolutionLabel: string;
  barStyle?: CSSProperties;
  resolutionStyle?: CSSProperties;
  transport?: VideoTransportState;
  preparing?: boolean;
  onPlayPause(): void;
  onScrubStart(): void;
  onScrubEnd(): void;
  onSeekFrame(frameIndex: number, sequential?: boolean, final?: boolean): void;
  onStep(frames: number): void;
  onToggleMute(): void;
  onRateChange(rate: number): void;
  onToggleLock(): void;
  pixelsPerFrame?: number;
}

function pointerSamples(event: PointerEvent) {
  const coalesced = event.getCoalescedEvents?.();
  return coalesced?.length ? coalesced : [event];
}

function frameAtTrack(
  clientX: number,
  maxFrame: number,
  track: { left?: number; width?: number; trackLeft?: number; trackWidth?: number },
) {
  const left = track.left ?? track.trackLeft ?? 0;
  const width = Math.max(1, track.width ?? track.trackWidth ?? 1);
  return Math.max(0, Math.min(maxFrame, Math.round(((clientX - left) / width) * maxFrame)));
}

function frameAtJog(jog: ScrubSession, pixelsPerFrame: number) {
  return videoScrubFrameAtDelta(
    jog.startFrame,
    jog.latestX - jog.startX,
    jog.maxFrame,
    pixelsPerFrame,
  );
}

function stopCanvasSteal(event: { stopPropagation(): void }) {
  event.stopPropagation();
}

export function VideoTransportBar({
  visible, itemId, locked, resolutionLabel, barStyle, resolutionStyle, transport, preparing,
  onPlayPause, onScrubStart, onScrubEnd, onSeekFrame, onStep, onToggleMute, onRateChange, onToggleLock,
  pixelsPerFrame = VIDEO_SCRUB_PIXELS_PER_FRAME,
}: VideoTransportBarProps) {
  const duration = Math.max(0, transport?.duration ?? 0);
  const current = Math.max(0, Math.min(duration || (transport?.currentTime ?? 0), transport?.currentTime ?? 0));
  const timingFrame = videoFrameScrubState(current, duration, transport?.fps ?? 30, transport?.frameCount);
  const frame = {
    ...timingFrame,
    currentFrame: Math.max(0, Math.min(timingFrame.maxFrame, transport?.displayedFrame ?? timingFrame.currentFrame)),
  };
  const jogRef = useRef<ScrubSession | undefined>(undefined);
  const scrubEndRef = useRef(onScrubEnd);
  scrubEndRef.current = onScrubEnd;
  const [scrubDisplay, setScrubDisplay] = useState<ScrubSession>();
  const activeFrame = scrubDisplay ?? frame;
  const localTargetFrame = scrubDisplay?.targetFrame;
  const displayedFrame = transport?.displayedFrame ?? frame.currentFrame;
  const targetFrame = localTargetFrame ?? transport?.targetFrame ?? displayedFrame;
  const playheadFrame = scrubDisplay?.dragging ? targetFrame : displayedFrame;
  const progress = activeFrame.maxFrame > 0 ? (playheadFrame / activeFrame.maxFrame) * 100 : 0;
  const targetProgress = activeFrame.maxFrame > 0 ? (targetFrame / activeFrame.maxFrame) * 100 : 0;
  const muted = transport?.muted !== false;
  const rate = transport?.rate || 1;
  const playing = Boolean(transport?.playing);
  const loading = Boolean(transport?.loading);
  useEffect(() => () => {
    const jog = jogRef.current;
    if (jog?.frameRequest !== undefined) cancelAnimationFrame(jog.frameRequest);
    if (jog?.idleTimer !== undefined) window.clearTimeout(jog.idleTimer);
    jogRef.current = undefined;
    if (jog) scrubEndRef.current();
  }, [itemId]);
  useEffect(() => {
    if (!scrubDisplay || scrubDisplay.dragging) return undefined;
    // Do not hand the timeline back to transport.currentTime until the renderer
    // confirms that the final decoded frame has actually been uploaded. A
    // matching stale currentTime during seek used to clear this snapshot early
    // and made both the thumb and counters jump backwards.
    if (transport?.scrubbing === false
      && displayedFrame === scrubDisplay.targetFrame) {
      setScrubDisplay(undefined);
    }
    return undefined;
  }, [displayedFrame, scrubDisplay, transport?.scrubbing]);
  if (!visible) return null;
  const moveJog = (event: ReactPointerEvent<HTMLDivElement>) => {
    const jog = jogRef.current;
    if (!jog || event.pointerId !== jog.pointerId) return;
    const samples = pointerSamples(event.nativeEvent);
    const bounds = event.currentTarget.getBoundingClientRect();
    jog.trackLeft = bounds.left;
    jog.trackWidth = bounds.width;
    for (const sample of samples) jog.latestX = sample.clientX;
    if (Math.abs(jog.latestX - jog.startX) >= VIDEO_SCRUB_CLICK_SLOP_PX) jog.moved = true;
    if (jog.frameRequest === undefined) {
      jog.frameRequest = requestAnimationFrame(() => {
        jog.frameRequest = undefined;
        const desiredFrame = jog.moved ? frameAtJog(jog, pixelsPerFrame) : jog.targetFrame;
        if (desiredFrame !== jog.targetFrame) {
          jog.targetFrame = desiredFrame;
          setScrubDisplay({ ...jog });
          onSeekFrame(desiredFrame, false, false);
        }
      });
    }
    if (jog.idleTimer !== undefined) window.clearTimeout(jog.idleTimer);
    jog.idleTimer = window.setTimeout(() => {
      jog.idleTimer = undefined;
      if (!jog.moved) return;
      const exactFrame = frameAtJog(jog, pixelsPerFrame);
      jog.targetFrame = exactFrame;
      setScrubDisplay({ ...jog });
      onSeekFrame(exactFrame, false, false);
    }, VIDEO_SCRUB_IDLE_RESET_MS);
  };
  const endJog = (event?: ReactPointerEvent<HTMLDivElement>) => {
    if (event && jogRef.current?.pointerId !== event.pointerId) return;
    const jog = jogRef.current;
    const started = Boolean(jog);
    jogRef.current = undefined;
    if (jog) {
      if (jog.frameRequest !== undefined) cancelAnimationFrame(jog.frameRequest);
      if (jog.idleTimer !== undefined) window.clearTimeout(jog.idleTimer);
      const exactFrame = jog.moved ? frameAtJog(jog, pixelsPerFrame) : jog.clickFrame;
      jog.targetFrame = exactFrame;
      setScrubDisplay({ ...jog, dragging: false, frameRequest: undefined, idleTimer: undefined });
      onSeekFrame(jog.targetFrame, false, true);
    }
    if (started) onScrubEnd();
  };

  return <>
    <div className="video-transport-bar no-drag" role="toolbar" aria-label="FrameRef 视频控制"
      aria-busy={loading || preparing} style={barStyle}
      onPointerDown={stopCanvasSteal} onPointerUp={stopCanvasSteal} onPointerMove={stopCanvasSteal}
      onWheel={stopCanvasSteal} onContextMenu={stopCanvasSteal} onDoubleClick={stopCanvasSteal}>
      <div className="video-transport-cluster">
        <button type="button" className="compact" title="上一帧" aria-label="上一帧" onClick={() => {
          onStep(-1);
        }}>
          <TransportIcon kind="prev" /></button>
        <button type="button" className={`compact play${playing ? ' active' : ''}`}
          title={playing ? '暂停' : loading || preparing ? '准备中…（点击取消）' : '播放'}
          aria-label={playing ? '暂停' : loading || preparing ? '取消加载' : '播放'} onClick={() => {
            onPlayPause();
          }}>
          <TransportIcon kind={playing ? 'pause' : 'play'} /></button>
        <button type="button" className="compact" title="下一帧" aria-label="下一帧" onClick={() => {
          onStep(1);
        }}>
          <TransportIcon kind="next" /></button>
      </div>

      <div className="video-transport-timeline">
        <div className="video-transport-jog" role="slider" tabIndex={0}
          aria-label="逐帧拖动" aria-valuemin={0} aria-valuemax={activeFrame.maxFrame} aria-valuenow={displayedFrame}
          aria-valuetext={`第 ${displayedFrame + 1} 帧，共 ${activeFrame.frameCount} 帧`}
          title="点击跳转，拖动逐帧查看"
          style={{ '--video-progress': `${progress}%`, '--video-target-progress': `${targetProgress}%` } as CSSProperties}
          onPointerDown={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            const clicked = frameAtTrack(event.clientX, frame.maxFrame, bounds);
            const session: ScrubSession = {
              pointerId: event.pointerId,
              targetFrame: displayedFrame,
              startFrame: displayedFrame,
              startX: event.clientX,
              clickFrame: clicked,
              duration,
              fps: frame.fps,
              frameCount: frame.frameCount,
              maxFrame: frame.maxFrame,
              dragging: true,
              moved: false,
              latestX: event.clientX,
              trackLeft: bounds.left,
              trackWidth: bounds.width,
            };
            jogRef.current = session;
            setScrubDisplay(session);
            onScrubStart();
            try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic input */ }
            moveJog(event);
          }}
          onPointerMove={moveJog}
          onPointerUp={endJog}
          onPointerCancel={endJog}
          onLostPointerCapture={endJog}
          onBlur={() => endJog()}
          onKeyDown={(event) => {
            if (event.key === ' ' || event.key === 'Enter') {
              event.preventDefault();
              onPlayPause();
              return;
            }
            if (event.key === 'Home' || event.key === 'End') {
              event.preventDefault();
              onScrubStart();
              onSeekFrame(event.key === 'Home' ? 0 : frame.maxFrame, false, false);
              onScrubEnd();
              return;
            }
            const direction = event.key === 'ArrowLeft' || event.key === 'PageDown' ? -1
              : event.key === 'ArrowRight' || event.key === 'PageUp' ? 1 : 0;
            if (!direction) return;
            event.preventDefault();
            onStep(direction * (event.shiftKey || event.key.startsWith('Page') ? 10 : 1));
          }}
        >{targetFrame !== displayedFrame && <span className="video-transport-jog-target" />}
          <span className="video-transport-jog-thumb" /></div>
        <span className="video-transport-time video-transport-frame-count">
          当前帧 {Math.min(displayedFrame + 1, activeFrame.frameCount)} / 总帧 {activeFrame.frameCount}
        </span>
      </div>

      <div className="video-transport-cluster">
        <button type="button" className={`compact${muted ? ' active' : ''}`}
          title={muted ? '取消静音' : '静音'} aria-label={muted ? '取消静音' : '静音'} onClick={onToggleMute}>
          <TransportIcon kind={muted ? 'mute' : 'unmute'} /></button>
        <label className="video-transport-rate" title="播放速度">
          <select aria-label="播放速度" value={String(rate)}
            onChange={(event) => onRateChange(Number(event.target.value))}>
            {RATES.map((value) => <option key={value} value={value}>{value}x</option>)}
          </select>
        </label>
        <button type="button" className={`compact${locked ? ' active' : ''}`}
          title={locked ? '解锁' : '锁定'} aria-label={locked ? '解锁' : '锁定'} onClick={onToggleLock}>
          <TransportIcon kind={locked ? 'lock' : 'unlock'} /></button>
      </div>
      {(loading || preparing) && <span className="video-transport-status" aria-live="polite">
        {preparing
          ? `${transport?.preparationStage === 'indexing' ? '建立帧索引' : transport?.preparationStage === 'validating' ? '校验逐帧代理' : '准备逐帧代理'}${transport?.preparationProgress ? ` ${Math.round(transport.preparationProgress * 100)}%` : ''}…`
          : transport?.phase === 'loading' ? '载入中…' : '缓冲中…'}
      </span>}
    </div>
    {resolutionLabel && <div className="video-resolution-pill no-drag" style={resolutionStyle}>{resolutionLabel}</div>}
  </>;
}
