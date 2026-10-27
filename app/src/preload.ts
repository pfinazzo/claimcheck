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
import { INVOKE_CHANNELS, type BridgeFailure, type DeskBridge, type InvokeChannel, type Reply } from './shared/ipc.ts';

type Invokers = { [K in InvokeChannel]: DeskBridge[K] };

/** One bridge call. The main process's handler decides the shape of the value; ipc.ts names it. */
const sendCall = <K extends InvokeChannel>({ name }: { name: K }): DeskBridge[K] => {
  const invoke = async ({ payload }: { payload?: unknown } = {}): Promise<unknown> => {
    const response = (await ipcRenderer.invoke(`desk:${name}`, payload)) as Reply<unknown>;
    if (!response.ok) {
      const failure: BridgeFailure = { bridge: 'failure', message: response.error, code: response.code, details: response.details };
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- an Error loses its code and details crossing the context bridge, so a plain object is thrown on purpose
      throw failure;
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
