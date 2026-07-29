import { Container, Graphics, Text, type Container as PixiContainer } from 'pixi.js';
import type { ImageItem } from '../../types';
import { RenderObjectRegistry } from './RenderObjectRegistry';

interface CommentObject { container: Container; background: Graphics; text: Text; destroy(): void }

export class CommentRenderer {
  private readonly objects = new RenderObjectRegistry<CommentObject>();
  constructor(private readonly layer: PixiContainer) {}
  sync(items: ImageItem[]) {
    const comments = items.filter((item) => item.comment && !item.hidden);
    this.objects.retain(new Set(comments.map((item) => item.id)));
    comments.forEach((item) => {
      let object = this.objects.get(item.id);
      if (!object) {
        const container = new Container(); const background = new Graphics();
        const text = new Text({ text: '', style: { fontFamily: 'Segoe UI', fontSize: 12, fill: 0xf3f6f8, wordWrap: true, wordWrapWidth: 180 } });
        container.addChild(background, text);
        object = { container, background, text, destroy: () => container.destroy({ children: true }) };
        this.objects.set(item.id, object); this.layer.addChild(container);
      }
      object.text.text = item.comment as string;
      object.text.position.set(8, 6);
      const width = Math.min(196, Math.max(80, object.text.width + 16)); const height = object.text.height + 12;
      object.background.clear().roundRect(0, 0, width, height, 6).fill({ color: 0x101419, alpha: 0.9 }).stroke({ color: 0x52606d, width: 1 });
      object.container.position.set(item.x + item.width + 10, item.y);
    });
  }
  destroy() { this.objects.destroy(); }
}
