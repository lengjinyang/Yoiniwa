import { Graphics, type Container } from 'pixi.js';
import type { AnnotationItem } from '../../types';
import { RenderObjectRegistry } from './RenderObjectRegistry';

interface AnnotationObject { graphics: Graphics; destroy(): void }

export class AnnotationRenderer {
  private readonly objects = new RenderObjectRegistry<AnnotationObject>();
  constructor(private readonly layer: Container) {}

  sync(annotations: AnnotationItem[]) {
    this.objects.retain(new Set(annotations.map((annotation) => annotation.id)));
    annotations.forEach((annotation) => {
      let object = this.objects.get(annotation.id);
      if (!object) {
        const graphics = new Graphics();
        object = { graphics, destroy: () => graphics.destroy() };
        this.objects.set(annotation.id, object);
        this.layer.addChild(graphics);
      }
      this.draw(object.graphics, annotation);
    });
  }

  destroy() { this.objects.destroy(); }

  private draw(graphics: Graphics, annotation: AnnotationItem) {
    graphics.clear();
    graphics.visible = !annotation.hidden;
    const style = { color: annotation.color, alpha: annotation.opacity ?? 1, width: annotation.strokeWidth, cap: 'round' as const, join: 'round' as const };
    if (annotation.points && annotation.points.length >= 2) {
      graphics.moveTo(annotation.points[0], annotation.points[1]);
      for (let index = 2; index < annotation.points.length; index += 2) graphics.lineTo(annotation.points[index], annotation.points[index + 1]);
      graphics.stroke(style);
      if (annotation.type === 'arrow' && annotation.points.length >= 4) {
        const x = annotation.points.at(-2) as number; const y = annotation.points.at(-1) as number;
        const previousX = annotation.points.at(-4) as number; const previousY = annotation.points.at(-3) as number;
        const angle = Math.atan2(y - previousY, x - previousX);
        const size = Math.max(10, annotation.strokeWidth * 4);
        graphics.moveTo(x, y).lineTo(x - Math.cos(angle - 0.5) * size, y - Math.sin(angle - 0.5) * size)
          .moveTo(x, y).lineTo(x - Math.cos(angle + 0.5) * size, y - Math.sin(angle + 0.5) * size).stroke(style);
      }
    } else if (annotation.type === 'rectangle') {
      graphics.rect(annotation.x ?? 0, annotation.y ?? 0, annotation.width ?? 0, annotation.height ?? 0).stroke(style);
    } else if (annotation.type === 'ellipse') {
      graphics.ellipse((annotation.x ?? 0) + (annotation.width ?? 0) / 2, (annotation.y ?? 0) + (annotation.height ?? 0) / 2,
        Math.abs(annotation.width ?? 0) / 2, Math.abs(annotation.height ?? 0) / 2).stroke(style);
    }
  }
}
