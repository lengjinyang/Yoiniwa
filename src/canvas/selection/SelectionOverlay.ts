import { Graphics, type Container } from 'pixi.js';
import type { BoardItem } from '../../types';
import type { LassoPoint } from '../publicTypes';
import type { SceneBounds } from '../scene/SceneNode';
import { unionImageBounds } from './HitTestService';
import { GROUP_RESIZE_HANDLE_SCREEN_SIZE } from '../groups/GroupPresentation';

export type TransformHandle = 'north-west' | 'north-east' | 'south-west' | 'south-east' | 'rotate';

export class SelectionOverlay {
  private readonly graphics = new Graphics();
  private selectionBounds?: SceneBounds;
  private scale = 1;
  private controlsVisible = true;
  private hidden = false;

  constructor(layer: Container) { layer.addChild(this.graphics); }

  draw(items: BoardItem[], scale: number, box?: SceneBounds, lasso?: LassoPoint[], controlsVisible = true) {
    this.scale = scale;
    this.controlsVisible = controlsVisible;
    this.selectionBounds = unionImageBounds(items);
    const lineWidth = 1 / scale;
    const handleSize = GROUP_RESIZE_HANDLE_SCREEN_SIZE / scale;
    this.graphics.clear();
    if (this.selectionBounds) {
      const bounds = this.selectionBounds;
      this.graphics.rect(bounds.x, bounds.y, bounds.width, bounds.height)
        .stroke({ color: 0x7892ff, width: lineWidth, alpha: 0.78 });
      if (controlsVisible) {
        this.cornerPoints(bounds).forEach((point) => {
          this.graphics.roundRect(point.x - handleSize / 2, point.y - handleSize / 2,
            handleSize, handleSize, 1.25 / scale)
            .fill({ color: 0x1d1f22, alpha: 0.78 })
            .stroke({ color: 0x8ca1ff, width: lineWidth, alpha: 0.76 });
        });
      }
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
    if (!this.selectionBounds || !this.controlsVisible || this.hidden) return undefined;
    const tolerance = 12 / this.scale;
    const corners: Array<[TransformHandle, { x: number; y: number }]> = [
      ...this.rotationPoints(this.selectionBounds).map((point) => ['rotate', point] as [TransformHandle, typeof point]),
      ['north-west', { x: this.selectionBounds.x, y: this.selectionBounds.y }],
      ['north-east', { x: this.selectionBounds.x + this.selectionBounds.width, y: this.selectionBounds.y }],
      ['south-west', { x: this.selectionBounds.x, y: this.selectionBounds.y + this.selectionBounds.height }],
      ['south-east', { x: this.selectionBounds.x + this.selectionBounds.width, y: this.selectionBounds.y + this.selectionBounds.height }],
    ];
    return corners.find(([, target]) => Math.hypot(point.x - target.x, point.y - target.y) <= tolerance)?.[0];
  }

  bounds() { return this.selectionBounds; }
  setHidden(hidden: boolean) { this.hidden = hidden; this.graphics.visible = !hidden; }
  destroy() { this.graphics.destroy(); }

  private cornerPoints(bounds: SceneBounds) {
    return [
      { x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.width, y: bounds.y },
      { x: bounds.x, y: bounds.y + bounds.height }, { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    ];
  }

  private rotationPoints(bounds: SceneBounds) {
    const offset = 18 / this.scale;
    return [
      { x: bounds.x - offset, y: bounds.y - offset },
      { x: bounds.x + bounds.width + offset, y: bounds.y - offset },
      { x: bounds.x - offset, y: bounds.y + bounds.height + offset },
      { x: bounds.x + bounds.width + offset, y: bounds.y + bounds.height + offset },
    ];
  }
}
