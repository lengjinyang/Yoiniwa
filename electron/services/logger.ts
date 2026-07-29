import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_BACKUPS = 3;
const MAX_BUFFERED_RECORDS = 500;

export const logSessionId = randomUUID();
let directory;
let filePath;
let currentBytes = 0;
let writeQueue = Promise.resolve();
const buffered = [];

function safeValue(value, depth = 0) {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return typeof value === 'string' && value.length > 4000 ? `${value.slice(0, 4000)}…` : value;
  }
  if (depth >= 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => safeValue(entry, depth + 1));
  if (typeof value === 'object') {
    const result = {};
    for (const [key, entry] of Object.entries(value).slice(0, 100)) result[key] = safeValue(entry, depth + 1);
    return result;
  }
  return String(value);
}

async function rotateIfNeeded(nextBytes) {
  if (currentBytes + nextBytes <= MAX_LOG_BYTES || !filePath) return;
  for (let index = MAX_BACKUPS; index >= 1; index -= 1) {
    const source = index === 1 ? filePath : `${filePath}.${index - 1}`;
    const target = `${filePath}.${index}`;
    await fs.rm(target, { force: true }).catch(() => undefined);
    await fs.rename(source, target).catch(() => undefined);
  }
  currentBytes = 0;
}

function enqueue(record) {
  if (!filePath) {
    buffered.push(record);
    if (buffered.length > MAX_BUFFERED_RECORDS) buffered.shift();
    return;
  }
  const line = `${JSON.stringify(record)}\n`;
  const bytes = Buffer.byteLength(line);
  writeQueue = writeQueue.then(async () => {
    await rotateIfNeeded(bytes);
    await fs.appendFile(filePath, line, 'utf8');
    currentBytes += bytes;
  }).catch(() => undefined);
}

export async function initializeLogger(logDirectory: string, context: Record<string, unknown> = {}) {
  directory = logDirectory;
  filePath = path.join(directory, 'refcanvas.jsonl');
  await fs.mkdir(directory, { recursive: true });
  try { currentBytes = (await fs.stat(filePath)).size; } catch { currentBytes = 0; }
  const pending = buffered.splice(0);
  pending.forEach(enqueue);
  logInfo('app.start', context);
}

export function log(level: string, event: string, data: unknown = {}) {
  enqueue({ timestamp: new Date().toISOString(), level, event, sessionId: logSessionId, pid: process.pid, data: safeValue(data) });
}

export const logInfo = (event: string, data: unknown = {}) => log('info', event, data);
export const logWarn = (event: string, data: unknown = {}) => log('warn', event, data);
export const logError = (event: string, error: unknown, data: object = {}) => log('error', event, { ...data, error: safeValue(error) });

export function appendRendererLogs(entries) {
  if (!Array.isArray(entries)) return;
  entries.slice(0, 200).forEach((entry) => log(
    ['debug', 'info', 'warn', 'error'].includes(entry?.level) ? entry.level : 'info',
    typeof entry?.event === 'string' ? `renderer.${entry.event}` : 'renderer.event',
    entry?.data ?? {},
  ));
}

export const getLogDirectory = () => directory;
export const getLogPath = () => filePath;
export const flushLogs = () => writeQueue;
