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

type DraftFile = { path: string; change: DiffFile['change']; added: number; removed: number; hunks: DiffHunk[] };
type DraftHunk = { header: string; lines: DiffLine[] };

const finishFile = (file: DraftFile): DiffFile => ({ ...file });

/** Reads unified diff text. Anything it does not recognise is skipped, never thrown on. */
export const parseUnifiedDiff = ({ text, isTruncated = false }: { text: string; isTruncated?: boolean }): ParsedDiff => {
  const files: DiffFile[] = [];
  let file: DraftFile | null = null;
  let hunk: DraftHunk | null = null;
  let oldNumber = 0;
  let newNumber = 0;

  const closeHunk = (): void => {
    if (file && hunk) file.hunks.push({ header: hunk.header, lines: hunk.lines });
    hunk = null;
  };
  const closeFile = (): void => {
    closeHunk();
    if (file) files.push(finishFile(file));
    file = null;
  };

  for (const line of text.split(/\r?\n/)) {
    const header = FILE_HEADER.exec(line);
    if (header) {
      closeFile();
      file = { path: header[2] ?? header[1] ?? '', change: 'modified', added: 0, removed: 0, hunks: [] };
      continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith('new file mode')) file.change = 'added';
      else if (line.startsWith('deleted file mode')) file.change = 'deleted';
      else if (line.startsWith('rename to ')) {
        file.change = 'renamed';
        file.path = line.slice('rename to '.length);
      } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) file.change = 'binary';
    }
    const start = HUNK_HEADER.exec(line);
    if (start) {
      closeHunk();
      oldNumber = Number(start[1]);
      newNumber = Number(start[2]);
      hunk = { header: line, lines: [] };
      continue;
    }
    if (!hunk) continue;
    const sign = line[0];
    if (sign === '+') {
      hunk.lines.push({ kind: 'added', text: line.slice(1), oldNumber: null, newNumber });
      newNumber += 1;
      file.added += 1;
    } else if (sign === '-') {
      hunk.lines.push({ kind: 'removed', text: line.slice(1), oldNumber, newNumber: null });
      oldNumber += 1;
      file.removed += 1;
    } else if (sign === ' ') {
      hunk.lines.push({ kind: 'context', text: line.slice(1), oldNumber, newNumber });
      oldNumber += 1;
      newNumber += 1;
    }
    // A line starting with "\" ("No newline at end of file") and anything else carries no code, so it is skipped.
  }
  closeFile();
  return { files, isTruncated };
};
