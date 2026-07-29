import type { AnnotationItem, ImageGroup, ImageItem } from '../../types';

export type SceneNode =
  | { kind: 'image'; id: string; value: ImageItem }
  | { kind: 'group'; id: string; value: ImageGroup }
  | { kind: 'annotation'; id: string; value: AnnotationItem };

export interface SceneBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
