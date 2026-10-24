/**
 * A tiny TOML reader for the subset claimcheck's config.toml uses:
 * `key = value` lines, `[section]` headers, strings, numbers, booleans,
 * and arrays of strings. Comments start with `#`.
 *
 * @author Patrick Finazzo
 */

const parseValue = (raw) => {
  const text = raw.trim();
  if (text.startsWith('[')) {
    const inner = text.slice(1, text.lastIndexOf(']'));
    const items = [];
    const re = /"((?:\\.|[^"\\])*)"|'([^']*)'/g;
    let m;
    while ((m = re.exec(inner))) items.push(m[1] !== undefined ? m[1].replace(/\\"/g, '"') : m[2]);
    return items;
  }
  if (text.startsWith('"')) return text.slice(1, text.lastIndexOf('"')).replace(/\\"/g, '"');
  if (text.startsWith("'")) return text.slice(1, text.lastIndexOf("'"));
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
};

const stripComment = (line) => {
  let inString = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === inString) inString = null;
    } else if (ch === '"' || ch === "'") inString = ch;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
};

export const parseToml = (text) => {
  const root = {};
  let current = root;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    const section = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (section) {
      current = root;
      for (const part of section[1].split('.')) current = current[part] ??= {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    current[line.slice(0, eq).trim()] = parseValue(line.slice(eq + 1));
  }
  return root;
};
