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

function requiredMipEdge(params: DesiredMipParams) {
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
