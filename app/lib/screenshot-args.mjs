/**
 * Reads `--screenshot <repo> <out.png> [--theme light|dark] [--size WxH] [--view board|wizard:N]`.
 *
 * @author Patrick Finazzo
 */

const VALUE_FLAGS = ['--theme', '--size', '--view'];

/** The options, or null when the app was not started in screenshot mode. */
export const parseScreenshotArgs = (args) => {
  const at = args.indexOf('--screenshot');
  if (at < 0) return null;
  const rest = args.slice(at + 1);
  const positional = [];
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    if (VALUE_FLAGS.includes(rest[i])) {
      flags[rest[i]] = rest[i + 1];
      i += 1;
    } else if (!rest[i].startsWith('--')) positional.push(rest[i]);
  }
  const size = /^(\d{3,4})x(\d{3,4})$/.exec(flags['--size'] ?? '1440x900');
  const view = /^(board|wizard:[1-6])$/.test(flags['--view'] ?? 'board') ? (flags['--view'] ?? 'board') : 'board';
  return {
    repo: positional[0],
    out: positional[1],
    theme: flags['--theme'] === 'light' || flags['--theme'] === 'dark' ? flags['--theme'] : null,
    width: size ? Number(size[1]) : 1440,
    height: size ? Number(size[2]) : 900,
    view,
  };
};
