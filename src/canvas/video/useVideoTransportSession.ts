import { useEffect, useMemo, useRef, useState } from 'react';
import { isVideoItem } from '../../domain/media';
import type { Scene } from '../../types';
import { isVideoProxyPending, rememberVideoProxy } from '../../runtime/videoUrl';
import type { CanvasRuntime } from '../runtime/CanvasRuntime';
import type { VideoTransportState } from '../renderer/VideoRenderer';
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
    if (!selectedVideo) {
      setTransport(undefined);
      setPreparing(false);
      runtimeRef.current?.setSelectedVideo(undefined);
      return;
    }
    runtimeRef.current?.setSelectedVideo(selectedVideo.id);
    setTransport(runtimeRef.current?.getVideoTransport(selectedVideo.id));
    setPreparing(false);
  }, [runtimeRef, selectedVideo]);

  useEffect(() => {
    if (!host) return undefined;
    const disposeReady = host.onProxyReady(({ assetId, path, fps, frameCount }) => {
      rememberVideoProxy(assetId, path, fps || 30, frameCount);
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
    const disposeProgress = host.onPreparationProgress?.(({ assetId, stage, fraction }) => {
      runtimeRef.current?.setVideoPreparation(assetId, stage, fraction);
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
