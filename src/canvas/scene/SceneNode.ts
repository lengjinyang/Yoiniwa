import type { ImageGroup, SceneItem } from '../../types';

export type SceneNode =
  | { kind: 'image'; id: string; value: SceneItem }
  | { kind: 'group'; id: string; value: ImageGroup };

export interface SceneBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
