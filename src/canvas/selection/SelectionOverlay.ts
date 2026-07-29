import { Graphics, type Container } from 'pixi.js';
import type { ImageItem } from '../../types';
import type { SceneBounds } from '../scene/SceneNode';
import { unionImageBounds } from './HitTestService';

export type TransformHandle = 'north-west' | 'north-east' | 'south-west' | 'south-east' | 'rotate';

export class SelectionOverlay {
  private readonly graphics = new Graphics();
  private selectionBounds?: SceneBounds;
  private scale = 1;

  constructor(layer: Container) { layer.addChild(this.graphics); }

  draw(items: ImageItem[], scale: number, box?: SceneBounds) {
    this.scale = scale;
    this.selectionBounds = unionImageBounds(items);
    const lineWidth = 1.5 / scale;
    const handleSize = 9 / scale;
    this.graphics.clear();
    if (this.selectionBounds) {
      const bounds = this.selectionBounds;
      this.graphics.rect(bounds.x, bounds.y, bounds.width, bounds.height)
        .stroke({ color: 0x55cfff, width: lineWidth });
      this.cornerPoints(bounds).forEach((point) => {
        this.graphics.rect(point.x - handleSize / 2, point.y - handleSize / 2, handleSize, handleSize)
          .fill({ color: 0xffffff }).stroke({ color: 0x168fbd, width: lineWidth });
      });
      const rotate = { x: bounds.x + bounds.width / 2, y: bounds.y - 28 / scale };
      this.graphics.moveTo(bounds.x + bounds.width / 2, bounds.y).lineTo(rotate.x, rotate.y)
        .stroke({ color: 0x55cfff, width: lineWidth });
      this.graphics.circle(rotate.x, rotate.y, handleSize / 2).fill({ color: 0xffffff })
        .stroke({ color: 0x168fbd, width: lineWidth });
    }
    if (box) this.graphics.rect(box.x, box.y, box.width, box.height)
      .fill({ color: 0x55cfff, alpha: 0.12 }).stroke({ color: 0x55cfff, width: lineWidth });
  }

  hit(point: { x: number; y: number }): TransformHandle | undefined {
    if (!this.selectionBounds) return undefined;
    const tolerance = 12 / this.scale;
    const corners: Array<[TransformHandle, { x: number; y: number }]> = [
      ['north-west', { x: this.selectionBounds.x, y: this.selectionBounds.y }],
      ['north-east', { x: this.selectionBounds.x + this.selectionBounds.width, y: this.selectionBounds.y }],
      ['south-west', { x: this.selectionBounds.x, y: this.selectionBounds.y + this.selectionBounds.height }],
      ['south-east', { x: this.selectionBounds.x + this.selectionBounds.width, y: this.selectionBounds.y + this.selectionBounds.height }],
      ['rotate', { x: this.selectionBounds.x + this.selectionBounds.width / 2, y: this.selectionBounds.y - 28 / this.scale }],
    ];
    return corners.find(([, target]) => Math.hypot(point.x - target.x, point.y - target.y) <= tolerance)?.[0];
  }

  bounds() { return this.selectionBounds; }
  destroy() { this.graphics.destroy(); }

  private cornerPoints(bounds: SceneBounds) {
    return [
      { x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.width, y: bounds.y },
      { x: bounds.x, y: bounds.y + bounds.height }, { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    ];
  }
}
