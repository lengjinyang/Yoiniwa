import type { ImageItem, Viewport } from '../../types';
import { CANVAS_MIP_EDGES, CANVAS_MIP_OVERSAMPLE } from './TextureConfig';

export interface MipSelectionState {
  displayedMip?: number;
  downgradeCandidate?: number;
  downgradeSince?: number;
}

export function requiredImageEdge(item: ImageItem, viewport: Viewport, devicePixelRatio: number) {
  const radians = item.rotation * Math.PI / 180;
  const screenWidth = (Math.abs(item.width * Math.cos(radians)) + Math.abs(item.height * Math.sin(radians))) * viewport.scale;
  const screenHeight = (Math.abs(item.width * Math.sin(radians)) + Math.abs(item.height * Math.cos(radians))) * viewport.scale;
  return Math.min(Math.max(item.naturalWidth, item.naturalHeight), Math.ceil(
    Math.max(screenWidth, screenHeight) * devicePixelRatio * CANVAS_MIP_OVERSAMPLE,
  ));
}

export function desiredImageMip(item: ImageItem, viewport: Viewport, devicePixelRatio: number) {
  const sourceEdge = Math.max(1, item.naturalWidth, item.naturalHeight);
  // Full-resolution sources above 4096 are serviced by the tile plane; they are
  // never promoted to one oversized WebGL texture.
  const maximumWholeTextureEdge = Math.min(sourceEdge, 4096);
  const available = [...CANVAS_MIP_EDGES.filter((edge) => edge <= maximumWholeTextureEdge), maximumWholeTextureEdge]
    .filter((edge, index, values) => values.indexOf(edge) === index).sort((a, b) => a - b);
  const required = requiredImageEdge(item, viewport, devicePixelRatio);
  return available.find((edge) => edge >= required) ?? available.at(-1) ?? sourceEdge;
}

export function mipWithHysteresis(options: {
  desired: number; required: number; state: MipSelectionState; now: number; cameraMoving: boolean; downgradeDelayMs?: number;
}) {
  const current = options.state.displayedMip;
  // Keep the on-screen plane stable while the camera is moving. Upgrades wait
  // until the gesture settles so pan/zoom is not fighting decode/upload work.
  if (current === undefined) return { mip: options.desired, state: { displayedMip: options.desired } };
  if (options.cameraMoving) return { mip: current, state: { displayedMip: current } };
  if (options.desired >= current) return { mip: options.desired, state: { displayedMip: options.desired } };
  if (current < options.required * 2) return { mip: current, state: { displayedMip: current } };
  const since = options.state.downgradeCandidate === options.desired ? options.state.downgradeSince ?? options.now : options.now;
  if (options.now - since < (options.downgradeDelayMs ?? 300)) {
    return { mip: current, state: { displayedMip: current, downgradeCandidate: options.desired, downgradeSince: since } };
  }
  return { mip: options.desired, state: { displayedMip: options.desired } };
}
