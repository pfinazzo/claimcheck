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
const call = <K extends InvokeChannel>(name: K): DeskBridge[K] => {
  const invoke = async (payload?: unknown): Promise<unknown> => {
    const res = (await ipcRenderer.invoke(`desk:${name}`, payload)) as Reply<unknown>;
    if (!res.ok) {
      const error = new BridgeError(res.error);
      if (res.code) error.code = res.code;
      if (res.details) error.details = res.details;
      throw error;
    }
    return res.value;
  };
  return invoke as DeskBridge[K];
};

const subscribe = <T,>(channel: string) => (callback: (payload: T) => void): (() => void) => {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
};

const invokers = Object.fromEntries(INVOKE_CHANNELS.map((name) => [name, call(name)])) as Invokers;

const bridge: DeskBridge = {
  ...invokers,
  onBoard: subscribe('desk:board'),
  onView: subscribe('desk:view'),
  onRunUpdate: subscribe('desk:run'),
  rendered: (): void => ipcRenderer.send('desk:rendered'),
};

contextBridge.exposeInMainWorld('desk', bridge);
