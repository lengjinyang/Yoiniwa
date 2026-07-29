import { useEffect, useRef } from 'react';
import type { ImageItem, Scene, Viewport } from '../types';
import { CanvasRuntime } from './runtime/CanvasRuntime';

interface CanvasViewProps {
  background: string;
  scene: Scene;
  viewport: Viewport;
  onViewportCommit?(viewport: Viewport): void;
  selectedIds: string[];
  onSelectionChange(ids: string[]): void;
  onItemsChanged(changes: Array<Partial<ImageItem> & { id: string }>): void;
}

export function CanvasView({ background, scene, viewport, selectedIds, onViewportCommit, onSelectionChange, onItemsChanged }: CanvasViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<CanvasRuntime | undefined>(undefined);
  const initialOptionsRef = useRef({ background, viewport, selectedIds });
  const viewportCommitRef = useRef(onViewportCommit);
  const selectionChangeRef = useRef(onSelectionChange);
  const itemsChangedRef = useRef(onItemsChanged);
  viewportCommitRef.current = onViewportCommit;
  selectionChangeRef.current = onSelectionChange;
  itemsChangedRef.current = onItemsChanged;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const runtime = new CanvasRuntime(container, {
      ...initialOptionsRef.current,
      onViewportCommit: (nextViewport) => viewportCommitRef.current?.(nextViewport),
      onSelectionChange: (ids) => selectionChangeRef.current(ids),
      onItemsChanged: (changes) => itemsChangedRef.current(changes),
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
  useEffect(() => { runtimeRef.current?.setScene(scene); }, [scene]);
  useEffect(() => { runtimeRef.current?.setSelection(selectedIds); }, [selectedIds]);
  useEffect(() => { runtimeRef.current?.setBackground(background); }, [background]);
  return <div ref={containerRef} className="canvas-runtime-root" data-canvas-runtime="pixi-v8" />;
}
