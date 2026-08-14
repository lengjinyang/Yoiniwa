import { imageSource } from '../../runtime/imageResources';
import type { PhotoshopVersionRecord } from '../../types';
import { formatBytes } from './CommonControls';
import { UiIcon } from './UiIcon';

export const PHOTOSHOP_VERSION_PREVIEW_MIME = 'application/x-yoiniwa-photoshop-version';

interface PhotoshopVersionsPanelProps {
  open: boolean;
  versions: readonly PhotoshopVersionRecord[];
  documentBlocked: boolean;
  onClose(): void;
  onSaveVersion(): void;
  onOpenVersion(version: PhotoshopVersionRecord): void;
  onPlacePreview(version: PhotoshopVersionRecord): void;
  onCompare(version: PhotoshopVersionRecord): void;
  onDelete(version: PhotoshopVersionRecord): void;
}

export function PhotoshopVersionsPanel({
  open, versions, documentBlocked, onClose, onSaveVersion, onOpenVersion, onPlacePreview, onCompare, onDelete,
}: PhotoshopVersionsPanelProps) {
  if (!open) return null;
  return <aside className="photoshop-version-panel no-drag">
    <header className="photoshop-version-header">
      <div><strong>版本视图</strong><span className="outline-count">{versions.length}</span></div>
      <button title="关闭版本面板" aria-label="关闭版本面板" onClick={onClose}><UiIcon name="close" /></button>
    </header>
    <div className="photoshop-version-toolbar">
      <div><strong>项目版本库</strong><small>{formatBytes(versions.reduce((sum, version) => sum + version.byteLength, 0))}</small></div>
      <button className="photoshop-version-save-button" disabled={documentBlocked} onClick={onSaveVersion}><UiIcon name="version" size={14} />保存版本</button>
    </div>
    <div className="photoshop-version-list">
      {versions.length === 0 && <div className="photoshop-version-empty"><strong>暂无 Photoshop 版本</strong><span>保存版本后，完整 PSD/PSB 会随 .yoi 画板一起保存。</span></div>}
      {[...versions].reverse().map((version) => <article className="photoshop-version-card" key={version.id}>
        <div className="photoshop-version-preview" draggable onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'copy';
          event.dataTransfer.setData(PHOTOSHOP_VERSION_PREVIEW_MIME, version.id);
        }} onDoubleClick={() => onPlacePreview(version)}>
          <img src={imageSource({ assetId: version.previewAssetId }, 'original')} alt="" draggable={false} /><span>{version.format.toUpperCase()}</span>
        </div>
        <div className="photoshop-version-info"><strong title={version.name}>{version.name}</strong><small className="photoshop-version-document" title={version.documentName}>{version.documentName}</small>
          <div className="photoshop-version-details">
            <span>{version.width}×{version.height} · {version.colorMode} · {version.bitDepth} bit</span>
            <span>{version.layerCount} 层 · {formatBytes(version.byteLength)}</span>
          </div>
          <time className="photoshop-version-saved-at" dateTime={version.createdAt}><UiIcon name="clock" size={13} />保存于 {new Date(version.createdAt).toLocaleString()}</time>
        </div>
        {version.note && <div className="photoshop-version-note"><p>{version.note}</p></div>}
        <div className="photoshop-version-actions">
          <button disabled={documentBlocked} onClick={() => onOpenVersion(version)}>在 PS 打开</button>
          <button onClick={() => onPlacePreview(version)}>放入画板</button>
          <button disabled={documentBlocked} onClick={() => onCompare(version)}><UiIcon name="eye" size={13} />比较</button>
          <button className="danger" disabled={documentBlocked} onClick={() => onDelete(version)}><UiIcon name="trash" size={13} />删除</button>
        </div>
      </article>)}
    </div>
  </aside>;
}
