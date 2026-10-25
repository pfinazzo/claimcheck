/**
 * A small, dependency-free TOML reader that follows Python's tomllib for what
 * a config file uses: bare, quoted and dotted keys; [table] and [[array]]
 * headers (spaces and quotes allowed); basic, literal and triple-quoted
 * strings with escapes; integers (underscores, hex, octal, binary, signs),
 * floats (exponents, inf, nan), booleans; multi-line arrays; inline tables;
 * comments. Dates and times are kept as their text.
 *
 * It never throws. A line it cannot read is skipped, so one typo in
 * config.toml cannot stop the board from opening.
 *
 * Also exports `setTomlString`, the helper that rewrites one top-level
 * string key in place and leaves every other byte alone.
 *
 * @author Patrick Finazzo
 */

import { toText } from '../shared/text.ts';

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export type TomlTable = {
  [key: string]: TomlValue;
};

class Skip extends Error {}

const BARE = /[A-Za-z0-9_-]/;
const ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };

const put = (obj: TomlTable, key: string, value: TomlValue): void => {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
};
const has = (obj: TomlTable, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);
const isTable = (v: unknown): v is TomlTable => v !== null && typeof v === 'object' && !Array.isArray(v);

const makeScanner = (text: string) => {
  let i = 0;
  /** The character at an offset, or '' past the end, so comparisons never meet undefined. */
  const at = (n: number): string => text[n] ?? '';
  const fail = (msg: string): never => {
    throw new Skip(msg);
  };
  const peek = (n = 0): string => at(i + n);
  const startsWith = (s: string): boolean => text.startsWith(s, i);
  const skipSpaces = (): void => {
    while (at(i) === ' ' || at(i) === '\t') i += 1;
  };
  const skipComment = (): void => {
    if (at(i) === '#') while (i < text.length && at(i) !== '\n') i += 1;
  };
  /** Inside arrays: spaces, newlines and comments. */
  const skipBlank = (): void => {
    for (;;) {
      skipSpaces();
      if (at(i) === '\r' || at(i) === '\n') i += 1;
      else if (at(i) === '#') skipComment();
      else return;
    }
  };

  /** A \uXXXX or \UXXXXXXXX escape at the cursor. */
  const readUnicodeEscape = ({ digits }: { digits: number }): string => {
    const hex = text.slice(i + 2, i + 2 + digits);
    if (!new RegExp(`^[0-9A-Fa-f]{${digits}}$`).test(hex)) fail('bad unicode escape');
    i += 2 + digits;
    return String.fromCodePoint(parseInt(hex, 16));
  };

  /** A backslash at the end of a line in a multi-line string: the newline and the indent after it vanish. */
  const skipLineEndingBackslash = (): void => {
    let j = i + 1;
    while (at(j) === ' ' || at(j) === '\t') j += 1;
    if (at(j) === '\r') j += 1;
    if (at(j) !== '\n') fail('bad escape');
    while (/[ \t\r\n]/.test(at(j) || 'x')) j += 1;
    i = j;
  };

  /** One backslash escape at the cursor. Moves past it and returns the text it stands for. */
  const readEscape = ({ multi }: { multi: boolean }): string => {
    const next = at(i + 1);
    const simple = ESCAPES[next];
    if (next !== '' && simple !== undefined) {
      i += 2;
      return simple;
    }
    if (next === 'u' || next === 'U') return readUnicodeEscape({ digits: next === 'u' ? 4 : 8 });
    if (!multi || !/[ \t\r\n]/.test(next)) return fail('bad escape');
    skipLineEndingBackslash();
    return '';
  };

  /**
   * The closing """ of a multi-line string, if the cursor is on it. Up to two quotes right before
   * the delimiter belong to the text, so they come back as the string's last characters.
   * Not at the end yet: null.
   */
  const readMultiLineClose = (): string | null => {
    if (!startsWith('"""')) return null;
    let run = 3;
    while (at(i + run) === '"') run += 1;
    if (run > 5) fail('too many quotes');
    i += run;
    return '"'.repeat(run - 3);
  };

  /** The closing quote of a one-line string, if the cursor is on it ("" then), else null. */
  const readOneLineClose = (): string | null => {
    if (at(i) === '"') {
      i += 1;
      return '';
    }
    if (at(i) === '\n') fail('newline in string');
    return null;
  };

  const readBasicString = (multi: boolean): string => {
    let out = '';
    i += multi ? 3 : 1;
    if (multi && at(i) === '\r' && at(i + 1) === '\n') i += 2;
    else if (multi && at(i) === '\n') i += 1;
    for (;;) {
      if (i >= text.length) fail('unterminated string');
      const closing = multi ? readMultiLineClose() : readOneLineClose();
      if (closing !== null) return out + closing;
      const ch = at(i);
      if (ch === '\\') out += readEscape({ multi });
      else {
        out += ch;
        i += 1;
      }
    }
  };

  const readLiteralString = (multi: boolean): string => {
    i += multi ? 3 : 1;
    if (multi && at(i) === '\r' && at(i + 1) === '\n') i += 2;
    else if (multi && at(i) === '\n') i += 1;
    const end = multi ? text.indexOf("'''", i) : text.indexOf("'", i);
    if (end < 0) fail('unterminated string');
    const body = text.slice(i, end);
    if (!multi && body.includes('\n')) fail('newline in string');
    i = end + (multi ? 3 : 1);
    return body;
  };

  const readString = (): string => {
    if (at(i) === '"') return readBasicString(startsWith('"""'));
    return readLiteralString(startsWith("'''"));
  };

  const readBareKey = (): string => {
    const start = i;
    while (i < text.length && BARE.test(at(i))) i += 1;
    if (i === start) fail('empty key');
    return text.slice(start, i);
  };

  const readKey = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      skipSpaces();
      parts.push(at(i) === '"' || at(i) === "'" ? readString() : readBareKey());
      skipSpaces();
      if (at(i) === '.') i += 1;
      else return parts;
    }
  };

  const scalar = (token: string): TomlValue => {
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (/^[+-]?inf$/.test(token)) return token.startsWith('-') ? -Infinity : Infinity;
    if (/^[+-]?nan$/.test(token)) return NaN;
    if (/^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}.*)?$/.test(token) || /^\d{2}:\d{2}:\d{2}/.test(token)) return token;
    const clean = token.replace(/_/g, '');
    if (/^[+-]?(0|[1-9]\d*)$/.test(clean)) return Number(clean);
    if (/^0x[0-9A-Fa-f]+$/.test(clean)) return parseInt(clean.slice(2), 16);
    if (/^0o[0-7]+$/.test(clean)) return parseInt(clean.slice(2), 8);
    if (/^0b[01]+$/.test(clean)) return parseInt(clean.slice(2), 2);
    if (/^[+-]?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(clean)) return Number(clean);
    return fail(`not a value: ${token}`);
  };

  const readValue = (): TomlValue => {
    skipSpaces();
    const ch = at(i);
    if (ch === '"' || ch === "'") return readString();
    if (ch === '[') return readArray();
    if (ch === '{') return readInlineTable();
    const start = i;
    while (i < text.length && !/[\s,\]}#]/.test(at(i))) i += 1;
    // a time-of-day or datetime may contain one space between date and time
    if (/^\d{4}-\d{2}-\d{2}$/.test(text.slice(start, i)) && /^ \d{2}:\d{2}/.test(text.slice(i, i + 6))) {
      i += 1;
      while (i < text.length && !/[\s,\]}#]/.test(at(i))) i += 1;
    }
    if (i === start) fail('missing value');
    return scalar(text.slice(start, i));
  };

  const readArray = (): TomlValue[] => {
    i += 1;
    const items: TomlValue[] = [];
    for (;;) {
      skipBlank();
      if (i >= text.length) fail('unterminated array');
      if (at(i) === ']') {
        i += 1;
        return items;
      }
      items.push(readValue());
      skipBlank();
      if (at(i) === ',') i += 1;
      else if (at(i) !== ']') fail('bad array');
    }
  };

  const assign = (table: TomlTable, parts: string[], value: TomlValue): void => {
    let node: TomlTable = table;
    for (const part of parts.slice(0, -1)) {
      if (!has(node, part)) put(node, part, {});
      let next: unknown = node[part];
      if (Array.isArray(next)) next = next[next.length - 1];
      if (!isTable(next)) return fail('key path is not a table');
      node = next;
    }
    const last = parts[parts.length - 1] ?? '';
    if (has(node, last)) fail('duplicate key');
    put(node, last, value);
  };

  const readInlineTable = (): TomlTable => {
    i += 1;
    const table: TomlTable = {};
    skipSpaces();
    if (at(i) === '}') {
      i += 1;
      return table;
    }
    for (;;) {
      skipBlank();
      const parts = readKey();
      skipSpaces();
      if (at(i) !== '=') fail('expected =');
      i += 1;
      assign(table, parts, readValue());
      skipBlank();
      if (at(i) === ',') {
        i += 1;
        continue;
      }
      if (at(i) === '}') {
        i += 1;
        return table;
      }
      fail('bad inline table');
    }
  };

  return {
    get pos(): number {
      return i;
    },
    set pos(v: number) {
      i = v;
    },
    eof: (): boolean => i >= text.length,
    peek,
    startsWith,
    skipSpaces,
    skipComment,
    skipBlank,
    readKey,
    readValue,
    assign,
    advance: (n = 1): void => {
      i += n;
    },
    skipLine: (): void => {
      while (i < text.length && at(i) !== '\n') i += 1;
    },
    fail,
  };
};

const enter = (root: TomlTable, parts: string[], { array }: { array: boolean }): TomlTable => {
  let node: TomlTable = root;
  parts.forEach((part, idx) => {
    const last = idx === parts.length - 1;
    if (!has(node, part)) put(node, part, array && last ? [] : {});
    let next: unknown = node[part];
    if (last && array) {
      if (!Array.isArray(next)) throw new Skip('not an array of tables');
      const fresh: TomlTable = {};
      next.push(fresh);
      node = fresh;
      return;
    }
    if (Array.isArray(next)) next = next[next.length - 1];
    if (!isTable(next)) throw new Skip('not a table');
    node = next;
  });
  return node;
};

type Scanner = ReturnType<typeof makeScanner>;

/** A [table] or [[array of tables]] header at the cursor. Returns the table later keys go into. */
const readHeader = ({ scanner, root }: { scanner: Scanner; root: TomlTable }): TomlTable => {
  const array = scanner.peek(1) === '[';
  scanner.advance(array ? 2 : 1);
  const parts = scanner.readKey();
  scanner.skipSpaces();
  if (!scanner.startsWith(array ? ']]' : ']')) scanner.fail('bad header');
  scanner.advance(array ? 2 : 1);
  return enter(root, parts, { array });
};

/** One `key = value` line at the cursor, stored in the current table. */
const readKeyValue = ({ scanner, current }: { scanner: Scanner; current: TomlTable }): void => {
  const parts = scanner.readKey();
  scanner.skipSpaces();
  if (scanner.peek() !== '=') scanner.fail('expected =');
  scanner.advance();
  scanner.assign(current, parts, scanner.readValue());
};

/** One line of the file. Returns the table the next line writes into. */
const readLine = ({ scanner, root, current }: { scanner: Scanner; root: TomlTable; current: TomlTable }): TomlTable => {
  scanner.skipSpaces();
  const ch = scanner.peek();
  if (ch === '') return current;
  if (ch === '\n' || ch === '\r') {
    scanner.advance();
    return current;
  }
  if (ch === '#') {
    scanner.skipComment();
    return current;
  }
  const next = ch === '[' ? readHeader({ scanner, root }) : current;
  if (ch !== '[') readKeyValue({ scanner, current });
  scanner.skipSpaces();
  scanner.skipComment();
  if (!scanner.eof() && scanner.peek() !== '\n' && scanner.peek() !== '\r') scanner.fail('junk after value');
  return next;
};

/**
 * One line, or, when the parser can't read it, nothing: the line is skipped so one odd line never
 * hides the rest of the config. Returns the table the next line writes into.
 */
const readLineOrSkip = ({ scanner, root, current }: { scanner: Scanner; root: TomlTable; current: TomlTable }): TomlTable => {
  const lineStart = scanner.pos;
  try {
    return readLine({ scanner, root, current });
  } catch (error) {
    if (!(error instanceof Skip)) throw error;
    scanner.pos = Math.max(scanner.pos, lineStart);
    scanner.skipLine();
    return current;
  }
};

export const parseToml = (input: unknown): TomlTable => {
  const text = toText({ value: input }).replace(/^\uFEFF/, '');
  const scanner = makeScanner(text);
  const root: TomlTable = {};
  let current: TomlTable = root;
  while (!scanner.eof()) current = readLineOrSkip({ scanner, root, current });
  return root;
};

const tomlBasicString = (value: unknown): string =>
  `"${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;

/**
 * Sets a top-level string key (`test_cmd = "..."`) in config text. Replaces the
 * existing line, or inserts the key above the first [table] header when it is
 * missing. Everything else, comments included, stays byte for byte.
 */
export const setTomlString = (text: string, key: string, value: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`Not a plain key: ${key}`);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const line = `${key} = ${tomlBasicString(value)}`;
  const keyLine = new RegExp(`^\\s*${key}\\s*=`);
  const headerLine = /^\s*\[/;
  let firstTable = lines.findIndex((l) => headerLine.test(l));
  if (firstTable < 0) firstTable = lines.length;
  const existing = lines.slice(0, firstTable).findIndex((l) => keyLine.test(l));
  if (existing >= 0) {
    // A multi-line value would leave debris; only the common single-line form is replaced here.
    if (/("""|''')/.test(lines[existing] ?? '')) throw new Error(`${key} is a multi-line string; edit config.toml by hand.`);
    lines[existing] = line;
    return lines.join(newline);
  }
  // insert after the last top-level key/value line before the first table, else at the top
  let at = 0;
  for (let n = 0; n < firstTable; n += 1) if (/^\s*[A-Za-z0-9_"'.-]+\s*=/.test(lines[n] ?? '')) at = n + 1;
  lines.splice(at, 0, line);
  return lines.join(newline);
};
