import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useImageResource, useImageSource, type ImageVariant } from '../imageResources';
import type { ImageItem, Viewport } from '../types';

export function useSettledViewport(viewport: Viewport) {
  const [settledViewport, setSettledViewport] = useState(viewport);
  useEffect(() => {
    if (viewport.x === settledViewport.x && viewport.y === settledViewport.y && viewport.scale === settledViewport.scale) return undefined;
    const timer = window.setTimeout(() => setSettledViewport(viewport), 80);
    return () => window.clearTimeout(timer);
  }, [settledViewport, viewport]);
  return settledViewport;
}

export function PixelImageLoader({ commandId, item, viewportScale, maximumVariant, exactVariant, enabled = true, onReady }: {
  commandId?: string;
  item: ImageItem;
  viewportScale: number;
  maximumVariant?: ImageVariant;
  exactVariant?: ImageVariant;
  enabled?: boolean;
  onReady(id: string, image: HTMLImageElement): void;
}) {
  const image = useImageResource(item, viewportScale, enabled, maximumVariant, exactVariant);
  useLayoutEffect(() => {
    if (image) onReady(commandId ?? item.id, image);
  }, [commandId, image, item.id, onReady]);
  return null;
}

export function PixelUrlLoader({ commandId, itemId, src, prefetch = false, delayMs = 0, priority = 10, enabled = true, onReady, onError }: {
  commandId: string;
  itemId: string;
  src: string;
  prefetch?: boolean;
  delayMs?: number;
  priority?: number;
  enabled?: boolean;
  onReady(id: string, image: HTMLImageElement): void;
  onError(itemId: string): void;
}) {
  const handleError = useCallback(() => onError(itemId), [itemId, onError]);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const retryTimerRef = useRef<number | undefined>(undefined);
  const [delayElapsed, setDelayElapsed] = useState(delayMs <= 0);
  useEffect(() => {
    if (delayMs <= 0) {
      setDelayElapsed(true);
      return undefined;
    }
    setDelayElapsed(false);
    const timer = window.setTimeout(() => setDelayElapsed(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, src]);
  useEffect(() => {
    setRetryAttempt(0);
    return () => {
      if (retryTimerRef.current !== undefined) window.clearTimeout(retryTimerRef.current);
    };
  }, [retryTimerRef, src]);
  const retryingError = useCallback(() => {
    if (prefetch || retryAttempt >= 3) {
      handleError();
      return;
    }
    const delays = [250, 1000, 5000];
    if (retryTimerRef.current !== undefined) window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = undefined;
      setRetryAttempt((value) => value + 1);
    }, delays[retryAttempt]);
  }, [handleError, prefetch, retryAttempt, retryTimerRef]);
  useEffect(() => {
    if (enabled && delayElapsed) window.refCanvas?.boostImageResource?.(src, priority);
  }, [delayElapsed, enabled, priority, src]);
  const image = useImageSource(src, retryingError, enabled && delayElapsed, retryAttempt);
  useLayoutEffect(() => {
    if (image && !prefetch) onReady(commandId, image);
  }, [commandId, image, onReady, prefetch]);
  return null;
}
