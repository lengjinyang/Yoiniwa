import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DisplayableMedia, ImageThumbnailReady, BoardItem } from '../types';
import { performanceMonitor } from './performanceMonitor';
import { boundedCpuImageBudget } from '../shared/imagePipelineConfig';
import { calculateDesiredMip, rotatedScreenBounds } from '../shared/textureSelection';
import { assetResourceUrl, isAssetResourceUrl } from './assetResourceUrl';
import { displayAssetId } from '../domain/media';

export type ImageVariant = 'thumb128' | 'thumb256' | 'thumb512' | 'thumb768' | 'thumb1024' | 'original';

interface CacheEntry {
  image: HTMLImageElement;
  refs: number;
  bytes: number;
  lastUsed: number;
  listeners: Set<(image: HTMLImageElement) => void>;
  errorListeners: Set<() => void>;
  releaseTimer?: number;
}

const cache = new Map<string, CacheEntry>();
const preloadPromises = new Map<string, Promise<boolean>>();
const deviceMemory = typeof navigator === 'undefined' ? undefined
  : (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
const MAX_UNUSED_BYTES = boundedCpuImageBudget(deviceMemory);
const RESOURCE_UPGRADE_DELAY_MS = 120;
const ORIGINAL_FALLBACK_DELAY_MS = 650;
const VARIANT_RANK: Record<ImageVariant, number> = {
  thumb128: 0, thumb256: 1, thumb512: 2, thumb768: 3, thumb1024: 4, original: 5,
};
const thumbnailRevisions = new Map<string, number>();
const thumbnailListeners = new Map<string, Set<() => void>>();
let thumbnailReadyUnsubscribe: (() => void) | undefined;

function thumbnailRevisionKey(assetId: string | undefined, variant: ImageVariant) {
  return `${assetId ?? ''}:${variant}`;
}

function publishThumbnailReady(thumbnail: ImageThumbnailReady) {
  const key = thumbnailRevisionKey(thumbnail.assetId, thumbnail.variant);
  thumbnailRevisions.set(key, (thumbnailRevisions.get(key) ?? 0) + 1);
  thumbnailListeners.get(key)?.forEach((listener) => listener());
}

function ensureThumbnailReadySubscription() {
  if (thumbnailReadyUnsubscribe || typeof window === 'undefined') return;
  const api = window.refCanvas;
  if (!api?.onThumbnailReady) return;
  thumbnailReadyUnsubscribe = api.onThumbnailReady(publishThumbnailReady);
}

function useThumbnailRevision(assetId: string | undefined, variant: ImageVariant) {
  const key = thumbnailRevisionKey(assetId, variant);
  const [revision, setRevision] = useState(() => thumbnailRevisions.get(key) ?? 0);
  useEffect(() => {
    setRevision(thumbnailRevisions.get(key) ?? 0);
    if (!assetId || variant === 'original') return undefined;
    ensureThumbnailReadySubscription();
    const update = () => setRevision(thumbnailRevisions.get(key) ?? 0);
    const listeners = thumbnailListeners.get(key) ?? new Set<() => void>();
    listeners.add(update);
    thumbnailListeners.set(key, listeners);
    return () => {
      listeners.delete(update);
      if (!listeners.size) thumbnailListeners.delete(key);
    };
  }, [assetId, key, variant]);
  return revision;
}

export function chooseImageVariant(
  item: Pick<BoardItem, 'width' | 'height'> & Partial<Pick<BoardItem, 'naturalWidth' | 'naturalHeight' | 'rotation'>>,
  viewportScale: number,
  pixelRatio = window.devicePixelRatio || 1,
): ImageVariant {
  const bounds = rotatedScreenBounds(item.width, item.height, item.rotation ?? 0, viewportScale);
  const mip = calculateDesiredMip({
    sourceWidth: item.naturalWidth ?? item.width,
    sourceHeight: item.naturalHeight ?? item.height,
    screenWidthCss: bounds.width,
    screenHeightCss: bounds.height,
    devicePixelRatio: pixelRatio,
    availableMips: [128, 256, 512, 1024],
  });
  if (mip <= 128) return 'thumb128';
  if (mip <= 256) return 'thumb256';
  if (mip <= 512) return 'thumb512';
  if (mip <= 1024) return 'thumb1024';
  return 'original';
}

function cappedImageVariant(variant: ImageVariant, maximumVariant: ImageVariant) {
  return VARIANT_RANK[variant] > VARIANT_RANK[maximumVariant] ? maximumVariant : variant;
}

export function imageVariantCandidates(hasDataUrl: boolean, variant: ImageVariant, exactVariant?: ImageVariant) {
  return hasDataUrl || exactVariant || variant === 'thumb128'
    ? [variant]
    : ['thumb128' as const, variant];
}

export function imageSource(
  item: DisplayableMedia,
  variant: ImageVariant = 'original',
  revision = 0,
) {
  if (item.dataUrl) return item.dataUrl;
  const assetId = displayAssetId(item) ?? '';
  if (item.mediaKind === 'video' && !item.posterAssetId) {
    const edge = variant === 'original' ? 2048 : Number(variant.replace('thumb', '')) || 512;
    const query = new URLSearchParams({ variant: 'video-poster', edge: String(edge) });
    if (revision > 0) query.set('v', String(revision));
    return assetResourceUrl(assetId, query);
  }
  const query = new URLSearchParams({ variant });
  if (revision > 0) query.set('v', String(revision));
  return assetResourceUrl(assetId, query);
}

function useSettledVariant(variant: ImageVariant) {
  const [settledVariant, setSettledVariant] = useState(variant);
  useEffect(() => {
    if (variant === settledVariant) return undefined;
    // Quality upgrades must not wait for the viewport to become idle. Downgrades
    // are delayed so a short zoom reversal keeps the finer decoded resource.
    if (VARIANT_RANK[variant] > VARIANT_RANK[settledVariant]) {
      setSettledVariant(variant);
      return undefined;
    }
    const timer = window.setTimeout(() => setSettledVariant(variant), RESOURCE_UPGRADE_DELAY_MS * 2);
    return () => window.clearTimeout(timer);
  }, [settledVariant, variant]);
  return settledVariant;
}

export function cropForResource(item: Pick<BoardItem, 'crop' | 'naturalWidth' | 'naturalHeight'>, resourceWidth: number, resourceHeight: number) {
  const scaleX = resourceWidth / Math.max(1, item.naturalWidth);
  const scaleY = resourceHeight / Math.max(1, item.naturalHeight);
  return {
    x: item.crop.x * scaleX,
    y: item.crop.y * scaleY,
    width: item.crop.width * scaleX,
    height: item.crop.height * scaleY,
  };
}

/**
 * Pick the least-recently-used unreferenced entries to drop until the unused
 * bytes fit the budget. Retained entries are deliberately excluded from the
 * total: they cannot be evicted here, so counting them would keep the budget
 * permanently exceeded and drain every unused entry on each trim.
 */
export function selectUnusedEvictions<K>(
  entries: Iterable<[K, { refs: number; bytes: number; lastUsed: number }]>,
  maxUnusedBytes: number,
) {
  const unused = [...entries].filter(([, entry]) => entry.refs === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  let bytes = unused.reduce((total, [, entry]) => total + entry.bytes, 0);
  const evicted: K[] = [];
  for (const [key, entry] of unused) {
    if (bytes <= maxUnusedBytes) break;
    bytes -= entry.bytes;
    evicted.push(key);
  }
  return evicted;
}

function trimUnusedCache() {
  for (const key of selectUnusedEvictions(cache, MAX_UNUSED_BYTES)) {
    const entry = cache.get(key);
    if (!entry) continue;
    entry.image.src = '';
    cache.delete(key);
  }
}

function canonicalImageResourceKey(src: string) {
  if (!isAssetResourceUrl(src)) return src;
  const url = new URL(src);
  url.searchParams.delete('priority');
  return url.toString();
}

export function deleteCacheEntryIfCurrent<K, V>(entries: Map<K, V>, key: K, entry: V) {
  if (entries.get(key) !== entry) return false;
  entries.delete(key);
  return true;
}

export function releaseCacheEntryReference<T>(entry: {
  refs: number;
  listeners: Set<T>;
  errorListeners: Set<() => void>;
  lastUsed: number;
}, listener: T, errorListener?: () => void, now = performance.now()) {
  entry.refs = Math.max(0, entry.refs - 1);
  entry.listeners.delete(listener);
  if (errorListener) entry.errorListeners.delete(errorListener);
  entry.lastUsed = now;
}

function retainImage(src: string, onReady: (image: HTMLImageElement) => void, onError?: () => void) {
  src = canonicalImageResourceKey(src);
  let entry = cache.get(src);
  if (!entry) {
    const decodeStartedAt = performanceMonitor.enabled ? performance.now() : 0;
    const image = new Image();
    image.decoding = 'async';
    if (isAssetResourceUrl(src)) image.crossOrigin = 'anonymous';
    entry = { image, refs: 0, bytes: 0, lastUsed: performance.now(), listeners: new Set(), errorListeners: new Set() };
    cache.set(src, entry);
    image.onload = () => {
      if (performanceMonitor.enabled) performanceMonitor.recordImageDecode(performance.now() - decodeStartedAt);
      entry!.bytes = image.naturalWidth * image.naturalHeight * 4;
      entry!.listeners.forEach((listener) => listener(image));
      trimUnusedCache();
    };
    const retainedEntry = entry;
    image.onerror = () => {
      retainedEntry.errorListeners.forEach((listener) => listener());
      deleteCacheEntryIfCurrent(cache, src, retainedEntry);
    };
    image.src = src;
  } else {
    if (entry.image.complete && entry.image.naturalWidth) queueMicrotask(() => onReady(entry!.image));
  }
  entry.listeners.add(onReady);
  if (onError) entry.errorListeners.add(onError);
  entry.refs += 1;
  entry.lastUsed = performance.now();
  if (entry.releaseTimer) window.clearTimeout(entry.releaseTimer);
  const retainedEntry = entry;
  return () => {
    releaseCacheEntryReference(retainedEntry, onReady, onError);
    if (retainedEntry.refs === 0 && cache.get(src) === retainedEntry) {
      // Leaving the visible/preload set must release the Chromium request too;
      // otherwise an obsolete high-resolution decode can finish and consume the
      // byte budget long after a fast pan or zoom moved elsewhere.
      if (!retainedEntry.image.complete) {
        retainedEntry.image.onload = null;
        retainedEntry.image.onerror = null;
        retainedEntry.image.src = '';
        cache.delete(src);
        return;
      }
      retainedEntry.releaseTimer = window.setTimeout(() => trimUnusedCache(), 2000);
    }
  };
}

function readyCachedImage(src: string) {
  const image = cache.get(canonicalImageResourceKey(src))?.image;
  return image?.complete && image.naturalWidth > 0 ? image : undefined;
}

export function boundedPreviewSize(width: number, height: number, maximumEdge = 128) {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const scale = Math.min(1, Math.max(1, maximumEdge) / Math.max(safeWidth, safeHeight));
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  };
}

function preloadImageSource(src: string) {
  src = canonicalImageResourceKey(src);
  if (readyCachedImage(src)) return Promise.resolve(true);
  const existing = preloadPromises.get(src);
  if (existing) return existing;
  const task = (async () => {
    try {
      const response = await fetch(src, { cache: 'no-store' });
      if (!response.ok) return false;
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      try {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
          const next = new Image();
          next.decoding = 'async';
          next.onload = () => resolve(next);
          next.onerror = () => reject(new Error('图片预解码失败'));
          next.src = objectUrl;
        });
        cache.set(src, {
          image,
          refs: 0,
          bytes: image.naturalWidth * image.naturalHeight * 4,
          lastUsed: performance.now(),
          listeners: new Set(),
          errorListeners: new Set(),
        });
        trimUnusedCache();
        return true;
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    } catch {
      return false;
    }
  })().finally(() => preloadPromises.delete(src));
  preloadPromises.set(src, task);
  return task;
}

export async function preloadImagePreview(
  item: DisplayableMedia,
  revision = 0,
  _maximumEdge = 128,
) {
  const previewSrc = imageSource(item, 'thumb128', revision);
  if (await preloadImageSource(previewSrc)) return true;
  // The renderer must never decode a full original merely to manufacture a fallback.
  // A missing committed preview is surfaced as an import/cache error instead.
  return false;
}

export function useImageResource(
  item: DisplayableMedia & Pick<BoardItem, 'width' | 'height'>,
  viewportScale: number,
  enabled = true,
  maximumVariant: ImageVariant = 'original',
  exactVariant?: ImageVariant,
) {
  const displayId = displayAssetId(item);
  const targetVariant = cappedImageVariant(exactVariant ?? chooseImageVariant(item, viewportScale), maximumVariant);
  const settledVariant = useSettledVariant(targetVariant);
  // Upgrades keep the previous decoded image visible until the new resource is
  // ready; downgrades are delayed to avoid churn around an LOD boundary.
  const variant = exactVariant ? targetVariant : cappedImageVariant(settledVariant, maximumVariant);
  const targetRevision = useThumbnailRevision(displayId, variant);
  const previewRevision = useThumbnailRevision(displayId, 'thumb128');
  // Pass the fields imageSource actually reads rather than the whole item, so
  // the dependency list stays checkable and a new BoardItem identity alone does
  // not rebuild the source URL.
  const { dataUrl, mediaKind, posterAssetId } = item;
  const src = useMemo(
    () => imageSource({ assetId: displayId, dataUrl, mediaKind, posterAssetId }, variant, targetRevision),
    [dataUrl, displayId, mediaKind, posterAssetId, targetRevision, variant],
  );
  const assetKey = item.dataUrl || displayId || '';
  const [resource, setResource] = useState<{ assetKey: string; rank: number; image: HTMLImageElement } | undefined>(() => {
    const targetImage = readyCachedImage(src);
    if (targetImage) return { assetKey, rank: VARIANT_RANK[variant], image: targetImage };
    if (exactVariant) return undefined;
    const previewImage = readyCachedImage(imageSource(item, 'thumb128', previewRevision));
    return previewImage ? { assetKey, rank: VARIANT_RANK.thumb128, image: previewImage } : undefined;
  });
  const [originalFallbackAssetKey, setOriginalFallbackAssetKey] = useState<string>();
  const reportResourceError = useCallback(() => {
    window.dispatchEvent(new CustomEvent('refcanvas-resource-error', { detail: displayId ?? item.assetId ?? 'unknown' }));
  }, [displayId, item.assetId]);

  useEffect(() => {
    if (!enabled || originalFallbackAssetKey !== assetKey || !displayId || item.dataUrl || item.mediaKind === 'video') return undefined;
    let canceled = false;
    let release: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      release = retainImage(imageSource({ assetId: displayId, dataUrl: item.dataUrl }, 'original'), (nextImage) => {
        if (canceled) return;
        setResource((current) => current?.assetKey === assetKey && current.rank > VARIANT_RANK.original
          ? current
          : { assetKey, rank: VARIANT_RANK.original, image: nextImage });
      }, reportResourceError);
    }, ORIGINAL_FALLBACK_DELAY_MS);
    return () => {
      canceled = true;
      window.clearTimeout(timer);
      release?.();
    };
  }, [assetKey, displayId, enabled, item.dataUrl, item.mediaKind, originalFallbackAssetKey, reportResourceError]);

  useEffect(() => {
    if (!enabled) {
      setResource(undefined);
      return undefined;
    }
    let canceled = false;
    const releases: Array<() => void> = [];
    let failed = 0;
    const candidates = imageVariantCandidates(Boolean(item.dataUrl), variant, exactVariant);
    const uniqueCandidates = [...new Set(candidates)];
    const accept = (candidate: ImageVariant) => (nextImage: HTMLImageElement) => {
      if (canceled) return;
      setResource((current) => current?.assetKey === assetKey && current.rank > VARIANT_RANK[candidate]
        ? current
        : { assetKey, rank: VARIANT_RANK[candidate], image: nextImage });
      if (candidate !== 'original') setOriginalFallbackAssetKey(undefined);
    };
    const fail = () => {
      failed += 1;
      if (failed < uniqueCandidates.length || canceled) return;
      if (exactVariant === 'thumb128' && displayId && !item.dataUrl) {
        // Some valid WebP/GIF files are decoded by Chromium but not by the
        // native image pipeline. Decode the original once in the
        // renderer and cache only a bounded preview so the object cannot remain
        // selectable-but-blank or consume an original-sized atlas slot.
        void preloadImagePreview(item, targetRevision).then((ready) => {
          if (canceled) return;
          const preview = ready ? readyCachedImage(src) : undefined;
          if (preview) accept('thumb128')(preview);
          else reportResourceError();
        });
        return;
      }
      // Exact higher-LOD commands already have a separate permanent preview
      // plane. Do not decode the original or duplicate the 128px preview under
      // the detail command; thumbnail-ready will retry this exact URL.
      if (exactVariant && exactVariant !== 'original') return;
      if (variant !== 'original' && displayId && !item.dataUrl && item.mediaKind !== 'video') {
        // Cold derivatives fail quickly while the worker creates them. Give
        // thumbnail-ready a short window before decoding originals as a
        // fallback, otherwise a batch import can decode every full source.
        setOriginalFallbackAssetKey(assetKey);
      } else reportResourceError();
    };
    uniqueCandidates.forEach((candidate) => {
      const candidateSrc = candidate === variant ? src : imageSource(item, candidate, previewRevision);
      releases.push(retainImage(candidateSrc, accept(candidate), fail));
    });
    return () => {
      canceled = true;
      releases.forEach((release) => release());
    };
  }, [assetKey, displayId, enabled, exactVariant, item, previewRevision, reportResourceError, src, targetRevision, variant]);
  return resource?.assetKey === assetKey ? resource.image : undefined;
}
