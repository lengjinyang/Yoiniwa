import { useCallback, useEffect, useRef, useState } from 'react';
import { clearOperation, settleOperation, startOperation, type OperationKind, type OperationState } from '../operationState';

export function useStatusOperations() {
  const [status, setStatus] = useState('');
  const [operation, setOperation] = useState<OperationState>();
  const operationRef = useRef<OperationState | undefined>(undefined);
  const operationRequestRef = useRef(0);

  useEffect(() => {
    if (!status) return undefined;
    const timer = window.setTimeout(() => setStatus(''), 2800);
    return () => window.clearTimeout(timer);
  }, [status]);

  const beginOperation = useCallback((kind: OperationKind, message: string) => {
    const next = { requestId: ++operationRequestRef.current, kind, status: 'running' as const, message };
    operationRef.current = startOperation(next);
    setOperation(operationRef.current);
    return next.requestId;
  }, []);

  const settleCurrentOperation = useCallback((requestId: number, nextStatus: 'success' | 'error', message: string) => {
    const next = settleOperation(operationRef.current, requestId, nextStatus, message);
    operationRef.current = next;
    setOperation(next);
  }, []);

  const clearCurrentOperation = useCallback((requestId: number) => {
    const next = clearOperation(operationRef.current, requestId);
    operationRef.current = next;
    setOperation(next);
  }, []);

  useEffect(() => {
    if (!operation || operation.status === 'running') return undefined;
    const timer = window.setTimeout(
      () => clearCurrentOperation(operation.requestId),
      operation.status === 'error' ? 6000 : 2800,
    );
    return () => window.clearTimeout(timer);
  }, [clearCurrentOperation, operation]);

  useEffect(() => {
    const resourceError = () => setStatus('图片资源载入失败，请重新拖入或检查文件是否损坏');
    const customStatus = (event: Event) => {
      const message = (event as CustomEvent<string>).detail;
      if (typeof message === 'string' && message.trim()) setStatus(message);
    };
    window.addEventListener('refcanvas-resource-error', resourceError);
    window.addEventListener('refcanvas-status', customStatus);
    return () => {
      window.removeEventListener('refcanvas-resource-error', resourceError);
      window.removeEventListener('refcanvas-status', customStatus);
    };
  }, []);

  return {
    status,
    operation,
    setStatus,
    beginOperation,
    settleCurrentOperation,
    clearCurrentOperation,
  };
}
