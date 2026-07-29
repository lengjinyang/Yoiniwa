import { IMAGE_MIP_EDGES, MIP_OVERSAMPLE } from '../shared/imagePipelineConfig';

export interface DesiredMipParams {
  sourceWidth: number;
  sourceHeight: number;
  screenWidthCss: number;
  screenHeightCss: number;
  devicePixelRatio: number;
  availableMips?: readonly number[];
  oversample?: number;
}

export interface MipHysteresisState {
  displayedMip?: number;
  downgradeCandidate?: number;
  downgradeSince?: number;
}

export function rotatedScreenBounds(
  width: number,
  height: number,
  rotationDegrees: number,
  cameraScale: number,
) {
  const radians = rotationDegrees * Math.PI / 180;
  const cosine = Math.abs(Math.cos(radians));
  const sine = Math.abs(Math.sin(radians));
  return {
    width: (width * cosine + height * sine) * cameraScale,
    height: (width * sine + height * cosine) * cameraScale,
  };
}

export function requiredMipEdge(params: DesiredMipParams) {
  const oversample = params.oversample ?? MIP_OVERSAMPLE;
  const requiredWidth = Math.max(1, params.screenWidthCss * params.devicePixelRatio * oversample);
  const requiredHeight = Math.max(1, params.screenHeightCss * params.devicePixelRatio * oversample);
  const sourceEdge = Math.max(params.sourceWidth, params.sourceHeight);
  const screenEdge = Math.max(requiredWidth, requiredHeight);
  return Math.min(sourceEdge, Math.ceil(screenEdge));
}

export function calculateDesiredMip(params: DesiredMipParams) {
  const sourceEdge = Math.max(1, params.sourceWidth, params.sourceHeight);
  const available = [...(params.availableMips ?? IMAGE_MIP_EDGES)]
    .filter((edge) => edge <= sourceEdge)
    .concat(sourceEdge)
    .filter((edge, index, values) => values.indexOf(edge) === index)
    .sort((left, right) => left - right);
  const required = requiredMipEdge(params);
  return available.find((edge) => edge >= required) ?? available.at(-1) ?? sourceEdge;
}

/** Upgrades immediately; downgrade requires 2x excess coverage and a settled camera. */
export function selectMipWithHysteresis(
  desiredMip: number,
  requiredEdge: number,
  state: MipHysteresisState,
  options: { now: number; cameraMoving: boolean; downgradeDelayMs?: number },
): { mip: number; state: MipHysteresisState } {
  const current = state.displayedMip;
  if (current === undefined || desiredMip >= current) {
    return { mip: desiredMip, state: { displayedMip: desiredMip } };
  }
  if (options.cameraMoving || current < requiredEdge * 2) {
    return { mip: current, state: { displayedMip: current } };
  }
  const candidateSince = state.downgradeCandidate === desiredMip
    ? state.downgradeSince ?? options.now
    : options.now;
  if (options.now - candidateSince < (options.downgradeDelayMs ?? 300)) {
    return {
      mip: current,
      state: { displayedMip: current, downgradeCandidate: desiredMip, downgradeSince: candidateSince },
    };
  }
  return { mip: desiredMip, state: { displayedMip: desiredMip } };
}
