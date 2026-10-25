/**
 * Small helpers shared by the tests.
 *
 * @author Patrick Finazzo
 */

/** Narrows a value that the test has just proved exists, failing loudly if it does not. */
export const expectDefined = <T>({ value, what = 'value' }: { value: T | null | undefined; what?: string }): T => {
  if (value === null || value === undefined) throw new Error(`expected ${what} to exist`);
  return value;
};

/** Records what a fake was called with, in order, without a shared array being pushed to. */
export const createRecorder = <T>() => {
  let entries: readonly T[] = [];
  return {
    record: (entry: T): void => {
      entries = [...entries, entry];
    },
    list: (): readonly T[] => entries,
  };
};
