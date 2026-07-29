import type { ImageItem } from '../types';
import type { ImageRenderCommand } from './renderPlan';

export interface PreviewImageTransform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  opacity?: number;
}

export type CompactImageGesture =
  | { kind: 'move'; imageIds: ReadonlySet<string>; deltaX: number; deltaY: number }
  | { kind: 'scale'; imageIds: ReadonlySet<string>; centerX: number; centerY: number; factor: number }
  | { kind: 'bounds'; imageIds: ReadonlySet<string>; sourceX: number; sourceY: number; targetX: number; targetY: number; scaleX: number; scaleY: number }
  | { kind: 'rotate'; imageIds: ReadonlySet<string>; centerX: number; centerY: number; deltaDegrees: number }
  | { kind: 'opacity'; imageIds: ReadonlySet<string>; opacity: number };

export function compactGestureMatrix(gesture: CompactImageGesture) {
  if (gesture.kind === 'move') return { matrix: [1, 0, 0, 0, 1, 0, gesture.deltaX, gesture.deltaY, 1], opacity: -1 };
  if (gesture.kind === 'scale') {
    const offsetX = gesture.centerX * (1 - gesture.factor);
    const offsetY = gesture.centerY * (1 - gesture.factor);
    return { matrix: [gesture.factor, 0, 0, 0, gesture.factor, 0, offsetX, offsetY, 1], opacity: -1 };
  }
  if (gesture.kind === 'bounds') return {
    matrix: [gesture.scaleX, 0, 0, 0, gesture.scaleY, 0,
      gesture.targetX - gesture.sourceX * gesture.scaleX,
      gesture.targetY - gesture.sourceY * gesture.scaleY, 1],
    opacity: -1,
  };
  if (gesture.kind === 'rotate') {
    const radians = gesture.deltaDegrees * Math.PI / 180;
    const cosine = Math.cos(radians); const sine = Math.sin(radians);
    return {
      matrix: [cosine, sine, 0, -sine, cosine, 0,
        gesture.centerX - cosine * gesture.centerX + sine * gesture.centerY,
        gesture.centerY - sine * gesture.centerX - cosine * gesture.centerY, 1],
      opacity: -1,
    };
  }
  return { matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], opacity: gesture.opacity };
}

export function applyCompactGesture(command: ImageRenderCommand, gesture: CompactImageGesture): ImageRenderCommand {
  const imageId = command.imageId ?? command.id;
  if (!gesture.imageIds.has(imageId)) return command;
  if (gesture.kind === 'move') return {
    ...command,
    x: command.x + gesture.deltaX,
    y: command.y + gesture.deltaY,
  };
  if (gesture.kind === 'scale') {
    const centerX = command.x + command.width / 2;
    const centerY = command.y + command.height / 2;
    const width = command.width * gesture.factor;
    const height = command.height * gesture.factor;
    return {
      ...command,
      x: gesture.centerX + (centerX - gesture.centerX) * gesture.factor - width / 2,
      y: gesture.centerY + (centerY - gesture.centerY) * gesture.factor - height / 2,
      width,
      height,
    };
  }
  if (gesture.kind === 'bounds') {
    const centerX = command.x + command.width / 2;
    const centerY = command.y + command.height / 2;
    const width = command.width * gesture.scaleX;
    const height = command.height * gesture.scaleY;
    return {
      ...command,
      x: gesture.targetX + (centerX - gesture.sourceX) * gesture.scaleX - width / 2,
      y: gesture.targetY + (centerY - gesture.sourceY) * gesture.scaleY - height / 2,
      width,
      height,
    };
  }
  if (gesture.kind === 'rotate') {
    const radians = gesture.deltaDegrees * Math.PI / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const centerX = command.x + command.width / 2;
    const centerY = command.y + command.height / 2;
    const deltaX = centerX - gesture.centerX;
    const deltaY = centerY - gesture.centerY;
    const rotatedX = gesture.centerX + deltaX * cosine - deltaY * sine;
    const rotatedY = gesture.centerY + deltaX * sine + deltaY * cosine;
    return {
      ...command,
      x: rotatedX - command.width / 2,
      y: rotatedY - command.height / 2,
      rotation: command.rotation + gesture.deltaDegrees,
    };
  }
  return { ...command, opacity: gesture.opacity };
}

export function applyImagePreview(
  command: ImageRenderCommand,
  item: ImageItem,
  preview: PreviewImageTransform,
): ImageRenderCommand {
  const itemCenterX = item.x + item.width / 2;
  const itemCenterY = item.y + item.height / 2;
  const commandCenterX = command.x + command.width / 2;
  const commandCenterY = command.y + command.height / 2;
  const radians = -item.rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const deltaX = commandCenterX - itemCenterX;
  const deltaY = commandCenterY - itemCenterY;
  const localX = (deltaX * cosine - deltaY * sine) * (item.flipX ? -1 : 1);
  const localY = (deltaX * sine + deltaY * cosine) * (item.flipY ? -1 : 1);
  const previewRadians = preview.rotation * Math.PI / 180;
  const previewCosine = Math.cos(previewRadians);
  const previewSine = Math.sin(previewRadians);
  const scaledX = localX * preview.scaleX;
  const scaledY = localY * preview.scaleY;
  const centerX = preview.x + scaledX * previewCosine - scaledY * previewSine;
  const centerY = preview.y + scaledX * previewSine + scaledY * previewCosine;
  const width = command.width * Math.abs(preview.scaleX);
  const height = command.height * Math.abs(preview.scaleY);

  return {
    ...command,
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
    rotation: preview.rotation,
    flipX: preview.scaleX < 0,
    flipY: preview.scaleY < 0,
    opacity: preview.opacity ?? command.opacity,
  };
}
