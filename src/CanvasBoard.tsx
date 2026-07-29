import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Konva from 'konva';
import { Arrow, Circle, Ellipse, Group as KonvaGroup, Image as KonvaImage, Layer, Line, Rect, Stage, Text, Transformer } from 'react-konva';
import { edgeAutoPanDelta, exceededWindowMoveThreshold, getImageDragMode, isAltColorPickerPointer, isPrimaryPointerButton, offsetPointOutward, zoomViewportAtPoint, type ColorPickerShortcut, type ImageDragMode } from './interactions';
import { pickedColorFromRgba, topmostImagePixel } from './colorPicker';
import { cropForResource, getImageResourceCacheStats, useImageResource } from './imageResources';
import type { CompactImageGesture } from './rendering/previewTransforms';
import { usePixelRenderer } from './rendering/usePixelRenderer';
import { annotationSceneBounds, groupVisibleBounds, GROUP_TITLE_HEIGHT, itemBounds, rotateItemsAsGroup, scaleItemsAsGroup, sceneBounds, topmostVisibleGroupAtPoint, translateItems } from './scene';
import type { AnnotationItem, AnnotationTool, ImageGroup, ImageItem, PickedColor, Scene, Viewport } from './types';
import { SpatialIndex, viewportWorldBounds } from './viewportCulling';
import { performanceMonitor } from './performanceMonitor';
import { rendererInfo, rendererWarn } from './logger';
import { usePixelScenePlan } from './canvas/usePixelScenePlan';
import { PixelImageLoader, PixelUrlLoader, useSettledViewport } from './canvas/PixelLoaders';
import { ImageCommentBubble, imageCommentPosition } from './canvas/overlays/ImageCommentBubble';
import { percentile } from './shared/statistics';

interface Props {
  scene: Scene;
  projectEpoch?: number;
  selectedIds: string[];
  selectedAnnotationIds: string[];
  selectedGroupId?: string;
  onSelectionChange(imageIds: string[], annotationIds?: string[]): void;
  onGroupSelectionChange(id?: string): void;
  onViewportChange(viewport: Viewport): void;
  onViewportPreview?(viewport: Viewport): void;
  onItemsChanged(changes: Array<Partial<ImageItem> & { id: string }>): void;
  onFocusItem(item: ImageItem): void;
  onContextMenu(position: { x: number; y: number }): void;
  onWindowMoveStart(): void;
  onWindowMove(): void;
  onWindowMoveEnd(): void;
  windowLocked: boolean;
  annotationMode: boolean;
  colorPickerHeld: boolean;
  colorPickerShortcut: ColorPickerShortcut;
  onColorPicked(color: PickedColor): void;
  annotationTool: AnnotationTool;
  annotationColor: string;
  annotationWidth: number;
  onAddAnnotation(annotation: AnnotationItem): void;
  onEraseStart(): void;
  onEraseAt(x: number, y: number, radius: number): void;
  onEraseEnd(): void;
  onAnnotationsChanged(changes: Array<{ id: string; deltaX: number; deltaY: number }>): void;
  onGroupMoved(id: string, deltaX: number, deltaY: number): void;
  onGroupHeaderDragChange?(dragging: boolean): void;
  onGroupPreview(id: string, x?: number, y?: number): void;
  onGroupChanged(id: string, patch: Partial<ImageGroup>): void;
  onGroupDeleted(id: string): void;
  onRenameGroup(id: string): void;
  stageRef: React.RefObject<Konva.Stage | null>;
}

function offsetRotationCorners(corners: Array<{ key: string; x: number; y: number }>, center: { x: number; y: number }, scale: number) {
  return corners.map((corner) => ({ ...corner, ...offsetPointOutward(corner, center, 12, scale) }));
}

function selectionRotationCorners(items: ImageItem[]) {
  if (items.length === 1) {
    const item = items[0];
    const radians = item.rotation * Math.PI / 180;
    const cosine = Math.cos(radians); const sine = Math.sin(radians);
    const centerX = item.x + item.width / 2; const centerY = item.y + item.height / 2;
    return [
      { key: 'nw', localX: -item.width / 2, localY: -item.height / 2 },
      { key: 'ne', localX: item.width / 2, localY: -item.height / 2 },
      { key: 'sw', localX: -item.width / 2, localY: item.height / 2 },
      { key: 'se', localX: item.width / 2, localY: item.height / 2 },
    ].map((corner) => ({
      key: corner.key,
      x: centerX + corner.localX * cosine - corner.localY * sine,
      y: centerY + corner.localX * sine + corner.localY * cosine,
    }));
  }
  const bounds = sceneBounds(items);
  return [
    { key: 'nw', x: bounds.x, y: bounds.y },
    { key: 'ne', x: bounds.x + bounds.width, y: bounds.y },
    { key: 'sw', x: bounds.x, y: bounds.y + bounds.height },
    { key: 'se', x: bounds.x + bounds.width, y: bounds.y + bounds.height },
  ];
}

function BoardImage({ item, companions, selected, interactionDisabled, pixelRendered, viewportScale, onSelect, onChange, onFocus, onPreview, onHoverChange, onPixelInteractionChange }: {
  item: ImageItem; selected: boolean;
  companions: ImageItem[];
  interactionDisabled: boolean;
  pixelRendered: boolean;
  viewportScale: number;
  onSelect(event: Konva.KonvaEventObject<MouseEvent | TouchEvent>): void;
  onChange(changes: Array<Partial<ImageItem> & { id: string }>): void;
  onFocus(): void;
  onPreview(gesture?: CompactImageGesture): void;
  onHoverChange(hovered: boolean): void;
  onPixelInteractionChange(active: boolean): void;
}) {
  const image = useImageResource(item, viewportScale, !pixelRendered);
  const resourceCrop = useMemo(() => image
    ? cropForResource(item, image.naturalWidth, image.naturalHeight)
    : item.crop, [image, item.crop, item.naturalHeight, item.naturalWidth]);
  const nodeOpacity = pixelRendered ? 0.001 : item.opacity;
  const imageRef = useRef<Konva.Image>(null);
  const dragOrigin = useRef({ x: 0, y: 0 });
  const groupOrigins = useRef<ImageItem[]>([]);
  const gestureImageIds = useRef<ReadonlySet<string>>(new Set());
  const gestureCenter = useRef({ x: 0, y: 0 });
  const imageGesture = useRef<{
    mode: ImageDragMode;
    screenX: number;
    rotation: number;
    opacity: number;
    factor: number;
    startWorldX: number;
    startWorldY: number;
    deltaX: number;
    deltaY: number;
  }>({ mode: 'move', screenX: 0, rotation: item.rotation, opacity: item.opacity, factor: 1, startWorldX: 0, startWorldY: 0, deltaX: 0, deltaY: 0 });
  useEffect(() => {
    if (!imageRef.current || !image) return;
    if (item.grayscale && !pixelRendered) imageRef.current.cache();
    else imageRef.current.clearCache();
    imageRef.current.getLayer()?.batchDraw();
  }, [image, item.grayscale, pixelRendered, resourceCrop, item.width, item.height]);
  return <KonvaImage
    ref={imageRef}
    id={item.id}
    name="board-image"
    image={pixelRendered ? undefined : image}
    x={item.x + item.width / 2}
    y={item.y + item.height / 2}
    width={item.width}
    height={item.height}
    offsetX={item.width / 2}
    offsetY={item.height / 2}
    rotation={item.rotation}
    scaleX={item.flipX ? -1 : 1}
    scaleY={item.flipY ? -1 : 1}
    opacity={nodeOpacity}
    filters={item.grayscale ? [Konva.Filters.Grayscale] : []}
    crop={resourceCrop}
    draggable={!item.locked && !interactionDisabled}
    stroke={selected ? '#64d8ff' : undefined}
    strokeWidth={selected ? 0.8 : 0}
    shadowColor={selected ? '#64d8ff' : '#000'}
    shadowBlur={selected ? 4 : 3}
    shadowOpacity={selected ? 0.3 : 0.2}
    onMouseEnter={() => onHoverChange(true)}
    onMouseLeave={() => onHoverChange(false)}
    onClick={(event) => { if (!interactionDisabled && isPrimaryPointerButton((event.evt as MouseEvent).button)) onSelect(event); }}
    onTap={(event) => { if (!interactionDisabled) onSelect(event); }}
    onDblClick={(event) => { if (!interactionDisabled && isPrimaryPointerButton((event.evt as MouseEvent).button)) onFocus(); }}
    onDragStart={(event) => {
      const mouse = event.evt as MouseEvent;
      dragOrigin.current = { x: event.target.x(), y: event.target.y() };
      groupOrigins.current = [item, ...companions].map((value) => ({ ...value, crop: { ...value.crop } }));
      gestureImageIds.current = new Set(groupOrigins.current.map((value) => value.id));
      const initialBounds = sceneBounds(groupOrigins.current);
      gestureCenter.current = { x: initialBounds.x + initialBounds.width / 2, y: initialBounds.y + initialBounds.height / 2 };
      const mode = mouse.button === 1 ? 'pan' : getImageDragMode(mouse);
      const stage = event.target.getStage();
      const pointer = stage?.getPointerPosition();
      const stageScale = stage?.scaleX() || 1;
      const startWorldX = pointer && stage ? (pointer.x - stage.x()) / stageScale : event.target.x();
      const startWorldY = pointer && stage ? (pointer.y - stage.y()) / stageScale : event.target.y();
      imageGesture.current = { mode, screenX: mouse.screenX, rotation: item.rotation, opacity: item.opacity, factor: 1, startWorldX, startWorldY, deltaX: 0, deltaY: 0 };
      if (mode !== 'pan') onPixelInteractionChange(true);
      if (mode === 'pan') event.target.stopDrag();
    }}
    onDragMove={(event) => {
      const mouse = event.evt as MouseEvent;
      const gesture = imageGesture.current;
      if (gesture.mode === 'pan') return;
      if (gesture.mode === 'rotate') {
        const rotation = gesture.rotation + (mouse.screenX - gesture.screenX) * 0.5;
        event.target.position(dragOrigin.current);
        event.target.rotation(mouse.shiftKey ? Math.round(rotation / 45) * 45 : rotation);
        onPreview({
          kind: 'rotate', imageIds: gestureImageIds.current,
          centerX: item.x + item.width / 2, centerY: item.y + item.height / 2,
          deltaDegrees: event.target.rotation() - item.rotation,
        });
        return;
      }
      if (gesture.mode === 'scale') {
        gesture.factor = Math.max(0.08, Math.min(12, Math.exp((mouse.screenX - gesture.screenX) / 180)));
        const groupCenter = gestureCenter.current;
        event.target.position(dragOrigin.current);
        if (!pixelRendered) {
          for (const origin of groupOrigins.current) {
            const node = event.target.getStage()?.findOne(`#${origin.id}`);
            if (!node) continue;
            const centerX = origin.x + origin.width / 2;
            const centerY = origin.y + origin.height / 2;
            node.position({
              x: groupCenter.x + (centerX - groupCenter.x) * gesture.factor,
              y: groupCenter.y + (centerY - groupCenter.y) * gesture.factor,
            });
            node.scaleX((origin.flipX ? -1 : 1) * gesture.factor);
            node.scaleY((origin.flipY ? -1 : 1) * gesture.factor);
            const width = origin.width * gesture.factor; const height = origin.height * gesture.factor;
            node.getStage()?.findOne(`#comment-${origin.id}`)?.position(imageCommentPosition({
              x: node.x() - width / 2, y: node.y() - height / 2, width, height, rotation: origin.rotation,
            }, viewportScale));
          }
        }
        onPreview({
          kind: 'scale', imageIds: gestureImageIds.current,
          centerX: groupCenter.x, centerY: groupCenter.y, factor: gesture.factor,
        });
        return;
      }
      if (gesture.mode === 'opacity') {
        const opacity = Math.max(0.1, Math.min(1, gesture.opacity + (mouse.screenX - gesture.screenX) / 220));
        event.target.position(dragOrigin.current);
        event.target.opacity(opacity);
        (event.target as Konva.Node).setAttr('pixelPreviewOpacity', opacity);
        onPreview({ kind: 'opacity', imageIds: gestureImageIds.current, opacity });
        return;
      }
      const stage = event.target.getStage();
      const pointer = stage?.getPointerPosition();
      const stageScale = stage?.scaleX() || 1;
      let deltaX = pointer && stage ? (pointer.x - stage.x()) / stageScale - gesture.startWorldX : event.target.x() - dragOrigin.current.x;
      let deltaY = pointer && stage ? (pointer.y - stage.y()) / stageScale - gesture.startWorldY : event.target.y() - dragOrigin.current.y;
      if (mouse.shiftKey) {
        if (Math.abs(deltaX) >= Math.abs(deltaY)) deltaY = 0;
        else deltaX = 0;
      }
      gesture.deltaX = deltaX;
      gesture.deltaY = deltaY;
      if (!pixelRendered) {
        for (const origin of groupOrigins.current) {
          stage?.findOne(`#${origin.id}`)?.position({
            x: origin.x + origin.width / 2 + deltaX,
            y: origin.y + origin.height / 2 + deltaY,
          });
          stage?.findOne(`#comment-${origin.id}`)?.position(imageCommentPosition({ ...origin, x: origin.x + deltaX, y: origin.y + deltaY }, viewportScale));
        }
      }
      onPreview({ kind: 'move', imageIds: gestureImageIds.current, deltaX, deltaY });
      if (!pixelRendered) stage?.batchDraw();
    }}
    onDragEnd={(event) => {
      const gesture = imageGesture.current;
      onPixelInteractionChange(false);
      if (gesture.mode === 'pan') return;
      if (gesture.mode === 'rotate') {
        onChange([{ id: item.id, rotation: event.target.rotation() }]);
        return;
      }
      if (gesture.mode === 'scale') {
        const stage = event.target.getStage();
        if (!pixelRendered) {
          groupOrigins.current.forEach((origin) => {
            const node = stage?.findOne(`#${origin.id}`);
            node?.position({ x: origin.x + origin.width / 2, y: origin.y + origin.height / 2 });
            node?.scale({ x: origin.flipX ? -1 : 1, y: origin.flipY ? -1 : 1 });
            stage?.findOne(`#comment-${origin.id}`)?.position(imageCommentPosition(origin, viewportScale));
          });
          stage?.batchDraw();
        }
        onChange(scaleItemsAsGroup(groupOrigins.current, gesture.factor));
        return;
      }
      if (gesture.mode === 'opacity') {
        (event.target as Konva.Node).setAttr('pixelPreviewOpacity', undefined);
        onChange([{ id: item.id, opacity: event.target.opacity() }]);
        return;
      }
      if (Math.abs(gesture.deltaX) < 0.001 && Math.abs(gesture.deltaY) < 0.001) return;
      onChange(translateItems(groupOrigins.current, gesture.deltaX, gesture.deltaY));
    }}
  />;
}

function AnnotationShape({ annotation, draft = false, selected = false, draggable = false, onSelect, onMove }: {
  annotation: AnnotationItem; draft?: boolean; selected?: boolean; draggable?: boolean;
  onSelect?: (event: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => void;
  onMove?: (deltaX: number, deltaY: number) => void;
}) {
  const dragOrigin = useRef({ x: 0, y: 0 });
  const common = {
    id: `annotation-${annotation.id}`,
    name: 'annotation',
    stroke: annotation.color,
    strokeWidth: annotation.strokeWidth,
    lineCap: 'round' as const,
    lineJoin: 'round' as const,
    opacity: draft ? 0.75 : 1,
    listening: !draft,
    draggable,
    x: 0,
    y: 0,
    shadowColor: selected ? '#64d8ff' : undefined,
    shadowBlur: selected ? 7 : 0,
    onClick: onSelect,
    onTap: onSelect,
    onDragStart: (event: Konva.KonvaEventObject<DragEvent>) => { dragOrigin.current = { x: event.target.x(), y: event.target.y() }; },
    onDragEnd: (event: Konva.KonvaEventObject<DragEvent>) => onMove?.(event.target.x() - dragOrigin.current.x, event.target.y() - dragOrigin.current.y),
  };
  if (annotation.type === 'pen') return <Line {...common} points={annotation.points ?? []} tension={0.12} />;
  if (annotation.type === 'arrow') return <Arrow {...common} points={annotation.points ?? []} pointerLength={annotation.strokeWidth * 4} pointerWidth={annotation.strokeWidth * 3} fill={annotation.color} />;
  if (annotation.type === 'rectangle') return <Rect {...common} x={annotation.x} y={annotation.y} width={annotation.width} height={annotation.height} />;
  return <Ellipse {...common} x={(annotation.x ?? 0) + (annotation.width ?? 0) / 2} y={(annotation.y ?? 0) + (annotation.height ?? 0) / 2} radiusX={(annotation.width ?? 0) / 2} radiusY={(annotation.height ?? 0) / 2} />;
}

function GroupBackground({ group, scale }: { group: ImageGroup; scale: number }) {
  const bounds = groupVisibleBounds(group);
  return <Rect id={`group-bg-${group.id}`} x={group.x} y={group.y}
    width={bounds.width} height={bounds.height}
    fill={group.collapsed ? '#25282d' : group.color} opacity={group.collapsed ? 0.96 : group.opacity} cornerRadius={group.collapsed ? 7 : 9}
    shadowColor="#000" shadowBlur={12 / scale} shadowOffsetY={4 / scale} shadowOpacity={0.16} listening={false} />;
}

function drawRoundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const clampedRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + clampedRadius, y);
  context.arcTo(x + width, y, x + width, y + height, clampedRadius);
  context.arcTo(x + width, y + height, x, y + height, clampedRadius);
  context.arcTo(x, y + height, x, y, clampedRadius);
  context.arcTo(x, y, x + width, y, clampedRadius);
  context.closePath();
}

function renderGroupBackgrounds(
  canvas: HTMLCanvasElement,
  groups: ImageGroup[],
  viewport: Viewport,
  size: { width: number; height: number },
) {
  const pixelRatio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(size.width * pixelRatio));
  const height = Math.max(1, Math.round(size.height * pixelRatio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, size.width, size.height);
  context.translate(viewport.x, viewport.y);
  context.scale(viewport.scale, viewport.scale);
  groups.forEach((group) => {
    const bounds = groupVisibleBounds(group);
    context.save();
    context.globalAlpha = group.collapsed ? 0.96 : group.opacity;
    context.fillStyle = group.collapsed ? '#25282d' : group.color;
    context.shadowColor = '#000';
    // Canvas shadow blur is already measured in display pixels and is not scaled by the transform.
    context.shadowBlur = 12;
    context.shadowOffsetY = 4;
    drawRoundedRect(context, bounds.x, bounds.y, bounds.width, bounds.height, group.collapsed ? 7 : 9);
    context.fill();
    context.restore();
  });
}

function GroupTitleButton({ x, kind, label, color, onClick }: {
  x: number; kind: 'collapse' | 'delete'; label: string; color: string; onClick(): void;
}) {
  const iconColor = color;
  return <KonvaGroup x={x} y={5} name={`group-action-${label}`}
    onMouseEnter={(event) => { const stage = event.target.getStage(); if (stage) stage.container().style.cursor = 'pointer'; }}
    onMouseLeave={(event) => { const stage = event.target.getStage(); if (stage) stage.container().style.cursor = 'default'; }}
    onMouseDown={(event) => { event.cancelBubble = true; }}
    onTouchStart={(event) => { event.cancelBubble = true; }}
    onDblClick={(event) => { event.cancelBubble = true; }}
    onClick={(event) => { event.cancelBubble = true; onClick(); }}
    onTap={(event) => { event.cancelBubble = true; onClick(); }}>
    <Circle x={9} y={9} radius={9} fill="#ffffff" opacity={0.001} />
    {kind === 'collapse' && <>
      <Line points={[5.5, 9, 12.5, 9]} stroke={iconColor} strokeWidth={1.35} lineCap="round" listening={false} />
    </>}
    {kind === 'delete' && <>
      <Line points={[5.8, 5.8, 12.2, 12.2]} stroke={iconColor} strokeWidth={1.25} lineCap="round" listening={false} />
      <Line points={[12.2, 5.8, 5.8, 12.2]} stroke={iconColor} strokeWidth={1.25} lineCap="round" listening={false} />
    </>}
  </KonvaGroup>;
}

const COMPACT_GROUP_HEADER_SCALE = 0.32;
const COMPACT_GROUP_UI_SCALE = 0.78;
const compactGroupHeaderY = (group: ImageGroup, scale: number) => group.collapsed ? group.y : group.y - 25 / scale;
const compactGroupHeaderWidth = (group: ImageGroup) => Math.min(210, Math.max(104, group.name.length * 7 + 56));
const compactGroupHeaderBounds = (group: ImageGroup, scale: number) => ({
  x: group.x,
  y: compactGroupHeaderY(group, scale),
  width: compactGroupHeaderWidth(group) * COMPACT_GROUP_UI_SCALE / scale,
  height: 28 * COMPACT_GROUP_UI_SCALE / scale,
});

function GroupCompactHeader({ group, scale, memberNodeIds, headerVisible, onGroupHeaderDragChange, onPixelInteractionChange, onBackgroundPreview, onSelect, onChange, onDelete, onRename, onMove, onPreview }: {
  group: ImageGroup; scale: number; memberNodeIds: string[]; headerVisible: boolean;
  onGroupHeaderDragChange?(dragging: boolean): void;
  onPixelInteractionChange?(active: boolean): void;
  onBackgroundPreview?(patch: Partial<Pick<ImageGroup, 'x' | 'y' | 'width' | 'height'>>, moveDescendants?: boolean): void;
  onSelect(): void; onChange(patch: Partial<ImageGroup>): void; onDelete(): void; onRename(): void;
  onMove(deltaX: number, deltaY: number): void; onPreview(x?: number, y?: number): void;
}) {
  const memberOrigins = useRef<Array<{ node: Konva.Node; x: number; y: number }>>([]);
  if (scale >= COMPACT_GROUP_HEADER_SCALE || group.collapsed || !headerVisible) return null;
  const width = compactGroupHeaderWidth(group);
  return <KonvaGroup id={`group-name-${group.id}`} x={group.x} y={compactGroupHeaderY(group, scale)}
    scaleX={COMPACT_GROUP_UI_SCALE / scale} scaleY={COMPACT_GROUP_UI_SCALE / scale} draggable
    onDragStart={(event) => {
      onSelect();
      onGroupHeaderDragChange?.(true);
      onPixelInteractionChange?.(true);
      const stage = event.currentTarget.getStage();
      memberOrigins.current = memberNodeIds.filter((id) => id !== `group-name-${group.id}`).flatMap((id) => {
        const node = stage?.findOne(`#${id}`);
        return node ? [{ node, x: node.x(), y: node.y() }] : [];
      });
    }}
    onDragMove={(event) => {
      const deltaX = event.currentTarget.x() - group.x;
      const deltaY = event.currentTarget.y() - compactGroupHeaderY(group, scale);
      const stage = event.currentTarget.getStage();
      stage?.findOne(`#group-bg-${group.id}`)?.position({ x: group.x + deltaX, y: group.y + deltaY });
      stage?.findOne(`#group-frame-${group.id}`)?.position({ x: group.x + deltaX, y: group.y + deltaY });
      memberOrigins.current.forEach((value) => value.node.position({ x: value.x + deltaX, y: value.y + deltaY }));
      onBackgroundPreview?.({ x: group.x + deltaX, y: group.y + deltaY }, true);
      onPreview(group.x + deltaX, group.y + deltaY);
      stage?.batchDraw();
    }}
    onDragEnd={(event) => {
      const node = event.currentTarget;
      const deltaX = node.x() - group.x;
      const deltaY = node.y() - compactGroupHeaderY(group, scale);
      const stage = node.getStage();
      node.position({ x: group.x, y: compactGroupHeaderY(group, scale) });
      stage?.findOne(`#group-bg-${group.id}`)?.position({ x: group.x, y: group.y });
      stage?.findOne(`#group-frame-${group.id}`)?.position({ x: group.x, y: group.y });
      memberOrigins.current.forEach((value) => value.node.position({ x: value.x, y: value.y }));
      stage?.batchDraw();
      onBackgroundPreview?.({ x: group.x + deltaX, y: group.y + deltaY }, true);
      onPreview();
      onMove(deltaX, deltaY);
      onGroupHeaderDragChange?.(false);
      onPixelInteractionChange?.(false);
    }}>
    <Rect width={width} height={28} cornerRadius={8} fill="#2c2c2e" opacity={0.94}
      stroke="#ffffff" strokeWidth={0.5} onClick={onSelect} onTap={onSelect} onDblClick={onRename} />
    <Text x={10} y={7} width={Math.max(20, width - 54)} height={16} text={group.name}
      fontFamily="Segoe UI" fontSize={11} fill={group.titleColor} ellipsis listening={false} />
    <GroupTitleButton x={width - 42} kind="collapse"
      label="compact-collapse" color={group.titleColor} onClick={() => onChange({ collapsed: !group.collapsed })} />
    <GroupTitleButton x={width - 21} kind="delete"
      label="compact-delete" color={group.titleColor} onClick={onDelete} />
  </KonvaGroup>;
}

function GroupFrame({ group, selected, scale, memberNodeIds, headerVisible, onPixelInteractionChange, onBackgroundPreview, onSelect, onMove, onPreview, onChange, onDelete, onRename }: {
  group: ImageGroup; selected: boolean; scale: number; memberNodeIds: string[]; headerVisible: boolean;
  onPixelInteractionChange?(active: boolean): void;
  onBackgroundPreview?(patch: Partial<Pick<ImageGroup, 'x' | 'y' | 'width' | 'height'>>, moveDescendants?: boolean): void;
  onSelect(): void; onMove(deltaX: number, deltaY: number): void; onPreview(x?: number, y?: number): void;
  onChange(patch: Partial<ImageGroup>): void; onDelete(): void; onRename(): void;
}) {
  const outlineRef = useRef<Konva.Rect>(null);
  const memberOrigins = useRef<Array<{ node: Konva.Node; x: number; y: number }>>([]);
  const visibleBounds = groupVisibleBounds(group);
  const visibleWidth = visibleBounds.width;
  const visibleHeight = visibleBounds.height;
  return <KonvaGroup id={`group-frame-${group.id}`} name="group-frame" x={group.x} y={group.y}>
    <Rect ref={outlineRef} x={0} y={0} width={visibleWidth} height={visibleHeight}
      stroke={selected ? '#9aa6af' : '#d7dde3'} opacity={selected ? 0.96 : 0.28}
      strokeWidth={(selected ? 1.15 : 0.55) / scale}
      hitStrokeWidth={8 / scale} cornerRadius={group.collapsed ? 7 : 9} fillEnabled={false}
      onClick={onSelect} onTap={onSelect} />
    <KonvaGroup x={0} y={0} draggable onClick={onSelect} onTap={onSelect} onDblClick={onRename}
      onDragStart={(event) => {
        onSelect();
        onPixelInteractionChange?.(true);
        const stage = event.currentTarget.getStage();
        memberOrigins.current = memberNodeIds.flatMap((id) => {
          const node = stage?.findOne(`#${id}`);
          return node ? [{ node, x: node.x(), y: node.y() }] : [];
        });
      }}
      onDragMove={(event) => {
        const deltaX = event.currentTarget.x();
        const deltaY = event.currentTarget.y();
        const stage = event.currentTarget.getStage();
        stage?.findOne(`#group-bg-${group.id}`)?.position({ x: group.x + deltaX, y: group.y + deltaY });
        stage?.findOne(`#group-name-${group.id}`)?.position({ x: group.x + deltaX, y: compactGroupHeaderY(group, scale) + deltaY });
        outlineRef.current?.position({ x: deltaX, y: deltaY });
        memberOrigins.current.forEach((value) => value.node.position({ x: value.x + deltaX, y: value.y + deltaY }));
        onBackgroundPreview?.({ x: group.x + deltaX, y: group.y + deltaY }, true);
        onPreview(group.x + deltaX, group.y + deltaY);
      }}
      onDragEnd={(event) => {
        const dragNode = event.currentTarget;
        const deltaX = dragNode.x();
        const deltaY = dragNode.y();
        const stage = dragNode.getStage();
        // Every preview mutation is restored before the scene command is committed.
        // This prevents react-konva's non-strict node state from applying the drag twice.
        dragNode.position({ x: 0, y: 0 });
        outlineRef.current?.position({ x: 0, y: 0 });
        stage?.findOne(`#group-bg-${group.id}`)?.position({ x: group.x, y: group.y });
        stage?.findOne(`#group-name-${group.id}`)?.position({ x: group.x, y: compactGroupHeaderY(group, scale) });
        memberOrigins.current.forEach((value) => value.node.position({ x: value.x, y: value.y }));
        stage?.batchDraw();
        onBackgroundPreview?.({ x: group.x + deltaX, y: group.y + deltaY }, true);
        onPreview();
        onMove(deltaX, deltaY);
        onPixelInteractionChange?.(false);
      }}>
      <Rect width={visibleWidth} height={GROUP_TITLE_HEIGHT} fill="#000000" opacity={0.001}
        onClick={onSelect}
        onDblClick={(event) => { event.cancelBubble = true; onRename(); }} />
      <Rect width={visibleWidth} height={GROUP_TITLE_HEIGHT} fill="#202328" opacity={0.96}
        visible={headerVisible || group.collapsed}
        cornerRadius={group.collapsed ? 7 : [9, 9, 0, 0]} shadowColor="#000" shadowBlur={7 / scale} shadowOffsetY={2 / scale} shadowOpacity={0.2} />
      <Text x={10} y={7} width={Math.max(16, visibleWidth - 58)} text={group.name}
        fontFamily="Segoe UI" fontStyle="normal" fontSize={11} fill={group.titleColor} ellipsis listening={false} visible={(headerVisible || group.collapsed) && (scale >= COMPACT_GROUP_HEADER_SCALE || group.collapsed)} />
      <Rect x={0} y={GROUP_TITLE_HEIGHT - 0.5 / scale} width={visibleWidth} height={0.5 / scale}
        fill="#ffffff" opacity={0.12} listening={false} visible={headerVisible || group.collapsed} />
      <KonvaGroup visible={(headerVisible || group.collapsed) && (scale >= COMPACT_GROUP_HEADER_SCALE || group.collapsed)}>
        <GroupTitleButton x={visibleWidth - 42} kind="collapse"
          label="collapse" color={group.titleColor} onClick={() => onChange({ collapsed: !group.collapsed })} />
        <GroupTitleButton x={visibleWidth - 21} kind="delete"
          label="delete" color={group.titleColor} onClick={onDelete} />
      </KonvaGroup>
    </KonvaGroup>
  </KonvaGroup>;
}

export function CanvasBoard(props: Props) {
  performanceMonitor.markReactRender();
  const manualInputRecording = new URLSearchParams(window.location.search).get('manual-input-record') === '1';
  const legacyRenderer = new URLSearchParams(window.location.search).get('legacy-renderer') === '1';
  const containerRef = useRef<HTMLDivElement>(null);
  const groupBackgroundCanvasRef = useRef<HTMLCanvasElement>(null);
  const pixelCanvasRef = useRef<HTMLCanvasElement>(null);
  const tileLevelsRef = useRef(new Map<string, number>());
  const [pixelBackend, setPixelBackend] = useState<'webgl2' | 'canvas2d' | 'konva'>('konva');
  const [pixelInteractionActive, setPixelInteractionActive] = useState(false);
  const transformerRef = useRef<Konva.Transformer>(null);
  const gpuSelectionProxyRef = useRef<Konva.Rect>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const delayedViewport = useSettledViewport(props.scene.viewport);
  const [qualityViewport, setQualityViewport] = useState(props.scene.viewport);
  const qualityViewportRef = useRef(props.scene.viewport);
  const [draftAnnotation, setDraftAnnotation] = useState<AnnotationItem>();
  const [eraserPoint, setEraserPoint] = useState<{ x: number; y: number }>();
  const [pickerPreview, setPickerPreview] = useState<{ x: number; y: number; color?: PickedColor; itemName?: string; reason?: string }>();
  const [expandedCommentId, setExpandedCommentId] = useState<string>();
  const [hoveredCommentImageId, setHoveredCommentImageId] = useState<string>();
  const [qualityFocus, setQualityFocus] = useState<{ imageId: string; x: number; y: number }>();
  const qualityFocusRef = useRef<typeof qualityFocus>(undefined);
  const [hoveredGroupId, setHoveredGroupId] = useState<string>();
  const selectionRectRef = useRef<Konva.Rect>(null);
  const commentHideTimerRef = useRef<number | undefined>(undefined);
  const groupHeaderHideTimerRef = useRef<number | undefined>(undefined);
  const pickerPreviewRef = useRef<typeof pickerPreview>(undefined);
  const pickerSampleSequenceRef = useRef(0);
  const pointerVisualFrameRef = useRef<number | undefined>(undefined);
  const draftAnnotationRef = useRef<AnnotationItem | undefined>(undefined);
  const pendingEraserPointRef = useRef<{ x: number; y: number } | undefined>(undefined);
  const pendingPickerPointRef = useRef<{ world: { x: number; y: number }; screen: { x: number; y: number } } | undefined>(undefined);
  const cornerRotationRef = useRef<{ origins: ImageItem[]; startAngle: number; changes: Array<Partial<ImageItem> & { id: string }> } | undefined>(undefined);
  const selectionBoxRef = useRef<{ x: number; y: number; width: number; height: number } | undefined>(undefined);
  const selectionPointerRef = useRef<{ x: number; y: number } | undefined>(undefined);
  const selectionPanFrameRef = useRef<number | undefined>(undefined);
  const viewportCommitTimerRef = useRef<number | undefined>(undefined);
  const viewportVisualFrameRef = useRef<number | undefined>(undefined);
  const lastViewportStatsAtRef = useRef(0);
  const reactRenderCountRef = useRef(0);
  const manualWheelTimerRef = useRef<number | undefined>(undefined);
  const manualWheelSessionRef = useRef<{
    startedAt: number; lastEventAt: number; startViewport: Viewport; startReactRenders: number;
    startUploads: number; events: Array<{ atMs: number; gapMs: number; deltaY: number; deltaMode: number; handlerMs: number }>;
    frameIntervals: number[]; lastFrameAt?: number; frameId?: number;
  } | undefined>(undefined);
  reactRenderCountRef.current += 1;
  const viewportGestureActiveRef = useRef(false);
  const viewportGestureBaseRef = useRef(props.scene.viewport);
  const finishSelectionRef = useRef<() => void>(() => undefined);
  const viewportRef = useRef(props.scene.viewport);
  if (!viewportGestureActiveRef.current) viewportRef.current = props.scene.viewport;
  const gesture = useRef<{
    mode: 'pan' | 'select' | 'window' | 'annotate' | 'erase' | 'pick-color' | 'image'; startX: number; startY: number; viewport: Viewport;
    lastScreenX?: number; lastScreenY?: number; moved?: boolean;
    imageMode?: ImageDragMode; imageId?: string; origins?: ImageItem[]; imageIds?: ReadonlySet<string>;
    startScreenX?: number; startRotation?: number; startOpacity?: number;
    deltaX?: number; deltaY?: number; factor?: number; deltaDegrees?: number; opacity?: number;
  } | undefined>(undefined);
  const suppressContextMenuUntil = useRef(0);

  useEffect(() => {
    qualityViewportRef.current = delayedViewport;
    setQualityViewport(delayedViewport);
  }, [delayedViewport]);

  const setCommentHover = (id: string | undefined, hovered: boolean) => {
    if (commentHideTimerRef.current !== undefined) window.clearTimeout(commentHideTimerRef.current);
    if (hovered && id) setHoveredCommentImageId(id);
    else commentHideTimerRef.current = window.setTimeout(() => {
      setHoveredCommentImageId((current) => !id || current === id ? undefined : current);
    }, 90);
  };

  const showGroupHeader = (id?: string) => {
    if (groupHeaderHideTimerRef.current !== undefined) window.clearTimeout(groupHeaderHideTimerRef.current);
    groupHeaderHideTimerRef.current = undefined;
    setHoveredGroupId(id);
  };

  const hideGroupHeaderSoon = () => {
    if (groupHeaderHideTimerRef.current !== undefined) window.clearTimeout(groupHeaderHideTimerRef.current);
    groupHeaderHideTimerRef.current = window.setTimeout(() => {
      groupHeaderHideTimerRef.current = undefined;
      setHoveredGroupId(undefined);
    }, 140);
  };

  const orderedItems = useMemo(() => [...props.scene.items].sort((a, b) => a.zIndex - b.zIndex), [props.scene.items]);
  const selectedIdSet = useMemo(() => new Set(props.selectedIds), [props.selectedIds]);
  const itemById = useMemo(() => new Map(props.scene.items.map((item) => [item.id, item])), [props.scene.items]);
  const annotationById = useMemo(() => new Map(props.scene.annotations.map((item) => [item.id, item])), [props.scene.annotations]);
  const groupById = useMemo(() => new Map(props.scene.groups.map((group) => [group.id, group])), [props.scene.groups]);
  const imageIndex = useMemo(() => new SpatialIndex(props.scene.items.map((item) => ({ id: item.id, ...itemBounds(item) }))), [props.scene.items]);
  const annotationIndex = useMemo(() => new SpatialIndex(props.scene.annotations.map((item) => ({ id: item.id, ...annotationSceneBounds(item) }))), [props.scene.annotations]);
  const groupIndex = useMemo(() => new SpatialIndex(props.scene.groups.map((group) => ({ id: group.id, ...groupVisibleBounds(group) }))), [props.scene.groups]);
  const renderBounds = useMemo(() => viewportWorldBounds(props.scene.viewport, size), [props.scene.viewport, size]);
  const settledRenderBounds = useMemo(() => viewportWorldBounds(qualityViewport, size), [qualityViewport, size]);
  const settledTileImageIds = useMemo(() => new Set(imageIndex.query(settledRenderBounds)), [imageIndex, settledRenderBounds]);
  const preloadRenderBounds = useMemo(() => ({
    x: settledRenderBounds.x - settledRenderBounds.width * 0.75,
    y: settledRenderBounds.y - settledRenderBounds.height * 0.75,
    width: settledRenderBounds.width * 2.5,
    height: settledRenderBounds.height * 2.5,
  }), [settledRenderBounds]);
  const preloadTileImageIds = useMemo(() => new Set(imageIndex.query(preloadRenderBounds)), [imageIndex, preloadRenderBounds]);
  const renderedImageIds = useMemo(() => {
    const result = new Set(imageIndex.query(renderBounds));
    props.selectedIds.forEach((id) => result.add(id));
    return result;
  }, [imageIndex, props.selectedIds, renderBounds]);
  const renderedAnnotationIds = useMemo(() => {
    const result = new Set(annotationIndex.query(renderBounds));
    props.selectedAnnotationIds.forEach((id) => result.add(id));
    return result;
  }, [annotationIndex, props.selectedAnnotationIds, renderBounds]);
  const renderedGroupIds = useMemo(() => {
    const result = new Set(groupIndex.query(renderBounds));
    if (props.selectedGroupId) result.add(props.selectedGroupId);
    return result;
  }, [groupIndex, props.selectedGroupId, renderBounds]);
  const renderedItems = useMemo(() => orderedItems.filter((item) => renderedImageIds.has(item.id)), [orderedItems, renderedImageIds]);
  const qualityImageIds = useMemo(
    () => new Set([...settledTileImageIds, ...renderedImageIds]),
    [renderedImageIds, settledTileImageIds],
  );
  const selectedMovableItems = useMemo(() => orderedItems.filter((item) => selectedIdSet.has(item.id) && !item.locked), [orderedItems, selectedIdSet]);
  const selectionProxyBounds = useMemo(() => selectedMovableItems.length ? sceneBounds(selectedMovableItems) : undefined, [selectedMovableItems]);
  const groupVisibility = useMemo(() => {
    const hiddenImages = new Set(props.scene.items.filter((item) => item.hidden).map((item) => item.id));
    const hiddenAnnotations = new Set(props.scene.annotations.filter((item) => item.hidden).map((item) => item.id));
    const hiddenGroups = new Set<string>();
    const visit = (groupId: string, hideFrame: boolean, visited = new Set<string>()) => {
      if (visited.has(groupId)) return;
      visited.add(groupId);
      const group = groupById.get(groupId);
      if (!group) return;
      if (hideFrame) hiddenGroups.add(groupId);
      for (const member of group.members) {
        if (member.type === 'image') hiddenImages.add(member.id);
        else if (member.type === 'annotation') hiddenAnnotations.add(member.id);
        else if (member.type === 'group') visit(member.id, true, visited);
      }
    };
    props.scene.groups.forEach((group) => {
      if (group.contentsHidden || group.collapsed) group.members.forEach((member) => {
        if (member.type === 'image') hiddenImages.add(member.id);
        else if (member.type === 'annotation') hiddenAnnotations.add(member.id);
        else if (member.type === 'group') visit(member.id, true);
      });
    });
    return { hiddenImages, hiddenAnnotations, hiddenGroups };
  }, [groupById, props.scene.annotations, props.scene.groups, props.scene.items]);

  const visibleRenderedGroups = useMemo(() => props.scene.groups.filter((group) => (
    renderedGroupIds.has(group.id) && !groupVisibility.hiddenGroups.has(group.id)
  )), [groupVisibility.hiddenGroups, props.scene.groups, renderedGroupIds]);

  useEffect(() => {
    const canvas = groupBackgroundCanvasRef.current;
    if (!canvas) return;
    if (pixelBackend === 'konva') {
      const context = canvas.getContext('2d');
      context?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    renderGroupBackgrounds(canvas, visibleRenderedGroups, props.scene.viewport, size);
  }, [pixelBackend, props.scene.viewport, size, visibleRenderedGroups]);

  const previewGroupBackground = useCallback((
    id: string,
    patch: Partial<Pick<ImageGroup, 'x' | 'y' | 'width' | 'height'>>,
    moveDescendants = false,
  ) => {
    const canvas = groupBackgroundCanvasRef.current;
    if (!canvas || pixelBackend === 'konva') return;
    const source = groupById.get(id);
    const deltaX = patch.x !== undefined && source ? patch.x - source.x : 0;
    const deltaY = patch.y !== undefined && source ? patch.y - source.y : 0;
    const descendants = new Set<string>();
    const collectDescendants = (groupId: string) => {
      const group = groupById.get(groupId);
      if (!group) return;
      group.members.forEach((member) => {
        if (member.type !== 'group' || descendants.has(member.id)) return;
        descendants.add(member.id);
        collectDescendants(member.id);
      });
    };
    if (moveDescendants) collectDescendants(id);
    renderGroupBackgrounds(canvas, visibleRenderedGroups.map((group) => {
      if (group.id === id) return { ...group, ...patch };
      return descendants.has(group.id) ? { ...group, x: group.x + deltaX, y: group.y + deltaY } : group;
    }), props.scene.viewport, size);
  }, [groupById, pixelBackend, props.scene.viewport, size, visibleRenderedGroups]);

  const groupMemberNodeIds = (groupId: string, visited = new Set<string>()): string[] => {
    if (visited.has(groupId)) return [];
    visited.add(groupId);
    const group = groupById.get(groupId);
    if (!group) return [];
    return group.members.flatMap((member) => member.type === 'image'
      ? [member.id, ...(itemById.get(member.id)?.comment ? [`comment-${member.id}`] : [])]
      : member.type === 'annotation' ? [`annotation-${member.id}`]
        : member.type === 'group' ? [`group-bg-${member.id}`, `group-frame-${member.id}`, `group-name-${member.id}`, ...groupMemberNodeIds(member.id, visited)] : []);
  };

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const pixelPlan = usePixelScenePlan({
    orderedItems,
    hiddenImageIds: groupVisibility.hiddenImages,
    itemById,
    settledBounds: settledRenderBounds,
    settledImageIds: qualityImageIds,
    preloadBounds: preloadRenderBounds,
    preloadImageIds: preloadTileImageIds,
    settledScale: qualityViewport.scale,
    tileLevelsRef,
    qualityFocus,
  });

  const pixelCommands = pixelPlan.commands;
  const gpuPrewarmCommandIds = useMemo(
    () => pixelPlan.gpuPrewarm.map((resource) => resource.commandId),
    [pixelPlan.gpuPrewarm],
  );
  const visibleFinalCommandIds = useMemo(() => {
    const groups = new Map<string, typeof pixelCommands>();
    pixelCommands.forEach((command) => {
      const imageId = command.imageId ?? command.id;
      if (!qualityImageIds.has(imageId)) return;
      const group = groups.get(imageId);
      if (group) group.push(command);
      else groups.set(imageId, [command]);
    });
    const result: string[] = [];
    groups.forEach((group) => {
      const final = group.filter((command) => command.id.endsWith(':detail') || command.id.includes(':tile:'));
      result.push(...(final.length ? final : group).map((command) => command.id));
    });
    return result;
  }, [pixelCommands, qualityImageIds]);
  const pixelRenderer = usePixelRenderer({
    canvasRef: pixelCanvasRef,
    commands: pixelCommands,
    prewarmCommandIds: gpuPrewarmCommandIds,
    protectedCommandIds: visibleFinalCommandIds,
    itemsById: itemById,
    selectedIds: props.selectedIds,
    viewport: props.scene.viewport,
    size,
    stageRef: props.stageRef,
    backend: pixelBackend,
    setBackend: setPixelBackend,
    interactionActive: pixelInteractionActive,
    setInteractionActive: setPixelInteractionActive,
    enabled: !legacyRenderer,
  });
  const {
    setPixelImage,
    setUploadPause: setPixelUploadPause,
    schedulePreviewRender: schedulePixelPreviewRender,
    scheduleViewportRender: schedulePixelViewportRender,
    settleViewportForPointerGesture: settlePixelViewportForPointerGesture,
    getStats: getPixelStats,
    previewResourcesReady,
    loadedCommandCount,
    loadedTileCommandCount,
  } = pixelRenderer;
  const setPixelInteraction = useCallback((active: boolean) => {
    setPixelUploadPause(active);
    setPixelInteractionActive(active);
  }, [setPixelUploadPause]);

  const publishViewportDiagnostics = useCallback((next: Viewport) => {
    if (!performanceMonitor.enabled) return;
    const host = containerRef.current;
    host?.setAttribute('data-viewport-x', String(Math.round(next.x)));
    host?.setAttribute('data-viewport-y', String(Math.round(next.y)));
    host?.setAttribute('data-viewport-scale', String(next.scale));
    if (performance.now() - lastViewportStatsAtRef.current < 250) return;
    lastViewportStatsAtRef.current = performance.now();
    const stats = getPixelStats();
    host?.setAttribute('data-frame-p95-ms', stats.frameP95Ms.toFixed(2));
    host?.setAttribute('data-draw-calls', String(stats.drawCalls));
    host?.setAttribute('data-bind-texture-calls', String(stats.bindTextureCalls));
    host?.setAttribute('data-buffer-data-calls', String(stats.bufferDataCalls));
    host?.setAttribute('data-buffer-sub-data-calls', String(stats.bufferSubDataCalls));
    host?.setAttribute('data-tex-image-2d-calls', String(stats.texImage2DCalls));
    host?.setAttribute('data-tex-sub-image-2d-calls', String(stats.texSubImage2DCalls));
    host?.setAttribute('data-texture-upload-ms', stats.textureUploadMs.toFixed(2));
    host?.setAttribute('data-gpu-textures', String(stats.textureCount));
    host?.setAttribute('data-gpu-bytes', String(stats.gpuBytes));
    host?.setAttribute('data-lod-coverage', stats.minimumLodCoverage.toFixed(3));
    host?.setAttribute('data-lod-command', stats.minimumLodCommandId);
    host?.setAttribute('data-lod-resident-size', stats.minimumLodResidentSize);
    host?.setAttribute('data-lod-plan', stats.minimumLodPlan);
    host?.setAttribute('data-lod-residency', stats.minimumLodResidency);
    host?.setAttribute('data-lod-loaded', stats.minimumLodLoaded);
    host?.setAttribute('data-pending-resources', String(stats.pendingResourceCount));
    host?.setAttribute('data-blocked-resources', String(stats.blockedResourceCount));
    host?.setAttribute('data-full-instance-uploads', String(stats.fullInstanceUploads));
    host?.setAttribute('data-prewarm-commands', String(stats.prewarmCommandCount));
    host?.setAttribute('data-prewarm-resident', String(stats.prewarmResidentCount));
    host?.setAttribute('data-resource-retries', String(stats.resourceRetryCount));
    host?.setAttribute('data-atlas-free-area', String(stats.atlasFreeArea ?? 0));
    host?.setAttribute('data-atlas-largest-free-rect', String(stats.atlasLargestFreeRectArea ?? 0));
    host?.setAttribute('data-texture-command-count', String(stats.textureCommandCount ?? 0));
    host?.setAttribute('data-active-texture-count', String(stats.activeTextureCount ?? 0));
  }, [getPixelStats]);

  useEffect(() => {
    if (!performanceMonitor.enabled) return undefined;
    const timer = window.setInterval(() => publishViewportDiagnostics(viewportRef.current), 100);
    return () => window.clearInterval(timer);
  }, [publishViewportDiagnostics]);

  const applyLiveViewport = useCallback((next: Viewport) => {
    viewportRef.current = next;
    props.onViewportPreview?.(next);
    // WebGL gestures are camera-only. Rebuilding the LOD plan at intermediate
    // wheel scales made large scenes pause every few frames; the settled
    // viewport effect updates quality once after the gesture commits.
    const stage = props.stageRef.current;
    if (stage) {
      if (pixelBackend === 'konva') {
        stage.position({ x: next.x, y: next.y });
        stage.scale({ x: next.scale, y: next.scale });
        stage.batchDraw();
        publishViewportDiagnostics(next);
      } else if (viewportVisualFrameRef.current === undefined) {
        viewportVisualFrameRef.current = requestAnimationFrame(() => {
          viewportVisualFrameRef.current = undefined;
          const live = viewportRef.current;
          const base = viewportGestureBaseRef.current;
          const ratio = live.scale / Math.max(0.00001, base.scale);
          const translateX = live.x - base.x * ratio;
          const translateY = live.y - base.y * ratio;
          const content = props.stageRef.current?.container();
          if (content) {
            content.style.transformOrigin = '0 0';
            content.style.transform = `matrix(${ratio}, 0, 0, ${ratio}, ${translateX}, ${translateY})`;
          }
          if (groupBackgroundCanvasRef.current && visibleRenderedGroups.length) {
            renderGroupBackgrounds(groupBackgroundCanvasRef.current, visibleRenderedGroups, live, size);
          }
          publishViewportDiagnostics(live);
        });
      }
    }
    schedulePixelViewportRender(next);
  }, [pixelBackend, props.onViewportPreview, props.stageRef, publishViewportDiagnostics, schedulePixelViewportRender, size, visibleRenderedGroups]);

  const beginViewportGesture = useCallback(() => {
    if (!viewportGestureActiveRef.current) viewportGestureBaseRef.current = { ...viewportRef.current };
    viewportGestureActiveRef.current = true;
    setPixelInteraction(true);
    if (viewportCommitTimerRef.current !== undefined) window.clearTimeout(viewportCommitTimerRef.current);
    viewportCommitTimerRef.current = undefined;
  }, [setPixelInteraction]);

  const commitViewportGesture = useCallback(() => {
    if (viewportCommitTimerRef.current !== undefined) window.clearTimeout(viewportCommitTimerRef.current);
    viewportCommitTimerRef.current = undefined;
    if (!viewportGestureActiveRef.current) return;
    viewportGestureActiveRef.current = false;
    const stage = props.stageRef.current;
    if (stage && pixelBackend !== 'konva') {
      stage.position({ x: viewportRef.current.x, y: viewportRef.current.y });
      stage.scale({ x: viewportRef.current.scale, y: viewportRef.current.scale });
      stage.draw();
      stage.container().style.transform = '';
    }
    props.onViewportChange({ ...viewportRef.current });
    setPixelInteraction(false);
  }, [pixelBackend, props.onViewportChange, props.stageRef, setPixelInteraction]);

  const commitViewportGestureSoon = useCallback(() => {
    if (viewportCommitTimerRef.current !== undefined) window.clearTimeout(viewportCommitTimerRef.current);
    viewportCommitTimerRef.current = window.setTimeout(commitViewportGesture, 400);
  }, [commitViewportGesture]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host || props.colorPickerShortcut !== 's') return undefined;
    const localPoint = (event: MouseEvent) => {
      const bounds = host.getBoundingClientRect();
      return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    };
    const isAltPanStart = (event: MouseEvent) => event.button === 0
      && event.altKey && !event.ctrlKey && !event.shiftKey;
    const consume = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    const finishPan = (event?: MouseEvent) => {
      if (gesture.current?.mode !== 'pan') return;
      if (event) consume(event);
      gesture.current = undefined;
      commitViewportGesture();
    };
    const startPan = (event: MouseEvent) => {
      if (!isAltPanStart(event)) return;
      consume(event);
      const point = localPoint(event);
      const settled = settlePixelViewportForPointerGesture();
      const hadPendingVisualFrame = viewportVisualFrameRef.current !== undefined;
      if (viewportVisualFrameRef.current !== undefined) cancelAnimationFrame(viewportVisualFrameRef.current);
      viewportVisualFrameRef.current = undefined;
      viewportRef.current = settled.viewport;
      if (settled.discardedPendingFrame || hadPendingVisualFrame) {
        const stage = props.stageRef.current;
        if (stage) {
          stage.position({ x: settled.viewport.x, y: settled.viewport.y });
          stage.scale({ x: settled.viewport.scale, y: settled.viewport.scale });
          stage.draw();
          stage.container().style.transform = '';
        }
        viewportGestureBaseRef.current = { ...settled.viewport };
      }
      transformerRef.current?.stopTransform();
      beginViewportGesture();
      gesture.current = {
        mode: 'pan', startX: point.x, startY: point.y,
        viewport: { ...viewportRef.current },
      };
    };
    const movePan = (event: MouseEvent) => {
      const active = gesture.current;
      if (active?.mode !== 'pan') return;
      if ((event.buttons & 1) === 0) {
        finishPan(event);
        return;
      }
      consume(event);
      const point = localPoint(event);
      applyLiveViewport({
        ...viewportRef.current,
        x: active.viewport.x + point.x - active.startX,
        y: active.viewport.y + point.y - active.startY,
      });
    };
    const releasePan = (event: MouseEvent) => {
      if (event.button === 0) finishPan(event);
    };
    const blurPan = () => finishPan();
    host.addEventListener('mousedown', startPan, true);
    window.addEventListener('mousemove', movePan, true);
    window.addEventListener('mouseup', releasePan, true);
    window.addEventListener('blur', blurPan);
    return () => {
      host.removeEventListener('mousedown', startPan, true);
      window.removeEventListener('mousemove', movePan, true);
      window.removeEventListener('mouseup', releasePan, true);
      window.removeEventListener('blur', blurPan);
    };
  }, [applyLiveViewport, beginViewportGesture, commitViewportGesture, props.colorPickerShortcut, props.stageRef,
    settlePixelViewportForPointerGesture]);

  const markTileFailed = useCallback((itemId: string) => {
    rendererWarn('tile.failed-after-retries', { itemId });
  }, []);
  const ignoreResourceError = useCallback(() => undefined, []);

  useEffect(() => {
    if (hoveredGroupId && (!props.scene.groups.some((group) => group.id === hoveredGroupId)
      || groupVisibility.hiddenGroups.has(hoveredGroupId))) setHoveredGroupId(undefined);
  }, [groupVisibility.hiddenGroups, hoveredGroupId, props.scene.groups]);

  useEffect(() => () => {
    if (groupHeaderHideTimerRef.current !== undefined) window.clearTimeout(groupHeaderHideTimerRef.current);
    if (viewportCommitTimerRef.current !== undefined) window.clearTimeout(viewportCommitTimerRef.current);
    if (viewportVisualFrameRef.current !== undefined) cancelAnimationFrame(viewportVisualFrameRef.current);
    if (manualWheelTimerRef.current !== undefined) window.clearTimeout(manualWheelTimerRef.current);
    if (manualWheelSessionRef.current?.frameId !== undefined) cancelAnimationFrame(manualWheelSessionRef.current.frameId);
    if (pointerVisualFrameRef.current !== undefined) cancelAnimationFrame(pointerVisualFrameRef.current);
  }, []);

  useEffect(() => {
    if (viewportCommitTimerRef.current !== undefined) window.clearTimeout(viewportCommitTimerRef.current);
    if (viewportVisualFrameRef.current !== undefined) cancelAnimationFrame(viewportVisualFrameRef.current);
    viewportCommitTimerRef.current = undefined;
    viewportVisualFrameRef.current = undefined;
    viewportGestureActiveRef.current = false;
    gesture.current = undefined;
    viewportRef.current = { ...props.scene.viewport };
    viewportGestureBaseRef.current = { ...props.scene.viewport };
    setPixelUploadPause(false);
    const stage = props.stageRef.current;
    if (stage) {
      stage.position({ x: props.scene.viewport.x, y: props.scene.viewport.y });
      stage.scale({ x: props.scene.viewport.scale, y: props.scene.viewport.scale });
      stage.container().style.transform = '';
    }
  }, [props.projectEpoch, props.scene.viewport, props.stageRef, setPixelUploadPause]);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get('stress') !== '2000' && !query.has('project-bench')) return;
    const setStressViewport = (event: Event) => props.onViewportChange((event as CustomEvent<Viewport>).detail);
    const setBenchmarkQualityFocus = (event: Event) => {
      const next = (event as CustomEvent<{ imageId: string; x: number; y: number }>).detail;
      qualityFocusRef.current = next;
      setQualityFocus(next);
    };
    window.addEventListener('refcanvas-stress-viewport', setStressViewport);
    window.addEventListener('refcanvas-benchmark-quality-focus', setBenchmarkQualityFocus);
    return () => {
      window.removeEventListener('refcanvas-stress-viewport', setStressViewport);
      window.removeEventListener('refcanvas-benchmark-quality-focus', setBenchmarkQualityFocus);
    };
  }, [props.onViewportChange]);

  useEffect(() => {
    const finishWindowMove = () => {
      if (gesture.current?.mode !== 'window') return;
      props.onWindowMoveEnd();
      if (gesture.current.moved) suppressContextMenuUntil.current = Date.now() + 350;
      gesture.current = undefined;
    };
    window.addEventListener('mouseup', finishWindowMove);
    window.addEventListener('blur', finishWindowMove);
    return () => {
      window.removeEventListener('mouseup', finishWindowMove);
      window.removeEventListener('blur', finishWindowMove);
    };
  }, [props.onWindowMoveEnd]);

  useEffect(() => window.refCanvas?.onWindowMoveFinished(() => {
    if (gesture.current?.mode !== 'window') return;
    props.onWindowMoveEnd();
    gesture.current.moved = true;
    suppressContextMenuUntil.current = Date.now() + 350;
    gesture.current = undefined;
  }), [props.onWindowMoveEnd]);

  useEffect(() => {
    const stage = props.stageRef.current;
    if (!stage || !transformerRef.current) return;
    const group = props.selectedGroupId ? props.scene.groups.find((value) => value.id === props.selectedGroupId) : undefined;
    const nodes = props.annotationMode ? [] : group && !group.sizeLocked && !group.collapsed
      ? [stage.findOne(`#group-frame-${group.id}`)].filter((node): node is Konva.Node => Boolean(node))
      : pixelBackend !== 'konva' && gpuSelectionProxyRef.current
        ? [gpuSelectionProxyRef.current]
      : props.selectedIds
        .filter((id) => !props.scene.items.find((item) => item.id === id)?.locked)
        .map((id) => stage.findOne(`#${id}`))
        .filter((node): node is Konva.Node => Boolean(node));
    transformerRef.current.nodes(nodes);
    transformerRef.current.getLayer()?.batchDraw();
  }, [pixelBackend, props.annotationMode, props.selectedGroupId, props.selectedIds, props.scene.groups, props.scene.items, props.stageRef]);

  useEffect(() => {
    if (props.annotationMode) return;
    if (gesture.current?.mode === 'erase') props.onEraseEnd();
    if (gesture.current?.mode === 'annotate' || gesture.current?.mode === 'erase') gesture.current = undefined;
    setDraftAnnotation(undefined);
    setEraserPoint(undefined);
  }, [props.annotationMode, props.onEraseEnd]);

  const screenPoint = () => props.stageRef.current?.getPointerPosition();
  const worldPoint = () => {
    const point = screenPoint();
    if (!point) return;
    const viewport = viewportRef.current;
    return {
      x: (point.x - viewport.x) / viewport.scale,
      y: (point.y - viewport.y) / viewport.scale,
    };
  };

  const updateGroupHeaderHover = (event: Konva.KonvaEventObject<MouseEvent>) => {
    const point = event.target.getStage()?.getPointerPosition();
    if (!point) return;
    const viewport = viewportRef.current;
    const world = { x: (point.x - viewport.x) / viewport.scale, y: (point.y - viewport.y) / viewport.scale };
    const groupId = topmostVisibleGroupAtPoint(
      props.scene.groups,
      groupIndex.query(renderBounds),
      groupVisibility.hiddenGroups,
      world,
    );
    const compactHeaderGroup = props.scene.groups.find((group) => {
      if (group.collapsed || viewport.scale >= COMPACT_GROUP_HEADER_SCALE) return false;
      const bounds = compactGroupHeaderBounds(group, viewport.scale);
      return world.x >= bounds.x && world.x <= bounds.x + bounds.width
        && world.y >= bounds.y && world.y <= bounds.y + bounds.height;
    });
    if (compactHeaderGroup && !groupVisibility.hiddenGroups.has(compactHeaderGroup.id)) showGroupHeader(compactHeaderGroup.id);
    else if (groupId) showGroupHeader(groupId);
    else hideGroupHeaderSoon();
  };

  const updateSelectionBox = (box?: { x: number; y: number; width: number; height: number }) => {
    selectionBoxRef.current = box;
    const node = selectionRectRef.current;
    if (!node) return;
    if (!box) node.visible(false);
    else {
      node.setAttrs(box);
      node.strokeWidth(1 / Math.max(0.00001, viewportRef.current.scale));
      node.visible(true);
    }
    node.getLayer()?.batchDraw();
  };

  const previewSelectionOverlay = (preview: CompactImageGesture) => {
    const point = (x: number, y: number) => {
      if (preview.kind === 'move') return { x: x + preview.deltaX, y: y + preview.deltaY };
      if (preview.kind === 'scale') return {
        x: preview.centerX + (x - preview.centerX) * preview.factor,
        y: preview.centerY + (y - preview.centerY) * preview.factor,
      };
      if (preview.kind === 'bounds') return {
        x: preview.targetX + (x - preview.sourceX) * preview.scaleX,
        y: preview.targetY + (y - preview.sourceY) * preview.scaleY,
      };
      if (preview.kind === 'rotate') {
        const radians = preview.deltaDegrees * Math.PI / 180;
        const deltaX = x - preview.centerX; const deltaY = y - preview.centerY;
        return {
          x: preview.centerX + deltaX * Math.cos(radians) - deltaY * Math.sin(radians),
          y: preview.centerY + deltaX * Math.sin(radians) + deltaY * Math.cos(radians),
        };
      }
      return { x, y };
    };
    const proxy = gpuSelectionProxyRef.current;
    if (proxy && selectionProxyBounds && preview.kind !== 'opacity' && preview.kind !== 'rotate') {
      const topLeft = point(selectionProxyBounds.x, selectionProxyBounds.y);
      const bottomRight = point(selectionProxyBounds.x + selectionProxyBounds.width, selectionProxyBounds.y + selectionProxyBounds.height);
      proxy.setAttrs({
        x: Math.min(topLeft.x, bottomRight.x), y: Math.min(topLeft.y, bottomRight.y),
        width: Math.abs(bottomRight.x - topLeft.x), height: Math.abs(bottomRight.y - topLeft.y),
      });
      transformerRef.current?.forceUpdate();
    }
    if (preview.kind !== 'opacity') rotationHandles.forEach((corner) => {
      props.stageRef.current?.findOne(`#rotation-corner-${corner.key}`)?.position(point(corner.x, corner.y));
    });
    proxy?.getLayer()?.batchDraw();
  };

  const updateSelectionAtScreenPoint = (point: { x: number; y: number }, viewport = viewportRef.current) => {
    if (gesture.current?.mode !== 'select') return;
    const endX = (Math.max(0, Math.min(size.width, point.x)) - viewport.x) / viewport.scale;
    const endY = (Math.max(0, Math.min(size.height, point.y)) - viewport.y) / viewport.scale;
    updateSelectionBox({
      x: Math.min(gesture.current.startX, endX),
      y: Math.min(gesture.current.startY, endY),
      width: Math.abs(endX - gesture.current.startX),
      height: Math.abs(endY - gesture.current.startY),
    });
  };

  const stopSelectionAutoPan = () => {
    if (selectionPanFrameRef.current !== undefined) cancelAnimationFrame(selectionPanFrameRef.current);
    selectionPanFrameRef.current = undefined;
  };

  const selectionAutoPanStep = () => {
    if (gesture.current?.mode !== 'select' || !selectionPointerRef.current) {
      selectionPanFrameRef.current = undefined;
      return;
    }
    const pointer = selectionPointerRef.current;
    const threshold = Math.max(12, Math.min(36, Math.min(size.width, size.height) / 3));
    const deltaX = edgeAutoPanDelta(pointer.x, size.width, threshold);
    const deltaY = edgeAutoPanDelta(pointer.y, size.height, threshold);
    if (deltaX || deltaY) {
      const current = viewportRef.current;
      const next = { ...current, x: current.x + deltaX, y: current.y + deltaY };
      beginViewportGesture();
      applyLiveViewport(next);
      updateSelectionAtScreenPoint(pointer, next);
    }
    selectionPanFrameRef.current = requestAnimationFrame(selectionAutoPanStep);
  };

  const startSelectionAutoPan = () => {
    stopSelectionAutoPan();
    selectionPanFrameRef.current = requestAnimationFrame(selectionAutoPanStep);
  };

  const sampleColor = async (world: { x: number; y: number }, screen: { x: number; y: number }) => {
    const sequence = ++pickerSampleSequenceRef.current;
    const candidates = imageIndex.query({ x: world.x, y: world.y, width: 0.001, height: 0.001 })
      .map((id) => itemById.get(id)).filter((item): item is ImageItem => Boolean(item));
    const hit = topmostImagePixel(candidates, groupVisibility.hiddenImages, world.x, world.y);
    let preview: typeof pickerPreview;
    if (!hit) preview = { ...screen, reason: '未命中图片' };
    else {
      try {
          if (!hit.item.assetId) throw new Error('取色资源缺少 Asset ID');
          const api = window.refCanvas;
          if (!api) throw new Error('取色服务不可用');
          const data = await api.sampleImagePixel(hit.item.assetId, hit.pixel.x, hit.pixel.y);
          const color = pickedColorFromRgba(data.r, data.g, data.b, data.a);
          preview = color
            ? { ...screen, color, itemName: hit.item.name }
            : { ...screen, itemName: hit.item.name, reason: '透明像素' };
        } catch {
          preview = { ...screen, itemName: hit.item.name, reason: '无法读取像素' };
        }
    }
    if (sequence !== pickerSampleSequenceRef.current || gesture.current?.mode !== 'pick-color') return;
    pickerPreviewRef.current = preview;
    setPickerPreview(preview);
  };

  const flushPointerVisuals = () => {
    pointerVisualFrameRef.current = undefined;
    if (draftAnnotationRef.current) setDraftAnnotation(draftAnnotationRef.current);
    const erase = pendingEraserPointRef.current;
    pendingEraserPointRef.current = undefined;
    if (erase) {
      setEraserPoint(erase);
      props.onEraseAt(erase.x, erase.y, 12 / viewportRef.current.scale);
    }
    const picker = pendingPickerPointRef.current;
    pendingPickerPointRef.current = undefined;
    if (picker) void sampleColor(picker.world, picker.screen);
  };

  const schedulePointerVisuals = () => {
    if (pointerVisualFrameRef.current === undefined) pointerVisualFrameRef.current = requestAnimationFrame(flushPointerVisuals);
  };

  useEffect(() => {
    if (props.colorPickerHeld) return;
    if (gesture.current?.mode === 'pick-color') gesture.current = undefined;
    pickerPreviewRef.current = undefined;
    setPickerPreview(undefined);
  }, [props.colorPickerHeld]);

  const imageAtWorldPoint = (world: { x: number; y: number }) => {
    const candidates = imageIndex.query({ x: world.x, y: world.y, width: 0.001, height: 0.001 })
      .map((id) => itemById.get(id)).filter((item): item is ImageItem => Boolean(item));
    return topmostImagePixel(candidates, groupVisibility.hiddenImages, world.x, world.y)?.item;
  };

  const updateQualityFocus = (item: ImageItem | undefined, world: { x: number; y: number } | undefined) => {
    if (!item || !world) {
      if (qualityFocusRef.current) {
        qualityFocusRef.current = undefined;
        setQualityFocus(undefined);
      }
      return;
    }
    const current = qualityFocusRef.current;
    const movedScreenPixels = current?.imageId === item.id
      ? Math.hypot(world.x - current.x, world.y - current.y) * viewportRef.current.scale
      : Number.POSITIVE_INFINITY;
    if (current?.imageId === item.id && movedScreenPixels < 96) return;
    const next = { imageId: item.id, x: world.x, y: world.y };
    qualityFocusRef.current = next;
    setQualityFocus(next);
  };

  const beginGpuImageGesture = (item: ImageItem, raw: MouseEvent, world: { x: number; y: number }) => {
    const shift = raw.shiftKey;
    const nextSelection = shift
      ? props.selectedIds.includes(item.id) ? props.selectedIds.filter((id) => id !== item.id) : [...props.selectedIds, item.id]
      : props.selectedIds.includes(item.id) ? props.selectedIds : [item.id];
    props.onGroupSelectionChange(undefined);
    props.onSelectionChange(nextSelection, shift ? props.selectedAnnotationIds : []);
    if (item.locked || !nextSelection.includes(item.id)) return;
    const nextSelectionSet = new Set(nextSelection);
    const origins = orderedItems.filter((value) => nextSelectionSet.has(value.id) && !value.locked)
      .map((value) => ({ ...value, crop: { ...value.crop } }));
    if (!origins.length) return;
    gesture.current = {
      mode: 'image', startX: world.x, startY: world.y, viewport: { ...viewportRef.current },
      imageMode: getImageDragMode(raw), imageId: item.id, origins,
      imageIds: new Set(origins.map((value) => value.id)), startScreenX: raw.screenX,
      startRotation: item.rotation, startOpacity: item.opacity,
      deltaX: 0, deltaY: 0, factor: 1, deltaDegrees: 0, opacity: item.opacity,
    };
    setPixelInteraction(true);
  };

  const onPointerDown = (event: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    const raw = 'evt' in event ? event.evt as MouseEvent : undefined;
    const point = screenPoint();
    if (!point) return;
    if (containerRef.current) {
      containerRef.current.setAttribute('data-pointer-target', event.target.id() || event.target.getClassName());
      containerRef.current.setAttribute('data-pointer-screen', `${point.x.toFixed(1)},${point.y.toFixed(1)}`);
    }
    const pickerGesture = props.colorPickerHeld || Boolean(raw && isAltColorPickerPointer(props.colorPickerShortcut, raw));
    if (pickerGesture && raw?.button === 0) {
      const world = worldPoint();
      if (!world) return;
      event.target.stopDrag();
      gesture.current = { mode: 'pick-color', startX: world.x, startY: world.y, viewport: { ...viewportRef.current } };
      void sampleColor(world, point);
      return;
    }
    if (raw?.button === 2) {
      if (props.windowLocked) return;
      event.target.stopDrag();
      transformerRef.current?.stopTransform();
      gesture.current = {
        mode: 'window', startX: raw.screenX, startY: raw.screenY,
        lastScreenX: raw.screenX, lastScreenY: raw.screenY, moved: false,
        viewport: { ...props.scene.viewport },
      };
      props.onWindowMoveStart();
      return;
    }
    const shouldPan = raw?.button === 1 || (props.colorPickerShortcut === 's' && raw?.button === 0 && raw.altKey && !raw.ctrlKey);
    if (shouldPan) {
      const bounds = raw ? containerRef.current?.getBoundingClientRect() : undefined;
      const panPoint = raw && bounds ? { x: raw.clientX - bounds.left, y: raw.clientY - bounds.top } : point;
      event.target.stopDrag();
      transformerRef.current?.stopTransform();
      beginViewportGesture();
      gesture.current = { mode: 'pan', startX: panPoint.x, startY: panPoint.y, viewport: { ...viewportRef.current } };
      return;
    }
    if (props.annotationMode && raw?.button === 0) {
      const world = worldPoint();
      if (!world) return;
      if (props.annotationTool === 'eraser') {
        gesture.current = { mode: 'erase', startX: world.x, startY: world.y, viewport: { ...viewportRef.current } };
        props.onEraseStart();
        pendingEraserPointRef.current = world;
        flushPointerVisuals();
        return;
      }
      const base = {
        id: crypto.randomUUID(),
        type: props.annotationTool,
        color: props.annotationColor,
        strokeWidth: props.annotationWidth,
      } as AnnotationItem;
      const annotation = props.annotationTool === 'pen' || props.annotationTool === 'arrow'
        ? { ...base, points: [world.x, world.y, world.x, world.y] }
        : { ...base, x: world.x, y: world.y, width: 0, height: 0 };
      gesture.current = { mode: 'annotate', startX: world.x, startY: world.y, viewport: { ...viewportRef.current } };
      draftAnnotationRef.current = annotation;
      setDraftAnnotation(annotation);
      return;
    }
    if (pixelBackend !== 'konva' && raw?.button === 0 && event.target === event.target.getStage()) {
      const world = worldPoint();
      const item = world ? imageAtWorldPoint(world) : undefined;
      if (containerRef.current) {
        containerRef.current.setAttribute('data-pointer-hit', item?.id ?? 'none');
      }
      if (world && item) {
        beginGpuImageGesture(item, raw, world);
        return;
      }
    }
    if (event.target === event.target.getStage()) {
      const world = worldPoint();
      if (!world) return;
      // Box selection must immediately release hover-only LOD prewarm tiles.
      // They are unrelated to selection and retaining them can exhaust the
      // atlas while the selection proxy is being created.
      updateQualityFocus(undefined, undefined);
      gesture.current = { mode: 'select', startX: world.x, startY: world.y, viewport: { ...viewportRef.current } };
      selectionPointerRef.current = point;
      updateSelectionBox({ x: world.x, y: world.y, width: 0, height: 0 });
      startSelectionAutoPan();
      if (!raw?.shiftKey) {
        props.onSelectionChange([], []);
        props.onGroupSelectionChange(undefined);
      }
    }
  };

  const onPointerMove = (event: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    performanceMonitor.markPointerMove();
    if (!gesture.current && event.evt instanceof MouseEvent) updateGroupHeaderHover(event as Konva.KonvaEventObject<MouseEvent>);
    if (!gesture.current && pixelBackend !== 'konva') {
      const world = worldPoint();
      const hovered = world ? imageAtWorldPoint(world) : undefined;
      updateQualityFocus(hovered, world);
      const nextCommentId = hovered?.comment ? hovered.id : undefined;
      if (nextCommentId !== hoveredCommentImageId) setCommentHover(nextCommentId, Boolean(nextCommentId));
    }
    if (!gesture.current) return;
    if (gesture.current.mode === 'pick-color') {
      const world = worldPoint();
      const screen = screenPoint();
      if (world && screen) {
        pendingPickerPointRef.current = { world, screen };
        schedulePointerVisuals();
      }
    } else if (gesture.current.mode === 'annotate') {
      const point = worldPoint();
      if (!point) return;
      const draft = draftAnnotationRef.current;
      if (!draft) return;
      draftAnnotationRef.current = draft.type === 'pen' ? { ...draft, points: [...(draft.points ?? []), point.x, point.y] }
        : draft.type === 'arrow' ? { ...draft, points: [gesture.current!.startX, gesture.current!.startY, point.x, point.y] }
        : {
          ...draft,
          x: Math.min(gesture.current!.startX, point.x),
          y: Math.min(gesture.current!.startY, point.y),
          width: Math.abs(point.x - gesture.current!.startX),
          height: Math.abs(point.y - gesture.current!.startY),
        };
      schedulePointerVisuals();
    } else if (gesture.current.mode === 'erase') {
      const point = worldPoint();
      if (!point) return;
      pendingEraserPointRef.current = point;
      schedulePointerVisuals();
    } else if (gesture.current.mode === 'image') {
      const imageGesture = gesture.current;
      const raw = event.evt as MouseEvent;
      const world = worldPoint();
      const imageIds = imageGesture.imageIds;
      const origins = imageGesture.origins;
      if (!world || !imageIds || !origins?.length) return;
      if (imageGesture.imageMode === 'scale') {
        imageGesture.factor = Math.max(0.08, Math.min(12, Math.exp((raw.screenX - (imageGesture.startScreenX ?? raw.screenX)) / 180)));
        const bounds = sceneBounds(origins);
        const preview: CompactImageGesture = {
          kind: 'scale', imageIds, centerX: bounds.x + bounds.width / 2,
          centerY: bounds.y + bounds.height / 2, factor: imageGesture.factor,
        };
        previewSelectionOverlay(preview);
        schedulePixelPreviewRender(preview);
      } else if (imageGesture.imageMode === 'rotate') {
        let delta = (raw.screenX - (imageGesture.startScreenX ?? raw.screenX)) * 0.5;
        const rotation = (imageGesture.startRotation ?? 0) + delta;
        if (raw.shiftKey) delta = Math.round(rotation / 45) * 45 - (imageGesture.startRotation ?? 0);
        imageGesture.deltaDegrees = delta;
        const primary = origins.find((value) => value.id === imageGesture.imageId) ?? origins[0];
        const preview: CompactImageGesture = {
          kind: 'rotate', imageIds: new Set([primary.id]),
          centerX: primary.x + primary.width / 2, centerY: primary.y + primary.height / 2, deltaDegrees: delta,
        };
        previewSelectionOverlay(preview);
        schedulePixelPreviewRender(preview);
      } else if (imageGesture.imageMode === 'opacity') {
        imageGesture.opacity = Math.max(0.1, Math.min(1, (imageGesture.startOpacity ?? 1)
          + (raw.screenX - (imageGesture.startScreenX ?? raw.screenX)) / 220));
        schedulePixelPreviewRender({ kind: 'opacity', imageIds: new Set([imageGesture.imageId!]), opacity: imageGesture.opacity });
      } else {
        let deltaX = world.x - imageGesture.startX;
        let deltaY = world.y - imageGesture.startY;
        if (raw.shiftKey) {
          if (Math.abs(deltaX) >= Math.abs(deltaY)) deltaY = 0;
          else deltaX = 0;
        }
        imageGesture.deltaX = deltaX; imageGesture.deltaY = deltaY;
        const preview: CompactImageGesture = { kind: 'move', imageIds, deltaX, deltaY };
        previewSelectionOverlay(preview);
        schedulePixelPreviewRender(preview);
      }
    } else if (gesture.current.mode === 'window') {
      const raw = event.evt as MouseEvent;
      if (!gesture.current.moved && exceededWindowMoveThreshold(gesture.current.startX, gesture.current.startY, raw.screenX, raw.screenY)) {
        props.onWindowMove();
        gesture.current.moved = true;
        gesture.current.lastScreenX = raw.screenX;
        gesture.current.lastScreenY = raw.screenY;
      }
    } else if (gesture.current.mode === 'pan') {
      const raw = event.evt as MouseEvent;
      const bounds = containerRef.current?.getBoundingClientRect();
      const point = bounds ? { x: raw.clientX - bounds.left, y: raw.clientY - bounds.top } : screenPoint();
      if (!point) return;
      applyLiveViewport({
        ...viewportRef.current,
        x: gesture.current.viewport.x + point.x - gesture.current.startX,
        y: gesture.current.viewport.y + point.y - gesture.current.startY,
      });
    } else {
      const raw = event.evt as MouseEvent;
      const bounds = containerRef.current?.getBoundingClientRect();
      const point = bounds ? { x: raw.clientX - bounds.left, y: raw.clientY - bounds.top } : screenPoint();
      if (!point) return;
      selectionPointerRef.current = point;
      updateSelectionAtScreenPoint(point);
    }
  };

  const onPointerUp = () => {
    if (pointerVisualFrameRef.current !== undefined) cancelAnimationFrame(pointerVisualFrameRef.current);
    flushPointerVisuals();
    const completedGestureMode = gesture.current?.mode;
    if (gesture.current?.mode === 'pick-color') {
      const color = pickerPreviewRef.current?.color;
      gesture.current = undefined;
      pickerPreviewRef.current = undefined;
      setPickerPreview(undefined);
      if (color) props.onColorPicked(color);
      return;
    }
    if (gesture.current?.mode === 'image') {
      const imageGesture = gesture.current;
      const origins = imageGesture.origins ?? [];
      if (imageGesture.imageMode === 'scale' && Math.abs((imageGesture.factor ?? 1) - 1) > 0.0001) {
        props.onItemsChanged(scaleItemsAsGroup(origins, imageGesture.factor ?? 1));
      } else if (imageGesture.imageMode === 'rotate' && Math.abs(imageGesture.deltaDegrees ?? 0) > 0.0001) {
        props.onItemsChanged([{ id: imageGesture.imageId!, rotation: (imageGesture.startRotation ?? 0) + (imageGesture.deltaDegrees ?? 0) }]);
      } else if (imageGesture.imageMode === 'opacity' && imageGesture.opacity !== undefined) {
        props.onItemsChanged([{ id: imageGesture.imageId!, opacity: imageGesture.opacity }]);
      } else if (imageGesture.imageMode === 'move'
        && (Math.abs(imageGesture.deltaX ?? 0) > 0.0001 || Math.abs(imageGesture.deltaY ?? 0) > 0.0001)) {
        props.onItemsChanged(translateItems(origins, imageGesture.deltaX ?? 0, imageGesture.deltaY ?? 0));
      }
      setPixelInteraction(false);
    }
    const finalSelectionBox = selectionBoxRef.current;
    if (gesture.current?.mode === 'select' && finalSelectionBox && finalSelectionBox.width > 3) {
      const hits = imageIndex.query(finalSelectionBox).map((id) => itemById.get(id))
        .filter((item): item is ImageItem => Boolean(item && !item.locked && !groupVisibility.hiddenImages.has(item.id)));
      const annotationHits = annotationIndex.query(finalSelectionBox)
        .filter((id) => !groupVisibility.hiddenAnnotations.has(id) && !annotationById.get(id)?.locked);
      props.onSelectionChange(hits.map((item) => item.id), annotationHits);
    }
    stopSelectionAutoPan();
    selectionPointerRef.current = undefined;
    if (gesture.current?.mode === 'window') {
      props.onWindowMoveEnd();
      if (gesture.current.moved) suppressContextMenuUntil.current = Date.now() + 350;
    }
    const finalDraftAnnotation = draftAnnotationRef.current;
    if (gesture.current?.mode === 'annotate' && finalDraftAnnotation) {
      const longEnough = finalDraftAnnotation.type === 'pen'
        ? (finalDraftAnnotation.points?.length ?? 0) >= 6
        : finalDraftAnnotation.type === 'arrow'
          ? Math.hypot((finalDraftAnnotation.points?.[2] ?? 0) - (finalDraftAnnotation.points?.[0] ?? 0), (finalDraftAnnotation.points?.[3] ?? 0) - (finalDraftAnnotation.points?.[1] ?? 0)) >= 2
          : (finalDraftAnnotation.width ?? 0) >= 2 && (finalDraftAnnotation.height ?? 0) >= 2;
      if (longEnough) props.onAddAnnotation(finalDraftAnnotation);
    }
    if (gesture.current?.mode === 'erase') props.onEraseEnd();
    gesture.current = undefined;
    if (completedGestureMode === 'pan' || completedGestureMode === 'select') commitViewportGesture();
    updateSelectionBox(undefined);
    setDraftAnnotation(undefined);
    draftAnnotationRef.current = undefined;
    setEraserPoint(undefined);
  };
  finishSelectionRef.current = onPointerUp;

  useEffect(() => {
    const finishGesture = () => { if (gesture.current) finishSelectionRef.current(); };
    window.addEventListener('mouseup', finishGesture);
    window.addEventListener('pointercancel', finishGesture);
    window.addEventListener('blur', finishGesture);
    return () => {
      window.removeEventListener('mouseup', finishGesture);
      window.removeEventListener('pointercancel', finishGesture);
      window.removeEventListener('blur', finishGesture);
      stopSelectionAutoPan();
      setPixelUploadPause(false);
    };
  }, [setPixelUploadPause]);

  const finishManualWheelSession = () => {
    const session = manualWheelSessionRef.current;
    manualWheelSessionRef.current = undefined;
    manualWheelTimerRef.current = undefined;
    if (!session) return;
    if (session.frameId !== undefined) cancelAnimationFrame(session.frameId);
    const stats = getPixelStats();
    const handlerTimes = session.events.map((value) => value.handlerMs);
    const gaps = session.events.slice(1).map((value) => value.gapMs);
    void window.refCanvas?.recordManualWheelSession({
      recordedAt: new Date().toISOString(), durationMs: performance.now() - session.startedAt,
      eventCount: session.events.length, events: session.events,
      wheelGapP50Ms: percentile(gaps, 0.5), wheelGapP95Ms: percentile(gaps, 0.95), wheelGapMaxMs: Math.max(0, ...gaps),
      handlerP95Ms: percentile(handlerTimes, 0.95), handlerMaxMs: Math.max(0, ...handlerTimes),
      frameP95Ms: percentile(session.frameIntervals, 0.95), frameP99Ms: percentile(session.frameIntervals, 0.99),
      onePercentLow: 1000 / Math.max(0.001, percentile(session.frameIntervals, 0.99)),
      reactRenders: reactRenderCountRef.current - session.startReactRenders,
      textureUploads: stats.textureUploads - session.startUploads,
      startViewport: session.startViewport, endViewport: { ...viewportRef.current },
      renderer: { backend: pixelBackend, drawCalls: stats.drawCalls, gpuBytes: stats.gpuBytes, cpuBytes: stats.cpuBytes,
        loadedCommands: loadedCommandCount, renderCommands: pixelCommands.length, lodCoverage: stats.minimumLodCoverage,
        longTasks: stats.longTasks },
    });
    rendererInfo('wheel.session', {
      durationMs: performance.now() - session.startedAt, eventCount: session.events.length,
      wheelGapP95Ms: percentile(gaps, 0.95), handlerP95Ms: percentile(handlerTimes, 0.95),
      frameP95Ms: percentile(session.frameIntervals, 0.95), frameP99Ms: percentile(session.frameIntervals, 0.99),
      reactRenders: reactRenderCountRef.current - session.startReactRenders,
      textureUploads: stats.textureUploads - session.startUploads, lodCoverage: stats.minimumLodCoverage,
    });
  };

  const onWheel = (event: Konva.KonvaEventObject<WheelEvent>) => {
    const handlerStartedAt = performance.now();
    let manualSession = manualWheelSessionRef.current;
    if (manualInputRecording && !manualSession) {
      const startedAt = performance.now();
      const newSession: NonNullable<typeof manualWheelSessionRef.current> = {
        startedAt, lastEventAt: startedAt, startViewport: { ...viewportRef.current },
        startReactRenders: reactRenderCountRef.current, startUploads: getPixelStats().textureUploads,
        events: [], frameIntervals: [],
      };
      manualSession = newSession;
      manualWheelSessionRef.current = newSession;
      const collectFrame = (now: number) => {
        if (manualWheelSessionRef.current !== newSession) return;
        if (newSession.lastFrameAt !== undefined) newSession.frameIntervals.push(now - newSession.lastFrameAt);
        newSession.lastFrameAt = now;
        newSession.frameId = requestAnimationFrame(collectFrame);
      };
      newSession.frameId = requestAnimationFrame(collectFrame);
    }
    event.evt.preventDefault();
    const bounds = containerRef.current?.getBoundingClientRect();
    const pointer = bounds
      ? { x: event.evt.clientX - bounds.left, y: event.evt.clientY - bounds.top }
      : screenPoint();
    if (!pointer) return;
    const next = zoomViewportAtPoint(viewportRef.current, pointer, event.evt.deltaY);
    const pointerWorld = {
      x: (pointer.x - viewportRef.current.x) / viewportRef.current.scale,
      y: (pointer.y - viewportRef.current.y) / viewportRef.current.scale,
    };
    updateQualityFocus(imageAtWorldPoint(pointerWorld), pointerWorld);
    beginViewportGesture();
    applyLiveViewport(next);
    commitViewportGestureSoon();
    if (manualSession) {
      const now = performance.now();
      manualSession.events.push({
        atMs: now - manualSession.startedAt, gapMs: now - manualSession.lastEventAt,
        deltaY: event.evt.deltaY, deltaMode: event.evt.deltaMode, handlerMs: now - handlerStartedAt,
      });
      manualSession.lastEventAt = now;
      if (manualWheelTimerRef.current !== undefined) window.clearTimeout(manualWheelTimerRef.current);
      manualWheelTimerRef.current = window.setTimeout(finishManualWheelSession, 1200);
    }
  };

  const onDoubleClick = (event: Konva.KonvaEventObject<MouseEvent>) => {
    if (pixelBackend === 'konva' || event.target !== event.target.getStage()) return;
    const world = worldPoint();
    const item = world ? imageAtWorldPoint(world) : undefined;
    if (item) props.onFocusItem(item);
  };

  const previewGroupTransform = () => {
    const activeNode = transformerRef.current?.nodes()[0];
    if (activeNode?.id() === 'gpu-selection-proxy' && selectionProxyBounds) {
      schedulePixelPreviewRender({
        kind: 'bounds', imageIds: new Set(selectedMovableItems.map((item) => item.id)),
        sourceX: selectionProxyBounds.x, sourceY: selectionProxyBounds.y,
        targetX: activeNode.x(), targetY: activeNode.y(),
        scaleX: Math.abs(activeNode.scaleX()), scaleY: Math.abs(activeNode.scaleY()),
      });
      return;
    }
    const groupNode = transformerRef.current?.nodes().find((node) => node.id().startsWith('group-frame-'));
    if (!groupNode) { syncSelectionControlsFromNodes(); return; }
    const id = groupNode.id().slice('group-frame-'.length);
    const group = props.scene.groups.find((value) => value.id === id);
    if (!group) return;
    const width = Math.max(100, Math.abs(group.width * groupNode.scaleX()));
    const height = Math.max(GROUP_TITLE_HEIGHT, Math.abs(group.height * groupNode.scaleY()));
    const background = props.stageRef.current?.findOne(`#group-bg-${id}`);
    background?.position({ x: groupNode.x(), y: groupNode.y() });
    background?.size({ width, height });
    props.stageRef.current?.findOne(`#group-name-${id}`)?.position({
      x: groupNode.x(),
      y: groupNode.y() - 25 / props.scene.viewport.scale,
    });
    background?.getLayer()?.batchDraw();
    previewGroupBackground(id, { x: groupNode.x(), y: groupNode.y(), width, height });
    props.onGroupPreview(id, groupNode.x(), groupNode.y());
    schedulePixelPreviewRender();
  };

  const transformEnd = () => {
    const activeNode = transformerRef.current?.nodes()[0];
    if (activeNode?.id() === 'gpu-selection-proxy' && selectionProxyBounds) {
      const scaleX = Math.abs(activeNode.scaleX());
      const scaleY = Math.abs(activeNode.scaleY());
      const targetX = activeNode.x(); const targetY = activeNode.y();
      const changes = selectedMovableItems.map((item) => {
        const centerX = item.x + item.width / 2;
        const centerY = item.y + item.height / 2;
        const width = Math.max(24, item.width * scaleX);
        const height = Math.max(24, item.height * scaleY);
        return {
          id: item.id,
          x: targetX + (centerX - selectionProxyBounds.x) * scaleX - width / 2,
          y: targetY + (centerY - selectionProxyBounds.y) * scaleY - height / 2,
          width,
          height,
        };
      });
      activeNode.position({ x: selectionProxyBounds.x, y: selectionProxyBounds.y });
      activeNode.scale({ x: 1, y: 1 });
      if (changes.length) props.onItemsChanged(changes);
      return;
    }
    const groupNode = transformerRef.current?.nodes().find((node) => node.id().startsWith('group-frame-'));
    if (groupNode) {
      const id = groupNode.id().slice('group-frame-'.length);
      const group = props.scene.groups.find((value) => value.id === id);
      if (group) {
        const width = Math.max(100, Math.abs(group.width * groupNode.scaleX()));
        const height = Math.max(GROUP_TITLE_HEIGHT, Math.abs(group.height * groupNode.scaleY()));
        const background = props.stageRef.current?.findOne(`#group-bg-${id}`);
        background?.position({ x: group.x, y: group.y });
        background?.size({ width: group.width, height: group.height });
        props.stageRef.current?.findOne(`#group-name-${id}`)?.position({
          x: group.x,
          y: compactGroupHeaderY(group, props.scene.viewport.scale),
        });
        groupNode.scale({ x: 1, y: 1 });
        previewGroupBackground(id, { x: groupNode.x(), y: groupNode.y(), width, height });
        props.onGroupChanged(id, { x: groupNode.x(), y: groupNode.y(), width, height });
      }
      return;
    }
    const changes = transformerRef.current?.nodes().flatMap((node) => {
      const item = props.scene.items.find((value) => value.id === node.id());
      if (!item) return [];
      const width = Math.max(24, Math.abs(item.width * node.scaleX()));
      const height = Math.max(24, Math.abs(item.height * node.scaleY()));
      node.scaleX(item.flipX ? -1 : 1);
      node.scaleY(item.flipY ? -1 : 1);
      node.width(width);
      node.height(height);
      node.offsetX(width / 2);
      node.offsetY(height / 2);
      return [{ id: item.id, x: node.x() - width / 2, y: node.y() - height / 2, width, height, rotation: node.rotation() }];
    }) ?? [];
    if (changes.length) props.onItemsChanged(changes);
  };

  const styleTransformerAnchor = (anchor: Konva.Rect) => {
    const hitSize = 4 / Math.max(1, props.scene.viewport.scale);
    const anchorName = anchor.name().split(' ')[0];
    anchor.hitStrokeWidth(hitSize);
    anchor.hitFunc((context, shape) => {
      const centerX = anchor.offsetX();
      const centerY = anchor.offsetY();
      const frameWidth = transformerRef.current?.width() ?? hitSize;
      const frameHeight = transformerRef.current?.height() ?? hitSize;
      let width = hitSize; let height = hitSize;
      if (anchorName === 'top-center' || anchorName === 'bottom-center') width = Math.max(hitSize, frameWidth - hitSize * 2);
      if (anchorName === 'middle-left' || anchorName === 'middle-right') height = Math.max(hitSize, frameHeight - hitSize * 2);
      context.beginPath();
      context.rect(centerX - width / 2, centerY - height / 2, width, height);
      context.fillStrokeShape(shape);
    });
  };

  const rotationItems = props.selectedGroupId ? [] : orderedItems.filter((item) =>
    selectedIdSet.has(item.id) && !item.locked && !groupVisibility.hiddenImages.has(item.id));
  const rotationBounds = rotationItems.length ? sceneBounds(rotationItems) : undefined;
  const rotationCenter = rotationBounds ? {
    x: rotationBounds.x + rotationBounds.width / 2,
    y: rotationBounds.y + rotationBounds.height / 2,
  } : undefined;
  const rotationCorners = rotationItems.length ? selectionRotationCorners(rotationItems) : [];
  const rotationHandles = rotationCenter
    ? offsetRotationCorners(rotationCorners, rotationCenter, props.scene.viewport.scale) : [];
  const syncSelectionControlsFromNodes = () => {
    const stage = props.stageRef.current;
    if (!stage || !rotationItems.length) return;
    const previewItems = rotationItems.map((item) => {
      const node = stage.findOne(`#${item.id}`);
      if (!node) return item;
      const width = item.width * Math.abs(node.scaleX()); const height = item.height * Math.abs(node.scaleY());
      return { ...item, x: node.x() - width / 2, y: node.y() - height / 2, width, height, rotation: node.rotation() };
    });
    const bounds = sceneBounds(previewItems);
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    offsetRotationCorners(selectionRotationCorners(previewItems), center, props.scene.viewport.scale).forEach((corner) => {
      stage.findOne(`#rotation-corner-${corner.key}`)?.position({ x: corner.x, y: corner.y });
    });
    transformerRef.current?.forceUpdate();
    transformerRef.current?.getLayer()?.batchDraw();
  };
  const restoreRotationPreview = (origins: ImageItem[]) => {
    const stage = props.stageRef.current;
    origins.forEach((origin) => {
      stage?.findOne(`#${origin.id}`)?.position({ x: origin.x + origin.width / 2, y: origin.y + origin.height / 2 });
      stage?.findOne(`#${origin.id}`)?.rotation(origin.rotation);
      stage?.findOne(`#comment-${origin.id}`)?.position(imageCommentPosition(origin, props.scene.viewport.scale));
    });
  };
  const beginCornerRotation = () => {
    const pointer = props.stageRef.current?.getPointerPosition();
    if (!pointer || !rotationCenter || !rotationItems.length) return;
    const worldX = (pointer.x - props.scene.viewport.x) / props.scene.viewport.scale;
    const worldY = (pointer.y - props.scene.viewport.y) / props.scene.viewport.scale;
    cornerRotationRef.current = {
      origins: rotationItems.map((item) => structuredClone(item)),
      startAngle: Math.atan2(worldY - rotationCenter.y, worldX - rotationCenter.x) * 180 / Math.PI,
      changes: [],
    };
  };
  const previewCornerRotation = (event: Konva.KonvaEventObject<DragEvent>) => {
    const gesture = cornerRotationRef.current;
    const pointer = props.stageRef.current?.getPointerPosition();
    if (!gesture || !pointer || !rotationCenter) return;
    const worldX = (pointer.x - props.scene.viewport.x) / props.scene.viewport.scale;
    const worldY = (pointer.y - props.scene.viewport.y) / props.scene.viewport.scale;
    let delta = Math.atan2(worldY - rotationCenter.y, worldX - rotationCenter.x) * 180 / Math.PI - gesture.startAngle;
    delta = ((delta + 540) % 360) - 180;
    if ((event.evt as MouseEvent).shiftKey) delta = Math.round(delta / 15) * 15;
    const changes = rotateItemsAsGroup(gesture.origins, delta);
    gesture.changes = changes;
    const stage = props.stageRef.current;
    if (pixelBackend === 'konva') changes.forEach((change) => {
      const origin = gesture.origins.find((item) => item.id === change.id);
      const node = stage?.findOne(`#${change.id}`);
      if (!origin || !node || change.x === undefined || change.y === undefined) return;
      node.position({ x: change.x + origin.width / 2, y: change.y + origin.height / 2 });
      node.rotation(change.rotation ?? origin.rotation);
      stage?.findOne(`#comment-${change.id}`)?.position(imageCommentPosition({
        ...origin, x: change.x, y: change.y, rotation: change.rotation ?? origin.rotation,
      }, props.scene.viewport.scale));
    });
    const previewItems = gesture.origins.map((origin) => ({
      ...origin,
      ...changes.find((change) => change.id === origin.id),
    }));
    const previewBounds = sceneBounds(previewItems);
    const previewCenter = { x: previewBounds.x + previewBounds.width / 2, y: previewBounds.y + previewBounds.height / 2 };
    offsetRotationCorners(selectionRotationCorners(previewItems), previewCenter, props.scene.viewport.scale).forEach((corner) => {
      const node = stage?.findOne(`#rotation-corner-${corner.key}`);
      if (node && node !== event.currentTarget) node.position({ x: corner.x, y: corner.y });
    });
    if (pixelBackend === 'konva') {
      transformerRef.current?.forceUpdate();
      stage?.batchDraw();
      schedulePixelPreviewRender();
    } else schedulePixelPreviewRender({
      kind: 'rotate', imageIds: new Set(gesture.origins.map((item) => item.id)),
      centerX: rotationCenter.x, centerY: rotationCenter.y, deltaDegrees: delta,
    });
  };
  const finishCornerRotation = () => {
    const gesture = cornerRotationRef.current;
    if (!gesture) return;
    if (pixelBackend === 'konva') {
      restoreRotationPreview(gesture.origins);
      props.stageRef.current?.batchDraw();
    }
    cornerRotationRef.current = undefined;
    if (gesture.changes.length) props.onItemsChanged(gesture.changes);
  };
  const transformerColor = props.selectedGroupId ? '#9aa6af' : '#8fe7ff';
  const renderStats = getPixelStats();
  const cpuCacheStats = getImageResourceCacheStats();
  performanceMonitor.setSceneCounts(renderedItems.length, props.scene.items.length, pixelBackend);
  performanceMonitor.setImageRuntimeStats({
    cpuImageBytes: cpuCacheStats.bytes,
    preloadImages: preloadTileImageIds.size,
    decodeQueueLength: cpuCacheStats.decodeQueueLength,
    uploadQueueLength: renderStats.uploadQueueLength ?? 0,
    frameUploadBytes: renderStats.frameUploadBytes ?? 0,
    currentMip: [...tileLevelsRef.current.values()].sort((left, right) => left - right).join(',') || 'fixed',
    cacheHitRate: cpuCacheStats.hitRate,
  });
  const stressHitItem = renderedItems.find((item) => {
    if (item.locked || groupVisibility.hiddenImages.has(item.id)) return false;
    const centerX = props.scene.viewport.x + (item.x + item.width / 2) * props.scene.viewport.scale;
    const centerY = props.scene.viewport.y + (item.y + item.height / 2) * props.scene.viewport.scale;
    const marginX = Math.min(200, size.width / 4);
    const marginY = Math.min(100, size.height / 4);
    return centerX >= marginX && centerX < size.width - marginX
      && centerY >= marginY && centerY < size.height - marginY;
  });
  const stressHitX = stressHitItem ? props.scene.viewport.x + (stressHitItem.x + stressHitItem.width / 2) * props.scene.viewport.scale : 0;
  const stressHitY = stressHitItem ? props.scene.viewport.y + (stressHitItem.y + stressHitItem.height / 2) * props.scene.viewport.scale : 0;

  return <div ref={containerRef} data-render-backend={pixelBackend} data-rendered-images={renderedItems.length}
    data-render-commands={pixelCommands.length} data-tiled-images={pixelPlan.tiledImageIds.size}
    data-loaded-commands={loadedCommandCount}
    data-loaded-tile-commands={loadedTileCommandCount}
    data-draw-calls={renderStats.drawCalls} data-render-instances={renderStats.instances}
    data-bind-texture-calls={renderStats.bindTextureCalls} data-buffer-data-calls={renderStats.bufferDataCalls}
    data-buffer-sub-data-calls={renderStats.bufferSubDataCalls} data-tex-image-2d-calls={renderStats.texImage2DCalls}
    data-tex-sub-image-2d-calls={renderStats.texSubImage2DCalls} data-texture-upload-ms={renderStats.textureUploadMs.toFixed(2)}
    data-gpu-textures={renderStats.textureCount}
    data-gpu-bytes={renderStats.gpuBytes} data-cpu-image-bytes={renderStats.cpuBytes}
    data-rendered-viewport-x={renderStats.renderedViewportX}
    data-rendered-viewport-y={renderStats.renderedViewportY}
    data-rendered-viewport-scale={renderStats.renderedViewportScale}
    data-frame-p95-ms={renderStats.frameP95Ms.toFixed(2)} data-frame-p99-ms={renderStats.frameP99Ms.toFixed(2)}
    data-lod-coverage={renderStats.minimumLodCoverage.toFixed(3)}
    data-lod-command={renderStats.minimumLodCommandId} data-lod-resident-size={renderStats.minimumLodResidentSize}
    data-lod-plan={renderStats.minimumLodPlan}
    data-lod-residency={renderStats.minimumLodResidency}
    data-lod-loaded={renderStats.minimumLodLoaded}
    data-interaction-uploads={renderStats.uploadsDuringGesture} data-long-tasks={renderStats.longTasks}
    data-prewarm-commands={renderStats.prewarmCommandCount}
    data-prewarm-resident={renderStats.prewarmResidentCount}
    data-pending-resources={renderStats.pendingResourceCount} data-blocked-resources={renderStats.blockedResourceCount}
    data-resource-retries={renderStats.resourceRetryCount}
    data-atlas-free-area={renderStats.atlasFreeArea ?? 0} data-atlas-used-area={renderStats.atlasUsedArea ?? 0}
    data-atlas-largest-free-rect={renderStats.atlasLargestFreeRectArea ?? 0}
    data-texture-command-count={renderStats.textureCommandCount ?? 0}
    data-active-texture-count={renderStats.activeTextureCount ?? 0}
    data-gesture-uniform-updates={renderStats.gestureUniformUpdates}
    data-full-instance-uploads={renderStats.fullInstanceUploads}
    data-selected-images={props.selectedIds.length}
    data-stress-hit-x={stressHitX.toFixed(2)} data-stress-hit-y={stressHitY.toFixed(2)}
    data-pixel-interaction={pixelInteractionActive ? 'active' : 'idle'}
    data-viewport-x={Math.round(props.scene.viewport.x)} data-viewport-y={Math.round(props.scene.viewport.y)}
    data-viewport-scale={props.scene.viewport.scale}
    data-total-images={props.scene.items.length} data-konva-layers={6} data-konva-node-mode={pixelBackend === 'konva' ? 'legacy-images' : 'gpu-scene'}
    className={`canvas-host ${props.annotationMode ? `annotation-mode annotation-${props.annotationTool}` : ''} ${props.colorPickerHeld ? 'color-picker-mode' : ''}`} style={{ background: props.scene.canvas.background }}>
    <canvas ref={groupBackgroundCanvasRef} className="group-background-plane" aria-hidden="true" />
    <canvas ref={pixelCanvasRef} className="pixel-render-plane" aria-hidden="true" />
    {pixelBackend !== 'konva' && pixelCommands.map((command) => {
      const previewItem = command.id === `${command.imageId}:preview` ? itemById.get(command.imageId ?? '') : undefined;
      if (command.resourceUrl && command.imageId) {
        const isTile = command.resourceUrl.includes('variant=tile');
        const imageItem = !isTile ? itemById.get(command.imageId) : undefined;
        if (imageItem) {
          const resourceVariant = new URL(command.resourceUrl).searchParams.get('variant');
          if (resourceVariant === 'thumb128' || resourceVariant === 'thumb256' || resourceVariant === 'thumb512' || resourceVariant === 'thumb768'
            || resourceVariant === 'thumb1024' || resourceVariant === 'original') {
            return <PixelImageLoader key={command.id} commandId={command.id} item={imageItem}
              viewportScale={qualityViewport.scale} maximumVariant="original" exactVariant={resourceVariant}
              enabled={resourceVariant === 'thumb128' || previewResourcesReady}
              onReady={setPixelImage} />;
          }
        }
        return <Fragment key={command.id}>
          <PixelUrlLoader commandId={command.id} itemId={command.imageId} src={command.resourceUrl}
            priority={10} enabled={!isTile || previewResourcesReady}
            onReady={setPixelImage} onError={isTile ? markTileFailed : ignoreResourceError} />
        </Fragment>;
      }
      if (previewItem) return <PixelImageLoader key={command.id} commandId={command.id} item={previewItem}
            viewportScale={qualityViewport.scale} maximumVariant="thumb1024" onReady={setPixelImage} />;
      const item = itemById.get(command.id);
      return item ? <PixelImageLoader key={item.id} item={item} viewportScale={qualityViewport.scale}
        maximumVariant="original" onReady={setPixelImage} /> : null;
    })}
    {pixelBackend !== 'konva' && pixelPlan.prefetch.map((resource) => <PixelUrlLoader
      key={`prefetch:${resource.commandId}`} commandId={resource.commandId} itemId={resource.itemId}
      src={resource.url} prefetch delayMs={250} priority={0} enabled={previewResourcesReady}
      onReady={setPixelImage} onError={markTileFailed} />)}
    {pixelBackend !== 'konva' && pixelPlan.gpuPrewarm.map((resource) => <PixelUrlLoader
      key={`gpu-prewarm:${resource.commandId}`} commandId={resource.commandId} itemId={resource.itemId}
      src={resource.url} priority={2} enabled={previewResourcesReady}
      onReady={setPixelImage} onError={markTileFailed} />)}
    <Stage
      ref={props.stageRef}
      width={size.width}
      height={size.height}
      x={props.scene.viewport.x}
      y={props.scene.viewport.y}
      scaleX={props.scene.viewport.scale}
      scaleY={props.scene.viewport.scale}
      onMouseDown={onPointerDown}
      onTouchStart={onPointerDown}
      onMouseMove={onPointerMove}
      onTouchMove={onPointerMove}
      onMouseLeave={hideGroupHeaderSoon}
      onMouseUp={onPointerUp}
      onTouchEnd={onPointerUp}
      onWheel={onWheel}
      onDblClick={onDoubleClick}
      onContextMenu={(event) => {
        event.evt.preventDefault();
        if (Date.now() < suppressContextMenuUntil.current) return;
        props.onContextMenu({ x: event.evt.clientX, y: event.evt.clientY });
      }}
    >
      <Layer listening={false}>
        {pixelBackend === 'konva' && visibleRenderedGroups.map((group) => <GroupBackground key={group.id} group={group} scale={props.scene.viewport.scale} />)}
      </Layer>
      <Layer listening={!props.colorPickerHeld}>
        {pixelBackend === 'konva' && renderedItems.filter((item) => !groupVisibility.hiddenImages.has(item.id)).map((item) => <BoardImage
          key={item.id}
          item={item}
          companions={props.selectedIds.includes(item.id)
            ? selectedMovableItems.filter((value) => value.id !== item.id)
            : []}
          selected={props.selectedIds.includes(item.id)}
          viewportScale={props.scene.viewport.scale}
          interactionDisabled={props.annotationMode || props.colorPickerHeld}
          pixelRendered={pixelBackend !== 'konva'}
          onPixelInteractionChange={setPixelInteraction}
          onSelect={(event) => {
            const shift = 'shiftKey' in event.evt && event.evt.shiftKey;
            props.onGroupSelectionChange(undefined);
            props.onSelectionChange(shift
              ? props.selectedIds.includes(item.id) ? props.selectedIds.filter((id) => id !== item.id) : [...props.selectedIds, item.id]
              : [item.id], shift ? props.selectedAnnotationIds : []);
          }}
          onChange={props.onItemsChanged}
          onPreview={(preview) => {
            if (pixelBackend === 'konva') syncSelectionControlsFromNodes();
            schedulePixelPreviewRender(preview);
          }}
          onHoverChange={(hovered) => setCommentHover(item.id, hovered)}
          onFocus={() => props.onFocusItem(item)}
        />)}
      </Layer>
      <Layer listening={!props.colorPickerHeld}>
        {renderedItems.filter((item) => !groupVisibility.hiddenImages.has(item.id) && item.comment
          && (hoveredCommentImageId === item.id || expandedCommentId === item.id)).map((item) =>
          <ImageCommentBubble key={`comment-${item.id}`} item={item} scale={props.scene.viewport.scale}
            expanded={expandedCommentId === item.id}
            onHoverChange={(hovered) => setCommentHover(item.id, hovered)}
            onToggle={() => setExpandedCommentId((value) => value === item.id ? undefined : item.id)} />)}
      </Layer>
      <Layer listening={!props.colorPickerHeld}>
        {props.scene.annotations.filter((annotation) => renderedAnnotationIds.has(annotation.id) && !groupVisibility.hiddenAnnotations.has(annotation.id)).map((annotation) => <AnnotationShape
          key={annotation.id} annotation={annotation}
          selected={props.selectedAnnotationIds.includes(annotation.id)}
          draggable={!annotation.locked && !props.annotationMode && !props.colorPickerHeld}
          onSelect={(event) => {
            if (props.annotationMode) return;
            const shift = 'shiftKey' in event.evt && event.evt.shiftKey;
            props.onGroupSelectionChange(undefined);
            props.onSelectionChange(shift ? props.selectedIds : [], shift
              ? props.selectedAnnotationIds.includes(annotation.id)
                ? props.selectedAnnotationIds.filter((id) => id !== annotation.id)
                : [...props.selectedAnnotationIds, annotation.id]
              : [annotation.id]);
          }}
          onMove={(deltaX, deltaY) => props.onAnnotationsChanged([{ id: annotation.id, deltaX, deltaY }])}
        />)}
        {draftAnnotation && <AnnotationShape annotation={draftAnnotation} draft />}
      </Layer>
      <Layer listening={!props.colorPickerHeld}>
        {visibleRenderedGroups.map((group) => <GroupFrame
          key={group.id}
          group={group}
          selected={props.selectedGroupId === group.id}
          headerVisible={hoveredGroupId === group.id}
          scale={props.scene.viewport.scale}
          memberNodeIds={groupMemberNodeIds(group.id)}
          onBackgroundPreview={(patch, moveDescendants) => previewGroupBackground(group.id, patch, moveDescendants)}
          onSelect={() => { props.onSelectionChange([], []); props.onGroupSelectionChange(group.id); }}
          onMove={(deltaX, deltaY) => props.onGroupMoved(group.id, deltaX, deltaY)}
          onPreview={(x, y) => {
            transformerRef.current?.forceUpdate();
            transformerRef.current?.getLayer()?.batchDraw();
            props.onGroupPreview(group.id, x, y);
            schedulePixelPreviewRender();
          }}
          onPixelInteractionChange={setPixelInteraction}
          onChange={(patch) => props.onGroupChanged(group.id, patch)}
          onDelete={() => props.onGroupDeleted(group.id)}
          onRename={() => props.onRenameGroup(group.id)}
        />)}
        {visibleRenderedGroups.map((group) => <GroupCompactHeader
          key={`name-${group.id}`} group={group} scale={props.scene.viewport.scale}
          headerVisible={hoveredGroupId === group.id}
          memberNodeIds={groupMemberNodeIds(group.id)}
          onBackgroundPreview={(patch, moveDescendants) => previewGroupBackground(group.id, patch, moveDescendants)}
          onSelect={() => { props.onSelectionChange([], []); props.onGroupSelectionChange(group.id); }}
          onChange={(patch) => props.onGroupChanged(group.id, patch)}
          onDelete={() => props.onGroupDeleted(group.id)}
          onRename={() => props.onRenameGroup(group.id)}
          onMove={(deltaX, deltaY) => props.onGroupMoved(group.id, deltaX, deltaY)}
          onPreview={(x, y) => {
            props.onGroupPreview(group.id, x, y);
            schedulePixelPreviewRender();
          }}
          onPixelInteractionChange={setPixelInteraction}
          onGroupHeaderDragChange={props.onGroupHeaderDragChange} />)}
      </Layer>
      <Layer listening={!props.colorPickerHeld}>
        <Rect ref={selectionRectRef} visible={false} listening={false}
          fill="rgba(100,216,255,.12)" stroke="#64d8ff" strokeWidth={1 / props.scene.viewport.scale} />
        {eraserPoint && <Circle x={eraserPoint.x} y={eraserPoint.y} radius={12 / props.scene.viewport.scale}
          fill="rgba(255,255,255,.10)" stroke="#ffffff" strokeWidth={1 / props.scene.viewport.scale} listening={false} />}
        {pixelBackend !== 'konva' && selectionProxyBounds && <Rect
          ref={gpuSelectionProxyRef}
          id="gpu-selection-proxy"
          x={selectionProxyBounds.x} y={selectionProxyBounds.y}
          width={selectionProxyBounds.width} height={selectionProxyBounds.height}
          fill="#ffffff" opacity={0.001} listening={false}
        />}
        <Transformer
          ref={transformerRef}
          visible={!pixelInteractionActive || gesture.current?.mode === 'image'}
          rotateEnabled={false}
          keepRatio={!props.selectedGroupId}
          enabledAnchors={props.selectedGroupId
            ? ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right']
            : ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right']}
          anchorFill={props.selectedGroupId ? '#e1e5e8' : '#effcff'}
          anchorStroke={transformerColor}
          borderStroke={transformerColor}
          padding={1 / Math.max(1, props.scene.viewport.scale)}
          anchorSize={3 / Math.max(1, props.scene.viewport.scale)}
          anchorCornerRadius={0.75 / Math.max(1, props.scene.viewport.scale)}
          anchorStyleFunc={styleTransformerAnchor}
          borderStrokeWidth={0.5 / Math.max(1, props.scene.viewport.scale)}
          boundBoxFunc={(oldBox, newBox) => {
            const minWidth = props.selectedGroupId ? 100 : 24;
            const minHeight = props.selectedGroupId ? GROUP_TITLE_HEIGHT : 24;
            return newBox.width < minWidth || newBox.height < minHeight ? oldBox : newBox;
          }}
          onTransform={previewGroupTransform}
          onTransformStart={() => { if (pixelBackend !== 'konva') setPixelInteraction(true); }}
          onTransformEnd={() => {
            transformEnd();
            setPixelInteraction(false);
          }}
        />
        {!props.annotationMode && rotationHandles.map((corner) => <KonvaGroup key={corner.key} id={`rotation-corner-${corner.key}`} x={corner.x} y={corner.y}
          draggable
          onMouseEnter={(event) => { const stage = event.target.getStage(); if (stage) stage.container().style.cursor = 'crosshair'; }}
          onMouseLeave={(event) => { const stage = event.target.getStage(); if (stage) stage.container().style.cursor = 'default'; }}
          onDragStart={() => {
            if (pixelBackend !== 'konva') setPixelInteraction(true);
            beginCornerRotation();
          }}
          onDragMove={previewCornerRotation}
          onDragEnd={(event) => {
            rotationHandles.forEach((value) => props.stageRef.current?.findOne(`#rotation-corner-${value.key}`)?.position({ x: value.x, y: value.y }));
            event.currentTarget.position({ x: corner.x, y: corner.y }); finishCornerRotation();
            setPixelInteraction(false);
          }}>
          <Circle radius={2.5 / props.scene.viewport.scale} fill="rgba(22,27,33,.92)" stroke="#64d8ff"
            strokeWidth={0.65 / props.scene.viewport.scale}
            hitStrokeWidth={4 / props.scene.viewport.scale} />
          <Line points={[-1.6, 0.3, -1.2, -1.2, 0, -1.8, 1.3, -1.2]}
            scaleX={1 / props.scene.viewport.scale} scaleY={1 / props.scene.viewport.scale}
            stroke="#64d8ff" strokeWidth={0.65} lineCap="round" lineJoin="round" listening={false} />
        </KonvaGroup>)}
      </Layer>
    </Stage>
    {pickerPreview && <div className="color-picker-hud" style={{
      left: Math.max(10, Math.min(size.width - 206, pickerPreview.x + 18)),
      top: Math.max(10, Math.min(size.height - 82, pickerPreview.y + 18)),
    }}>
      <span className="color-picker-swatch" style={pickerPreview.color ? { background: pickerPreview.color.hex } : undefined} />
      <span className="color-picker-values">
        {pickerPreview.color
          ? <><strong>{pickerPreview.color.hex}</strong><small>RGB {pickerPreview.color.r} · {pickerPreview.color.g} · {pickerPreview.color.b}</small></>
          : <><strong>{pickerPreview.reason}</strong><small>{pickerPreview.itemName ?? `按住 ${props.colorPickerShortcut === 's' ? 'S' : 'Alt'} 并拖动`}</small></>}
      </span>
    </div>}
  </div>;
}
