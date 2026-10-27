/**
 * Why this file exists: the app reads text out of values it does not control (CLI output, JSON from
 * Claude, the ledger). One function turns any of them into a string the same way everywhere.
 *
 * Normally: a string comes back as it is. Missing values become the fallback.
 * If the value is an object: it becomes JSON, never "[object Object]", so a person can still read it.
 *
 * @author Patrick Finazzo
 */

/** Any value as display text. Null and undefined give the fallback, which defaults to "". */
export const toText = ({ value, fallback = '' }: { value: unknown; fallback?: string }): string => {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return typeof value === 'object' ? JSON.stringify(value) : fallback;
};
