/**
 * The board: a slim top bar, one summary sentence, the claims in two groups, and the selected
 * claim's detail beside them.
 *
 * @author Patrick Finazzo
 */

import type { PublicRun } from '../lib/fixer.ts';
import type { Board, Claim } from '../shared/types.ts';
import { renderDetail, type DetailActions } from './detail.ts';
import { h, type Child } from './dom.ts';
import { factsLine, groupClaims, specWord, summaryLine } from './format.ts';

export type BoardUi = {
  board: Board | null;
  selectedId: string | null;
  runs: Map<string, PublicRun>;
  ghOk: boolean;
  running: boolean;
  drawer: { open: boolean; status: string; lines: string[] };
};

export type BoardActions = DetailActions & {
  select: (id: string | null) => void;
  openRepo: () => void;
  connectClaude: () => void;
  runClaimcheck: () => void;
  writeSpec: () => void;
  closeDrawer: () => void;
};

const btn = (label: string, onClick: () => void, cls = '', disabled = false): HTMLButtonElement =>
  h('button', { class: `btn ${cls}`.trim(), attrs: { type: 'button', disabled }, on: { click: onClick } }, label);

const header = (ui: BoardUi, a: BoardActions): HTMLElement => {
  const b = ui.board;
  return h(
    'header',
    { class: 'topbar' },
    h(
      'div',
      { class: 'repo' },
      h('strong', {}, b ? b.repo.name : 'claimcheck Desk'),
      b ? h('span', { class: 'muted' }, [b.repo.branch, specWord(b.repo.specState)].filter(Boolean).join('  ·  ')) : null,
    ),
    h(
      'div',
      { class: 'row' },
      b ? btn('Write a spec', a.writeSpec) : null,
      btn('Connect Claude', a.connectClaude),
      b ? btn(ui.running ? 'Running…' : 'Run claimcheck', a.runClaimcheck, 'primary', ui.running) : null,
      btn('Open repo', a.openRepo),
    ),
  );
};

const row = (claim: Claim, ui: BoardUi, a: BoardActions): HTMLElement => {
  const done = claim.status === 'resolved' ? 'Resolved' : claim.status === 'accepted' ? 'Accepted' : claim.status === 'fixing' ? 'Fix in progress' : '';
  return h(
    'button',
    {
      class: `claim-row${claim.id === ui.selectedId ? ' selected' : ''}`,
      attrs: { type: 'button', 'aria-pressed': claim.id === ui.selectedId },
      data: { claim: claim.id },
      on: { click: () => a.select(claim.id) },
    },
    h('span', { class: 'claim-title' }, claim.claim),
    h('span', { class: 'claim-facts' }, factsLine(claim)),
    done ? h('span', { class: 'claim-status' }, done) : null,
  );
};

const group = (title: string, claims: Claim[], ui: BoardUi, a: BoardActions): HTMLElement | null =>
  claims.length ? h('section', { class: 'group' }, h('h3', {}, `${title} (${claims.length})`), ...claims.map((c) => row(c, ui, a))) : null;

const emptyState = (ui: BoardUi, a: BoardActions): HTMLElement =>
  h(
    'div',
    { class: 'empty-state' },
    h('h2', {}, ui.board ? 'No claims yet' : 'Open a repository'),
    h(
      'p',
      { class: 'muted' },
      ui.board
        ? 'Your coding agent adds claims to .claimcheck/claims.yaml as it works. When it has, press Run claimcheck.'
        : 'Pick a project folder. If it is not set up for claimcheck yet, Desk walks you through it.',
    ),
    ui.board ? null : btn('Open repo', a.openRepo, 'primary'),
  );

const drawer = (ui: BoardUi, a: BoardActions): HTMLElement | null =>
  ui.drawer.open
    ? h(
        'section',
        { class: 'drawer' },
        h('div', { class: 'drawer-head' }, h('strong', {}, 'claimcheck run'), h('span', { class: 'muted' }, ui.drawer.status), btn('Close', a.closeDrawer)),
        h('pre', { class: 'code' }, ui.drawer.lines.join('\n')),
      )
    : null;

/** Everything inside #app for the board view. */
export const renderBoard = (ui: BoardUi, a: BoardActions): Child[] => {
  const b = ui.board;
  const claims = b?.claims ?? [];
  const groups = b ? groupClaims(b) : { needs: [], backed: [] };
  const selected = claims.find((c) => c.id === ui.selectedId) ?? null;
  return [
    header(ui, a),
    b ? h('p', { class: 'summary' }, summaryLine(b)) : null,
    claims.length === 0
      ? emptyState(ui, a)
      : h(
          'main',
          { class: 'split' },
          h('nav', { class: 'claims', attrs: { 'aria-label': 'Claims' } }, group('Needs a decision', groups.needs, ui, a), group('Backed', groups.backed, ui, a)),
          renderDetail(selected, selected ? (ui.runs.get(selected.id) ?? null) : null, ui.ghOk, a),
        ),
    drawer(ui, a),
  ];
};
