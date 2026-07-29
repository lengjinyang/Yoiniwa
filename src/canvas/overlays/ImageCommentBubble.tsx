import { memo } from 'react';
import { Circle, Group as KonvaGroup, Line, Rect, Text } from 'react-konva';
import type { ImageItem } from '../../types';

export function imageCommentPosition(item: Pick<ImageItem, 'x' | 'y' | 'width' | 'height' | 'rotation'>, scale: number) {
  const radians = item.rotation * Math.PI / 180;
  const outside = 13 / scale;
  const localX = item.width / 2 + outside;
  const localY = -item.height / 2;
  const centerX = item.x + item.width / 2;
  const centerY = item.y + item.height / 2;
  return {
    x: centerX + localX * Math.cos(radians) - localY * Math.sin(radians),
    y: centerY + localX * Math.sin(radians) + localY * Math.cos(radians),
  };
}

export const ImageCommentBubble = memo(function ImageCommentBubble({ item, scale, expanded, onToggle, onHoverChange }: {
  item: ImageItem;
  scale: number;
  expanded: boolean;
  onToggle(): void;
  onHoverChange(hovered: boolean): void;
}) {
  if (!item.comment) return null;
  const position = imageCommentPosition(item, scale);
  return <KonvaGroup id={`comment-${item.id}`} x={position.x} y={position.y}
    scaleX={1 / scale} scaleY={1 / scale}
    onMouseDown={(event) => { event.cancelBubble = true; }}
    onTouchStart={(event) => { event.cancelBubble = true; }}
    onMouseEnter={() => onHoverChange(true)}
    onMouseLeave={() => onHoverChange(false)}
    onClick={(event) => { event.cancelBubble = true; onToggle(); }}
    onTap={(event) => { event.cancelBubble = true; onToggle(); }}>
    <KonvaGroup>
      <Circle x={10} y={10} radius={9} fill="rgba(30,34,41,.96)" stroke="rgba(255,255,255,.22)" strokeWidth={0.6}
        shadowColor="#000" shadowBlur={9} shadowOpacity={0.32} />
      <Line points={[5, 15, 4, 20, 9, 17]} closed fill="rgba(30,34,41,.96)" stroke="rgba(255,255,255,.18)" strokeWidth={0.55} />
      <Text x={4} y={1} width={12} height={15} text="···" align="center" fontFamily="Segoe UI" fontStyle="bold" fontSize={9} fill="#72d9ff" listening={false} />
    </KonvaGroup>
    {expanded && <KonvaGroup x={25} y={-2}>
      <Rect width={184} height={58} cornerRadius={10} fill="rgba(29,33,40,.97)" stroke="rgba(255,255,255,.16)" strokeWidth={0.6}
        shadowColor="#000" shadowBlur={14} shadowOpacity={0.34} />
      <Text x={10} y={8} width={164} height={42} text={item.comment} fontFamily="Segoe UI" fontSize={11}
        lineHeight={1.3} fill="#edf2f6" ellipsis wrap="word" listening={false} />
    </KonvaGroup>}
  </KonvaGroup>;
});
