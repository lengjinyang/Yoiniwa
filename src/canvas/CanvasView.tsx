import { useEffect, useRef } from 'react';
import type { Viewport } from '../types';
import { CanvasRuntime } from './runtime/CanvasRuntime';

interface CanvasViewProps {
  background: string;
  viewport: Viewport;
  onViewportCommit?(viewport: Viewport): void;
}

export function CanvasView({ background, viewport, onViewportCommit }: CanvasViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<CanvasRuntime | undefined>(undefined);
  const initialOptionsRef = useRef({ background, viewport });
  const viewportCommitRef = useRef(onViewportCommit);
  viewportCommitRef.current = onViewportCommit;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const runtime = new CanvasRuntime(container, {
      ...initialOptionsRef.current,
      onViewportCommit: (nextViewport) => viewportCommitRef.current?.(nextViewport),
    });
    runtimeRef.current = runtime;
    void runtime.start().catch((error: unknown) => {
      console.error('Failed to start Pixi canvas runtime', error);
    });
    return () => {
      runtimeRef.current = undefined;
      runtime.destroy();
    };
  }, []); // Runtime owns high-frequency state for its complete mounted lifetime.

  useEffect(() => { runtimeRef.current?.setViewport(viewport); }, [viewport]);
  useEffect(() => { runtimeRef.current?.setBackground(background); }, [background]);
  return <div ref={containerRef} className="canvas-runtime-root" data-canvas-runtime="pixi-v8" />;
}
