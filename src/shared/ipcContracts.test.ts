import { describe, expect, it } from 'vitest';
import type { IpcArgs, IpcChannel, IpcContract, IpcContractMap, IpcEventMap, IpcResult } from './ipcContracts';

const contractAssertions: [
  IpcContract<[], string> extends { args: []; result: string } ? true : false,
  IpcArgs<'project:commit'> extends IpcContractMap['project:commit']['args'] ? true : false,
  IpcResult<'window:get-mode'> extends IpcContractMap['window:get-mode']['result'] ? true : false,
  'images:prewarm-progress' extends keyof IpcEventMap ? true : false,
] = [true, true, true, true];

const invokeChannels = [
  'images:import', 'images:register-paths', 'images:register-urls', 'images:register-clipboard', 'images:prewarm',
  'images:performance-stats', 'images:sample-pixel', 'project:open', 'project:commit',
  'project:choose-save-path', 'project:save-as',
  'project:close', 'project:compact', 'project:stats', 'project:recover', 'scene:import', 'scene:recent',
  'scene:startup-path', 'cache:info', 'cache:choose-location', 'cache:reset-location', 'image:export',
  'image:export-originals', 'image:copy', 'image:copy-original', 'image:show-source',
  'photoshop:set-foreground', 'window:set-mode', 'window:get-mode',
  'window:set-collaboration-shortcut', 'window:get-collaboration-shortcut',
  'logs:write', 'logs:open-folder', 'logs:copy-diagnostics', 'performance:record-manual-wheel',
] as const satisfies readonly IpcChannel[];

describe('IPC contract', () => {
  it('keeps every renderer invoke channel unique', () => {
    expect(new Set(invokeChannels).size).toBe(invokeChannels.length);
    expect(contractAssertions.every(Boolean)).toBe(true);
  });
});
