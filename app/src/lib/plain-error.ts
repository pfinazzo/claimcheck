/**
 * Why this file exists: every failure the person sees passes through here once, at the bridge.
 * Node's error for a failed child process starts with the whole command line, and Desk's commands
 * can carry a pull request body or a prompt. Showing that text puts a wall of internals on screen
 * and can echo content the person never meant to see again. This keeps only what the program said.
 *
 * @author Patrick Finazzo
 */

import { toText } from '../shared/text.ts';

const COMMAND_FAILED = /^Command failed: /;
const LONGEST_MESSAGE = 400;
const FALLBACK = 'A command Desk ran failed, and it gave no reason.';

const pickLastLine = ({ text }: { text: string }): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? '';

const truncateMessage = ({ text }: { text: string }): string => (text.length > LONGEST_MESSAGE ? `${text.slice(0, LONGEST_MESSAGE)}…` : text);

/**
 * The message a person should see for a failure.
 * A failed child process becomes the last line it printed to stderr. Any other error keeps its
 * own message. A message is cut to a readable length.
 */
export const toPlainMessage = ({ error }: { error: unknown }): string => {
  const raw = error instanceof Error ? error.message : toText({ value: error });
  if (!COMMAND_FAILED.test(raw)) return truncateMessage({ text: raw });
  const fromStderr = pickLastLine({ text: toText({ value: (error as { stderr?: unknown }).stderr }) });
  // Node writes "Command failed: <command line>\n<stderr>", so what follows the first line is the program's own words.
  const fromMessage = pickLastLine({ text: raw.split(/\r?\n/).slice(1).join('\n') });
  return truncateMessage({ text: fromStderr || fromMessage || FALLBACK });
};
