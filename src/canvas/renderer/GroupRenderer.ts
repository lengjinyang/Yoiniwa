import { Container, Graphics, type Container as PixiContainer } from 'pixi.js';
import type { ImageGroup, Viewport } from '../../types';
import {
  GROUP_HEADER_ACTION_SCREEN_WIDTH,
  GROUP_MORE_ICON_DOT_RADIUS,
  GROUP_MORE_ICON_DOT_SPACING,
  GROUP_MORE_ICON_RIGHT_INSET,
  GROUP_TITLE_SCREEN_FONT_SIZE,
  GROUP_TITLE_SCREEN_LINE_HEIGHT,
  fitGroupTitle,
  groupHeaderScreenWidth,
  groupHeaderScreenHeight,
  groupHeaderWorldY,
} from '../groups/GroupPresentation';
import { RenderObjectRegistry } from './RenderObjectRegistry';
import type { GroupHeaderAction } from '../selection/HitTestService';

interface GroupObject {
  body: Graphics;
  header: Container;
  headerBackground: Graphics;
  title: HTMLSpanElement;
  dropHint: HTMLSpanElement;
  colorMark: Graphics;
  more: Graphics;
  expand: Graphics;
  actionState: Graphics;
  destroy(): void;
}

function lightenGroupColor(color: string, ratio: number) {
  const value = /^#[0-9a-f]{6}$/i.test(color) ? color.slice(1) : '536778';
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  return (channels.reduce((result, channel) => (result << 8) | Math.round(channel + (255 - channel) * ratio), 0)) >>> 0;
}

function darkenGroupColor(color: string, ratio: number) {
  const value = /^#[0-9a-f]{6}$/i.test(color) ? color.slice(1) : '536778';
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  return (channels.reduce((result, channel) => (result << 8) | Math.round(channel * (1 - ratio)), 0)) >>> 0;
}

export class GroupRenderer {
  private readonly objects = new RenderObjectRegistry<GroupObject>();
  private selectedId?: string;
  private hoveredId?: string;
  private hoveredAction?: GroupHeaderAction;
  private dropTargetId?: string;
  private scale = 1;
  private viewport: Viewport = { x: 0, y: 0, scale: 1 };
  private groups: ImageGroup[] = [];
  private readonly titleLayer: HTMLDivElement;

  constructor(
    private readonly bodyLayer: PixiContainer,
    private readonly headerSurfaceLayer: PixiContainer,
    private readonly headerLayer: PixiContainer,
    domRoot: HTMLElement,
  ) {
    bodyLayer.sortableChildren = true;
    headerSurfaceLayer.sortableChildren = true;
    headerLayer.sortableChildren = true;
    this.titleLayer = document.createElement('div');
    this.titleLayer.className = 'group-title-text-layer';
    domRoot.appendChild(this.titleLayer);
  }

  sync(groups: ImageGroup[]) {
    this.groups = groups;
    this.objects.retain(new Set(groups.map((group) => group.id)));
    groups.forEach((group, index) => {
      let object = this.objects.get(group.id);
      if (!object) {
        const body = new Graphics();
        const header = new Container();
        const headerBackground = new Graphics();
        const title = document.createElement('span');
        title.className = 'group-title-text';
        title.style.fontSize = `${GROUP_TITLE_SCREEN_FONT_SIZE}px`;
        title.style.lineHeight = `${GROUP_TITLE_SCREEN_LINE_HEIGHT}px`;
        this.titleLayer.appendChild(title);
        const dropHint = document.createElement('span');
        dropHint.className = 'group-drop-hint';
        dropHint.textContent = '释放以加入组';
        this.titleLayer.appendChild(dropHint);
        const colorMark = new Graphics({ roundPixels: true });
        const more = new Graphics({ roundPixels: true });
        const expand = new Graphics({ roundPixels: true });
        const actionState = new Graphics({ roundPixels: true });
        header.addChild(actionState, colorMark, more, expand);
        object = { body, header, headerBackground, title, dropHint, actionState, colorMark, more, expand,
          destroy() { title.remove(); dropHint.remove(); body.destroy(); headerBackground.destroy(); header.destroy({ children: true }); } };
        this.objects.set(group.id, object);
        this.bodyLayer.addChild(body);
        this.headerSurfaceLayer.addChild(headerBackground);
        this.headerLayer.addChild(header);
      }
      this.draw(object, group, index);
    });
  }

  setSelected(id?: string) { this.selectedId = id; }
  setHover(id?: string, action?: GroupHeaderAction) {
    if (id === this.hoveredId && action === this.hoveredAction) return false;
    this.hoveredId = id;
    this.hoveredAction = action;
    this.sync(this.groups);
    return true;
  }
  setDropTarget(id?: string) {
    if (id === this.dropTargetId) return false;
    this.dropTargetId = id;
    this.sync(this.groups);
    return true;
  }
  setViewport(viewport: Viewport) {
    const next = Math.max(viewport.scale, 0.0001);
    const scaleChanged = Math.abs(this.scale - next) >= 0.0001;
    this.viewport = viewport;
    this.scale = next;
    if (scaleChanged) this.sync(this.groups);
    else this.positionTitles();
  }
  destroy() {
    this.objects.destroy();
    this.titleLayer.remove();
  }

  private draw(object: GroupObject, group: ImageGroup, index: number) {
    const selected = group.id === this.selectedId;
    const hovered = group.id === this.hoveredId;
    const dropTarget = group.id === this.dropTargetId;
    const hoveredAction = hovered ? this.hoveredAction : undefined;
    object.body.position.set(group.x, group.y);
    const headerY = groupHeaderWorldY(group, this.scale);
    object.headerBackground.position.set(group.x, headerY);
    object.header.position.set(group.x, headerY);
    object.body.visible = !group.hidden && !group.collapsed;
    object.headerBackground.visible = !group.hidden;
    object.header.visible = !group.hidden;
    object.body.zIndex = index;
    object.headerBackground.zIndex = index;
    object.header.zIndex = index;
    object.body.clear();
    const bodyHeight = Math.max(1, group.height);
    const bodyRadius = Math.min(6 / this.scale, group.width / 2, bodyHeight / 2);
    const borderColor = lightenGroupColor(group.color, 0.125);
    const bodyColor = darkenGroupColor(group.color, 0.22);
    if (!group.collapsed) {
      object.body.moveTo(0, 0).lineTo(group.width, 0)
        .lineTo(group.width, bodyHeight - bodyRadius)
        .quadraticCurveTo(group.width, bodyHeight, group.width - bodyRadius, bodyHeight)
        .lineTo(bodyRadius, bodyHeight)
        .quadraticCurveTo(0, bodyHeight, 0, bodyHeight - bodyRadius)
        .closePath().fill({ color: bodyColor, alpha: Math.min(1, group.opacity + (dropTarget ? 0.1 : 0)) });
      object.body.moveTo(0, 0).lineTo(0, bodyHeight - bodyRadius)
        .quadraticCurveTo(0, bodyHeight, bodyRadius, bodyHeight)
        .lineTo(group.width - bodyRadius, bodyHeight)
        .quadraticCurveTo(group.width, bodyHeight, group.width, bodyHeight - bodyRadius)
        .lineTo(group.width, 0)
        .stroke({ color: dropTarget ? group.color : borderColor, width: (dropTarget ? 1.4 : 1) / this.scale,
          alpha: dropTarget ? 0.95 : hovered ? 0.68 : 0.46 });
    }
    // The inverse child scale cancels the world zoom, keeping the title readable.
    object.headerBackground.scale.set(1 / this.scale);
    object.header.scale.set(1 / this.scale);
    const headerWidth = groupHeaderScreenWidth(group, this.scale);
    const headerHeight = groupHeaderScreenHeight(this.scale);
    object.headerBackground.clear();
    // A controlled luminance/opacity lift establishes the title hierarchy
    // without introducing a detached window-style divider or shadow.
    const headerAlpha = Math.min(1, group.opacity + (hovered ? 0.025 : 0));
    // Body uses a 22% darkening; 16% here yields a restrained 6% lift.
    const headerColor = darkenGroupColor(group.color, 0.16);
    const radius = Math.min(5, headerWidth / 2, headerHeight / 2);
    if (group.collapsed) {
      object.headerBackground.roundRect(0, 0, headerWidth, headerHeight, radius)
        .fill({ color: headerColor, alpha: headerAlpha })
        .stroke({ color: selected ? 0x708cff : borderColor, width: selected ? 1.25 : 1,
          alpha: selected ? 0.95 : hovered ? 0.68 : 0.46 });
    } else {
      object.headerBackground.moveTo(0, headerHeight)
        .lineTo(0, radius).quadraticCurveTo(0, 0, radius, 0)
        .lineTo(headerWidth - radius, 0).quadraticCurveTo(headerWidth, 0, headerWidth, radius)
        .lineTo(headerWidth, headerHeight).closePath()
        .fill({ color: headerColor, alpha: headerAlpha });
      object.headerBackground.moveTo(0, headerHeight).lineTo(0, radius)
        .quadraticCurveTo(0, 0, radius, 0).lineTo(headerWidth - radius, 0)
        .quadraticCurveTo(headerWidth, 0, headerWidth, radius).lineTo(headerWidth, headerHeight)
        .stroke({ color: selected ? 0x708cff : borderColor, width: selected ? 1.25 : 1,
          alpha: selected ? 0.95 : hovered ? 0.68 : 0.46 });
    }
    object.title.style.color = group.titleColor;
    object.title.style.opacity = String(group.titleOpacity ?? 1);
    const actionWidth = GROUP_HEADER_ACTION_SCREEN_WIDTH * (group.collapsed ? 2 : 1);
    const displayedTitle = fitGroupTitle(group.name,
      Math.max(8, headerWidth - actionWidth - 19));
    object.title.textContent = displayedTitle;
    object.title.style.display = group.hidden ? 'none' : '';
    object.title.style.maxWidth = `${Math.max(0, headerWidth - actionWidth - 17)}px`;
    object.dropHint.style.display = dropTarget && !group.collapsed && !group.hidden ? '' : 'none';
    this.positionDom(object, group);
    const expandX = headerWidth - GROUP_HEADER_ACTION_SCREEN_WIDTH * 0.5;
    // The glyph occupies roughly 10 px inside a 20 px hit target. A 14 px
    // center inset leaves balanced optical whitespace at the right edge.
    const moreX = headerWidth - GROUP_MORE_ICON_RIGHT_INSET
      - (group.collapsed ? GROUP_HEADER_ACTION_SCREEN_WIDTH : 0);
    const actionY = headerHeight / 2;
    const actionRadius = Math.min(8.5, Math.max(6, headerHeight / 2 - 1));
    object.actionState.clear();
    if (hoveredAction === 'more') object.actionState.circle(moreX, actionY, actionRadius)
      .fill({ color: group.titleColor, alpha: 0.09 });
    if (hoveredAction === 'expand') object.actionState.circle(expandX, actionY, actionRadius)
      .fill({ color: group.titleColor, alpha: 0.09 });
    object.colorMark.clear().roundRect(4, 3, 3, Math.max(8, headerHeight - 6), 1.5)
      .fill({ color: group.color, alpha: 1 });
    object.colorMark.visible = headerWidth >= 8;
    object.more.clear();
    if (hovered || selected) {
      const iconColor = 0xa4aeba;
      const iconAlpha = hoveredAction === 'more' ? 0.96 : 0.68;
      [-GROUP_MORE_ICON_DOT_SPACING, 0, GROUP_MORE_ICON_DOT_SPACING]
        .forEach((offset) => object.more.circle(moreX + offset, actionY, GROUP_MORE_ICON_DOT_RADIUS)
        .fill({ color: iconColor, alpha: iconAlpha }));
    }
    object.more.visible = headerWidth >= (group.collapsed ? 44 : 24) && !dropTarget && (hovered || selected);
    object.expand.clear();
    if (group.collapsed) object.expand.moveTo(expandX - 3.25, actionY - 1.75)
      .lineTo(expandX, actionY + 1.75).lineTo(expandX + 3.25, actionY - 1.75)
      .stroke({ color: 0x73a0d8, width: 1.15,
        alpha: hoveredAction === 'expand' ? 0.92 : 0.68, cap: 'round', join: 'round' });
    object.expand.visible = group.collapsed && headerWidth >= 24 && !dropTarget;
  }

  private positionTitles() {
    this.groups.forEach((group) => {
      const object = this.objects.get(group.id);
      if (object) this.positionDom(object, group);
    });
  }

  private positionDom(object: GroupObject, group: ImageGroup) {
    const dpr = Math.max(1, globalThis.devicePixelRatio || 1);
    const snap = (value: number) => Math.round(value * dpr) / dpr;
    const x = this.viewport.x + group.x * this.scale + 14;
    const y = this.viewport.y + groupHeaderWorldY(group, this.scale) * this.scale
      + (groupHeaderScreenHeight(this.scale) - GROUP_TITLE_SCREEN_LINE_HEIGHT) / 2;
    object.title.style.transform = `translate3d(${snap(x)}px, ${snap(y)}px, 0)`;
    object.dropHint.style.transform = `translate3d(${snap(this.viewport.x + (group.x + group.width / 2) * this.scale)}px, ${snap(this.viewport.y + (group.y + group.height / 2) * this.scale)}px, 0) translate(-50%, -50%)`;
  }
}
