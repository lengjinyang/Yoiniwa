import type { ImageGroup, ImageItem } from '../../types';

export type SceneNode =
  | { kind: 'image'; id: string; value: ImageItem }
  | { kind: 'group'; id: string; value: ImageGroup };

export interface SceneBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
