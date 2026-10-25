/**
 * Why this file exists: Desk reads JSON it did not write (CLI output, model replies, ledger lines).
 * Text that is not JSON is normal there, so it is a value to check, not an error to catch.
 *
 * @author Patrick Finazzo
 */

/** The parsed value, or undefined when the text is not JSON. */
export const parseJsonOrUndefined = ({ text }: { text: string }): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};
