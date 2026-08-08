export type OperationKind = 'save' | 'open' | 'import' | 'export' | 'photoshop';
export type OperationStatus = 'running' | 'success' | 'error';

export interface OperationState {
  requestId: number;
  kind: OperationKind;
  status: OperationStatus;
  message: string;
}

export function startOperation(next: OperationState): OperationState {
  return next;
}

export function settleOperation(
  current: OperationState | undefined,
  requestId: number,
  status: Exclude<OperationStatus, 'running'>,
  message: string,
): OperationState | undefined {
  if (!current || current.requestId !== requestId) return current;
  return { ...current, status, message };
}

export function clearOperation(
  current: OperationState | undefined,
  requestId: number,
): OperationState | undefined {
  return current?.requestId === requestId ? undefined : current;
}
