export const SHORTCUT_PREFERENCES_STORAGE_KEY = 'refcanvas.shortcuts';

const SHORTCUT_IDS = [
  'settings',
  'save',
  'saveAs',
  'undo',
  'redo',
  'redoAlternate',
  'open',
  'openLatest',
  'newScene',
  'importImages',
  'exportBoard',
  'exportSelected',
  'copy',
  'cut',
  'paste',
  'duplicate',
  'selectAll',
  'deleteSelection',
  'createGroup',
  'detachGroup',
  'renameGroup',
  'restoreCrop',
  'resetTransform',
  'flipHorizontal',
  'flipVertical',
  'toggleImageLock',
  'moveFront',
  'moveBack',
  'pack',
  'packAndFit',
  'alignLeft',
  'alignRight',
  'alignTop',
  'alignBottom',
  'normalizeWidth',
  'normalizeHeight',
  'normalizeSize',
  'normalizeSizeAlternate',
  'fitCanvas',
  'fitCanvasAlternate',
  'resetZoom',
  'toggleFocus',
  'focusNext',
  'focusPrevious',
  'zoomIn',
  'zoomOut',
  'openMenu',
  'boxSelect',
  'colorPicker',
  'visualNotesToggle',
  'visualNotesHide',
  'visualNotesBrush',
  'visualNotesBrushAlternate',
  'visualNotesArrow',
  'visualNotesEraser',
  'visualNotesEraserAlternate',
  'alwaysOnTop',
  'lockWindow',
  'clickThrough',
  'opacityUp',
  'opacityDown',
  'maximize',
  'minimize',
  'closeWindow',
  'collaboration',
  'escape',
] as const;

export type ShortcutId = typeof SHORTCUT_IDS[number];
export type ShortcutPreferences = Record<ShortcutId, string>;

export const DEFAULT_SHORTCUTS: ShortcutPreferences = {
  settings: 'Tab',
  save: 'Ctrl+S',
  saveAs: 'Ctrl+Shift+S',
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Shift+Z',
  redoAlternate: 'Ctrl+Y',
  open: 'Ctrl+L',
  openLatest: 'Ctrl+Shift+L',
  newScene: 'Ctrl+K',
  importImages: 'Ctrl+I',
  exportBoard: 'Ctrl+E',
  exportSelected: 'Ctrl+Shift+E',
  copy: 'Ctrl+C',
  cut: 'Ctrl+X',
  paste: 'Ctrl+V',
  duplicate: 'Ctrl+D',
  selectAll: 'Ctrl+A',
  deleteSelection: 'Delete',
  createGroup: 'Ctrl+G',
  detachGroup: 'Ctrl+Shift+G',
  renameGroup: 'F2',
  restoreCrop: 'Ctrl+Shift+C',
  resetTransform: 'Ctrl+Shift+T',
  flipHorizontal: 'Alt+Shift+H',
  flipVertical: 'Alt+Shift+V',
  toggleImageLock: 'Alt+L',
  moveFront: 'ArrowUp',
  moveBack: 'ArrowDown',
  pack: 'Ctrl+P',
  packAndFit: 'Ctrl+Alt+P',
  alignLeft: 'Ctrl+ArrowLeft',
  alignRight: 'Ctrl+ArrowRight',
  alignTop: 'Ctrl+ArrowUp',
  alignBottom: 'Ctrl+ArrowDown',
  normalizeWidth: 'Ctrl+Alt+ArrowRight',
  normalizeHeight: 'Ctrl+Alt+ArrowLeft',
  normalizeSize: 'Ctrl+Alt+ArrowUp',
  normalizeSizeAlternate: 'Ctrl+Alt+ArrowDown',
  fitCanvas: 'Ctrl+Space',
  fitCanvasAlternate: 'Ctrl+O',
  resetZoom: 'Ctrl+0',
  toggleFocus: 'Space',
  focusNext: 'ArrowRight',
  focusPrevious: 'ArrowLeft',
  zoomIn: 'Ctrl+=',
  zoomOut: 'Ctrl+-',
  openMenu: 'Ctrl+Shift+P',
  boxSelect: 'D',
  colorPicker: 'S',
  visualNotesToggle: 'Q',
  visualNotesHide: 'H',
  visualNotesBrush: 'B',
  visualNotesBrushAlternate: '1',
  visualNotesArrow: '2',
  visualNotesEraser: 'E',
  visualNotesEraserAlternate: '3',
  alwaysOnTop: 'Ctrl+Shift+A',
  lockWindow: 'Ctrl+W',
  clickThrough: 'Ctrl+T',
  opacityUp: 'Ctrl+Shift+=',
  opacityDown: 'Ctrl+Shift+-',
  maximize: 'Ctrl+F',
  minimize: 'Ctrl+M',
  closeWindow: 'Ctrl+Q',
  collaboration: 'Ctrl+Alt+Y',
  escape: 'Escape',
};

export const SHORTCUT_LABELS: ReadonlyArray<{ id: ShortcutId; label: string; group: string }> = [
  { id: 'settings', label: '打开设置', group: '应用' },
  { id: 'openMenu', label: '打开主菜单', group: '应用' },
  { id: 'escape', label: '退出 / 取消', group: '应用' },
  { id: 'open', label: '打开画板', group: '文件' },
  { id: 'openLatest', label: '打开最近画板', group: '文件' },
  { id: 'newScene', label: '新建画板', group: '文件' },
  { id: 'save', label: '保存画板', group: '文件' },
  { id: 'saveAs', label: '另存为', group: '文件' },
  { id: 'importImages', label: '导入图片', group: '文件' },
  { id: 'exportBoard', label: '导出画板', group: '文件' },
  { id: 'exportSelected', label: '导出选中', group: '文件' },
  { id: 'undo', label: '撤销', group: '编辑' },
  { id: 'redo', label: '重做', group: '编辑' },
  { id: 'redoAlternate', label: '重做（备用）', group: '编辑' },
  { id: 'copy', label: '复制', group: '编辑' },
  { id: 'cut', label: '剪切', group: '编辑' },
  { id: 'paste', label: '粘贴', group: '编辑' },
  { id: 'duplicate', label: '快速创建副本', group: '编辑' },
  { id: 'selectAll', label: '全选', group: '编辑' },
  { id: 'deleteSelection', label: '删除选中', group: '编辑' },
  { id: 'createGroup', label: '创建分组框', group: '分组与图片' },
  { id: 'detachGroup', label: '移出分组', group: '分组与图片' },
  { id: 'renameGroup', label: '重命名分组', group: '分组与图片' },
  { id: 'toggleImageLock', label: '锁定图片', group: '分组与图片' },
  { id: 'flipHorizontal', label: '水平翻转', group: '分组与图片' },
  { id: 'flipVertical', label: '垂直翻转', group: '分组与图片' },
  { id: 'resetTransform', label: '重置变换', group: '分组与图片' },
  { id: 'restoreCrop', label: '恢复裁剪区域', group: '分组与图片' },
  { id: 'moveFront', label: '移到顶层', group: '分组与图片' },
  { id: 'moveBack', label: '移到底层', group: '分组与图片' },
  { id: 'pack', label: '紧密排列', group: '排列' },
  { id: 'packAndFit', label: '排列并适配画板', group: '排列' },
  { id: 'alignLeft', label: '左对齐', group: '排列' },
  { id: 'alignRight', label: '右对齐', group: '排列' },
  { id: 'alignTop', label: '顶部对齐', group: '排列' },
  { id: 'alignBottom', label: '底部对齐', group: '排列' },
  { id: 'normalizeWidth', label: '统一宽度', group: '排列' },
  { id: 'normalizeHeight', label: '统一高度', group: '排列' },
  { id: 'normalizeSize', label: '统一尺寸', group: '排列' },
  { id: 'normalizeSizeAlternate', label: '统一尺寸（备用）', group: '排列' },
  { id: 'fitCanvas', label: '显示整个画板', group: '画布与视图' },
  { id: 'fitCanvasAlternate', label: '显示整个画板（备用）', group: '画布与视图' },
  { id: 'resetZoom', label: '重置缩放', group: '画布与视图' },
  { id: 'toggleFocus', label: '聚焦选中', group: '画布与视图' },
  { id: 'focusNext', label: '下一个焦点对象', group: '画布与视图' },
  { id: 'focusPrevious', label: '上一个焦点对象', group: '画布与视图' },
  { id: 'zoomIn', label: '放大', group: '画布与视图' },
  { id: 'zoomOut', label: '缩小', group: '画布与视图' },
  { id: 'boxSelect', label: '框选', group: '画布与视图' },
  { id: 'colorPicker', label: '取色', group: '画布与视图' },
  { id: 'visualNotesToggle', label: '标注模式', group: '标注' },
  { id: 'visualNotesHide', label: '临时隐藏标注', group: '标注' },
  { id: 'visualNotesBrush', label: '标注画笔', group: '标注' },
  { id: 'visualNotesBrushAlternate', label: '标注画笔（备用）', group: '标注' },
  { id: 'visualNotesArrow', label: '标注箭头', group: '标注' },
  { id: 'visualNotesEraser', label: '标注橡皮擦', group: '标注' },
  { id: 'visualNotesEraserAlternate', label: '标注橡皮擦（备用）', group: '标注' },
  { id: 'alwaysOnTop', label: '始终置顶', group: '窗口' },
  { id: 'lockWindow', label: '锁定窗口位置', group: '窗口' },
  { id: 'clickThrough', label: '鼠标穿透', group: '窗口' },
  { id: 'opacityUp', label: '增加窗口透明度', group: '窗口' },
  { id: 'opacityDown', label: '降低窗口透明度', group: '窗口' },
  { id: 'maximize', label: '最大化 / 还原', group: '窗口' },
  { id: 'minimize', label: '最小化', group: '窗口' },
  { id: 'closeWindow', label: '关闭画板', group: '窗口' },
  { id: 'collaboration', label: '协作模式（全局）', group: '窗口' },
];

// These native recovery accelerators stay fixed so a bad window state can
// still be recovered even when the renderer is locked or not focused.
const RESERVED_SYSTEM_SHORTCUTS = new Map<string, string>([
  ['Ctrl+Alt+Shift+T', '解除鼠标穿透兜底'],
  ['Ctrl+Alt+Shift+Y', '协作模式退出兜底'],
]);

function keyFromEvent(event: Pick<KeyboardEvent, 'key' | 'code'>) {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
  if (event.code === 'Minus') return '-';
  if (event.code === 'Equal') return '=';
  if (/^F(?:[1-9]|1\d|2[0-4])$/.test(event.key)) return event.key;
  if (['Tab', 'Space', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return event.key;
  if (event.code === 'Space') return 'Space';
  if (event.key === '-' || event.key === '=') return event.key;
  return undefined;
}

export function shortcutFromKeyboardEvent(event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>) {
  const key = keyFromEvent(event);
  if (!key || ['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return undefined;
  const modifiers = [
    event.ctrlKey || event.metaKey ? 'Ctrl' : undefined,
    event.altKey ? 'Alt' : undefined,
    event.shiftKey ? 'Shift' : undefined,
  ].filter((value): value is string => Boolean(value));
  return [...modifiers, key].join('+');
}

export function shortcutMatchesEvent(shortcut: string, event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>) {
  return shortcutFromKeyboardEvent(event) === shortcut;
}

function modifierFromEventKey(key: string) {
  if (key === 'Control') return 'Ctrl';
  if (key === 'Alt' || key === 'Shift') return key;
  return undefined;
}

export function panModifierShortcutFromKeyboardEvent(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
) {
  const modifier = modifierFromEventKey(event.key);
  if (!modifier) return undefined;
  return [
    event.ctrlKey || event.metaKey || modifier === 'Ctrl' ? 'Ctrl' : undefined,
    event.altKey || modifier === 'Alt' ? 'Alt' : undefined,
    event.shiftKey || modifier === 'Shift' ? 'Shift' : undefined,
  ].filter((value): value is string => Boolean(value)).join('+');
}

export function shortcutMatchesKeyboardEvent(
  shortcut: string,
  event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
) {
  const modifier = modifierFromEventKey(event.key);
  const parts = shortcut.split('+');
  const modifierOnly = parts.every((part) => ['Ctrl', 'Alt', 'Shift'].includes(part));
  if (modifier && modifierOnly) {
    return (event.ctrlKey || event.metaKey) === parts.includes('Ctrl')
      && event.altKey === parts.includes('Alt')
      && event.shiftKey === parts.includes('Shift');
  }
  return shortcutMatchesEvent(shortcut, event);
}

export function shortcutReleasedByKeyboardEvent(shortcut: string, event: Pick<KeyboardEvent, 'key' | 'code'>) {
  const released = modifierFromEventKey(event.key) ?? keyFromEvent(event);
  return Boolean(released && shortcut.split('+').includes(released));
}

export function shortcutDisplayName(shortcut: string) {
  return shortcut.replace(/ArrowUp/g, '↑').replace(/ArrowDown/g, '↓').replace(/ArrowLeft/g, '←').replace(/ArrowRight/g, '→');
}

export function shortcutConflict(preferences: ShortcutPreferences, changedId: ShortcutId, shortcut: string) {
  const reserved = RESERVED_SYSTEM_SHORTCUTS.get(shortcut);
  if (reserved) return `已被${reserved}占用`;
  const matching = SHORTCUT_IDS.find((id) => id !== changedId && preferences[id] === shortcut);
  if (!matching) return undefined;
  return `已用于${SHORTCUT_LABELS.find((item) => item.id === matching)?.label ?? '其他操作'}`;
}

function isValidShortcut(shortcut: string) {
  if (!shortcut || shortcut.length > 80) return false;
  const parts = shortcut.split('+');
  const key = parts.at(-1);
  const modifiers = parts.slice(0, -1);
  if (!key || modifiers.some((modifier) => !['Ctrl', 'Alt', 'Shift'].includes(modifier))) return false;
  if (new Set(modifiers).size !== modifiers.length) return false;
  return /^[A-Z0-9]$|^F(?:[1-9]|1\d|2[0-4])$|^(?:Tab|Space|Delete|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$|^(?:-|=)$/.test(key);
}

function isValidConfigurableShortcut(shortcut: string) {
  if (isValidShortcut(shortcut)) return true;
  const parts = shortcut.split('+');
  return parts.length > 0
    && new Set(parts).size === parts.length
    && parts.every((part) => ['Ctrl', 'Alt', 'Shift'].includes(part));
}

export function loadShortcutPreferences(raw: string | null): ShortcutPreferences {
  if (!raw) return { ...DEFAULT_SHORTCUTS };
  try {
    const parsed = JSON.parse(raw) as Partial<Record<ShortcutId, unknown>>;
    const values = { ...DEFAULT_SHORTCUTS };
    for (const id of SHORTCUT_IDS) {
      if (typeof parsed[id] === 'string' && isValidConfigurableShortcut(parsed[id])) {
        values[id] = parsed[id];
      }
    }
    return values;
  } catch {
    return { ...DEFAULT_SHORTCUTS };
  }
}
