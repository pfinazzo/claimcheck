/**
 * Why this file exists: the code viewer for a fix. It shows what Claude committed: the changed
 * files on the left, and each file's changes with line numbers and +/- marks on the right. Read only.
 *
 * @author Patrick Finazzo
 */

import type { DiffFile, DiffHunk } from '../shared/diff.ts';
import type { DeskBridge } from '../shared/ipc.ts';
import type { DialogHost } from './dialogs.ts';
import { makeElement, mount } from './dom.ts';

type InspectedFix = Awaited<ReturnType<DeskBridge['inspectFix']>>;

const CHANGE_WORDS = new Map<DiffFile['change'], string>([
  ['added', 'new'],
  ['deleted', 'deleted'],
  ['renamed', 'renamed'],
  ['modified', 'changed'],
  ['binary', 'binary'],
]);

const LINE_SIGNS = new Map<string, string>([
  ['added', '+'],
  ['removed', '-'],
  ['context', ' '],
]);

const LONGEST_FILE_VIEW_LINES = 3000;

const renderLineNumber = ({ value }: { value: number | null }): string => (value === null ? '' : String(value));

/** The hunks of a file, cut so that no more than `limit` lines are shown in all. */
const trimHunks = ({ hunks, limit }: { hunks: readonly DiffHunk[]; limit: number }): readonly DiffHunk[] =>
  hunks.reduce<{ kept: readonly DiffHunk[]; left: number }>(
    (carried, hunk) => {
      const lines = hunk.lines.slice(0, Math.max(0, carried.left));
      return { kept: lines.length ? [...carried.kept, { header: hunk.header, lines }] : carried.kept, left: carried.left - lines.length };
    },
    { kept: [], left: limit },
  ).kept;

const renderFileView = ({ file }: { file: DiffFile }): HTMLElement => {
  if (file.change === 'binary') return makeElement({ tag: 'p', props: { class: 'muted' }, children: ['This is a binary file, so there is no text to show.'] });
  if (file.hunks.length === 0) return makeElement({ tag: 'p', props: { class: 'muted' }, children: ['The file changed, but git reports no lines to show (for example a mode change or a plain rename).'] });
  const totalLines = file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  const hunks = trimHunks({ hunks: file.hunks, limit: LONGEST_FILE_VIEW_LINES }).map((hunk) =>
    makeElement({
      tag: 'div',
      props: { class: 'hunk' },
      children: [
        makeElement({ tag: 'div', props: { class: 'hunk-head' }, children: [hunk.header] }),
        ...hunk.lines.map((line) =>
          makeElement({
            tag: 'div',
            props: { class: `diff-line ${line.kind}` },
            children: [
              makeElement({ tag: 'span', props: { class: 'ln' }, children: [renderLineNumber({ value: line.oldNumber })] }),
              makeElement({ tag: 'span', props: { class: 'ln' }, children: [renderLineNumber({ value: line.newNumber })] }),
              makeElement({ tag: 'span', props: { class: 'sign' }, children: [LINE_SIGNS.get(line.kind) ?? ' '] }),
              makeElement({ tag: 'span', props: { class: 'src' }, children: [line.text || ' '] }),
            ],
          }),
        ),
      ],
    }),
  );
  const cutNote = totalLines > LONGEST_FILE_VIEW_LINES ? makeElement({ tag: 'p', props: { class: 'muted' }, children: [`This file has more than ${LONGEST_FILE_VIEW_LINES} changed lines. Open the worktree to read the rest.`] }) : null;
  return makeElement({ tag: 'div', props: {}, children: [...hunks, cutNote] });
};

/** Shows what Claude committed for a fix: the files, then each file's changes with line numbers. Read only. */
export const showCodeDialog = ({ host, fix }: { host: DialogHost; fix: InspectedFix }): void => {
  const files = fix.diff.files;
  if (files.length === 0) {
    host.show('The code Claude wrote', makeElement({ tag: 'p', props: { class: 'muted' }, children: [`${fix.branch} has no changes compared with ${fix.base} yet.`] }));
    return;
  }
  const totals = files.reduce((carried, file) => ({ added: carried.added + file.added, removed: carried.removed + file.removed }), { added: 0, removed: 0 });
  const list = makeElement({ tag: 'ul', props: { class: 'plain code-files' } });
  const pane = makeElement({ tag: 'div', props: { class: 'code-pane' } });
  const selection = { index: 0 };

  const drawPane = (): void => {
    const file = files[selection.index];
    mount({ parent: pane, children: file ? [makeElement({ tag: 'div', props: {}, children: [makeElement({ tag: 'h3', props: {}, children: [file.path] }), renderFileView({ file })] })] : [] });
    pane.scrollTop = 0;
  };

  const drawList = (): void =>
    mount({
      parent: list,
      children: files.map((file, index) =>
        makeElement({
          tag: 'li',
          props: {},
          children: [
            makeElement({
              tag: 'button',
              props: {
                class: `code-file${index === selection.index ? ' is-selected' : ''}`,
                attrs: { type: 'button', 'aria-pressed': index === selection.index },
                on: {
                  click: () => {
                    selection.index = index;
                    drawList();
                    drawPane();
                  },
                },
              },
              children: [
                makeElement({ tag: 'span', props: { class: 'code-file-name' }, children: [file.path] }),
                makeElement({ tag: 'span', props: { class: 'code-file-stats' }, children: [`${CHANGE_WORDS.get(file.change) ?? file.change}  +${file.added} -${file.removed}`] }),
              ],
            }),
          ],
        }),
      ),
    });
  drawList();
  drawPane();

  host.showWide(
    'The code Claude wrote',
    makeElement({
      tag: 'p',
      props: { class: 'muted' },
      children: [`${fix.branch} compared with ${fix.base}: ${files.length} ${files.length === 1 ? 'file' : 'files'}, ${totals.added} lines added, ${totals.removed} removed. Nothing here can be edited.`],
    }),
    fix.diff.isTruncated ? makeElement({ tag: 'p', props: { class: 'error' }, children: ['This change is large, so the end of it is not shown. Open the worktree to read all of it.'] }) : null,
    fix.commits.length
      ? makeElement({
          tag: 'details',
          props: { class: 'more' },
          children: [makeElement({ tag: 'summary', props: {}, children: [`${fix.commits.length} ${fix.commits.length === 1 ? 'commit' : 'commits'}`] }), makeElement({ tag: 'pre', props: { class: 'code' }, children: [fix.commits.join('\n')] })],
        })
      : null,
    makeElement({
      tag: 'div',
      props: { class: 'code-view' },
      children: [makeElement({ tag: 'nav', props: { class: 'code-list', attrs: { 'aria-label': 'Changed files' } }, children: [list] }), pane],
    }),
  );
};
