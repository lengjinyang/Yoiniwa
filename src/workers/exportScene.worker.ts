import { groupVisibleBounds, GROUP_TITLE_HEIGHT } from '../scene';
import type { ImageGroup, ImageItem, VisualNotesState } from '../types';
import { markWorldPoints } from '../visualNotes/VisualNoteGeometry';

interface ExportImage extends ImageItem { resourceUrl: string }
interface ExportRequest {
  width: number;
  height: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  background?: string;
  backgroundOpacity?: number;
  items: ExportImage[];
  groups: ImageGroup[];
  visualNotes?: VisualNotesState;
  clipPolygon?: Array<{ x: number; y: number }>;
}

function drawVisualNotes(context: OffscreenCanvasRenderingContext2D, request: ExportRequest) {
  const notes = request.visualNotes;
  if (!notes?.visible) return;
  for (const mark of notes.marks) {
    const points = markWorldPoints(mark, request.items);
    if (!points.length) continue;
    context.save(); context.globalAlpha = mark.style.opacity; context.strokeStyle = mark.style.color;
    context.fillStyle = mark.style.color; context.lineCap = 'round'; context.lineJoin = 'round';
    if (mark.kind === 'stroke') {
      for (let index = 1; index < points.length; index += 1) {
        context.beginPath(); context.lineWidth = mark.style.baseWidth * (points[index - 1].widthFactor + points[index].widthFactor) / 2;
        context.moveTo(points[index - 1].x, points[index - 1].y); context.lineTo(points[index].x, points[index].y); context.stroke();
      }
    } else if (mark.kind === 'arrow') {
      const [start, end] = points; const angle = Math.atan2(end.y - start.y, end.x - start.x);
      const head = Math.max(9, Math.min(24, mark.style.baseWidth * 4));
      context.lineWidth = mark.style.baseWidth; context.beginPath(); context.moveTo(start.x, start.y); context.lineTo(end.x, end.y); context.stroke();
      context.beginPath(); context.moveTo(end.x, end.y);
      context.lineTo(end.x - Math.cos(angle - Math.PI / 6) * head, end.y - Math.sin(angle - Math.PI / 6) * head);
      context.lineTo(end.x - Math.cos(angle + Math.PI / 6) * head, end.y - Math.sin(angle + Math.PI / 6) * head);
      context.closePath(); context.fill();
    } else {
      const point = points[0]; const radius = 12;
      context.beginPath(); context.arc(point.x, point.y, radius, 0, Math.PI * 2); context.fill();
      context.globalAlpha = 1; context.fillStyle = '#17191c'; context.font = '600 12px "Segoe UI", sans-serif';
      context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(String(mark.number), point.x, point.y);
    }
    context.restore();
  }
}

async function render(request: ExportRequest) {
  const canvas = new OffscreenCanvas(request.width, request.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建后台导出画布');
  context.scale(request.scale, request.scale);
  if (request.background) {
    context.globalAlpha = request.backgroundOpacity ?? 1;
    context.fillStyle = request.background;
    context.fillRect(0, 0, request.width / request.scale, request.height / request.scale);
    context.globalAlpha = 1;
  }
  context.translate(request.offsetX, request.offsetY);
  if (request.clipPolygon?.length && request.clipPolygon.length >= 3) {
    context.beginPath();
    context.moveTo(request.clipPolygon[0].x, request.clipPolygon[0].y);
    for (const point of request.clipPolygon.slice(1)) context.lineTo(point.x, point.y);
    context.closePath();
    context.clip();
  }
  for (const group of request.groups) {
    if (!group.collapsed) {
      context.save(); context.globalAlpha = group.opacity; context.fillStyle = group.color;
      context.fillRect(group.x, group.y, group.width, group.height); context.restore();
    }
  }
  for (const item of request.items) {
    const response = await fetch(item.resourceUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`导出资源读取失败：${item.name}`);
    const bitmap = await createImageBitmap(await response.blob());
    try {
      context.save(); context.globalAlpha = item.opacity;
      context.filter = item.grayscale
        ? `grayscale(1) contrast(${Math.round(Math.max(0, Math.min(2, item.grayscaleContrast ?? 1)) * 100)}%)`
        : 'none';
      context.translate(item.x + item.width / 2, item.y + item.height / 2);
      context.rotate(item.rotation * Math.PI / 180); context.scale(item.flipX ? -1 : 1, item.flipY ? -1 : 1);
      context.drawImage(bitmap, item.crop.x, item.crop.y, item.crop.width, item.crop.height,
        -item.width / 2, -item.height / 2, item.width, item.height);
      context.restore();
    } finally { bitmap.close(); }
  }
  drawVisualNotes(context, request);
  for (const group of request.groups) {
    const bounds = groupVisibleBounds(group);
    const headerY = group.y - GROUP_TITLE_HEIGHT;
    context.save(); context.globalAlpha = Math.min(0.96, group.opacity + 0.58); context.fillStyle = group.color;
    context.fillRect(group.x, headerY, bounds.width, GROUP_TITLE_HEIGHT); context.restore();
    context.save(); context.globalAlpha = group.titleOpacity ?? 1; context.fillStyle = group.titleColor; context.font = '600 11px "Segoe UI", sans-serif';
    context.textBaseline = 'middle'; context.beginPath(); context.rect(group.x + 8, headerY, Math.max(1, bounds.width - 16), GROUP_TITLE_HEIGHT);
    context.clip(); context.fillText(`${group.collapsed ? '▸' : '▾'}  ${group.name}`, group.x + 10, headerY + GROUP_TITLE_HEIGHT / 2);
    context.restore();
  }
  return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
}

self.onmessage = (event: MessageEvent<ExportRequest>) => {
  void render(event.data).then(
    (buffer) => self.postMessage({ ok: true, buffer }, { transfer: [buffer] }),
    (error) => self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
};
