import { Graphics, type Container } from 'pixi.js';
import type { ImageGroup } from '../../types';
import { GROUP_RESIZE_HANDLE_SCREEN_SIZE, groupHeaderWorldBounds } from '../groups/GroupPresentation';
import type { GroupResizeHandle } from '../publicTypes';

export class GroupResizeOverlay {
  private readonly graphics = new Graphics();
  private group?: ImageGroup;
  private resizable = false;
  private muted = false;
  private hidden = false;
  private scale = 1;

  constructor(layer: Container) { layer.addChild(this.graphics); }

  draw(group: ImageGroup | undefined, scale: number) {
    this.group = group?.hidden || group?.collapsed ? undefined : group;
    this.resizable = Boolean(this.group && !this.group.sizeLocked);
    this.scale = Math.max(scale, 0.0001);
    const lineWidth = 1 / this.scale;
    this.graphics.clear();
    if (!this.group) return;
    const header = groupHeaderWorldBounds(this.group, this.scale);
    const outerHeight = this.group.y + this.group.height - header.y;
    const radius = Math.min(6 / this.scale, this.group.width / 2, outerHeight / 2);
    this.graphics.roundRect(header.x, header.y, this.group.width, outerHeight, radius)
      .stroke({ color: 0x7892ff, width: lineWidth, alpha: this.muted ? 0.42 : this.resizable ? 0.78 : 0.46 });
    if (!this.muted) {
      if (this.resizable) this.points(this.group).forEach(([handle, point]) => {
        const corner = handle.includes('-');
        const handleSize = (corner ? GROUP_RESIZE_HANDLE_SCREEN_SIZE : 5) / this.scale;
        this.graphics.roundRect(point.x - handleSize / 2, point.y - handleSize / 2,
          handleSize, handleSize, 1.25 / this.scale)
          .fill({ color: 0x1d1f22, alpha: corner ? 0.78 : 0.56 })
          .stroke({ color: 0x8ca1ff, width: lineWidth, alpha: corner ? 0.76 : 0.52 });
      });
    }
  }

  setMuted(muted: boolean) {
    if (this.muted === muted) return;
    this.muted = muted;
    this.draw(this.group, this.scale);
  }

  hit(point: { x: number; y: number }): GroupResizeHandle | undefined {
    if (!this.group || this.muted || this.hidden) return undefined;
    const tolerance = 12 / this.scale;
    const rotate = this.rotationPoints(this.group)
      .find((target) => Math.hypot(point.x - target.x, point.y - target.y) <= tolerance);
    if (rotate) return 'rotate';
    if (!this.resizable) return undefined;
    return this.points(this.group)
      .find(([, target]) => Math.hypot(point.x - target.x, point.y - target.y) <= tolerance)?.[0];
  }

  destroy() { this.graphics.destroy(); }

  setHidden(hidden: boolean) { this.hidden = hidden; this.graphics.visible = !hidden; }

  private points(group: ImageGroup): Array<[GroupResizeHandle, { x: number; y: number }]> {
    const header = groupHeaderWorldBounds(group, this.scale);
    const right = group.x + group.width;
    const bottom = group.y + group.height;
    const middleY = header.y + (bottom - header.y) / 2;
    return [
      ['north-west', { x: group.x, y: header.y }],
      ['north', { x: group.x + group.width / 2, y: header.y }],
      ['north-east', { x: right, y: header.y }],
      ['west', { x: group.x, y: middleY }],
      ['east', { x: right, y: middleY }],
      ['south-west', { x: group.x, y: bottom }],
      ['south', { x: group.x + group.width / 2, y: bottom }],
      ['south-east', { x: right, y: bottom }],
    ];
  }

  private rotationPoints(group: ImageGroup) {
    const header = groupHeaderWorldBounds(group, this.scale);
    const right = group.x + group.width;
    const bottom = group.y + group.height;
    const offset = 18 / this.scale;
    return [
      { x: group.x - offset, y: header.y - offset },
      { x: right + offset, y: header.y - offset },
      { x: group.x - offset, y: bottom + offset },
      { x: right + offset, y: bottom + offset },
    ];
  }
}
