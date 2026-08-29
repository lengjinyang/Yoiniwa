export interface PoseAssetAuditV1 {
  schemaVersion: 1;
  status: 'approved';
  modelId: 'chambersu-bjd-female-v1';
  downloadedAt: string;
  source: {
    author: 'ChamberSu';
    modelName: 'Ball Joint Doll Basemesh';
    url: string;
    originalSha256: string;
  };
  license: { id: 'CC-BY-4.0'; url: string; archivedFile: string; pageSnapshot: string };
  handSource: { author: 'zacko'; name: string; url: string; licenseId: 'CC-BY-4.0' };
  audit: {
    rigidPartsVerified: true;
    pivotsVerified: true;
    hierarchyVerified: true;
    redistributionVerified: true;
  };
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

/** A model cannot enter the editor unless the archived Phase 0 evidence explicitly says approved. */
export function parsePoseAssetAudit(value: unknown): PoseAssetAuditV1 {
  if (!value || typeof value !== 'object') throw new Error('缺少资产授权审计清单');
  const source = value as Partial<PoseAssetAuditV1>;
  if (source.schemaVersion !== 1 || source.status !== 'approved' || source.modelId !== 'chambersu-bjd-female-v1'
    || !source.source || source.source.author !== 'ChamberSu' || source.source.modelName !== 'Ball Joint Doll Basemesh'
    || source.source.url !== 'https://sketchfab.com/3d-models/ball-joint-doll-basemesh-df21b9e5b2f34283aafb8bacee141496'
    || !isSha256(source.source.originalSha256)
    || !source.license || source.license.id !== 'CC-BY-4.0'
    || source.license.url !== 'https://creativecommons.org/licenses/by/4.0/'
    || !source.license.archivedFile || !source.license.pageSnapshot
    || !source.handSource || source.handSource.author !== 'zacko' || source.handSource.licenseId !== 'CC-BY-4.0'
    || !source.audit || source.audit.rigidPartsVerified !== true || source.audit.pivotsVerified !== true
    || source.audit.hierarchyVerified !== true || source.audit.redistributionVerified !== true
    || Number.isNaN(Date.parse(String(source.downloadedAt)))) {
    throw new Error('BJD 模型尚未通过 Phase 0 授权、分件、层级和 pivot 审计');
  }
  return structuredClone(value) as PoseAssetAuditV1;
}
