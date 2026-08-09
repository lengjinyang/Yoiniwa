import type { ImagePrewarmProgress } from '../../types';

interface ImageImportProgressProps {
  progress?: ImagePrewarmProgress;
}

export function ImageImportProgress({ progress }: ImageImportProgressProps) {
  if (!progress) return null;
  const completed = progress.stageCompleted ?? progress.completed;
  const total = progress.stageTotal ?? progress.total;
  const fraction = progress.fraction !== undefined ? progress.fraction : total ? completed / total : 0;
  return <div className="import-progress no-drag" role="status">
    <strong>少女祈祷中~</strong>
    <div className="import-progress-track"><i style={{ width: `${fraction * 100}%` }} /></div>
  </div>;
}
