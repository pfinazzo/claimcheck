/**
 * The board: a slim top bar, one summary sentence, the claims in two groups, and the selected
 * claim's detail beside them.
 *
 * @author Patrick Finazzo
 */

import type { PublicRun } from '../lib/fixer.ts';
import type { Board, Claim } from '../shared/types.ts';
import { renderDetail, type DetailActions } from './detail.ts';
import { makeElement, type Child } from './dom.ts';
import { formatFactsLine, collectClaimGroups, formatSpecWord, formatSummaryLine } from './format.ts';

export type BoardUi = {
  board: Board | null;
  selectedId: string | null;
  runs: Map<string, PublicRun>;
  ghOk: boolean;
  running: boolean;
  drawer: { open: boolean; status: string; lines: readonly string[] };
};

export type BoardActions = DetailActions & {
  select: (options: { id: string | null }) => void;
  openRepo: () => void;
  connectClaude: () => void;
  runClaimcheck: () => void;
  writeSpec: () => void;
  closeDrawer: () => void;
};

const renderButton = ({ label, onClick, cls = '', disabled = false }: { label: string; onClick: () => void; cls?: string; disabled?: boolean }): HTMLButtonElement =>
  makeElement({ tag: 'button', props: { class: `btn ${cls}`.trim(), attrs: { type: 'button', disabled }, on: { click: onClick } }, children: [label] });

const renderHeader = ({ ui, actions }: { ui: BoardUi; actions: BoardActions }): HTMLElement => {
  const board = ui.board;
  return makeElement({ tag: 'header', props: { class: 'topbar' }, children: [makeElement({ tag: 'div', props: { class: 'repo' }, children: [makeElement({ tag: 'strong', props: {}, children: [board ? board.repo.name : 'claimcheck Desk'] }), board ? makeElement({ tag: 'span', props: { class: 'muted' }, children: [[board.repo.branch, formatSpecWord({ state: board.repo.specState })].filter(Boolean).join('  ·  ')] }) : null] }), makeElement({ tag: 'div', props: { class: 'row' }, children: [board ? renderButton({ label: 'Write a spec', onClick: actions.writeSpec }) : null, renderButton({ label: 'Connect Claude', onClick: actions.connectClaude }), board ? renderButton({ label: ui.running ? 'Running…' : 'Run claimcheck', onClick: actions.runClaimcheck, cls: 'primary', disabled: ui.running }) : null, renderButton({ label: 'Open repo', onClick: actions.openRepo })] })] });
};

/** The badge for a claim that is already handled; claims still open have none. */
const DONE_LABEL = new Map<unknown, string>([
  ['resolved', 'Resolved'],
  ['accepted', 'Accepted'],
  ['fixing', 'Fix in progress'],
]);

const renderRow = ({ claim, ui, boardActions }: { claim: Claim; ui: BoardUi; boardActions: BoardActions }): HTMLElement => {
  const done = DONE_LABEL.get(claim.status) ?? '';
  return makeElement({ tag: 'button', props: {
      class: `claim-row${claim.id === ui.selectedId ? ' selected' : ''}`,
      attrs: { type: 'button', 'aria-pressed': claim.id === ui.selectedId },
      dataset: { claim: claim.id },
      on: { click: () => boardActions.select({ id: claim.id }) },
    }, children: [makeElement({ tag: 'span', props: { class: 'claim-title' }, children: [claim.claim] }), makeElement({ tag: 'span', props: { class: 'claim-facts' }, children: [formatFactsLine({ claim })] }), done ? makeElement({ tag: 'span', props: { class: 'claim-status' }, children: [done] }) : null] });
};

const renderGroup = ({ title, claims, ui, boardActions }: { title: string; claims: readonly Claim[]; ui: BoardUi; boardActions: BoardActions }): HTMLElement | null =>
  claims.length ? makeElement({ tag: 'section', props: { class: 'group' }, children: [makeElement({ tag: 'h3', props: {}, children: [`${title} (${claims.length})`] }), ...claims.map((claim) => renderRow({ claim, ui, boardActions }))] }) : null;

const renderEmptyState = ({ ui, actions }: { ui: BoardUi; actions: BoardActions }): HTMLElement =>
  makeElement({ tag: 'div', props: { class: 'empty-state' }, children: [makeElement({ tag: 'h2', props: {}, children: [ui.board ? 'No claims yet' : 'Open a repository'] }), makeElement({ tag: 'p', props: { class: 'muted' }, children: [ui.board
        ? 'Your coding agent adds claims to .claimcheck/claims.yaml as it works. When it has, press Run claimcheck.'
        : 'Pick a project folder. If it is not set up for claimcheck yet, Desk walks you through it.'] }), ui.board ? null : renderButton({ label: 'Open repo', onClick: actions.openRepo, cls: 'primary' })] });

const renderDrawer = ({ ui, actions }: { ui: BoardUi; actions: BoardActions }): HTMLElement | null =>
  ui.drawer.open
    ? makeElement({ tag: 'section', props: { class: 'drawer' }, children: [makeElement({ tag: 'div', props: { class: 'drawer-head' }, children: [makeElement({ tag: 'strong', props: {}, children: ['claimcheck run'] }), makeElement({ tag: 'span', props: { class: 'muted' }, children: [ui.drawer.status] }), renderButton({ label: 'Close', onClick: actions.closeDrawer })] }), makeElement({ tag: 'pre', props: { class: 'code' }, children: [ui.drawer.lines.join('\n')] })] })
    : null;

/** Everything inside #app for the board view. */
export const renderBoard = ({ ui, actions }: { ui: BoardUi; actions: BoardActions }): Child[] => {
  const board = ui.board;
  const claims = board?.claims ?? [];
  const groups = board ? collectClaimGroups({ board: board }) : { needs: [], backed: [] };
  const selected = claims.find((claim) => claim.id === ui.selectedId) ?? null;
  return [
    renderHeader({ ui, actions }),
    board ? makeElement({ tag: 'p', props: { class: 'summary' }, children: [formatSummaryLine({ board: board })] }) : null,
    claims.length === 0
      ? renderEmptyState({ ui, actions })
      : makeElement({ tag: 'main', props: { class: 'split' }, children: [makeElement({ tag: 'nav', props: { class: 'claims', attrs: { 'aria-label': 'Claims' } }, children: [renderGroup({ title: 'Needs a decision', claims: groups.needs, ui, boardActions: actions }), renderGroup({ title: 'Backed', claims: groups.backed, ui, boardActions: actions })] }), renderDetail({ claim: selected, run: selected ? (ui.runs.get(selected.id) ?? null) : null, ghOk: ui.ghOk, detailActions: actions })] }),
    renderDrawer({ ui, actions }),
  ];
};
