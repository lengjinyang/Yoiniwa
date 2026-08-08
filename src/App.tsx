import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { CanvasView } from './canvas/CanvasView';
import { AutosaveCoordinator } from './canvas/persistence/AutosaveCoordinator';
import { loadProjectScene } from './canvas/persistence/ProjectLoader';
import { serializeProjectScene } from './canvas/persistence/ProjectSerializer';
import { ContextMenu, type ContextMenuEntry, type MenuPosition } from './ContextMenu';
import { renderItems } from './exportScene';
import { applyLayout, type LayoutAction } from './layout';
import { matchesColorPickerShortcut, MAX_ZOOM, MIN_ZOOM, type ColorPickerShortcut } from './interactions';
import { arrangeImportedItems } from './importPlacement';
import { imageSource, preloadImagePreview } from './imageResources';
import { groupOrDescendantMatches, outlineObjectMatches, type OutlineFilter } from './outline';
import { startOperation, settleOperation, clearOperation, type OperationKind, type OperationState } from './operationState';
import { addMemberToGroup, createGroupFrame, createScene, detachImageFromGroup, fitAutoGroupsToContents, fitGroupToContents, groupVisibleBounds, itemBounds, memberBounds, moveGroupWithContents, reconcileAllMemberships, reconcileMemberBounds, reorderImages, resetImageTransform, resetNonDestructiveCrop, sceneBounds, validateScene } from './scene';
import type { GroupFrameBounds } from './canvas/selection/GroupResizeController';
import { captureSceneSelection, pasteScenePayload, type SceneClipboardPayload } from './sceneClipboard';
import { mergeSceneInto } from './sceneMerge';
import type { CacheInfo, EraserSize, GroupMember, ImageGroup, ImageItem, ImagePrewarmProgress, ImportedImage, PickedColor, PhotoshopProjectMetadata, PhotoshopVersionRecord, RecentScene, Scene, VisualNotesState, VisualNoteTool, VisualNoteWidth, WindowState } from './types';
import { useSceneHistory } from './useSceneHistory';
import { performanceMonitor } from './performanceMonitor';
import { applyImageChanges, deleteSceneSelection, layoutSceneImages, moveImageLayer } from './domain/sceneCommands';
import { Button, formatBytes, OutlineThumbnail } from './app/components/CommonControls';
import { UiIcon, type UiIconName } from './app/components/UiIcon';
import { PhotoshopVersionComparePanel, type ComparisonMode, type ComparisonPreviewState } from './app/components/PhotoshopVersionComparePanel';
import { appCommand, createAppCommandRegistry } from './app/AppCommand';
import { ColorControl, type ColorControlHandle } from './ColorControl';
import './styles.css';
import './styles/quiet-tokens.css';
import './styles/quiet-controls.css';
import './styles/quiet-surfaces.css';
import type { VisualNotesToolState } from './canvas/interaction/VisualNotesController';
import type { LassoPoint } from './canvas/selection/SelectionController';
import { shouldAutoPhotoshopRoundTrip } from './shared/photoshopIntegration';
import { EMPTY_PHOTOSHOP_PROJECT_METADATA } from './shared/photoshopVersions';
import { DEFAULT_SHORTCUTS, loadShortcutPreferences, SHORTCUT_LABELS, shortcutConflict, shortcutFromKeyboardEvent, shortcutMatchesEvent, SHORTCUT_PREFERENCES_STORAGE_KEY, type ShortcutId, type ShortcutPreferences } from './keyboardShortcuts';

const initialWindowState: WindowState = { alwaysOnTop: false, clickThrough: false, locked: false, collaborationMode: false, opacity: 1 };
const COLOR_PICKER_SHORTCUT_STORAGE_KEY = 'refcanvas.colorPickerShortcut';
const VISUAL_NOTE_TOOL_OPTIONS: ReadonlyArray<{ tool: VisualNoteTool; label: string; shortcut: string; icon: UiIconName }> = [
  { tool: 'brush', label: '画笔', shortcut: '1 / B', icon: 'pen' },
  { tool: 'arrow', label: '箭头', shortcut: '2', icon: 'note-arrow' },
  { tool: 'eraser', label: '橡皮擦', shortcut: '3 / E', icon: 'eraser' },
];
const VISUAL_NOTE_COLOR_OPTIONS = [
  ['#d5d8dc', '白色'], ['#c97c80', '暖红'], ['#c6a15b', '暖黄'],
  ['#78a089', '青绿'], ['#7595b8', '冷蓝'], ['#9383ae', '灰紫'],
] as const;
const PHOTOSHOP_VERSION_PREVIEW_MIME = 'application/x-yoiniwa-photoshop-version';

interface ComparisonPreview {
  url?: string;
  state: ComparisonPreviewState;
  error?: string;
  capturedAt?: string;
  documentName?: string;
}

async function renderProjectPreview(scene: Scene): Promise<ArrayBuffer | undefined> {
  try {
    return await renderItems(
      scene.items, scene.canvas.background, scene.groups, scene.canvas.backgroundOpacity ?? 1,
      scene.visualNotes, { margin: 20, maxSide: 512 },
    );
  } catch {
    // A preview must never prevent the project itself from being saved.
    return undefined;
  }
}

export default function App() {
  performanceMonitor.markReactRender();
  const history = useSceneHistory();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [lassoPoints, setLassoPoints] = useState<LassoPoint[]>();
  const [lassoClearRequest, setLassoClearRequest] = useState(0);
  const [selectedGroupId, setSelectedGroupId] = useState<string>();
  const [renamingGroupId, setRenamingGroupId] = useState<string>();
  const [renameDraft, setRenameDraft] = useState('');
  const [windowMode, setWindowMode] = useState(initialWindowState);
  const [drawingCollaborationMode, setDrawingCollaborationMode] = useState(false);
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
  const [photoshopVersionsOpen, setPhotoshopVersionsOpen] = useState(false);
  const [photoshopMetadata, setPhotoshopMetadata] = useState<PhotoshopProjectMetadata>(EMPTY_PHOTOSHOP_PROJECT_METADATA);
  const photoshopMetadataRef = useRef(photoshopMetadata);
  const projectSessionIdRef = useRef<string | undefined>(undefined);
  photoshopMetadataRef.current = photoshopMetadata;
  const [versionSaveDialogOpen, setVersionSaveDialogOpen] = useState(false);
  const [versionName, setVersionName] = useState('');
  const [versionNote, setVersionNote] = useState('');
  const [comparisonVersionId, setComparisonVersionId] = useState<string>();
  const [comparisonMode, setComparisonMode] = useState<ComparisonMode>('ab');
  const [comparisonSplit, setComparisonSplit] = useState(50);
  const [comparisonOpacity, setComparisonOpacity] = useState(50);
  const [comparisonPreview, setComparisonPreview] = useState<ComparisonPreview>({ state: 'loading' });
  const comparisonPreviewUrlRef = useRef<string>();
  const comparisonPreviewRequestRef = useRef(0);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [outlineQuery, setOutlineQuery] = useState('');
  const [visualNotesEnabled, setVisualNotesEnabled] = useState(false);
  const [visualNoteTool, setVisualNoteTool] = useState<VisualNoteTool>('brush');
  const [visualNoteColor, setVisualNoteColor] = useState('#c6a15b');
  const [visualNoteOpacity, setVisualNoteOpacity] = useState(0.82);
  const [visualNoteWidth, setVisualNoteWidth] = useState<VisualNoteWidth>('medium');
  const [visualNotePressure, setVisualNotePressure] = useState(true);
  const [eraserSize, setEraserSize] = useState<EraserSize>('medium');
  const [visualNotesTemporaryHidden, setVisualNotesTemporaryHidden] = useState(false);
  const [selectedVisualMarkId, setSelectedVisualMarkId] = useState<string>();
  const [outlineCollapsedIds, setOutlineCollapsedIds] = useState<Set<string>>(() => new Set());
  const [sceneNameVisible, setSceneNameVisible] = useState(false);
  const sceneNameVisibleRef = useRef(false);
  const [contextMenu, setContextMenu] = useState<MenuPosition>();
  const [groupActionMenu, setGroupActionMenu] = useState<{ id: string; position: MenuPosition }>();
  const [colorPickerHeld, setColorPickerHeld] = useState(false);
  const [groupColorEditor, setGroupColorEditor] = useState<{ id: string; anchor: { x: number; y: number } }>();
  const groupColorEditorRef = useRef<ColorControlHandle>(null);
  const groupColorEditorIdRef = useRef<string | undefined>(undefined);
  const [colorPickerShortcut, setColorPickerShortcut] = useState<ColorPickerShortcut>(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.has('smoke') || query.has('stress')) return 's';
    try { return localStorage.getItem(COLOR_PICKER_SHORTCUT_STORAGE_KEY) === 'alt' ? 'alt' : 's'; }
    catch { return 's'; }
  });
  const [shortcuts, setShortcuts] = useState<ShortcutPreferences>(() => {
    try { return loadShortcutPreferences(localStorage.getItem(SHORTCUT_PREFERENCES_STORAGE_KEY)); }
    catch { return { ...DEFAULT_SHORTCUTS }; }
  });
  const [shortcutCaptureId, setShortcutCaptureId] = useState<ShortcutId>();
  const [focusReturn, setFocusReturn] = useState<typeof history.scene.viewport>();
  const renameComposingRef = useRef(false);
  const colorSyncRequestRef = useRef(0);
  const sceneClipboardRef = useRef<SceneClipboardPayload | undefined>(undefined);
  const drawingModeSnapshotRef = useRef<{ locked: boolean; alwaysOnTop: boolean } | undefined>(undefined);
  const lastPointerRef = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const api = window.refCanvas;
  const autoPhotoshopRoundTrip = shouldAutoPhotoshopRoundTrip(windowMode);
  const photoshopDocumentBlocked = drawingCollaborationMode || (windowMode.locked && windowMode.alwaysOnTop);
  const activeColorPickerShortcut: ColorPickerShortcut = windowMode.locked ? 'alt' : colorPickerShortcut;
  const revokeComparisonPreview = useCallback(() => {
    const url = comparisonPreviewUrlRef.current;
    comparisonPreviewUrlRef.current = undefined;
    if (url) URL.revokeObjectURL(url);
  }, []);
  const resetComparisonPreview = useCallback(() => {
    comparisonPreviewRequestRef.current += 1;
    revokeComparisonPreview();
    setComparisonPreview({ state: 'loading' });
  }, [revokeComparisonPreview]);
  const closeVersionComparison = useCallback(() => {
    resetComparisonPreview();
    setComparisonVersionId(undefined);
  }, [resetComparisonPreview]);
  const captureComparisonPreview = useCallback(async () => {
    const request = ++comparisonPreviewRequestRef.current;
    setComparisonPreview((current) => ({ ...current, state: 'loading', error: undefined }));
    try {
      const result = await api?.capturePhotoshopPreview();
      if (!result?.ok || !result.preview) throw new Error(result?.message ?? '无法捕获 Photoshop 当前文档预览');
      const url = URL.createObjectURL(new Blob([result.preview], { type: 'image/png' }));
      if (request !== comparisonPreviewRequestRef.current) {
        URL.revokeObjectURL(url);
        return;
      }
      revokeComparisonPreview();
      comparisonPreviewUrlRef.current = url;
      setComparisonPreview({ url, state: 'ready', capturedAt: new Date().toISOString(), documentName: result.documentName });
    } catch (error) {
      if (request !== comparisonPreviewRequestRef.current) return;
      setComparisonPreview((current) => ({ ...current, state: 'error', error: String(error) }));
    }
  }, [api, revokeComparisonPreview]);
  const refreshComparisonPreview = useCallback(() => {
    if (!comparisonVersionId) return;
    void captureComparisonPreview();
  }, [captureComparisonPreview, comparisonVersionId]);
  const openVersionComparison = useCallback((version: PhotoshopVersionRecord) => {
    if (photoshopDocumentBlocked) return;
    resetComparisonPreview();
    setComparisonVersionId(version.id);
    setComparisonMode('ab');
    setComparisonSplit(50);
    setComparisonOpacity(50);
    setPhotoshopVersionsOpen(false);
    void captureComparisonPreview();
  }, [captureComparisonPreview, photoshopDocumentBlocked, resetComparisonPreview]);
  const comparisonVersions = useMemo(() => [...photoshopMetadata.versions].reverse(), [photoshopMetadata.versions]);
  const comparisonVersion = comparisonVersionId
    ? photoshopMetadata.versions.find((version) => version.id === comparisonVersionId) : undefined;
  useEffect(() => () => {
    comparisonPreviewRequestRef.current += 1;
    revokeComparisonPreview();
  }, [revokeComparisonPreview]);
  useEffect(() => {
    if (comparisonVersionId && !comparisonVersion) closeVersionComparison();
  }, [closeVersionComparison, comparisonVersion, comparisonVersionId]);
  useEffect(() => {
    if (drawingCollaborationMode && comparisonVersionId) closeVersionComparison();
  }, [closeVersionComparison, comparisonVersionId, drawingCollaborationMode]);
  const autosaveExecuteRef = useRef<(scene: typeof history.scene, revision: number) => Promise<void>>(async () => undefined);
  const autosaveCoordinatorRef = useRef<AutosaveCoordinator | undefined>(undefined);
  if (!autosaveCoordinatorRef.current) {
    autosaveCoordinatorRef.current = new AutosaveCoordinator((scene, revision) => autosaveExecuteRef.current(scene, revision));
  }
  autosaveExecuteRef.current = async (scene, revision) => {
    const preview = await renderProjectPreview(scene);
    const result = await api?.commitProject({
      sessionId: projectSessionIdRef.current,
      scene: serializeProjectScene(scene),
      photoshopProject: photoshopMetadataRef.current,
      rendererRevision: revision,
      preview,
      reason: 'autosave',
    });
    if (result?.scene) {
      if (result.sessionId) projectSessionIdRef.current = result.sessionId;
      history.markSaved(result.scene, result.committedRevision ?? revision);
    }
  };
  const performanceSceneRef = useRef(history.scene);
  const liveViewportRef = useRef(history.scene.viewport);
  performanceSceneRef.current = history.scene;
  useEffect(() => { liveViewportRef.current = history.scene.viewport; }, [history.scene.viewport]);
  useEffect(() => {
    setSelectedVisualMarkId(undefined);
    setVisualNotesTemporaryHidden(false);
  }, [history.projectEpoch]);
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
      history.scene.groups,
      history.scene.canvas.backgroundOpacity ?? 1,
      visualNotesTemporaryHidden ? { ...history.scene.visualNotes, visible: false } : history.scene.visualNotes,
    );
    return () => { delete smokeWindow.__refCanvasSmokeExport; };
  }, [history.scene, visualNotesTemporaryHidden]);

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
      clearSelection: () => { setSelectedIds([]); setSelectedGroupId(undefined); },
      loadScene: (scene) => history.load(scene),
    };
    return () => { delete perfWindow.__refCanvasPerf; };
  }, [history.commit, history.load]);

  useEffect(() => {
    try { localStorage.setItem(COLOR_PICKER_SHORTCUT_STORAGE_KEY, colorPickerShortcut); } catch { /* Persistence is optional. */ }
    setColorPickerHeld(false);
  }, [colorPickerShortcut]);

  useEffect(() => {
    try { localStorage.setItem(SHORTCUT_PREFERENCES_STORAGE_KEY, JSON.stringify(shortcuts)); } catch { /* Persistence is optional. */ }
  }, [shortcuts]);

  const syncPickedColor = useCallback(async (color: PickedColor) => {
    const request = ++colorSyncRequestRef.current;
    if (!api) {
      setStatus(`无法连接桌面取色服务 ${color.hex}`);
      return;
    }
    const result = await api.syncPhotoshopForeground(color, autoPhotoshopRoundTrip);
    if (request !== colorSyncRequestRef.current) return;
    if (!result.ok) {
      setStatus(`${result.message ?? 'Photoshop 同步失败'} · ${color.hex}`);
      return;
    }
    if (drawingCollaborationMode) return;
    setStatus(result.focusStatus === 'automation-error' || result.focusStatus === 'not-found'
      ? `已同步 Photoshop 前景色，但未能自动返回窗口 · ${color.hex}`
      : `已同步 Photoshop 前景色 ${color.hex}`);
  }, [api, autoPhotoshopRoundTrip, drawingCollaborationMode]);

  const selectedItems = useMemo(() => selectedIds.flatMap((id) => {
    const item = history.scene.items.find((value) => value.id === id);
    return item ? [item] : [];
  }), [history.scene.items, selectedIds]);
  const selectedGroup = selectedGroupId ? history.scene.groups.find((group) => group.id === selectedGroupId) : undefined;

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
    return history.scene.items.filter((item) => !item.locked).map((item) => item.id);
  }, [history.scene.groups, history.scene.items, selectedGroup, selectedIds]);
  const primary = selectedItems[0];
  const visualNotesToolState = useMemo<VisualNotesToolState>(() => ({
    enabled: visualNotesEnabled,
    tool: visualNoteTool,
    color: visualNoteColor,
    opacity: visualNoteOpacity,
    width: visualNoteWidth,
    pressureEnabled: visualNotePressure,
    eraserSize,
    selectedMarkId: selectedVisualMarkId,
  }), [eraserSize, selectedVisualMarkId, visualNoteColor, visualNoteOpacity, visualNotePressure, visualNoteTool, visualNoteWidth, visualNotesEnabled]);

  useEffect(() => {
    if (!visualNotesEnabled) return undefined;
    const closeVisualNoteFolds = (event: PointerEvent) => {
      document.querySelectorAll<HTMLDetailsElement>('.visual-note-fold[open]').forEach((details) => {
        if (!details.contains(event.target as Node)) details.removeAttribute('open');
      });
    };
    window.addEventListener('pointerdown', closeVisualNoteFolds, true);
    return () => window.removeEventListener('pointerdown', closeVisualNoteFolds, true);
  }, [visualNotesEnabled]);

  const updateSelectedVisualMarkStyle = useCallback((patch: { color?: string; opacity?: number; width?: VisualNoteWidth }) => {
    if (!selectedVisualMarkId) return;
    history.commit((scene) => {
      const mark = scene.visualNotes.marks.find((value) => value.id === selectedVisualMarkId);
      if (!mark) return;
      Object.assign(mark.style, patch);
      if (patch.width) mark.style.baseWidth = ({ thin: 1.6, medium: 3.2, thick: 6 } as const)[patch.width]
        / Math.max(0.001, scene.viewport.scale);
    });
  }, [history, selectedVisualMarkId]);

  const deleteSelectedVisualMark = useCallback(() => {
    if (!selectedVisualMarkId) return false;
    history.commit((scene) => {
      scene.visualNotes.marks = scene.visualNotes.marks.filter((mark) => mark.id !== selectedVisualMarkId);
      scene.groups.forEach((group) => { group.members = group.members.filter((member) => member.type !== 'mark' || member.id !== selectedVisualMarkId); });
    });
    setSelectedVisualMarkId(undefined);
    return true;
  }, [history, selectedVisualMarkId]);


  const commitVisualNotes = useCallback((notes: VisualNotesState) => {
    history.commit((scene) => {
      scene.visualNotes = structuredClone(notes);
      const markIds = new Set(notes.marks.map((mark) => mark.id));
      scene.groups.forEach((group) => { group.members = group.members.filter((member) => member.type !== 'mark' || markIds.has(member.id)); });
      notes.marks.filter((mark) => mark.anchor.type === 'scene').forEach((mark) => {
        const bounds = memberBounds(scene, { type: 'mark', id: mark.id });
        if (bounds) reconcileMemberBounds(scene, { type: 'mark', id: mark.id }, bounds);
      });
    });
  }, [history]);

  const layoutTargetCount = targetIds.length;
  const hasContent = history.scene.items.length > 0 || history.scene.groups.length > 0;

  const setMode = useCallback(async (patch: Partial<WindowState>, force = false) => {
    if (!api) return;
    const protectedPatch = !force && drawingCollaborationMode && ('locked' in patch || 'alwaysOnTop' in patch || 'collaborationMode' in patch)
      ? { ...patch, locked: true, alwaysOnTop: true, collaborationMode: true }
      : patch;
    const next = await api.setWindowMode(protectedPatch);
    setWindowMode(next);
    if (next.locked) {
      setSelectedIds([]);
      setSelectedGroupId(undefined);
      setSelectedVisualMarkId(undefined);
      setContextMenu(undefined);
      setGroupActionMenu(undefined);
      setStatus(shouldAutoPhotoshopRoundTrip(next)
        ? '无感取色已启用 · Photoshop 保持前台，Alt + 笔尖直接取色'
        : '参考模式已锁定 · 同时开启始终置顶后可启用 Photoshop 无焦点取色');
    } else if (patch.locked === false) {
      setStatus('画板已解锁');
    }
    return next;
  }, [api, drawingCollaborationMode]);

  const toggleDrawingCollaborationMode = useCallback(async () => {
    if (!api) return;
    if (drawingCollaborationMode) {
      const snapshot = drawingModeSnapshotRef.current;
      drawingModeSnapshotRef.current = undefined;
      try {
        const next = await setMode({ ...(snapshot ?? { locked: false, alwaysOnTop: false }), collaborationMode: false }, true);
        if (next?.collaborationMode) throw new Error('窗口层级仍在恢复中');
        setDrawingCollaborationMode(false);
        setStatus('已退出协作模式，窗口状态已恢复');
      } catch (error) {
        drawingModeSnapshotRef.current = snapshot;
        setStatus(`退出协作模式失败：${String(error)}`);
      }
      return;
    }
    const snapshot = { locked: windowMode.locked, alwaysOnTop: windowMode.alwaysOnTop };
    try {
      const next = await setMode({ locked: true, alwaysOnTop: true, collaborationMode: true }, true);
      if (!next?.collaborationMode) throw new Error('未能确认任务栏后方的稳定协作窗口层级');
      drawingModeSnapshotRef.current = snapshot;
      setDrawingCollaborationMode(true);
      setStatus(`协作模式已启用 · Space + 主按钮拖动可平移画布 · ${shortcuts.collaboration} 退出`);
    } catch (error) {
      drawingModeSnapshotRef.current = undefined;
      setStatus(`启用协作模式失败：${String(error)}`);
    }
  }, [api, drawingCollaborationMode, setMode, shortcuts.collaboration, windowMode.alwaysOnTop, windowMode.locked]);

  useEffect(() => {
    if (!api) return;
    void api.getWindowMode().then(setWindowMode).catch((error) => setStatus(`读取窗口状态失败：${String(error)}`));
    void api.getCollaborationShortcut().then(({ shortcut }) => setShortcuts((current) => ({ ...current, collaboration: shortcut })))
      .catch((error) => setStatus(`读取协作快捷键失败：${String(error)}`));
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

  useEffect(() => {
    if (!api) return undefined;
    return api.onToggleCollaborationRequested(() => { void toggleDrawingCollaborationMode(); });
  }, [api, toggleDrawingCollaborationMode]);

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
    const rememberPointer = (event: MouseEvent) => {
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
      const visible = event.clientY <= 40;
      if (visible === sceneNameVisibleRef.current) return;
      sceneNameVisibleRef.current = visible;
      setSceneNameVisible(visible);
    };
    const hideSceneName = () => {
      if (!sceneNameVisibleRef.current) return;
      sceneNameVisibleRef.current = false;
      setSceneNameVisible(false);
    };
    window.addEventListener('mousemove', rememberPointer);
    window.addEventListener('mousedown', rememberPointer);
    window.addEventListener('mouseleave', hideSceneName);
    return () => {
      window.removeEventListener('mousemove', rememberPointer);
      window.removeEventListener('mousedown', rememberPointer);
      window.removeEventListener('mouseleave', hideSceneName);
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
      const preview = await renderProjectPreview(flushed.scene);
      const request = {
        sessionId: projectSessionIdRef.current,
        scene: serializeProjectScene(flushed.scene),
        photoshopProject: photoshopMetadataRef.current,
        rendererRevision: saveRevision,
        preview,
        reason: 'explicit' as const,
      };
      const result = saveAs || !projectSessionIdRef.current
        ? await api.saveProjectAs(request)
        : await api.commitProject(request);
      if (!result.canceled) {
        if (result.sessionId) projectSessionIdRef.current = result.sessionId;
        const savedCurrentRevision = result.scene
          ? history.markSaved(result.scene, result.committedRevision ?? saveRevision) : false;
        if (result.metadata) setPhotoshopMetadata(result.metadata);
        const upgrade = result.upgraded === 'legacy-yoi' ? '（旧 .yoi 已升级并保留 legacy 备份）'
          : result.upgraded === 'refcanvas' ? '（已从 .refcanvas 升级，旧文件保留）' : '';
        settleCurrentOperation(requestId, 'success', `已保存至 ${result.path}${upgrade}`);
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
    closeVersionComparison();
    const requestId = beginOperation('open', '正在打开画板…');
    try {
      const result = await api.openProject(path);
      const loaded = loadProjectScene(result.scene);
      if (!result.canceled && validateScene(loaded)) {
        history.load(loaded);
        projectSessionIdRef.current = result.sessionId;
        setPhotoshopMetadata(result.metadata ?? EMPTY_PHOTOSHOP_PROJECT_METADATA);
        setSelectedIds([]);
        setSelectedGroupId(undefined);
        const recovery = result.recovered ? `（已从 ${result.recoverySource ?? '最后一个完整提交'} 恢复）` : '';
        const readOnly = result.readOnly ? '（只读；保存时请使用另存为）' : '';
        settleCurrentOperation(requestId, 'success', `已打开 ${result.path}${recovery}${readOnly}`);
        api.recentScenes().then(setRecent).catch((error) => setStatus(`刷新最近画板失败：${String(error)}`));
      } else if (!result.canceled) settleCurrentOperation(requestId, 'error', '无法打开：不是有效的 Yoiniwa 画板');
      else clearCurrentOperation(requestId);
    } catch (error) { settleCurrentOperation(requestId, 'error', `打开失败：${String(error)}`); }
  }, [api, beginOperation, clearCurrentOperation, closeVersionComparison, history, settleCurrentOperation]);

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
        settleCurrentOperation(requestId, 'error', '无法导入：不是有效的 Yoiniwa 画板');
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
      setSelectedGroupId(merged?.rootGroupIds[0]);
      const count = (merged?.imageIds.length ?? 0) + (merged?.groupIds.length ?? 0);
      settleCurrentOperation(requestId, 'success', `已导入 ${count} 个对象`);
    } catch (error) {
      settleCurrentOperation(requestId, 'error', `导入画板失败：${String(error)}`);
    }
  }, [api, beginOperation, clearCurrentOperation, history, settleCurrentOperation]);

  const newScene = useCallback(() => {
    if (history.dirty && !window.confirm('当前更改尚未保存，仍要新建画板吗？')) return;
    closeVersionComparison();
    void api?.closeProject(projectSessionIdRef.current);
    projectSessionIdRef.current = undefined;
    history.load(createScene());
    setPhotoshopMetadata(EMPTY_PHOTOSHOP_PROJECT_METADATA);
    setSelectedIds([]);
    setSelectedGroupId(undefined);
    setStatus('已新建画板');
  }, [api, closeVersionComparison, history]);

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

  const deleteSelected = useCallback(() => {
    if (!selectedIds.length) return;
    history.commit((scene) => deleteSceneSelection(scene, selectedIds));
    setSelectedIds([]);
  }, [history, selectedIds]);

  const duplicate = useCallback(() => {
    const payload = captureSceneSelection(history.scene, selectedIds, selectedGroupId);
    if (!payload) return;
    const next = structuredClone(history.scene);
    const result = pasteScenePayload(next, payload, 30);
    history.commit((scene) => {
      scene.items = next.items; scene.groups = next.groups; scene.visualNotes = next.visualNotes;
    });
    setSelectedIds(result?.rootGroupId ? [] : result?.imageIds ?? []);
    setSelectedGroupId(result?.rootGroupId);
  }, [history, selectedGroupId, selectedIds]);

  const createGroup = useCallback(() => {
    const members: GroupMember[] = selectedIds.map((id) => ({ type: 'image' as const, id }));
    if (members.length < 2) { setStatus('请先框选至少两个对象'); return; }
    const name = `组 ${history.scene.groups.length + 1}`;
    const id = crypto.randomUUID();
    history.commit((scene) => { createGroupFrame(scene, members, name, id); });
    setSelectedIds([]);
    setSelectedGroupId(id);
    setStatus(`已创建分组框“${name}”`);
  }, [history, selectedIds]);


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

  const detachImages = useCallback((imageIds: readonly string[], groupId?: string) => {
    const selected = new Set(imageIds);
    const targets = history.scene.groups.flatMap((group) => group.members
      .filter((member) => member.type === 'image' && selected.has(member.id) && (!groupId || group.id === groupId))
      .map((member) => ({ groupId: group.id, imageId: member.id })));
    if (!targets.length) {
      setStatus('选中的图片不在组内');
      return;
    }
    history.commit((scene) => {
      targets.forEach((target) => { detachImageFromGroup(scene, target.groupId, target.imageId); });
    });
    setStatus(`已将 ${targets.length} 张图片移出组，图片位置保持不变`);
  }, [history]);

  const detachSelectedImages = useCallback(() => detachImages(selectedIds), [detachImages, selectedIds]);

  const addImagesToGroup = useCallback((imageIds: readonly string[], groupId: string) => {
    const existingIds = new Set(history.scene.items.map((item) => item.id));
    const target = history.scene.groups.find((group) => group.id === groupId);
    const targets = [...new Set(imageIds)].filter((id) => existingIds.has(id)
      && !target?.members.some((member) => member.type === 'image' && member.id === id));
    if (!target || !targets.length) {
      setStatus(target ? '选中的图片已经在该组中' : '目标组不存在');
      return;
    }
    history.commit((scene) => {
      const group = scene.groups.find((value) => value.id === groupId);
      if (!group) return;
      targets.forEach((imageId) => {
        // Mark the former relationship as explicitly detached before assigning
        // the new one, otherwise geometry reconciliation could claim it back.
        const former = scene.groups.find((value) => value.members.some((member) =>
          member.type === 'image' && member.id === imageId));
        if (former && former.id !== group.id) detachImageFromGroup(scene, former.id, imageId);
        addMemberToGroup(scene, group, { type: 'image', id: imageId });
      });
      fitAutoGroupsToContents(scene);
    });
    setStatus(`已将 ${targets.length} 张图片加入“${target.name}”，图片位置保持不变`);
  }, [history]);

  const changeGroup = useCallback((groupId: string, patch: Partial<ImageGroup>) => {
    history.commit((scene) => {
      const group = scene.groups.find((value) => value.id === groupId);
      if (group) {
        Object.assign(group, patch);
        if (patch.x !== undefined || patch.y !== undefined || patch.width !== undefined || patch.height !== undefined) reconcileAllMemberships(scene);
      }
    });
  }, [history]);

  const openGroupActions = useCallback((groupId: string, position: { x: number; y: number }) => {
    const group = history.scene.groups.find((value) => value.id === groupId);
    if (!group) return;
    setSelectedGroupId(groupId);
    setContextMenu(undefined);
    // Keep the popup just outside the group's right edge so it never covers
    // images inside the frame while remaining visually tied to the trigger.
    setGroupActionMenu({ id: groupId, position: { x: position.x + 6, y: position.y } });
  }, [history.scene.groups]);

  useEffect(() => {
    groupColorEditorIdRef.current = groupColorEditor?.id;
  }, [groupColorEditor]);

  useEffect(() => {
    if (groupColorEditor && selectedGroupId !== groupColorEditor.id) setGroupColorEditor(undefined);
  }, [groupColorEditor, selectedGroupId]);

  const moveGroupColorEditor = useCallback((groupId: string, position: { x: number; y: number }) => {
    if (groupColorEditorIdRef.current === groupId) groupColorEditorRef.current?.setAnchor(position);
  }, []);

  const moveGroup = useCallback((groupId: string, deltaX: number, deltaY: number) => {
    if (Math.abs(deltaX) < 0.01 && Math.abs(deltaY) < 0.01) return;
    history.commit((scene) => {
      moveGroupWithContents(scene, groupId, deltaX, deltaY);
      const bounds = memberBounds(scene, { type: 'group', id: groupId });
      if (bounds) reconcileMemberBounds(scene, { type: 'group', id: groupId }, bounds);
    });
  }, [history]);

  const resizeGroup = useCallback((groupId: string, bounds: GroupFrameBounds) => {
    const current = history.scene.groups.find((group) => group.id === groupId);
    if (!current || current.sizeLocked || current.collapsed
      || (current.x === bounds.x && current.y === bounds.y
        && current.width === bounds.width && current.height === bounds.height)) return;
    history.commit((scene) => {
      const group = scene.groups.find((value) => value.id === groupId);
      if (!group || group.sizeLocked || group.collapsed) return;
      Object.assign(group, bounds, { autoFit: false });
      reconcileAllMemberships(scene);
    });
  }, [history]);

  const deleteGroupById = useCallback((groupId: string, withContents: boolean) => {
    history.commit((scene) => {
      const remove = (groupId: string) => {
        const group = scene.groups.find((value) => value.id === groupId);
        if (!group) return;
        if (withContents) {
          const imageIds = new Set(group.members.filter((member) => member.type === 'image').map((member) => member.id));
          const markIds = new Set(group.members.filter((member) => member.type === 'mark').map((member) => member.id));
          group.members.filter((member) => member.type === 'group').forEach((member) => remove(member.id));
          deleteSceneSelection(scene, [...imageIds]);
          scene.visualNotes.marks = scene.visualNotes.marks.filter((mark) => !markIds.has(mark.id));
          scene.groups.forEach((value) => { value.members = value.members.filter((member) => member.type !== 'mark' || !markIds.has(member.id)); });
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
      fitAutoGroupsToContents(scene);
    });
    setSelectedGroupId(undefined);
    setGroupColorEditor((current) => current?.id === groupId ? undefined : current);
    setRenamingGroupId((current) => current === groupId ? undefined : current);
    setStatus(withContents ? '已删除分组框及其内容' : '已删除分组框，内部对象已保留');
  }, [history]);

  const deleteGroup = useCallback((withContents: boolean) => {
    if (selectedGroup) deleteGroupById(selectedGroup.id, withContents);
  }, [deleteGroupById, selectedGroup]);

  const copySelection = useCallback(() => {
    const payload = captureSceneSelection(history.scene, selectedIds, selectedGroupId);
    if (!payload) { setStatus('没有可复制的内容'); return false; }
    sceneClipboardRef.current = payload;
    setStatus(selectedGroupId ? '已复制分组框及其内容' : `已复制 ${payload.items.length} 项`);
    return true;
  }, [history.scene, selectedGroupId, selectedIds]);

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
    history.commit((scene) => { scene.items = next.items; scene.groups = next.groups; scene.visualNotes = next.visualNotes; });
    setSelectedIds(result?.rootGroupId ? [] : result?.imageIds ?? []);
    setSelectedGroupId(result?.rootGroupId);
    setStatus(result?.rootGroupId ? '已粘贴完整分组框' : '已粘贴内容');
  }, [history]);

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
      ...history.scene.groups.map(groupVisibleBounds),
    ];
    if (!bounds.length) return;
    const x = Math.min(...bounds.map((part) => part.x));
    const y = Math.min(...bounds.map((part) => part.y));
    const right = Math.max(...bounds.map((part) => part.x + part.width));
    const bottom = Math.max(...bounds.map((part) => part.y + part.height));
    fitBounds({ x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) });
  }, [fitBounds, history.scene.groups, history.scene.items]);

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
    if (windowMode.locked) return;
    const ordered = [...history.scene.items].sort((a, b) => a.zIndex - b.zIndex);
    if (!ordered.length) return;
    const currentIndex = Math.max(0, ordered.findIndex((item) => item.id === primary?.id));
    const next = ordered[(currentIndex + direction + ordered.length) % ordered.length];
    if (!focusReturn) setFocusReturn({ ...history.scene.viewport });
    setSelectedIds([next.id]);
    fitItems([next]);
  }, [fitItems, focusReturn, history.scene.items, history.scene.viewport, primary?.id, windowMode.locked]);

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

  useEffect(() => {
    const api = window.refCanvas;
    if (!api) return undefined;
    return api.onNativeZoom((direction) => zoomBy(direction === 'in' ? 1.15 : 1 / 1.15));
  }, [zoomBy]);

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
    if (!items.length) { setStatus('没有可导出的内容'); return; }
    const requestId = beginOperation('export', '正在渲染导出图片…');
    try {
      const selectedImageIds = new Set(items.map((item) => item.id));
      const notes = visualNotesTemporaryHidden ? { ...history.scene.visualNotes, visible: false } : {
        ...history.scene.visualNotes,
        marks: onlySelected ? history.scene.visualNotes.marks.filter((mark) => mark.anchor.type === 'image'
          && selectedImageIds.has(mark.anchor.imageId)) : history.scene.visualNotes.marks,
      };
      const imageData = await renderItems(items, history.scene.canvas.includeBackgroundOnExport ? history.scene.canvas.background : undefined,
        onlySelected ? [] : history.scene.groups, history.scene.canvas.backgroundOpacity ?? 1, notes);
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
  }, [api, beginOperation, clearCurrentOperation, history.scene, selectedItems, settleCurrentOperation, visualNotesTemporaryHidden]);

  const renderSelectedPhotoshopImage = useCallback(async () => {
    if (!selectedItems.length) throw new Error('请先选择要发送到 Photoshop 的图片');
    const selectedImageIds = new Set(selectedItems.map((item) => item.id));
    const pixelScale = Math.max(1, ...selectedItems.map((item) => Math.max(
      item.crop.width / Math.max(1, item.width),
      item.crop.height / Math.max(1, item.height),
    )));
    const notes = visualNotesTemporaryHidden ? { ...history.scene.visualNotes, visible: false } : {
      ...history.scene.visualNotes,
      marks: history.scene.visualNotes.marks.filter((mark) => mark.anchor.type === 'image'
        && selectedImageIds.has(mark.anchor.imageId)),
    };
    return renderItems(selectedItems, undefined, [], 1, notes, { margin: 0, maxSide: 30000, pixelScale });
  }, [history.scene.visualNotes, selectedItems, visualNotesTemporaryHidden]);

  const renderSelectedPhotoshopLayers = useCallback(async () => {
    if (!selectedItems.length) throw new Error('请先选择要发送到 Photoshop 的图片');
    const layerItems = [...selectedItems].sort((left, right) => left.zIndex - right.zIndex);
    return Promise.all(layerItems.map(async (item) => {
      const notes = visualNotesTemporaryHidden ? { ...history.scene.visualNotes, visible: false } : {
        ...history.scene.visualNotes,
        marks: history.scene.visualNotes.marks.filter((mark) => mark.anchor.type === 'image' && mark.anchor.imageId === item.id),
      };
      const pixelScale = Math.max(1,
        item.crop.width / Math.max(1, item.width), item.crop.height / Math.max(1, item.height));
      return {
        data: await renderItems([item], undefined, [], 1, notes, { margin: 0, maxSide: 30000, pixelScale }),
        name: item.name.replace(/\.[^.]+$/, '') || item.name,
      };
    }));
  }, [history.scene.visualNotes, selectedItems, visualNotesTemporaryHidden]);

  const renderLassoPhotoshopImage = useCallback(async () => {
    if (!selectedItems.length || !lassoPoints || lassoPoints.length < 3) {
      throw new Error('请先按住 D 绘制要发送的区域');
    }
    const selectedImageIds = new Set(selectedItems.map((item) => item.id));
    const pixelScale = Math.max(1, ...selectedItems.map((item) => Math.max(
      item.crop.width / Math.max(1, item.width),
      item.crop.height / Math.max(1, item.height),
    )));
    const notes = visualNotesTemporaryHidden ? { ...history.scene.visualNotes, visible: false } : {
      ...history.scene.visualNotes,
      marks: history.scene.visualNotes.marks.filter((mark) => mark.anchor.type === 'image'
        && selectedImageIds.has(mark.anchor.imageId)),
    };
    return renderItems(selectedItems, undefined, [], 1, notes, {
      margin: 0, maxSide: 30000, pixelScale, clipPolygon: lassoPoints,
    });
  }, [history.scene.visualNotes, lassoPoints, selectedItems, visualNotesTemporaryHidden]);

  const sendSelectedToPhotoshop = useCallback(async (mode: 'layer' | 'image') => {
    if (!api || photoshopDocumentBlocked) return;
    setLassoPoints(undefined);
    setLassoClearRequest((request) => request + 1);
    const requestId = beginOperation('photoshop', mode === 'layer' ? '正在发送图层到 Photoshop…' : '正在打开 Photoshop 图像…');
    try {
      const hasLasso = Boolean(lassoPoints && lassoPoints.length >= 3);
      const result = mode === 'layer'
        ? await api.placeRenderedLayersInPhotoshop(hasLasso
          ? [{ data: await renderLassoPhotoshopImage(), name: `${history.scene.name}-选区` }]
          : await renderSelectedPhotoshopLayers())
        : await api.openRenderedInPhotoshop(hasLasso ? await renderLassoPhotoshopImage() : await renderSelectedPhotoshopImage(), selectedItems.length === 1
          ? selectedItems[0].name.replace(/\.[^.]+$/, '') || selectedItems[0].name : `${history.scene.name}-选中`);
      if (result.ok) settleCurrentOperation(requestId, 'success', result.message ?? 'Photoshop 操作完成');
      else settleCurrentOperation(requestId, 'error', result.message ?? 'Photoshop 操作失败');
    } catch (error) { settleCurrentOperation(requestId, 'error', `发送到 Photoshop 失败：${String(error)}`); }
  }, [api, beginOperation, history.scene.name, lassoPoints, photoshopDocumentBlocked, renderLassoPhotoshopImage, renderSelectedPhotoshopImage, renderSelectedPhotoshopLayers, selectedItems, settleCurrentOperation]);

  const savePhotoshopVersion = useCallback(async () => {
    if (!api || photoshopDocumentBlocked) return;
    const name = versionName.trim();
    if (!name) { setStatus('请输入版本名称'); return; }
    const flushed = history.flushViewport(liveViewportRef.current);
    const requestId = beginOperation('photoshop', '正在保存 Photoshop 分层版本…');
    try {
      const preview = await renderProjectPreview(flushed.scene);
      const result = await api.createPhotoshopVersion(projectSessionIdRef.current, serializeProjectScene(flushed.scene), photoshopMetadataRef.current, name, versionNote, flushed.revision, preview);
      if (result.canceled) { clearCurrentOperation(requestId); return; }
      if (!result.version || !result.metadata) throw new Error(result.message ?? 'Photoshop 版本保存失败');
      if (result.sessionId) projectSessionIdRef.current = result.sessionId;
      if (result.scene) history.markSaved(result.scene, result.committedRevision ?? flushed.revision);
      setPhotoshopMetadata(result.metadata);
      setVersionSaveDialogOpen(false); setVersionName(''); setVersionNote('');
      settleCurrentOperation(requestId, 'success', `已保存 Photoshop 版本 ${result.version.name}`);
    } catch (error) { settleCurrentOperation(requestId, 'error', `保存 Photoshop 版本失败：${String(error)}`); }
  }, [api, beginOperation, clearCurrentOperation, history, photoshopDocumentBlocked, settleCurrentOperation, versionName, versionNote]);

  const openPhotoshopVersionSaveDialog = useCallback(async () => {
    if (!api || photoshopDocumentBlocked) return;
    const result = await api.getPhotoshopDocumentInfo();
    if (!result.ok || !result.documentName) {
      setStatus(result.message ?? '无法读取 Photoshop 当前文档名称');
      return;
    }
    setVersionName(result.documentName);
    setVersionNote('');
    setVersionSaveDialogOpen(true);
  }, [api, photoshopDocumentBlocked]);

  const openPhotoshopVersion = useCallback(async (version: PhotoshopVersionRecord) => {
    if (!api || photoshopDocumentBlocked) return;
    const result = await api.openPhotoshopVersion(projectSessionIdRef.current, version.id);
    setStatus(result.ok ? (result.message ?? `已打开 ${version.name}`) : (result.message ?? '无法打开 Photoshop 版本'));
  }, [api, photoshopDocumentBlocked]);

  const deletePhotoshopVersion = useCallback(async (version: PhotoshopVersionRecord) => {
    if (!api || photoshopDocumentBlocked || !window.confirm(`确定删除版本“${version.name}”？此操作会从 .yoi 中移除完整分层文件。`)) return;
    const flushed = history.flushViewport(liveViewportRef.current);
    const preview = await renderProjectPreview(flushed.scene);
    const result = await api.deletePhotoshopVersion(projectSessionIdRef.current, serializeProjectScene(flushed.scene), photoshopMetadataRef.current, version.id, flushed.revision, preview);
    if (result.metadata) setPhotoshopMetadata(result.metadata);
    if (result.sessionId) projectSessionIdRef.current = result.sessionId;
    if (result.scene) history.markSaved(result.scene, result.committedRevision ?? flushed.revision);
    setStatus(result.metadata ? `已删除版本 ${version.name}` : (result.message ?? '删除 Photoshop 版本失败'));
  }, [api, history, photoshopDocumentBlocked]);

  const placePhotoshopVersionPreview = useCallback(async (version: PhotoshopVersionRecord, placement?: { screenX: number; screenY: number }) => {
    const source: ImportedImage = {
      name: `${version.name}.png`, assetId: version.previewAssetId, asset: version.previewAsset, sourceType: 'file',
    };
    await prepareAndAddImages([source], placement ?? { screenX: window.innerWidth / 2, screenY: window.innerHeight / 2 });
    setStatus(`已将版本 ${version.name} 的预览放入画板`);
  }, [prepareAndAddImages]);

  const commands = useMemo(() => createAppCommandRegistry([
    { id: 'edit.undo', enabled: history.canUndo, execute: history.undo },
    { id: 'edit.redo', enabled: history.canRedo, execute: history.redo },
    { id: 'edit.copy', enabled: selectedIds.length > 0 || Boolean(selectedGroup), execute: copySelection },
    { id: 'edit.cut', enabled: selectedIds.length > 0 || Boolean(selectedGroup), execute: cutSelection },
    { id: 'edit.paste', enabled: Boolean(sceneClipboardRef.current), execute: pasteClipboard },
    { id: 'edit.duplicate', enabled: selectedIds.length > 0 || Boolean(selectedGroup), execute: duplicate },
    { id: 'edit.delete', enabled: selectedIds.length > 0 || Boolean(selectedGroup), execute: () => selectedGroup ? deleteGroup(false) : deleteSelected() },
    { id: 'group.create', enabled: selectedIds.length >= 2, execute: createGroup },
  ]), [copySelection, createGroup, cutSelection, deleteGroup, deleteSelected, duplicate, history.canRedo, history.canUndo, history.redo, history.undo, pasteClipboard, selectedGroup, selectedIds.length]);

  const captureShortcut = useCallback((id: ShortcutId, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      setShortcutCaptureId(undefined);
      setStatus('已取消快捷键设置');
      return;
    }
    const next = shortcutFromKeyboardEvent(event.nativeEvent);
    if (!next) {
      setStatus('请按下一个有效的快捷键组合');
      return;
    }
    if (id !== 'collaboration' && next.split('+').includes('Alt')) {
      setStatus('Alt 组合键保留给取色与画布交互');
      return;
    }
    const conflict = shortcutConflict(shortcuts, id, next);
    if (conflict) {
      setStatus(`快捷键 ${next} ${conflict}`);
      return;
    }
    if (id === 'collaboration') {
      if (drawingCollaborationMode) {
        setStatus('请先退出协作模式，再更改协作快捷键');
        setShortcutCaptureId(undefined);
        return;
      }
      if (!api) {
        setStatus('桌面快捷键服务不可用');
        setShortcutCaptureId(undefined);
        return;
      }
      void api.setCollaborationShortcut(next).then((result) => {
        if (!result.ok) {
          setStatus(result.message ?? '协作快捷键注册失败');
          return;
        }
        setShortcuts((current) => ({ ...current, collaboration: result.shortcut }));
        setShortcutCaptureId(undefined);
        setStatus(`协作快捷键已设为 ${result.shortcut}`);
      }).catch((error) => setStatus(`设置协作快捷键失败：${String(error)}`));
      return;
    }
    setShortcuts((current) => ({ ...current, [id]: next }));
    setShortcutCaptureId(undefined);
    setStatus(`${SHORTCUT_LABELS.find((item) => item.id === id)?.label ?? '操作'}快捷键已设为 ${next}`);
  }, [api, drawingCollaborationMode, shortcuts]);

  const resetShortcuts = useCallback(() => {
    if (drawingCollaborationMode) {
      setStatus('请先退出协作模式，再恢复快捷键');
      return;
    }
    if (!api) {
      setShortcuts({ ...DEFAULT_SHORTCUTS });
      setShortcutCaptureId(undefined);
      setStatus('快捷键已恢复默认');
      return;
    }
    void api.setCollaborationShortcut(DEFAULT_SHORTCUTS.collaboration).then((result) => {
      if (!result.ok) {
        setStatus(result.message ?? '恢复协作快捷键失败');
        return;
      }
      setShortcuts({ ...DEFAULT_SHORTCUTS, collaboration: result.shortcut });
      setShortcutCaptureId(undefined);
      setStatus('快捷键已恢复默认');
    }).catch((error) => setStatus(`恢复快捷键失败：${String(error)}`));
  }, [api, drawingCollaborationMode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const input = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      if (input) return;
      const ctrl = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      const alt = event.altKey;
      const shift = event.shiftKey;
      const run = (action: () => void) => { event.preventDefault(); action(); };

      if (drawingCollaborationMode && !ctrl && !alt && !shift && event.code === 'Space') {
        event.preventDefault();
        return;
      }

      if (!ctrl && !alt && !shift && key === 'q') return run(() => setVisualNotesEnabled((value) => !value));
      if (visualNotesEnabled && !ctrl && !alt && !shift) {
        if (key === 'h') return run(() => { if (!event.repeat) setVisualNotesTemporaryHidden(true); });
        if (key === '1' || key === 'b') return run(() => setVisualNoteTool('brush'));
        if (key === '2') return run(() => setVisualNoteTool('arrow'));
        if (key === '3' || key === 'e') return run(() => setVisualNoteTool('eraser'));
      }

      if (matchesColorPickerShortcut(activeColorPickerShortcut, event)) return run(() => {
        if (!event.repeat) setColorPickerHeld(true);
      });

      if (shortcutMatchesEvent(shortcuts.settings, event)) return run(() => { setContextMenu(undefined); setPropertiesOpen((value) => !value); });
      if (shortcutMatchesEvent(shortcuts.saveAs, event)) return run(() => { void save(true); });
      if (shortcutMatchesEvent(shortcuts.save, event)) return run(() => { void save(false); });
      if (shortcutMatchesEvent(shortcuts.undo, event)) return run(appCommand(commands, 'edit.undo').execute);
      if (shortcutMatchesEvent(shortcuts.redo, event)) return run(appCommand(commands, 'edit.redo').execute);
      if (shortcutMatchesEvent(shortcuts.open, event)) return run(() => { void open(); });
      if (shortcutMatchesEvent(shortcuts.newScene, event)) return run(newScene);
      if (shortcutMatchesEvent(shortcuts.fitCanvas, event)) return run(fitCanvas);
      if (shortcutMatchesEvent(shortcuts.resetZoom, event)) return run(resetZoom);
      if (shortcutMatchesEvent(shortcuts.alwaysOnTop, event)) return run(() => { void setMode({ alwaysOnTop: !windowMode.alwaysOnTop }); });
      if (shortcutMatchesEvent(shortcuts.lockWindow, event)) return run(() => { void setMode({ locked: !windowMode.locked }); });
      if (shortcutMatchesEvent(shortcuts.clickThrough, event)) return run(() => { void setMode({ clickThrough: !windowMode.clickThrough }); });

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
      if (ctrl && !alt && shift && key === 'c') return run(restoreFullImages);
      if (ctrl && !alt && shift && key === 't') return run(() => mutateSelected(resetImageTransform));
      if (ctrl && !alt && shift && key === 'g') return run(selectedIds.length ? detachSelectedImages : ungroupSelected);
      if (ctrl && !alt && shift && (key === '+' || key === '=')) return run(() => { void setMode({ opacity: Math.min(1, windowMode.opacity + 0.1) }); });
      if (ctrl && !alt && shift && key === '-') return run(() => { void setMode({ opacity: Math.max(0.3, windowMode.opacity - 0.1) }); });

      if (ctrl && alt && !shift && key === 'p') return run(packAndFit);
      if (ctrl && !alt && !shift && key === 'c') return run(appCommand(commands, 'edit.copy').execute);
      if (ctrl && !alt && !shift && key === 'x') return run(appCommand(commands, 'edit.cut').execute);
      if (ctrl && !alt && !shift && key === 'v') return run(appCommand(commands, 'edit.paste').execute);
      if (ctrl && !alt && !shift && key === 'i') return run(importImages);
      if (ctrl && !alt && shift && key === 'l') return run(() => { if (recent[0]) void open(recent[0].path); else setStatus('没有最近打开的画板'); });
      if (ctrl && !alt && !shift && key === 'y') return run(appCommand(commands, 'edit.redo').execute);
      if (ctrl && !alt && !shift && key === 'd') return run(appCommand(commands, 'edit.duplicate').execute);
      if (ctrl && !alt && !shift && key === 'g') return run(appCommand(commands, 'group.create').execute);
      if (ctrl && !alt && !shift && key === 'a') return run(() => {
        if (windowMode.locked) return;
        setSelectedGroupId(undefined);
        setSelectedIds(history.scene.items.filter((item) => !item.locked).map((item) => item.id));
      });
      if (ctrl && !alt && !shift && key === 'p') return run(() => layout('pack'));
      if (ctrl && !alt && !shift && key === 'o') return run(fitCanvas);
      if (ctrl && !alt && key === 'e') return run(() => { void exportItems(shift); });
      if (ctrl && !alt && !shift && key === 'f') return run(() => api?.toggleMaximize());
      if (ctrl && !alt && !shift && key === 'm') return run(() => api?.minimize());
      if (ctrl && !alt && !shift && key === 'q') return run(() => api?.close());
      if (ctrl && !alt && !shift && (key === '+' || key === '=')) return run(() => zoomBy(1.15));
      if (ctrl && !alt && !shift && key === '-') return run(() => zoomBy(1 / 1.15));

      if (!ctrl && alt && shift && key === 'h') return run(() => mutateSelected((item) => { item.flipX = !item.flipX; }));
      if (!ctrl && alt && shift && key === 'v') return run(() => mutateSelected((item) => { item.flipY = !item.flipY; }));
      if (!ctrl && alt && !shift && key === 'l') return run(() => mutateSelected((item) => { item.locked = !item.locked; }));
      if (!ctrl && !alt && !shift && event.key === 'F2') return run(renameGroup);
      if (!ctrl && !alt && !shift && event.code === 'Space' && !event.repeat) return run(() => toggleFocus(selectedItems));
      if (!ctrl && !alt && !shift && event.key === 'ArrowRight') return run(() => focusStep(1));
      if (!ctrl && !alt && !shift && event.key === 'ArrowLeft') return run(() => focusStep(-1));
      if (!ctrl && !alt && !shift && event.key === 'ArrowUp') return run(() => moveLayer(true));
      if (!ctrl && !alt && !shift && event.key === 'ArrowDown') return run(() => moveLayer(false));
      if (!ctrl && !alt && event.key === 'Delete') {
        if (!deleteSelectedVisualMark()) appCommand(commands, 'edit.delete').execute();
      }
      if (event.key === 'Escape') {
        setColorPickerHeld(false);
        if (renamingGroupId) setRenamingGroupId(undefined);
        else if (contextMenu) setContextMenu(undefined);
        else if (comparisonVersionId) closeVersionComparison();
        else if (photoshopVersionsOpen) setPhotoshopVersionsOpen(false);
        else if (outlineOpen) setOutlineOpen(false);
        else if (propertiesOpen) setPropertiesOpen(false);
        else if (selectedVisualMarkId) setSelectedVisualMarkId(undefined);
        else if (visualNotesEnabled) setVisualNotesEnabled(false);
        else { setSelectedIds([]); setSelectedGroupId(undefined); }
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const releasedPickerKey = activeColorPickerShortcut === 's'
        ? event.key.toLowerCase() === 's' || event.code === 'KeyS'
        : event.key === 'Alt' || event.code === 'AltLeft' || event.code === 'AltRight';
      if (releasedPickerKey) setColorPickerHeld(false);
      if (event.key.toLowerCase() === 'h') setVisualNotesTemporaryHidden(false);
    };
    const onBlur = () => { setColorPickerHeld(false); setVisualNotesTemporaryHidden(false); };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [activeColorPickerShortcut, api, closeVersionComparison, commands, comparisonVersionId, contextMenu, deleteSelectedVisualMark, detachSelectedImages, drawingCollaborationMode, exportItems, fitCanvas, focusStep, history, importImages, layout, moveLayer, mutateSelected, newScene, open, outlineOpen, packAndFit, photoshopVersionsOpen, propertiesOpen, recent, renameGroup, renamingGroupId, resetZoom, restoreFullImages, save, selectedIds.length, selectedItems, selectedVisualMarkId, setMode, shortcuts, toggleFocus, ungroupSelected, visualNotesEnabled, windowMode, zoomBy]);

  useEffect(() => {
    const over = (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer?.types.includes(PHOTOSHOP_VERSION_PREVIEW_MIME)) event.dataTransfer.dropEffect = 'copy';
    };
    const drop = async (event: DragEvent) => {
      event.preventDefault();
      const versionId = event.dataTransfer?.getData(PHOTOSHOP_VERSION_PREVIEW_MIME);
      if (versionId) {
        const version = photoshopMetadataRef.current.versions.find((value) => value.id === versionId);
        if (version) {
          await placePhotoshopVersionPreview(version, { screenX: event.clientX, screenY: event.clientY });
          return;
        }
      }
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
  }, [api, placePhotoshopVersionPreview, prepareAndAddImages]);

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

  const selectedObjectCount = selectedIds.length;
  const hasSelection = selectedObjectCount > 0;
  const hasImageSelection = selectedIds.length > 0;
  const selectedGroupedImageIds = selectedIds.filter((id) => history.scene.groups.some((group) =>
    group.members.some((member) => member.type === 'image' && member.id === id)));
  const joinGroupEntries: ContextMenuEntry[] = history.scene.groups.map((group) => {
    const alreadyJoined = selectedIds.length > 0 && selectedIds.every((id) => group.members.some((member) =>
      member.type === 'image' && member.id === id));
    return {
      type: 'item', label: group.name, checked: alreadyJoined, disabled: alreadyJoined,
      action: () => addImagesToGroup(selectedIds, group.id),
    };
  });
  const undoCommand = appCommand(commands, 'edit.undo');
  const redoCommand = appCommand(commands, 'edit.redo');
  const copyCommand = appCommand(commands, 'edit.copy');
  const cutCommand = appCommand(commands, 'edit.cut');
  const pasteCommand = appCommand(commands, 'edit.paste');
  const duplicateCommand = appCommand(commands, 'edit.duplicate');
  const deleteCommand = appCommand(commands, 'edit.delete');
  const createGroupCommand = appCommand(commands, 'group.create');
  const menuEntries: ContextMenuEntry[] = [
    { type: 'item', label: `${history.scene.name}${history.dirty ? '  • 未保存' : ''}`, disabled: true },
    { type: 'separator' },
    { type: 'item', label: '大纲视图', checked: outlineOpen, action: () => {
      if (!outlineOpen) { setPhotoshopVersionsOpen(false); closeVersionComparison(); }
      setOutlineOpen((value) => !value);
    } },
    { type: 'item', label: '版本视图', checked: photoshopVersionsOpen, action: () => {
      if (!photoshopVersionsOpen) { setOutlineOpen(false); closeVersionComparison(); }
      setPhotoshopVersionsOpen((value) => !value);
    } },
    { type: 'separator' },
    {
      type: 'item', label: '文件', children: [
        { type: 'item', label: '打开…', shortcut: shortcuts.open, action: () => open() },
        { type: 'item', label: '合并其他画板…', action: () => { void importScene(); } },
        {
          type: 'item', label: '最近打开', disabled: recent.length === 0,
          children: recent.length ? recent.slice(0, 8).map((item) => ({ type: 'item' as const, label: item.name, action: () => open(item.path) })) : undefined,
        },
        { type: 'separator' },
        { type: 'item', label: '保存', shortcut: shortcuts.save, action: () => save(false) },
        { type: 'item', label: '另存为…', shortcut: shortcuts.saveAs, action: () => save(true) },
      ],
    },
    {
      type: 'item', label: '编辑', children: [
        { type: 'item', label: '撤销', shortcut: shortcuts.undo, disabled: !undoCommand.enabled, action: undoCommand.execute },
        { type: 'item', label: '重做', shortcut: shortcuts.redo, disabled: !redoCommand.enabled, action: redoCommand.execute },
        { type: 'separator' },
        { type: 'item', label: '全选', shortcut: 'Ctrl+A', disabled: history.scene.items.length === 0, action: () => setSelectedIds(history.scene.items.filter((item) => !item.locked).map((item) => item.id)) },
        { type: 'item', label: '复制', shortcut: 'Ctrl+C', disabled: !copyCommand.enabled, action: copyCommand.execute },
        { type: 'item', label: '剪切', shortcut: 'Ctrl+X', disabled: !cutCommand.enabled, action: cutCommand.execute },
        { type: 'item', label: '粘贴', shortcut: 'Ctrl+V', disabled: !pasteCommand.enabled, action: pasteCommand.execute },
        { type: 'item', label: '快速创建副本', shortcut: 'Ctrl+D', disabled: !duplicateCommand.enabled, action: duplicateCommand.execute },
        { type: 'item', label: '删除选中', shortcut: 'Delete', disabled: !deleteCommand.enabled, danger: true, action: deleteCommand.execute },
      ],
    },
    {
      type: 'item', label: '分组', disabled: !selectedGroup && !createGroupCommand.enabled
        && selectedGroupedImageIds.length === 0 && (!hasImageSelection || joinGroupEntries.length === 0), children: [
        { type: 'item', label: '创建分组框', shortcut: 'Ctrl+G', disabled: !createGroupCommand.enabled, action: createGroupCommand.execute },
        { type: 'item', label: '加入组', disabled: !hasImageSelection || joinGroupEntries.length === 0, children: joinGroupEntries },
        { type: 'item', label: '将选中图片移出组', shortcut: 'Ctrl+Shift+G', disabled: selectedGroupedImageIds.length === 0, action: detachSelectedImages },
        { type: 'item', label: '重命名…', shortcut: 'F2', disabled: !selectedGroup, action: renameGroup },
        { type: 'separator' },
        { type: 'item', label: selectedGroup?.collapsed ? '展开' : '折叠', disabled: !selectedGroup,
          action: () => { if (selectedGroup) changeGroup(selectedGroup.id, { collapsed: !selectedGroup.collapsed }); } },
        { type: 'separator' },
        { type: 'item', label: '清空成员', disabled: !selectedGroup, action: ungroupSelected },
        { type: 'item', label: '删除组框', disabled: !selectedGroup, action: () => deleteGroup(false) },
      ],
    },
    {
      type: 'item', label: '图片', disabled: !hasImageSelection, children: hasImageSelection ? [
        { type: 'item', label: '加入组', disabled: joinGroupEntries.length === 0, children: joinGroupEntries },
        { type: 'item', label: '从组中移出', shortcut: 'Ctrl+Shift+G', disabled: selectedGroupedImageIds.length === 0, action: detachSelectedImages },
        { type: 'separator' },
        { type: 'item', label: primary?.locked ? '解锁' : '锁定', shortcut: 'Alt+L', action: () => mutateSelected((item) => { item.locked = !item.locked; }) },
        { type: 'item', label: '水平翻转', shortcut: 'Alt+Shift+H', action: () => mutateSelected((item) => { item.flipX = !item.flipX; }) },
        { type: 'item', label: '垂直翻转', shortcut: 'Alt+Shift+V', action: () => mutateSelected((item) => { item.flipY = !item.flipY; }) },
        { type: 'item', label: '重置变换', shortcut: 'Ctrl+Shift+T', action: () => mutateSelected(resetImageTransform) },
        { type: 'separator' },
        { type: 'item', label: '移到顶层', shortcut: '↑', action: () => moveLayer(true) },
        { type: 'item', label: '移到底层', shortcut: '↓', action: () => moveLayer(false) },
        { type: 'item', label: '恢复裁剪区域', shortcut: 'Ctrl+Shift+C', action: restoreFullImages },
        { type: 'item', label: primary?.grayscale ? '恢复彩色' : '灰度去色', action: () => mutateSelected((item) => { item.grayscale = !item.grayscale; }) },
        { type: 'item', label: '打开源文件位置', disabled: !primary?.sourcePath, action: () => { void showPrimarySource(); } },
      ] : undefined,
    },
    {
      type: 'item', label: '传输', children: [
        { type: 'item', label: '将选中内容作为图层发送', disabled: !hasImageSelection || photoshopDocumentBlocked,
          action: () => { void sendSelectedToPhotoshop('layer'); } },
        { type: 'item', label: '将选中内容作为新图像打开', disabled: !hasImageSelection || photoshopDocumentBlocked,
          action: () => { void sendSelectedToPhotoshop('image'); } },
        { type: 'separator' },
        { type: 'item', label: '保存当前 Photoshop 版本…', disabled: photoshopDocumentBlocked,
          action: () => { void openPhotoshopVersionSaveDialog(); } },
      ],
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
        { type: 'item', label: '显示整个画板', shortcut: shortcuts.fitCanvas, disabled: !hasContent, action: fitCanvas },
        { type: 'item', label: '重置缩放为 1:1', shortcut: shortcuts.resetZoom, action: resetZoom },
        { type: 'item', label: '系统设置', shortcut: shortcuts.settings, checked: propertiesOpen, action: () => setPropertiesOpen((value) => !value) },
      ],
    },
    {
      type: 'item', label: '窗口', children: [
        { type: 'item', label: '协作模式', shortcut: shortcuts.collaboration, checked: drawingCollaborationMode,
          action: () => { void toggleDrawingCollaborationMode(); } },
        { type: 'separator' },
        { type: 'item', label: '始终置顶', shortcut: shortcuts.alwaysOnTop, checked: windowMode.alwaysOnTop, disabled: drawingCollaborationMode,
          action: () => setMode({ alwaysOnTop: !windowMode.alwaysOnTop }) },
        { type: 'item', label: '锁定窗口位置', shortcut: shortcuts.lockWindow, checked: windowMode.locked, disabled: drawingCollaborationMode,
          action: () => setMode({ locked: !windowMode.locked }) },
        { type: 'item', label: '鼠标穿透', shortcut: shortcuts.clickThrough, checked: windowMode.clickThrough, action: () => setMode({ clickThrough: !windowMode.clickThrough }) },
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
    { type: 'item', label: '新建画板', shortcut: shortcuts.newScene, action: newScene },
    { type: 'item', label: '退出画布', shortcut: 'Ctrl+Q', danger: true, action: () => api?.close() },
  ];
  const groupActionTarget = groupActionMenu
    ? history.scene.groups.find((group) => group.id === groupActionMenu.id) : undefined;
  const groupActionEntries: ContextMenuEntry[] = groupActionTarget && groupActionMenu ? [
    { type: 'item', label: '更改颜色…', action: () => setGroupColorEditor({
      id: groupActionTarget.id,
      anchor: { ...groupActionMenu.position },
    }) },
    { type: 'item', label: '重命名…', shortcut: 'F2', action: () => renameGroupById(groupActionTarget.id) },
    { type: 'item', label: groupActionTarget.collapsed ? '展开' : '折叠',
      action: () => changeGroup(groupActionTarget.id, { collapsed: !groupActionTarget.collapsed }) },
    { type: 'item', label: '自动适应内容', checked: groupActionTarget.autoFit ?? true,
      action: () => history.commit((scene) => {
        const group = scene.groups.find((value) => value.id === groupActionTarget.id);
        if (!group) return;
        group.autoFit = !(group.autoFit ?? true);
        if (group.autoFit) fitGroupToContents(scene, group.id);
      }) },
    { type: 'item', label: '移出组内全部图片', disabled: !groupActionTarget.members.some((member) => member.type === 'image'),
      action: () => detachImages(groupActionTarget.members.filter((member) => member.type === 'image').map((member) => member.id), groupActionTarget.id) },
    { type: 'separator' },
    { type: 'item', label: '删除组框', action: () => deleteGroupById(groupActionTarget.id, false) },
  ] : [];

  const groupedImageIds = new Set(history.scene.groups.flatMap((group) => group.members.filter((member) => member.type === 'image').map((member) => member.id)));
  const displaySceneName = history.scene.name === '未命名画板' ? history.scene.name : `${history.scene.name}.yoi`;
  useEffect(() => {
    const title = `${displaySceneName}${history.dirty ? ' •' : ''} · Yoiniwa`;
    document.title = title;
    void api?.setTitle(title).catch(() => undefined);
  }, [api, displaySceneName, history.dirty]);
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
    if (windowMode.locked) return;
    setSelectedGroupId(undefined); setSelectedIds([item.id]);
  };
  const focusOutlineImage = (item: ImageItem) => { if (windowMode.locked) return; selectOutlineImage(item); focusOutlineBounds(sceneBounds([item])); };
  const selectOutlineGroup = (group: ImageGroup) => {
    if (windowMode.locked) return;
    setSelectedIds([]); setSelectedGroupId(group.id);
  };
  const focusOutlineGroup = (group: ImageGroup) => {
    if (windowMode.locked) return;
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
  const groupMatchesOutline = (group: ImageGroup) => groupOrDescendantMatches(history.scene, group, outlineFilter);
  const renderOutlineImage = (item: ImageItem) => imageMatchesOutline(item) ? <li key={`image-${item.id}`}>
    <div className={`outline-row image${selectedIds.includes(item.id) ? ' selected' : ''}${item.hidden ? ' muted' : ''}`}>
      <span className="outline-indent" />
      <OutlineThumbnail item={item} />
      <button className="outline-name" title={`${item.name} · 双击定位`} onClick={() => selectOutlineImage(item)} onDoubleClick={() => focusOutlineImage(item)}>{item.name}</button>
      <span className="outline-actions">
        <button className={`outline-visibility${item.hidden ? ' off' : ''}`} title={item.hidden ? '显示图片' : '隐藏图片'} onClick={() => history.commit((scene) => { const value = scene.items.find((entry) => entry.id === item.id); if (value) value.hidden = !value.hidden; })}><UiIcon name={item.hidden ? 'eye-off' : 'eye'} /></button>
        <button className={`outline-lock${item.locked ? ' locked' : ''}`} title={item.locked ? '解锁图片' : '锁定图片'} onClick={() => history.commit((scene) => { const value = scene.items.find((entry) => entry.id === item.id); if (value) value.locked = !value.locked; })}><UiIcon name={item.locked ? 'lock' : 'unlock'} /></button>
        <button className="outline-layer down" title="下移一层" onClick={() => moveOutlineImageLayer(item.id, -1)}><UiIcon name="arrow-down" /></button>
        <button className="outline-layer up" title="上移一层" onClick={() => moveOutlineImageLayer(item.id, 1)}><UiIcon name="arrow-up" /></button>
      </span>
    </div>
  </li> : null;
  const renderOutlineGroup = (group: ImageGroup, visited = new Set<string>()): React.ReactNode => {
    if (visited.has(group.id) || !groupMatchesOutline(group)) return null;
    const nextVisited = new Set(visited).add(group.id);
    const collapsed = !hasOutlineFilter && outlineCollapsedIds.has(group.id);
    return <li key={group.id} className="outline-group-node">
      <div className={`outline-row group${selectedGroupId === group.id ? ' selected' : ''}`}>
        <button className={`outline-disclosure${collapsed ? ' collapsed' : ''}`} title={collapsed ? '展开层级' : '折叠层级'}
          onClick={() => toggleOutlineGroup(group.id)}><UiIcon name={collapsed ? 'chevron-right' : 'chevron-down'} /></button>
        <span className="outline-group-mark" style={{ color: group.color }}><UiIcon name="group" /></span>
        <button className="outline-name" title={`${group.name} · 双击定位`} onClick={() => selectOutlineGroup(group)} onDoubleClick={() => focusOutlineGroup(group)}>{group.name}</button>
        <span className="outline-count">{group.members.length}</span>
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
        return null;
      })}</ul>}
    </li>;
  };

  return <main className="app-shell">
    <section className="workspace">
      <CanvasView
        background={history.scene.canvas.background}
        backgroundOpacity={history.scene.canvas.backgroundOpacity ?? 1}
        scene={history.scene}
        viewport={history.scene.viewport}
        selectedIds={selectedIds}
        selectedGroupId={selectedGroupId}
        lassoClearRequest={lassoClearRequest}
        projectEpoch={history.projectEpoch}
        onSelectionChange={(ids, source) => {
          setSelectedIds(ids); setSelectedGroupId(undefined);
          if (source !== 'lasso') setLassoPoints(undefined);
        }}
        onLassoSelectionChange={setLassoPoints}
        onGroupSelectionChange={(id) => { setSelectedGroupId(id); if (id) setSelectedIds([]); }}
        onItemsChanged={commitItemChanges}
        onGroupMoved={moveGroup}
        onGroupResized={resizeGroup}
        onRenameGroup={renameGroupById}
        onOpenGroupMenu={openGroupActions}
        onExpandGroup={(id) => changeGroup(id, { collapsed: false })}
        groupMenuOpen={Boolean(groupActionMenu)}
        onGroupPreviewAnchor={moveGroupColorEditor}
        colorPickerHeld={colorPickerHeld}
        colorPickerShortcut={colorPickerShortcut}
        drawingCollaborationMode={drawingCollaborationMode}
        onColorPicked={(color) => { void syncPickedColor(color); }}
        onFocusItem={focusItem}
        onContextMenu={(position) => { setPropertiesOpen(false); setGroupActionMenu(undefined); setContextMenu(position); }}
        onExternalImageDrag={(items) => {
          if (!api || photoshopDocumentBlocked) return undefined;
          const assetIds = items.flatMap((item) => item.assetId ? [item.assetId] : []);
          return assetIds.length ? () => api.startImageDrag(assetIds) : undefined;
        }}
        windowLocked={windowMode.locked}
        onWindowMoveStart={() => api?.beginWindowMove()}
        onWindowMove={() => api?.updateWindowMove()}
        onWindowMoveEnd={() => api?.endWindowMove()}
        visualNotesState={visualNotesToolState}
        visualNotesTemporaryHidden={visualNotesTemporaryHidden}
        onVisualNotesChanged={commitVisualNotes}
        onVisualNoteSelectionChange={setSelectedVisualMarkId}
        onViewportCommit={(viewport) => { liveViewportRef.current = viewport; history.updateViewport(viewport); }}
      />

      {propertiesOpen && <aside className="property-panel no-drag">
        <div className="property-header"><div><strong>设置</strong><span>应用</span></div><button title={`关闭设置面板 (${shortcuts.settings})`} onClick={() => setPropertiesOpen(false)}><UiIcon name="close" /></button></div>
        <section>
          <h3>交互设置</h3>
          <div className="selection-summary">Alt 模式适合 Photoshop + 数位板：锁定后 Alt + 笔尖点击取色，并自动返回 Photoshop</div>
          <div className="button-grid">
            <Button active={colorPickerShortcut === 's'} onClick={() => { setColorPickerShortcut('s'); setStatus('取色快捷键已设为 S'); }}>S</Button>
            <Button active={colorPickerShortcut === 'alt'} onClick={() => { setColorPickerShortcut('alt'); setStatus('取色快捷键已设为 Alt'); }}>Alt（PS / 数位板）</Button>
          </div>
        </section>

        <section>
          <h3>快捷键</h3>
          <div className="shortcut-list">
            {SHORTCUT_LABELS.map(({ id, label }) => {
              const capturing = shortcutCaptureId === id;
              const disabled = id === 'collaboration' && drawingCollaborationMode;
              return <div className="shortcut-row" key={id}>
                <span>{label}</span>
                <button
                  className={capturing ? 'active shortcut-capture' : 'shortcut-capture'}
                  title={disabled ? '请先退出协作模式' : '点击后按下快捷键'}
                  disabled={disabled}
                  onClick={() => { setShortcutCaptureId(id); setStatus(`请按下“${label}”的新快捷键`); }}
                  onKeyDown={(event) => captureShortcut(id, event)}
                  onBlur={() => { if (capturing) setShortcutCaptureId(undefined); }}
                >{capturing ? '请按键…' : shortcuts[id]}</button>
              </div>;
            })}
          </div>
          <Button onClick={resetShortcuts}>恢复默认快捷键</Button>
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
      </aside>}
    </section>

    {comparisonVersion && <PhotoshopVersionComparePanel
      currentPreviewUrl={comparisonPreview.url}
      currentPreviewState={comparisonPreview.state}
      currentPreviewError={comparisonPreview.error}
      currentCapturedAt={comparisonPreview.capturedAt}
      currentLabel={comparisonPreview.documentName || 'Photoshop 当前文档'}
      version={comparisonVersion}
      versions={comparisonVersions}
      mode={comparisonMode}
      split={comparisonSplit}
      opacity={comparisonOpacity}
      onModeChange={setComparisonMode}
      onSplitChange={setComparisonSplit}
      onOpacityChange={setComparisonOpacity}
      onVersionChange={setComparisonVersionId}
      onRefreshCurrent={refreshComparisonPreview}
      onClose={closeVersionComparison}
    />}

    {photoshopVersionsOpen && !comparisonVersionId && <aside className="photoshop-version-panel no-drag">
      <header className="photoshop-version-header">
        <div><strong>版本视图</strong><span className="outline-count">{photoshopMetadata.versions.length}</span></div>
        <button title="关闭版本面板" aria-label="关闭版本面板" onClick={() => setPhotoshopVersionsOpen(false)}><UiIcon name="close" /></button>
      </header>
      <div className="photoshop-version-toolbar">
        <div><strong>项目版本库</strong><small>{formatBytes(photoshopMetadata.versions.reduce((sum, version) => sum + version.byteLength, 0))}</small></div>
        <button className="photoshop-version-save-button" disabled={photoshopDocumentBlocked}
          onClick={() => { void openPhotoshopVersionSaveDialog(); }}><UiIcon name="plus" size={13} />保存版本</button>
      </div>
      <div className="photoshop-version-list">
        {photoshopMetadata.versions.length === 0 && <div className="photoshop-version-empty"><strong>暂无 Photoshop 版本</strong><span>保存版本后，完整 PSD/PSB 会随 .yoi 画板一起保存。</span></div>}
        {[...photoshopMetadata.versions].reverse().map((version) => <article className="photoshop-version-card" key={version.id}>
          <div className="photoshop-version-preview" draggable
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'copy';
              event.dataTransfer.setData(PHOTOSHOP_VERSION_PREVIEW_MIME, version.id);
            }}
            onDoubleClick={() => { void placePhotoshopVersionPreview(version); }}>
            <img src={imageSource({ assetId: version.previewAssetId }, 'original')} alt="" draggable={false} /><span>{version.format.toUpperCase()}</span>
          </div>
          <div className="photoshop-version-info"><strong title={version.name}>{version.name}</strong><small title={version.documentName}>{version.documentName}</small>
            <small>{version.width}×{version.height} · {version.colorMode} · {version.bitDepth} bit</small>
            <small>{version.layerCount} 层 · {formatBytes(version.byteLength)} · {new Date(version.createdAt).toLocaleString()}</small>
            {version.note && <p>{version.note}</p>}</div>
          <div className="photoshop-version-actions">
            <button disabled={photoshopDocumentBlocked} onClick={() => { void openPhotoshopVersion(version); }}>在 PS 打开</button>
            <button onClick={() => { void placePhotoshopVersionPreview(version); }}>放入画板</button>
            <button disabled={photoshopDocumentBlocked} onClick={() => openVersionComparison(version)}><UiIcon name="eye" size={13} />比较</button>
            <button className="danger" disabled={photoshopDocumentBlocked} onClick={() => { void deletePhotoshopVersion(version); }}><UiIcon name="trash" size={13} />删除</button>
          </div>
        </article>)}
      </div>
    </aside>}

    {outlineOpen && <aside className="outline-panel no-drag">
      <header>
        <div><strong>大纲</strong><span>{history.scene.items.length + history.scene.groups.length}</span></div>
        <span className="outline-header-actions">
          <button className="outline-expand-all" title="全部展开" aria-label="全部展开"
            onClick={() => setOutlineCollapsedIds(new Set())}>
            <UiIcon name="chevrons-down" />
          </button>
          <button className="outline-collapse-all" title="全部折叠" aria-label="全部折叠"
            onClick={() => setOutlineCollapsedIds(new Set(history.scene.groups.map((group) => group.id)))}>
            <UiIcon name="chevrons-up" />
          </button>
          <button className="outline-close" title="关闭大纲" aria-label="关闭大纲" onClick={() => setOutlineOpen(false)}>
            <UiIcon name="close" />
          </button>
        </span>
      </header>
      <div className="outline-search">
        <span><UiIcon name="search" /></span><input value={outlineQuery} onChange={(event) => setOutlineQuery(event.target.value)} placeholder="搜索名称或标签" />
        {outlineQuery && <button title="清除搜索" onClick={() => setOutlineQuery('')}><UiIcon name="close" size={14} /></button>}
      </div>
      <div className="outline-tree"><ul>
        {history.scene.groups.filter((group) => !group.parentId).map((group) => renderOutlineGroup(group))}
        {history.scene.items.filter((item) => !groupedImageIds.has(item.id)).map(renderOutlineImage)}
      </ul>
      {hasOutlineFilter && !history.scene.groups.some((group) => groupMatchesOutline(group))
        && !history.scene.items.some(imageMatchesOutline)
        && <div className="outline-empty">没有匹配的对象</div>}
      </div>
    </aside>}

    <div className={`scene-name-badge no-drag${sceneNameVisible ? ' visible' : ''}`} title={displaySceneName}>{displaySceneName}{history.dirty ? '  •' : ''}</div>

    {!drawingCollaborationMode && <div className="window-control-zone no-drag">
      <div className="window-floating-controls">
        <button className={windowMode.alwaysOnTop ? 'active' : ''}
          title={windowMode.alwaysOnTop ? '取消始终置顶' : '始终置顶'}
          onClick={() => { void setMode({ alwaysOnTop: !windowMode.alwaysOnTop }); }}><UiIcon name="pin" /></button>
        <button title={`协作模式 · ${shortcuts.collaboration}`}
          aria-pressed={false}
          onClick={() => { void toggleDrawingCollaborationMode(); }}><UiIcon name="pen" /></button>
        <button title="最小化" onClick={() => api?.minimize()}><UiIcon name="minimize" /></button>
        <button title="最大化 / 还原" onClick={() => api?.toggleMaximize()}><UiIcon name="maximize" /></button>
        <button className="close" title="关闭" onClick={() => api?.close()}><UiIcon name="close" /></button>
      </div>
    </div>}

    {contextMenu && <ContextMenu position={contextMenu} entries={menuEntries} onClose={() => setContextMenu(undefined)} />}
    {groupActionMenu && groupActionEntries.length > 0 && <ContextMenu variant="group" position={groupActionMenu.position}
      entries={groupActionEntries} onClose={() => setGroupActionMenu(undefined)} />}

      {groupColorEditor && (() => {
      const group = history.scene.groups.find((value) => value.id === groupColorEditor.id);
      return group ? <ColorControl groupPalette key={group.id} ref={groupColorEditorRef} label="组背景颜色" value={group.color} alpha={group.opacity}
        anchor={groupColorEditor.anchor} onClose={() => setGroupColorEditor(undefined)}
        onChange={(color) => changeGroup(group.id, { color })}
        onPresetChange={(color, opacity) => changeGroup(group.id, { color, opacity })}
        onPreviewChange={(color) => history.preview((scene) => {
          const current = scene.groups.find((value) => value.id === group.id);
          if (current) current.color = color;
        })}
        onInteractionStart={history.beginTransaction} onInteractionEnd={history.commitTransaction}
        onAlphaChange={(opacity) => history.preview((scene) => {
          const current = scene.groups.find((value) => value.id === group.id);
          if (current) current.opacity = opacity;
        })} /> : null;
      })()}

      {versionSaveDialogOpen && <div className="photoshop-version-dialog-backdrop no-drag" onPointerDown={(event) => {
        if (event.target === event.currentTarget) setVersionSaveDialogOpen(false);
      }}><form className="photoshop-version-dialog" onSubmit={(event) => { event.preventDefault(); void savePhotoshopVersion(); }}>
        <header><div><strong>保存 Photoshop 版本</strong><span>完整分层 PSD/PSB 将嵌入当前 .yoi</span></div>
          <button type="button" title="取消" onClick={() => setVersionSaveDialogOpen(false)}><UiIcon name="close" /></button></header>
        <label><span>版本名称</span><input autoFocus maxLength={160} value={versionName} onChange={(event) => setVersionName(event.target.value)} /></label>
        <label><span>备注（可选）</span><textarea maxLength={4000} rows={4} value={versionNote} onChange={(event) => setVersionNote(event.target.value)} /></label>
        <footer><button type="button" onClick={() => setVersionSaveDialogOpen(false)}>取消</button><button type="submit" disabled={!versionName.trim()}>保存版本</button></footer>
      </form></div>}

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

    {visualNotesEnabled && <div className="visual-notes-toolbar no-drag" role="toolbar" aria-label="视觉标注工具">
      <div className="visual-note-tools">
        {VISUAL_NOTE_TOOL_OPTIONS.map((option) => <button key={option.tool}
          className={`visual-note-tool${visualNoteTool === option.tool ? ' active' : ''}`}
          data-tooltip={`${option.label}　${option.shortcut}`} aria-label={`${option.label}，快捷键 ${option.shortcut}`}
          onClick={() => setVisualNoteTool(option.tool)}><UiIcon name={option.icon} size={17} /></button>)}
      </div>
      <span className="visual-note-divider" />
      <details className="visual-note-fold visual-note-width-fold">
        <summary data-tooltip={visualNoteTool === 'eraser' ? '橡皮尺寸' : `${visualNoteWidth === 'thin' ? '细线' : visualNoteWidth === 'medium' ? '中线' : '粗线'}`}
          aria-label={visualNoteTool === 'eraser' ? '选择橡皮尺寸' : '选择线宽'}>
          <i style={{ width: '16px', height: visualNoteTool === 'eraser'
            ? `${({ small: 2, medium: 4, large: 6 } as const)[eraserSize]}px`
            : `${({ thin: 1, medium: 2.5, thick: 5 } as const)[visualNoteWidth]}px` }} />
          <UiIcon className="visual-note-fold-caret" name="caret-down" size={11} />
        </summary>
        <div className="visual-note-fold-panel visual-note-width-list">
          {visualNoteTool === 'eraser' ? (['small', 'medium', 'large'] as const).map((size, index) => <button key={size}
            className={eraserSize === size ? 'active' : ''} onClick={(event) => {
              setEraserSize(size); event.currentTarget.closest('details')?.removeAttribute('open');
            }}><i style={{ width: `${[10, 16, 22][index]}px`, height: `${[2, 4, 6][index]}px` }} /><span>{['小', '中', '大'][index]}</span></button>)
            : (['thin', 'medium', 'thick'] as const).map((width, index) => <button key={width}
              className={visualNoteWidth === width ? 'active' : ''} onClick={(event) => {
                setVisualNoteWidth(width); updateSelectedVisualMarkStyle({ width }); event.currentTarget.closest('details')?.removeAttribute('open');
              }}><i style={{ height: `${[1, 2.5, 5][index]}px` }} /><span>{['细线', '中线', '粗线'][index]}</span></button>)}
        </div>
      </details>
      {visualNoteTool !== 'eraser' && <>
        <span className="visual-note-divider" />
        <details className="visual-note-fold visual-note-color-fold">
          <summary data-tooltip="标注颜色" aria-label="选择标注颜色">
            <i className="visual-note-current-color" style={{ '--note-color': visualNoteColor } as React.CSSProperties} />
            <UiIcon className="visual-note-fold-caret" name="caret-down" size={11} />
          </summary>
          <div className="visual-note-fold-panel visual-note-color-list">
            {VISUAL_NOTE_COLOR_OPTIONS.map(([color, name]) => <button key={color} className={visualNoteColor === color ? 'active' : ''}
              onClick={(event) => {
                setVisualNoteColor(color); updateSelectedVisualMarkStyle({ color }); event.currentTarget.closest('details')?.removeAttribute('open');
              }}><i style={{ '--note-color': color } as React.CSSProperties} /><span>{name}</span><UiIcon name="check" size={13} /></button>)}
            <label className="visual-note-color-custom"><UiIcon name="palette" size={16} /><span>更多颜色</span>
              <input type="color" value={visualNoteColor} onChange={(event) => {
                setVisualNoteColor(event.target.value); updateSelectedVisualMarkStyle({ color: event.target.value });
                event.currentTarget.closest('details')?.removeAttribute('open');
              }} />
            </label>
          </div>
        </details>
        <span className="visual-note-divider" />
        <details className="visual-note-fold visual-note-opacity-fold">
          <summary data-tooltip={`不透明度　${Math.round(visualNoteOpacity * 100)}%`} aria-label={`不透明度 ${Math.round(visualNoteOpacity * 100)}%`}>
            <UiIcon name="opacity" size={16} />
          </summary>
          <div className="visual-note-fold-panel visual-note-opacity-panel">
            <div className="visual-note-opacity-heading"><span>不透明度</span><output>{Math.round(visualNoteOpacity * 100)}%</output></div>
            <input aria-label="不透明度" type="range" min="20" max="100" step="5" value={Math.round(visualNoteOpacity * 100)}
              style={{ '--opacity-progress': `${(visualNoteOpacity - 0.2) / 0.8 * 100}%` } as React.CSSProperties}
              onPointerDown={() => { if (selectedVisualMarkId) history.beginTransaction(); }}
              onChange={(event) => {
                const opacity = Number(event.target.value) / 100; setVisualNoteOpacity(opacity);
                if (selectedVisualMarkId) history.preview((scene) => {
                  const mark = scene.visualNotes.marks.find((value) => value.id === selectedVisualMarkId);
                  if (mark) mark.style.opacity = opacity;
                });
              }}
              onPointerUp={() => { if (selectedVisualMarkId) history.commitTransaction(); }}
              onPointerCancel={() => { if (selectedVisualMarkId) history.commitTransaction(); }} />
            <div className="visual-note-opacity-scale"><span>20</span><span>100</span></div>
          </div>
        </details>
      </>}
      <span className="visual-note-divider" />
      <div className="visual-note-auxiliary">
        {visualNoteTool !== 'eraser' && <button className={visualNotePressure ? 'active compact' : 'compact'} data-tooltip="笔迹平滑" aria-label="笔迹平滑"
          onClick={() => setVisualNotePressure((value) => !value)}><UiIcon name="smooth" /></button>}
        {selectedVisualMarkId && <button className="compact" data-tooltip="删除选中标注　Delete" aria-label="删除选中标注"
          onClick={deleteSelectedVisualMark}><UiIcon name="trash" /></button>}
      </div>
      <span className="visual-note-divider" />
      <button className={history.scene.visualNotes.visible ? 'compact' : 'compact active'}
        data-tooltip={`${history.scene.visualNotes.visible ? '隐藏' : '显示'}标注　H（按住临时隐藏）`}
        aria-label={history.scene.visualNotes.visible ? '隐藏标注' : '显示标注'}
        onClick={() => history.commit((scene) => { scene.visualNotes.visible = !scene.visualNotes.visible; })}>
        <UiIcon name={history.scene.visualNotes.visible ? 'eye' : 'eye-off'} />
      </button>
      <button className="compact visual-note-exit" data-tooltip="退出标注模式　Esc" aria-label="退出标注模式"
        onClick={() => setVisualNotesEnabled(false)}><UiIcon name="close" /></button>
    </div>}

    {!hasContent && <div className="empty-state no-drag">
      <img className="empty-brand-icon" src="./yoiniwa-icon.png" alt="宵庭 Logo" draggable={false} />
      <div className="empty-brand-name"><strong>Yoiniwa</strong><span>宵庭</span></div>
      <h1>建立你的参考画板</h1>
      <p>拖入图片、粘贴截图，或从电脑中选择图片。</p>
      <Button onClick={importImages}>选择图片</Button>
      <small>右键菜单/拖动窗口 · {activeColorPickerShortcut === 's' ? 'S+左键取色 · Alt+左键或中键平移' : 'Alt+笔尖取色 · 中键平移'} · 空格聚焦</small>
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
