import { useEffect, useRef } from 'react';
import { renderItems } from '../../exportScene';
import type { SceneHistoryController } from './useSceneHistory';
import type { useVisualNotes } from './useVisualNotes';

interface UseAppHarnessOptions {
  history: SceneHistoryController;
  getVisualNotesForRender: ReturnType<typeof useVisualNotes>['getRenderNotes'];
  setSelectedIds(ids: string[]): void;
  setSelectedGroupId(id?: string): void;
}

export function useAppHarness({
  history,
  getVisualNotesForRender,
  setSelectedIds,
  setSelectedGroupId,
}: UseAppHarnessOptions) {
  const performanceSceneRef = useRef(history.scene);
  performanceSceneRef.current = history.scene;
  // The bench harness only needs the two stable history methods; depending on
  // the controller object would rebuild the window hooks on every commit.
  const { commit: commitScene, load: loadScene } = history;

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('smoke')) return undefined;
    const smokeWindow = window as typeof window & { __refCanvasSmokeExport?: () => Promise<ArrayBuffer> };
    smokeWindow.__refCanvasSmokeExport = () => renderItems(
      history.scene.items,
      history.scene.canvas.includeBackgroundOnExport ? history.scene.canvas.background : undefined,
      history.scene.groups,
      history.scene.canvas.backgroundOpacity ?? 1,
      getVisualNotesForRender(),
    );
    return () => { delete smokeWindow.__refCanvasSmokeExport; };
  }, [getVisualNotesForRender, history.scene]);

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('perf-bench')) return undefined;
    const perfWindow = window as typeof window & { __refCanvasPerf?: {
      getScene(): SceneHistoryController['scene'];
      expandScene(count: number): void;
      selectImages(count: number): void;
      clearSelection(): void;
      loadScene(scene: SceneHistoryController['scene']): void;
    } };
    perfWindow.__refCanvasPerf = {
      getScene: () => performanceSceneRef.current,
      expandScene: (count) => {
        commitScene((scene) => {
          if (!scene.items.length || count <= 0) return;
          const originals = [...scene.items];
          const columns = Math.ceil(Math.sqrt(count * 1.6));
          const cellWidth = 190;
          const cellHeight = 145;
          scene.items = Array.from({ length: count }, (_, index) => {
            const original = originals[index % originals.length];
            const width = 150;
            const height = width * original.naturalHeight / Math.max(1, original.naturalWidth);
            return {
              ...original,
              id: `perf-item-${index}`,
              name: `性能测试图片 ${index + 1}`,
              x: (index % columns) * cellWidth,
              y: Math.floor(index / columns) * cellHeight,
              width,
              height,
              rotation: 0,
              zIndex: index,
              locked: false,
            };
          });
          scene.groups = [];
          const rows = Math.ceil(count / columns);
          const scale = Math.min(
            (window.innerWidth - 80) / Math.max(1, columns * cellWidth),
            (window.innerHeight - 80) / Math.max(1, rows * cellHeight),
          );
          scene.viewport = { x: 40, y: 40, scale: Math.max(0.01, scale) };
        });
      },
      selectImages: (count) => {
        setSelectedGroupId(undefined);
        setSelectedIds(performanceSceneRef.current.items.slice(0, count).map((item) => item.id));
      },
      clearSelection: () => {
        setSelectedIds([]);
        setSelectedGroupId(undefined);
      },
      loadScene: (scene) => loadScene(scene),
    };
    return () => { delete perfWindow.__refCanvasPerf; };
  }, [commitScene, loadScene, setSelectedGroupId, setSelectedIds]);
}
