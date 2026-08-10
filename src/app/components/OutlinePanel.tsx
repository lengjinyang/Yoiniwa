import { useMemo, useState, type ReactNode } from 'react';
import { groupOrDescendantMatches, outlineObjectMatches, type OutlineFilter } from '../../outline';
import type { ImageGroup, ImageItem, Scene } from '../../types';
import { OutlineThumbnail } from './CommonControls';
import { UiIcon } from './UiIcon';

interface OutlinePanelProps {
  open: boolean;
  scene: Scene;
  selectedIds: readonly string[];
  selectedGroupId?: string;
  onClose(): void;
  onSelectImage(item: ImageItem): void;
  onFocusImage(item: ImageItem): void;
  onSelectGroup(group: ImageGroup): void;
  onFocusGroup(group: ImageGroup): void;
  onToggleImageVisibility(id: string): void;
  onToggleImageLock(id: string): void;
  onMoveImageLayer(id: string, direction: -1 | 1): void;
}

export function OutlinePanel({
  open, scene, selectedIds, selectedGroupId, onClose, onSelectImage, onFocusImage, onSelectGroup, onFocusGroup,
  onToggleImageVisibility, onToggleImageLock, onMoveImageLayer,
}: OutlinePanelProps) {
  const [query, setQuery] = useState('');
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const hasFilter = Boolean(normalizedQuery);
  const filter = useMemo<OutlineFilter>(() => ({ query }), [query]);
  const groupedImageIds = new Set(scene.groups.flatMap((group) => group.members
    .filter((member) => member.type === 'image').map((member) => member.id)));
  const imageMatches = (item: ImageItem) => outlineObjectMatches(item, 'image', filter);
  const groupMatches = (group: ImageGroup) => groupOrDescendantMatches(scene, group, filter);
  const toggleGroup = (id: string) => setCollapsedIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const renderImage = (item: ImageItem) => imageMatches(item) ? <li key={`image-${item.id}`}>
    <div className={`outline-row image${selectedIds.includes(item.id) ? ' selected' : ''}${item.hidden ? ' muted' : ''}`}>
      <span className="outline-indent" />
      <OutlineThumbnail item={item} />
      <button className="outline-name" title={`${item.name} · 双击定位`} onClick={() => onSelectImage(item)} onDoubleClick={() => onFocusImage(item)}>{item.name}</button>
      <span className="outline-actions">
        <button className={`outline-visibility${item.hidden ? ' off' : ''}`} title={item.hidden ? '显示图片' : '隐藏图片'} onClick={() => onToggleImageVisibility(item.id)}><UiIcon name={item.hidden ? 'eye-off' : 'eye'} /></button>
        <button className={`outline-lock${item.locked ? ' locked' : ''}`} title={item.locked ? '解锁图片' : '锁定图片'} onClick={() => onToggleImageLock(item.id)}><UiIcon name={item.locked ? 'lock' : 'unlock'} /></button>
        <button className="outline-layer down" title="下移一层" onClick={() => onMoveImageLayer(item.id, -1)}><UiIcon name="arrow-down" /></button>
        <button className="outline-layer up" title="上移一层" onClick={() => onMoveImageLayer(item.id, 1)}><UiIcon name="arrow-up" /></button>
      </span>
    </div>
  </li> : null;

  const renderGroup = (group: ImageGroup, visited = new Set<string>()): ReactNode => {
    if (visited.has(group.id) || !groupMatches(group)) return null;
    const nextVisited = new Set(visited).add(group.id);
    const collapsed = !hasFilter && collapsedIds.has(group.id);
    return <li key={group.id} className="outline-group-node">
      <div className={`outline-row group${selectedGroupId === group.id ? ' selected' : ''}`}>
        <button className={`outline-disclosure${collapsed ? ' collapsed' : ''}`} title={collapsed ? '展开层级' : '折叠层级'} onClick={() => toggleGroup(group.id)}><UiIcon name={collapsed ? 'chevron-right' : 'chevron-down'} /></button>
        <span className="outline-group-mark" style={{ color: group.color }}><UiIcon name="group" /></span>
        <button className="outline-name" title={`${group.name} · 双击定位`} onClick={() => onSelectGroup(group)} onDoubleClick={() => onFocusGroup(group)}>{group.name}</button>
        <span className="outline-count">{group.members.length}</span>
      </div>
      {!collapsed && <ul>{group.members.map((member) => {
        if (member.type === 'group') {
          const child = scene.groups.find((value) => value.id === member.id);
          return child ? renderGroup(child, nextVisited) : null;
        }
        if (member.type === 'image') {
          const item = scene.items.find((value) => value.id === member.id);
          return item ? renderImage(item) : null;
        }
        return null;
      })}</ul>}
    </li>;
  };

  if (!open) return null;
  return <aside className="outline-panel no-drag">
    <header>
      <div><strong>大纲</strong><span>{scene.items.length + scene.groups.length}</span></div>
      <span className="outline-header-actions">
        <button className="outline-expand-all" title="全部展开" aria-label="全部展开" onClick={() => setCollapsedIds(new Set())}><UiIcon name="chevrons-down" /></button>
        <button className="outline-collapse-all" title="全部折叠" aria-label="全部折叠" onClick={() => setCollapsedIds(new Set(scene.groups.map((group) => group.id)))}><UiIcon name="chevrons-up" /></button>
        <button className="outline-close" title="关闭大纲" aria-label="关闭大纲" onClick={onClose}><UiIcon name="close" /></button>
      </span>
    </header>
    <div className="outline-search">
      <span><UiIcon name="search" /></span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称或标签" />
      {query && <button title="清除搜索" onClick={() => setQuery('')}><UiIcon name="close" size={14} /></button>}
    </div>
    <div className="outline-tree"><ul>
      {scene.groups.filter((group) => !group.parentId).map((group) => renderGroup(group))}
      {scene.items.filter((item) => !groupedImageIds.has(item.id)).map(renderImage)}
    </ul>
    {hasFilter && !scene.groups.some(groupMatches) && !scene.items.some(imageMatches) && <div className="outline-empty">没有匹配的对象</div>}
    </div>
  </aside>;
}
