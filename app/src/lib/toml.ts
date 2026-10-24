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

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

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

  const readBasicString = (multi: boolean): string => {
    let out = '';
    i += multi ? 3 : 1;
    if (multi && at(i) === '\r' && at(i + 1) === '\n') i += 2;
    else if (multi && at(i) === '\n') i += 1;
    for (;;) {
      if (i >= text.length) fail('unterminated string');
      const ch = at(i);
      if (multi) {
        if (startsWith('"""')) {
          // up to two extra quotes may directly precede the closing delimiter and belong to the text
          let run = 3;
          while (at(i + run) === '"') run += 1;
          if (run > 5) fail('too many quotes');
          out += '"'.repeat(run - 3);
          i += run;
          return out;
        }
      } else {
        if (ch === '"') {
          i += 1;
          return out;
        }
        if (ch === '\n') fail('newline in string');
      }
      if (ch === '\\') {
        const next = at(i + 1);
        const simple = ESCAPES[next];
        if (next !== '' && simple !== undefined) {
          out += simple;
          i += 2;
        } else if (next === 'u' || next === 'U') {
          const len = next === 'u' ? 4 : 8;
          const hex = text.slice(i + 2, i + 2 + len);
          if (!new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex)) fail('bad unicode escape');
          out += String.fromCodePoint(parseInt(hex, 16));
          i += 2 + len;
        } else if (multi && /[ \t\r\n]/.test(next)) {
          // line-ending backslash: swallow the newline and the whitespace after it
          let j = i + 1;
          while (at(j) === ' ' || at(j) === '\t') j += 1;
          if (at(j) === '\r') j += 1;
          if (at(j) !== '\n') fail('bad escape');
          while (/[ \t\r\n]/.test(at(j) || 'x')) j += 1;
          i = j;
        } else fail('bad escape');
      } else {
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

  const readKey = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      skipSpaces();
      if (at(i) === '"' || at(i) === "'") parts.push(readString());
      else {
        const start = i;
        while (i < text.length && BARE.test(at(i))) i += 1;
        if (i === start) fail('empty key');
        parts.push(text.slice(start, i));
      }
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

export const parseToml = (input: unknown): TomlTable => {
  const text = String(input ?? '').replace(/^﻿/, '');
  const s = makeScanner(text);
  const root: TomlTable = {};
  let current: TomlTable = root;
  while (!s.eof()) {
    const lineStart = s.pos;
    try {
      s.skipSpaces();
      const ch = s.peek();
      if (ch === '') break;
      if (ch === '\n' || ch === '\r') {
        s.advance();
        continue;
      }
      if (ch === '#') {
        s.skipComment();
        continue;
      }
      if (ch === '[') {
        const array = s.peek(1) === '[';
        s.advance(array ? 2 : 1);
        const parts = s.readKey();
        s.skipSpaces();
        if (!s.startsWith(array ? ']]' : ']')) s.fail('bad header');
        s.advance(array ? 2 : 1);
        current = enter(root, parts, { array });
      } else {
        const parts = s.readKey();
        s.skipSpaces();
        if (s.peek() !== '=') s.fail('expected =');
        s.advance();
        s.assign(current, parts, s.readValue());
      }
      s.skipSpaces();
      s.skipComment();
      if (!s.eof() && s.peek() !== '\n' && s.peek() !== '\r') s.fail('junk after value');
    } catch (error) {
      if (!(error instanceof Skip)) throw error;
      s.pos = Math.max(s.pos, lineStart);
      s.skipLine();
    }
  }
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
  for (let n = 0; n < firstTable; n += 1) {
    const current = lines[n] ?? '';
    if (keyLine.test(current)) {
      // A multi-line value would leave debris; only the common single-line form is replaced here.
      if (/("""|''')/.test(current)) throw new Error(`${key} is a multi-line string; edit config.toml by hand.`);
      lines[n] = line;
      return lines.join(newline);
    }
  }
  // insert after the last top-level key/value line before the first table, else at the top
  let at = 0;
  for (let n = 0; n < firstTable; n += 1) if (/^\s*[A-Za-z0-9_"'.-]+\s*=/.test(lines[n] ?? '')) at = n + 1;
  lines.splice(at, 0, line);
  return lines.join(newline);
};
