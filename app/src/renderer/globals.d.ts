import type { DeskBridge } from '../shared/ipc.ts';

declare global {
  interface Window {
    desk: DeskBridge;
  }
}

export {};
