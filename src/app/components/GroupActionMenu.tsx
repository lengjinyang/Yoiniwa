import { ContextMenu, type ContextMenuEntry, type MenuPosition } from './ContextMenu';
import type { ImageGroup } from '../../types';

interface GroupActionMenuProps {
  menu?: { id: string; position: MenuPosition };
  groups: readonly ImageGroup[];
  onOpenColor(groupId: string, anchor: MenuPosition): void;
  onRename(groupId: string): void;
  onChange(groupId: string, patch: Partial<ImageGroup>): void;
  onToggleAutoFit(groupId: string): void;
  onDetachAll(groupId: string, imageIds: string[]): void;
  onDelete(groupId: string): void;
  onClose(): void;
}

export function GroupActionMenu({
  menu,
  groups,
  onOpenColor,
  onRename,
  onChange,
  onToggleAutoFit,
  onDetachAll,
  onDelete,
  onClose,
}: GroupActionMenuProps) {
  if (!menu) return null;
  const group = groups.find((value) => value.id === menu.id);
  if (!group) return null;
  const imageIds = group.members.filter((member) => member.type === 'image').map((member) => member.id);
  const entries: ContextMenuEntry[] = [
    { type: 'item', label: '更改颜色…', action: () => onOpenColor(group.id, { ...menu.position }) },
    { type: 'item', label: '重命名…', shortcut: 'F2', action: () => onRename(group.id) },
    { type: 'item', label: group.collapsed ? '展开' : '折叠', action: () => onChange(group.id, { collapsed: !group.collapsed }) },
    { type: 'item', label: '自动适应内容', checked: group.autoFit ?? true, action: () => onToggleAutoFit(group.id) },
    { type: 'item', label: '移出组内全部图片', disabled: imageIds.length === 0, action: () => onDetachAll(group.id, imageIds) },
    { type: 'separator' },
    { type: 'item', label: '删除组框', action: () => onDelete(group.id) },
  ];
  return <ContextMenu variant="group" position={menu.position} entries={entries} onClose={onClose} />;
}
