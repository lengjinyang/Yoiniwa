import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { IpcArgs, IpcChannel, IpcResult } from '../../src/shared/ipcContracts.js';

type Awaitable<T> = T | Promise<T>;

export function createIpcHandlerRegistrar(ipcMain: Pick<IpcMain, 'handle'>) {
  return function handle<C extends IpcChannel>(
    channel: C,
    handler: (event: IpcMainInvokeEvent, ...args: IpcArgs<C>) => Awaitable<IpcResult<C>>,
  ) {
    ipcMain.handle(channel, handler as (...args: unknown[]) => unknown);
  };
}
