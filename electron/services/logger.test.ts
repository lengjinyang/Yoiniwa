import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appendRendererLogs, flushLogs, initializeLogger, logError, logInfo, logSessionId } from './logger.js';

const directory = path.join(os.tmpdir(), `refcanvas-logger-${process.pid}-${Date.now()}`);

describe('persistent logger', () => {
  afterAll(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  it('writes structured main and renderer records with one session id', async () => {
    await initializeLogger(directory, { test: true });
    logInfo('test.info', { count: 2 });
    logError('test.error', new Error('expected failure'));
    appendRendererLogs([{ level: 'warn', event: 'test.renderer', data: { source: 'vitest' } }]);
    await flushLogs();

    const records = (await fs.readFile(path.join(directory, 'refcanvas.jsonl'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line));
    expect(records.map((record) => record.event)).toEqual(expect.arrayContaining([
      'app.start', 'test.info', 'test.error', 'renderer.test.renderer',
    ]));
    expect(records.every((record) => record.sessionId === logSessionId)).toBe(true);
    expect(records.find((record) => record.event === 'test.error')?.data.error.message).toBe('expected failure');
  });
});
