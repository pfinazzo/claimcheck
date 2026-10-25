/**
 * Why this file exists: the preload script puts the `desk` bridge on `window`. This tells the
 * renderer's type checker it is there, so every call to it is checked against DeskBridge.
 *
 * @author Patrick Finazzo
 */

import type { DeskBridge } from '../shared/ipc.ts';

declare global {
  // Only an interface can merge into the browser's built-in Window type; a type alias would clash with it.
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions, no-restricted-syntax
  interface Window {
    desk: DeskBridge;
  }
}

export {};
