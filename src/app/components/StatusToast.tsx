import type { OperationState } from '../../operationState';

interface StatusToastProps {
  status: string;
  operation?: OperationState;
}

export function StatusToast({ status, operation }: StatusToastProps) {
  if (!operation && !status) return null;
  return <div className="status-toast no-drag" role={operation?.status === 'error' ? 'alert' : 'status'}>
    {operation?.message ?? status}
  </div>;
}
