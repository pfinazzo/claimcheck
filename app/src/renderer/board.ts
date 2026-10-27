/**
 * The board: a glass top bar, three figures, the claims in two groups with a confidence meter
 * each, and the selected claim's detail beside them.
 *
 * @author Patrick Finazzo
 */

import type { PublicRun } from '../lib/fixer.ts';
import type { Board, Claim } from '../shared/types.ts';
import { pullRequestBlocker } from '../shared/pull-request.ts';
import { renderDetail, type DetailActions } from './detail.ts';
import { h, type Child } from './dom.ts';
import { factsLine, groupClaims, specWord, summaryLine, summaryStats } from './format.ts';
import { renderGraphView } from './graph-view.ts';

export type BoardMode = 'list' | 'graph';

export type BoardUi = {
  board: Board | null;
  /** The board shows the claims as a list with a detail pane, or as the confidence map with a table of all of them. */
  mode: BoardMode;
  selectedId: string | null;
  runs: Map<string, PublicRun>;
  ghOk: boolean;
  running: boolean;
  drawer: { open: boolean; status: string; lines: string[] };
};

export type BoardActions = DetailActions & {
  select: (id: string | null) => void;
  setMode: (mode: BoardMode) => void;
  /** Opens one claim in the list view. */
  showClaim: (id: string) => void;
  openRepo: () => void;
  connectClaude: () => void;
  runClaimcheck: () => void;
  writeSpec: () => void;
  closeDrawer: () => void;
};

const CLAIM_STATUS_WORDS: Record<Claim['status'], string> = { open: '', fixing: 'Fix in progress', resolved: 'Resolved', accepted: 'Accepted' };

const btn = (label: string, onClick: () => void, cls = '', disabled = false): HTMLButtonElement =>
  h('button', { class: `btn ${cls}`.trim(), attrs: { type: 'button', disabled }, on: { click: onClick } }, label);

const header = (ui: BoardUi, a: BoardActions): HTMLElement => {
  const b = ui.board;
  return h(
    'header',
    { class: 'topbar panel' },
    h(
      'div',
      { class: 'brand' },
      h('span', { class: 'mark', attrs: { 'aria-hidden': 'true' } }),
      h(
        'div',
        { class: 'repo' },
        h('strong', {}, b ? b.repo.name : 'claimcheck Desk'),
        b
          ? h(
              'span',
              { class: 'repo-meta' },
              b.repo.branch ? h('span', { class: 'branch' }, b.repo.branch) : null,
              h('span', {}, h('span', { class: `dot ${b.repo.specState}`, attrs: { 'aria-hidden': 'true' } }), specWord(b.repo.specState)),
            )
          : null,
      ),
    ),
    h(
      'div',
      { class: 'row' },
      b ? btn('Write a spec', a.writeSpec) : null,
      btn('Connect Claude', a.connectClaude),
      btn('Connect GitHub', a.connectGithub),
      b ? btn(ui.running ? 'Running…' : 'Run claimcheck', a.runClaimcheck, 'primary', ui.running) : null,
      btn('Open repo', a.openRepo),
    ),
  );
};

/** A bar filled to `ratio` (0 to 1). The width is set through the CSSOM, since the CSP forbids inline style attributes. */
const meterBar = (ratio: number, weak: boolean): HTMLElement => {
  const fill = h('span');
  fill.style.width = `${Math.round(ratio * 100)}%`;
  return h('span', { class: `meter${weak ? ' weak' : ''}` }, fill);
};

const stat = (cls: string, label: string, value: Child, note: Child, meter: HTMLElement | null = null): HTMLElement =>
  h('div', { class: `stat panel ${cls}`.trim() }, h('span', { class: 'stat-label' }, label), h('span', { class: 'stat-value' }, value, note), meter);

/** Three figures: claims, how many need a decision, and planted bugs caught. */
const stats = (b: Board): HTMLElement => {
  const s = summaryStats(b);
  const rate = s.total === 0 ? null : s.caught / s.total;
  const meter = rate === null ? null : meterBar(rate, rate < 0.8);
  return h(
    'section',
    { class: 'stats', attrs: { 'aria-label': summaryLine(b) } },
    stat('', 'Claims', s.claims, null),
    stat(s.needs === 0 ? 'clear' : 'needs', 'Need a decision', s.needs, s.needs === 0 ? h('small', {}, 'none') : null),
    stat('', 'Planted bugs caught', s.total === 0 ? '–' : s.caught, s.total === 0 ? h('small', {}, 'no run yet') : h('small', {}, `of ${s.total}`), meter),
  );
};

const confidenceMeter = (claim: Claim, weak: boolean): HTMLElement | null =>
  claim.confidence === null
    ? null
    : h(
        'span',
        { class: 'claim-meter', attrs: { 'aria-hidden': 'true' } },
        meterBar(claim.confidence, weak),
        h('span', { class: 'num' }, claim.confidence.toFixed(2)),
      );

const row = (claim: Claim, ui: BoardUi, a: BoardActions, weak: boolean): HTMLElement => {
  const done = CLAIM_STATUS_WORDS[claim.status];
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
    confidenceMeter(claim, weak),
    done ? h('span', { class: 'claim-status' }, done) : null,
  );
};

const group = (title: string, claims: Claim[], ui: BoardUi, a: BoardActions, weak: boolean): HTMLElement | null =>
  claims.length ? h('section', { class: 'group' }, h('h3', {}, `${title} (${claims.length})`), ...claims.map((c) => row(c, ui, a, weak))) : null;

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
        { class: 'drawer panel' },
        h('div', { class: 'drawer-head' }, h('strong', {}, 'claimcheck run'), h('span', { class: 'muted' }, ui.drawer.status), btn('Close', a.closeDrawer)),
        h('pre', { class: 'code' }, ui.drawer.lines.join('\n')),
      )
    : null;

const MODE_LABELS: Record<BoardMode, string> = { list: 'Claims', graph: 'Confidence map' };

const modeTabs = (ui: BoardUi, a: BoardActions): HTMLElement =>
  h(
    'div',
    { class: 'tabs mode-tabs', attrs: { role: 'tablist', 'aria-label': 'Board view' } },
    ...(Object.keys(MODE_LABELS) as BoardMode[]).map((mode) =>
      h('button', { class: `tab${ui.mode === mode ? ' active' : ''}`, attrs: { type: 'button', role: 'tab', 'aria-selected': ui.mode === mode }, on: { click: () => a.setMode(mode) } }, MODE_LABELS[mode]),
    ),
  );

/** Everything inside #app for the board view. */
export const renderBoard = (ui: BoardUi, a: BoardActions): Child[] => {
  const b = ui.board;
  const claims = b?.claims ?? [];
  const groups = b ? groupClaims(b) : { needs: [], backed: [] };
  const selected = claims.find((c) => c.id === ui.selectedId) ?? null;
  return [
    header(ui, a),
    b && claims.length ? stats(b) : null,
    b && claims.length ? modeTabs(ui, a) : null,
    claims.length === 0
      ? emptyState(ui, a)
      : ui.mode === 'graph'
        ? renderGraphView(ui, a)[0] ?? null
        : h(
          'main',
          { class: 'split' },
          h('nav', { class: 'claims panel', attrs: { 'aria-label': 'Claims' } }, group('Needs a decision', groups.needs, ui, a, true), group('Backed', groups.backed, ui, a, false)),
          renderDetail(selected, selected ? (ui.runs.get(selected.id) ?? null) : null, pullRequestBlocker({ isGhReady: ui.ghOk, origin: b?.repo.origin ?? null }), a),
        ),
    drawer(ui, a),
  ];
};
