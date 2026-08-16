import { useCallback, useEffect, useRef, useState } from 'react';
import { produce } from 'immer';
import { cloneScene, createScene, normalizeScene } from './domain/scene';
import type { Scene } from './types';
import { createStressScene } from './stressScene';
import { createRevisionTracker } from './revisionTracker';

const stressFixture = (index: number) => {
  const hue = index * 47 % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="hsl(${hue} 55% 45%)"/><path d="M0 ${index % 32} L64 ${63 - index % 32} M${index % 24} 0 L${63 - index % 24} 64" stroke="white" stroke-width="2"/><circle cx="32" cy="32" r="${8 + index % 20}" fill="none" stroke="black"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

export function useSceneHistory() {
  const [scene, setScene] = useState<Scene>(() => new URLSearchParams(window.location.search).get('stress') === '2000'
    ? createStressScene(2000, 2000, stressFixture) : createScene());
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const [dirty, setDirty] = useState(false);
  const [revision, setRevision] = useState(0);
  const [projectEpoch, setProjectEpoch] = useState(0);
  const revisionTracker = useRef(createRevisionTracker());
  const past = useRef<Scene[]>([]);
  const future = useRef<Scene[]>([]);
  const transactionStart = useRef<Scene | undefined>(undefined);
  const pendingViewport = useRef<Scene['viewport'] | undefined>(undefined);
  const viewportFrame = useRef<number | undefined>(undefined);

  const advanceRevision = useCallback(() => {
    const next = revisionTracker.current.advance();
    setRevision(next);
    return next;
  }, []);

  const commit = useCallback((updater: (draft: Scene) => void) => {
    setScene((current) => {
      past.current.push(current);
      if (past.current.length > 200) past.current.shift();
      future.current = [];
      return produce(current, (draft) => {
        updater(draft as Scene);
        draft.savedAt = new Date().toISOString();
      });
    });
    setDirty(true);
    advanceRevision();
  }, [advanceRevision]);

  const updateViewport = useCallback((viewport: Scene['viewport']) => {
    pendingViewport.current = viewport;
    if (viewportFrame.current === undefined) viewportFrame.current = requestAnimationFrame(() => {
      const next = pendingViewport.current;
      viewportFrame.current = undefined;
      if (next) {
        setScene((current) => ({ ...current, viewport: next }));
        advanceRevision();
      }
    });
  }, [advanceRevision]);

  const flushViewport = useCallback((viewport: Scene['viewport']) => {
    if (viewportFrame.current !== undefined) cancelAnimationFrame(viewportFrame.current);
    viewportFrame.current = undefined;
    pendingViewport.current = undefined;
    const current = sceneRef.current;
    if (current.viewport.x === viewport.x && current.viewport.y === viewport.y && current.viewport.scale === viewport.scale) {
      return { scene: current, revision: revisionTracker.current.current() };
    }
    const next = { ...current, viewport: { ...viewport } };
    sceneRef.current = next;
    setScene(next);
    return { scene: next, revision: advanceRevision() };
  }, [advanceRevision]);

  const beginTransaction = useCallback(() => {
    if (!transactionStart.current) transactionStart.current = sceneRef.current;
  }, []);

  const preview = useCallback((updater: (draft: Scene) => void) => {
    setScene((current) => {
      return produce(current, (draft) => updater(draft as Scene));
    });
  }, []);

  const commitTransaction = useCallback(() => {
    if (!transactionStart.current) return;
    past.current.push(transactionStart.current);
    if (past.current.length > 200) past.current.shift();
    transactionStart.current = undefined;
    future.current = [];
    setDirty(true);
    advanceRevision();
  }, [advanceRevision]);

  const undo = useCallback(() => {
    setScene((current) => {
      const previous = past.current.pop();
      if (!previous) return current;
      future.current.push(current);
      setDirty(true);
      advanceRevision();
      return previous;
    });
  }, [advanceRevision]);

  const redo = useCallback(() => {
    setScene((current) => {
      const next = future.current.pop();
      if (!next) return current;
      past.current.push(current);
      setDirty(true);
      advanceRevision();
      return next;
    });
  }, [advanceRevision]);

  const load = useCallback((next: Scene) => {
    if (viewportFrame.current !== undefined) cancelAnimationFrame(viewportFrame.current);
    viewportFrame.current = undefined;
    pendingViewport.current = undefined;
    setScene(normalizeScene(cloneScene({ ...next, groups: next.groups ?? [] })));
    past.current = [];
    future.current = [];
    transactionStart.current = undefined;
    setProjectEpoch((value) => value + 1);
    setDirty(false);
    advanceRevision();
  }, [advanceRevision]);

  useEffect(() => () => {
    if (viewportFrame.current !== undefined) cancelAnimationFrame(viewportFrame.current);
  }, []);

  return {
    scene, commit, updateViewport, flushViewport, beginTransaction, preview, commitTransaction, undo, redo, load, dirty, revision, projectEpoch,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    markSaved: (saved?: Scene, savedRevision?: number) => {
      if (saved) setScene((current) => ({ ...current, name: saved.name, savedAt: saved.savedAt }));
      const isCurrent = revisionTracker.current.matches(savedRevision);
      if (isCurrent) setDirty(false);
      return isCurrent;
    },
  };
}

export type SceneHistoryController = ReturnType<typeof useSceneHistory>;
