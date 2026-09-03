import type { OperationState } from '../operationState';

interface StatusToastProps {
  status: string;
  operation?: OperationState;
}

export function StatusToast({ status, operation }: StatusToastProps) {
  if (!operation && !status) return null;
  const saving = operation?.kind === 'save' && operation.status === 'running';
  return <div className={`${saving ? 'import-progress' : 'status-toast'} no-drag`} role={operation?.status === 'error' ? 'alert' : 'status'}>
    {operation?.message ?? status}
    {saving && <progress className="save-progress" aria-label="正在保存画板" />}
  </div>;
}
