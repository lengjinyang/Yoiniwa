type LogLevel = 'debug' | 'info' | 'warn' | 'error';
interface PendingLog { level: LogLevel; event: string; data?: unknown }

let pending: PendingLog[] = [];
let flushTimer: number | undefined;

function flush() {
  flushTimer = undefined;
  if (!pending.length || !window.refCanvas?.writeLogEntries) return;
  const entries = pending;
  pending = [];
  void window.refCanvas.writeLogEntries(entries).catch(() => undefined);
}

function rendererLog(level: LogLevel, event: string, data?: unknown) {
  pending.push({ level, event, data });
  if (pending.length >= 50) flush();
  else if (flushTimer === undefined) flushTimer = window.setTimeout(flush, 250);
}

export const rendererInfo = (event: string, data?: unknown) => rendererLog('info', event, data);
export const rendererWarn = (event: string, data?: unknown) => rendererLog('warn', event, data);
export const rendererError = (event: string, error: unknown, data?: unknown) => rendererLog('error', event, {
  ...(data && typeof data === 'object' ? data : {}),
  error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
});

if (typeof window !== 'undefined') {
  window.addEventListener('error', (event) => rendererError('window.error', event.error ?? event.message, {
    filename: event.filename, line: event.lineno, column: event.colno,
  }));
  window.addEventListener('unhandledrejection', (event) => rendererError('unhandled-rejection', event.reason));
  window.addEventListener('pagehide', flush);
}
