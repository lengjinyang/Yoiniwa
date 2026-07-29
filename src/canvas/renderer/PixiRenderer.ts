import { Application, Graphics } from 'pixi.js';
import type { Viewport } from '../../types';
import { boundedDevicePixelRatio } from '../runtime/CanvasConfig';
import { RenderLayers } from './RenderLayers';

export class PixiRenderer {
  private readonly app = new Application();
  private layers?: RenderLayers;

  async start(container: HTMLElement, background: string) {
    await this.app.init({
      background, antialias: true, autoDensity: true,
      resolution: boundedDevicePixelRatio(), preference: 'webgl', powerPreference: 'high-performance',
      resizeTo: container,
    });
    this.app.canvas.className = 'pixi-canvas';
    container.appendChild(this.app.canvas);
    this.layers = new RenderLayers(this.app.stage);
    this.drawPhaseOneFixture();
  }

  private drawPhaseOneFixture() {
    if (!this.layers) return;
    const grid = new Graphics();
    for (let value = -2000; value <= 2000; value += 100) {
      const strong = value % 500 === 0;
      grid.moveTo(value, -2000).lineTo(value, 2000).stroke({ width: strong ? 1.5 : 1, color: strong ? 0x3d4855 : 0x29313a, alpha: 0.7 });
      grid.moveTo(-2000, value).lineTo(2000, value).stroke({ width: strong ? 1.5 : 1, color: strong ? 0x3d4855 : 0x29313a, alpha: 0.7 });
    }
    const marker = new Graphics().roundRect(-120, -80, 240, 160, 18)
      .fill({ color: 0x256b86, alpha: 0.92 }).stroke({ color: 0x64d8ff, width: 3 });
    this.layers.groups.addChild(grid, marker);
  }

  render(viewport: Viewport) {
    if (!this.layers) return;
    this.layers.world.position.set(viewport.x, viewport.y);
    this.layers.world.scale.set(viewport.scale);
  }

  setBackground(background: string) {
    if (this.app.renderer) this.app.renderer.background.color = background;
  }

  destroy() {
    this.app.destroy({ removeView: true }, { children: true, texture: false, textureSource: false });
    this.layers = undefined;
  }
}
