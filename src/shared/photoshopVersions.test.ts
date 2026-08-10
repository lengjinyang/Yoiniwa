import { describe, expect, it } from 'vitest';
import { normalizePhotoshopProjectMetadata } from './photoshopVersions';

const hash = 'a'.repeat(64);
const version = {
  id: '12345678-1234-1234-1234-123456789012', name: ' v001 ', createdAt: '2026-08-08T00:00:00.000Z',
  documentName: 'painting.psd', width: 100, height: 200, colorMode: 'RGB', bitDepth: 8, layerCount: 3,
  format: 'psd', byteLength: 128, sha256: 'b'.repeat(64),
  archiveEntry: 'photoshop-versions/12345678-1234-1234-1234-123456789012.psd', previewAssetId: hash,
  previewAsset: { id: hash, hash, mimeType: 'image/png', byteLength: 10, naturalWidth: 10, naturalHeight: 20, originalName: 'preview.png' },
};

describe('Photoshop project metadata', () => {
  it('normalizes valid embedded version records and rejects unsafe entries', () => {
    expect(normalizePhotoshopProjectMetadata({ versions: [version] }).versions[0].name).toBe('v001');
    expect(normalizePhotoshopProjectMetadata({ versions: [{ ...version, archiveEntry: '../escape.psd' }] }).versions).toEqual([]);
  });
});
