import { Container } from 'pixi.js';

export class RenderLayers {
  readonly world = new Container();
  readonly images = new Container();
  readonly groups = new Container();
  readonly annotations = new Container();
  readonly overlay = new Container();

  constructor(root: Container) {
    this.world.label = 'world';
    this.images.label = 'images';
    this.groups.label = 'groups';
    this.annotations.label = 'annotations';
    this.overlay.label = 'overlay';
    this.world.addChild(this.groups, this.images, this.annotations);
    root.addChild(this.world, this.overlay);
  }
}
