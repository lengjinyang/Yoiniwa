import type { ImageItem } from '../types';
import type { ImagePyramid } from '../imagePyramid';
import type { TileAddress } from '../tileSelection';
import { tileResourceUrl } from '../tileResources';
import type { ImageRenderCommand } from './renderPlan';

export interface TileRenderResource {
  command: ImageRenderCommand;
  url: string;
}

function rotatedCenter(item: ImageItem, localX: number, localY: number) {
  const radians = item.rotation * Math.PI / 180;
  const flippedX = localX * (item.flipX ? -1 : 1);
  const flippedY = localY * (item.flipY ? -1 : 1);
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: item.x + item.width / 2 + flippedX * cosine - flippedY * sine,
    y: item.y + item.height / 2 + flippedX * sine + flippedY * cosine,
  };
}

export function tileRenderResource(
  item: ImageItem,
  pyramid: ImagePyramid,
  tile: TileAddress,
): TileRenderResource | undefined {
  if (!item.assetId) return undefined;
  const level = pyramid.levels[tile.level];
  if (!level) return undefined;

  const tileSize = pyramid.tileSize;
  const gutter = pyramid.gutter;
  const innerLeft = tile.column * tileSize;
  const innerTop = tile.row * tileSize;
  const innerRight = Math.min(level.width, innerLeft + tileSize);
  const innerBottom = Math.min(level.height, innerTop + tileSize);
  const returnedLeft = Math.max(0, innerLeft - gutter);
  const returnedTop = Math.max(0, innerTop - gutter);
  const returnedRight = Math.min(level.width, innerRight + gutter);
  const returnedBottom = Math.min(level.height, innerBottom + gutter);

  const scaleX = level.width / Math.max(1, item.naturalWidth);
  const scaleY = level.height / Math.max(1, item.naturalHeight);
  const cropLeft = item.crop.x * scaleX;
  const cropTop = item.crop.y * scaleY;
  const cropRight = (item.crop.x + item.crop.width) * scaleX;
  const cropBottom = (item.crop.y + item.crop.height) * scaleY;
  const sourceLeft = Math.max(innerLeft, cropLeft);
  const sourceTop = Math.max(innerTop, cropTop);
  const sourceRight = Math.min(innerRight, cropRight);
  const sourceBottom = Math.min(innerBottom, cropBottom);
  if (sourceLeft >= sourceRight || sourceTop >= sourceBottom) return undefined;

  const cropWidth = Math.max(Number.EPSILON, cropRight - cropLeft);
  const cropHeight = Math.max(Number.EPSILON, cropBottom - cropTop);
  const destinationWidth = item.width * (sourceRight - sourceLeft) / cropWidth;
  const destinationHeight = item.height * (sourceBottom - sourceTop) / cropHeight;
  const localCenterX = -item.width / 2
    + item.width * ((sourceLeft + sourceRight) / 2 - cropLeft) / cropWidth;
  const localCenterY = -item.height / 2
    + item.height * ((sourceTop + sourceBottom) / 2 - cropTop) / cropHeight;
  const center = rotatedCenter(item, localCenterX, localCenterY);
  const id = `${item.id}:tile:${tile.level}:${tile.column}:${tile.row}`;
  const url = tileResourceUrl(item.assetId, tile.level, tile.column, tile.row);

  return {
    url,
    command: {
      id,
      imageId: item.id,
      source: { assetId: item.assetId },
      sourceRect: {
        x: sourceLeft - returnedLeft,
        y: sourceTop - returnedTop,
        width: sourceRight - sourceLeft,
        height: sourceBottom - sourceTop,
      },
      naturalWidth: returnedRight - returnedLeft,
      naturalHeight: returnedBottom - returnedTop,
      x: center.x - destinationWidth / 2,
      y: center.y - destinationHeight / 2,
      width: destinationWidth,
      height: destinationHeight,
      rotation: item.rotation,
      flipX: item.flipX,
      flipY: item.flipY,
      opacity: item.opacity,
      grayscale: Boolean(item.grayscale),
      zIndex: item.zIndex,
      resourceUrl: url,
    },
  };
}

export function createTileRenderResources(
  item: ImageItem,
  pyramid: ImagePyramid,
  tiles: readonly TileAddress[],
) {
  return tiles.flatMap((tile) => {
    const resource = tileRenderResource(item, pyramid, tile);
    return resource ? [resource] : [];
  });
}
