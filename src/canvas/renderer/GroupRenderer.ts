import { Container, Graphics, Text, type Container as PixiContainer } from 'pixi.js';
import type { ImageGroup } from '../../types';
import { RenderObjectRegistry } from './RenderObjectRegistry';

const HEADER_HEIGHT = 28;
interface GroupObject { container: Container; frame: Graphics; title: Text; destroy(): void }

export class GroupRenderer {
  private readonly objects = new RenderObjectRegistry<GroupObject>();
  private selectedId?: string;

  constructor(private readonly layer: PixiContainer) { layer.sortableChildren = true; }

  sync(groups: ImageGroup[]) {
    this.objects.retain(new Set(groups.map((group) => group.id)));
    groups.forEach((group, index) => {
      let object = this.objects.get(group.id);
      if (!object) {
        const container = new Container();
        const frame = new Graphics();
        const title = new Text({ text: '', style: { fontFamily: 'Segoe UI', fontSize: 13, fill: 0xffffff } });
        container.addChild(frame, title);
        object = { container, frame, title, destroy() { container.destroy({ children: true }); } };
        this.objects.set(group.id, object);
        this.layer.addChild(container);
      }
      this.draw(object, group, index);
    });
  }

  setSelected(id?: string) { this.selectedId = id; }
  destroy() { this.objects.destroy(); }

  private draw(object: GroupObject, group: ImageGroup, index: number) {
    const selected = group.id === this.selectedId;
    const height = group.collapsed ? HEADER_HEIGHT : group.height;
    object.container.position.set(group.x, group.y);
    object.container.visible = !group.hidden;
    object.container.alpha = group.opacity;
    object.container.zIndex = index;
    object.frame.clear().roundRect(0, 0, group.width, height, 8)
      .fill({ color: group.color, alpha: group.collapsed ? 0.24 : 0.09 })
      .stroke({ color: selected ? 0x55cfff : group.color, width: selected ? 2.5 : 1.5, alpha: 0.9 });
    object.frame.roundRect(0, 0, group.width, Math.min(HEADER_HEIGHT, height), 8)
      .fill({ color: group.titleColor || group.color, alpha: 0.86 });
    object.title.text = `${group.collapsed ? '▸' : '▾'}  ${group.name}${group.sizeLocked ? '  🔒' : ''}`;
    object.title.position.set(9, 5);
  }
}
