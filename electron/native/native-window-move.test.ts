import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const helpers = new Set<ChildProcessWithoutNullStreams>();

function waitForLine(helper: ChildProcessWithoutNullStreams, expected: string, timeoutMs = 15000) {
  return new Promise<string>((resolve, reject) => {
    let pending = '';
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${expected}`)), timeoutMs);
    const onData = (chunk: Buffer | string) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      const match = lines.find((line) => line.trim() === expected);
      if (match) finish(undefined, match.trim());
    };
    const onExit = (code: number | null) => finish(new Error(`Native helper exited with ${code}`));
    const finish = (error?: Error, line?: string) => {
      clearTimeout(timer);
      helper.stdout.off('data', onData);
      helper.off('exit', onExit);
      if (error) reject(error);
      else resolve(line ?? '');
    };
    helper.stdout.on('data', onData);
    helper.on('exit', onExit);
  });
}

afterEach(() => {
  helpers.forEach((helper) => helper.kill());
  helpers.clear();
});

describe.skipIf(process.platform !== 'win32')('native collaboration input helper', () => {
  it('compiles and installs its DPI-correct low-level pointer hook', async () => {
    const script = fileURLToPath(new URL('./native-window-move.ps1', import.meta.url));
    const helper = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    ], { stdio: 'pipe', windowsHide: true });
    helpers.add(helper);

    await waitForLine(helper, 'READY');
    const enabled = waitForLine(helper, 'INPUT_ACK|1|READY');
    helper.stdin.write('INPUT|1|1|1\n');
    await expect(enabled).resolves.toBe('INPUT_ACK|1|READY');
    const disabled = waitForLine(helper, 'INPUT_ACK|2|READY');
    helper.stdin.write('INPUT|2|1|0\n');
    await expect(disabled).resolves.toBe('INPUT_ACK|2|READY');
  }, 30000);
});
