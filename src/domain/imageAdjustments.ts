import type { BoardItem } from './sceneTypes';

export function imageGrayscaleContrast(item: Pick<BoardItem, 'grayscaleContrast'>) {
  const contrast = item.grayscaleContrast;
  return typeof contrast === 'number' && Number.isFinite(contrast) ? Math.max(0, Math.min(2, contrast)) : 1;
}

export function setImageGrayscaleContrast(item: BoardItem, contrast: number) {
  item.grayscaleContrast = Math.max(0, Math.min(2, Number.isFinite(contrast) ? contrast : 1));
}
