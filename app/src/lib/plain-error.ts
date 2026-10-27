/**
 * Why this file exists: every failure the person sees passes through here once, at the bridge.
 * Node's error for a failed child process starts with the whole command line, and Desk's commands
 * can carry a pull request body or a prompt. Showing that text puts a wall of internals on screen
 * and can echo content the person never meant to see again. This keeps only what the program said.
 *
 * @author Patrick Finazzo
 */

const COMMAND_FAILED = /^Command failed: /;
const LONGEST_MESSAGE = 400;
const FALLBACK = 'A command Desk ran failed, and it gave no reason.';

const lastLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? '';

const asText = (value: unknown): string => (typeof value === 'string' ? value : value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : '');

/**
 * The message a person should see for a failure.
 * A failed child process becomes the last line it printed to stderr. Any other error keeps its
 * own message. A message is cut to a readable length.
 */
export const toPlainMessage = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error);
  if (!COMMAND_FAILED.test(raw)) return raw.length > LONGEST_MESSAGE ? `${raw.slice(0, LONGEST_MESSAGE)}…` : raw;
  const fromStderr = lastLine(asText((error as { stderr?: unknown }).stderr));
  // Node writes "Command failed: <command line>\n<stderr>", so what follows the first line is the program's own words.
  const fromMessage = lastLine(raw.split(/\r?\n/).slice(1).join('\n'));
  const reason = fromStderr || fromMessage || FALLBACK;
  return reason.length > LONGEST_MESSAGE ? `${reason.slice(0, LONGEST_MESSAGE)}…` : reason;
};
