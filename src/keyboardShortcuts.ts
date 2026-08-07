export const SHORTCUT_PREFERENCES_STORAGE_KEY = 'refcanvas.shortcuts';

const SHORTCUT_IDS = [
  'settings',
  'save',
  'saveAs',
  'undo',
  'redo',
  'open',
  'newScene',
  'fitCanvas',
  'resetZoom',
  'alwaysOnTop',
  'lockWindow',
  'clickThrough',
  'collaboration',
] as const;

export type ShortcutId = typeof SHORTCUT_IDS[number];
export type ShortcutPreferences = Record<ShortcutId, string>;

export const DEFAULT_SHORTCUTS: ShortcutPreferences = {
  settings: 'Tab',
  save: 'Ctrl+S',
  saveAs: 'Ctrl+Shift+S',
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Shift+Z',
  open: 'Ctrl+L',
  newScene: 'Ctrl+K',
  fitCanvas: 'Ctrl+Space',
  resetZoom: 'Ctrl+0',
  alwaysOnTop: 'Ctrl+Shift+A',
  lockWindow: 'Ctrl+W',
  clickThrough: 'Ctrl+T',
  collaboration: 'Ctrl+Alt+Y',
};

export const SHORTCUT_LABELS: ReadonlyArray<{ id: ShortcutId; label: string }> = [
  { id: 'settings', label: '打开设置' },
  { id: 'save', label: '保存画板' },
  { id: 'saveAs', label: '另存为' },
  { id: 'undo', label: '撤销' },
  { id: 'redo', label: '重做' },
  { id: 'open', label: '打开画板' },
  { id: 'newScene', label: '新建画板' },
  { id: 'fitCanvas', label: '显示整个画板' },
  { id: 'resetZoom', label: '重置缩放' },
  { id: 'alwaysOnTop', label: '始终置顶' },
  { id: 'lockWindow', label: '锁定窗口位置' },
  { id: 'clickThrough', label: '鼠标穿透' },
  { id: 'collaboration', label: '协作模式（全局）' },
];

const RESERVED_SHORTCUTS = new Map<string, string>([
  ['Ctrl+C', '复制'],
  ['Ctrl+X', '剪切'],
  ['Ctrl+V', '粘贴'],
  ['Ctrl+D', '快速创建副本'],
  ['Ctrl+G', '创建分组框'],
  ['Ctrl+Y', '重做'],
  ['Ctrl+P', '紧密排列'],
  ['Ctrl+I', '导入图片'],
  ['Ctrl+O', '显示整个画板'],
  ['Ctrl+A', '全选'],
  ['Ctrl+=', '放大'],
  ['Ctrl+-', '缩小'],
  ['Ctrl+Shift+=', '增加窗口透明度'],
  ['Ctrl+Shift+-', '降低窗口透明度'],
  ['Ctrl+Q', '退出画布'],
  ['Ctrl+M', '最小化'],
  ['Ctrl+F', '最大化 / 还原'],
  ['Ctrl+E', '导出画板'],
  ['Ctrl+Shift+E', '导出选中'],
  ['Ctrl+Shift+G', '移出分组'],
  ['Ctrl+Shift+C', '恢复裁剪区域'],
  ['Ctrl+Shift+T', '重置变换'],
  ['Ctrl+Shift+P', '打开菜单'],
  ['Ctrl+Shift+L', '打开最近画板'],
  ['Q', '标注模式'],
  ['H', '临时隐藏标注'],
  ['1', '标注画笔'],
  ['2', '标注箭头'],
  ['3', '标注橡皮擦'],
  ['B', '标注画笔'],
  ['E', '标注橡皮擦'],
  ['S', '取色'],
  ['Alt+L', '锁定图片'],
  ['Alt+Shift+H', '水平翻转'],
  ['Alt+Shift+V', '垂直翻转'],
  ['F2', '重命名'],
  ['Space', '聚焦选中'],
  ['ArrowUp', '移到顶层'],
  ['ArrowDown', '移到底层'],
  ['ArrowLeft', '上一个焦点对象'],
  ['ArrowRight', '下一个焦点对象'],
  ['Delete', '删除选中'],
]);

function keyFromEvent(event: Pick<KeyboardEvent, 'key' | 'code'>) {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
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

export function shortcutConflict(preferences: ShortcutPreferences, changedId: ShortcutId, shortcut: string) {
  const reserved = RESERVED_SHORTCUTS.get(shortcut);
  if (reserved) return `已用于${reserved}`;
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

export function loadShortcutPreferences(raw: string | null): ShortcutPreferences {
  if (!raw) return { ...DEFAULT_SHORTCUTS };
  try {
    const parsed = JSON.parse(raw) as Partial<Record<ShortcutId, unknown>>;
    const values = { ...DEFAULT_SHORTCUTS };
    for (const id of SHORTCUT_IDS) {
      if (typeof parsed[id] === 'string' && isValidShortcut(parsed[id])) values[id] = parsed[id];
    }
    return values;
  } catch {
    return { ...DEFAULT_SHORTCUTS };
  }
}
