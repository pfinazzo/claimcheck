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
export const parseScreenshotArgs = ({ argList }: { argList: readonly string[] }): ScreenshotArgs | null => {
  const at = argList.indexOf('--screenshot');
  if (at < 0) return null;
  const rest = argList.slice(at + 1);
  const flags: Record<string, string | undefined> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? '';
    if (VALUE_FLAGS.includes(arg)) {
      flags[arg] = rest[index + 1];
      index += 1;
    }
  }
  const positional = rest.filter((arg, index) => !arg.startsWith('--') && !VALUE_FLAGS.includes(rest[index - 1] ?? ''));
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
