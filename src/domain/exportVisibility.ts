import type { ImageGroup } from './sceneTypes';

export function exportVisibility(groups: ImageGroup[]) {
  const hiddenImages = new Set<string>();
  const hiddenGroups = new Set<string>();
  const hiddenMarks = new Set<string>();
  const visit = (id: string, hideFrame: boolean, visited = new Set<string>()) => {
    if (visited.has(id)) return;
    visited.add(id);
    const group = groups.find((value) => value.id === id);
    if (!group) return;
    if (hideFrame) hiddenGroups.add(id);
    group.members.forEach((member) => {
      if (member.type === 'image') hiddenImages.add(member.id);
      else if (member.type === 'group') visit(member.id, true, visited);
      else if (member.type === 'mark') hiddenMarks.add(member.id);
    });
  };
  groups.forEach((group) => {
    if (!group.collapsed && !group.contentsHidden) return;
    group.members.forEach((member) => {
      if (member.type === 'image') hiddenImages.add(member.id);
      else if (member.type === 'group') visit(member.id, true);
      else if (member.type === 'mark') hiddenMarks.add(member.id);
    });
  });
  return { hiddenImages, hiddenGroups, hiddenMarks };
}
