/**
 * Why this file exists: Desk shows the code Claude wrote for a fix, and the page needs it as
 * files, hunks and numbered lines rather than one block of text. This turns the output of
 * `git diff` into that shape. It is pure, so the page and the tests use the same reader, and
 * every line stays plain text that the page draws with text nodes only.
 *
 * @author Patrick Finazzo
 */

export type DiffLine = {
  kind: 'added' | 'removed' | 'context';
  text: string;
  /** Line number in the old file, or null for an added line. */
  oldNumber: number | null;
  /** Line number in the new file, or null for a removed line. */
  newNumber: number | null;
};

export type DiffHunk = {
  header: string;
  lines: readonly DiffLine[];
};

export type DiffFile = {
  path: string;
  /** What happened to the file as a whole. */
  change: 'added' | 'deleted' | 'renamed' | 'modified' | 'binary';
  added: number;
  removed: number;
  hunks: readonly DiffHunk[];
};

export type ParsedDiff = {
  files: readonly DiffFile[];
  /** True when the text was cut before the end, so some files or lines are missing. */
  isTruncated: boolean;
};

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;

const LINE_KINDS = new Map<string, DiffLine['kind']>([
  ['+', 'added'],
  ['-', 'removed'],
  [' ', 'context'],
]);

/** The lines git writes between a file's header and its first hunk, and the change each one announces. */
const FILE_HEADER_CHANGES: readonly { startsWith: string; change: DiffFile['change'] }[] = [
  { startsWith: 'new file mode', change: 'added' },
  { startsWith: 'deleted file mode', change: 'deleted' },
  { startsWith: 'rename to ', change: 'renamed' },
  { startsWith: 'Binary files ', change: 'binary' },
  { startsWith: 'GIT binary patch', change: 'binary' },
];

type DraftHunk = { header: string; lines: readonly DiffLine[] };

type DraftFile = DiffFile & { hunk: DraftHunk | null };

/** Where the reader is: the files finished so far, the file being read, and the next line numbers. */
type Cursor = { done: readonly DiffFile[]; file: DraftFile | null; oldNumber: number; newNumber: number };

const START: Cursor = { done: [], file: null, oldNumber: 0, newNumber: 0 };

const closeHunk = ({ file }: { file: DraftFile }): DraftFile => (file.hunk ? { ...file, hunks: [...file.hunks, { header: file.hunk.header, lines: file.hunk.lines }], hunk: null } : file);

const toDiffFile = ({ file }: { file: DraftFile }): DiffFile => {
  const closed = closeHunk({ file });
  return { path: closed.path, change: closed.change, added: closed.added, removed: closed.removed, hunks: closed.hunks };
};

const startFile = ({ cursor, path }: { cursor: Cursor; path: string }): Cursor => ({
  done: cursor.file ? [...cursor.done, toDiffFile({ file: cursor.file })] : cursor.done,
  file: { path, change: 'modified', added: 0, removed: 0, hunks: [], hunk: null },
  oldNumber: 0,
  newNumber: 0,
});

const startHunk = ({ cursor, file, line, match }: { cursor: Cursor; file: DraftFile; line: string; match: RegExpExecArray }): Cursor => ({
  done: cursor.done,
  file: { ...closeHunk({ file }), hunk: { header: line, lines: [] } },
  oldNumber: Number(match[1]),
  newNumber: Number(match[2]),
});

/** A line before the first hunk of a file: it may say the file is new, deleted, renamed or binary. */
const applyFileHeader = ({ file, line }: { file: DraftFile; line: string }): DraftFile => {
  const found = FILE_HEADER_CHANGES.find((entry) => line.startsWith(entry.startsWith));
  if (!found) return file;
  return { ...file, change: found.change, path: found.change === 'renamed' ? line.slice('rename to '.length) : file.path };
};

/** One line of code in the current hunk. A line that carries no code, such as "No newline at end of file", is skipped. */
const addBodyLine = ({ cursor, file, hunk, line }: { cursor: Cursor; file: DraftFile; hunk: DraftHunk; line: string }): Cursor => {
  const kind = LINE_KINDS.get(line.charAt(0));
  if (!kind) return cursor;
  const isAdded = kind === 'added';
  const isRemoved = kind === 'removed';
  const entry: DiffLine = { kind, text: line.slice(1), oldNumber: isAdded ? null : cursor.oldNumber, newNumber: isRemoved ? null : cursor.newNumber };
  return {
    done: cursor.done,
    file: { ...file, hunk: { header: hunk.header, lines: [...hunk.lines, entry] }, added: file.added + (isAdded ? 1 : 0), removed: file.removed + (isRemoved ? 1 : 0) },
    oldNumber: cursor.oldNumber + (isAdded ? 0 : 1),
    newNumber: cursor.newNumber + (isRemoved ? 0 : 1),
  };
};

const applyLine = ({ cursor, line }: { cursor: Cursor; line: string }): Cursor => {
  const header = FILE_HEADER.exec(line);
  if (header) return startFile({ cursor, path: header[2] ?? header[1] ?? '' });
  const file = cursor.file;
  if (!file) return cursor;
  const match = HUNK_HEADER.exec(line);
  if (match) return startHunk({ cursor, file, line, match });
  if (!file.hunk) return { ...cursor, file: applyFileHeader({ file, line }) };
  return addBodyLine({ cursor, file, hunk: file.hunk, line });
};

/** Reads unified diff text. Anything it does not recognise is skipped, never thrown on. */
export const parseUnifiedDiff = ({ text, isTruncated = false }: { text: string; isTruncated?: boolean }): ParsedDiff => {
  const end = text.split(/\r?\n/).reduce((cursor, line) => applyLine({ cursor, line }), START);
  return { files: end.file ? [...end.done, toDiffFile({ file: end.file })] : end.done, isTruncated };
};
