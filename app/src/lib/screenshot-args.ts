/**
 * Reads `--screenshot <repo> <out.png> [--theme light|dark] [--size WxH] [--view board|board:trust|board:github|board:code|wizard:STEP[:BEAT]]`.
 * `board:trust` presses Run claimcheck on a repo that has not been trusted yet, so the commands dialog shows.
 * `board:github` opens the Connect GitHub dialog, `board:code` opens the code viewer on a canned fix, `board:open` opens the Open repository dialog, `board:propose` shows sample proposals with a recommendation, and `board:graph` shows the confidence map with sample claims.
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
  const view = /^(board|board:(trust|github|code|open|propose|graph|clear)|wizard:[1-6](:[0-2])?)$/.test(requestedView) ? requestedView : 'board';
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
