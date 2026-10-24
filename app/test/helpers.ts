/**
 * Small helpers shared by the tests.
 *
 * @author Patrick Finazzo
 */

/** Narrows a value that the test has just proved exists, failing loudly if it does not. */
export const must = <T>(value: T | null | undefined, what = 'value'): T => {
  if (value === null || value === undefined) throw new Error(`expected ${what} to exist`);
  return value;
};
