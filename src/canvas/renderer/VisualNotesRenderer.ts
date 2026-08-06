import { Container, Graphics, MeshSimple, Text, Texture } from 'pixi.js';
import type { ImageItem, VisualMark, VisualNotePoint, VisualNotesState } from '../../types';
import { markWorldPoints } from '../../visualNotes/VisualNoteGeometry';
import { markWorldBounds } from '../../visualNotes/VisualNoteGeometry';

interface RenderedMark { container: Container; signature: string }

function destroyRenderedContainer(container: Container) {
  container.children.forEach((child) => {
    if (child instanceof MeshSimple) child.geometry.destroy();
  });
  container.destroy({ children: true });
}

function strokeGeometry(points: readonly VisualNotePoint[], baseWidth: number) {
  if (points.length < 2) return { vertices: new Float32Array(), indices: new Uint32Array() };
  const vertices: number[] = [];
  const indices: number[] = [];
  points.forEach((point, index) => {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const dx = next.x - previous.x; const dy = next.y - previous.y;
    const length = Math.max(1e-6, Math.hypot(dx, dy));
    const radius = baseWidth * point.widthFactor / 2;
    const nx = -dy / length * radius; const ny = dx / length * radius;
    vertices.push(point.x + nx, point.y + ny, point.x - nx, point.y - ny);
    if (index) {
      const start = index * 2;
      indices.push(start - 2, start - 1, start, start, start - 1, start + 1);
    }
  });
  const addCap = (point: VisualNotePoint, vertexIndex: number, startAngle: number) => {
    const center = vertices.length / 2;
    vertices.push(point.x, point.y);
    const radius = baseWidth * point.widthFactor / 2;
    for (let step = 0; step <= 8; step += 1) {
      const angle = startAngle + Math.PI * step / 8;
      vertices.push(point.x + Math.cos(angle) * radius, point.y + Math.sin(angle) * radius);
      if (step) indices.push(center, center + step, center + step + 1);
    }
    indices.push(center, center + 1, vertexIndex, center, vertexIndex, center + 9);
  };
  const first = points[0]; const second = points[1];
  const firstAngle = Math.atan2(first.y - second.y, first.x - second.x) - Math.PI / 2;
  addCap(first, 0, firstAngle);
  const last = points.at(-1)!; const before = points.at(-2)!;
  const lastAngle = Math.atan2(last.y - before.y, last.x - before.x) - Math.PI / 2;
  addCap(last, points.length * 2 - 1, lastAngle);
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}

function createStroke(points: readonly VisualNotePoint[], mark: VisualMark) {
  const geometry = strokeGeometry(points, mark.style.baseWidth);
  const mesh = new MeshSimple({ texture: Texture.WHITE, vertices: geometry.vertices, indices: geometry.indices });
  mesh.tint = mark.style.color;
  mesh.alpha = mark.style.opacity;
  mesh.autoUpdate = false;
  return mesh;
}

export class VisualNotesRenderer {
  private readonly objects = new Map<string, RenderedMark>();
  private readonly preview = new Container();
  private readonly selection = new Graphics();
  private readonly eraserCursor = new Graphics();
  private temporaryHidden = false;
  private notesVisible = true;
  private images: ImageItem[] = [];
  private previewMark?: VisualMark;
  private selectedId?: string;
  private state?: VisualNotesState;
  private viewportScale = 1;
  private eraserPoint?: { x: number; y: number };
  private eraserRadiusScreen = 0;

  constructor(private readonly layer: Container) { layer.addChild(this.preview, this.selection, this.eraserCursor); }

  sync(state: VisualNotesState, images: ImageItem[]) {
    this.images = images;
    this.state = state;
    this.notesVisible = state.visible;
    const ids = new Set(state.marks.map((mark) => mark.id));
    for (const [id, object] of this.objects) {
      if (ids.has(id)) continue;
      destroyRenderedContainer(object.container); this.objects.delete(id);
    }
    state.marks.forEach((mark) => this.syncMark(mark));
    this.updateVisibility();
    this.redrawSelection();
  }

  setSelection(id?: string) { this.selectedId = id; this.redrawSelection(); }
  setViewportScale(scale: number) {
    if (Math.abs(scale - this.viewportScale) < 0.001) return;
    this.viewportScale = Math.max(0.001, scale); this.redrawSelection(); this.redrawEraserCursor();
  }

  setTemporaryHidden(hidden: boolean) { this.temporaryHidden = hidden; this.updateVisibility(); }

  setPreview(mark?: VisualMark) {
    this.previewMark = mark;
    this.preview.removeChildren().forEach((child) => destroyRenderedContainer(child as Container));
    if (mark) this.preview.addChild(this.renderMark(mark));
    this.updateVisibility();
  }

  setEraserCursor(point?: { x: number; y: number }, radiusScreen = 0) {
    this.eraserPoint = point; this.eraserRadiusScreen = radiusScreen;
    this.redrawEraserCursor();
  }

  private syncMark(mark: VisualMark) {
    const id = mark.id;
    const imageId = mark.anchor.type === 'image' ? mark.anchor.imageId : undefined;
    const image = imageId ? this.images.find((item) => item.id === imageId) : undefined;
    const signature = JSON.stringify([mark, image && [image.x, image.y, image.width, image.height,
      image.rotation, image.flipX, image.flipY, image.crop]]);
    const current = this.objects.get(id);
    if (current?.signature === signature) return;
    if (current) destroyRenderedContainer(current.container);
    const container = this.renderMark(mark);
    this.layer.addChild(container);
    this.objects.set(id, { container, signature });
  }

  private renderMark(mark: VisualMark) {
    const container = new Container();
    const points = markWorldPoints(mark, this.images);
    if (mark.kind === 'stroke') container.addChild(createStroke(points, mark));
    else if (mark.kind === 'arrow') {
      container.addChild(createStroke(points, mark));
      const start = points[0]; const end = points[1];
      const angle = Math.atan2(end.y - start.y, end.x - start.x);
      const size = Math.max(8, mark.style.baseWidth * 3.5);
      const graphics = new Graphics().poly([
        end.x, end.y,
        end.x - Math.cos(angle - 0.48) * size, end.y - Math.sin(angle - 0.48) * size,
        end.x - Math.cos(angle + 0.48) * size, end.y - Math.sin(angle + 0.48) * size,
      ]).fill({ color: mark.style.color, alpha: mark.style.opacity });
      container.addChild(graphics);
    } else {
      const point = points[0]; const radius = Math.max(10, mark.style.baseWidth * 3.5);
      const badge = new Graphics().circle(point.x, point.y, radius)
        .fill({ color: mark.style.color, alpha: Math.max(0.7, mark.style.opacity) });
      const label = new Text({ text: String(mark.number), style: {
        fill: '#17191c', fontFamily: 'Segoe UI, Microsoft YaHei UI, sans-serif', fontSize: Math.max(11, radius), fontWeight: '600',
      } });
      label.anchor.set(0.5); label.position.set(point.x, point.y);
      container.addChild(badge, label);
    }
    return container;
  }

  private updateVisibility() {
    this.layer.visible = this.notesVisible && !this.temporaryHidden;
    this.preview.visible = this.layer.visible && Boolean(this.previewMark);
  }

  private redrawSelection() {
    this.selection.clear();
    const mark = this.state?.marks.find((value) => value.id === this.selectedId);
    if (!mark || !this.notesVisible || this.temporaryHidden) return;
    const bounds = markWorldBounds(mark, this.images); const scale = this.viewportScale;
    this.selection.rect(bounds.x, bounds.y, bounds.width, bounds.height)
      .stroke({ color: '#708cff', alpha: 0.82, width: 1 / scale });
    const radius = 2.5 / scale;
    [[bounds.x, bounds.y], [bounds.x + bounds.width, bounds.y], [bounds.x + bounds.width, bounds.y + bounds.height], [bounds.x, bounds.y + bounds.height]]
      .forEach(([x, y]) => this.selection.circle(x, y, radius).fill({ color: '#aebcff', alpha: 0.82 }));
    this.layer.setChildIndex(this.selection, this.layer.children.length - 1);
  }

  private redrawEraserCursor() {
    this.eraserCursor.clear();
    if (!this.eraserPoint || this.eraserRadiusScreen <= 0) return;
    const radius = this.eraserRadiusScreen / this.viewportScale;
    const outerWidth = 2.4 / this.viewportScale;
    const innerWidth = 1 / this.viewportScale;
    this.eraserCursor.circle(this.eraserPoint.x, this.eraserPoint.y, radius)
      .fill({ color: '#708cff', alpha: 0.08 })
      .stroke({ color: '#111317', alpha: 0.82, width: outerWidth });
    this.eraserCursor.circle(this.eraserPoint.x, this.eraserPoint.y, radius)
      .stroke({ color: '#e4e6e8', alpha: 0.78, width: innerWidth });
    this.layer.setChildIndex(this.eraserCursor, this.layer.children.length - 1);
  }

  destroy() {
    this.objects.forEach((object) => destroyRenderedContainer(object.container));
    this.objects.clear(); this.preview.destroy({ children: true });
    this.selection.destroy(); this.eraserCursor.destroy();
  }
}
