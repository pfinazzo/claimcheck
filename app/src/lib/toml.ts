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

const setEntry = ({ record, key, value }: { record: TomlTable; key: string; value: TomlValue }): void => {
  Object.defineProperty(record, key, { value, writable: true, enumerable: true, configurable: true });
};
const has = ({ record, key }: { record: TomlTable; key: string }): boolean => Object.prototype.hasOwnProperty.call(record, key);
// A type guard must name the value it narrows, so it takes it positionally.
// eslint-disable-next-line no-restricted-syntax
const isTable = (value: unknown): value is TomlTable => value !== null && typeof value === 'object' && !Array.isArray(value);

const makeScanner = ({ text }: { text: string }) => {
  let index = 0;
  /** The character at an offset, or '' past the end, so comparisons never meet undefined. */
  const at = ({ count }: { count: number }): string => text[count] ?? '';
  const fail = ({ message }: { message: string }): never => {
    throw new Skip(message);
  };
  const peek = ({ count = 0 }: { count?: number } = {}): string => at({ count: index + count });
  const startsWith = ({ prefix }: { prefix: string }): boolean => text.startsWith(prefix, index);
  const skipSpaces = (): void => {
    while (at({ count: index }) === ' ' || at({ count: index }) === '\t') index += 1;
  };
  const skipComment = (): void => {
    if (at({ count: index }) === '#') while (index < text.length && at({ count: index }) !== '\n') index += 1;
  };
  /** Inside arrays: spaces, newlines and comments. */
  const skipBlank = (): void => {
    for (;;) {
      skipSpaces();
      if (at({ count: index }) === '\r' || at({ count: index }) === '\n') index += 1;
      else if (at({ count: index }) === '#') skipComment();
      else return;
    }
  };

  /** A \uXXXX or \UXXXXXXXX escape at the cursor. */
  const readUnicodeEscape = ({ digits }: { digits: number }): string => {
    const hex = text.slice(index + 2, index + 2 + digits);
    if (!new RegExp(`^[0-9A-Fa-f]{${digits}}$`).test(hex)) fail({ message: 'bad unicode escape' });
    index += 2 + digits;
    return String.fromCodePoint(parseInt(hex, 16));
  };

  /** A backslash at the end of a line in a multi-line string: the newline and the indent after it vanish. */
  const skipLineEndingBackslash = (): void => {
    let innerIndex = index + 1;
    while (at({ count: innerIndex }) === ' ' || at({ count: innerIndex }) === '\t') innerIndex += 1;
    if (at({ count: innerIndex }) === '\r') innerIndex += 1;
    if (at({ count: innerIndex }) !== '\n') fail({ message: 'bad escape' });
    while (/[ \t\r\n]/.test(at({ count: innerIndex }) || 'x')) innerIndex += 1;
    index = innerIndex;
  };

  /** One backslash escape at the cursor. Moves past it and returns the text it stands for. */
  const readEscape = ({ multi }: { multi: boolean }): string => {
    const next = at({ count: index + 1 });
    const simple = ESCAPES[next];
    if (next !== '' && simple !== undefined) {
      index += 2;
      return simple;
    }
    if (next === 'u' || next === 'U') return readUnicodeEscape({ digits: next === 'u' ? 4 : 8 });
    if (!multi || !/[ \t\r\n]/.test(next)) return fail({ message: 'bad escape' });
    skipLineEndingBackslash();
    return '';
  };

  /**
   * The closing """ of a multi-line string, if the cursor is on it. Up to two quotes right before
   * the delimiter belong to the text, so they come back as the string's last characters.
   * Not at the end yet: null.
   */
  const readMultiLineClose = (): string | null => {
    if (!startsWith({ prefix: '"""' })) return null;
    let run = 3;
    while (at({ count: index + run }) === '"') run += 1;
    if (run > 5) fail({ message: 'too many quotes' });
    index += run;
    return '"'.repeat(run - 3);
  };

  /** The closing quote of a one-line string, if the cursor is on it ("" then), else null. */
  const readOneLineClose = (): string | null => {
    if (at({ count: index }) === '"') {
      index += 1;
      return '';
    }
    if (at({ count: index }) === '\n') fail({ message: 'newline in string' });
    return null;
  };

  const readBasicString = ({ multi }: { multi: boolean }): string => {
    let out = '';
    index += multi ? 3 : 1;
    if (multi && at({ count: index }) === '\r' && at({ count: index + 1 }) === '\n') index += 2;
    else if (multi && at({ count: index }) === '\n') index += 1;
    for (;;) {
      if (index >= text.length) fail({ message: 'unterminated string' });
      const closing = multi ? readMultiLineClose() : readOneLineClose();
      if (closing !== null) return out + closing;
      const char = at({ count: index });
      if (char === '\\') out += readEscape({ multi });
      else {
        out += char;
        index += 1;
      }
    }
  };

  const readLiteralString = ({ multi }: { multi: boolean }): string => {
    index += multi ? 3 : 1;
    if (multi && at({ count: index }) === '\r' && at({ count: index + 1 }) === '\n') index += 2;
    else if (multi && at({ count: index }) === '\n') index += 1;
    const end = multi ? text.indexOf("'''", index) : text.indexOf("'", index);
    if (end < 0) fail({ message: 'unterminated string' });
    const body = text.slice(index, end);
    if (!multi && body.includes('\n')) fail({ message: 'newline in string' });
    index = end + (multi ? 3 : 1);
    return body;
  };

  const readString = (): string => {
    if (at({ count: index }) === '"') return readBasicString({ multi: startsWith({ prefix: '"""' }) });
    return readLiteralString({ multi: startsWith({ prefix: "'''" }) });
  };

  const readBareKey = (): string => {
    const start = index;
    while (index < text.length && BARE.test(at({ count: index }))) index += 1;
    if (index === start) fail({ message: 'empty key' });
    return text.slice(start, index);
  };

  const readKey = (): string[] => {
    let parts: string[] = [];
    for (;;) {
      skipSpaces();
      parts = [...parts, at({ count: index }) === '"' || at({ count: index }) === "'" ? readString() : readBareKey()];
      skipSpaces();
      if (at({ count: index }) === '.') index += 1;
      else return parts;
    }
  };

  const scalar = ({ token }: { token: string }): TomlValue => {
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
    return fail({ message: `not a value: ${token}` });
  };

  const readValue = (): TomlValue => {
    skipSpaces();
    const char = at({ count: index });
    if (char === '"' || char === "'") return readString();
    if (char === '[') return readArray();
    if (char === '{') return readInlineTable();
    const start = index;
    while (index < text.length && !/[\s,\]}#]/.test(at({ count: index }))) index += 1;
    // a time-of-day or datetime may contain one space between date and time
    if (/^\d{4}-\d{2}-\d{2}$/.test(text.slice(start, index)) && /^ \d{2}:\d{2}/.test(text.slice(index, index + 6))) {
      index += 1;
      while (index < text.length && !/[\s,\]}#]/.test(at({ count: index }))) index += 1;
    }
    if (index === start) fail({ message: 'missing value' });
    return scalar({ token: text.slice(start, index) });
  };

  const readArray = (): TomlValue[] => {
    index += 1;
    let items: TomlValue[] = [];
    for (;;) {
      skipBlank();
      if (index >= text.length) fail({ message: 'unterminated array' });
      if (at({ count: index }) === ']') {
        index += 1;
        return items;
      }
      items = [...items, readValue()];
      skipBlank();
      if (at({ count: index }) === ',') index += 1;
      else if (at({ count: index }) !== ']') fail({ message: 'bad array' });
    }
  };

  const assign = ({ table, parts, value }: { table: TomlTable; parts: readonly string[]; value: TomlValue }): void => {
    let node: TomlTable = table;
    for (const part of parts.slice(0, -1)) {
      if (!has({ record: node, key: part })) setEntry({ record: node, key: part, value: {} });
      let next: unknown = node[part];
      if (Array.isArray(next)) next = next[next.length - 1];
      if (!isTable(next)) return fail({ message: 'key path is not a table' });
      node = next;
    }
    const last = parts[parts.length - 1] ?? '';
    if (has({ record: node, key: last })) fail({ message: 'duplicate key' });
    setEntry({ record: node, key: last, value });
  };

  const readInlineTable = (): TomlTable => {
    index += 1;
    const table: TomlTable = {};
    skipSpaces();
    if (at({ count: index }) === '}') {
      index += 1;
      return table;
    }
    for (;;) {
      skipBlank();
      const parts = readKey();
      skipSpaces();
      if (at({ count: index }) !== '=') fail({ message: 'expected =' });
      index += 1;
      assign({ table, parts, value: readValue() });
      skipBlank();
      if (at({ count: index }) === ',') {
        index += 1;
        continue;
      }
      if (at({ count: index }) === '}') {
        index += 1;
        return table;
      }
      fail({ message: 'bad inline table' });
    }
  };

  return {
    get pos(): number {
      return index;
    },
    set pos(value: number) {
      index = value;
    },
    eof: (): boolean => index >= text.length,
    peek,
    startsWith,
    skipSpaces,
    skipComment,
    skipBlank,
    readKey,
    readValue,
    assign,
    advance: (count = 1): void => {
      index += count;
    },
    skipLine: (): void => {
      while (index < text.length && at({ count: index }) !== '\n') index += 1;
    },
    fail,
  };
};

const openTable = ({ root, parts, array }: { array: boolean } & { root: TomlTable; parts: readonly string[] }): TomlTable => {
  let node: TomlTable = root;
  parts.forEach((part, index) => {
    const isLast = index === parts.length - 1;
    if (!has({ record: node, key: part })) setEntry({ record: node, key: part, value: array && isLast ? [] : {} });
    let next: unknown = node[part];
    if (isLast && array) {
      if (!Array.isArray(next)) throw new Skip('not an array of tables');
      const fresh: TomlTable = {};
      // An array of tables holds only tables.
      const tables = next.filter((entry: unknown) => isTable(entry));
      setEntry({ record: node, key: part, value: [...tables, fresh] });
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
  const isArrayTable = scanner.peek({ count: 1 }) === '[';
  scanner.advance(isArrayTable ? 2 : 1);
  const parts = scanner.readKey();
  scanner.skipSpaces();
  if (!scanner.startsWith({ prefix: isArrayTable ? ']]' : ']' })) scanner.fail({ message: 'bad header' });
  scanner.advance(isArrayTable ? 2 : 1);
  return openTable({ root, parts, array: isArrayTable });
};

/** One `key = value` line at the cursor, stored in the current table. */
const readKeyValue = ({ scanner, current }: { scanner: Scanner; current: TomlTable }): void => {
  const parts = scanner.readKey();
  scanner.skipSpaces();
  if (scanner.peek() !== '=') scanner.fail({ message: 'expected =' });
  scanner.advance();
  scanner.assign({ table: current, parts, value: scanner.readValue() });
};

/** One line of the file. Returns the table the next line writes into. */
const readLine = ({ scanner, root, current }: { scanner: Scanner; root: TomlTable; current: TomlTable }): TomlTable => {
  scanner.skipSpaces();
  const char = scanner.peek();
  if (char === '') return current;
  if (char === '\n' || char === '\r') {
    scanner.advance();
    return current;
  }
  if (char === '#') {
    scanner.skipComment();
    return current;
  }
  const next = char === '[' ? readHeader({ scanner, root }) : current;
  if (char !== '[') readKeyValue({ scanner, current });
  scanner.skipSpaces();
  scanner.skipComment();
  if (!scanner.eof() && scanner.peek() !== '\n' && scanner.peek() !== '\r') scanner.fail({ message: 'junk after value' });
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

export const parseToml = ({ input }: { input: unknown }): TomlTable => {
  const text = toText({ value: input }).replace(/^\uFEFF/, '');
  const scanner = makeScanner({ text });
  const root: TomlTable = {};
  let current: TomlTable = root;
  while (!scanner.eof()) current = readLineOrSkip({ scanner, root, current });
  return root;
};

const tomlBasicString = ({ value }: { value: unknown }): string =>
  `"${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, (text) => `\\u${text.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;

/**
 * Sets a top-level string key (`test_cmd = "..."`) in config text. Replaces the
 * existing line, or inserts the key above the first [table] header when it is
 * missing. Everything else, comments included, stays byte for byte.
 */
export const setTomlString = ({ text, key, value }: { text: string; key: string; value: string }): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`Not a plain key: ${key}`);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const line = `${key} = ${tomlBasicString({ value })}`;
  const keyLine = new RegExp(`^\\s*${key}\\s*=`);
  const headerLine = /^\s*\[/;
  let firstTable = lines.findIndex((line) => headerLine.test(line));
  if (firstTable < 0) firstTable = lines.length;
  const existing = lines.slice(0, firstTable).findIndex((line) => keyLine.test(line));
  if (existing >= 0) {
    // A multi-line value would leave debris; only the common single-line form is replaced here.
    if (/("""|''')/.test(lines[existing] ?? '')) throw new Error(`${key} is a multi-line string; edit config.toml by hand.`);
    lines[existing] = line;
    return lines.join(newline);
  }
  // insert after the last top-level key/value line before the first table, else at the top
  let at = 0;
  for (let count = 0; count < firstTable; count += 1) if (/^\s*[A-Za-z0-9_"'.-]+\s*=/.test(lines[count] ?? '')) at = count + 1;
  return [...lines.slice(0, at), line, ...lines.slice(at)].join(newline);
};
