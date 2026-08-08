import { Graphics, type Container } from 'pixi.js';
import type { ImageItem } from '../../types';
import type { LassoPoint } from './SelectionController';
import type { SceneBounds } from '../scene/SceneNode';
import { unionImageBounds } from './HitTestService';
import { GROUP_RESIZE_HANDLE_SCREEN_SIZE } from '../groups/GroupPresentation';

export type TransformHandle = 'north-west' | 'north-east' | 'south-west' | 'south-east' | 'rotate';

export class SelectionOverlay {
  private readonly graphics = new Graphics();
  private selectionBounds?: SceneBounds;
  private scale = 1;

  constructor(layer: Container) { layer.addChild(this.graphics); }

  draw(items: ImageItem[], scale: number, box?: SceneBounds, lasso?: LassoPoint[]) {
    this.scale = scale;
    this.selectionBounds = unionImageBounds(items);
    const lineWidth = 1 / scale;
    const handleSize = GROUP_RESIZE_HANDLE_SCREEN_SIZE / scale;
    this.graphics.clear();
    if (this.selectionBounds) {
      const bounds = this.selectionBounds;
      this.graphics.rect(bounds.x, bounds.y, bounds.width, bounds.height)
        .stroke({ color: 0x7892ff, width: lineWidth, alpha: 0.78 });
      this.cornerPoints(bounds).forEach((point) => {
        this.graphics.roundRect(point.x - handleSize / 2, point.y - handleSize / 2,
          handleSize, handleSize, 1.25 / scale)
          .fill({ color: 0x1d1f22, alpha: 0.78 })
          .stroke({ color: 0x8ca1ff, width: lineWidth, alpha: 0.76 });
      });
      const rotate = { x: bounds.x + bounds.width / 2, y: bounds.y - 28 / scale };
      this.graphics.moveTo(bounds.x + bounds.width / 2, bounds.y).lineTo(rotate.x, rotate.y)
        .stroke({ color: 0x7892ff, width: lineWidth, alpha: 0.62 });
      this.graphics.roundRect(rotate.x - handleSize / 2, rotate.y - handleSize / 2,
        handleSize, handleSize, 1.25 / scale)
        .fill({ color: 0x1d1f22, alpha: 0.78 })
        .stroke({ color: 0x8ca1ff, width: lineWidth, alpha: 0.76 });
    }
    if (box) this.graphics.rect(box.x, box.y, box.width, box.height)
      .fill({ color: 0x708cff, alpha: 0.1 }).stroke({ color: 0x708cff, width: lineWidth });
    if (lasso?.length) {
      this.graphics.moveTo(lasso[0].x, lasso[0].y);
      for (const point of lasso.slice(1)) this.graphics.lineTo(point.x, point.y);
      if (lasso.length > 2) this.graphics.closePath();
      this.graphics.fill({ color: 0x708cff, alpha: 0.1 }).stroke({ color: 0x8ca1ff, width: lineWidth, alpha: 0.9 });
    }
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
