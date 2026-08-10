import { describe, expect, it, vi } from 'vitest';
import type { ContextMenuEntry } from '../ContextMenu';
import { DEFAULT_SHORTCUTS } from '../keyboardShortcuts';
import { createScene } from '../scene';
import type { ImageItem } from '../types';
import { createAppCommandRegistry, type AppCommandId } from './AppCommand';
import { buildAppMenuEntries } from './appMenuEntries';

function image(): ImageItem {
  return {
    id: 'selected', name: 'selected.png', assetId: 'a'.repeat(64), sourceType: 'file', dataUrl: '',
    naturalWidth: 100, naturalHeight: 100, x: 0, y: 0, width: 100, height: 100, rotation: 0,
    flipX: false, flipY: false, opacity: 1, zIndex: 0, locked: false,
    crop: { x: 0, y: 0, width: 100, height: 100 },
  };
}

function menuItem(entries: ContextMenuEntry[], label: string) {
  const entry = entries.find((value) => value.type === 'item' && value.label === label);
  if (!entry || entry.type !== 'item') throw new Error(`Missing menu item: ${label}`);
  return entry;
}

describe('app export menu', () => {
  it('keeps rendered selection delivery separate from explicit original delivery', () => {
    const selected = image();
    const scene = createScene();
    scene.items = [selected];
    const render = vi.fn();
    const originals = vi.fn();
    const copyOriginal = vi.fn();
    const commandIds: AppCommandId[] = [
      'edit.undo', 'edit.redo', 'edit.copy', 'edit.cut', 'edit.paste', 'edit.duplicate', 'edit.delete', 'group.create',
    ];
    const commands = createAppCommandRegistry(commandIds.map((id) => ({ id, enabled: true, execute: vi.fn() })));
    const noop = vi.fn();
    const entries = buildAppMenuEntries({
      scene, dirty: false, shortcuts: DEFAULT_SHORTCUTS, commands,
      panels: {
        outlineOpen: false, versionsOpen: false, propertiesOpen: false,
        toggleOutline: noop, toggleVersions: noop, toggleProperties: noop,
      },
      file: { recent: [], open: noop, importScene: noop, save: noop },
      selection: {
        selectedIds: [selected.id], selectedItems: [selected], primary: selected, selectAll: noop,
      },
      groups: {
        create: noop, addImages: noop, detachSelected: noop, renameSelected: noop,
        change: noop, ungroupSelected: noop, deleteSelected: noop,
      },
      images: {
        mutate: noop, preview: noop, beginAdjustment: noop, commitAdjustment: noop,
        resetTransform: noop, moveLayer: noop, restoreFull: noop, showSource: noop,
      },
      photoshop: { blocked: false, sendSelected: noop, saveVersion: noop },
      layout: { targetCount: 1, run: noop, packAndFit: noop },
      view: { hasContent: true, focusSelected: noop, fitCanvas: noop, resetZoom: noop },
      window: {
        mode: { alwaysOnTop: false, clickThrough: false, locked: false, collaborationMode: false, opacity: 1 },
        collaborationMode: false, toggleCollaboration: noop, setMode: noop, minimize: noop, toggleMaximize: noop,
      },
      export: { render, originals, copyOriginal },
      application: { newScene: noop, close: noop },
    });

    const exportChildren = menuItem(entries, '导出').children ?? [];
    menuItem(exportChildren, '导出选中…').action?.();
    menuItem(exportChildren, '复制合成图').action?.();
    expect(render).toHaveBeenNthCalledWith(1, true);
    expect(render).toHaveBeenNthCalledWith(2, true, true);
    expect(originals).not.toHaveBeenCalled();

    menuItem(exportChildren, '导出选中原图…').action?.();
    menuItem(exportChildren, '复制选中原图').action?.();
    expect(originals).toHaveBeenCalledOnce();
    expect(copyOriginal).toHaveBeenCalledOnce();
  });
});
