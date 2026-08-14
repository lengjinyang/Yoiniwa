import { isVideoItem } from '../../domain/media';
import type { SceneItem, Scene } from '../../types';
import type { Camera } from '../camera/Camera';
import type { InputRouter } from '../interaction/InputRouter';
import type { RuntimeLifecycle } from '../runtime/RuntimeLifecycle';
import { topmostImageAtPoint } from '../selection/HitTestService';

export function bindVideoHover(options: {
  container: HTMLElement;
  input: InputRouter;
  camera: Camera;
  lifecycle: RuntimeLifecycle;
  images: () => SceneItem[];
  assets: () => Scene['assets'] | undefined;
  setHoveredVideo: (id?: string) => boolean;
  scheduleRender: () => void;
}) {
  const update = (event: PointerEvent) => {
    const bounds = options.container.getBoundingClientRect();
    const world = options.camera.screenToWorld({
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    });
    const hit = topmostImageAtPoint(options.images(), world);
    const videoId = hit && isVideoItem(hit, options.assets()) ? hit.id : undefined;
    if (options.setHoveredVideo(videoId)) options.scheduleRender();
  };
  const clear = () => {
    if (options.setHoveredVideo()) options.scheduleRender();
  };
  const disposeMove = options.input.onPointerMove(update);
  options.container.addEventListener('pointerleave', clear);
  options.lifecycle.add(() => {
    disposeMove();
    options.container.removeEventListener('pointerleave', clear);
  });
}
