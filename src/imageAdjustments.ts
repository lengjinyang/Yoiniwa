import type { ImageItem } from './types';

export function imageGrayscaleContrast(item: Pick<ImageItem, 'grayscaleContrast'>) {
  const contrast = item.grayscaleContrast;
  return typeof contrast === 'number' && Number.isFinite(contrast) ? Math.max(0, Math.min(2, contrast)) : 1;
}

export function setImageGrayscaleContrast(item: ImageItem, contrast: number) {
  item.grayscaleContrast = Math.max(0, Math.min(2, Number.isFinite(contrast) ? contrast : 1));
}
