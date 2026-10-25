/**
 * The only bridge between the page and Node: `window.desk`.
 * Every call returns the handler's value or throws its error message
 * (with `code` and `details` when the handler gave them).
 *
 * Built to dist/preload.cjs: Electron's sandboxed preload has to be CommonJS.
 *
 * @author Patrick Finazzo
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { INVOKE_CHANNELS, type DeskBridge, type InvokeChannel, type Reply } from './shared/ipc.ts';

class BridgeError extends Error {
  code?: string;
  details?: unknown;
}

type Invokers = { [K in InvokeChannel]: DeskBridge[K] };

/** One bridge call. The main process's handler decides the shape of the value; ipc.ts names it. */
const sendCall = <K extends InvokeChannel>({ name }: { name: K }): DeskBridge[K] => {
  const invoke = async ({ payload }: { payload?: unknown } = {}): Promise<unknown> => {
    const response = (await ipcRenderer.invoke(`desk:${name}`, payload)) as Reply<unknown>;
    if (!response.ok) {
      const error = new BridgeError(response.error);
      if (response.code) error.code = response.code;
      if (response.details) error.details = response.details;
      throw error;
    }
    return response.value;
  };
  return ((payload?: unknown) => invoke({ payload })) as DeskBridge[K];
};

const watchChannel = <T>({ channel }: { channel: string }) => (callback: (payload: T) => void): (() => void) => {
  // Electron calls listeners positionally (event, payload), and removeListener needs this same function back.
  // eslint-disable-next-line no-restricted-syntax
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
};

const invokers = Object.fromEntries(INVOKE_CHANNELS.map((name) => [name, sendCall({ name })])) as Invokers;

const bridge: DeskBridge = {
  ...invokers,
  onBoard: watchChannel({ channel: 'desk:board' }),
  onView: watchChannel({ channel: 'desk:view' }),
  onRunUpdate: watchChannel({ channel: 'desk:run' }),
  rendered: (): void => ipcRenderer.send('desk:rendered'),
};

contextBridge.exposeInMainWorld('desk', bridge);
