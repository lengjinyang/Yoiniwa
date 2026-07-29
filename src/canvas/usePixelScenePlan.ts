import { useMemo } from 'react';
import { chooseImageVariant, imageSource } from '../imageResources';
import { createImagePyramid } from '../imagePyramid';
import { createImageRenderPlan } from '../rendering/renderPlan';
import { createTileRenderResources } from '../rendering/tileRenderPlan';
import type { Bounds } from '../scene';
import { selectImageTiles } from '../tileSelection';
import { shouldUseImagePyramid } from '../tileResources';
import type { ImageItem } from '../types';

interface PixelScenePlanOptions {
  orderedItems: readonly ImageItem[];
  hiddenImageIds: ReadonlySet<string>;
  itemById: ReadonlyMap<string, ImageItem>;
  settledBounds: Bounds;
  settledImageIds: ReadonlySet<string>;
  preloadBounds: Bounds;
  preloadImageIds: ReadonlySet<string>;
  settledScale: number;
  tileLevelsRef: { current: Map<string, number> };
  qualityFocus?: { imageId: string; x: number; y: number };
}

export interface PixelScenePlan {
  commands: ReturnType<typeof createImageRenderPlan>;
  prefetch: Array<{ commandId: string; itemId: string; url: string }>;
  gpuPrewarm: Array<{ commandId: string; itemId: string; url: string }>;
  tiledImageIds: Set<string>;
}

export function usePixelScenePlan({
  orderedItems, hiddenImageIds, itemById, settledBounds,
  settledImageIds, preloadBounds, preloadImageIds, settledScale, tileLevelsRef, qualityFocus,
}: PixelScenePlanOptions): PixelScenePlan {
  const baseCommands = useMemo(() => createImageRenderPlan(
    orderedItems,
    // The preload ring is camera-ready while distant nodes stay metadata-only.
    preloadBounds,
    new Set(hiddenImageIds),
  ), [hiddenImageIds, orderedItems, preloadBounds]);

  return useMemo(() => {
    const commands: PixelScenePlan['commands'] = [];
    const prefetch: PixelScenePlan['prefetch'] = [];
    const gpuPrewarm = new Map<string, PixelScenePlan['gpuPrewarm'][number]>();
    const tiledImageIds = new Set<string>();
    const activeLevelIds = new Set<string>();
    const pixelRatio = window.devicePixelRatio || 1;

    baseCommands.forEach((baseCommand) => {
      const item = itemById.get(baseCommand.id);
      // Selection is UI state, not a texture residency request. Treating every
      // selected image as a high-quality working-set member made a box-select
      // flood the atlas and displaced visible previews with group backgrounds.
      const inWorkingSet = settledImageIds.has(baseCommand.id);
      const inPreloadRing = !inWorkingSet && preloadImageIds.has(baseCommand.id);
      if (!item || !item.assetId || item.dataUrl) {
        commands.push(baseCommand);
        return;
      }
      // Visible images request the smallest resource that covers the current
      // device pixels. Large originals switch to tiles only when their display
      // size actually needs original resolution.
      const targetVariant = inWorkingSet
        ? chooseImageVariant(item, settledScale, pixelRatio)
        : 'thumb128';
      if (!shouldUseImagePyramid(item)) {
        // A fixed preview is the permanent safety plane. Higher variants use a
        // separate command, so a failed large allocation can never replace the
        // only resident texture with a group-background-colored hole.
        commands.push({
          ...baseCommand,
          id: `${item.id}:preview`,
          imageId: item.id,
          resourceUrl: imageSource(item, 'thumb128'),
        });
        if (targetVariant !== 'thumb128') commands.push({
          ...baseCommand,
          id: `${item.id}:detail`,
          imageId: item.id,
          resourceUrl: imageSource(item, targetVariant),
        });
        else if (inPreloadRing) {
          const preloadVariant = chooseImageVariant(item, settledScale, pixelRatio);
          if (preloadVariant !== 'thumb128') gpuPrewarm.set(`${item.id}:detail`, {
            commandId: `${item.id}:detail`, itemId: item.id, url: imageSource(item, preloadVariant),
          });
        }
        return;
      }
      commands.push({
        ...baseCommand,
        id: `${item.id}:preview`,
        imageId: item.id,
        resourceUrl: imageSource(item, 'thumb128'),
      });
      const pyramid = createImagePyramid(item.naturalWidth, item.naturalHeight);
      if (inPreloadRing) {
        // Make the next viewport ring GPU-ready, not merely decoded. The same
        // command IDs become visible after a pan, so the first onscreen frame
        // reuses the already-resident final LOD without a soft-to-sharp swap.
        const preloadSelection = selectImageTiles(item, pyramid, preloadBounds, settledScale, pixelRatio);
        createTileRenderResources(item, pyramid, preloadSelection.visible).forEach((resource) => {
          gpuPrewarm.set(resource.command.id, {
            commandId: resource.command.id, itemId: item.id, url: resource.url,
          });
        });
      }
      if (qualityFocus?.imageId === item.id) {
        // Keep exactly the next finer level ready. Pinning every future level at
        // once can exceed the 256 MiB atlas, after which the prewarm set evicts
        // itself forever and never converges.
        const futureScale = settledScale * 2.05;
        const factor = futureScale / Math.max(0.00001, settledScale);
        const futureBounds = {
          x: qualityFocus.x - settledBounds.width / factor / 2,
          y: qualityFocus.y - settledBounds.height / factor / 2,
          width: settledBounds.width / factor,
          height: settledBounds.height / factor,
        };
        const future = selectImageTiles(item, pyramid, futureBounds, futureScale, pixelRatio);
        createTileRenderResources(item, pyramid, [...future.visible, ...future.prefetch]).forEach((resource) => {
          gpuPrewarm.set(resource.command.id, {
            commandId: resource.command.id, itemId: item.id, url: resource.url,
          });
        });
      }
      if (targetVariant === 'thumb128') return;
      if (targetVariant === 'thumb256' || targetVariant === 'thumb512' || targetVariant === 'thumb768') {
        commands.push({
          ...baseCommand,
          id: `${item.id}:detail`,
          imageId: item.id,
          resourceUrl: imageSource(item, targetVariant),
        });
        return;
      }
      // At 1024/original scale, tiles avoid reserving a large contiguous slot
      // for image pixels that are outside the viewport.
      if (!settledImageIds.has(item.id)) return;

      const selection = selectImageTiles(item, pyramid, settledBounds, settledScale, pixelRatio, tileLevelsRef.current.get(item.id));
      const visibleResources = createTileRenderResources(item, pyramid, selection.visible);
      if (!visibleResources.length) return;
      activeLevelIds.add(item.id);
      tiledImageIds.add(item.id);
      tileLevelsRef.current.set(item.id, selection.level);
      visibleResources.forEach((resource) => commands.push(resource.command));
      createTileRenderResources(item, pyramid, selection.prefetch).forEach((resource) => {
        prefetch.push({ commandId: resource.command.id, itemId: item.id, url: resource.url });
      });
      const finerSelection = selectImageTiles(item, pyramid, settledBounds, settledScale * 2.05, pixelRatio);
      if ((!qualityFocus || qualityFocus.imageId === item.id) && finerSelection.level < selection.level) {
        createTileRenderResources(item, pyramid, finerSelection.visible).forEach((resource) => {
          gpuPrewarm.set(resource.command.id, { commandId: resource.command.id, itemId: item.id, url: resource.url });
        });
      }
    });

    [...tileLevelsRef.current.keys()].forEach((id) => {
      if (!activeLevelIds.has(id)) tileLevelsRef.current.delete(id);
    });
    return { commands, prefetch, gpuPrewarm: [...gpuPrewarm.values()], tiledImageIds };
  }, [baseCommands, itemById, preloadBounds, preloadImageIds, qualityFocus, settledBounds, settledImageIds, settledScale, tileLevelsRef]);
}
