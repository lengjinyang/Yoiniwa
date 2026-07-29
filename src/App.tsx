import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Konva from 'konva';
import { eraseAnnotationsAt } from './annotationEraser';
import { CanvasBoard } from './CanvasBoard';
import { CanvasView } from './canvas/CanvasView';
import { AutosaveCoordinator } from './canvas/persistence/AutosaveCoordinator';
import { loadProjectScene } from './canvas/persistence/ProjectLoader';
import { serializeProjectScene } from './canvas/persistence/ProjectSerializer';
import { ContextMenu, type ContextMenuEntry, type MenuPosition } from './ContextMenu';
import { annotationBounds, renderItems } from './exportScene';
import { applyLayout, type LayoutAction } from './layout';
import { matchesColorPickerShortcut, MAX_ZOOM, MIN_ZOOM, type ColorPickerShortcut } from './interactions';
import { arrangeImportedItems } from './importPlacement';
import { preloadImagePreview } from './imageResources';
import { annotationLabel, groupOrDescendantMatches, outlineObjectMatches, type OutlineFilter } from './outline';
import { normalizeTags } from './tags';
import { startOperation, settleOperation, clearOperation, type OperationKind, type OperationState } from './operationState';
import { annotationSceneBounds, applyNonDestructiveCrop, createGroupFrame, createScene, groupVisibleBounds, GROUP_TITLE_HEIGHT, itemBounds, memberBounds, moveAnnotation, moveGroupWithContents, reconcileAllMemberships, reconcileMemberBounds, removeMemberFromGroups, reorderImages, resetImageTransform, resetNonDestructiveCrop, sceneBounds, validateScene } from './scene';
import { captureSceneSelection, pasteScenePayload, type SceneClipboardPayload } from './sceneClipboard';
import { mergeSceneInto } from './sceneMerge';
import type { AnnotationItem, AnnotationTool, CacheInfo, GroupMember, ImageGroup, ImageItem, ImagePrewarmProgress, ImportedImage, PickedColor, RecentScene, WindowState } from './types';
import { useSceneHistory } from './useSceneHistory';
import { performanceMonitor } from './performanceMonitor';
import { applyImageChanges, deleteSceneSelection, layoutSceneImages, moveImageLayer } from './domain/sceneCommands';
import { Button, formatBytes, OutlineThumbnail } from './app/components/CommonControls';
import { clampGroupToolbarX } from './app/uiGeometry';
import { appCommand, createAppCommandRegistry } from './app/AppCommand';
import './styles.css';

const initialWindowState: WindowState = { alwaysOnTop: false, clickThrough: false, locked: false, opacity: 1 };
const COLOR_PICKER_SHORTCUT_STORAGE_KEY = 'refcanvas.colorPickerShortcut';

function commentScreenAnchor(item: ImageItem, viewport: { x: number; y: number; scale: number }) {
  const radians = item.rotation * Math.PI / 180;
  const centerX = item.x + item.width / 2; const centerY = item.y + item.height / 2;
  const localX = item.width / 2 + 14 / viewport.scale; const localY = -item.height / 2;
  const worldX = centerX + localX * Math.cos(radians) - localY * Math.sin(radians);
  const worldY = centerY + localX * Math.sin(radians) + localY * Math.cos(radians);
  return { x: viewport.x + worldX * viewport.scale, y: viewport.y + worldY * viewport.scale };
}

export default function App() {
  performanceMonitor.markReactRender();
  const history = useSceneHistory();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedAnnotationIds, setSelectedAnnotationIds] = useState<string[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string>();
  const [renamingGroupId, setRenamingGroupId] = useState<string>();
  const [renameDraft, setRenameDraft] = useState('');
  const [windowMode, setWindowMode] = useState(initialWindowState);
  const [recent, setRecent] = useState<RecentScene[]>([]);
  const [cacheInfo, setCacheInfo] = useState<CacheInfo>();
  const [cacheChanging, setCacheChanging] = useState(false);
  const [prewarmProgress, setPrewarmProgress] = useState<ImagePrewarmProgress>();
  const [status, setStatus] = useState('');
  const [operation, setOperation] = useState<OperationState>();
  const operationRef = useRef<OperationState | undefined>(undefined);
  const operationRequestRef = useRef(0);
  const saveInFlightRef = useRef(false);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [outlineQuery, setOutlineQuery] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [outlineCollapsedIds, setOutlineCollapsedIds] = useState<Set<string>>(() => new Set());
  const [sceneNameVisible, setSceneNameVisible] = useState(false);
  const [commentEditingId, setCommentEditingId] = useState<string>();
  const [commentDraft, setCommentDraft] = useState('');
  const [contextMenu, setContextMenu] = useState<MenuPosition>();
  const [annotationMode, setAnnotationMode] = useState(false);
  const [annotationTool, setAnnotationTool] = useState<AnnotationTool>('pen');
  const [annotationColor, setAnnotationColor] = useState('#ffcc45');
  const [annotationWidth, setAnnotationWidth] = useState(4);
  const [colorPickerHeld, setColorPickerHeld] = useState(false);
  const [groupToolbarVisible, setGroupToolbarVisible] = useState(false);
  const [colorPickerShortcut, setColorPickerShortcut] = useState<ColorPickerShortcut>(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.has('smoke') || query.has('stress')) return 's';
    try { return localStorage.getItem(COLOR_PICKER_SHORTCUT_STORAGE_KEY) === 'alt' ? 'alt' : 's'; }
    catch { return 's'; }
  });
  const [focusReturn, setFocusReturn] = useState<typeof history.scene.viewport>();
  const stageRef = useRef<Konva.Stage>(null);
  const groupToolbarRef = useRef<HTMLDivElement>(null);
  const groupToolbarHideTimerRef = useRef<number | undefined>(undefined);
  const groupToolbarPointerInsideRef = useRef(false);
  const groupHeaderDraggingRef = useRef(false);
  const renameComposingRef = useRef(false);
  const colorSyncRequestRef = useRef(0);
  const sceneClipboardRef = useRef<SceneClipboardPayload | undefined>(undefined);
  const lastPointerRef = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const api = window.refCanvas;
  const autosaveExecuteRef = useRef<(scene: typeof history.scene, revision: number) => Promise<void>>(async () => undefined);
  const autosaveCoordinatorRef = useRef<AutosaveCoordinator | undefined>(undefined);
  if (!autosaveCoordinatorRef.current) {
    autosaveCoordinatorRef.current = new AutosaveCoordinator((scene, revision) => autosaveExecuteRef.current(scene, revision));
  }
  autosaveExecuteRef.current = async (scene, revision) => {
    const result = await api?.autosaveScene(scene, revision);
    if (result?.scene) history.markSaved(result.scene, result.revision ?? revision);
  };
  const pixiCanvasPreview = new URLSearchParams(window.location.search).has('pixi-canvas');
  const performanceSceneRef = useRef(history.scene);
  const liveViewportRef = useRef(history.scene.viewport);
  performanceSceneRef.current = history.scene;
  useEffect(() => { liveViewportRef.current = history.scene.viewport; }, [history.scene.viewport]);
  useEffect(() => {
    const autosave = autosaveCoordinatorRef.current;
    if (!history.dirty) autosave?.cancel();
    else autosave?.schedule(history.scene, history.revision);
    return () => autosave?.cancel();
  }, [history.dirty, history.revision, history.scene]);
  useEffect(() => () => autosaveCoordinatorRef.current?.destroy(), []);

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('smoke')) return undefined;
    const smokeWindow = window as typeof window & { __refCanvasSmokeExport?: () => Promise<ArrayBuffer> };
    smokeWindow.__refCanvasSmokeExport = () => renderItems(
      history.scene.items,
      history.scene.canvas.includeBackgroundOnExport ? history.scene.canvas.background : undefined,
      history.scene.annotations,
      history.scene.groups,
    );
    return () => { delete smokeWindow.__refCanvasSmokeExport; };
  }, [history.scene]);

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('perf-bench')) return undefined;
    const perfWindow = window as typeof window & { __refCanvasPerf?: {
      getScene(): typeof history.scene;
      expandScene(count: number): void;
      selectImages(count: number): void;
      clearSelection(): void;
      loadScene(scene: typeof history.scene): void;
    } };
    perfWindow.__refCanvasPerf = {
      getScene: () => performanceSceneRef.current,
      expandScene: (count) => {
        history.commit((scene) => {
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
              comment: undefined,
            };
          });
          scene.groups = [];
          scene.annotations = [];
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
        setSelectedAnnotationIds([]);
        setSelectedIds(performanceSceneRef.current.items.slice(0, count).map((item) => item.id));
      },
      clearSelection: () => { setSelectedIds([]); setSelectedAnnotationIds([]); setSelectedGroupId(undefined); },
      loadScene: (scene) => history.load(scene),
    };
    return () => { delete perfWindow.__refCanvasPerf; };
  }, [history.commit, history.load]);

  useEffect(() => {
    try { localStorage.setItem(COLOR_PICKER_SHORTCUT_STORAGE_KEY, colorPickerShortcut); } catch { /* Persistence is optional. */ }
    setColorPickerHeld(false);
  }, [colorPickerShortcut]);

  const syncPickedColor = useCallback(async (color: PickedColor) => {
    const request = ++colorSyncRequestRef.current;
    if (!api) {
      setStatus(`无法连接桌面取色服务 ${color.hex}`);
      return;
    }
    const result = await api.syncPhotoshopForeground(color);
    if (request !== colorSyncRequestRef.current) return;
    setStatus(result.ok
      ? `已同步 Photoshop 前景色 ${color.hex}`
      : `${result.message ?? 'Photoshop 同步失败'} · ${color.hex}`);
  }, [api]);

  const selectedItems = useMemo(() => selectedIds.flatMap((id) => {
    const item = history.scene.items.find((value) => value.id === id);
    return item ? [item] : [];
  }), [history.scene.items, selectedIds]);
  const selectedAnnotations = useMemo(() => history.scene.annotations.filter((item) => selectedAnnotationIds.includes(item.id)), [history.scene.annotations, selectedAnnotationIds]);
  const selectedGroup = selectedGroupId ? history.scene.groups.find((group) => group.id === selectedGroupId) : undefined;

  const showGroupToolbar = useCallback(() => {
    if (groupHeaderDraggingRef.current) return;
    if (groupToolbarHideTimerRef.current !== undefined) window.clearTimeout(groupToolbarHideTimerRef.current);
    groupToolbarHideTimerRef.current = undefined;
    setGroupToolbarVisible(true);
  }, []);

  const hideGroupToolbarSoon = useCallback(() => {
    if (groupToolbarHideTimerRef.current !== undefined) window.clearTimeout(groupToolbarHideTimerRef.current);
    groupToolbarHideTimerRef.current = window.setTimeout(() => {
      groupToolbarHideTimerRef.current = undefined;
      if (!groupToolbarPointerInsideRef.current) setGroupToolbarVisible(false);
    }, 140);
  }, []);

  const setGroupHeaderDragging = useCallback((dragging: boolean) => {
    groupHeaderDraggingRef.current = dragging;
    if (!dragging) return;
    if (groupToolbarHideTimerRef.current !== undefined) window.clearTimeout(groupToolbarHideTimerRef.current);
    groupToolbarHideTimerRef.current = undefined;
    setGroupToolbarVisible(false);
  }, []);

  useEffect(() => {
    if (!selectedGroup) {
      setGroupToolbarVisible(false);
      return;
    }
    const bounds = groupVisibleBounds(selectedGroup);
    const viewport = history.scene.viewport;
    const pointerInsideGroup = (clientX: number, clientY: number) => {
      const worldX = (clientX - viewport.x) / viewport.scale;
      const worldY = (clientY - viewport.y) / viewport.scale;
      return worldX >= bounds.x && worldX <= bounds.x + bounds.width
        && worldY >= bounds.y && worldY <= bounds.y + bounds.height;
    };
    const pointer = lastPointerRef.current;
    setGroupToolbarVisible(pointerInsideGroup(pointer.x, pointer.y) || groupToolbarPointerInsideRef.current);
    const trackPointer = (event: MouseEvent) => {
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
      if (groupHeaderDraggingRef.current) return;
      const inside = pointerInsideGroup(event.clientX, event.clientY);
      if (inside) showGroupToolbar();
      else if (!groupToolbarPointerInsideRef.current) hideGroupToolbarSoon();
    };
    window.addEventListener('mousemove', trackPointer);
    return () => {
      window.removeEventListener('mousemove', trackPointer);
      if (groupToolbarHideTimerRef.current !== undefined) window.clearTimeout(groupToolbarHideTimerRef.current);
      groupToolbarHideTimerRef.current = undefined;
    };
  }, [hideGroupToolbarSoon, history.scene.viewport, selectedGroup, showGroupToolbar]);
  const targetIds = useMemo(() => {
    if (selectedIds.length) return selectedIds.filter((id) => !history.scene.items.find((item) => item.id === id)?.locked);
    if (selectedGroup) {
      const ids: string[] = [];
      const visited = new Set<string>();
      const collect = (group: ImageGroup) => {
        if (visited.has(group.id)) return;
        visited.add(group.id);
        group.members.forEach((member) => {
          if (member.type === 'image' && !history.scene.items.find((item) => item.id === member.id)?.locked) ids.push(member.id);
          if (member.type === 'group') {
            const child = history.scene.groups.find((value) => value.id === member.id);
            if (child) collect(child);
          }
        });
      };
      collect(selectedGroup);
      return [...new Set(ids)];
    }
    if (selectedAnnotationIds.length) return [];
    return history.scene.items.filter((item) => !item.locked).map((item) => item.id);
  }, [history.scene.groups, history.scene.items, selectedAnnotationIds.length, selectedGroup, selectedIds]);
  const primary = selectedItems[0];
  const layoutTargetCount = targetIds.length;
  const hasContent = history.scene.items.length > 0 || history.scene.annotations.length > 0 || history.scene.groups.length > 0;

  const setMode = useCallback(async (patch: Partial<WindowState>) => {
    if (!api) return;
    const next = await api.setWindowMode(patch);
    setWindowMode(next);
  }, [api]);

  useEffect(() => {
    if (!api) return;
    void api.getWindowMode().then(setWindowMode).catch((error) => setStatus(`读取窗口状态失败：${String(error)}`));
    void api.recentScenes().then(setRecent).catch((error) => setStatus(`读取最近画板失败：${String(error)}`));
    void api.getCacheInfo().then(setCacheInfo).catch((error) => setStatus(`读取缓存状态失败：${String(error)}`));
    const unsubscribePrewarm = api.onPrewarmProgress((progress) => {
      setPrewarmProgress((current) => current?.requestId === progress.requestId ? progress : current);
    });
    const unsubscribeClickThrough = api.onClickThroughDisabled(() => {
      setWindowMode((value) => ({ ...value, clickThrough: false }));
      setStatus('鼠标穿透已通过全局快捷键关闭');
    });
    return () => { unsubscribePrewarm(); unsubscribeClickThrough(); };
  }, [api]);

  useEffect(() => { api?.setDirty(history.dirty, history.revision); }, [api, history.dirty, history.revision]);
  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(''), 2800);
    return () => window.clearTimeout(timer);
  }, [status]);
  const beginOperation = useCallback((kind: OperationKind, message: string) => {
    const next = { requestId: ++operationRequestRef.current, kind, status: 'running' as const, message };
    operationRef.current = startOperation(next);
    setOperation(operationRef.current);
    return next.requestId;
  }, []);

  const settleCurrentOperation = useCallback((requestId: number, status: 'success' | 'error', message: string) => {
    const next = settleOperation(operationRef.current, requestId, status, message);
    operationRef.current = next;
    setOperation(next);
  }, []);

  const clearCurrentOperation = useCallback((requestId: number) => {
    const next = clearOperation(operationRef.current, requestId);
    operationRef.current = next;
    setOperation(next);
  }, []);

  useEffect(() => {
    if (!operation || operation.status === 'running') return;
    const timer = window.setTimeout(() => clearCurrentOperation(operation.requestId), operation.status === 'error' ? 6000 : 2800);
    return () => window.clearTimeout(timer);
  }, [clearCurrentOperation, operation]);
  useEffect(() => {
    const resourceError = () => setStatus('图片资源载入失败，请重新拖入或检查文件是否损坏');
    window.addEventListener('refcanvas-resource-error', resourceError);
    return () => window.removeEventListener('refcanvas-resource-error', resourceError);
  }, []);
  useEffect(() => {
    if (!sceneNameVisible) return;
    const timer = window.setTimeout(() => setSceneNameVisible(false), 2600);
    return () => window.clearTimeout(timer);
  }, [sceneNameVisible]);
  useEffect(() => {
    const rememberPointer = (event: MouseEvent) => { lastPointerRef.current = { x: event.clientX, y: event.clientY }; };
    window.addEventListener('mousemove', rememberPointer);
    window.addEventListener('mousedown', rememberPointer);
    return () => {
      window.removeEventListener('mousemove', rememberPointer);
      window.removeEventListener('mousedown', rememberPointer);
    };
  }, []);
  const addImages = useCallback(async (sources: ImportedImage[], placement?: { screenX: number; screenY: number; pack?: boolean }) => {
    if (!sources.length) return;
    setStatus(`正在载入 ${sources.length} 张图片…`);
    const decodedResults = await Promise.all(sources.map(async (source, index) => {
      try {
      // Registration in the main process already validates and records dimensions.
      // Re-decoding every original in Chromium makes large batch imports hitch badly.
      if (source.asset.naturalWidth < 1 || source.asset.naturalHeight < 1) {
        throw new Error('主进程未返回有效的图片尺寸');
      }
      const dimensions = { width: source.asset.naturalWidth, height: source.asset.naturalHeight };
      const scale = Math.min(1, 480 / Math.max(dimensions.width, dimensions.height));
      const width = dimensions.width * scale;
      const height = dimensions.height * scale;
      return { source, item: {
        id: crypto.randomUUID(),
        name: source.name,
        sourcePath: source.path,
        sourceType: source.sourceType ?? 'drop',
        assetId: source.assetId,
        naturalWidth: dimensions.width,
        naturalHeight: dimensions.height,
        x: 0,
        y: 0,
        width, height, rotation: 0, flipX: false, flipY: false, opacity: 1,
        zIndex: history.scene.items.length + index,
        locked: false,
        crop: { x: 0, y: 0, width: dimensions.width, height: dimensions.height },
      } satisfies ImageItem };
      } catch { return undefined; }
    }));
    const decoded = decodedResults.filter((value): value is NonNullable<typeof value> => Boolean(value));
    if (!decoded.length) { setStatus('图片无法解码，请检查文件格式或完整性'); return; }
    const screenX = placement?.screenX ?? window.innerWidth * 0.5;
    const screenY = placement?.screenY ?? window.innerHeight * 0.5;
    const placed = arrangeImportedItems(decoded.map((value) => value.item), history.scene.viewport, screenX, screenY, Boolean(placement?.pack),
      history.scene.canvas.padding, window.innerWidth / Math.max(1, window.innerHeight));
    history.commit((scene) => {
      decoded.forEach(({ item, source }) => { scene.assets[item.assetId!] = source.asset; });
      scene.items.push(...placed);
      placed.forEach((item) => reconcileMemberBounds(scene, { type: 'image', id: item.id }, memberBounds(scene, { type: 'image', id: item.id })!));
    });
    setSelectedIds(placed.map((item) => item.id));
    setSelectedAnnotationIds([]);
    setSelectedGroupId(undefined);
    setStatus(decoded.length === sources.length ? `已添加 ${decoded.length} 张图片` : `已添加 ${decoded.length} 张图片，${sources.length - decoded.length} 张无法解码`);
  }, [history]);

  const prepareAndAddImages = useCallback(async (
    sources: ImportedImage[],
    placement?: { screenX: number; screenY: number; pack?: boolean },
    existingRequestId?: string,
  ) => {
    if (!sources.length) return;
    if (!api) { await addImages(sources, placement); return; }
    const requestId = existingRequestId ?? crypto.randomUUID();
    setPrewarmProgress((current) => current?.requestId === requestId
      ? current : { requestId, completed: 0, total: sources.length });
    const decodePreviews = () => Promise.all(sources.map((source) => preloadImagePreview({
      assetId: source.assetId,
    })));
    try {
      const result = await api.prewarmImages(sources.map((source) => source.assetId), requestId);
      if (result.canceled) {
        setStatus('已取消导入');
        return;
      }
      // Keep the import overlay visible until Chromium has decoded every
      // generated preview. The canvas can then seed all previews synchronously
      // from memory instead of revealing them one at a time.
      const previewResults = await decodePreviews();
      if (new URLSearchParams(window.location.search).get('smoke') === '1') {
        document.documentElement.dataset.importPreviewPreloads = String(previewResults.filter(Boolean).length);
      }
      if (result.failed) setStatus(`${result.failed} 张图片预览生成失败，将使用原图`);
      // Do not add a batch of logically selected but visually blank objects.
      // Preview generation is the import boundary; higher quality continues in
      // the main process after this first frame is committed.
      await addImages(sources, placement);
    } catch {
      // A cache failure must not make a supported image impossible to import.
      const previewResults = await decodePreviews();
      if (new URLSearchParams(window.location.search).get('smoke') === '1') {
        document.documentElement.dataset.importPreviewPreloads = String(previewResults.filter(Boolean).length);
      }
      await addImages(sources, placement);
    } finally {
      setPrewarmProgress((current) => current?.requestId === requestId ? undefined : current);
    }
  }, [addImages, api]);

  const importImages = useCallback(async () => {
    if (!api) return;
    const requestId = crypto.randomUUID();
    setPrewarmProgress({ requestId, completed: 0, total: 1, stage: 'hash', fraction: 0 });
    try {
      const sources = await api.importImages(requestId);
      if (sources.length) await prepareAndAddImages(sources, undefined, requestId);
      else setPrewarmProgress((current) => current?.requestId === requestId ? undefined : current);
    } catch (error) {
      setPrewarmProgress((current) => current?.requestId === requestId ? undefined : current);
      setStatus(`导入失败：${String(error)}`);
    }
  }, [api, prepareAndAddImages]);

  const save = useCallback(async (saveAs = false) => {
    if (!api || saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    const flushed = history.flushViewport(liveViewportRef.current);
    const saveRevision = flushed.revision;
    const requestId = beginOperation('save', '正在保存…');
    try {
      const result = await api.saveScene(serializeProjectScene(flushed.scene), saveAs, saveRevision);
      if (!result.canceled) {
        const savedCurrentRevision = history.markSaved(result.scene, result.revision ?? saveRevision);
        setSceneNameVisible(true);
        settleCurrentOperation(requestId, 'success', `已保存至 ${result.path}`);
        setStatus(savedCurrentRevision ? '' : '保存完成，但保存期间产生了新修改');
        api.recentScenes().then(setRecent).catch((error) => setStatus(`刷新最近画板失败：${String(error)}`));
      } else clearCurrentOperation(requestId);
    } catch (error) {
      settleCurrentOperation(requestId, 'error', `保存失败：${String(error)}`);
    } finally {
      saveInFlightRef.current = false;
    }
  }, [api, beginOperation, clearCurrentOperation, history, settleCurrentOperation]);

  const open = useCallback(async (path?: string) => {
    if (!api) return;
    if (history.dirty && !window.confirm('当前更改尚未保存，仍要打开其他画板吗？')) return;
    const requestId = beginOperation('open', '正在打开画板…');
    try {
      const result = await api.openScene(path);
      const loaded = loadProjectScene(result.scene);
      if (!result.canceled && validateScene(loaded)) {
        history.load(loaded);
        setSelectedIds([]);
        setSelectedAnnotationIds([]);
        setSelectedGroupId(undefined);
        settleCurrentOperation(requestId, 'success', `已打开 ${result.path}`);
        api.recentScenes().then(setRecent).catch((error) => setStatus(`刷新最近画板失败：${String(error)}`));
      } else if (!result.canceled) settleCurrentOperation(requestId, 'error', '无法打开：不是有效的 RefCanvas 场景');
      else clearCurrentOperation(requestId);
    } catch (error) { settleCurrentOperation(requestId, 'error', `打开失败：${String(error)}`); }
  }, [api, beginOperation, clearCurrentOperation, history, settleCurrentOperation]);

  const openRef = useRef(open);
  useEffect(() => { openRef.current = open; }, [open]);

  useEffect(() => {
    if (!api) return;
    let active = true;
    void api.consumeStartupPath().then(async (path) => {
      if (!active) return;
      if (path) await openRef.current(path);
    }).catch((error) => {
      if (active) setStatus(`读取启动信息失败：${String(error)}`);
    });
    const dispose = api.onExternalOpen((path) => { void openRef.current(path); });
    return () => { active = false; dispose(); };
  // API is fixed for the lifetime of the Electron window; openRef carries the latest scene state.
  }, [api]);

  const importScene = useCallback(async () => {
    if (!api) return;
    const requestId = beginOperation('import', '正在导入画板…');
    try {
      const result = await api.importScene();
      if (result.canceled || !result.scene) {
        clearCurrentOperation(requestId);
        return;
      }
      const imported = loadProjectScene(result.scene);
      if (!validateScene(imported)) {
        settleCurrentOperation(requestId, 'error', '无法导入：不是有效的 RefCanvas 场景');
        return;
      }
      const viewport = history.scene.viewport;
      let merged: ReturnType<typeof mergeSceneInto> | undefined;
      history.commit((scene) => {
        merged = mergeSceneInto(scene, imported, {
          x: (window.innerWidth / 2 - viewport.x) / viewport.scale,
          y: (window.innerHeight / 2 - viewport.y) / viewport.scale,
        });
      });
      setSelectedIds(merged?.imageIds ?? []);
      setSelectedAnnotationIds(merged?.annotationIds ?? []);
      setSelectedGroupId(merged?.rootGroupIds[0]);
      const count = (merged?.imageIds.length ?? 0) + (merged?.annotationIds.length ?? 0) + (merged?.groupIds.length ?? 0);
      settleCurrentOperation(requestId, 'success', `已导入 ${count} 个对象`);
    } catch (error) {
      settleCurrentOperation(requestId, 'error', `导入画板失败：${String(error)}`);
    }
  }, [api, beginOperation, clearCurrentOperation, history, settleCurrentOperation]);

  const newScene = useCallback(() => {
    if (history.dirty && !window.confirm('当前更改尚未保存，仍要新建画板吗？')) return;
    api?.resetScenePath();
    history.load(createScene());
    setSelectedIds([]);
    setSelectedAnnotationIds([]);
    setSelectedGroupId(undefined);
    setStatus('已新建画板');
  }, [api, history]);

  const mutateSelected = useCallback((updater: (item: ImageItem) => void) => {
    if (!selectedIds.length) return;
    const selected = new Set(selectedIds);
    history.commit((scene) => {
      scene.items.forEach((item) => {
        if (!selected.has(item.id)) return;
        updater(item);
        const bounds = memberBounds(scene, { type: 'image', id: item.id });
        if (bounds) reconcileMemberBounds(scene, { type: 'image', id: item.id }, bounds);
      });
    });
  }, [history, selectedIds]);

  const restoreFullImages = useCallback(() => {
    const cropped = selectedItems.filter((item) => item.crop.x !== 0 || item.crop.y !== 0
      || item.crop.width !== item.naturalWidth || item.crop.height !== item.naturalHeight);
    if (!cropped.length) { setStatus('选中图片当前已经是完整原图'); return; }
    mutateSelected(resetNonDestructiveCrop);
    setStatus(`已恢复 ${cropped.length} 张图片被裁掉的区域`);
  }, [mutateSelected, selectedItems]);

  const addAnnotation = useCallback((annotation: AnnotationItem) => {
    history.commit((scene) => {
      scene.annotations.push(annotation);
      const bounds = annotationSceneBounds(annotation);
      reconcileMemberBounds(scene, { type: 'annotation', id: annotation.id }, bounds);
    });
  }, [history]);

  const eraseAnnotations = useCallback((x: number, y: number, radius: number) => {
    history.preview((scene) => {
      const result = eraseAnnotationsAt(scene.annotations, x, y, radius);
      if (!result.changed) return;
      scene.annotations = result.annotations;
      scene.groups.forEach((group) => {
        const memberIds = new Set(group.members.filter((member) => member.type === 'annotation').map((member) => member.id));
        group.members = group.members.filter((member) => member.type !== 'annotation' || !result.removedIds.includes(member.id));
        result.splitMembers.forEach(({ sourceId, newId }) => {
          if (memberIds.has(sourceId) && !group.members.some((member) => member.type === 'annotation' && member.id === newId)) {
            group.members.push({ type: 'annotation', id: newId });
          }
        });
      });
    });
  }, [history]);

  const clearAnnotations = useCallback(() => {
    if (!history.scene.annotations.length) return;
    history.commit((scene) => {
      scene.annotations = [];
      scene.groups.forEach((group) => { group.members = group.members.filter((member) => member.type !== 'annotation'); });
    });
    setSelectedAnnotationIds([]);
  }, [history]);

  const toggleAnnotationMode = useCallback(() => {
    setContextMenu(undefined);
    setPropertiesOpen(false);
    setAnnotationMode((enabled) => {
      if (!enabled) setSelectedIds([]);
      setStatus(enabled ? '已退出标注模式' : '标注模式：画笔');
      return !enabled;
    });
  }, []);

  const deleteSelected = useCallback(() => {
    if (!selectedIds.length && !selectedAnnotationIds.length) return;
    history.commit((scene) => deleteSceneSelection(scene, selectedIds, selectedAnnotationIds));
    setSelectedIds([]);
    setSelectedAnnotationIds([]);
  }, [history, selectedAnnotationIds, selectedIds]);

  const duplicate = useCallback(() => {
    const payload = captureSceneSelection(history.scene, selectedIds, selectedAnnotationIds, selectedGroupId);
    if (!payload) return;
    const next = structuredClone(history.scene);
    const result = pasteScenePayload(next, payload, 30);
    history.commit((scene) => {
      scene.items = next.items; scene.annotations = next.annotations; scene.groups = next.groups;
    });
    setSelectedIds(result?.rootGroupId ? [] : result?.imageIds ?? []);
    setSelectedAnnotationIds(result?.rootGroupId ? [] : result?.annotationIds ?? []);
    setSelectedGroupId(result?.rootGroupId);
  }, [history, selectedAnnotationIds, selectedGroupId, selectedIds]);

  const createGroup = useCallback(() => {
    const members: GroupMember[] = [
      ...selectedIds.map((id) => ({ type: 'image' as const, id })),
      ...selectedAnnotationIds.map((id) => ({ type: 'annotation' as const, id })),
    ];
    if (members.length < 2) { setStatus('请先框选至少两个对象'); return; }
    const name = `组 ${history.scene.groups.length + 1}`;
    const id = crypto.randomUUID();
    history.commit((scene) => { createGroupFrame(scene, members, name, id); });
    setSelectedIds([]);
    setSelectedAnnotationIds([]);
    setSelectedGroupId(id);
    setStatus(`已创建分组框“${name}”`);
  }, [history, selectedAnnotationIds, selectedIds]);

  const positionGroupToolbar = useCallback((group: ImageGroup, x = group.x, y = group.y) => {
    const toolbar = groupToolbarRef.current;
    if (!toolbar) return;
    const visibleBounds = groupVisibleBounds({ ...group, x, y });
    const centerX = history.scene.viewport.x + x * history.scene.viewport.scale + visibleBounds.width * history.scene.viewport.scale / 2;
    const frameTop = history.scene.viewport.y + y * history.scene.viewport.scale;
    toolbar.style.left = `${clampGroupToolbarX(centerX)}px`;
    toolbar.style.top = `${frameTop > 42 ? frameTop - 31 : frameTop + GROUP_TITLE_HEIGHT * history.scene.viewport.scale + 6}px`;
  }, [history.scene.viewport]);

  const renameGroupById = useCallback((groupId: string) => {
    const current = history.scene.groups.find((group) => group.id === groupId);
    if (!current) return;
    setSelectedGroupId(groupId);
    setRenameDraft(current.name);
    setRenamingGroupId(groupId);
  }, [history]);

  const renameGroup = useCallback(() => { if (selectedGroup) renameGroupById(selectedGroup.id); }, [renameGroupById, selectedGroup]);

  const cancelGroupRename = useCallback(() => {
    setRenamingGroupId(undefined);
    setRenameDraft('');
  }, []);

  const finishGroupRename = useCallback(() => {
    const name = renameDraft.trim();
    const current = renamingGroupId ? history.scene.groups.find((group) => group.id === renamingGroupId) : undefined;
    if (renamingGroupId && name && current?.name !== name) {
      history.commit((scene) => {
        const group = scene.groups.find((value) => value.id === renamingGroupId);
        if (group && group.name !== name) group.name = name;
      });
      setStatus(`分组框已重命名为“${name}”`);
    }
    setRenamingGroupId(undefined);
    setRenameDraft('');
  }, [history, renameDraft, renamingGroupId]);

  const ungroupSelected = useCallback(() => {
    if (!selectedGroup) return;
    history.commit((scene) => {
      removeMemberFromGroups(scene, { type: 'group', id: selectedGroup.id });
      const group = scene.groups.find((value) => value.id === selectedGroup.id);
      if (group) {
        group.members.filter((member) => member.type === 'group').forEach((member) => {
          const child = scene.groups.find((value) => value.id === member.id);
          if (child) child.parentId = undefined;
        });
        group.members = [];
      }
    });
    setStatus('已清空分组框成员');
  }, [history, selectedGroup]);

  const changeGroup = useCallback((groupId: string, patch: Partial<ImageGroup>) => {
    history.commit((scene) => {
      const group = scene.groups.find((value) => value.id === groupId);
      if (group) {
        Object.assign(group, patch);
        if (patch.x !== undefined || patch.y !== undefined || patch.width !== undefined || patch.height !== undefined) reconcileAllMemberships(scene);
      }
    });
  }, [history]);

  const moveGroup = useCallback((groupId: string, deltaX: number, deltaY: number) => {
    if (Math.abs(deltaX) < 0.01 && Math.abs(deltaY) < 0.01) return;
    history.commit((scene) => {
      moveGroupWithContents(scene, groupId, deltaX, deltaY);
      const bounds = memberBounds(scene, { type: 'group', id: groupId });
      if (bounds) reconcileMemberBounds(scene, { type: 'group', id: groupId }, bounds);
    });
  }, [history]);

  const deleteGroupById = useCallback((groupId: string, withContents: boolean) => {
    history.commit((scene) => {
      const remove = (groupId: string) => {
        const group = scene.groups.find((value) => value.id === groupId);
        if (!group) return;
        if (withContents) {
          const imageIds = new Set(group.members.filter((member) => member.type === 'image').map((member) => member.id));
          const annotationIds = new Set(group.members.filter((member) => member.type === 'annotation').map((member) => member.id));
          group.members.filter((member) => member.type === 'group').forEach((member) => remove(member.id));
          scene.items = scene.items.filter((item) => !imageIds.has(item.id));
          scene.annotations = scene.annotations.filter((annotation) => !annotationIds.has(annotation.id));
        } else {
          group.members.filter((member) => member.type === 'group').forEach((member) => {
            const child = scene.groups.find((value) => value.id === member.id);
            if (child) child.parentId = undefined;
          });
        }
        scene.groups.forEach((value) => { value.members = value.members.filter((member) => member.type !== 'group' || member.id !== groupId); });
        scene.groups = scene.groups.filter((value) => value.id !== groupId);
      };
      remove(groupId);
    });
    setSelectedGroupId(undefined);
    setStatus(withContents ? '已删除分组框及其内容' : '已删除分组框，内部对象已保留');
  }, [history]);

  const deleteGroup = useCallback((withContents: boolean) => {
    if (selectedGroup) deleteGroupById(selectedGroup.id, withContents);
  }, [deleteGroupById, selectedGroup]);

  const copySelection = useCallback(() => {
    const payload = captureSceneSelection(history.scene, selectedIds, selectedAnnotationIds, selectedGroupId);
    if (!payload) { setStatus('没有可复制的内容'); return false; }
    sceneClipboardRef.current = payload;
    setStatus(selectedGroupId ? '已复制分组框及其内容' : `已复制 ${payload.items.length + payload.annotations.length} 项`);
    return true;
  }, [history.scene, selectedAnnotationIds, selectedGroupId, selectedIds]);

  const cutSelection = useCallback(() => {
    if (!copySelection()) return;
    if (selectedGroup) deleteGroup(true); else deleteSelected();
    setStatus('已剪切，按 Ctrl+V 粘贴');
  }, [copySelection, deleteGroup, deleteSelected, selectedGroup]);

  const pasteClipboard = useCallback(() => {
    const payload = sceneClipboardRef.current;
    if (!payload) { setStatus('内部剪贴板为空'); return; }
    const next = structuredClone(history.scene);
    const pointer = lastPointerRef.current;
    const viewport = history.scene.viewport;
    const result = pasteScenePayload(next, payload, {
      x: (pointer.x - viewport.x) / viewport.scale,
      y: (pointer.y - viewport.y) / viewport.scale,
    });
    history.commit((scene) => { scene.items = next.items; scene.annotations = next.annotations; scene.groups = next.groups; });
    setSelectedIds(result?.rootGroupId ? [] : result?.imageIds ?? []);
    setSelectedAnnotationIds(result?.rootGroupId ? [] : result?.annotationIds ?? []);
    setSelectedGroupId(result?.rootGroupId);
    setStatus(result?.rootGroupId ? '已粘贴完整分组框' : '已粘贴内容');
  }, [history]);

  const editImageComment = useCallback(() => {
    if (!primary) return;
    setCommentEditingId(primary.id);
    setCommentDraft(primary.comment ?? '');
  }, [primary]);

  const finishImageComment = useCallback((saveComment: boolean) => {
    const id = commentEditingId;
    if (!id) return;
    const comment = commentDraft.trim();
    if (saveComment) {
      const current = history.scene.items.find((item) => item.id === id)?.comment ?? '';
      if (current !== comment) history.commit((scene) => {
          const item = scene.items.find((value) => value.id === id);
          if (item) item.comment = comment || undefined;
        });
      setStatus(comment ? '评论已收起到图片外侧' : '已删除图片评论');
    }
    setCommentEditingId(undefined);
    setCommentDraft('');
  }, [commentDraft, commentEditingId, history]);

  const showPrimarySource = useCallback(async () => {
    if (!primary?.sourcePath) { setStatus('这张图片来自剪贴板，或没有可用的本地源文件'); return; }
    const result = await api?.showSourceInFolder(primary.sourcePath);
    setStatus(result?.ok ? '已在资源管理器中定位源文件' : result?.message ?? '无法打开源文件位置');
  }, [api, primary]);

  const moveLayer = useCallback((toFront: boolean) => {
    if (!selectedIds.length) return;
    history.commit((scene) => {
      scene.items = reorderImages(scene.items, selectedIds, toFront);
    });
  }, [history, selectedIds]);

  const layout = useCallback((action: LayoutAction) => {
    if (!targetIds.length) return;
    history.commit((scene) => { layoutSceneImages(scene, targetIds, action, window.innerWidth / Math.max(1, window.innerHeight)); });
  }, [history, targetIds]);

  const commitItemChanges = useCallback((changes: Array<Partial<ImageItem> & { id: string }>) => {
    history.commit((scene) => applyImageChanges(scene, changes));
  }, [history]);

  const commitAnnotationChanges = useCallback((changes: Array<{ id: string; deltaX: number; deltaY: number }>) => {
    history.commit((scene) => changes.forEach((change) => {
      const annotation = scene.annotations.find((value) => value.id === change.id);
      if (!annotation) return;
      moveAnnotation(annotation, change.deltaX, change.deltaY);
      const bounds = annotationSceneBounds(annotation);
      reconcileMemberBounds(scene, { type: 'annotation', id: annotation.id }, bounds);
    }));
  }, [history]);

  const fitBounds = useCallback((bounds: { x: number; y: number; width: number; height: number }, margin = 80) => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(width / (bounds.width + margin), height / (bounds.height + margin))));
    history.updateViewport({ x: (width - bounds.width * scale) / 2 - bounds.x * scale, y: (height - bounds.height * scale) / 2 - bounds.y * scale, scale });
  }, [history]);

  const fitItems = useCallback((items: ImageItem[]) => {
    if (!items.length) return;
    fitBounds(sceneBounds(items));
  }, [fitBounds]);

  const fitCanvas = useCallback(() => {
    const bounds = [
      ...(history.scene.items.length ? [sceneBounds(history.scene.items)] : []),
      ...history.scene.annotations.map(annotationBounds),
      ...history.scene.groups.map(groupVisibleBounds),
    ];
    if (!bounds.length) return;
    const x = Math.min(...bounds.map((part) => part.x));
    const y = Math.min(...bounds.map((part) => part.y));
    const right = Math.max(...bounds.map((part) => part.x + part.width));
    const bottom = Math.max(...bounds.map((part) => part.y + part.height));
    fitBounds({ x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) });
  }, [fitBounds, history.scene.annotations, history.scene.groups, history.scene.items]);

  const toggleFocus = useCallback((items: ImageItem[]) => {
    if (!items.length) return;
    if (focusReturn) {
      history.updateViewport(focusReturn);
      setFocusReturn(undefined);
      return;
    }
    setFocusReturn({ ...history.scene.viewport });
    fitItems(items);
  }, [fitItems, focusReturn, history]);

  const focusItem = useCallback((item: ImageItem) => {
    if (!focusReturn) setFocusReturn({ ...history.scene.viewport });
    fitBounds(sceneBounds([item]), 8);
  }, [fitBounds, focusReturn, history.scene.viewport]);

  const focusStep = useCallback((direction: -1 | 1) => {
    const ordered = [...history.scene.items].sort((a, b) => a.zIndex - b.zIndex);
    if (!ordered.length) return;
    const currentIndex = Math.max(0, ordered.findIndex((item) => item.id === primary?.id));
    const next = ordered[(currentIndex + direction + ordered.length) % ordered.length];
    if (!focusReturn) setFocusReturn({ ...history.scene.viewport });
    setSelectedIds([next.id]);
    fitItems([next]);
  }, [fitItems, focusReturn, history.scene.items, history.scene.viewport, primary?.id]);

  const resetZoom = useCallback(() => {
    const viewport = history.scene.viewport;
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;
    const worldX = (centerX - viewport.x) / viewport.scale;
    const worldY = (centerY - viewport.y) / viewport.scale;
    history.updateViewport({ x: centerX - worldX, y: centerY - worldY, scale: 1 });
  }, [history]);

  const zoomBy = useCallback((factor: number) => {
    const viewport = history.scene.viewport;
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;
    const scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, viewport.scale * factor));
    const worldX = (centerX - viewport.x) / viewport.scale;
    const worldY = (centerY - viewport.y) / viewport.scale;
    history.updateViewport({ x: centerX - worldX * scale, y: centerY - worldY * scale, scale });
  }, [history]);

  const packAndFit = useCallback(() => {
    if (!targetIds.length) return;
    const targets = targetIds.flatMap((id) => {
      const item = history.scene.items.find((value) => value.id === id);
      return item ? [item] : [];
    });
    const transformed = applyLayout(targets, 'pack', history.scene.canvas.padding, window.innerWidth / Math.max(1, window.innerHeight));
    const byId = new Map(transformed.map((item) => [item.id, item]));
    const combined = history.scene.items.map((item) => byId.get(item.id) ?? item);
    history.commit((scene) => {
      scene.items = combined;
      transformed.forEach((item) => reconcileMemberBounds(scene, { type: 'image', id: item.id }, itemBounds(item)));
    });
    fitItems(transformed);
  }, [fitItems, history, targetIds]);

  const exportItems = useCallback(async (onlySelected: boolean, copy = false, format: 'png' | 'jpg' = 'png') => {
    if (!api) return;
    const items = onlySelected ? selectedItems : history.scene.items;
    const selectedBounds = onlySelected && items.length ? sceneBounds(items) : undefined;
    const annotations = onlySelected && selectedBounds
      ? history.scene.annotations.filter((annotation) => {
        const bounds = annotationBounds(annotation);
        return bounds.x < selectedBounds.x + selectedBounds.width && bounds.x + bounds.width > selectedBounds.x
          && bounds.y < selectedBounds.y + selectedBounds.height && bounds.y + bounds.height > selectedBounds.y;
      })
      : onlySelected ? [] : history.scene.annotations;
    if (!items.length && !annotations.length) { setStatus('没有可导出的内容'); return; }
    const requestId = beginOperation('export', '正在渲染导出图片…');
    try {
      const imageData = await renderItems(items, history.scene.canvas.includeBackgroundOnExport ? history.scene.canvas.background : undefined, annotations, onlySelected ? [] : history.scene.groups);
      if (copy) {
        await api.copyImage(imageData);
        settleCurrentOperation(requestId, 'success', '已将合成结果复制到剪贴板');
      } else {
        const originalBaseName = onlySelected && items.length === 1
          ? items[0].name.replace(/\.[^.]+$/, '') || items[0].name
          : undefined;
        const suggestedName = originalBaseName
          ? `${originalBaseName}.${format}`
          : `${history.scene.name}${onlySelected ? '-选中' : ''}.${format}`;
        const result = await api.exportImage(imageData, suggestedName);
        if (result.canceled) clearCurrentOperation(requestId);
        else settleCurrentOperation(requestId, 'success', `已导出至 ${result.path}`);
      }
    } catch (error) {
      settleCurrentOperation(requestId, 'error', `导出失败：${String(error)}`);
    }
  }, [api, beginOperation, clearCurrentOperation, history.scene, selectedItems, settleCurrentOperation]);

  const commands = useMemo(() => createAppCommandRegistry([
    { id: 'edit.undo', enabled: history.canUndo, execute: history.undo },
    { id: 'edit.redo', enabled: history.canRedo, execute: history.redo },
    { id: 'edit.copy', enabled: selectedIds.length + selectedAnnotationIds.length > 0 || Boolean(selectedGroup), execute: copySelection },
    { id: 'edit.cut', enabled: selectedIds.length + selectedAnnotationIds.length > 0 || Boolean(selectedGroup), execute: cutSelection },
    { id: 'edit.paste', enabled: Boolean(sceneClipboardRef.current), execute: pasteClipboard },
    { id: 'edit.duplicate', enabled: selectedIds.length + selectedAnnotationIds.length > 0 || Boolean(selectedGroup), execute: duplicate },
    { id: 'edit.delete', enabled: selectedIds.length + selectedAnnotationIds.length > 0 || Boolean(selectedGroup), execute: () => selectedGroup ? deleteGroup(false) : deleteSelected() },
    { id: 'group.create', enabled: selectedIds.length + selectedAnnotationIds.length >= 2, execute: createGroup },
  ]), [copySelection, createGroup, cutSelection, deleteGroup, deleteSelected, duplicate, history.canRedo, history.canUndo, history.redo, history.undo, pasteClipboard, selectedAnnotationIds.length, selectedGroup, selectedIds.length]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const input = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      if (input) return;
      const ctrl = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      const alt = event.altKey;
      const shift = event.shiftKey;
      const run = (action: () => void) => { event.preventDefault(); action(); };

      if (matchesColorPickerShortcut(colorPickerShortcut, event)) return run(() => {
        if (!event.repeat) setColorPickerHeld(true);
      });

      if (!ctrl && !alt && !shift && key === 'q') return run(() => {
        toggleAnnotationMode();
      });
      if (annotationMode && !ctrl && !alt) {
        if (key === '1') return run(() => setAnnotationTool('pen'));
        if (key === '2') return run(() => setAnnotationTool('arrow'));
        if (key === '3') return run(() => setAnnotationTool('rectangle'));
        if (key === '4') return run(() => setAnnotationTool('ellipse'));
        if (key === 'e') return run(() => setAnnotationTool('eraser'));
      }

      if (ctrl && alt && shift && event.key === 'ArrowUp') return run(() => layout('distribute-horizontal'));
      if (ctrl && alt && shift && event.key === 'ArrowDown') return run(() => layout('distribute-vertical'));
      if (ctrl && alt && !shift && event.key === 'ArrowLeft') return run(() => layout('normalize-height'));
      if (ctrl && alt && !shift && event.key === 'ArrowRight') return run(() => layout('normalize-width'));
      if (ctrl && alt && !shift && event.key === 'ArrowUp') return run(() => layout('normalize-size'));
      if (ctrl && alt && !shift && event.key === 'ArrowDown') return run(() => layout('normalize-size'));
      if (ctrl && !alt && !shift && event.key === 'ArrowLeft') return run(() => layout('align-left'));
      if (ctrl && !alt && !shift && event.key === 'ArrowRight') return run(() => layout('align-right'));
      if (ctrl && !alt && !shift && event.key === 'ArrowUp') return run(() => layout('align-top'));
      if (ctrl && !alt && !shift && event.key === 'ArrowDown') return run(() => layout('align-bottom'));

      if (ctrl && !alt && shift && key === 'p') return run(() => setContextMenu({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));
      if (ctrl && !alt && shift && key === 'a') return run(() => { void setMode({ alwaysOnTop: !windowMode.alwaysOnTop }); });
      if (ctrl && !alt && shift && key === 'z') return run(appCommand(commands, 'edit.redo').execute);
      if (ctrl && !alt && shift && key === 'c') return run(restoreFullImages);
      if (ctrl && !alt && shift && key === 't') return run(() => mutateSelected(resetImageTransform));
      if (ctrl && !alt && shift && key === 'g') return run(ungroupSelected);
      if (ctrl && !alt && shift && (key === '+' || key === '=')) return run(() => { void setMode({ opacity: Math.min(1, windowMode.opacity + 0.1) }); });
      if (ctrl && !alt && shift && key === '-') return run(() => { void setMode({ opacity: Math.max(0.3, windowMode.opacity - 0.1) }); });

      if (ctrl && alt && !shift && key === 'p') return run(packAndFit);
      if (ctrl && !alt && !shift && key === 'c') return run(appCommand(commands, 'edit.copy').execute);
      if (ctrl && !alt && !shift && key === 'x') return run(appCommand(commands, 'edit.cut').execute);
      if (ctrl && !alt && !shift && key === 'v') return run(appCommand(commands, 'edit.paste').execute);
      if (ctrl && !alt && !shift && key === 'i') return run(importImages);
      if (ctrl && !alt && key === 's') return run(() => { void save(shift); });
      if (ctrl && !alt && shift && key === 'l') return run(() => { if (recent[0]) void open(recent[0].path); else setStatus('没有最近打开的画板'); });
      if (ctrl && !alt && !shift && key === 'l') return run(() => { void open(); });
      if (ctrl && !alt && !shift && key === 'k') return run(newScene);
      if (ctrl && !alt && !shift && key === 'z') return run(appCommand(commands, 'edit.undo').execute);
      if (ctrl && !alt && !shift && key === 'y') return run(appCommand(commands, 'edit.redo').execute);
      if (ctrl && !alt && !shift && key === 'd') return run(appCommand(commands, 'edit.duplicate').execute);
      if (ctrl && !alt && !shift && key === 'g') return run(appCommand(commands, 'group.create').execute);
      if (ctrl && !alt && !shift && key === 'a') return run(() => {
        setSelectedGroupId(undefined);
        setSelectedIds(history.scene.items.filter((item) => !item.locked).map((item) => item.id));
        setSelectedAnnotationIds(history.scene.annotations.map((annotation) => annotation.id));
      });
      if (ctrl && !alt && !shift && key === 'p') return run(() => layout('pack'));
      if (ctrl && !alt && !shift && key === 'o') return run(fitCanvas);
      if (ctrl && !alt && key === 'e') return run(() => { void exportItems(shift); });
      if (ctrl && !alt && !shift && key === 'f') return run(() => api?.toggleMaximize());
      if (ctrl && !alt && !shift && key === 'm') return run(() => api?.minimize());
      if (ctrl && !alt && !shift && key === 'q') return run(() => api?.close());
      if (ctrl && !alt && !shift && key === 'w') return run(() => { void setMode({ locked: !windowMode.locked }); });
      if (ctrl && !alt && !shift && key === 't') return run(() => { void setMode({ clickThrough: !windowMode.clickThrough }); });
      if (ctrl && !alt && !shift && event.code === 'Space') return run(fitCanvas);
      if (ctrl && !alt && !shift && event.key === '0') return run(resetZoom);
      if (ctrl && !alt && !shift && (key === '+' || key === '=')) return run(() => zoomBy(1.15));
      if (ctrl && !alt && !shift && key === '-') return run(() => zoomBy(1 / 1.15));

      if (!ctrl && alt && shift && key === 'h') return run(() => mutateSelected((item) => { item.flipX = !item.flipX; }));
      if (!ctrl && alt && shift && key === 'v') return run(() => mutateSelected((item) => { item.flipY = !item.flipY; }));
      if (!ctrl && alt && !shift && key === 'l') return run(() => mutateSelected((item) => { item.locked = !item.locked; }));
      if (!ctrl && !alt && !shift && event.key === 'F2') return run(renameGroup);
      if (!annotationMode && !ctrl && !alt && !shift && event.code === 'Space' && !event.repeat) return run(() => toggleFocus(selectedItems));
      if (!ctrl && !alt && !shift && event.key === 'ArrowRight') return run(() => focusStep(1));
      if (!ctrl && !alt && !shift && event.key === 'ArrowLeft') return run(() => focusStep(-1));
      if (!ctrl && !alt && !shift && event.key === 'ArrowUp') return run(() => moveLayer(true));
      if (!ctrl && !alt && !shift && event.key === 'ArrowDown') return run(() => moveLayer(false));
      if (!ctrl && !alt && event.key === 'Tab') { event.preventDefault(); setContextMenu(undefined); setPropertiesOpen((value) => !value); }
      if (!annotationMode && !ctrl && !alt && event.key === 'Delete') {
        appCommand(commands, 'edit.delete').execute();
      }
      if (event.key === 'Escape') {
        setColorPickerHeld(false);
        if (renamingGroupId) setRenamingGroupId(undefined);
        else if (annotationMode) setAnnotationMode(false);
        else if (contextMenu) setContextMenu(undefined);
        else if (outlineOpen) setOutlineOpen(false);
        else if (propertiesOpen) setPropertiesOpen(false);
        else { setSelectedIds([]); setSelectedAnnotationIds([]); setSelectedGroupId(undefined); }
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const releasedPickerKey = colorPickerShortcut === 's'
        ? event.key.toLowerCase() === 's' || event.code === 'KeyS'
        : event.key === 'Alt' || event.code === 'AltLeft' || event.code === 'AltRight';
      if (releasedPickerKey) setColorPickerHeld(false);
    };
    const onBlur = () => setColorPickerHeld(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [annotationMode, api, colorPickerShortcut, commands, contextMenu, exportItems, fitCanvas, focusStep, history, importImages, layout, moveLayer, mutateSelected, newScene, open, outlineOpen, packAndFit, propertiesOpen, recent, renameGroup, renamingGroupId, resetZoom, restoreFullImages, save, selectedItems, setMode, toggleAnnotationMode, toggleFocus, ungroupSelected, windowMode, zoomBy]);

  useEffect(() => {
    const over = (event: DragEvent) => event.preventDefault();
    const drop = async (event: DragEvent) => {
      event.preventDefault();
      const supported = /\.(png|jpe?g|webp|bmp|gif)$/i;
      const files = [...(event.dataTransfer?.files ?? [])].filter((file) => file.type.startsWith('image/') || supported.test(file.name));
      if (!api) return;
      try {
        let sources: ImportedImage[] = [];
        if (files.length) {
          const localPaths = files.map((file) => api.pathForFile(file));
          if (!localPaths.every((value): value is string => Boolean(value))) {
            throw new Error('无法取得拖入文件的本地路径');
          }
          sources = await api.registerImagePaths(localPaths, 'drop');
        } else {
          const html = event.dataTransfer?.getData('text/html') ?? '';
          const uriList = event.dataTransfer?.getData('text/uri-list') ?? '';
          const plain = event.dataTransfer?.getData('text/plain') ?? '';
          const htmlSource = html.match(/<img[^>]+src=["']([^"']+)/i)?.[1];
          const urls = [...new Set([...uriList.split(/\r?\n/), plain, htmlSource]
            .filter((value): value is string => Boolean(value && !value.startsWith('#')))
            .filter((value) => /^https?:\/\//i.test(value.trim())).map((value) => value.trim()))];
          if (urls.length) sources = await api.registerImageUrls(urls);
        }
        if (!sources.length) { setStatus('没有识别到可导入的图片'); return; }
        const placement = { screenX: event.clientX, screenY: event.clientY, pack: sources.length > 1 };
        await prepareAndAddImages(sources, placement);
      } catch (error) {
        setStatus(`拖入图片失败：${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const paste = async (event: ClipboardEvent) => {
      const supported = /\.(png|jpe?g|webp|bmp|gif)$/i;
      const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/') || supported.test(file.name));
      if (files.length && api) try {
        const localPaths = files.map((file) => api.pathForFile(file));
        const sources = localPaths.every((value): value is string => Boolean(value))
          ? await api.registerImagePaths(localPaths, 'clipboard')
          : await api.registerClipboardImage();
        await prepareAndAddImages(sources, {
          screenX: lastPointerRef.current.x, screenY: lastPointerRef.current.y, pack: files.length > 1,
        });
      } catch (error) { setStatus(`粘贴图片失败：${error instanceof Error ? error.message : String(error)}`); }
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    window.addEventListener('paste', paste);
    return () => { window.removeEventListener('dragover', over); window.removeEventListener('drop', drop); window.removeEventListener('paste', paste); };
  }, [api, prepareAndAddImages]);

  useEffect(() => {
    if (!api || new URLSearchParams(window.location.search).get('smoke') !== '1') return;
    const addTestPaths = (event: Event) => {
      const paths = (event as CustomEvent<string[]>).detail;
      void api.registerImagePaths(paths, 'drop').then((sources) => prepareAndAddImages(sources, {
        screenX: window.innerWidth / 2, screenY: window.innerHeight / 2, pack: sources.length > 1,
      })).catch((error) => setStatus(`冒烟图片载入失败：${String(error)}`));
    };
    window.addEventListener('refcanvas-smoke-add-paths', addTestPaths);
    return () => window.removeEventListener('refcanvas-smoke-add-paths', addTestPaths);
  }, [addImages, api]);

  const updateCrop = (side: 'left' | 'right' | 'top' | 'bottom', percent: number) => {
    if (!primary) return;
    mutateSelected((item) => {
      const fullW = item.naturalWidth;
      const fullH = item.naturalHeight;
      let left = item.crop.x;
      let right = fullW - item.crop.x - item.crop.width;
      let top = item.crop.y;
      let bottom = fullH - item.crop.y - item.crop.height;
      if (side === 'left') left = Math.min(fullW - right - 1, fullW * percent / 100);
      if (side === 'right') right = Math.min(fullW - left - 1, fullW * percent / 100);
      if (side === 'top') top = Math.min(fullH - bottom - 1, fullH * percent / 100);
      if (side === 'bottom') bottom = Math.min(fullH - top - 1, fullH * percent / 100);
      applyNonDestructiveCrop(item, { x: left, y: top, width: fullW - left - right, height: fullH - top - bottom });
    });
  };

  const selectedObjectCount = selectedIds.length + selectedAnnotationIds.length;
  const hasSelection = selectedObjectCount > 0;
  const hasImageSelection = selectedIds.length > 0;
  const selectedTagObjects = useMemo(() => [
    ...selectedItems,
    ...selectedAnnotations,
    ...(selectedGroup ? [selectedGroup] : []),
  ], [selectedAnnotations, selectedGroup, selectedItems]);
  const displayedTags = selectedTagObjects.length
    ? (selectedTagObjects[0].tags ?? []).filter((tag) => selectedTagObjects.every((object) =>
      object.tags?.some((value) => value.localeCompare(tag, undefined, { sensitivity: 'accent' }) === 0)))
    : [];
  const mutateSelectedTags = (mutate: (tags: string[]) => string[]) => {
    history.commit((scene) => {
      const imageIds = new Set(selectedIds);
      const annotationIds = new Set(selectedAnnotationIds);
      const apply = <T extends { tags?: string[] },>(object: T) => {
        const next = normalizeTags(mutate([...(object.tags ?? [])]));
        if (next) object.tags = next;
        else delete object.tags;
      };
      scene.items.forEach((item) => { if (imageIds.has(item.id)) apply(item); });
      scene.annotations.forEach((annotation) => { if (annotationIds.has(annotation.id)) apply(annotation); });
      const group = selectedGroupId ? scene.groups.find((value) => value.id === selectedGroupId) : undefined;
      if (group) apply(group);
    });
  };
  const addSelectedTag = () => {
    const tag = normalizeTags([tagDraft])?.[0];
    if (!tag) return;
    mutateSelectedTags((tags) => [...tags, tag]);
    setTagDraft('');
  };
  const removeSelectedTag = (tag: string) => {
    const key = tag.toLocaleLowerCase();
    mutateSelectedTags((tags) => tags.filter((value) => value.toLocaleLowerCase() !== key));
  };
  const undoCommand = appCommand(commands, 'edit.undo');
  const redoCommand = appCommand(commands, 'edit.redo');
  const copyCommand = appCommand(commands, 'edit.copy');
  const cutCommand = appCommand(commands, 'edit.cut');
  const pasteCommand = appCommand(commands, 'edit.paste');
  const duplicateCommand = appCommand(commands, 'edit.duplicate');
  const deleteCommand = appCommand(commands, 'edit.delete');
  const createGroupCommand = appCommand(commands, 'group.create');
  const menuEntries: ContextMenuEntry[] = [
    { type: 'item', label: '大纲视图', checked: outlineOpen, action: () => setOutlineOpen((value) => !value) },
    { type: 'separator' },
    { type: 'item', label: `${history.scene.name}${history.dirty ? '  • 未保存' : ''}`, disabled: true },
    { type: 'separator' },
    {
      type: 'item', label: '文件', children: [
        { type: 'item', label: '打开…', shortcut: 'Ctrl+L', action: () => open() },
        { type: 'item', label: '合并其他画板…', action: () => { void importScene(); } },
        {
          type: 'item', label: '最近打开', disabled: recent.length === 0,
          children: recent.length ? recent.slice(0, 8).map((item) => ({ type: 'item' as const, label: item.name, action: () => open(item.path) })) : undefined,
        },
        { type: 'separator' },
        { type: 'item', label: '保存', shortcut: 'Ctrl+S', action: () => save(false) },
        { type: 'item', label: '另存为…', shortcut: 'Ctrl+Shift+S', action: () => save(true) },
      ],
    },
    {
      type: 'item', label: '编辑', children: [
        { type: 'item', label: '撤销', shortcut: 'Ctrl+Z', disabled: !undoCommand.enabled, action: undoCommand.execute },
        { type: 'item', label: '重做', shortcut: 'Ctrl+Shift+Z', disabled: !redoCommand.enabled, action: redoCommand.execute },
        { type: 'separator' },
        { type: 'item', label: '全选', shortcut: 'Ctrl+A', disabled: history.scene.items.length === 0, action: () => setSelectedIds(history.scene.items.filter((item) => !item.locked).map((item) => item.id)) },
        { type: 'item', label: '复制', shortcut: 'Ctrl+C', disabled: !copyCommand.enabled, action: copyCommand.execute },
        { type: 'item', label: '剪切', shortcut: 'Ctrl+X', disabled: !cutCommand.enabled, action: cutCommand.execute },
        { type: 'item', label: '粘贴', shortcut: 'Ctrl+V', disabled: !pasteCommand.enabled, action: pasteCommand.execute },
        { type: 'item', label: '快速创建副本', shortcut: 'Ctrl+D', disabled: !duplicateCommand.enabled, action: duplicateCommand.execute },
        { type: 'item', label: '删除选中', shortcut: 'Delete', disabled: !deleteCommand.enabled, danger: true, action: deleteCommand.execute },
        { type: 'separator' },
        { type: 'item', label: '创建分组框', shortcut: 'Ctrl+G', disabled: !createGroupCommand.enabled, action: createGroupCommand.execute },
        { type: 'item', label: '重命名组…', shortcut: 'F2', disabled: !selectedGroup, action: renameGroup },
        { type: 'item', label: '清空分组成员', shortcut: 'Ctrl+Shift+G', disabled: !selectedGroup, action: ungroupSelected },
        { type: 'item', label: '删除分组框', disabled: !selectedGroup, action: () => deleteGroup(false) },
        { type: 'item', label: '删除分组及内容', disabled: !selectedGroup, danger: true, action: () => deleteGroup(true) },
      ],
    },
    {
      type: 'item', label: '图片', disabled: !hasImageSelection, children: hasImageSelection ? [
        { type: 'item', label: primary?.locked ? '解锁' : '锁定', shortcut: 'Alt+L', action: () => mutateSelected((item) => { item.locked = !item.locked; }) },
        { type: 'item', label: '水平翻转', shortcut: 'Alt+Shift+H', action: () => mutateSelected((item) => { item.flipX = !item.flipX; }) },
        { type: 'item', label: '垂直翻转', shortcut: 'Alt+Shift+V', action: () => mutateSelected((item) => { item.flipY = !item.flipY; }) },
        { type: 'item', label: '重置变换', shortcut: 'Ctrl+Shift+T', action: () => mutateSelected(resetImageTransform) },
        { type: 'separator' },
        { type: 'item', label: '移到顶层', shortcut: '↑', action: () => moveLayer(true) },
        { type: 'item', label: '移到底层', shortcut: '↓', action: () => moveLayer(false) },
        { type: 'item', label: '恢复裁剪区域', shortcut: 'Ctrl+Shift+C', action: restoreFullImages },
        { type: 'item', label: primary?.grayscale ? '恢复彩色' : '灰度去色', action: () => mutateSelected((item) => { item.grayscale = !item.grayscale; }) },
        { type: 'item', label: primary?.comment ? '编辑气泡评论…' : '添加气泡评论…', action: editImageComment },
        { type: 'item', label: '打开源文件位置', disabled: !primary?.sourcePath, action: () => { void showPrimarySource(); } },
      ] : undefined,
    },
    {
      type: 'item', label: '排列', disabled: layoutTargetCount < 2, children: [
        { type: 'item', label: '紧密排列', shortcut: 'Ctrl+P', disabled: layoutTargetCount < 2, action: () => layout('pack') },
        { type: 'separator' },
        { type: 'item', label: '左对齐', shortcut: 'Ctrl+←', disabled: layoutTargetCount < 2, action: () => layout('align-left') },
        { type: 'item', label: '右对齐', shortcut: 'Ctrl+→', disabled: layoutTargetCount < 2, action: () => layout('align-right') },
        { type: 'item', label: '顶部对齐', shortcut: 'Ctrl+↑', disabled: layoutTargetCount < 2, action: () => layout('align-top') },
        { type: 'item', label: '底部对齐', shortcut: 'Ctrl+↓', disabled: layoutTargetCount < 2, action: () => layout('align-bottom') },
        { type: 'item', label: '水平分布', shortcut: 'Ctrl+Alt+Shift+↑', disabled: layoutTargetCount < 2, action: () => layout('distribute-horizontal') },
        { type: 'item', label: '垂直分布', shortcut: 'Ctrl+Alt+Shift+↓', disabled: layoutTargetCount < 2, action: () => layout('distribute-vertical') },
        { type: 'separator' },
        { type: 'item', label: '统一宽度', shortcut: 'Ctrl+Alt+→', disabled: layoutTargetCount < 2, action: () => layout('normalize-width') },
        { type: 'item', label: '统一高度', shortcut: 'Ctrl+Alt+←', disabled: layoutTargetCount < 2, action: () => layout('normalize-height') },
        { type: 'item', label: '统一尺寸', shortcut: 'Ctrl+Alt+↑', disabled: layoutTargetCount < 2, action: () => layout('normalize-size') },
      ],
    },
    {
      type: 'item', label: '视图', children: [
        { type: 'item', label: '聚焦选中', shortcut: 'Space', disabled: !hasSelection, action: () => toggleFocus(selectedItems) },
        { type: 'item', label: '显示整个画板', shortcut: 'Ctrl+Space', disabled: !hasContent, action: fitCanvas },
        { type: 'item', label: '重置缩放为 1:1', shortcut: 'Ctrl+0', action: resetZoom },
        { type: 'item', label: '属性面板', shortcut: 'Tab', checked: propertiesOpen, action: () => setPropertiesOpen((value) => !value) },
      ],
    },
    {
      type: 'item', label: '窗口', children: [
        { type: 'item', label: '始终置顶', shortcut: 'Ctrl+Shift+A', checked: windowMode.alwaysOnTop, action: () => setMode({ alwaysOnTop: !windowMode.alwaysOnTop }) },
        { type: 'item', label: '锁定窗口位置', shortcut: 'Ctrl+W', checked: windowMode.locked, action: () => setMode({ locked: !windowMode.locked }) },
        { type: 'item', label: '鼠标穿透', shortcut: 'Ctrl+T', checked: windowMode.clickThrough, action: () => setMode({ clickThrough: !windowMode.clickThrough }) },
        { type: 'range', label: '窗口透明度', min: 25, max: 100, value: windowMode.opacity * 100, onChange: (opacity) => { void setMode({ opacity: opacity / 100 }); } },
        { type: 'separator' },
        { type: 'item', label: '最小化', shortcut: 'Ctrl+M', action: () => api?.minimize() },
        { type: 'item', label: '最大化 / 还原', shortcut: 'Ctrl+F', action: () => api?.toggleMaximize() },
      ],
    },
    {
      type: 'item', label: '导出', disabled: !hasContent, children: [
        { type: 'item', label: '画板为 PNG…', shortcut: 'Ctrl+E', action: () => exportItems(false, false, 'png') },
        { type: 'item', label: '画板为 JPEG…', action: () => exportItems(false, false, 'jpg') },
        { type: 'item', label: '导出选中…', shortcut: 'Ctrl+Shift+E', disabled: !hasSelection, action: () => exportItems(true) },
        { type: 'item', label: '复制合成图', action: () => exportItems(hasSelection, true) },
      ],
    },
    { type: 'separator' },
    { type: 'item', label: '新建画板', shortcut: 'Ctrl+K', action: newScene },
    { type: 'item', label: '退出画布', shortcut: 'Ctrl+Q', danger: true, action: () => api?.close() },
  ];

  const groupedImageIds = new Set(history.scene.groups.flatMap((group) => group.members.filter((member) => member.type === 'image').map((member) => member.id)));
  const groupedAnnotationIds = new Set(history.scene.groups.flatMap((group) => group.members.filter((member) => member.type === 'annotation').map((member) => member.id)));
  const displaySceneName = history.scene.name === '未命名画板' ? history.scene.name : `${history.scene.name}.refcanvas`;
  const normalizedOutlineQuery = outlineQuery.trim().toLocaleLowerCase();
  const hasOutlineFilter = Boolean(normalizedOutlineQuery);
  const outlineFilter = useMemo<OutlineFilter>(() => ({
    query: outlineQuery,
  }), [outlineQuery]);
  const focusOutlineBounds = (bounds: { x: number; y: number; width: number; height: number }) => {
    if (!focusReturn) setFocusReturn({ ...history.scene.viewport });
    fitBounds(bounds, 72);
  };
  const selectOutlineImage = (item: ImageItem) => {
    setSelectedGroupId(undefined); setSelectedAnnotationIds([]); setSelectedIds([item.id]);
  };
  const focusOutlineImage = (item: ImageItem) => { selectOutlineImage(item); focusOutlineBounds(sceneBounds([item])); };
  const selectOutlineAnnotation = (annotation: AnnotationItem) => {
    setSelectedGroupId(undefined); setSelectedIds([]); setSelectedAnnotationIds([annotation.id]);
  };
  const focusOutlineAnnotation = (annotation: AnnotationItem) => { selectOutlineAnnotation(annotation); focusOutlineBounds(annotationSceneBounds(annotation)); };
  const selectOutlineGroup = (group: ImageGroup) => {
    setSelectedIds([]); setSelectedAnnotationIds([]); setSelectedGroupId(group.id);
  };
  const focusOutlineGroup = (group: ImageGroup) => {
    selectOutlineGroup(group);
    focusOutlineBounds(groupVisibleBounds(group));
  };
  const toggleOutlineGroup = (id: string) => setOutlineCollapsedIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const moveOutlineImageLayer = (id: string, direction: -1 | 1) => {
    const currentOrder = [...history.scene.items].sort((a, b) => a.zIndex - b.zIndex);
    const currentIndex = currentOrder.findIndex((item) => item.id === id);
    if (currentIndex < 0 || currentIndex + direction < 0 || currentIndex + direction >= currentOrder.length) return;
    history.commit((scene) => { moveImageLayer(scene, id, direction); });
  };
  const imageMatchesOutline = (item: ImageItem) => outlineObjectMatches(item, 'image', outlineFilter);
  const annotationMatchesOutline = (annotation: AnnotationItem) => outlineObjectMatches(annotation, 'annotation', outlineFilter);
  const groupMatchesOutline = (group: ImageGroup) => groupOrDescendantMatches(history.scene, group, outlineFilter);
  const renderOutlineImage = (item: ImageItem) => imageMatchesOutline(item) ? <li key={`image-${item.id}`}>
    <div className={`outline-row image${selectedIds.includes(item.id) ? ' selected' : ''}${item.hidden ? ' muted' : ''}`}>
      <span className="outline-indent" />
      <OutlineThumbnail item={item} />
      <button className="outline-name" title={`${item.name} · 双击定位`} onClick={() => selectOutlineImage(item)} onDoubleClick={() => focusOutlineImage(item)}>{item.name}</button>
      {item.comment && <span className="outline-comment-dot" title={item.comment}>●</span>}
      <span className="outline-actions">
        <button title={item.hidden ? '显示图片' : '隐藏图片'} onClick={() => history.commit((scene) => { const value = scene.items.find((entry) => entry.id === item.id); if (value) value.hidden = !value.hidden; })}>{item.hidden ? '◌' : '◉'}</button>
        <button title={item.locked ? '解锁图片' : '锁定图片'} onClick={() => history.commit((scene) => { const value = scene.items.find((entry) => entry.id === item.id); if (value) value.locked = !value.locked; })}>{item.locked ? '◆' : '◇'}</button>
        <button title="下移一层" onClick={() => moveOutlineImageLayer(item.id, -1)}>↓</button>
        <button title="上移一层" onClick={() => moveOutlineImageLayer(item.id, 1)}>↑</button>
      </span>
    </div>
  </li> : null;
  const renderOutlineAnnotation = (annotation: AnnotationItem) => annotationMatchesOutline(annotation) ? <li key={`annotation-${annotation.id}`}>
    <div className={`outline-row annotation${selectedAnnotationIds.includes(annotation.id) ? ' selected' : ''}${annotation.hidden ? ' muted' : ''}`}>
      <span className="outline-indent" /><span className="outline-type-icon">✎</span>
      <button className="outline-name" title="双击定位" onClick={() => selectOutlineAnnotation(annotation)} onDoubleClick={() => focusOutlineAnnotation(annotation)}>{annotationLabel(annotation)}</button>
      <span className="outline-actions">
        <button title={annotation.hidden ? '显示标注' : '隐藏标注'} onClick={() => history.commit((scene) => { const value = scene.annotations.find((entry) => entry.id === annotation.id); if (value) value.hidden = !value.hidden; })}>{annotation.hidden ? '◌' : '◉'}</button>
        <button title={annotation.locked ? '解锁标注' : '锁定标注'} onClick={() => history.commit((scene) => { const value = scene.annotations.find((entry) => entry.id === annotation.id); if (value) value.locked = !value.locked; })}>{annotation.locked ? '◆' : '◇'}</button>
      </span>
    </div>
  </li> : null;
  const renderOutlineGroup = (group: ImageGroup, visited = new Set<string>()): React.ReactNode => {
    if (visited.has(group.id) || !groupMatchesOutline(group)) return null;
    const nextVisited = new Set(visited).add(group.id);
    const collapsed = !hasOutlineFilter && outlineCollapsedIds.has(group.id);
    return <li key={group.id} className="outline-group-node">
      <div className={`outline-row group${selectedGroupId === group.id ? ' selected' : ''}`}>
        <button className="outline-disclosure" title={collapsed ? '展开' : '折叠'} onClick={() => toggleOutlineGroup(group.id)}>{collapsed ? '›' : '⌄'}</button>
        <span className="outline-type-icon group" style={{ color: group.color }}>▣</span>
        <button className="outline-name" title={`${group.name} · 双击定位`} onClick={() => selectOutlineGroup(group)} onDoubleClick={() => focusOutlineGroup(group)}>{group.name}</button>
        <span className="outline-count">{group.members.length}</span>
        <span className="outline-actions">
          <button title={group.contentsHidden ? '显示组内容' : '隐藏组内容'} onClick={() => changeGroup(group.id, { contentsHidden: !group.contentsHidden })}>{group.contentsHidden ? '◌' : '◉'}</button>
          <button title={group.sizeLocked ? '解锁组尺寸' : '锁定组尺寸'} onClick={() => changeGroup(group.id, { sizeLocked: !group.sizeLocked })}>{group.sizeLocked ? '◆' : '◇'}</button>
        </span>
      </div>
      {!collapsed && <ul>{group.members.map((member) => {
        if (member.type === 'group') {
          const child = history.scene.groups.find((value) => value.id === member.id);
          return child ? renderOutlineGroup(child, nextVisited) : null;
        }
        if (member.type === 'image') {
          const item = history.scene.items.find((value) => value.id === member.id);
          return item ? renderOutlineImage(item) : null;
        }
        const annotation = history.scene.annotations.find((value) => value.id === member.id);
        return annotation ? renderOutlineAnnotation(annotation) : null;
      })}</ul>}
    </li>;
  };

  return <main className="app-shell">
    <section className="workspace">
      {pixiCanvasPreview ? <CanvasView
        background={history.scene.canvas.background}
        scene={history.scene}
        viewport={history.scene.viewport}
        selectedIds={selectedIds}
        selectedAnnotationIds={selectedAnnotationIds}
        selectedGroupId={selectedGroupId}
        projectEpoch={history.projectEpoch}
        onSelectionChange={(ids) => { setSelectedIds(ids); setSelectedAnnotationIds([]); setSelectedGroupId(undefined); }}
        onAnnotationSelectionChange={(ids) => { setSelectedAnnotationIds(ids); setSelectedIds([]); setSelectedGroupId(undefined); }}
        onGroupSelectionChange={(id) => { setSelectedGroupId(id); if (id) { setSelectedIds([]); setSelectedAnnotationIds([]); } }}
        onItemsChanged={commitItemChanges}
        onAnnotationsChanged={commitAnnotationChanges}
        onGroupMoved={moveGroup}
        annotationMode={annotationMode}
        annotationTool={annotationTool}
        annotationColor={annotationColor}
        annotationWidth={annotationWidth}
        colorPickerHeld={colorPickerHeld}
        onColorPicked={(color) => { void syncPickedColor(color); }}
        onAddAnnotation={addAnnotation}
        onEraseStart={history.beginTransaction}
        onEraseAt={eraseAnnotations}
        onEraseEnd={history.commitTransaction}
        onFocusItem={focusItem}
        onContextMenu={(position) => { setPropertiesOpen(false); setContextMenu(position); }}
        windowLocked={windowMode.locked}
        onWindowMoveStart={() => api?.beginWindowMove()}
        onWindowMove={() => api?.updateWindowMove()}
        onWindowMoveEnd={() => api?.endWindowMove()}
        onViewportCommit={history.updateViewport}
      /> : <CanvasBoard
        scene={history.scene}
        projectEpoch={history.projectEpoch}
        selectedIds={selectedIds}
        selectedAnnotationIds={selectedAnnotationIds}
        selectedGroupId={selectedGroupId}
        onSelectionChange={(imageIds, annotationIds = []) => { setSelectedIds(imageIds); setSelectedAnnotationIds(annotationIds); }}
        onGroupSelectionChange={setSelectedGroupId}
        onViewportChange={history.updateViewport}
        onViewportPreview={(viewport) => { liveViewportRef.current = viewport; }}
        onItemsChanged={commitItemChanges}
        onFocusItem={focusItem}
        onContextMenu={(position) => { setPropertiesOpen(false); setContextMenu(position); }}
        onWindowMoveStart={() => api?.beginWindowMove()}
        onWindowMove={() => api?.updateWindowMove()}
        onWindowMoveEnd={() => api?.endWindowMove()}
        windowLocked={windowMode.locked}
        annotationMode={annotationMode}
        colorPickerHeld={colorPickerHeld}
        colorPickerShortcut={colorPickerShortcut}
        onColorPicked={(color) => { void syncPickedColor(color); }}
        annotationTool={annotationTool}
        annotationColor={annotationColor}
        annotationWidth={annotationWidth}
        onAddAnnotation={addAnnotation}
        onEraseStart={history.beginTransaction}
        onEraseAt={eraseAnnotations}
        onEraseEnd={history.commitTransaction}
        onAnnotationsChanged={commitAnnotationChanges}
        onGroupMoved={moveGroup}
        onGroupHeaderDragChange={setGroupHeaderDragging}
        onGroupPreview={(id, x, y) => {
          const group = history.scene.groups.find((value) => value.id === id);
          if (group) { positionGroupToolbar(group, x, y); showGroupToolbar(); }
        }}
        onGroupChanged={changeGroup}
        onGroupDeleted={(id) => deleteGroupById(id, false)}
        onRenameGroup={renameGroupById}
        stageRef={stageRef}
      />}

      {propertiesOpen && <aside className="property-panel no-drag">
        <div className="property-header"><div><strong>属性</strong><span>{selectedGroup ? '分组框' : selectedObjectCount ? `${selectedObjectCount} 项` : '画板'}</span></div><button title="关闭属性面板 (Tab)" onClick={() => setPropertiesOpen(false)}>×</button></div>
        <section>
          <h3>选择</h3>
          <div className="selection-summary">{selectedGroup
            ? `分组框“${selectedGroup.name}” · ${selectedGroup.members.length} 个直接成员`
            : selectedObjectCount ? `已选择 ${selectedObjectCount} 个对象` : `画板共 ${history.scene.items.length} 张图片`}</div>
          <div className="button-grid">
            <Button onClick={duplicateCommand.execute} disabled={!duplicateCommand.enabled}>复制</Button>
            <Button onClick={deleteCommand.execute} disabled={!deleteCommand.enabled}>删除</Button>
            <Button onClick={() => mutateSelected((item) => { item.locked = !item.locked; })} disabled={!selectedIds.length}>{primary?.locked ? '解锁' : '锁定'}</Button>
            <Button onClick={() => mutateSelected((item) => { item.flipX = !item.flipX; })} disabled={!selectedIds.length}>水平翻转</Button>
            <Button onClick={() => mutateSelected((item) => { item.flipY = !item.flipY; })} disabled={!selectedIds.length}>垂直翻转</Button>
            <Button onClick={() => mutateSelected(resetImageTransform)} disabled={!selectedIds.length}>重置变换</Button>
            <Button onClick={() => moveLayer(true)} disabled={!selectedIds.length}>移到顶层</Button>
            <Button onClick={() => moveLayer(false)} disabled={!selectedIds.length}>移到底层</Button>
            <Button onClick={() => mutateSelected((item) => { item.grayscale = !item.grayscale; })} disabled={!selectedIds.length}>{primary?.grayscale ? '恢复彩色' : '灰度去色'}</Button>
            <Button onClick={editImageComment} disabled={!primary}>{primary?.comment ? '编辑评论' : '添加评论'}</Button>
            <Button onClick={() => { void showPrimarySource(); }} disabled={!primary?.sourcePath}>源文件位置</Button>
          </div>
          <div className="button-grid" style={{ marginTop: 5 }}>
            <Button onClick={createGroupCommand.execute} disabled={!createGroupCommand.enabled}>创建分组框</Button>
            <Button onClick={renameGroup} disabled={!selectedGroup}>重命名组</Button>
            <Button onClick={ungroupSelected} disabled={!selectedGroup}>清空成员</Button>
          </div>
          <label>图片透明度 <output>{Math.round((primary?.opacity ?? 1) * 100)}%</output>
            <input type="range" min="10" max="100" value={(primary?.opacity ?? 1) * 100} disabled={!primary} onChange={(event) => mutateSelected((item) => { item.opacity = Number(event.target.value) / 100; })} />
          </label>
          {selectedTagObjects.length > 0 && <div className="tag-editor">
            <label>标签</label>
            <div className="tag-list">{displayedTags.map((tag) => <button key={tag} title={`移除标签 ${tag}`} onClick={() => removeSelectedTag(tag)}>{tag} ×</button>)}</div>
            <div className="tag-input-row">
              <input value={tagDraft} maxLength={64} placeholder="添加标签" onChange={(event) => setTagDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addSelectedTag(); } }} />
              <Button onClick={addSelectedTag}>添加</Button>
            </div>
          </div>}
        </section>

        {selectedGroup && <section>
          <h3>分组框</h3>
          <label className="color-row">背景颜色 <input type="color" value={selectedGroup.color} onChange={(event) => changeGroup(selectedGroup.id, { color: event.target.value })} /></label>
          <label>背景透明度 <output>{Math.round(selectedGroup.opacity * 100)}%</output>
            <input type="range" min="0" max="80" value={selectedGroup.opacity * 100}
              onPointerDown={history.beginTransaction}
              onChange={(event) => history.preview((scene) => { const group = scene.groups.find((value) => value.id === selectedGroup.id); if (group) group.opacity = Number(event.target.value) / 100; })}
              onPointerUp={history.commitTransaction}
              onPointerCancel={history.commitTransaction}
              onBlur={history.commitTransaction} />
          </label>
          <label className="color-row">标题颜色 <input type="color" value={selectedGroup.titleColor} onChange={(event) => changeGroup(selectedGroup.id, { titleColor: event.target.value })} /></label>
          <div className="button-grid" style={{ marginTop: 10 }}>
            <Button onClick={() => changeGroup(selectedGroup.id, { collapsed: !selectedGroup.collapsed })}>{selectedGroup.collapsed ? '展开' : '折叠'}</Button>
            <Button onClick={() => changeGroup(selectedGroup.id, { sizeLocked: !selectedGroup.sizeLocked })}>{selectedGroup.sizeLocked ? '解锁尺寸' : '锁定尺寸'}</Button>
            <Button onClick={() => changeGroup(selectedGroup.id, { contentsHidden: !selectedGroup.contentsHidden })}>{selectedGroup.contentsHidden ? '显示成员' : '隐藏成员'}</Button>
            <Button onClick={() => deleteGroup(false)}>删除框</Button>
            <Button onClick={() => deleteGroup(true)}>删除框及内容</Button>
          </div>
        </section>}

        {history.scene.groups.length > 0 && <section>
          <h3>所有分组框</h3>
          <div className="recent-list">{history.scene.groups.map((group) => <button key={group.id} onClick={() => {
            setSelectedIds([]); setSelectedAnnotationIds([]); setSelectedGroupId(group.id);
          }}>{group.contentsHidden ? '◌' : group.collapsed ? '▸' : '▾'} {group.name}</button>)}</div>
        </section>}

        <section>
          <h3>排列与对齐</h3>
          <div className="button-grid compact">
            <Button disabled={layoutTargetCount < 2} onClick={() => layout('align-left')}>左对齐</Button><Button disabled={layoutTargetCount < 2} onClick={() => layout('align-right')}>右对齐</Button>
            <Button disabled={layoutTargetCount < 2} onClick={() => layout('align-top')}>顶对齐</Button><Button disabled={layoutTargetCount < 2} onClick={() => layout('align-bottom')}>底对齐</Button>
            <Button disabled={layoutTargetCount < 2} onClick={() => layout('distribute-horizontal')}>水平分布</Button><Button disabled={layoutTargetCount < 2} onClick={() => layout('distribute-vertical')}>垂直分布</Button>
            <Button disabled={layoutTargetCount < 2} onClick={() => layout('normalize-width')}>统一宽度</Button><Button disabled={layoutTargetCount < 2} onClick={() => layout('normalize-height')}>统一高度</Button>
            <Button disabled={layoutTargetCount < 2} onClick={() => layout('normalize-size')}>统一尺寸</Button><Button disabled={layoutTargetCount < 2} onClick={() => layout('pack')}>紧密排列</Button>
          </div>
          <label>排列间距 <output>{history.scene.canvas.padding}px</output>
            <input type="range" min="0" max="100" value={history.scene.canvas.padding} onChange={(event) => history.commit((scene) => { scene.canvas.padding = Number(event.target.value); })} />
          </label>
          <label className="check-row"><input type="checkbox" checked={history.scene.canvas.snap} onChange={(event) => history.commit((scene) => { scene.canvas.snap = event.target.checked; })} /> 移动时吸附图片边缘与中心</label>
        </section>

        {primary && <section>
          <h3>非破坏性裁剪</h3>
          <div className="crop-grid">
            {(['left', 'right', 'top', 'bottom'] as const).map((side) => {
              const percent = side === 'left' ? primary.crop.x / primary.naturalWidth * 100
                : side === 'right' ? (1 - (primary.crop.x + primary.crop.width) / primary.naturalWidth) * 100
                : side === 'top' ? primary.crop.y / primary.naturalHeight * 100
                : (1 - (primary.crop.y + primary.crop.height) / primary.naturalHeight) * 100;
              const labels = { left: '左', right: '右', top: '上', bottom: '下' };
              return <label key={side}>{labels[side]} <input type="number" min="0" max="45" step="1" value={Math.round(percent)} onChange={(event) => updateCrop(side, Number(event.target.value))} />%</label>;
            })}
          </div>
          <Button onClick={restoreFullImages}>恢复裁剪区域</Button>
        </section>}

        <section>
          <h3>画板与输出</h3>
          <label className="color-row">背景色 <input type="color" value={history.scene.canvas.background} onChange={(event) => history.commit((scene) => { scene.canvas.background = event.target.value; })} /></label>
          <label className="check-row"><input type="checkbox" checked={history.scene.canvas.includeBackgroundOnExport} onChange={(event) => history.commit((scene) => { scene.canvas.includeBackgroundOnExport = event.target.checked; })} /> 导出时包含背景</label>
          <div className="button-grid">
            <Button onClick={() => exportItems(false, false, 'png')}>导出 PNG</Button>
            <Button onClick={() => exportItems(false, false, 'jpg')}>导出 JPEG</Button>
            <Button onClick={() => exportItems(true)} disabled={!selectedIds.length}>导出选中</Button>
            <Button onClick={() => exportItems(Boolean(selectedIds.length), true)}>复制合成图</Button>
            <Button onClick={() => save(true)}>另存为</Button>
          </div>
        </section>

        <section>
          <h3>交互设置</h3>
          <div className="selection-summary">按住所选按键并用左键在图片上拖动取色</div>
          <div className="button-grid">
            <Button active={colorPickerShortcut === 's'} onClick={() => { setColorPickerShortcut('s'); setStatus('取色快捷键已设为 S'); }}>S（默认）</Button>
            <Button active={colorPickerShortcut === 'alt'} onClick={() => { setColorPickerShortcut('alt'); setStatus('取色快捷键已设为 Alt'); }}>Alt</Button>
          </div>
        </section>

        <section>
          <h3>性能与缓存</h3>
          <div className="cache-location" title={cacheInfo?.root ?? '正在读取缓存位置'}>{cacheInfo?.root ?? '正在读取…'}</div>
          <div className="selection-summary">缓存占用 {cacheInfo ? formatBytes(cacheInfo.assetBytes + cacheInfo.derivedBytes) : '—'} · 原图与预览资源</div>
          <div className="cache-notice">建议放在 SSD 或其他高速本地硬盘。避免使用 U 盘、移动硬盘、网络磁盘及云同步目录，以免影响导入和缩放性能。</div>
          {cacheInfo?.warning && <div className="cache-warning">{cacheInfo.warning}</div>}
          <div className="button-grid" style={{ marginTop: 9 }}>
            <Button disabled={!api || cacheChanging} onClick={() => { void (async () => {
              if (!api) return;
              setCacheChanging(true);
              try {
                const result = await api.chooseCacheLocation();
                if (!result.canceled && result.info) { setCacheInfo(result.info); setStatus('缓存已迁移到新位置'); }
              } catch (error) { setStatus(`迁移缓存失败：${String(error)}`); }
              finally { setCacheChanging(false); }
            })(); }}>{cacheChanging ? '正在迁移…' : '更改位置…'}</Button>
            <Button disabled={!api || cacheChanging || !cacheInfo || cacheInfo.isDefault} onClick={() => { void (async () => {
              if (!api) return;
              setCacheChanging(true);
              try { setCacheInfo(await api.resetCacheLocation()); setStatus('缓存已恢复默认位置'); }
              catch (error) { setStatus(`迁移缓存失败：${String(error)}`); }
              finally { setCacheChanging(false); }
            })(); }}>恢复默认位置</Button>
            <Button disabled={!api} onClick={() => { void api?.openLogsFolder()
              .then((result) => setStatus(`日志目录：${result.path}`))
              .catch((error) => setStatus(`打开日志目录失败：${String(error)}`)); }}>打开日志文件夹</Button>
            <Button disabled={!api} onClick={() => { void api?.copyDiagnostics()
              .then((result) => setStatus(`诊断信息已复制 · 会话 ${result.sessionId.slice(0, 8)}`))
              .catch((error) => setStatus(`复制诊断信息失败：${String(error)}`)); }}>复制诊断信息</Button>
          </div>
        </section>

        {recent.length > 0 && <section>
          <h3>最近打开</h3>
          <div className="recent-list">{recent.slice(0, 5).map((item) => <button key={item.path} title={item.path} onClick={() => open(item.path)}>{item.name}</button>)}</div>
        </section>}
      </aside>}
    </section>

    {outlineOpen && <aside className="outline-panel no-drag">
      <header>
        <div><strong>大纲</strong><span>{history.scene.items.length + history.scene.annotations.length + history.scene.groups.length}</span></div>
        <span className="outline-header-actions">
          <button title="全部展开" onClick={() => setOutlineCollapsedIds(new Set())}>⌄</button>
          <button title="全部折叠" onClick={() => setOutlineCollapsedIds(new Set(history.scene.groups.map((group) => group.id)))}>›</button>
          <button title="关闭大纲" onClick={() => setOutlineOpen(false)}>×</button>
        </span>
      </header>
      <div className="outline-search">
        <span>⌕</span><input value={outlineQuery} onChange={(event) => setOutlineQuery(event.target.value)} placeholder="搜索名称、评论或标签" />
        {outlineQuery && <button title="清除搜索" onClick={() => setOutlineQuery('')}>×</button>}
      </div>
      <div className="outline-tree"><ul>
        {history.scene.groups.filter((group) => !group.parentId).map((group) => renderOutlineGroup(group))}
        {history.scene.items.filter((item) => !groupedImageIds.has(item.id)).map(renderOutlineImage)}
        {history.scene.annotations.filter((item) => !groupedAnnotationIds.has(item.id)).map(renderOutlineAnnotation)}
      </ul>
      {hasOutlineFilter && !history.scene.groups.some((group) => groupMatchesOutline(group))
        && !history.scene.items.some(imageMatchesOutline) && !history.scene.annotations.some(annotationMatchesOutline)
        && <div className="outline-empty">没有匹配的对象</div>}
      </div>
    </aside>}

    {commentEditingId && (() => {
      const item = history.scene.items.find((value) => value.id === commentEditingId);
      if (!item) return null;
      const anchor = commentScreenAnchor(item, history.scene.viewport);
      return <div className="comment-editor-backdrop no-drag" onMouseDown={() => finishImageComment(true)}>
        <div className="comment-editor-bubble" style={{
          left: Math.max(14, Math.min(window.innerWidth - 334, anchor.x)),
          top: Math.max(14, Math.min(window.innerHeight - 196, anchor.y)),
        }} onMouseDown={(event) => event.stopPropagation()}>
          <div className="comment-editor-heading"><span>评论 · {item.name}</span><button title="取消" onClick={() => finishImageComment(false)}>×</button></div>
          <textarea autoFocus value={commentDraft} maxLength={1200} placeholder="写下这张参考图需要注意的内容…"
            onChange={(event) => setCommentDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.preventDefault(); finishImageComment(false); }
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); finishImageComment(true); }
            }} />
          <div className="comment-editor-footer">
            <small>{commentDraft.length}/1200 · 点击外部或 Ctrl+Enter 发布</small>
            {item.comment && <button className="delete" onClick={() => {
              history.commit((scene) => { const value = scene.items.find((entry) => entry.id === item.id); if (value) value.comment = undefined; });
              setCommentEditingId(undefined); setCommentDraft(''); setStatus('已删除图片评论');
            }}>删除</button>}
            <button className="submit" onClick={() => finishImageComment(true)}>发布</button>
          </div>
        </div>
      </div>;
    })()}

    <div className={`scene-name-badge no-drag${sceneNameVisible ? ' visible' : ''}`} title={displaySceneName}>{displaySceneName}{history.dirty ? '  •' : ''}</div>

    <div className="window-control-zone no-drag">
      <div className="window-floating-controls">
        <button className={windowMode.alwaysOnTop ? 'active' : ''} title={windowMode.alwaysOnTop ? '取消始终置顶' : '始终置顶'}
          onClick={() => { void setMode({ alwaysOnTop: !windowMode.alwaysOnTop }); }}>⌃</button>
        <button title="最小化" onClick={() => api?.minimize()}>—</button>
        <button title="最大化 / 还原" onClick={() => api?.toggleMaximize()}>□</button>
        <button className="close" title="关闭" onClick={() => api?.close()}>×</button>
      </div>
    </div>

    {contextMenu && <ContextMenu position={contextMenu} entries={menuEntries} onClose={() => setContextMenu(undefined)} />}

    {selectedGroup && <div ref={groupToolbarRef} className={`group-toolbar no-drag${groupToolbarVisible ? '' : ' auto-hidden'}`}
      onMouseEnter={() => { groupToolbarPointerInsideRef.current = true; showGroupToolbar(); }}
      onMouseLeave={() => { groupToolbarPointerInsideRef.current = false; hideGroupToolbarSoon(); }}
      style={(() => {
      const visibleBounds = groupVisibleBounds(selectedGroup);
      const centerX = history.scene.viewport.x + selectedGroup.x * history.scene.viewport.scale + visibleBounds.width * history.scene.viewport.scale / 2;
      const frameTop = history.scene.viewport.y + selectedGroup.y * history.scene.viewport.scale;
      return { left: clampGroupToolbarX(centerX), top: frameTop > 42 ? frameTop - 31 : frameTop + GROUP_TITLE_HEIGHT * history.scene.viewport.scale + 6 };
    })()}>
      <button className="group-toolbar-title" title="双击分组框标题或按 F2 重命名" onDoubleClick={() => renameGroupById(selectedGroup.id)}>
        <span style={{ background: selectedGroup.color }} />{selectedGroup.name}
      </button>
      <span className="group-toolbar-divider" />
      <label title="分组框颜色" className="group-color-control"><input type="color" value={selectedGroup.color} onChange={(event) => changeGroup(selectedGroup.id, { color: event.target.value })} /></label>
      <label className="group-opacity-control" title={`背景透明度 ${Math.round(selectedGroup.opacity * 100)}%`}>
        <input type="range" min="0" max="80" value={selectedGroup.opacity * 100}
          onPointerDown={history.beginTransaction}
          onChange={(event) => history.preview((scene) => { const group = scene.groups.find((value) => value.id === selectedGroup.id); if (group) group.opacity = Number(event.target.value) / 100; })}
          onPointerUp={history.commitTransaction}
          onPointerCancel={history.commitTransaction}
          onBlur={history.commitTransaction} />
      </label>
      <label title="标题文字颜色" className="group-title-color"><input type="color" value={selectedGroup.titleColor} onChange={(event) => changeGroup(selectedGroup.id, { titleColor: event.target.value })} /></label>
      <span className="group-toolbar-divider" />
      <button className={selectedGroup.collapsed ? 'active' : ''} title={selectedGroup.collapsed ? '展开内容' : '折叠内容'} onClick={() => changeGroup(selectedGroup.id, { collapsed: !selectedGroup.collapsed })}>▱</button>
      <button className={selectedGroup.sizeLocked ? 'active' : ''} title={selectedGroup.sizeLocked ? '解锁分组框尺寸' : '锁定分组框尺寸'} onClick={() => changeGroup(selectedGroup.id, { sizeLocked: !selectedGroup.sizeLocked })}>{selectedGroup.sizeLocked ? '●' : '○'}</button>
      <button className={selectedGroup.contentsHidden ? 'active' : ''} title={selectedGroup.contentsHidden ? '显示成员' : '隐藏成员'} onClick={() => changeGroup(selectedGroup.id, { contentsHidden: !selectedGroup.contentsHidden })}>{selectedGroup.contentsHidden ? '◌' : '◉'}</button>
      <button className="danger" title="删除分组框，保留内容" onClick={() => deleteGroup(false)}>×</button>
    </div>}

    {renamingGroupId && <div className="group-rename-overlay no-drag" onMouseDown={finishGroupRename}>
      <div className="group-rename-card" onMouseDown={(event) => event.stopPropagation()}>
        <span>重命名分组框</span>
        <input autoFocus value={renameDraft} onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setRenameDraft(event.target.value)}
          onCompositionStart={() => { renameComposingRef.current = true; }}
          onCompositionEnd={() => { window.setTimeout(() => { renameComposingRef.current = false; }, 0); }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !renameComposingRef.current && !event.nativeEvent.isComposing) { event.preventDefault(); finishGroupRename(); }
            if (event.key === 'Escape') cancelGroupRename();
          }} />
        <small>Enter 或点击外部保存 · Esc 取消</small>
      </div>
    </div>}

    {annotationMode && <div className="annotation-toolbar no-drag">
      <span className="annotation-badge">Q 标注</span>
      <Button active={annotationTool === 'pen'} title="画笔 (1)" onClick={() => setAnnotationTool('pen')}>画笔</Button>
      <Button active={annotationTool === 'arrow'} title="箭头 (2)" onClick={() => setAnnotationTool('arrow')}>箭头</Button>
      <Button active={annotationTool === 'rectangle'} title="矩形 (3)" onClick={() => setAnnotationTool('rectangle')}>矩形</Button>
      <Button active={annotationTool === 'ellipse'} title="椭圆 (4)" onClick={() => setAnnotationTool('ellipse')}>椭圆</Button>
      <Button active={annotationTool === 'eraser'} title="橡皮擦 (E)" onClick={() => setAnnotationTool('eraser')}>橡皮</Button>
      <span className="annotation-separator" />
      <label title="标注颜色"><input type="color" value={annotationColor} onChange={(event) => setAnnotationColor(event.target.value)} /></label>
      <label className="annotation-width" title="笔画粗细"><input type="range" min="1" max="24" value={annotationWidth} onChange={(event) => setAnnotationWidth(Number(event.target.value))} /><output>{annotationWidth}</output></label>
      <Button title="撤销最后一次标注 (Ctrl+Z)" onClick={history.undo} disabled={!history.canUndo}>撤销</Button>
      <Button title="清除全部标注" onClick={clearAnnotations} disabled={!history.scene.annotations.length}>清除</Button>
      <button className="annotation-close" title="退出标注 (Q / Esc)" onClick={toggleAnnotationMode}>×</button>
    </div>}

    {!hasContent && <div className="empty-state no-drag">
      <div className="empty-icon">＋</div>
      <h1>建立你的参考画板</h1>
      <p>拖入图片、粘贴截图，或从电脑中选择图片。</p>
      <Button onClick={importImages}>选择图片</Button>
      <small>右键菜单/拖动窗口 · {colorPickerShortcut === 's' ? 'S+左键取色 · Alt+左键或中键平移' : 'Alt+左键取色 · 中键平移'} · 空格聚焦</small>
    </div>}

    {prewarmProgress && <div className="import-progress no-drag" role="status">
      <strong>{prewarmProgress.stage === 'mip' ? '正在生成图片金字塔' : prewarmProgress.stage === 'commit'
        ? '正在校验并提交缓存' : '正在导入图片'}</strong>
      <span>{prewarmProgress.stageCompleted ?? prewarmProgress.completed} / {prewarmProgress.stageTotal ?? prewarmProgress.total}</span>
      <div className="import-progress-track"><i style={{ width: `${prewarmProgress.fraction !== undefined
        ? prewarmProgress.fraction * 100 : (prewarmProgress.stageTotal ?? prewarmProgress.total)
          ? (prewarmProgress.stageCompleted ?? prewarmProgress.completed) / (prewarmProgress.stageTotal ?? prewarmProgress.total) * 100 : 0}%` }} /></div>
      {Boolean((prewarmProgress.failed ?? 0) + (prewarmProgress.detailFailed ?? 0))
        && <small title={prewarmProgress.lastFailedName}>{(prewarmProgress.failed ?? 0) + (prewarmProgress.detailFailed ?? 0)} 张已跳过</small>}
      <button title="取消导入" onClick={() => api?.cancelPrewarmImages(prewarmProgress.requestId)}>取消</button>
    </div>}
    {(operation || status) && <div className="status-toast no-drag" role={operation?.status === 'error' ? 'alert' : 'status'}>{operation?.message ?? status}</div>}
  </main>;
}
