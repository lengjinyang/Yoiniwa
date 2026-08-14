import { useEffect, useRef, useState } from 'react';
import { useSceneHistory } from './useSceneHistory';
import { performanceMonitor } from './runtime/performanceMonitor';
import { PHOTOSHOP_VERSION_PREVIEW_MIME } from './app/components/PhotoshopVersionsPanel';
import { AppOverlays, AppWorkspace } from './app/components/AppPresentation';
import { usePhotoshopVersionController } from './app/hooks/usePhotoshopVersionController';
import { useVisualNotes } from './app/hooks/useVisualNotes';
import { useImageImport, type InternalImageDropHandler } from './app/hooks/useImageImport';
import { useContextMenu } from './app/hooks/useContextMenu';
import { useStatusOperations } from './app/hooks/useStatusOperations';
import { useProjectLifecycle } from './app/hooks/useProjectLifecycle';
import { useSceneWorkspaceController } from './app/hooks/useSceneWorkspaceController';
import { useAppPreferences } from './app/hooks/useAppPreferences';
import { useSceneDelivery } from './app/hooks/useSceneDelivery';
import { useAppHarness } from './app/hooks/useAppHarness';
import { useAppCommands } from './app/hooks/useAppCommands';
import { useWindowCollaborationController } from './app/hooks/useWindowCollaborationController';
import { useColorPickerController } from './app/hooks/useColorPickerController';
import { useAppShell, useNativeZoom } from './app/hooks/useAppShell';
import { UnsavedChangesDialog } from './app/components/UnsavedChangesDialog';
import './styles.css';
import './styles/quiet-tokens.css';
import './styles/quiet-controls.css';
import './styles/quiet-surfaces.css';
import './styles/motion.css';
export default function App() {
  performanceMonitor.markReactRender();
  const history = useSceneHistory();
  const statusOperations = useStatusOperations();
  const {
    setStatus,
    beginOperation,
    settleCurrentOperation,
    clearCurrentOperation,
  } = statusOperations;
  const shell = useAppShell();
  const { panels, sceneNameVisible, lastPointerRef } = shell;
  const photoshopVersionPreviewDropRef = useRef<InternalImageDropHandler>(async () => false);
  const beforeProjectChangeRef = useRef<() => void>(() => undefined);
  const drawingCollaborationModeRef = useRef(false);
  const onWindowLockedRef = useRef<() => void>(() => undefined);
  const api = window.refCanvas;
  const [closePromptOpen, setClosePromptOpen] = useState(false);
  const [closeSaving, setCloseSaving] = useState(false);
  const context = useContextMenu();
  const { close: closeContextMenu } = context;
  const preferences = useAppPreferences({ api, drawingCollaborationModeRef, setStatus });
  const {
    colorPickerShortcut,
    shortcuts,
  } = preferences;
  const windowController = useWindowCollaborationController({
    api,
    collaborationShortcut: shortcuts.collaboration,
    onLockedRef: onWindowLockedRef,
    setStatus,
  });
  const {
    mode: windowMode,
    drawingCollaborationMode,
    autoPhotoshopRoundTrip,
    documentBlocked: photoshopDocumentBlocked,
    setMode,
    toggleDrawingCollaborationMode,
  } = windowController;
  drawingCollaborationModeRef.current = drawingCollaborationMode;
  const colorPicker = useColorPickerController({
    api,
    colorPickerShortcut,
    autoPhotoshopRoundTrip,
    drawingCollaborationMode,
    windowLocked: windowMode.locked,
    setStatus,
  });
  const {
    setHeld: setColorPickerHeld,
  } = colorPicker;
  const workspace = useSceneWorkspaceController({
    api,
    history,
    windowLocked: windowMode.locked,
    closeContextMenu,
    lastPointerRef,
    setStatus,
  });
  const {
    setSelectedIds,
    setSelectedGroupId,
    selectedItems,
    lassoPoints,
    clearLasso,
    setGroupActionMenu,
    zoomBy,
  } = workspace;
  const visualNotes = useVisualNotes({
    notes: history.scene.visualNotes,
    projectEpoch: history.projectEpoch,
    commit: history.commit,
    preview: history.preview,
    beginTransaction: history.beginTransaction,
    commitTransaction: history.commitTransaction,
  });
  const imageImport = useImageImport({
    api,
    scene: history.scene,
    commit: history.commit,
    setSelectedIds,
    setSelectedGroupId,
    setStatus,
    internalDropMime: PHOTOSHOP_VERSION_PREVIEW_MIME,
    internalDropHandlerRef: photoshopVersionPreviewDropRef,
    lastPointerRef,
  });
  const { prepareAndAddImages } = imageImport;
  const project = useProjectLifecycle({
    api,
    history,
    beforeProjectChangeRef,
    setSelectedIds,
    setSelectedGroupId,
    setStatus,
    beginOperation,
    settleOperation: settleCurrentOperation,
    clearOperation: clearCurrentOperation,
  });
  useEffect(() => api?.onCloseRequested(() => {
    setCloseSaving(false);
    setClosePromptOpen(true);
  }), [api]);
  const cancelClose = () => {
    if (closeSaving) return;
    setClosePromptOpen(false);
    api?.respondToClose(false);
  };
  const discardAndClose = () => {
    if (closeSaving) return;
    setClosePromptOpen(false);
    api?.respondToClose(true);
  };
  const saveAndClose = async () => {
    if (closeSaving) return;
    setCloseSaving(true);
    const saved = await project.save(false);
    if (saved) {
      setClosePromptOpen(false);
      api?.respondToClose(true);
      return;
    }
    setCloseSaving(false);
  };
  const {
    photoshopMetadata,
    setPhotoshopMetadata,
    photoshopMetadataRef,
    projectSessionIdRef,
    liveViewportRef,
  } = project;
  const {
    getRenderNotes: getVisualNotesForRender,
    clearSelection: clearVisualNoteSelection,
  } = visualNotes;
  onWindowLockedRef.current = () => {
    workspace.clearSelection();
    clearVisualNoteSelection();
    closeContextMenu();
    setGroupActionMenu(undefined);
  };
  const delivery = useSceneDelivery({
    api,
    scene: history.scene,
    selectedItems,
    lassoPoints,
    photoshopDocumentBlocked,
    getVisualNotesForRender,
    clearLasso,
    beginOperation,
    settleOperation: settleCurrentOperation,
    clearOperation: clearCurrentOperation,
    setStatus,
  });
  useAppHarness({ history, getVisualNotesForRender, setSelectedIds, setSelectedGroupId });

  useNativeZoom(api, zoomBy);

  const versions = usePhotoshopVersionController({
    api,
    metadata: photoshopMetadata,
    metadataRef: photoshopMetadataRef,
    onMetadataChange: setPhotoshopMetadata,
    projectSessionIdRef,
    liveViewportRef,
    drawingCollaborationMode,
    documentBlocked: photoshopDocumentBlocked,
    flushViewport: history.flushViewport,
    markSaved: history.markSaved,
    prepareAndAddImages,
    beginOperation,
    settleOperation: settleCurrentOperation,
    clearOperation: clearCurrentOperation,
    setStatus,
  });
  const {
    placePhotoshopVersionPreview,
    closeVersionComparison,
  } = versions;
  beforeProjectChangeRef.current = closeVersionComparison;
  photoshopVersionPreviewDropRef.current = async (versionId, placement) => {
    const version = photoshopMetadataRef.current.versions.find((value) => value.id === versionId);
    if (!version) return false;
    await placePhotoshopVersionPreview(version, placement);
    return true;
  };

  const menuEntries = useAppCommands({
    api,
    history,
    preferences,
    workspace,
    visualNotes,
    imageImport,
    project,
    delivery,
    versions,
    context,
    panels,
    window: {
      mode: windowMode,
      drawingCollaborationMode,
      setMode,
      toggleDrawingCollaborationMode,
    },
    photoshopDocumentBlocked,
    setColorPickerHeld,
    setStatus,
  });
  return <main className="app-shell">
    <AppWorkspace
      api={api}
      history={history}
      workspace={workspace}
      preferences={preferences}
      visualNotes={visualNotes}
      project={project}
      windowController={windowController}
      colorPicker={colorPicker}
      panels={panels}
      context={context}
      photoshopDocumentBlocked={photoshopDocumentBlocked}
    />
    <AppOverlays
      api={api}
      history={history}
      workspace={workspace}
      preferences={preferences}
      visualNotes={visualNotes}
      project={project}
      windowController={windowController}
      versions={versions}
      imageImport={imageImport}
      context={context}
      statusOperations={statusOperations}
      panels={panels}
      menuEntries={menuEntries}
      sceneNameVisible={sceneNameVisible}
      photoshopDocumentBlocked={photoshopDocumentBlocked}
    />
    <UnsavedChangesDialog
      open={closePromptOpen}
      saving={closeSaving}
      sceneName={project.displaySceneName}
      onCancel={cancelClose}
      onDiscard={discardAndClose}
      onSave={() => { void saveAndClose(); }}
    />
  </main>;
}
