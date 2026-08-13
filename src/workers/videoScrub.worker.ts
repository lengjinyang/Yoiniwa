import { assetResourceUrl } from '../assetResourceUrl';
import type { VideoScrubIndex } from '../videoScrub';

type InitMessage = { type: 'init'; index?: VideoScrubIndex; assetId: string; durationUs: number; frameCount: number };
type DecodeMessage = { type: 'decode'; generation: number; frameIndex: number; width: number; height: number; prefetch?: boolean };
type CloseMessage = { type: 'close' };
type CancelMessage = { type: 'cancel'; generation: number };
type IncomingMessage = InitMessage | DecodeMessage | CancelMessage | CloseMessage;

const workerScope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<IncomingMessage>) => void) | null;
};

let index: VideoScrubIndex | undefined;
let assetId = '';
let durationUs = 0;
let frameCount = 1;
let activeGeneration = 0;
const activeRequests = new Map<number, AbortController>();

function frameTimeUs(frameIndex: number) {
  const indexed = index?.frames[frameIndex];
  if (indexed) return Math.max(0, indexed.ptsUs);
  return Math.max(0, Math.round((frameIndex / Math.max(1, frameCount - 1)) * durationUs));
}

function frameBatch(message: DecodeMessage, target: number) {
  const frameBytes = message.width * message.height * 4;
  const maxByBytes = Math.max(1, Math.floor((128 * 1024 * 1024) / Math.max(1, frameBytes)));
  const count = message.prefetch ? Math.min(7, maxByBytes, frameCount) : 1;
  const before = Math.floor((count - 1) / 2);
  const start = Math.max(0, Math.min(frameCount - count, target - before));
  return { start, count };
}

function frameUrl(message: DecodeMessage, target: number, start: number, count: number) {
  return assetResourceUrl(assetId, new URLSearchParams({
    variant: 'scrub-frame',
    frame: String(target),
    start: String(start),
    count: String(count),
    width: String(message.width),
    height: String(message.height),
    timeUs: String(frameTimeUs(start)),
    generation: String(message.generation),
  }));
}

async function requestDecode(message: DecodeMessage) {
  activeGeneration = Math.max(activeGeneration, message.generation);
  const generation = message.generation;
  const target = Math.max(0, Math.min(frameCount - 1, Math.round(message.frameIndex)));
  const batch = frameBatch(message, target);
  const abort = new AbortController();
  activeRequests.set(generation, abort);
  try {
    const response = await fetch(frameUrl(message, target, batch.start, batch.count), { cache: 'no-store', signal: abort.signal });
    if (!response.ok) throw new Error(`FFmpeg 原片帧解码失败 (${response.status})`);
    const rgba = await response.arrayBuffer();
    if (generation !== activeGeneration || abort.signal.aborted) return;
    const frameBytes = message.width * message.height * 4;
    if (rgba.byteLength === 0 || rgba.byteLength % frameBytes !== 0) {
      throw new Error('FFmpeg 原片帧数据尺寸不匹配');
    }
    const decodedCount = rgba.byteLength / frameBytes;
    for (let offset = 0; offset < decodedCount; offset += 1) {
      const frameIndex = batch.start + offset;
      const pixels = new Uint8ClampedArray(rgba, offset * frameBytes, frameBytes);
      const imageData = new ImageData(pixels, message.width, message.height);
      const bitmap = await createImageBitmap(imageData, { premultiplyAlpha: 'none' });
      if (generation !== activeGeneration || abort.signal.aborted) {
        bitmap.close();
        return;
      }
      workerScope.postMessage({
        type: 'frame', assetId, frameIndex,
        width: message.width, height: message.height, generation, bitmap,
      }, [bitmap]);
    }
    workerScope.postMessage({ type: 'complete', generation, frameIndex: target });
  } finally {
    activeRequests.delete(generation);
  }
}

function cancelBefore(generation: number) {
  activeGeneration = generation;
  activeRequests.forEach((request, requestGeneration) => {
    if (requestGeneration < generation) request.abort();
  });
}

workerScope.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'init') {
    index = message.index;
    assetId = message.assetId;
    durationUs = message.durationUs;
    frameCount = Math.max(1, message.frameCount);
    workerScope.postMessage({ type: 'ready', backend: 'ffmpeg-source' });
    return;
  }
  if (message.type === 'close') {
    cancelBefore(activeGeneration + 1);
    activeRequests.forEach((request) => request.abort());
    activeRequests.clear();
    index = undefined;
    assetId = '';
    return;
  }
  if (message.type === 'cancel') {
    cancelBefore(message.generation);
    return;
  }
  void requestDecode(message).catch((error) => {
    if (message.generation === activeGeneration) workerScope.postMessage({
      type: 'error', generation: message.generation,
      message: error instanceof Error ? error.message : String(error),
    });
  });
};
