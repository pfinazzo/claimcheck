/**
 * The board: a glass top bar, three figures, the claims in two groups with a confidence meter
 * each, and the selected claim's detail beside them. A second tab shows every claim as a 3D map.
 *
 * @author Patrick Finazzo
 */

import type { PublicRun } from '../lib/fixer.ts';
import { findBranchPullRequestBlocker, findPullRequestBlocker } from '../shared/pull-request.ts';
import { THEME_CHOICES, THEME_HINTS, THEME_LABELS, type ThemeChoice } from '../shared/theme.ts';
import type { Board, Claim } from '../shared/types.ts';
import { renderDetail, type DetailActions } from './detail.ts';
import { makeElement, type Child } from './dom.ts';
import { calculateSummaryStats, collectClaimGroups, formatFactsLine, formatPlural, formatSpecWord, formatSummaryLine } from './format.ts';
import { renderGithubView, type GithubActions, type GithubUi } from './github-view.ts';
import { renderGraphView } from './graph-view.ts';

export type BoardMode = 'list' | 'graph' | 'pulls' | 'issues';

export type BoardUi = GithubUi & {
  board: Board | null;
  /** The board shows the claims as a list with a detail pane, or as the confidence map with a table of all of them. */
  mode: BoardMode;
  selectedId: string | null;
  runs: Map<string, PublicRun>;
  /** The look the person picked: light, dark, or follow the computer. */
  theme: ThemeChoice;
  /** The pull request opened from the whole branch from the all-clear banner, once there is one. */
  branchPr: { branch: string; url: string } | null;
  running: boolean;
  drawer: { open: boolean; status: string; lines: readonly string[] };
};

export type BoardActions = DetailActions & GithubActions & {
  select: (options: { id: string | null }) => void;
  setMode: (options: { mode: BoardMode }) => void;
  setTheme: (options: { choice: ThemeChoice }) => void;
  /** Opens a pull request from the branch the repo is on, once nothing needs a decision. */
  openBranchPr: () => void;
  /** Opens one claim in the list view. */
  showClaim: (options: { id: string }) => void;
  openRepo: () => void;
  connectClaude: () => void;
  runClaimcheck: () => void;
  writeSpec: () => void;
  closeDrawer: () => void;
};

const BOARD_MODES: readonly BoardMode[] = ['list', 'graph', 'pulls', 'issues'];

const MODE_LABELS = new Map<BoardMode, string>([
  ['list', 'Claims'],
  ['graph', 'Confidence map'],
  ['pulls', 'Pull requests'],
  ['issues', 'Issues'],
]);

/** A tab's words, with how many are open once the list has loaded. */
const toModeLabel = ({ mode, ui }: { mode: BoardMode; ui: BoardUi }): string => {
  const words = MODE_LABELS.get(mode) ?? mode;
  const counts = new Map<BoardMode, number | null>([
    ['pulls', ui.pulls.state === 'ready' ? ui.pulls.items.length : null],
    ['issues', ui.issues.state === 'ready' ? ui.issues.items.length : null],
  ]);
  const count = counts.get(mode) ?? null;
  return count === null ? words : `${words} (${count})`;
};

/** The badge for a claim that is already handled; claims still open have none. */
const DONE_LABEL = new Map<unknown, string>([
  ['resolved', 'Resolved'],
  ['accepted', 'Accepted'],
  ['fixing', 'Fix in progress'],
]);

/** A catch rate below this reads as weak on the planted-bug meter. */
const WEAK_RATIO = 0.8;

const renderButton = ({ label, onClick, cls = '', disabled = false }: { label: string; onClick: () => void; cls?: string; disabled?: boolean }): HTMLButtonElement =>
  makeElement({ tag: 'button', props: { class: `btn ${cls}`.trim(), attrs: { type: 'button', disabled }, on: { click: onClick } }, children: [label] });

/** Light, Dark and Auto side by side, always visible in the top bar, one click each. */
const renderThemeSwitch = ({ ui, actions }: { ui: BoardUi; actions: BoardActions }): HTMLElement =>
  makeElement({
    tag: 'div',
    props: { class: 'tabs theme-switch', attrs: { role: 'group', 'aria-label': 'Colour theme' } },
    children: THEME_CHOICES.map((choice) =>
      makeElement({
        tag: 'button',
        props: { class: `tab${ui.theme === choice ? ' active' : ''}`, attrs: { type: 'button', 'aria-pressed': ui.theme === choice, title: THEME_HINTS.get(choice) ?? null }, on: { click: () => actions.setTheme({ choice }) } },
        children: [THEME_LABELS.get(choice) ?? choice],
      }),
    ),
  });

const renderHeader = ({ ui, actions }: { ui: BoardUi; actions: BoardActions }): HTMLElement => {
  const board = ui.board;
  const meta = board
    ? makeElement({
        tag: 'span',
        props: { class: 'repo-meta' },
        children: [
          board.repo.branch ? makeElement({ tag: 'span', props: { class: 'branch' }, children: [board.repo.branch] }) : null,
          makeElement({
            tag: 'span',
            props: {},
            children: [makeElement({ tag: 'span', props: { class: `dot ${board.repo.specState}`, attrs: { 'aria-hidden': 'true' } } }), formatSpecWord({ state: board.repo.specState })],
          }),
        ],
      })
    : null;
  return makeElement({
    tag: 'header',
    props: { class: 'topbar panel' },
    children: [
      makeElement({
        tag: 'div',
        props: { class: 'brand' },
        children: [
          makeElement({ tag: 'span', props: { class: 'mark', attrs: { 'aria-hidden': 'true' } } }),
          makeElement({ tag: 'div', props: { class: 'repo' }, children: [makeElement({ tag: 'strong', props: {}, children: [board ? board.repo.name : 'claimcheck Desk'] }), meta] }),
        ],
      }),
      makeElement({
        tag: 'div',
        props: { class: 'row' },
        children: [
          board ? renderButton({ label: 'Write a spec', onClick: actions.writeSpec }) : null,
          renderButton({ label: 'Connect Claude', onClick: actions.connectClaude }),
          renderButton({ label: 'Connect GitHub', onClick: actions.connectGithub }),
          board ? renderButton({ label: ui.running ? 'Running…' : 'Run claimcheck', onClick: actions.runClaimcheck, cls: 'primary', disabled: ui.running }) : null,
          renderButton({ label: 'Open repo', onClick: actions.openRepo }),
          renderThemeSwitch({ ui, actions }),
        ],
      }),
    ],
  });
};

const SPARK_COUNT = 10;

/** The board has claims and none of them needs a decision. */
export const isBoardClear = ({ board }: { board: Board }): boolean => board.claims.length > 0 && board.queue.length === 0;

/** Claims that left the queue without becoming backed: a risk the person accepted, or a fix not checked again yet. */
export const countHeldClaims = ({ board }: { board: Board }): number => board.claims.filter((claim) => claim.flags.length > 0).length;

/** The line under the banner's heading: how many claims, and how many planted bugs the tests caught. */
const describeAllClear = ({ board }: { board: Board }): string => {
  const stats = calculateSummaryStats({ board });
  const heldCount = countHeldClaims({ board });
  const claims = `${formatPlural({ count: stats.claims - heldCount, one: 'claim' })} backed`;
  const held = heldCount === 0 ? '' : `, ${heldCount} settled by hand but still flagged`;
  return stats.total === 0 ? `${claims}${held}.` : `${claims}${held}. The tests caught ${stats.caught} of ${stats.total} planted bugs.`;
};

/**
 * What the pull request button says and does: it opens one, or shows the reason it cannot and
 * puts Connect GitHub one press away. Once a pull request exists it links to it instead.
 */
const renderBranchPrOffer = ({ board, ui, actions }: { board: Board; ui: BoardUi; actions: BoardActions }): HTMLElement => {
  const opened = ui.branchPr !== null && ui.branchPr.branch === board.repo.branch ? ui.branchPr : null;
  if (opened) return makeElement({ tag: 'div', props: { class: 'pr-offer' }, children: [makeElement({ tag: 'p', props: { class: 'muted', attrs: { role: 'status' } }, children: ['Pull request opened.'] }), renderButton({ label: 'View pull request', onClick: () => actions.openPath(opened.url), cls: 'primary' })] });
  const blocker = findBranchPullRequestBlocker({ isGhReady: ui.ghOk, origin: board.repo.origin, branch: board.repo.branch, base: board.config.base, isBranchPushed: board.repo.isBranchPushed });
  return makeElement({
    tag: 'div',
    props: { class: 'pr-offer' },
    children: [
      makeElement({ tag: 'div', props: { class: 'row' }, children: [renderButton({ label: 'Open pull request', onClick: actions.openBranchPr, cls: 'primary', disabled: blocker !== null }), blocker && !ui.ghOk ? renderButton({ label: 'Connect GitHub', onClick: actions.connectGithub }) : null] }),
      blocker ? makeElement({ tag: 'p', props: { class: 'muted pr-blocker', attrs: { role: 'status' } }, children: [blocker] }) : null,
    ],
  });
};

/**
 * Shown when every claim is backed: a short celebration, an honest line about what that means,
 * and the way forward. The sparks are decoration and only move when the banner is first reached.
 */
const renderAllClear = ({ board, ui, actions }: { board: Board; ui: BoardUi; actions: BoardActions }): HTMLElement =>
  makeElement({
    tag: 'section',
    props: { class: 'all-clear panel', attrs: { 'aria-label': 'All claims backed' } },
    children: [
      makeElement({ tag: 'div', props: { class: 'all-clear-mark', attrs: { 'aria-hidden': 'true' } }, children: [...Array.from({ length: SPARK_COUNT }, () => makeElement({ tag: 'span', props: { class: 'spark' } })), makeElement({ tag: 'span', props: { class: 'check' }, children: ['✓'] })] }),
      makeElement({
        tag: 'div',
        props: { class: 'all-clear-text' },
        children: [
          makeElement({ tag: 'h2', props: {}, children: [countHeldClaims({ board }) === 0 ? 'Nice work. Every claim is backed.' : 'Nice work. Nothing is left to decide.'] }),
          makeElement({ tag: 'p', props: {}, children: [`Nothing on ${board.repo.branch ?? 'this branch'} needs a decision now. ${describeAllClear({ board })}`] }),
          makeElement({ tag: 'p', props: { class: 'muted' }, children: ['That is a good sign, not a sign-off. Open a pull request so a person reads it before it merges.'] }),
        ],
      }),
      renderBranchPrOffer({ board, ui, actions }),
    ],
  });

/** A bar filled to `ratio` (0 to 1). The width is set through the CSSOM, since the CSP forbids inline style attributes. */
const renderMeterBar = ({ ratio, isWeak }: { ratio: number; isWeak: boolean }): HTMLElement => {
  const fill = makeElement({ tag: 'span', props: {} });
  fill.style.width = `${Math.round(ratio * 100)}%`;
  return makeElement({ tag: 'span', props: { class: `meter${isWeak ? ' weak' : ''}` }, children: [fill] });
};

const renderStat = ({ cls, label, value, note, meter = null }: { cls: string; label: string; value: Child; note: Child; meter?: HTMLElement | null }): HTMLElement =>
  makeElement({
    tag: 'div',
    props: { class: `stat panel ${cls}`.trim() },
    children: [makeElement({ tag: 'span', props: { class: 'stat-label' }, children: [label] }), makeElement({ tag: 'span', props: { class: 'stat-value' }, children: [value, note] }), meter],
  });

const renderSmall = ({ text }: { text: string }): HTMLElement => makeElement({ tag: 'small', props: {}, children: [text] });

/** Three figures: claims, how many need a decision, and planted bugs caught. */
const renderStats = ({ board }: { board: Board }): HTMLElement => {
  const stats = calculateSummaryStats({ board });
  const rate = stats.total === 0 ? null : stats.caught / stats.total;
  return makeElement({
    tag: 'section',
    props: { class: 'stats', attrs: { 'aria-label': formatSummaryLine({ board }) } },
    children: [
      renderStat({ cls: '', label: 'Claims', value: stats.claims, note: null }),
      renderStat({ cls: stats.needs === 0 ? 'clear' : 'needs', label: 'Need a decision', value: stats.needs, note: stats.needs === 0 ? renderSmall({ text: 'none' }) : null }),
      renderStat({
        cls: '',
        label: 'Planted bugs caught',
        value: stats.total === 0 ? '–' : stats.caught,
        note: renderSmall({ text: stats.total === 0 ? 'no run yet' : `of ${stats.total}` }),
        meter: rate === null ? null : renderMeterBar({ ratio: rate, isWeak: rate < WEAK_RATIO }),
      }),
    ],
  });
};

const renderConfidenceMeter = ({ claim, isWeak }: { claim: Claim; isWeak: boolean }): HTMLElement | null =>
  claim.confidence === null
    ? null
    : makeElement({
        tag: 'span',
        props: { class: 'claim-meter', attrs: { 'aria-hidden': 'true' } },
        children: [renderMeterBar({ ratio: claim.confidence, isWeak }), makeElement({ tag: 'span', props: { class: 'num' }, children: [claim.confidence.toFixed(2)] })],
      });

const renderRow = ({ claim, ui, boardActions, isWeak }: { claim: Claim; ui: BoardUi; boardActions: BoardActions; isWeak: boolean }): HTMLElement => {
  const done = DONE_LABEL.get(claim.status) ?? '';
  return makeElement({
    tag: 'button',
    props: {
      class: `claim-row${claim.id === ui.selectedId ? ' selected' : ''}`,
      attrs: { type: 'button', 'aria-pressed': claim.id === ui.selectedId },
      dataset: { claim: claim.id },
      on: { click: () => boardActions.select({ id: claim.id }) },
    },
    children: [
      makeElement({ tag: 'span', props: { class: 'claim-title' }, children: [claim.claim] }),
      makeElement({ tag: 'span', props: { class: 'claim-facts' }, children: [formatFactsLine({ claim })] }),
      renderConfidenceMeter({ claim, isWeak }),
      done ? makeElement({ tag: 'span', props: { class: 'claim-status' }, children: [done] }) : null,
    ],
  });
};

const renderGroup = ({ title, claims, ui, boardActions, isWeak }: { title: string; claims: readonly Claim[]; ui: BoardUi; boardActions: BoardActions; isWeak: boolean }): HTMLElement | null =>
  claims.length
    ? makeElement({
        tag: 'section',
        props: { class: 'group' },
        children: [makeElement({ tag: 'h3', props: {}, children: [`${title} (${claims.length})`] }), ...claims.map((claim) => renderRow({ claim, ui, boardActions, isWeak }))],
      })
    : null;

const renderEmptyState = ({ ui, actions }: { ui: BoardUi; actions: BoardActions }): HTMLElement =>
  makeElement({
    tag: 'div',
    props: { class: 'empty-state' },
    children: [
      makeElement({ tag: 'h2', props: {}, children: [ui.board ? 'No claims yet' : 'Open a repository'] }),
      makeElement({
        tag: 'p',
        props: { class: 'muted' },
        children: [
          ui.board
            ? 'Your coding agent adds claims to .claimcheck/claims.yaml as it works. When it has, press Run claimcheck.'
            : 'Pick a project folder. If it is not set up for claimcheck yet, Desk walks you through it.',
        ],
      }),
      ui.board ? null : renderButton({ label: 'Open repo', onClick: actions.openRepo, cls: 'primary' }),
    ],
  });

const renderDrawer = ({ ui, actions }: { ui: BoardUi; actions: BoardActions }): HTMLElement | null =>
  ui.drawer.open
    ? makeElement({
        tag: 'section',
        props: { class: 'drawer panel' },
        children: [
          makeElement({
            tag: 'div',
            props: { class: 'drawer-head' },
            children: [makeElement({ tag: 'strong', props: {}, children: ['claimcheck run'] }), makeElement({ tag: 'span', props: { class: 'muted' }, children: [ui.drawer.status] }), renderButton({ label: 'Close', onClick: actions.closeDrawer })],
          }),
          makeElement({ tag: 'pre', props: { class: 'code' }, children: [ui.drawer.lines.join('\n')] }),
        ],
      })
    : null;

const renderModeTabs = ({ ui, actions }: { ui: BoardUi; actions: BoardActions }): HTMLElement =>
  makeElement({
    tag: 'div',
    props: { class: 'tabs mode-tabs', attrs: { role: 'tablist', 'aria-label': 'Board view' } },
    children: BOARD_MODES.map((mode) =>
      makeElement({
        tag: 'button',
        props: { class: `tab${ui.mode === mode ? ' active' : ''}`, attrs: { type: 'button', role: 'tab', 'aria-selected': ui.mode === mode }, on: { click: () => actions.setMode({ mode }) } },
        children: [toModeLabel({ mode, ui })],
      }),
    ),
  });

/** The claims list with the selected claim's detail beside it. */
const renderListView = ({ board, ui, actions }: { board: Board; ui: BoardUi; actions: BoardActions }): HTMLElement => {
  const groups = collectClaimGroups({ board });
  const selected = board.claims.find((claim) => claim.id === ui.selectedId) ?? null;
  return makeElement({
    tag: 'main',
    props: { class: 'split' },
    children: [
      makeElement({
        tag: 'nav',
        props: { class: 'claims panel', attrs: { 'aria-label': 'Claims' } },
        children: [
          renderGroup({ title: 'Needs a decision', claims: groups.needs, ui, boardActions: actions, isWeak: true }),
          renderGroup({ title: 'Backed', claims: groups.backed, ui, boardActions: actions, isWeak: false }),
        ],
      }),
      renderDetail({
        claim: selected,
        run: selected ? (ui.runs.get(selected.id) ?? null) : null,
        prBlocker: findPullRequestBlocker({ isGhReady: ui.ghOk, origin: board.repo.origin }),
        detailActions: actions,
      }),
    ],
  });
};

/** What fills the page under the stats: the empty state, the claims list, or the confidence map. */
const renderBody = ({ ui, actions }: { ui: BoardUi; actions: BoardActions }): HTMLElement => {
  const board = ui.board;
  if (board && (ui.mode === 'pulls' || ui.mode === 'issues')) return renderGithubView({ kind: ui.mode, ui, actions });
  if (!board || board.claims.length === 0) return renderEmptyState({ ui, actions });
  return ui.mode === 'graph' ? renderGraphView({ ui, actions }) : renderListView({ board, ui, actions });
};

/** Everything inside #app for the board view. */
export const renderBoard = ({ ui, actions }: { ui: BoardUi; actions: BoardActions }): Child[] => {
  const board = ui.board;
  const hasClaims = board !== null && board.claims.length > 0;
  const isClaimsTab = ui.mode === 'list' || ui.mode === 'graph';
  return [renderHeader({ ui, actions }), board && hasClaims && isClaimsTab ? renderStats({ board }) : null, board && isClaimsTab && isBoardClear({ board }) ? renderAllClear({ board, ui, actions }) : null, board ? renderModeTabs({ ui, actions }) : null, renderBody({ ui, actions }), renderDrawer({ ui, actions })];
};
