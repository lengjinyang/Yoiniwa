import { convertFileSrc } from '@tauri-apps/api/core';
import { isVideoAsset } from '../domain/media';
import type { AssetRecord, ImportedImage } from '../types';
import { resolveVideoPlaybackUrl, videoPlaybackLookupFromApi } from './videoUrl';

interface ProbedVideo {
  width: number;
  height: number;
  durationSec: number;
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const run = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(values.length, Math.max(1, concurrency)) }, run));
  return results;
}

function loadVideoElement(url: string) {
  return new Promise<HTMLVideoElement>((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('视频加载超时'));
    }, 20000);
    const cleanup = () => {
      window.clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onerror = null;
    };
    video.onloadedmetadata = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(video);
    };
    video.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('视频无法解码，请确认编码受 WebView2 支持'));
    };
    video.src = url;
    video.load();
  });
}

async function probeVideoAsset(asset: AssetRecord, api?: Window['refCanvas']): Promise<ProbedVideo> {
  let url = await resolveVideoPlaybackUrl(asset.id, videoPlaybackLookupFromApi(api));
  if (!url && api?.assetFilePath) {
    url = convertFileSrc(await api.assetFilePath(asset.id));
  }
  if (!url) throw new Error('视频播放地址尚未就绪');
  const video = await loadVideoElement(url);
  try {
    const width = Math.max(1, video.videoWidth);
    const height = Math.max(1, video.videoHeight);
    if (width < 1 || height < 1) throw new Error('视频尺寸无效');
    const durationSec = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    return { width, height, durationSec };
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

/** Prefer backend metadata; only use two WebView metadata probes when a container parser could not resolve dimensions. */
export async function enrichImportedMedia(source: ImportedImage, api: Window['refCanvas']): Promise<ImportedImage> {
  if (!isVideoAsset(source.asset)) return source;
  const placeholderSize = source.asset.naturalWidth <= 1 || source.asset.naturalHeight <= 1;
  if (!placeholderSize) return source;
  try {
    const probed = await probeVideoAsset(source.asset, api);
    const asset: AssetRecord = {
      ...source.asset,
      kind: 'video',
      naturalWidth: probed.width,
      naturalHeight: probed.height,
      durationSec: probed.durationSec || source.asset.durationSec,
    };
    return { ...source, asset };
  } catch {
    throw new Error('视频尺寸无效，请确认文件完整或改用「选择图片/视频」导入');
  }
}

export function enrichImportedMediaBatch(sources: readonly ImportedImage[], api: Window['refCanvas']) {
  return mapWithConcurrency(sources, 2, (source) => enrichImportedMedia(source, api));
}
