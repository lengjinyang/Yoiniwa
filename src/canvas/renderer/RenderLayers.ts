import { Container } from 'pixi.js';

export class RenderLayers {
  readonly world = new Container();
  readonly images = new Container();
  readonly groups = new Container();
  readonly groupHeaderSurfaces = new Container();
  readonly groupHeaders = new Container();
  readonly annotations = new Container();
  readonly overlay = new Container();

  constructor(root: Container) {
    this.world.sortableChildren = true;
    this.world.label = 'world';
    this.images.label = 'images';
    this.groups.label = 'groups';
    this.groupHeaderSurfaces.label = 'group-header-surfaces';
    this.groupHeaders.label = 'group-headers';
    this.annotations.label = 'annotations';
    this.overlay.label = 'overlay';
    // Group bodies and title surfaces are separate: titles cannot be buried by
    // another group body, while image pixels still remain above both surfaces.
    this.groups.zIndex = 0;
    this.groupHeaderSurfaces.zIndex = 5;
    this.images.zIndex = 10;
    this.annotations.zIndex = 20;
    this.groupHeaders.zIndex = 30;
    this.world.addChild(this.groups, this.groupHeaderSurfaces, this.images, this.annotations, this.groupHeaders);
    root.addChild(this.world, this.overlay);
  }
}
