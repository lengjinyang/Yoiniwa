import type { ContextMenuEntry } from '../ContextMenu';
import type { LayoutAction } from '../layout';
import type { ImageGroup, ImageItem, RecentScene, Scene, WindowState } from '../types';
import type { ShortcutPreferences } from '../keyboardShortcuts';
import { appCommand, type AppCommandRegistry } from './AppCommand';

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

  return [
    { type: 'item', label: `${scene.name}${dirty ? '  • 未保存' : ''}`, disabled: true },
    { type: 'separator' },
    { type: 'item', label: '大纲视图', checked: panels.outlineOpen, action: panels.toggleOutline },
    { type: 'item', label: '版本视图', checked: panels.versionsOpen, action: panels.toggleVersions },
    { type: 'separator' },
    {
      type: 'item', label: '文件', children: [
        { type: 'item', label: '打开…', shortcut: shortcuts.open, action: () => file.open() },
        { type: 'item', label: '合并其他画板…', action: file.importScene },
        {
          type: 'item', label: '最近打开', disabled: file.recent.length === 0,
          children: file.recent.length ? file.recent.slice(0, 8).map((item) => ({
            type: 'item' as const, label: item.name, action: () => file.open(item.path),
          })) : undefined,
        },
        { type: 'separator' },
        { type: 'item', label: '保存', shortcut: shortcuts.save, action: () => file.save(false) },
        { type: 'item', label: '另存为…', shortcut: shortcuts.saveAs, action: () => file.save(true) },
      ],
    },
    {
      type: 'item', label: '编辑', children: [
        { type: 'item', label: '撤销', shortcut: shortcuts.undo, disabled: !undoCommand.enabled, action: undoCommand.execute },
        { type: 'item', label: '重做', shortcut: shortcuts.redo, disabled: !redoCommand.enabled, action: redoCommand.execute },
        { type: 'separator' },
        { type: 'item', label: '全选', shortcut: 'Ctrl+A', disabled: scene.items.length === 0, action: selection.selectAll },
        { type: 'item', label: '复制', shortcut: 'Ctrl+C', disabled: !copyCommand.enabled, action: copyCommand.execute },
        { type: 'item', label: '剪切', shortcut: 'Ctrl+X', disabled: !cutCommand.enabled, action: cutCommand.execute },
        { type: 'item', label: '粘贴', shortcut: 'Ctrl+V', disabled: !pasteCommand.enabled, action: pasteCommand.execute },
        { type: 'item', label: '快速创建副本', shortcut: 'Ctrl+D', disabled: !duplicateCommand.enabled, action: duplicateCommand.execute },
        { type: 'item', label: '删除选中', shortcut: 'Delete', disabled: !deleteCommand.enabled, danger: true, action: deleteCommand.execute },
      ],
    },
    {
      type: 'item', label: '分组', disabled: !selection.selectedGroup && !createGroupCommand.enabled
        && selectedGroupedImageIds.length === 0 && (!hasImageSelection || joinGroupEntries.length === 0), children: [
        { type: 'item', label: '创建分组框', shortcut: 'Ctrl+G', disabled: !createGroupCommand.enabled, action: groups.create },
        { type: 'item', label: '加入组', disabled: !hasImageSelection || joinGroupEntries.length === 0, children: joinGroupEntries },
        { type: 'item', label: '将选中图片移出组', shortcut: 'Ctrl+Shift+G', disabled: selectedGroupedImageIds.length === 0, action: groups.detachSelected },
        { type: 'item', label: '重命名…', shortcut: 'F2', disabled: !selection.selectedGroup, action: groups.renameSelected },
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
        { type: 'item', label: '从组中移出', shortcut: 'Ctrl+Shift+G', disabled: selectedGroupedImageIds.length === 0, action: groups.detachSelected },
        { type: 'separator' },
        { type: 'item', label: selection.primary?.locked ? '解锁' : '锁定', shortcut: 'Alt+L', action: () => images.mutate((item) => { item.locked = !item.locked; }) },
        { type: 'item', label: '水平翻转', shortcut: 'Alt+Shift+H', action: () => images.mutate((item) => { item.flipX = !item.flipX; }) },
        { type: 'item', label: '垂直翻转', shortcut: 'Alt+Shift+V', action: () => images.mutate((item) => { item.flipY = !item.flipY; }) },
        { type: 'item', label: '重置变换', shortcut: 'Ctrl+Shift+T', action: images.resetTransform },
        { type: 'separator' },
        { type: 'item', label: '移到顶层', shortcut: '↑', action: () => images.moveLayer(true) },
        { type: 'item', label: '移到底层', shortcut: '↓', action: () => images.moveLayer(false) },
        { type: 'item', label: '恢复裁剪区域', shortcut: 'Ctrl+Shift+C', action: images.restoreFull },
        { type: 'item', label: selection.primary?.grayscale ? '恢复彩色' : '灰度去色', action: () => images.mutate((item) => { item.grayscale = !item.grayscale; }) },
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
        { type: 'item', label: '紧密排列', shortcut: 'Ctrl+P', disabled: layout.targetCount < 2, action: () => layout.run('pack') },
        { type: 'separator' },
        { type: 'item', label: '左对齐', shortcut: 'Ctrl+←', disabled: layout.targetCount < 2, action: () => layout.run('align-left') },
        { type: 'item', label: '右对齐', shortcut: 'Ctrl+→', disabled: layout.targetCount < 2, action: () => layout.run('align-right') },
        { type: 'item', label: '顶部对齐', shortcut: 'Ctrl+↑', disabled: layout.targetCount < 2, action: () => layout.run('align-top') },
        { type: 'item', label: '底部对齐', shortcut: 'Ctrl+↓', disabled: layout.targetCount < 2, action: () => layout.run('align-bottom') },
        { type: 'item', label: '水平分布', shortcut: 'Ctrl+Alt+Shift+↑', disabled: layout.targetCount < 2, action: () => layout.run('distribute-horizontal') },
        { type: 'item', label: '垂直分布', shortcut: 'Ctrl+Alt+Shift+↓', disabled: layout.targetCount < 2, action: () => layout.run('distribute-vertical') },
        { type: 'separator' },
        { type: 'item', label: '统一宽度', shortcut: 'Ctrl+Alt+→', disabled: layout.targetCount < 2, action: () => layout.run('normalize-width') },
        { type: 'item', label: '统一高度', shortcut: 'Ctrl+Alt+←', disabled: layout.targetCount < 2, action: () => layout.run('normalize-height') },
        { type: 'item', label: '统一尺寸', shortcut: 'Ctrl+Alt+↑', disabled: layout.targetCount < 2, action: () => layout.run('normalize-size') },
      ],
    },
    {
      type: 'item', label: '视图', children: [
        { type: 'item', label: '聚焦选中', shortcut: 'Space', disabled: !hasSelection, action: () => view.focusSelected(selection.selectedItems) },
        { type: 'item', label: '显示整个画板', shortcut: shortcuts.fitCanvas, disabled: !view.hasContent, action: view.fitCanvas },
        { type: 'item', label: '重置缩放为 1:1', shortcut: shortcuts.resetZoom, action: view.resetZoom },
        { type: 'item', label: '系统设置', shortcut: shortcuts.settings, checked: panels.propertiesOpen, action: panels.toggleProperties },
      ],
    },
    {
      type: 'item', label: '窗口', children: [
        { type: 'item', label: '协作模式', shortcut: shortcuts.collaboration, checked: window.collaborationMode,
          action: window.toggleCollaboration },
        { type: 'separator' },
        { type: 'item', label: '始终置顶', shortcut: shortcuts.alwaysOnTop, checked: window.mode.alwaysOnTop,
          disabled: window.collaborationMode, action: () => window.setMode({ alwaysOnTop: !window.mode.alwaysOnTop }) },
        { type: 'item', label: '锁定窗口位置', shortcut: shortcuts.lockWindow, checked: window.mode.locked,
          disabled: window.collaborationMode, action: () => window.setMode({ locked: !window.mode.locked }) },
        { type: 'item', label: '鼠标穿透', shortcut: shortcuts.clickThrough, checked: window.mode.clickThrough,
          action: () => window.setMode({ clickThrough: !window.mode.clickThrough }) },
        { type: 'range', label: '窗口透明度', min: 25, max: 100, value: window.mode.opacity * 100,
          onChange: (opacity) => window.setMode({ opacity: opacity / 100 }) },
        { type: 'separator' },
        { type: 'item', label: '最小化', shortcut: 'Ctrl+M', action: window.minimize },
        { type: 'item', label: '最大化 / 还原', shortcut: 'Ctrl+F', action: window.toggleMaximize },
      ],
    },
    {
      type: 'item', label: '导出', disabled: !view.hasContent, children: [
        { type: 'item', label: '画板为 PNG…', shortcut: 'Ctrl+E', action: () => exportActions.render(false, false, 'png') },
        { type: 'item', label: '画板为 JPEG…', action: () => exportActions.render(false, false, 'jpg') },
        { type: 'item', label: '导出选中…', shortcut: 'Ctrl+Shift+E', disabled: !hasSelection, action: () => exportActions.render(true) },
        { type: 'item', label: '复制合成图', action: () => exportActions.render(hasSelection, true) },
      ],
    },
    { type: 'separator' },
    { type: 'item', label: '新建画板', shortcut: shortcuts.newScene, action: application.newScene },
    { type: 'item', label: '退出画布', shortcut: 'Ctrl+Q', danger: true, action: application.close },
  ];
}
