import type { AssetRecord, PhotoshopProjectMetadata, PhotoshopVersionRecord } from '../types.js';

export const EMPTY_PHOTOSHOP_PROJECT_METADATA: PhotoshopProjectMetadata = { versions: [] };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function assetRecord(value: unknown): AssetRecord | undefined {
  const asset = record(value);
  if (!asset || typeof asset.id !== 'string' || !/^[a-f0-9]{64}$/i.test(asset.id)
    || asset.hash !== asset.id || typeof asset.mimeType !== 'string'
    || !Number.isSafeInteger(asset.byteLength) || Number(asset.byteLength) < 1
    || !Number.isInteger(asset.naturalWidth) || Number(asset.naturalWidth) < 1
    || !Number.isInteger(asset.naturalHeight) || Number(asset.naturalHeight) < 1
    || typeof asset.originalName !== 'string') return undefined;
  return asset as unknown as AssetRecord;
}

function versionRecord(value: unknown): PhotoshopVersionRecord | undefined {
  const version = record(value);
  const format = version?.format === 'psb' ? 'psb' : version?.format === 'psd' ? 'psd' : undefined;
  const previewAsset = assetRecord(version?.previewAsset);
  if (!version || typeof version.id !== 'string' || !/^[a-f0-9-]{16,80}$/i.test(version.id)
    || typeof version.name !== 'string' || !version.name.trim() || version.name.length > 160
    || typeof version.createdAt !== 'string' || !Number.isFinite(Date.parse(version.createdAt))
    || typeof version.documentName !== 'string' || !version.documentName.trim()
    || !Number.isInteger(version.width) || Number(version.width) < 1
    || !Number.isInteger(version.height) || Number(version.height) < 1
    || typeof version.colorMode !== 'string' || !version.colorMode
    || !Number.isInteger(version.bitDepth) || Number(version.bitDepth) < 1
    || !Number.isInteger(version.layerCount) || Number(version.layerCount) < 0
    || !format || !Number.isSafeInteger(version.byteLength) || Number(version.byteLength) < 1
    || typeof version.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(version.sha256)
    || typeof version.archiveEntry !== 'string'
    || version.archiveEntry !== `photoshop-versions/${version.id}.${format}`
    || typeof version.previewAssetId !== 'string' || previewAsset?.id !== version.previewAssetId
    || (version.note !== undefined && (typeof version.note !== 'string' || version.note.length > 4000))) return undefined;
  return { ...version, name: version.name.trim(), note: typeof version.note === 'string' && version.note.trim() ? version.note.trim() : undefined,
    format, previewAsset } as unknown as PhotoshopVersionRecord;
}

export function normalizePhotoshopProjectMetadata(value: unknown): PhotoshopProjectMetadata {
  const source = record(value);
  if (!source || !Array.isArray(source.versions)) return { versions: [] };
  const ids = new Set<string>();
  const versions = source.versions.slice(0, 10_000).flatMap((value) => {
    const version = versionRecord(value);
    if (!version || ids.has(version.id)) return [];
    ids.add(version.id);
    return [version];
  });
  return { versions };
}

