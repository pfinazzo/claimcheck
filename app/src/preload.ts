/**
 * The only bridge between the page and Node: `window.desk`.
 * Every call returns the handler's value or rejects with a BridgeFailure: a plain object, because
 * the context bridge keeps only the message of an Error and the page needs the code and details
 * (the trust dialog is built from them).
 *
 * Built to dist/preload.cjs: Electron's sandboxed preload has to be CommonJS.
 *
 * @author Patrick Finazzo
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { BridgeFailure, DeskBridge, InvokeChannel, Reply } from './shared/ipc.ts';
import { INVOKE_CHANNELS } from './shared/ipc.ts';

const call = (name: InvokeChannel) => async (payload?: unknown): Promise<unknown> => {
  const res = (await ipcRenderer.invoke(`desk:${name}`, payload)) as Reply<unknown>;
  if (!res.ok) {
    const failure: BridgeFailure = { bridge: 'failure', message: res.error, code: res.code, details: res.details };
    throw failure;
  }
  return res.value;
};

const subscribe = <T,>(channel: string) => (callback: (payload: T) => void): (() => void) => {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
};

const invokers = Object.fromEntries(INVOKE_CHANNELS.map((name) => [name, call(name)]));

const bridge = {
  ...invokers,
  onBoard: subscribe('desk:board'),
  onView: subscribe('desk:view'),
  onRunUpdate: subscribe('desk:run'),
  rendered: (): void => ipcRenderer.send('desk:rendered'),
} as unknown as DeskBridge;

contextBridge.exposeInMainWorld('desk', bridge);
