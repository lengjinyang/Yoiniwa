import { useMemo, useRef, type Dispatch, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type SetStateAction } from 'react';
import { CanvasView } from '../../canvas/CanvasView';
import { videoPlaybackHostFromApi } from '../../canvas/video/videoPlaybackHost';
import { imageResourceBoostFromApi } from '../../canvas/textures/imageResourceBoost';
import { spaceKeyQueryFromApi } from '../../canvas/runtime/spaceKeyQuery';
import { ColorControl } from '../../ColorControl';
import { ContextMenu, type ContextMenuEntry } from '../../ContextMenu';
import type { useSceneHistory } from '../../useSceneHistory';
import type { useAppPreferences } from '../hooks/useAppPreferences';
import type { useColorPickerController } from '../hooks/useColorPickerController';
import type { useContextMenu } from '../hooks/useContextMenu';
import type { useImageImport } from '../hooks/useImageImport';
import type { usePhotoshopVersionController } from '../hooks/usePhotoshopVersionController';
import type { useProjectLifecycle } from '../hooks/useProjectLifecycle';
import type { useSceneWorkspaceController } from '../hooks/useSceneWorkspaceController';
import type { useStatusOperations } from '../hooks/useStatusOperations';
import type { useVisualNotes } from '../hooks/useVisualNotes';
import type { useWindowCollaborationController } from '../hooks/useWindowCollaborationController';
import { Button } from './CommonControls';
import { GroupActionMenu } from './GroupActionMenu';
import { GroupRenameDialog } from './GroupRenameDialog';
import { ImageImportProgress } from './ImageImportProgress';
import { OutlinePanel } from './OutlinePanel';
import { PhotoshopVersionComparePanel } from './PhotoshopVersionComparePanel';
import { PhotoshopVersionSaveDialog } from './PhotoshopVersionSaveDialog';
import { PhotoshopVersionsPanel } from './PhotoshopVersionsPanel';
import { PropertiesPanel } from './PropertiesPanel';
import { StatusToast } from './StatusToast';
import { UiIcon } from './UiIcon';
import { VisualNotesToolbar } from './VisualNotesToolbar';

type History = ReturnType<typeof useSceneHistory>;
type Workspace = ReturnType<typeof useSceneWorkspaceController>;
type Preferences = ReturnType<typeof useAppPreferences>;
type VisualNotes = ReturnType<typeof useVisualNotes>;
type Project = ReturnType<typeof useProjectLifecycle>;
type WindowController = ReturnType<typeof useWindowCollaborationController>;
type ColorPicker = ReturnType<typeof useColorPickerController>;
type Versions = ReturnType<typeof usePhotoshopVersionController>;
type ImageImport = ReturnType<typeof useImageImport>;
type Context = ReturnType<typeof useContextMenu>;
type StatusOperations = ReturnType<typeof useStatusOperations>;

interface PanelState {
  propertiesOpen: boolean;
  setPropertiesOpen: Dispatch<SetStateAction<boolean>>;
  outlineOpen: boolean;
  setOutlineOpen: Dispatch<SetStateAction<boolean>>;
}

interface AppWorkspaceProps {
  api: Window['refCanvas'];
  history: History;
  workspace: Workspace;
  preferences: Preferences;
  visualNotes: VisualNotes;
  project: Project;
  windowController: WindowController;
  colorPicker: ColorPicker;
  panels: PanelState;
  context: Context;
  photoshopDocumentBlocked: boolean;
}

export function AppWorkspace({
  api,
  history,
  workspace,
  preferences,
  visualNotes,
  project,
  windowController,
  colorPicker,
  panels,
  context,
  photoshopDocumentBlocked,
}: AppWorkspaceProps) {
  const videoPlayback = useMemo(() => videoPlaybackHostFromApi(api), [api]);
  const boostImageResource = useMemo(() => imageResourceBoostFromApi(api), [api]);
  const isSpaceDown = useMemo(() => spaceKeyQueryFromApi(api), [api]);
  return <section className="workspace">
    <CanvasView
      canvas={{
        background: history.scene.canvas.background,
        backgroundOpacity: history.scene.canvas.backgroundOpacity ?? 1,
        scene: history.scene,
        viewport: history.scene.viewport,
        projectEpoch: history.projectEpoch,
        onViewportCommit: project.onViewportCommit,
      }}
      selection={{
        selectedIds: workspace.selectedIds,
        selectedGroupId: workspace.selectedGroupId,
        lassoClearRequest: workspace.lassoClearRequest,
        onSelectionChange: workspace.onSelectionChange,
        onLassoSelectionChange: workspace.setLassoPoints,
        onGroupSelectionChange: workspace.onGroupSelectionChange,
        onItemsChanged: workspace.commitItemChanges,
        onFocusItem: workspace.focusItem,
      }}
      groups={{
        onGroupMoved: workspace.moveGroup,
        onGroupResized: workspace.resizeGroup,
        onRenameGroup: workspace.renameGroupById,
        onOpenGroupMenu: workspace.openGroupActions,
        onExpandGroup: (id) => workspace.changeGroup(id, { collapsed: false }),
        groupMenuOpen: Boolean(workspace.groupActionMenu),
        onGroupPreviewAnchor: workspace.moveGroupColorEditor,
      }}
      colorPicker={{
        colorPickerHeld: colorPicker.held,
        colorPickerShortcut: preferences.colorPickerShortcut,
        onColorPicked: (color) => { void colorPicker.syncPickedColor(color); },
      }}
      windowInteraction={{
        drawingCollaborationMode: windowController.drawingCollaborationMode,
        onContextMenu: (position) => {
          panels.setPropertiesOpen(false);
          workspace.setGroupActionMenu(undefined);
          context.open(position);
        },
        onExternalImageDrag: (items) => {
          if (!api || photoshopDocumentBlocked) return undefined;
          const assetIds = items.flatMap((item) => item.assetId ? [item.assetId] : []);
          return assetIds.length ? () => api.startImageDrag(assetIds) : undefined;
        },
        windowLocked: windowController.mode.locked,
        onWindowMoveStart: () => api?.beginWindowMove(),
        onWindowMove: () => api?.updateWindowMove(),
        onWindowMoveEnd: () => api?.endWindowMove(),
      }}
      visualNotes={visualNotes.canvas}
      videoPlayback={videoPlayback}
      boostImageResource={boostImageResource}
      isSpaceDown={isSpaceDown}
    />

    <PropertiesPanel
      open={panels.propertiesOpen}
      settingsShortcut={preferences.shortcuts.settings}
      shortcuts={preferences.shortcuts}
      shortcutCaptureId={preferences.shortcutCaptureId}
      drawingCollaborationMode={windowController.drawingCollaborationMode}
      cacheInfo={preferences.cacheInfo}
      cacheChanging={preferences.cacheChanging}
      nativeAvailable={Boolean(api)}
      onClose={() => panels.setPropertiesOpen(false)}
      onBeginShortcutCapture={preferences.beginShortcutCapture}
      onCaptureShortcut={preferences.captureShortcut}
      onCaptureShortcutKeyUp={preferences.captureShortcutKeyUp}
      onShortcutCaptureBlur={() => preferences.setShortcutCaptureId(undefined)}
      onResetShortcuts={preferences.resetShortcuts}
      onChooseCacheLocation={preferences.chooseCacheLocation}
      onResetCacheLocation={preferences.resetCacheLocation}
      onClearCache={preferences.clearCache}
      onOpenLogsFolder={preferences.openLogsFolder}
      onCopyDiagnostics={preferences.copyDiagnostics}
    />
  </section>;
}

interface AppOverlaysProps {
  api: Window['refCanvas'];
  history: History;
  workspace: Workspace;
  preferences: Preferences;
  visualNotes: VisualNotes;
  project: Project;
  windowController: WindowController;
  versions: Versions;
  imageImport: ImageImport;
  context: Context;
  statusOperations: StatusOperations;
  panels: PanelState;
  menuEntries: ContextMenuEntry[];
  sceneNameVisible: boolean;
  photoshopDocumentBlocked: boolean;
}

export function AppOverlays({
  api,
  history,
  workspace,
  preferences,
  visualNotes,
  project,
  windowController,
  versions,
  imageImport,
  context,
  statusOperations,
  panels,
  menuEntries,
  sceneNameVisible,
  photoshopDocumentBlocked,
}: AppOverlaysProps) {
  const comparison = versions.comparisonPreview;
  const emptyStateWindowDragRef = useRef<{ pointerId: number; startX: number; startY: number; moved: boolean } | undefined>(undefined);
  const suppressEmptyStateContextMenuRef = useRef(false);
  const startEmptyStateWindowDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse' || event.button !== 2 || windowController.mode.locked) return;
    suppressEmptyStateContextMenuRef.current = false;
    emptyStateWindowDragRef.current = {
      pointerId: event.pointerId, startX: event.screenX, startY: event.screenY, moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    api?.beginWindowMove();
    event.preventDefault();
    event.stopPropagation();
  };
  const moveEmptyStateWindow = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = emptyStateWindowDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moved && Math.hypot(event.screenX - drag.startX, event.screenY - drag.startY) >= 4) {
      drag.moved = true;
      suppressEmptyStateContextMenuRef.current = true;
    }
    if (drag.moved) api?.updateWindowMove();
    event.preventDefault();
    event.stopPropagation();
  };
  const endEmptyStateWindowDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = emptyStateWindowDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    emptyStateWindowDragRef.current = undefined;
    if (!drag.moved) suppressEmptyStateContextMenuRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    api?.endWindowMove();
    event.preventDefault();
    event.stopPropagation();
  };
  const openEmptyStateContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (suppressEmptyStateContextMenuRef.current) {
      suppressEmptyStateContextMenuRef.current = false;
      return;
    }
    panels.setPropertiesOpen(false);
    workspace.setGroupActionMenu(undefined);
    context.open({ x: event.clientX, y: event.clientY });
  };
  return <>
    {versions.comparisonVersion && <PhotoshopVersionComparePanel
      currentPreviewUrl={comparison.url}
      currentPreviewState={comparison.state}
      currentPreviewError={comparison.error}
      currentCapturedAt={comparison.capturedAt}
      currentLabel={comparison.documentName || 'Photoshop 当前文档'}
      version={versions.comparisonVersion}
      versions={versions.comparisonVersions}
      mode={versions.comparisonMode}
      split={versions.comparisonSplit}
      opacity={versions.comparisonOpacity}
      onModeChange={versions.setComparisonMode}
      onSplitChange={versions.setComparisonSplit}
      onOpacityChange={versions.setComparisonOpacity}
      onVersionChange={versions.setComparisonVersionId}
      onRefreshCurrent={versions.refreshComparisonPreview}
      onClose={versions.closeVersionComparison}
    />}

    <PhotoshopVersionsPanel
      open={versions.versionsOpen && !versions.comparisonVersionId}
      versions={project.photoshopMetadata.versions}
      documentBlocked={photoshopDocumentBlocked}
      onClose={versions.closeVersionsPanel}
      onSaveVersion={() => { void versions.openPhotoshopVersionSaveDialog(); }}
      onOpenVersion={(version) => { void versions.openPhotoshopVersion(version); }}
      onPlacePreview={(version) => { void versions.placePhotoshopVersionPreview(version); }}
      onCompare={versions.openVersionComparison}
      onDelete={(version) => { void versions.deletePhotoshopVersion(version); }}
    />

    <OutlinePanel
      open={panels.outlineOpen}
      scene={history.scene}
      selectedIds={workspace.selectedIds}
      selectedGroupId={workspace.selectedGroupId}
      onClose={() => panels.setOutlineOpen(false)}
      onSelectImage={workspace.selectOutlineImage}
      onFocusImage={workspace.focusOutlineImage}
      onSelectGroup={workspace.selectOutlineGroup}
      onFocusGroup={workspace.focusOutlineGroup}
      onToggleImageVisibility={workspace.toggleOutlineImageVisibility}
      onToggleImageLock={workspace.toggleOutlineImageLock}
      onMoveImageLayer={workspace.moveOutlineImageLayer}
    />

    <div className={`scene-name-badge no-drag${sceneNameVisible ? ' visible' : ''}`}
      title={project.displaySceneName}>
      {project.displaySceneName}{history.dirty ? '  •' : ''}
    </div>

    {!windowController.drawingCollaborationMode && <div className="window-control-zone no-drag">
      <div className="window-floating-controls">
        <button className={windowController.mode.alwaysOnTop ? 'active' : ''}
          title={windowController.mode.alwaysOnTop ? '取消始终置顶' : '始终置顶'}
          onClick={() => { void windowController.setMode({ alwaysOnTop: !windowController.mode.alwaysOnTop }); }}>
          <UiIcon name="pin" />
        </button>
        <button title={`协作模式 · ${preferences.shortcuts.collaboration}`} aria-pressed={false}
          onClick={() => { void windowController.toggleDrawingCollaborationMode(); }}>
          <UiIcon name="pen" />
        </button>
        <button title="最小化" onClick={() => api?.minimize()}><UiIcon name="minimize" /></button>
        <button title="最大化 / 还原" onClick={() => api?.toggleMaximize()}><UiIcon name="maximize" /></button>
        <button className="close" title="关闭" onClick={() => api?.close()}
          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}>
          <UiIcon name="close" />
        </button>
      </div>
    </div>}

    {context.position && <ContextMenu position={context.position} entries={menuEntries} onClose={context.close} />}
    <GroupActionMenu
      menu={workspace.groupActionMenu}
      groups={history.scene.groups}
      onOpenColor={(id, anchor) => workspace.setGroupColorEditor({ id, anchor })}
      onRename={workspace.renameGroupById}
      onChange={workspace.changeGroup}
      onToggleAutoFit={workspace.toggleGroupAutoFit}
      onDetachAll={(groupId, imageIds) => workspace.detachImages(imageIds, groupId)}
      onDelete={(groupId) => workspace.deleteGroupById(groupId, false)}
      onClose={() => workspace.setGroupActionMenu(undefined)}
    />

    {workspace.groupColorEditor && (() => {
      const group = history.scene.groups.find((value) => value.id === workspace.groupColorEditor?.id);
      return group ? <ColorControl groupPalette key={group.id} ref={workspace.groupColorEditorRef}
        label="组背景颜色" value={group.color} alpha={group.opacity}
        anchor={workspace.groupColorEditor.anchor} onClose={() => workspace.setGroupColorEditor(undefined)}
        onChange={(color) => workspace.changeGroup(group.id, { color })}
        onPresetChange={(color, opacity) => workspace.changeGroup(group.id, { color, opacity })}
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

    <PhotoshopVersionSaveDialog
      open={versions.saveDialogOpen}
      name={versions.versionName}
      note={versions.versionNote}
      onNameChange={versions.setVersionName}
      onNoteChange={versions.setVersionNote}
      onCancel={versions.closeSaveDialog}
      onSubmit={() => { void versions.savePhotoshopVersion(); }}
    />

    {workspace.renamingGroupId && <GroupRenameDialog
      key={workspace.renamingGroupId}
      draft={workspace.renameDraft}
      onDraftChange={workspace.setRenameDraft}
      onCancel={workspace.cancelGroupRename}
      onSubmit={workspace.finishGroupRename}
    />}

    <VisualNotesToolbar {...visualNotes.toolbarProps} />

    {!workspace.hasContent && <div className="empty-state no-drag"
      onPointerDown={startEmptyStateWindowDrag} onPointerMove={moveEmptyStateWindow}
      onPointerUp={endEmptyStateWindowDrag} onPointerCancel={endEmptyStateWindowDrag}
      onContextMenu={openEmptyStateContextMenu}>
      <img className="empty-brand-icon" src="./yoiniwa-icon.png" alt="宵庭 Logo" draggable={false} />
      <div className="empty-brand-name"><strong>Yoiniwa</strong><span>宵庭</span></div>
      <h1>建立你的参考画板</h1>
      <p>拖入图片或视频、粘贴截图，或从电脑中选择媒体。</p>
      <Button onClick={imageImport.importImages}>选择图片/视频</Button>
      {project.recent.length > 0 && <section className="empty-recent" aria-label="最近的文件">
        <header><strong>最近的文件</strong><span>{project.recent.length}</span></header>
        <div className="empty-recent-list">
          {project.recent.slice(0, 6).map((item) => <button type="button" key={item.path}
            title={item.path} onClick={() => { void project.open(item.path); }}>
            <span className="empty-recent-icon"><UiIcon name="file" size={17} /></span>
            <span className="empty-recent-copy"><strong>{item.name}</strong><small>{item.path}</small></span>
            <time dateTime={item.openedAt}>{new Date(item.openedAt).toLocaleDateString()}</time>
          </button>)}
        </div>
      </section>}
    </div>}

    <ImageImportProgress progress={imageImport.progress} />
    {!imageImport.progress && <StatusToast status={statusOperations.status} operation={statusOperations.operation} />}
  </>;
}
