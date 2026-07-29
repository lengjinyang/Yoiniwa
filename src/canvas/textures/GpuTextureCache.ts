import type { Texture } from 'pixi.js';
import { ByteBudgetCache } from './ByteBudgetCache';
import { GPU_TEXTURE_BUDGET_BYTES } from './TextureConfig';

export interface GpuTextureEntry {
  key: string;
  texture: Texture;
  width: number;
  height: number;
  estimatedBytes: number;
  pinCount: number;
  dispose(): void;
}

export class GpuTextureCache extends ByteBudgetCache<GpuTextureEntry> {
  constructor(budgetBytes = GPU_TEXTURE_BUDGET_BYTES) { super(budgetBytes); }
}
