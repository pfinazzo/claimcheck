/**
 * The Pull requests and Issues tabs: the repo's open pull requests or issues on the left, and the
 * selected one in full on the right.
 *
 * Why everything is text: titles, branch names, labels and descriptions are written by other
 * people. They go into the page only as text nodes, never as markup, and a description is cut to a
 * readable length so one enormous pull request cannot freeze the window.
 *
 * @author Patrick Finazzo
 */

import type { CheckState, GithubLoad, IssueDetail, IssueSummary, MergeState, PullRequestDetail, PullRequestSummary, ReviewState } from '../shared/github.ts';
import { makeElement, type Child } from './dom.ts';
import { formatAge, formatPlural } from './format.ts';
import { renderMarkdown } from './markdown.ts';

export type GithubKind = 'pulls' | 'issues';

export type GithubFilter = 'all' | 'mine' | 'review';

/** One opened pull request or issue, once it has been asked for. */
export type GithubDetailLoad = { state: 'loading' } | { state: 'failed'; message: string } | { state: 'pull'; value: PullRequestDetail } | { state: 'issue'; value: IssueDetail };

/** What the two tabs need from the page. */
export type GithubUi = {
  pulls: GithubLoad<PullRequestSummary>;
  issues: GithubLoad<IssueSummary>;
  githubFilter: GithubFilter;
  selectedPull: number | null;
  selectedIssue: number | null;
  /** Keyed `pull:12` or `issue:7`. */
  details: Map<string, GithubDetailLoad>;
  ghOk: boolean;
};

export type GithubActions = {
  refreshGithub: () => void;
  selectPull: (options: { number: number }) => void;
  selectIssue: (options: { number: number }) => void;
  setGithubFilter: (options: { filter: GithubFilter }) => void;
  openPath: (target: string) => void;
  connectGithub: () => void;
};

type Tone = 'good' | 'bad' | 'warn' | 'quiet';

const BODY_LIMIT = 6000;

const renderPill = ({ text, tone }: { text: string; tone: Tone }): HTMLElement => makeElement({ tag: 'span', props: { class: `pill ${tone}` }, children: [text] });

const renderMuted = ({ text }: { text: string }): HTMLElement => makeElement({ tag: 'p', props: { class: 'muted' }, children: [text] });

const renderButton = ({ label, onClick, cls = '' }: { label: string; onClick: () => void; cls?: string }): HTMLButtonElement =>
  makeElement({ tag: 'button', props: { class: `btn ${cls}`.trim(), attrs: { type: 'button' }, on: { click: onClick } }, children: [label] });

const renderSection = ({ title, children }: { title: string; children: readonly Child[] }): HTMLElement => makeElement({ tag: 'section', props: { class: 'block' }, children: [makeElement({ tag: 'h3', props: {}, children: [title] }), ...children] });

// ---- words for the states -----------------------------------------------------------------------------------------------

const REVIEW_WORDS = new Map<ReviewState, { text: string; tone: Tone }>([
  ['approved', { text: 'Approved', tone: 'good' }],
  ['changes-requested', { text: 'Changes requested', tone: 'bad' }],
  ['review-required', { text: 'Review needed', tone: 'warn' }],
]);

const CHECK_TONES = new Map<CheckState, Tone>([
  ['passing', 'good'],
  ['failing', 'bad'],
  ['pending', 'warn'],
  ['none', 'quiet'],
]);

const CHECK_VALUES = new Map<CheckState, string>([
  ['passing', 'passing'],
  ['failing', 'failing'],
  ['pending', 'running'],
  ['none', 'none'],
]);

const MERGE_WORDS = new Map<MergeState, { value: string; note: string; tone: string }>([
  ['clean', { value: 'Can merge', note: 'no conflicts', tone: 'ok' }],
  ['conflicting', { value: 'Conflicts', note: 'needs an update from the base', tone: 'bad' }],
  ['unknown', { value: 'Unknown', note: 'GitHub is still working it out', tone: '' }],
]);

const TILE_TONES = new Map<Tone, string>([
  ['good', 'ok'],
  ['bad', 'bad'],
  ['warn', 'warn'],
  ['quiet', ''],
]);

const toCheckNote = ({ pull }: { pull: PullRequestSummary }): string => {
  const { checks } = pull;
  if (checks.state === 'none') return 'no checks ran';
  if (checks.state === 'failing') return checks.failingNames.slice(0, 3).join(', ');
  return `${checks.passing} passed${checks.pending > 0 ? `, ${checks.pending} running` : ''}`;
};

const toChecksPill = ({ pull }: { pull: PullRequestSummary }): HTMLElement | null => {
  const { checks } = pull;
  if (checks.state === 'none') return null;
  const text = checks.state === 'failing' ? `${checks.failing} failing` : `Checks ${CHECK_VALUES.get(checks.state) ?? ''}`;
  return renderPill({ text, tone: CHECK_TONES.get(checks.state) ?? 'quiet' });
};

const toReviewPill = ({ pull }: { pull: PullRequestSummary }): HTMLElement | null => {
  const words = REVIEW_WORDS.get(pull.review);
  return words ? renderPill(words) : null;
};

const toSizeWords = ({ additions, deletions, changedFiles }: { additions: number; deletions: number; changedFiles: number }): string => `+${additions} −${deletions} in ${formatPlural({ count: changedFiles, one: 'file' })}`;

// ---- the left side ------------------------------------------------------------------------------------------------------

const FILTER_LABELS = new Map<GithubFilter, string>([
  ['all', 'All'],
  ['mine', 'Mine'],
  ['review', 'To review'],
]);

const FILTERS_FOR = new Map<GithubKind, readonly GithubFilter[]>([
  ['pulls', ['all', 'mine', 'review']],
  ['issues', ['all', 'mine']],
]);

const keepPull = ({ pull, filter }: { pull: PullRequestSummary; filter: GithubFilter }): boolean => {
  const tests = new Map<GithubFilter, boolean>([
    ['all', true],
    ['mine', pull.isMine],
    ['review', pull.isReviewRequested],
  ]);
  return tests.get(filter) ?? true;
};

const keepIssue = ({ issue, filter }: { issue: IssueSummary; filter: GithubFilter }): boolean => filter !== 'mine' || issue.isMine;

/** A filter that does not exist for this tab (Needs my review on Issues) reads as All. */
const toFilterFor = ({ kind, filter }: { kind: GithubKind; filter: GithubFilter }): GithubFilter => ((FILTERS_FOR.get(kind) ?? []).includes(filter) ? filter : 'all');

const renderToolbar = ({ kind, ui, actions, shownCount }: { kind: GithubKind; ui: GithubUi; actions: GithubActions; shownCount: number }): HTMLElement => {
  const filter = toFilterFor({ kind, filter: ui.githubFilter });
  return makeElement({
    tag: 'div',
    props: { class: 'gh-toolbar' },
    children: [
      makeElement({
        tag: 'div',
        props: { class: 'tabs', attrs: { role: 'group', 'aria-label': 'Filter' } },
        children: (FILTERS_FOR.get(kind) ?? []).map((candidate) =>
          makeElement({ tag: 'button', props: { class: `tab${candidate === filter ? ' active' : ''}`, attrs: { type: 'button', 'aria-pressed': candidate === filter }, on: { click: () => actions.setGithubFilter({ filter: candidate }) } }, children: [FILTER_LABELS.get(candidate) ?? candidate] }),
        ),
      }),
      makeElement({ tag: 'span', props: { class: 'muted gh-count' }, children: [String(shownCount)] }),
      renderButton({ label: 'Refresh', onClick: actions.refreshGithub, cls: 'ghost' }),
    ],
  });
};

const renderPullRow = ({ pull, ui, actions, nowMs }: { pull: PullRequestSummary; ui: GithubUi; actions: GithubActions; nowMs: number }): HTMLElement =>
  makeElement({
    tag: 'button',
    props: { class: `claim-row${pull.number === ui.selectedPull ? ' selected' : ''}`, attrs: { type: 'button', 'aria-pressed': pull.number === ui.selectedPull }, dataset: { pull: pull.number }, on: { click: () => actions.selectPull({ number: pull.number }) } },
    children: [
      makeElement({ tag: 'span', props: { class: 'claim-title' }, children: [`#${pull.number} ${pull.title}`] }),
      makeElement({ tag: 'span', props: { class: 'claim-facts' }, children: [`${pull.author} · ${pull.headBranch} → ${pull.baseBranch} · ${formatAge({ iso: pull.updatedAtIso, nowMs })}`] }),
      makeElement({
        tag: 'span',
        props: { class: 'gh-pills' },
        children: [
          pull.isDraft ? renderPill({ text: 'Draft', tone: 'quiet' }) : null,
          pull.isReviewRequested ? renderPill({ text: 'Review requested', tone: 'warn' }) : null,
          pull.isMine ? renderPill({ text: 'Yours', tone: 'quiet' }) : null,
          toChecksPill({ pull }),
          toReviewPill({ pull }),
          pull.merge === 'conflicting' ? renderPill({ text: 'Conflicts', tone: 'bad' }) : null,
        ],
      }),
    ],
  });

const renderIssueRow = ({ issue, ui, actions, nowMs }: { issue: IssueSummary; ui: GithubUi; actions: GithubActions; nowMs: number }): HTMLElement =>
  makeElement({
    tag: 'button',
    props: { class: `claim-row${issue.number === ui.selectedIssue ? ' selected' : ''}`, attrs: { type: 'button', 'aria-pressed': issue.number === ui.selectedIssue }, dataset: { issue: issue.number }, on: { click: () => actions.selectIssue({ number: issue.number }) } },
    children: [
      makeElement({ tag: 'span', props: { class: 'claim-title' }, children: [`#${issue.number} ${issue.title}`] }),
      makeElement({ tag: 'span', props: { class: 'claim-facts' }, children: [`${issue.author} · ${formatAge({ iso: issue.updatedAtIso, nowMs })} · ${formatPlural({ count: issue.commentCount, one: 'comment' })}`] }),
      makeElement({ tag: 'span', props: { class: 'gh-pills' }, children: [issue.isMine ? renderPill({ text: 'Yours', tone: 'quiet' }) : null, ...issue.labels.slice(0, 3).map((label) => renderPill({ text: label, tone: 'quiet' }))] }),
    ],
  });

const renderFailure = ({ message, ui, actions }: { message: string; ui: GithubUi; actions: GithubActions }): HTMLElement =>
  makeElement({
    tag: 'div',
    props: { class: 'gh-state' },
    children: [makeElement({ tag: 'p', props: { class: 'error', attrs: { role: 'alert' } }, children: [message] }), makeElement({ tag: 'div', props: { class: 'row' }, children: [renderButton({ label: 'Try again', onClick: actions.refreshGithub }), ui.ghOk ? null : renderButton({ label: 'Connect GitHub', onClick: actions.connectGithub })] })],
  });

const EMPTY_WORDS = new Map<GithubKind, Map<GithubFilter, string>>([
  [
    'pulls',
    new Map<GithubFilter, string>([
      ['all', 'No open pull requests.'],
      ['mine', 'You have no open pull requests here.'],
      ['review', 'Nothing is waiting on your review.'],
    ]),
  ],
  [
    'issues',
    new Map<GithubFilter, string>([
      ['all', 'No open issues.'],
      ['mine', 'No open issues are yours or assigned to you.'],
    ]),
  ],
]);

const renderPullList = ({ ui, actions, nowMs }: { ui: GithubUi; actions: GithubActions; nowMs: number }): HTMLElement => {
  const filter = toFilterFor({ kind: 'pulls', filter: ui.githubFilter });
  const load = ui.pulls;
  const pulls = load.state === 'ready' ? load.items.filter((pull) => keepPull({ pull, filter })) : [];
  const states = new Map<GithubLoad<PullRequestSummary>['state'], () => Child>([
    ['idle', () => renderMuted({ text: 'Loading pull requests…' })],
    ['loading', () => renderMuted({ text: 'Loading pull requests…' })],
    ['failed', () => renderFailure({ message: load.state === 'failed' ? load.message : '', ui, actions })],
    ['ready', () => (pulls.length === 0 ? renderMuted({ text: EMPTY_WORDS.get('pulls')?.get(filter) ?? '' }) : makeElement({ tag: 'div', props: { class: 'gh-rows' }, children: pulls.map((pull) => renderPullRow({ pull, ui, actions, nowMs })) }))],
  ]);
  return makeElement({ tag: 'nav', props: { class: 'claims panel', attrs: { 'aria-label': 'Pull requests' } }, children: [renderToolbar({ kind: 'pulls', ui, actions, shownCount: pulls.length }), states.get(load.state)?.() ?? null] });
};

const renderIssueList = ({ ui, actions, nowMs }: { ui: GithubUi; actions: GithubActions; nowMs: number }): HTMLElement => {
  const filter = toFilterFor({ kind: 'issues', filter: ui.githubFilter });
  const load = ui.issues;
  const issues = load.state === 'ready' ? load.items.filter((issue) => keepIssue({ issue, filter })) : [];
  const states = new Map<GithubLoad<IssueSummary>['state'], () => Child>([
    ['idle', () => renderMuted({ text: 'Loading issues…' })],
    ['loading', () => renderMuted({ text: 'Loading issues…' })],
    ['failed', () => renderFailure({ message: load.state === 'failed' ? load.message : '', ui, actions })],
    ['ready', () => (issues.length === 0 ? renderMuted({ text: EMPTY_WORDS.get('issues')?.get(filter) ?? '' }) : makeElement({ tag: 'div', props: { class: 'gh-rows' }, children: issues.map((issue) => renderIssueRow({ issue, ui, actions, nowMs })) }))],
  ]);
  return makeElement({ tag: 'nav', props: { class: 'claims panel', attrs: { 'aria-label': 'Issues' } }, children: [renderToolbar({ kind: 'issues', ui, actions, shownCount: issues.length }), states.get(load.state)?.() ?? null] });
};

// ---- the right side -----------------------------------------------------------------------------------------------------

const renderTile = ({ tone, label, value, note }: { tone: string; label: string; value: string; note: string }): HTMLElement =>
  makeElement({
    tag: 'div',
    props: { class: `tile ${tone}`.trim() },
    children: [makeElement({ tag: 'span', props: { class: 'tile-label' }, children: [label] }), makeElement({ tag: 'span', props: { class: 'tile-value' }, children: [value] }), makeElement({ tag: 'span', props: { class: 'tile-note' }, children: [note] })],
  });

/** A description, cut to a readable length. The cut says so, so nobody reads half a description as the whole. */
const toBodyText = ({ body }: { body: string }): string => (body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT).trimEnd()}\n\n… the rest is on GitHub.` : body.trim());

/** The description as GitHub would show it: formatted, with links that open in the browser. */
const renderBody = ({ body, actions }: { body: string; actions: GithubActions }): HTMLElement => (body.trim() ? makeElement({ tag: 'div', props: { class: 'gh-body' }, children: [renderMarkdown({ text: toBodyText({ body }), onOpenLink: actions.openPath })] }) : renderMuted({ text: 'No description.' }));

const renderLinks = ({ pull, actions }: { pull: PullRequestDetail; actions: GithubActions }): HTMLElement =>
  pull.linkedIssues.length
    ? makeElement({ tag: 'ul', props: { class: 'plain' }, children: pull.linkedIssues.map((issue) => makeElement({ tag: 'li', props: {}, children: [renderButton({ label: `#${issue.number} ${issue.title}`, onClick: () => actions.openPath(issue.url), cls: 'ghost' })] })) })
    : renderMuted({ text: 'None. Link one by writing "Fixes #12" in the description.' });

const renderFiles = ({ pull }: { pull: PullRequestDetail }): HTMLElement =>
  makeElement({
    tag: 'ul',
    props: { class: 'gh-files' },
    children: pull.files.map((file) => makeElement({ tag: 'li', props: {}, children: [makeElement({ tag: 'span', props: { class: 'mono' }, children: [file.path] }), makeElement({ tag: 'span', props: { class: 'muted' }, children: [`+${file.additions} −${file.deletions}`] })] })),
  });

const renderPullDetail = ({ pull, actions, nowMs }: { pull: PullRequestDetail; actions: GithubActions; nowMs: number }): HTMLElement => {
  const merge = MERGE_WORDS.get(pull.merge) ?? { value: '', note: '', tone: '' };
  const review = REVIEW_WORDS.get(pull.review);
  return makeElement({
    tag: 'div',
    props: { class: 'detail panel' },
    children: [
      makeElement({
        tag: 'header',
        props: { class: 'detail-head' },
        children: [
          makeElement({ tag: 'p', props: { class: 'id mono' }, children: [`#${pull.number}`, pull.isDraft ? renderPill({ text: 'Draft', tone: 'quiet' }) : null] }),
          makeElement({ tag: 'h2', props: {}, children: [pull.title] }),
          renderMuted({ text: `${pull.author} wants to merge ${pull.headBranch} into ${pull.baseBranch}. ${toSizeWords(pull)}, ${formatPlural({ count: pull.commitCount, one: 'commit' })}. Updated ${formatAge({ iso: pull.updatedAtIso, nowMs })}.` }),
          makeElement({ tag: 'div', props: { class: 'row' }, children: [renderButton({ label: 'View on GitHub', onClick: () => actions.openPath(pull.url) })] }),
          makeElement({
            tag: 'div',
            props: { class: 'tiles' },
            children: [
              renderTile({ tone: TILE_TONES.get(CHECK_TONES.get(pull.checks.state) ?? 'quiet') ?? '', label: 'Checks', value: CHECK_VALUES.get(pull.checks.state) ?? '', note: toCheckNote({ pull }) }),
              renderTile({ tone: TILE_TONES.get(review?.tone ?? 'quiet') ?? '', label: 'Review', value: review?.text ?? 'None yet', note: pull.reviews.map((line) => `${line.author} ${line.state}`).join(', ') || 'no reviews' }),
              renderTile({ tone: merge.tone, label: 'Merge', value: merge.value, note: merge.note }),
            ],
          }),
        ],
      }),
      pull.carriesClaims ? renderSection({ title: 'Claimcheck', children: [renderMuted({ text: 'This branch carries its own claims file (.claimcheck/claims.yaml), so claimcheck can grade the claims its author wrote.' })] }) : null,
      renderSection({ title: 'Linked issues', children: [renderLinks({ pull, actions })] }),
      pull.labels.length ? renderSection({ title: 'Labels', children: [makeElement({ tag: 'p', props: { class: 'gh-pills' }, children: pull.labels.map((label) => renderPill({ text: label, tone: 'quiet' })) })] }) : null,
      renderSection({ title: `Files changed (${pull.files.length})`, children: [renderFiles({ pull })] }),
      renderSection({ title: 'Description', children: [renderBody({ body: pull.body, actions })] }),
    ],
  });
};

const renderIssueDetail = ({ issue, actions, nowMs }: { issue: IssueDetail; actions: GithubActions; nowMs: number }): HTMLElement =>
  makeElement({
    tag: 'div',
    props: { class: 'detail panel' },
    children: [
      makeElement({
        tag: 'header',
        props: { class: 'detail-head' },
        children: [
          makeElement({ tag: 'p', props: { class: 'id mono' }, children: [`#${issue.number}`, renderPill({ text: issue.isOpen ? 'Open' : 'Closed', tone: issue.isOpen ? 'good' : 'quiet' })] }),
          makeElement({ tag: 'h2', props: {}, children: [issue.title] }),
          renderMuted({ text: `${issue.author} opened this ${formatAge({ iso: issue.createdAtIso, nowMs })}. ${formatPlural({ count: issue.commentCount, one: 'comment' })}. ${issue.assignees.length ? `Assigned to ${issue.assignees.join(', ')}.` : 'Nobody is assigned.'}` }),
          makeElement({ tag: 'div', props: { class: 'row' }, children: [renderButton({ label: 'View on GitHub', onClick: () => actions.openPath(issue.url) })] }),
        ],
      }),
      issue.labels.length ? renderSection({ title: 'Labels', children: [makeElement({ tag: 'p', props: { class: 'gh-pills' }, children: issue.labels.map((label) => renderPill({ text: label, tone: 'quiet' })) })] }) : null,
      renderSection({ title: 'Description', children: [renderBody({ body: issue.body, actions })] }),
    ],
  });

const renderDetailMessage = ({ children }: { children: readonly Child[] }): HTMLElement => makeElement({ tag: 'div', props: { class: 'detail panel empty' }, children });

const renderDetailFor = ({ key, emptyText, ui, actions, nowMs }: { key: string | null; emptyText: string; ui: GithubUi; actions: GithubActions; nowMs: number }): HTMLElement => {
  const load = key === null ? undefined : ui.details.get(key);
  if (!load) return renderDetailMessage({ children: [renderMuted({ text: emptyText })] });
  const views = new Map<GithubDetailLoad['state'], () => HTMLElement>([
    ['loading', () => renderDetailMessage({ children: [renderMuted({ text: 'Loading…' })] })],
    ['failed', () => renderDetailMessage({ children: [makeElement({ tag: 'p', props: { class: 'error', attrs: { role: 'alert' } }, children: [load.state === 'failed' ? load.message : ''] })] })],
    ['pull', () => (load.state === 'pull' ? renderPullDetail({ pull: load.value, actions, nowMs }) : renderDetailMessage({ children: [] }))],
    ['issue', () => (load.state === 'issue' ? renderIssueDetail({ issue: load.value, actions, nowMs }) : renderDetailMessage({ children: [] }))],
  ]);
  return (views.get(load.state) ?? (() => renderDetailMessage({ children: [] })))();
};

/** The key the page files an opened pull request or issue under. */
export const toDetailKey = ({ kind, number }: { kind: 'pull' | 'issue'; number: number }): string => `${kind}:${number}`;

/** The list and the opened item for one of the two tabs. */
export const renderGithubView = ({ kind, ui, actions, nowMs = Date.now() }: { kind: GithubKind; ui: GithubUi; actions: GithubActions; nowMs?: number }): HTMLElement => {
  const isPulls = kind === 'pulls';
  const selected = isPulls ? ui.selectedPull : ui.selectedIssue;
  return makeElement({
    tag: 'main',
    props: { class: 'split gh-view' },
    children: [
      isPulls ? renderPullList({ ui, actions, nowMs }) : renderIssueList({ ui, actions, nowMs }),
      renderDetailFor({ key: selected === null ? null : toDetailKey({ kind: isPulls ? 'pull' : 'issue', number: selected }), emptyText: isPulls ? 'Pick a pull request to see its checks, files and description.' : 'Pick an issue to read it.', ui, actions, nowMs }),
    ],
  });
};
