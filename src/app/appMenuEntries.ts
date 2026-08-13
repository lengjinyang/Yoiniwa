import type { ContextMenuEntry } from '../ContextMenu';
import type { LayoutAction } from '../layout';
import type { ImageGroup, ImageItem, RecentScene, Scene, WindowState } from '../types';
import { shortcutDisplayName, type ShortcutPreferences } from '../keyboardShortcuts';
import { imageGrayscaleContrast, setImageGrayscaleContrast } from '../imageAdjustments';
import { appCommand, type AppCommandRegistry } from './AppCommand';
import { isVideoItem } from '../media';

interface BuildAppMenuEntriesOptions {
  scene: Scene;
  dirty: boolean;
  shortcuts: ShortcutPreferences;
  commands: AppCommandRegistry;
  panels: {
    outlineOpen: boolean;
    versionsOpen: boolean;
    propertiesOpen: boolean;
    toggleOutline(): void;
    toggleVersions(): void;
    toggleProperties(): void;
  };
  file: {
    recent: RecentScene[];
    open(path?: string): void;
    importScene(): void;
    save(saveAs: boolean): void;
  };
  selection: {
    selectedIds: string[];
    selectedItems: ImageItem[];
    selectedGroup?: ImageGroup;
    primary?: ImageItem;
    selectAll(): void;
  };
  groups: {
    create(): void;
    addImages(imageIds: readonly string[], groupId: string): void;
    detachSelected(): void;
    renameSelected(): void;
    change(groupId: string, patch: Partial<ImageGroup>): void;
    ungroupSelected(): void;
    deleteSelected(withContents: boolean): void;
  };
  images: {
    mutate(updater: (item: ImageItem) => void): void;
    preview(updater: (item: ImageItem) => void): void;
    beginAdjustment(): void;
    commitAdjustment(): void;
    resetTransform(): void;
    moveLayer(toFront: boolean): void;
    restoreFull(): void;
    showSource(): void;
  };
  photoshop: {
    blocked: boolean;
    sendSelected(mode: 'layer' | 'image'): void;
    saveVersion(): void;
  };
  layout: {
    targetCount: number;
    run(action: LayoutAction): void;
    packAndFit(): void;
  };
  view: {
    hasContent: boolean;
    focusSelected(items: ImageItem[]): void;
    fitCanvas(): void;
    resetZoom(): void;
  };
  window: {
    mode: WindowState;
    collaborationMode: boolean;
    toggleCollaboration(): void;
    setMode(patch: Partial<WindowState>): void;
    minimize(): void;
    toggleMaximize(): void;
  };
  export: {
    render(onlySelected: boolean, copy?: boolean, format?: 'png' | 'jpg'): void;
    originals(): void;
    copyOriginal(): void;
  };
  application: {
    newScene(): void;
    close(): void;
  };
}

export function buildAppMenuEntries({
  scene,
  dirty,
  shortcuts,
  commands,
  panels,
  file,
  selection,
  groups,
  images,
  photoshop,
  layout,
  view,
  window,
  export: exportActions,
  application,
}: BuildAppMenuEntriesOptions): ContextMenuEntry[] {
  const displayShortcut = (id: keyof ShortcutPreferences) => shortcutDisplayName(shortcuts[id]);
  const hasSelection = selection.selectedIds.length > 0;
  const hasImageSelection = selection.selectedIds.length > 0;
  const selectedGroupedImageIds = selection.selectedIds.filter((id) => scene.groups.some((group) =>
    group.members.some((member) => member.type === 'image' && member.id === id)));
  const joinGroupEntries: ContextMenuEntry[] = scene.groups.map((group) => {
    const alreadyJoined = selection.selectedIds.length > 0 && selection.selectedIds.every((id) => group.members.some((member) =>
      member.type === 'image' && member.id === id));
    return {
      type: 'item',
      label: group.name,
      checked: alreadyJoined,
      disabled: alreadyJoined,
      action: () => groups.addImages(selection.selectedIds, group.id),
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
  const grayscale = Boolean(selection.primary?.grayscale);
  const grayscaleContrast = selection.primary ? imageGrayscaleContrast(selection.primary) : 1;
  const primaryIsVideo = selection.primary ? isVideoItem(selection.primary, scene.assets) : false;
  const selectedVideos = selection.selectedItems.filter((item) => isVideoItem(item, scene.assets));

  return [
    { type: 'item', label: `${scene.name}${dirty ? '  • 未保存' : ''}`, disabled: true },
    { type: 'separator' },
    { type: 'item', label: '大纲视图', checked: panels.outlineOpen, action: panels.toggleOutline },
    { type: 'item', label: '版本视图', checked: panels.versionsOpen, action: panels.toggleVersions },
    { type: 'separator' },
    {
      type: 'item', label: '文件', children: [
        { type: 'item', label: '打开…', shortcut: displayShortcut('open'), action: () => file.open() },
        { type: 'item', label: '合并其他画板…', action: file.importScene },
        {
          type: 'item', label: '最近的文件', shortcut: displayShortcut('openLatest'), disabled: file.recent.length === 0,
          children: file.recent.length ? file.recent.slice(0, 12).map((item) => ({
            type: 'item' as const,
            label: item.name,
            shortcut: new Date(item.openedAt).toLocaleDateString(),
            action: () => file.open(item.path),
          })) : undefined,
        },
        { type: 'separator' },
        { type: 'item', label: '保存', shortcut: displayShortcut('save'), action: () => file.save(false) },
        { type: 'item', label: '另存为…', shortcut: displayShortcut('saveAs'), action: () => file.save(true) },
      ],
    },
    {
      type: 'item', label: '编辑', children: [
        { type: 'item', label: '撤销', shortcut: displayShortcut('undo'), disabled: !undoCommand.enabled, action: undoCommand.execute },
        { type: 'item', label: '重做', shortcut: displayShortcut('redo'), disabled: !redoCommand.enabled, action: redoCommand.execute },
        { type: 'separator' },
        { type: 'item', label: '全选', shortcut: displayShortcut('selectAll'), disabled: scene.items.length === 0, action: selection.selectAll },
        { type: 'item', label: '复制', shortcut: displayShortcut('copy'), disabled: !copyCommand.enabled, action: copyCommand.execute },
        { type: 'item', label: '剪切', shortcut: displayShortcut('cut'), disabled: !cutCommand.enabled, action: cutCommand.execute },
        { type: 'item', label: '粘贴', shortcut: displayShortcut('paste'), disabled: !pasteCommand.enabled, action: pasteCommand.execute },
        { type: 'item', label: '快速创建副本', shortcut: displayShortcut('duplicate'), disabled: !duplicateCommand.enabled, action: duplicateCommand.execute },
        { type: 'item', label: '删除选中', shortcut: displayShortcut('deleteSelection'), disabled: !deleteCommand.enabled, danger: true, action: deleteCommand.execute },
      ],
    },
    {
      type: 'item', label: '分组', disabled: !selection.selectedGroup && !createGroupCommand.enabled
        && selectedGroupedImageIds.length === 0 && (!hasImageSelection || joinGroupEntries.length === 0), children: [
        { type: 'item', label: '创建分组框', shortcut: displayShortcut('createGroup'), disabled: !createGroupCommand.enabled, action: groups.create },
        { type: 'item', label: '加入组', disabled: !hasImageSelection || joinGroupEntries.length === 0, children: joinGroupEntries },
        { type: 'item', label: '将选中图片移出组', shortcut: displayShortcut('detachGroup'), disabled: selectedGroupedImageIds.length === 0, action: groups.detachSelected },
        { type: 'item', label: '重命名…', shortcut: displayShortcut('renameGroup'), disabled: !selection.selectedGroup, action: groups.renameSelected },
        { type: 'separator' },
        { type: 'item', label: selection.selectedGroup?.collapsed ? '展开' : '折叠', disabled: !selection.selectedGroup,
          action: () => { if (selection.selectedGroup) groups.change(selection.selectedGroup.id, { collapsed: !selection.selectedGroup.collapsed }); } },
        { type: 'separator' },
        { type: 'item', label: '清空成员', disabled: !selection.selectedGroup, action: groups.ungroupSelected },
        { type: 'item', label: '删除组框', disabled: !selection.selectedGroup, action: () => groups.deleteSelected(false) },
      ],
    },
    {
      type: 'item', label: '图片', disabled: !hasImageSelection, children: hasImageSelection ? [
        { type: 'item', label: '加入组', disabled: joinGroupEntries.length === 0, children: joinGroupEntries },
        { type: 'item', label: '从组中移出', shortcut: displayShortcut('detachGroup'), disabled: selectedGroupedImageIds.length === 0, action: groups.detachSelected },
        { type: 'separator' },
        { type: 'item', label: selection.primary?.locked ? '解锁' : '锁定', shortcut: displayShortcut('toggleImageLock'), action: () => images.mutate((item) => { item.locked = !item.locked; }) },
        { type: 'item', label: '水平翻转', shortcut: displayShortcut('flipHorizontal'), action: () => images.mutate((item) => { item.flipX = !item.flipX; }) },
        { type: 'item', label: '垂直翻转', shortcut: displayShortcut('flipVertical'), action: () => images.mutate((item) => { item.flipY = !item.flipY; }) },
        { type: 'item', label: '重置变换', shortcut: displayShortcut('resetTransform'), action: images.resetTransform },
        { type: 'separator' },
        { type: 'item', label: '移到顶层', shortcut: displayShortcut('moveFront'), action: () => images.moveLayer(true) },
        { type: 'item', label: '移到底层', shortcut: displayShortcut('moveBack'), action: () => images.moveLayer(false) },
        { type: 'item', label: '恢复裁剪区域', shortcut: displayShortcut('restoreCrop'), action: images.restoreFull, disabled: primaryIsVideo },
        { type: 'item', label: grayscale ? '恢复彩色' : '灰度去色', disabled: primaryIsVideo,
          action: () => images.mutate((item) => { item.grayscale = !item.grayscale; }) },
        ...(grayscale && !primaryIsVideo ? [{
          type: 'range' as const, label: '灰度对比度', min: 0, max: 200, step: 5, value: grayscaleContrast * 100,
          onInteractionStart: images.beginAdjustment,
          onChange: (contrast: number) => images.preview((item) => setImageGrayscaleContrast(item, contrast / 100)),
          onInteractionEnd: images.commitAdjustment,
        }] : []),
        ...(selectedVideos.length ? [
          { type: 'separator' as const },
          {
            type: 'item' as const,
            label: selection.primary?.muted === false ? '静音' : '取消静音',
            action: () => images.mutate((item) => {
              if (!isVideoItem(item, scene.assets)) return;
              item.muted = item.muted === false;
            }),
          },
          {
            type: 'item' as const,
            label: selection.primary?.loop === false ? '循环播放' : '关闭循环',
            action: () => images.mutate((item) => {
              if (!isVideoItem(item, scene.assets)) return;
              item.loop = item.loop === false;
            }),
          },
        ] : []),
        { type: 'item', label: '打开源文件位置', disabled: !selection.primary?.sourcePath, action: images.showSource },
      ] : undefined,
    },
    {
      type: 'item', label: '传输', children: [
        { type: 'item', label: '将选中内容作为图层发送', disabled: !hasImageSelection || photoshop.blocked,
          action: () => photoshop.sendSelected('layer') },
        { type: 'item', label: '将选中内容作为新图像打开', disabled: !hasImageSelection || photoshop.blocked,
          action: () => photoshop.sendSelected('image') },
        { type: 'separator' },
        { type: 'item', label: '保存当前 Photoshop 版本…', disabled: photoshop.blocked, action: photoshop.saveVersion },
      ],
    },
    {
      type: 'item', label: '排列', disabled: layout.targetCount < 2, children: [
        { type: 'item', label: '紧密排列', shortcut: displayShortcut('pack'), disabled: layout.targetCount < 2, action: () => layout.run('pack') },
        { type: 'item', label: '排列并适配画板', shortcut: displayShortcut('packAndFit'), disabled: layout.targetCount < 2, action: layout.packAndFit },
        { type: 'separator' },
        { type: 'item', label: '左对齐', shortcut: displayShortcut('alignLeft'), disabled: layout.targetCount < 2, action: () => layout.run('align-left') },
        { type: 'item', label: '右对齐', shortcut: displayShortcut('alignRight'), disabled: layout.targetCount < 2, action: () => layout.run('align-right') },
        { type: 'item', label: '顶部对齐', shortcut: displayShortcut('alignTop'), disabled: layout.targetCount < 2, action: () => layout.run('align-top') },
        { type: 'item', label: '底部对齐', shortcut: displayShortcut('alignBottom'), disabled: layout.targetCount < 2, action: () => layout.run('align-bottom') },
        { type: 'separator' },
        { type: 'item', label: '统一宽度', shortcut: displayShortcut('normalizeWidth'), disabled: layout.targetCount < 2, action: () => layout.run('normalize-width') },
        { type: 'item', label: '统一高度', shortcut: displayShortcut('normalizeHeight'), disabled: layout.targetCount < 2, action: () => layout.run('normalize-height') },
        { type: 'item', label: '统一尺寸', shortcut: displayShortcut('normalizeSize'), disabled: layout.targetCount < 2, action: () => layout.run('normalize-size') },
      ],
    },
    {
      type: 'item', label: '视图', children: [
        { type: 'item', label: '聚焦选中', shortcut: displayShortcut('toggleFocus'), disabled: !hasSelection, action: () => view.focusSelected(selection.selectedItems) },
        { type: 'item', label: '显示整个画板', shortcut: displayShortcut('fitCanvas'), disabled: !view.hasContent, action: view.fitCanvas },
        { type: 'item', label: '重置缩放为 1:1', shortcut: displayShortcut('resetZoom'), action: view.resetZoom },
        { type: 'item', label: '系统设置', shortcut: displayShortcut('settings'), checked: panels.propertiesOpen, action: panels.toggleProperties },
      ],
    },
    {
      type: 'item', label: '窗口', children: [
        { type: 'item', label: '协作模式', shortcut: displayShortcut('collaboration'), checked: window.collaborationMode,
          action: window.toggleCollaboration },
        { type: 'separator' },
        { type: 'item', label: '始终置顶', shortcut: displayShortcut('alwaysOnTop'), checked: window.mode.alwaysOnTop,
          disabled: window.collaborationMode, action: () => window.setMode({ alwaysOnTop: !window.mode.alwaysOnTop }) },
        { type: 'item', label: '锁定窗口位置', shortcut: displayShortcut('lockWindow'), checked: window.mode.locked,
          disabled: window.collaborationMode, action: () => window.setMode({ locked: !window.mode.locked }) },
        { type: 'item', label: '鼠标穿透', shortcut: displayShortcut('clickThrough'), checked: window.mode.clickThrough,
          action: () => window.setMode({ clickThrough: !window.mode.clickThrough }) },
        { type: 'range', label: '窗口透明度', min: 25, max: 100, value: window.mode.opacity * 100,
          onChange: (opacity) => window.setMode({ opacity: opacity / 100 }) },
        { type: 'separator' },
        { type: 'item', label: '最小化', shortcut: displayShortcut('minimize'), action: window.minimize },
        { type: 'item', label: '最大化 / 还原', shortcut: displayShortcut('maximize'), action: window.toggleMaximize },
      ],
    },
    {
      type: 'item', label: '导出', disabled: !view.hasContent, children: [
        { type: 'item', label: '画板为 PNG…', shortcut: displayShortcut('exportBoard'), action: () => exportActions.render(false, false, 'png') },
        { type: 'item', label: '画板为 JPEG…', action: () => exportActions.render(false, false, 'jpg') },
        { type: 'item', label: '导出选中…', shortcut: displayShortcut('exportSelected'), disabled: !hasSelection, action: () => exportActions.render(true) },
        { type: 'item', label: '导出选中原图…', disabled: !hasImageSelection, action: exportActions.originals },
        { type: 'item', label: '复制合成图', action: () => exportActions.render(hasSelection, true) },
        { type: 'item', label: '复制选中原图', disabled: selection.selectedItems.length !== 1, action: exportActions.copyOriginal },
      ],
    },
    { type: 'separator' },
    { type: 'item', label: '新建画板', shortcut: displayShortcut('newScene'), action: application.newScene },
    { type: 'item', label: '退出画布', shortcut: displayShortcut('closeWindow'), danger: true, action: application.close },
  ];
}
