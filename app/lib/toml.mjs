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

class Skip extends Error {}

const BARE = /[A-Za-z0-9_-]/;
const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };

const put = (obj, key, value) => Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const makeScanner = (text) => {
  let i = 0;
  const fail = (msg) => {
    throw new Skip(msg);
  };
  const peek = (n = 0) => text[i + n];
  const startsWith = (s) => text.startsWith(s, i);
  const skipSpaces = () => {
    while (text[i] === ' ' || text[i] === '\t') i += 1;
  };
  const skipComment = () => {
    if (text[i] === '#') while (i < text.length && text[i] !== '\n') i += 1;
  };
  /** Inside arrays: spaces, newlines and comments. */
  const skipBlank = () => {
    for (;;) {
      skipSpaces();
      if (text[i] === '\r' || text[i] === '\n') i += 1;
      else if (text[i] === '#') skipComment();
      else return;
    }
  };

  const readBasicString = (multi) => {
    let out = '';
    i += multi ? 3 : 1;
    if (multi && text[i] === '\r' && text[i + 1] === '\n') i += 2;
    else if (multi && text[i] === '\n') i += 1;
    for (;;) {
      if (i >= text.length) fail('unterminated string');
      const ch = text[i];
      if (multi) {
        if (startsWith('"""')) {
          // up to two extra quotes may directly precede the closing delimiter and belong to the text
          let run = 3;
          while (text[i + run] === '"') run += 1;
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
        const next = text[i + 1];
        if (next in ESCAPES) {
          out += ESCAPES[next];
          i += 2;
        } else if (next === 'u' || next === 'U') {
          const len = next === 'u' ? 4 : 8;
          const hex = text.slice(i + 2, i + 2 + len);
          if (!new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex)) fail('bad unicode escape');
          out += String.fromCodePoint(parseInt(hex, 16));
          i += 2 + len;
        } else if (multi && /[ \t\r\n]/.test(next ?? '')) {
          // line-ending backslash: swallow the newline and the whitespace after it
          let j = i + 1;
          while (text[j] === ' ' || text[j] === '\t') j += 1;
          if (text[j] === '\r') j += 1;
          if (text[j] !== '\n') fail('bad escape');
          while (/[ \t\r\n]/.test(text[j] ?? 'x')) j += 1;
          i = j;
        } else fail('bad escape');
      } else {
        out += ch;
        i += 1;
      }
    }
  };

  const readLiteralString = (multi) => {
    i += multi ? 3 : 1;
    if (multi && text[i] === '\r' && text[i + 1] === '\n') i += 2;
    else if (multi && text[i] === '\n') i += 1;
    const end = multi ? text.indexOf("'''", i) : text.indexOf("'", i);
    if (end < 0) fail('unterminated string');
    const body = text.slice(i, end);
    if (!multi && body.includes('\n')) fail('newline in string');
    i = end + (multi ? 3 : 1);
    return body;
  };

  const readString = () => {
    if (text[i] === '"') return readBasicString(startsWith('"""'));
    return readLiteralString(startsWith("'''"));
  };

  const readKey = () => {
    const parts = [];
    for (;;) {
      skipSpaces();
      if (text[i] === '"' || text[i] === "'") parts.push(readString());
      else {
        const start = i;
        while (i < text.length && BARE.test(text[i])) i += 1;
        if (i === start) fail('empty key');
        parts.push(text.slice(start, i));
      }
      skipSpaces();
      if (text[i] === '.') i += 1;
      else return parts;
    }
  };

  const scalar = (token) => {
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

  const readValue = () => {
    skipSpaces();
    const ch = text[i];
    if (ch === '"' || ch === "'") return readString();
    if (ch === '[') return readArray();
    if (ch === '{') return readInlineTable();
    const start = i;
    while (i < text.length && !/[\s,\]}#]/.test(text[i])) i += 1;
    // a time-of-day or datetime may contain one space between date and time
    if (/^\d{4}-\d{2}-\d{2}$/.test(text.slice(start, i)) && /^ \d{2}:\d{2}/.test(text.slice(i, i + 6))) {
      i += 1;
      while (i < text.length && !/[\s,\]}#]/.test(text[i])) i += 1;
    }
    if (i === start) fail('missing value');
    return scalar(text.slice(start, i));
  };

  const readArray = () => {
    i += 1;
    const items = [];
    for (;;) {
      skipBlank();
      if (i >= text.length) fail('unterminated array');
      if (text[i] === ']') {
        i += 1;
        return items;
      }
      items.push(readValue());
      skipBlank();
      if (text[i] === ',') i += 1;
      else if (text[i] !== ']') fail('bad array');
    }
  };

  const assign = (table, parts, value) => {
    let node = table;
    for (const part of parts.slice(0, -1)) {
      if (!has(node, part)) put(node, part, {});
      node = node[part];
      if (Array.isArray(node)) node = node[node.length - 1];
      if (!node || typeof node !== 'object') fail('key path is not a table');
    }
    const last = parts[parts.length - 1];
    if (has(node, last)) fail('duplicate key');
    put(node, last, value);
  };

  const readInlineTable = () => {
    i += 1;
    const table = {};
    skipSpaces();
    if (text[i] === '}') {
      i += 1;
      return table;
    }
    for (;;) {
      skipBlank();
      const parts = readKey();
      skipSpaces();
      if (text[i] !== '=') fail('expected =');
      i += 1;
      assign(table, parts, readValue());
      skipBlank();
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text[i] === '}') {
        i += 1;
        return table;
      }
      fail('bad inline table');
    }
  };

  return {
    get pos() {
      return i;
    },
    set pos(v) {
      i = v;
    },
    eof: () => i >= text.length,
    peek,
    startsWith,
    skipSpaces,
    skipComment,
    skipBlank,
    readKey,
    readValue,
    assign,
    advance: (n = 1) => {
      i += n;
    },
    skipLine: () => {
      while (i < text.length && text[i] !== '\n') i += 1;
    },
    fail,
  };
};

const enter = (root, parts, { array }) => {
  let node = root;
  parts.forEach((part, idx) => {
    const last = idx === parts.length - 1;
    if (!has(node, part)) put(node, part, array && last ? [] : {});
    let next = node[part];
    if (last && array) {
      if (!Array.isArray(next)) throw new Skip('not an array of tables');
      const fresh = {};
      next.push(fresh);
      node = fresh;
      return;
    }
    if (Array.isArray(next)) next = next[next.length - 1];
    if (!next || typeof next !== 'object') throw new Skip('not a table');
    node = next;
  });
  return node;
};

export const parseToml = (input) => {
  const text = String(input ?? '').replace(/^﻿/, '');
  const s = makeScanner(text);
  const root = {};
  let current = root;
  while (!s.eof()) {
    const lineStart = s.pos;
    try {
      s.skipSpaces();
      const ch = s.peek();
      if (ch === undefined) break;
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

const tomlBasicString = (value) =>
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
export const setTomlString = (text, key, value) => {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`Not a plain key: ${key}`);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const line = `${key} = ${tomlBasicString(value)}`;
  const keyLine = new RegExp(`^\\s*${key}\\s*=`);
  const headerLine = /^\s*\[/;
  let firstTable = lines.findIndex((l) => headerLine.test(l));
  if (firstTable < 0) firstTable = lines.length;
  for (let n = 0; n < firstTable; n += 1) {
    if (keyLine.test(lines[n])) {
      // A multi-line value would leave debris; only the common single-line form is replaced here.
      if (/("""|''')/.test(lines[n])) throw new Error(`${key} is a multi-line string; edit config.toml by hand.`);
      lines[n] = line;
      return lines.join(newline);
    }
  }
  // insert after the last top-level key/value line before the first table, else at the top
  let at = 0;
  for (let n = 0; n < firstTable; n += 1) if (/^\s*[A-Za-z0-9_"'.-]+\s*=/.test(lines[n])) at = n + 1;
  lines.splice(at, 0, line);
  return lines.join(newline);
};
