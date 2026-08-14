import { createScene, GROUP_PADDING } from './domain/scene';
import type { AssetRecord, ImageGroup, ImageItem, Scene } from './types';

/**
 * Deterministic metadata-only stress fixture. It reuses a small asset pool so routine tests
 * exercise 2,000 canvas objects without generating gigabytes of disposable image files.
 */
export function createStressScene(itemCount = 2000, assetCount = 40, fixtureDataUrl?: string | ((index: number) => string)): Scene {
  const scene = createScene();
  const columns = Math.ceil(Math.sqrt(itemCount * 1.6));
  const assets = Array.from({ length: assetCount }, (_, index): AssetRecord => {
    const naturalWidth = 640 + (index % 8) * 320;
    const naturalHeight = 480 + (index % 7) * 240;
    const id = `stress-asset-${index}`;
    return {
      id, hash: id, mimeType: 'image/png', byteLength: 32_000 + index * 101,
      naturalWidth, naturalHeight, originalName: `stress-${index}.png`,
    };
  });
  scene.assets = Object.fromEntries(assets.map((asset) => [asset.id, asset]));
  scene.items = Array.from({ length: itemCount }, (_, index): ImageItem => {
    const asset = assets[index % assets.length];
    const width = 90 + (index % 9) * 17;
    const height = width * asset.naturalHeight / asset.naturalWidth;
    const column = index % columns; const row = Math.floor(index / columns);
    return {
      id: `stress-item-${index}`, name: `参考图 ${index + 1}`, assetId: asset.id,
      dataUrl: typeof fixtureDataUrl === 'function' ? fixtureDataUrl(index) : fixtureDataUrl,
      sourceType: 'file', naturalWidth: asset.naturalWidth, naturalHeight: asset.naturalHeight,
      x: column * 230 + (row % 3) * 13, y: row * 190 + (column % 4) * 9,
      width, height, rotation: (index % 13 - 6) * 2.5,
      flipX: index % 29 === 0, flipY: index % 47 === 0, opacity: 1,
      zIndex: index, locked: assetCount === itemCount ? false : index % 97 === 0,
      crop: { x: 0, y: 0, width: asset.naturalWidth, height: asset.naturalHeight },
    };
  });

  const groupSize = 25;
  scene.groups = Array.from({ length: Math.floor(itemCount / groupSize) }, (_, groupIndex): ImageGroup => {
    const members = scene.items.slice(groupIndex * groupSize, groupIndex * groupSize + groupSize);
    const left = Math.min(...members.map((item) => item.x)); const top = Math.min(...members.map((item) => item.y));
    const right = Math.max(...members.map((item) => item.x + item.width)); const bottom = Math.max(...members.map((item) => item.y + item.height));
    return {
      id: `stress-group-${groupIndex}`, name: `分组 ${groupIndex + 1}`,
      headerLayoutVersion: 2,
      x: left - GROUP_PADDING, y: top - GROUP_PADDING,
      width: right - left + GROUP_PADDING * 2, height: bottom - top + GROUP_PADDING * 2,
      color: `hsl(${groupIndex * 47 % 360} 32% 48%)`, opacity: 0.18, titleColor: '#f5f7fa',
      collapsed: false, sizeLocked: false, contentsHidden: false,
      members: members.map((item) => ({ type: 'image', id: item.id })),
    };
  });
  scene.viewport = { x: 24, y: 24, scale: 0.065 };
  return scene;
}
