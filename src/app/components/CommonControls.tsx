import { memo, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useImageResource } from '../../runtime/imageResources';
import type { SceneItem } from '../../types';

export const OutlineThumbnail = memo(function OutlineThumbnail({ item }: { item: SceneItem }) {
  const image = useImageResource(item, 1, true, 'thumb128', 'thumb128');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const scale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
    const width = image.naturalWidth * scale; const height = image.naturalHeight * scale;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  }, [image]);
  return <span className="outline-thumb"><canvas ref={canvasRef} width={44} height={44} /></span>;
});

export function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 1024 * 1024 * 1024 ? 0 : 1)} MB`;
}

export function Button({ active, title, children, onClick, disabled }: {
  active?: boolean;
  title?: string;
  children: ReactNode;
  onClick(): void;
  disabled?: boolean;
}) {
  return <button className={active ? 'active' : ''} title={title} onClick={onClick} disabled={disabled}>{children}</button>;
}
