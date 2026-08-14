import type { BoardItem, Viewport } from '../../types';
import { calculateDesiredMip, rotatedScreenBounds } from '../../rendering/textureSelection';
import { CANVAS_MIP_EDGES, CANVAS_MIP_OVERSAMPLE } from './TextureConfig';

export interface MipSelectionState {
  displayedMip?: number;
  downgradeCandidate?: number;
  downgradeSince?: number;
}

export function requiredImageEdge(item: BoardItem, viewport: Viewport, devicePixelRatio: number) {
  const screen = rotatedScreenBounds(item.width, item.height, item.rotation, viewport.scale);
  return Math.min(Math.max(item.naturalWidth, item.naturalHeight), Math.ceil(
    Math.max(screen.width, screen.height) * devicePixelRatio * CANVAS_MIP_OVERSAMPLE,
  ));
}

export function desiredImageMip(item: BoardItem, viewport: Viewport, devicePixelRatio: number) {
  const sourceEdge = Math.max(1, item.naturalWidth, item.naturalHeight);
  // Full-resolution sources above 4096 are serviced by the tile plane; they are
  // never promoted to one oversized WebGL texture.
  const maximumWholeTextureEdge = Math.min(sourceEdge, 4096);
  const available = [...CANVAS_MIP_EDGES.filter((edge) => edge <= maximumWholeTextureEdge), maximumWholeTextureEdge]
    .filter((edge, index, values) => values.indexOf(edge) === index).sort((a, b) => a - b);
  const screen = rotatedScreenBounds(item.width, item.height, item.rotation, viewport.scale);
  return calculateDesiredMip({
    sourceWidth: item.naturalWidth,
    sourceHeight: item.naturalHeight,
    screenWidthCss: screen.width,
    screenHeightCss: screen.height,
    devicePixelRatio,
    availableMips: available,
    oversample: CANVAS_MIP_OVERSAMPLE,
    allowSourceEdge: false,
  });
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
