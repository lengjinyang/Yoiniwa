import { useEffect, useMemo, useRef, useState } from 'react';
import { isVideoItem } from '../../domain/media';
import type { Scene } from '../../types';
import {
  isVideoProxyPending,
  hasCachedVideoFrameIndex,
  rememberVideoFrameIndex,
  rememberVideoProxy,
  rememberVideoTiming,
} from '../../runtime/videoUrl';
import type { CanvasRuntime } from '../runtime/CanvasRuntime';
import type { VideoTransportState } from '../renderer/VideoTypes';
import type { VideoPlaybackHost } from './videoPlaybackHost';

interface UseVideoTransportSessionOptions {
  host?: VideoPlaybackHost;
  scene: Scene;
  selectedIds: string[];
  runtimeRef: { current: CanvasRuntime | undefined };
}

function reportStatus(detail: string) {
  window.dispatchEvent(new CustomEvent('refcanvas-status', { detail }));
}

const frameIndexLoads = new Map<string, Promise<boolean>>();

async function hydrateFrameIndex(
  host: VideoPlaybackHost | undefined,
  runtimeRef: { current: CanvasRuntime | undefined },
  assetId: string,
) {
  if (hasCachedVideoFrameIndex(assetId)) {
    runtimeRef.current?.refreshVideoTiming(assetId);
    return true;
  }
  if (!host?.loadFrameIndex) return false;
  try {
    let load = frameIndexLoads.get(assetId);
    if (!load) {
      load = host.loadFrameIndex(assetId)
        .then((index) => Boolean(index && rememberVideoFrameIndex(index)))
        .catch(() => false)
        .finally(() => frameIndexLoads.delete(assetId));
      frameIndexLoads.set(assetId, load);
    }
    if (!await load) return false;
    runtimeRef.current?.refreshVideoTiming(assetId);
    return true;
  } catch {
    return false;
  }
}

export function useVideoTransportSession({
  host,
  scene,
  selectedIds,
  runtimeRef,
}: UseVideoTransportSessionOptions) {
  const [transport, setTransport] = useState<VideoTransportState>();
  const [preparing, setPreparing] = useState(false);
  const selectedVideo = useMemo(() => {
    if (selectedIds.length !== 1) return undefined;
    const item = scene.items.find((candidate) => candidate.id === selectedIds[0]);
    return item && isVideoItem(item, scene.assets) ? item : undefined;
  }, [scene.assets, scene.items, selectedIds]);
  const selectedVideoIdRef = useRef<string | undefined>(undefined);
  const selectedVideoAssetIdRef = useRef<string | undefined>(undefined);
  selectedVideoIdRef.current = selectedVideo?.id;
  selectedVideoAssetIdRef.current = selectedVideo?.assetId;

  useEffect(() => {
    let keyboardJog: { id: string; frameOffset: number } | undefined;
    const endKeyboardJog = () => {
      if (!keyboardJog) return;
      runtimeRef.current?.endCanvasVideoJog(keyboardJog.id);
      keyboardJog = undefined;
    };
    const editableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      return target.isContentEditable || Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || editableTarget(event.target)) return;
      const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
      const id = selectedVideoIdRef.current;
      const runtime = runtimeRef.current;
      if (!direction || !id || !runtime) return;
      if (keyboardJog?.id !== id) {
        endKeyboardJog();
        if (!runtime.beginCanvasVideoJog(id)) return;
        keyboardJog = { id, frameOffset: 0 };
      }
      keyboardJog.frameOffset += direction;
      if (!runtime.jogCanvasVideoFrames(id, keyboardJog.frameOffset)) {
        endKeyboardJog();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!keyboardJog || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
      event.preventDefault();
      event.stopPropagation();
      endKeyboardJog();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', endKeyboardJog);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', endKeyboardJog);
      endKeyboardJog();
    };
  }, [runtimeRef]);

  useEffect(() => {
    if (!selectedVideo) {
      setTransport(undefined);
      setPreparing(false);
      runtimeRef.current?.setSelectedVideo(undefined);
      return;
    }
    runtimeRef.current?.setSelectedVideo(selectedVideo.id);
    setTransport(runtimeRef.current?.getVideoTransport(selectedVideo.id));
    setPreparing(false);
    // Load exact PTS/duration data when available, otherwise build the source
    // frame index in the background. FPS-only math remains a temporary fallback.
    if (selectedVideo.assetId) {
      const assetId = selectedVideo.assetId;
      void hydrateFrameIndex(host, runtimeRef, assetId).then((loaded) => {
        if (!loaded) host?.prepareIndex?.(assetId);
      });
    }
  }, [host, runtimeRef, selectedVideo]);

  useEffect(() => {
    if (!host) return undefined;
    const disposeReady = host.onProxyReady(({ assetId, fps, frameCount }) => {
      rememberVideoProxy(assetId, fps || 30, frameCount);
      void hydrateFrameIndex(host, runtimeRef, assetId);
      runtimeRef.current?.resumeVideoWhenProxyReady(assetId);
      runtimeRef.current?.setVideoPreparation(assetId, 'ready', 1);
      if (assetId === selectedVideoAssetIdRef.current) setPreparing(false);
      reportStatus('视频可播放版本已就绪');
    });
    const disposeFailed = host.onProxyFailed?.(({ assetId, message, indexReady, unsupportedReason }) => {
      runtimeRef.current?.failVideoProxy(assetId);
      runtimeRef.current?.setVideoPreparation(assetId, indexReady ? 'index-ready' : 'failed', indexReady ? 0.18 : 0);
      if (assetId === selectedVideoAssetIdRef.current) setPreparing(false);
      reportStatus(unsupportedReason
        ? `视频代理不可用：${unsupportedReason}；将尝试使用原片播放`
        : `视频代理准备失败，将尝试使用原片播放：${message}`);
    });
    const disposeProgress = host.onPreparationProgress?.(({ assetId, stage, fraction, fps, frameCount }) => {
      runtimeRef.current?.setVideoPreparation(assetId, stage, fraction);
      if (stage === 'index-ready' && fps) {
        rememberVideoTiming(assetId, fps, frameCount);
        runtimeRef.current?.refreshVideoTiming(assetId);
        void hydrateFrameIndex(host, runtimeRef, assetId);
      }
      if (assetId === selectedVideoAssetIdRef.current && stage === 'failed') setPreparing(false);
    });
    return () => {
      disposeReady();
      disposeFailed?.();
      disposeProgress?.();
    };
  }, [host, runtimeRef]);

  useEffect(() => {
    const onPreparing = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; assetId?: string }>).detail;
      if (!selectedVideo) return;
      if (detail?.id === selectedVideo.id || detail?.assetId === selectedVideo.assetId) setPreparing(true);
    };
    window.addEventListener('refcanvas-video-preparing', onPreparing);
    return () => window.removeEventListener('refcanvas-video-preparing', onPreparing);
  }, [selectedVideo]);

  return {
    selectedVideo,
    transport,
    setTransport,
    preparing,
    setPreparing,
    selectedVideoIdRef,
    isProxyPending: (assetId: string) => isVideoProxyPending(assetId),
  };
}
