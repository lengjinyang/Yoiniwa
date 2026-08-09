import type { ImagePrewarmProgress } from '../../types';

interface ImageImportProgressProps {
  progress?: ImagePrewarmProgress;
  onCancel(): void;
}

export function ImageImportProgress({ progress, onCancel }: ImageImportProgressProps) {
  if (!progress) return null;
  const completed = progress.stageCompleted ?? progress.completed;
  const total = progress.stageTotal ?? progress.total;
  const fraction = progress.fraction !== undefined ? progress.fraction : total ? completed / total : 0;
  const failed = (progress.failed ?? 0) + (progress.detailFailed ?? 0);
  return <div className="import-progress no-drag" role="status">
    <strong>{progress.stage === 'mip' ? '正在生成图片金字塔' : progress.stage === 'commit'
      ? '正在校验并提交缓存' : '正在导入图片'}</strong>
    <span>{completed} / {total}</span>
    <div className="import-progress-track"><i style={{ width: `${fraction * 100}%` }} /></div>
    {Boolean(failed) && <small title={progress.lastFailedName}>{failed} 张已跳过</small>}
    <button title="取消导入" onClick={onCancel}>取消</button>
  </div>;
}
