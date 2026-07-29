import { groupVisibleBounds, GROUP_TITLE_HEIGHT } from '../scene';
import type { AnnotationItem, ImageGroup, ImageItem } from '../types';

interface ExportImage extends ImageItem { resourceUrl: string }
interface ExportRequest {
  width: number;
  height: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  background?: string;
  items: ExportImage[];
  annotations: AnnotationItem[];
  groups: ImageGroup[];
}

function drawAnnotation(context: OffscreenCanvasRenderingContext2D, annotation: AnnotationItem) {
  context.save();
  context.strokeStyle = annotation.color;
  context.fillStyle = annotation.color;
  context.lineWidth = annotation.strokeWidth;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  if (annotation.type === 'pen' && annotation.points?.length) {
    context.beginPath(); context.moveTo(annotation.points[0], annotation.points[1]);
    for (let index = 2; index < annotation.points.length; index += 2) context.lineTo(annotation.points[index], annotation.points[index + 1]);
    context.stroke();
  } else if (annotation.type === 'arrow' && annotation.points?.length === 4) {
    const [x1, y1, x2, y2] = annotation.points;
    context.beginPath(); context.moveTo(x1, y1); context.lineTo(x2, y2); context.stroke();
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const length = annotation.strokeWidth * 4;
    context.beginPath(); context.moveTo(x2, y2);
    context.lineTo(x2 - length * Math.cos(angle - Math.PI / 6), y2 - length * Math.sin(angle - Math.PI / 6));
    context.lineTo(x2 - length * Math.cos(angle + Math.PI / 6), y2 - length * Math.sin(angle + Math.PI / 6));
    context.closePath(); context.fill();
  } else if (annotation.type === 'rectangle') {
    context.strokeRect(annotation.x ?? 0, annotation.y ?? 0, annotation.width ?? 0, annotation.height ?? 0);
  } else if (annotation.type === 'ellipse') {
    context.beginPath();
    context.ellipse((annotation.x ?? 0) + (annotation.width ?? 0) / 2, (annotation.y ?? 0) + (annotation.height ?? 0) / 2,
      (annotation.width ?? 0) / 2, (annotation.height ?? 0) / 2, 0, 0, Math.PI * 2);
    context.stroke();
  }
  context.restore();
}

async function render(request: ExportRequest) {
  const canvas = new OffscreenCanvas(request.width, request.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建后台导出画布');
  context.scale(request.scale, request.scale);
  if (request.background) {
    context.fillStyle = request.background;
    context.fillRect(0, 0, request.width / request.scale, request.height / request.scale);
  }
  context.translate(request.offsetX, request.offsetY);
  for (const group of request.groups) {
    const bounds = groupVisibleBounds(group);
    context.save(); context.globalAlpha = group.opacity; context.fillStyle = group.color;
    context.fillRect(group.x, group.y, bounds.width, bounds.height); context.restore();
    context.save(); context.strokeStyle = group.color; context.lineWidth = 0.5;
    context.strokeRect(group.x, group.y, bounds.width, bounds.height); context.restore();
  }
  for (const item of request.items) {
    const response = await fetch(item.resourceUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`导出资源读取失败：${item.name}`);
    const bitmap = await createImageBitmap(await response.blob());
    try {
      context.save(); context.globalAlpha = item.opacity; context.filter = item.grayscale ? 'grayscale(1)' : 'none';
      context.translate(item.x + item.width / 2, item.y + item.height / 2);
      context.rotate(item.rotation * Math.PI / 180); context.scale(item.flipX ? -1 : 1, item.flipY ? -1 : 1);
      context.drawImage(bitmap, item.crop.x, item.crop.y, item.crop.width, item.crop.height,
        -item.width / 2, -item.height / 2, item.width, item.height);
      context.restore();
    } finally { bitmap.close(); }
  }
  request.annotations.forEach((annotation) => drawAnnotation(context, annotation));
  for (const group of request.groups) {
    const bounds = groupVisibleBounds(group);
    context.save(); context.globalAlpha = Math.min(0.96, group.opacity + 0.58); context.fillStyle = group.color;
    context.fillRect(group.x, group.y, bounds.width, GROUP_TITLE_HEIGHT); context.restore();
    context.save(); context.fillStyle = group.titleColor; context.font = '600 11px "Segoe UI", sans-serif';
    context.textBaseline = 'middle'; context.beginPath(); context.rect(group.x + 8, group.y, Math.max(1, bounds.width - 16), GROUP_TITLE_HEIGHT);
    context.clip(); context.fillText(`${group.collapsed ? '▸' : '▾'}  ${group.name}`, group.x + 10, group.y + GROUP_TITLE_HEIGHT / 2);
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
