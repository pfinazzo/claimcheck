/**
 * Reads `--screenshot <repo> <out.png> [--theme light|dark] [--size WxH] [--view board|wizard:STEP[:BEAT]]`.
 *
 * @author Patrick Finazzo
 */

const VALUE_FLAGS = ['--theme', '--size', '--view'];

export type ScreenshotArgs = {
  repo: string | undefined;
  out: string | undefined;
  theme: 'light' | 'dark' | null;
  width: number;
  height: number;
  view: string;
};

/** The options, or null when the app was not started in screenshot mode. */
export const parseScreenshotArgs = (args: readonly string[]): ScreenshotArgs | null => {
  const at = args.indexOf('--screenshot');
  if (at < 0) return null;
  const rest = args.slice(at + 1);
  const positional: string[] = [];
  const flags: Record<string, string | undefined> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? '';
    if (VALUE_FLAGS.includes(arg)) {
      flags[arg] = rest[i + 1];
      i += 1;
    } else if (!arg.startsWith('--')) positional.push(arg);
  }
  const size = /^(\d{3,4})x(\d{3,4})$/.exec(flags['--size'] ?? '1440x900');
  const requestedView = flags['--view'] ?? 'board';
  const view = /^(board|wizard:[1-6](:[0-2])?)$/.test(requestedView) ? requestedView : 'board';
  const theme = flags['--theme'];
  return {
    repo: positional[0],
    out: positional[1],
    theme: theme === 'light' || theme === 'dark' ? theme : null,
    width: size ? Number(size[1]) : 1440,
    height: size ? Number(size[2]) : 900,
    view,
  };
};
