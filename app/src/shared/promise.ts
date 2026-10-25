/**
 * Why this file exists: some functions implement an async interface (the Desk IPC API, injected
 * hooks) but have nothing to wait for. Marking them `async` with no `await` hides that, and
 * dropping `async` would turn their errors into synchronous throws. This keeps both honest.
 *
 * @author Patrick Finazzo
 */

/** Runs `work` now and returns its result as a promise; a throw becomes a rejection, as with `async`. */
export const toPromise = <T>(work: () => T): Promise<T> => new Promise<T>((resolve) => resolve(work()));
