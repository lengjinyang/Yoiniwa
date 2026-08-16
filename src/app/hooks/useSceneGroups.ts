import { useCallback, useEffect, useRef, useState } from 'react';
import type { ColorControlHandle } from '../components/ColorControl';
import type { MenuPosition } from '../components/ContextMenu';
import {
  addMemberToGroup,
  createGroupFrame,
  detachImageFromGroup,
  fitAutoGroupsToContents,
  fitGroupToContents,
  memberBounds,
  moveGroupWithContents,
  reconcileAllMemberships,
  reconcileMemberBounds,
} from '../../domain/scene';
import { deleteSceneSelection } from '../../domain/sceneCommands';
import type { GroupFrameBounds } from '../../canvas/publicTypes';
import type { ImageGroup } from '../../types';
import type { SceneHistoryController } from './useSceneHistory';

export function useSceneGroups({
  history,
  selectedIds,
  selectedGroup,
  selectedGroupId,
  setSelectedIds,
  setSelectedGroupId,
  closeContextMenu,
  setStatus,
}: {
  history: SceneHistoryController;
  selectedIds: string[];
  selectedGroup?: ImageGroup;
  selectedGroupId?: string;
  setSelectedIds(ids: string[]): void;
  setSelectedGroupId(id?: string): void;
  closeContextMenu(): void;
  setStatus(message: string): void;
}) {
  const [renamingGroupId, setRenamingGroupId] = useState<string>();
  const [renameDraft, setRenameDraft] = useState('');
  const [groupActionMenu, setGroupActionMenu] = useState<{ id: string; position: MenuPosition }>();
  const [groupColorEditor, setGroupColorEditor] = useState<{ id: string; anchor: { x: number; y: number } }>();
  const groupColorEditorRef = useRef<ColorControlHandle>(null);
  const groupColorEditorIdRef = useRef<string | undefined>(undefined);

  const createGroup = useCallback(() => {
    const members = selectedIds.map((id) => ({ type: 'image' as const, id }));
    if (members.length < 2) { setStatus('请先框选至少两个对象'); return; }
    const name = `组 ${history.scene.groups.length + 1}`;
    const id = crypto.randomUUID();
    history.commit((scene) => { createGroupFrame(scene, members, name, id); });
    setSelectedIds([]);
    setSelectedGroupId(id);
    setStatus(`已创建分组框“${name}”`);
  }, [history, selectedIds, setSelectedGroupId, setSelectedIds, setStatus]);

  const renameGroupById = useCallback((groupId: string) => {
    const current = history.scene.groups.find((group) => group.id === groupId);
    if (!current) return;
    setSelectedGroupId(groupId);
    setRenameDraft(current.name);
    setRenamingGroupId(groupId);
  }, [history.scene.groups, setSelectedGroupId]);

  const renameGroup = useCallback(() => {
    if (selectedGroup) renameGroupById(selectedGroup.id);
  }, [renameGroupById, selectedGroup]);

  const cancelGroupRename = useCallback(() => {
    setRenamingGroupId(undefined);
    setRenameDraft('');
  }, []);

  const finishGroupRename = useCallback(() => {
    const name = renameDraft.trim();
    const current = renamingGroupId
      ? history.scene.groups.find((group) => group.id === renamingGroupId)
      : undefined;
    if (renamingGroupId && name && current?.name !== name) {
      history.commit((scene) => {
        const group = scene.groups.find((value) => value.id === renamingGroupId);
        if (group && group.name !== name) group.name = name;
      });
      setStatus(`分组框已重命名为“${name}”`);
    }
    setRenamingGroupId(undefined);
    setRenameDraft('');
  }, [history, renameDraft, renamingGroupId, setStatus]);

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
  }, [history, selectedGroup, setStatus]);

  const detachImages = useCallback((imageIds: readonly string[], groupId?: string) => {
    const selected = new Set(imageIds);
    const targets = history.scene.groups.flatMap((group) => group.members
      .filter((member) => member.type === 'image' && selected.has(member.id) && (!groupId || group.id === groupId))
      .map((member) => ({ groupId: group.id, imageId: member.id })));
    if (!targets.length) { setStatus('选中的图片不在组内'); return; }
    history.commit((scene) => {
      targets.forEach((target) => { detachImageFromGroup(scene, target.groupId, target.imageId); });
    });
    setStatus(`已将 ${targets.length} 张图片移出组，图片位置保持不变`);
  }, [history, setStatus]);

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
        const former = scene.groups.find((value) => value.members.some((member) =>
          member.type === 'image' && member.id === imageId));
        if (former && former.id !== group.id) detachImageFromGroup(scene, former.id, imageId);
        addMemberToGroup(scene, group, { type: 'image', id: imageId });
      });
      fitAutoGroupsToContents(scene);
    });
    setStatus(`已将 ${targets.length} 张图片加入“${target.name}”，图片位置保持不变`);
  }, [history, setStatus]);

  const changeGroup = useCallback((groupId: string, patch: Partial<ImageGroup>) => {
    history.commit((scene) => {
      const group = scene.groups.find((value) => value.id === groupId);
      if (!group) return;
      Object.assign(group, patch);
      if (patch.x !== undefined || patch.y !== undefined || patch.width !== undefined || patch.height !== undefined) {
        reconcileAllMemberships(scene);
      }
    });
  }, [history]);

  const openGroupActions = useCallback((groupId: string, position: { x: number; y: number }) => {
    const group = history.scene.groups.find((group) => group.id === groupId);
    if (!group) return;
    setSelectedGroupId(groupId);
    closeContextMenu();
    setGroupActionMenu({ id: groupId, position: { x: position.x + 6, y: position.y } });
  }, [closeContextMenu, history.scene.groups, setSelectedGroupId]);

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
      const remove = (id: string) => {
        const group = scene.groups.find((value) => value.id === id);
        if (!group) return;
        if (withContents) {
          const imageIds = new Set(group.members.filter((member) => member.type === 'image').map((member) => member.id));
          const markIds = new Set(group.members.filter((member) => member.type === 'mark').map((member) => member.id));
          group.members.filter((member) => member.type === 'group').forEach((member) => remove(member.id));
          deleteSceneSelection(scene, [...imageIds]);
          scene.visualNotes.marks = scene.visualNotes.marks.filter((mark) => !markIds.has(mark.id));
          scene.groups.forEach((value) => {
            value.members = value.members.filter((member) => member.type !== 'mark' || !markIds.has(member.id));
          });
        } else {
          group.members.filter((member) => member.type === 'group').forEach((member) => {
            const child = scene.groups.find((value) => value.id === member.id);
            if (child) child.parentId = undefined;
          });
        }
        scene.groups.forEach((value) => {
          value.members = value.members.filter((member) => member.type !== 'group' || member.id !== id);
        });
        scene.groups = scene.groups.filter((value) => value.id !== id);
      };
      remove(groupId);
      fitAutoGroupsToContents(scene);
    });
    setSelectedGroupId(undefined);
    setGroupColorEditor((current) => current?.id === groupId ? undefined : current);
    setRenamingGroupId((current) => current === groupId ? undefined : current);
    setStatus(withContents ? '已删除分组框及其内容' : '已删除分组框，内部对象已保留');
  }, [history, setSelectedGroupId, setStatus]);

  const deleteGroup = useCallback((withContents: boolean) => {
    if (selectedGroup) deleteGroupById(selectedGroup.id, withContents);
  }, [deleteGroupById, selectedGroup]);

  const toggleGroupAutoFit = useCallback((groupId: string) => {
    history.commit((scene) => {
      const group = scene.groups.find((value) => value.id === groupId);
      if (!group) return;
      group.autoFit = !(group.autoFit ?? true);
      if (group.autoFit) fitGroupToContents(scene, group.id);
    });
  }, [history]);

  return {
    createGroup,
    renameGroupById,
    renameGroup,
    renamingGroupId,
    renameDraft,
    setRenameDraft,
    cancelGroupRename,
    finishGroupRename,
    ungroupSelected,
    detachImages,
    detachSelectedImages,
    addImagesToGroup,
    changeGroup,
    groupActionMenu,
    setGroupActionMenu,
    openGroupActions,
    groupColorEditor,
    setGroupColorEditor,
    groupColorEditorRef,
    moveGroupColorEditor,
    moveGroup,
    resizeGroup,
    deleteGroupById,
    deleteGroup,
    toggleGroupAutoFit,
  };
}
