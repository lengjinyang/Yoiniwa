import { boundedCpuImageBudget } from '../../shared/imagePipelineConfig';
import { ByteBudgetCache } from './ByteBudgetCache';

export interface DecodedImageEntry {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  estimatedBytes: number;
  pinCount: number;
  dispose(): void;
}

export function createDecodedImageEntry(bitmap: ImageBitmap): DecodedImageEntry {
  return { bitmap, width: bitmap.width, height: bitmap.height, estimatedBytes: bitmap.width * bitmap.height * 4, pinCount: 0, dispose: () => bitmap.close() };
}

export class CpuImageCache extends ByteBudgetCache<DecodedImageEntry> {
  constructor(deviceMemoryGb?: number) { super(boundedCpuImageBudget(deviceMemoryGb)); }
}
