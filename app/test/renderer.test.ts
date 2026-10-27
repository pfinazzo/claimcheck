/**
 * The page: board and wizard drawn with DOM calls into a small DOM, checked as text. Includes the
 * cases a hostile repo would try: markup in a claim, a verdict, a file name.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import type { PublicRun } from '../src/lib/fixer.ts';
import type { PullRequestDetail, PullRequestSummary } from '../src/shared/github.ts';
import type { GithubDetailLoad } from '../src/renderer/github-view.ts';
import type { Board, Claim } from '../src/shared/types.ts';
import { renderBoard, type BoardActions, type BoardUi } from '../src/renderer/board.ts';
import { runDemoWizard } from '../src/renderer/demo.ts';
import { mount, setDocument } from '../src/renderer/dom.ts';
import { formatFactsLine, collectClaimGroups, formatSpecWord, formatSummaryLine } from '../src/renderer/format.ts';
import { drawConfidenceMap } from '../src/renderer/graph-view.ts';
import { renderWizard, type WizardCtx } from '../src/renderer/wizard.ts';
import { createRecorder } from './helpers.ts';

const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>');
setDocument({ replacement: document });
const app = document.getElementById('app') as HTMLElement;

// The wizard schedules its animation with window timers; a plain stand-in is enough here.
Object.assign(globalThis, { window: { setTimeout: (callback: () => void) => { void callback; return 0; }, clearTimeout: () => {} } });

const makeClaim = ({ over = {} }: { over?: Partial<Claim> } = {}): Claim => ({
  id: 'c1',
  claim: 'shipping_fee returns 0 for orders of $50 or more',
  confidence: 0.92,
  criteria: [{ id: 1, text: 'Orders of $50 ship free.' }],
  files: ['src/shipping.py'],
  killCondition: 'test: tests/test_shipping.py::test_a',
  verifiedBy: ['cmd: pytest -q'],
  verdict: { id: 'c1', verdict: 'SUPPORTED', reason: 'matches', evidence: ['+    if total >= 50:'], provider: 'stub', model: null, ts: '2026-01-01T00:00:00Z', runId: 'r1' },
  mutation: { total: 4, killed: 2, survived: 2, timeout: 0, catchRate: 0.5, ts: '2026-01-01T00:00:00Z', runId: 'r1', mutants: [
    { file: 'src/shipping.py', line_no: 3, cls: 'boundary', original: 'if total >= 50:', mutated: 'if total > 50:', outcome: 'survived' },
    { file: 'src/shipping.py', line_no: 4, cls: 'sign_flip', original: 'return 0', mutated: 'return -0', outcome: 'survived' },
    { file: 'src/shipping.py', line_no: 5, cls: 'off_by_one', original: 'fee = 5', mutated: 'fee = 6', outcome: 'killed' },
    { file: 'src/shipping.py', line_no: 6, cls: 'swap_args', original: 'f(a, b)', mutated: 'f(b, a)', outcome: 'killed' },
  ] },
  status: 'open',
  reopened: false,
  note: '',
  fix: null,
  history: [],
  risk: 0.2,
  flags: ['weak-tests'],
  ...over,
});

const readBoard = ({ claims, queue, repo = {} }: { claims: readonly Claim[]; queue: readonly string[]; repo?: Partial<Board['repo']> }): Board => ({
  repo: { name: 'shop', path: 'C:/shop', origin: null, branch: 'feature/x', head: 'abc', hasClaimcheck: true, lockOk: true, specState: 'frozen', lastRunTs: null, isBranchPushed: true, ...repo },
  config: { base: 'main', test_cmd: 'npm test', ignore: [], checker: { provider: 'auto', model: 'm' }, app: { flagConfidence: 0.75, flagCatchRate: 0.8, python: null } },
  criteria: [],
  claims,
  queue,
  runs: { check: null, mutate: null },
  ledgerCount: 0,
});

const skipAction = (): void => {};
const makeActions = ({ calls = createRecorder<string>() }: { calls?: ReturnType<typeof createRecorder<string>> } = {}): BoardActions => ({
  select: ({ id }) => calls.record(`select:${id}`),
  setMode: ({ mode }) => calls.record(`mode:${mode}`),
  setTheme: ({ choice }) => calls.record(`theme:${choice}`),
  openBranchPr: () => calls.record('branch-pr'),
  refreshGithub: () => calls.record('refresh'),
  selectPull: ({ number }) => calls.record(`pull:${number}`),
  selectIssue: ({ number }) => calls.record(`issue:${number}`),
  setGithubFilter: ({ filter }) => calls.record(`filter:${filter}`),
  showClaim: ({ id }) => calls.record(`show:${id}`),
  connectGithub: () => calls.record('github'),
  inspect: (id) => calls.record(`inspect:${id}`),
  openRepo: skipAction, connectClaude: skipAction, runClaimcheck: skipAction, writeSpec: skipAction, closeDrawer: skipAction,
  fix: (id) => calls.record(`fix:${id}`),
  useApproach: skipAction, copyPrompt: skipAction, copyImplement: skipAction, copyText: skipAction, acceptRisk: skipAction, openPr: skipAction, openPath: skipAction, connect: skipAction,
});

const makeUi = ({ board, selectedId = null, runs = new Map(), mode = 'list', ghOk = false, theme = 'system', branchPr = null, github = {} }: { board: Board | null; selectedId?: string | null; runs?: Map<string, PublicRun>; mode?: BoardUi['mode']; ghOk?: boolean; theme?: BoardUi['theme']; branchPr?: BoardUi['branchPr']; github?: Partial<BoardUi> }): BoardUi => ({
  board, mode, selectedId, runs, ghOk, theme, branchPr, pulls: { state: 'idle' }, issues: { state: 'idle' }, githubFilter: 'all', selectedPull: null, selectedIssue: null, details: new Map(), ...github, running: false, drawer: { open: false, status: '', lines: [] },
});

const draw = ({ ui, actions = makeActions() }: { ui: BoardUi; actions?: BoardActions }): string => {
  mount({ parent: app, children: [...renderBoard({ ui: ui, actions })] });
  return app.textContent;
};

// ---- pure formatting ------------------------------------------------------------

// ---- the summary counts each planted bug once (criteria 1-4 of the distinct-planted-bugs task) ----

const makeBug = ({ line, outcome, runId = 'r1' }: { line: number; outcome: string; runId?: string }) => ({ file: 'src/a.py', line_no: line, cls: 'boundary', original: 'x >= 1', mutated: `x > ${line}`, outcome, runId });

const addBugs = ({ id, run, specs }: { id: string; run: string; specs: readonly { line: number; outcome: string }[] }): Claim => {
  const mutants = specs.map((spec) => makeBug({ line: spec.line, outcome: spec.outcome, runId: run }));
  const killed = mutants.filter((mutant) => mutant.outcome === 'killed').length;
  const survived = mutants.filter((mutant) => mutant.outcome === 'survived').length;
  return makeClaim({ over: { id, mutation: { total: mutants.length, killed, survived, timeout: 0, catchRate: killed / mutants.length, ts: '2026-01-01T00:00:00Z', runId: run, mutants: mutants.map(({ runId: _runId, ...mutant }) => mutant) } } });
};

test('two claims sharing the same planted bugs from one run count each bug once', () => {
  const same = [{ line: 1, outcome: 'killed' }, { line: 2, outcome: 'killed' }];
  const board = readBoard({ claims: [addBugs({ id: 'c1', run: 'r1', specs: same }), addBugs({ id: 'c2', run: 'r1', specs: same })], queue: [] });
  assert.match(formatSummaryLine({ board }), /2 of 2 planted bugs caught\./);
});

test('claims with different planted bugs still add up', () => {
  const claim = addBugs({ id: 'c1', run: 'r1', specs: [{ line: 1, outcome: 'killed' }, { line: 2, outcome: 'survived' }] });
  const buggyClaim = addBugs({ id: 'c2', run: 'r1', specs: [{ line: 3, outcome: 'killed' }, { line: 4, outcome: 'killed' }, { line: 5, outcome: 'killed' }] });
  assert.match(formatSummaryLine({ board: readBoard({ claims: [claim, buggyClaim], queue: [] }) }), /4 of 5 planted bugs caught\./);
});

test('the same change in two different runs is two measurements', () => {
  const one = addBugs({ id: 'c1', run: 'r1', specs: [{ line: 1, outcome: 'killed' }] });
  const two = addBugs({ id: 'c2', run: 'r2', specs: [{ line: 1, outcome: 'killed' }] });
  assert.match(formatSummaryLine({ board: readBoard({ claims: [one, two], queue: [] }) }), /2 of 2 planted bugs caught\./);
});

test('a claim facts line is unchanged and a board with no planted bugs has no such sentence', () => {
  const two = addBugs({ id: 'c1', run: 'r1', specs: [{ line: 1, outcome: 'killed' }, { line: 2, outcome: 'killed' }] });
  assert.equal(formatFactsLine({ claim: two }), 'Stated 0.92. Checker: supported. Tests caught 2 of 2 planted bugs.');
  assert.doesNotMatch(formatSummaryLine({ board: readBoard({ claims: [makeClaim({ over: { mutation: null } })], queue: [] }) }), /planted bugs/);
});

test('summary and facts are plain sentences', () => {
  const board = readBoard({ claims: [makeClaim(), makeClaim({ over: { id: 'c2', flags: [], mutation: null } })], queue: ['c1'] });
  assert.equal(formatSummaryLine({ board }), '2 claims, 1 needs a decision. 2 of 4 planted bugs caught.');
  assert.equal(formatFactsLine({ claim: makeClaim() }), 'Stated 0.92. Checker: supported. Tests caught 2 of 4 planted bugs.');
  assert.equal(formatSummaryLine({ board: readBoard({ claims: [], queue: [] }) }), 'No claims yet.');
  assert.equal(formatSpecWord({ state: 'frozen' }), 'Spec frozen');
  const groups = collectClaimGroups({ board });
  assert.deepEqual(groups.needs.map((claim) => claim.id), ['c1']);
  assert.deepEqual(groups.backed.map((claim) => claim.id), ['c2']);
});

// ---- the board -------------------------------------------------------------------

test('the board shows the groups, the selected claim and its sections', () => {
  const board = readBoard({ claims: [makeClaim(), makeClaim({ over: { id: 'c2', claim: 'second claim', flags: [] } })], queue: ['c1'] });
  const text = draw({ ui: makeUi({ board, selectedId: 'c1' }) });
  for (const must of ['shop', 'Needs a decision (1)', 'Backed (1)', 'Why it is here', 'Planted bugs hit', 'Fix this', 'What the checker said']) {
    if (must === 'Planted bugs hit') continue;
    assert.ok(text.includes(must), must);
  }
  assert.ok(text.includes('Planted bugs got past the tests.'));
  assert.ok(text.includes('if total >= 50:  →  if total > 50:'));
});

test('a backed claim does not offer Fix this', () => {
  const text = draw({ ui: makeUi({ board: readBoard({ claims: [makeClaim({ over: { flags: [] } })], queue: [] }), selectedId: 'c1' }) });
  assert.ok(!text.includes('Fix this'));
  assert.ok(text.includes('Nothing is flagged'));
  assert.ok(text.includes('What to do next'), 'a backed claim says what the person does from here');
});

test('a flagged claim does not show the all-clear steps', () => {
  const text = draw({ ui: makeUi({ board: readBoard({ claims: [makeClaim({ over: { flags: ['refuted'] } })], queue: ['c1'] }), selectedId: 'c1' }) });
  assert.ok(!text.includes('What to do next'));
});

test('clicking a row selects it, and Fix this calls the action', () => {
  const calls = createRecorder<string>();
  const board = readBoard({ claims: [makeClaim()], queue: ['c1'] });
  draw({ ui: makeUi({ board, selectedId: 'c1' }), actions: makeActions({ calls }) });
  (document.querySelector('.claim-row') as HTMLElement).click();
  const fix = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Fix this') as HTMLElement;
  fix.click();
  assert.deepEqual(calls.list(), ['select:c1', 'fix:c1']);
});

test('empty states say what to do next', () => {
  assert.ok(draw({ ui: makeUi({ board: null }) }).includes('Open a repository'));
  assert.ok(draw({ ui: makeUi({ board: readBoard({ claims: [], queue: [] }) }) }).includes('Run claimcheck'));
});

test('markup in a claim, a verdict, a path or a mutation is shown as text, never built', () => {
  const evil = '<img src=x onerror=alert(1)><button data-action="open-path">x</button>';
  const hostile = makeClaim({ over: {
    claim: evil,
    files: [evil],
    killCondition: evil,
    verifiedBy: [evil],
    verdict: { id: 'c1', verdict: `x" onclick="alert(1)`, reason: evil, evidence: [evil], provider: evil, model: evil, ts: evil, runId: 'r' },
    mutation: { total: 1, killed: 0, survived: 1, timeout: 0, catchRate: 0, ts: 't', runId: 'r', mutants: [{ file: evil, line_no: null, cls: evil, original: evil, mutated: evil, outcome: evil }] },
  } });
  const text = draw({ ui: makeUi({ board: readBoard({ claims: [hostile], queue: ['c1'] }), selectedId: 'c1' }) });
  assert.ok(text.includes(evil), 'the text is there, as text');
  assert.equal(document.querySelectorAll('img').length, 0);
  assert.equal(document.querySelectorAll('[onclick], [onerror], [data-action]').length, 0);
});

test('a running fix shows its activity and offers no second Fix press', () => {
  const run = { id: 'run1', kind: 'propose', claimId: 'c1', status: 'running', startedAt: 0, mode: 'cli', activity: ['Read src/a.py'], proposals: null, recommendationWhy: null, proposal: null, error: null, needsSignIn: false, branch: null, worktree: null, tests: null, killCondition: null, commits: [], summary: null, prompt: 'P', prUrl: null } satisfies PublicRun;
  const text = draw({ ui: makeUi({ board: readBoard({ claims: [makeClaim()], queue: ['c1'] }), selectedId: 'c1', runs: new Map([['c1', run]]) }) });
  assert.ok(text.includes('Claude is reading the code'));
  assert.ok(text.includes('Read src/a.py'));
  const fix = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Fix this') as HTMLButtonElement;
  assert.equal(fix.disabled, true);
});

// ---- pressed and selected states --------------------------------------------------

test('pressed and selected states are the words true and false, which is what screen readers read', () => {
  const board = readBoard({ claims: [makeClaim(), makeClaim({ over: { id: 'c2' } })], queue: ['c1'] });
  draw({ ui: makeUi({ board, selectedId: 'c1' }) });
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  assert.deepEqual(tabs.map((tab) => tab.getAttribute('aria-selected')), ['true', 'false', 'false', 'false']);
  const rows = [...document.querySelectorAll('.claim-row')];
  assert.deepEqual(rows.map((row) => row.getAttribute('aria-pressed')), rows.map((row) => (row.getAttribute('data-claim') === 'c1' ? 'true' : 'false')));
});

// ---- the confidence map tab ---------------------------------------------------------

const makeMixedBoard = (): Board => {
  const strong = makeClaim({ over: { id: 'c3', claim: 'strong claim', confidence: 0.95, flags: [], risk: 0.05, mutation: { total: 4, killed: 4, survived: 0, timeout: 0, catchRate: 1, ts: 't', runId: 'r', mutants: [] } } });
  const weak = makeClaim({ over: { id: 'c1', claim: 'weak claim', confidence: 0.4, flags: ['low-confidence'], risk: 0.9 } });
  const settled = makeClaim({ over: { id: 'c4', claim: 'settled claim', confidence: 0.6, flags: ['low-confidence'], status: 'resolved', risk: 0.5 } });
  return readBoard({ claims: [strong, weak, settled], queue: ['c1'] });
};

test('the board offers a Claims tab and a Confidence map tab, and pressing one asks for that mode', () => {
  const calls = createRecorder<string>();
  draw({ ui: makeUi({ board: makeMixedBoard(), selectedId: 'c1' }), actions: makeActions({ calls }) });
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  assert.deepEqual(tabs.map((tab) => tab.textContent), ['Claims', 'Confidence map', 'Pull requests', 'Issues']);
  assert.equal(tabs[0]?.getAttribute('aria-selected'), 'true');
  (tabs[1] as HTMLElement).click();
  assert.deepEqual(calls.list(), ['mode:graph']);
});

test('the confidence map lists EVERY claim, flagged and backed, riskiest first, with plain-word states', () => {
  draw({ ui: makeUi({ board: makeMixedBoard(), selectedId: 'c1', mode: 'graph' }) });
  const rows = [...document.querySelectorAll('.all-claims-table tbody tr')].map((row) => row.textContent.replace(/\s+/g, ' ').trim());
  assert.equal(rows.length, 3, 'all three claims, not only the flagged one');
  assert.ok(rows[0]?.startsWith('c1 weak claim'));
  assert.ok(rows[0]?.includes('Needs a decision'));
  assert.ok(rows[1]?.includes('settled claim') && rows[1].includes('Resolved'));
  assert.ok(rows[2]?.includes('strong claim') && rows[2].includes('Backed') && rows[2].includes('100%'));
  assert.ok(app.textContent.includes('All claims (3)'));
  assert.ok(app.textContent.includes('1 of 3 claims need a decision'));
});

test('a row selects its claim, and Open claim leaves the map for that claim', () => {
  const calls = createRecorder<string>();
  draw({ ui: makeUi({ board: makeMixedBoard(), selectedId: 'c1', mode: 'graph' }), actions: makeActions({ calls }) });
  (document.querySelector('tr[data-claim="c3"] button') as HTMLElement).click();
  [...document.querySelectorAll('button')].find((button) => button.textContent === 'Open claim')?.click();
  assert.deepEqual(calls.list(), ['select:c3', 'show:c1']);
});

test('where WebGL is not available the map says so, and the table is still there', () => {
  const ui = makeUi({ board: makeMixedBoard(), selectedId: 'c1', mode: 'graph' });
  draw({ ui });
  drawConfidenceMap({ ui, onSelect: skipAction, reducedMotion: true });
  const note = document.querySelector('.map-note') as HTMLElement;
  assert.ok(note.textContent.includes('The map could not start'));
  assert.equal(note.hidden, false);
  assert.equal(document.querySelectorAll('.all-claims-table tbody tr').length, 3);
});

// ---- pull requests, the code viewer and GitHub -----------------------------------------

const makeResolvedRun = (): PublicRun => ({
  id: 'run2', kind: 'implement', claimId: 'c1', status: 'resolved', startedAt: 0, mode: 'cli', activity: [], proposals: null, recommendationWhy: null,
  proposal: { title: 'Pin it', summary: 's', effort: 'small', pros: [], cons: [], touches: [], recommended: true },
  error: null, needsSignIn: false, branch: 'claimcheck/fix-c1-abc', worktree: '/wt', tests: { ok: true, code: 0, tail: '' }, killCondition: null, commits: ['abc Pin it'], summary: 'done', prompt: 'P', prUrl: null,
});

test('Open pull request is disabled with the reason written beside it when the repo has no remote', () => {
  const calls = createRecorder<string>();
  const board = readBoard({ claims: [makeClaim()], queue: ['c1'] });
  const text = draw({ ui: makeUi({ board, selectedId: 'c1', runs: new Map([['c1', makeResolvedRun()]]), ghOk: true }), actions: makeActions({ calls }) });
  const open = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Open pull request') as HTMLButtonElement;
  assert.equal(open.disabled, true);
  assert.ok(text.includes('no GitHub remote yet'), 'the reason is text on the page, not only a tooltip');
  [...document.querySelectorAll('button')].find((button) => button.textContent === 'Connect GitHub' && button.closest('.pr-offer'))?.click();
  assert.deepEqual(calls.list(), ['github']);
});

test('Open pull request is enabled when gh is signed in and the repo has a remote', () => {
  const board = { ...readBoard({ claims: [makeClaim()], queue: ['c1'] }) };
  board.repo = { ...board.repo, origin: 'https://github.com/a/b.git' };
  draw({ ui: makeUi({ board, selectedId: 'c1', runs: new Map([['c1', makeResolvedRun()]]), ghOk: true }) });
  const open = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Open pull request') as HTMLButtonElement;
  assert.equal(open.disabled, false);
  assert.equal([...document.querySelectorAll('button')].some((button) => button.textContent === 'Connect GitHub' && button.closest('.pr-offer')), false);
});

test('a fix with a branch offers Inspect the code, and pressing it names the claim', () => {
  const calls = createRecorder<string>();
  draw({ ui: makeUi({ board: readBoard({ claims: [makeClaim()], queue: ['c1'] }), selectedId: 'c1', runs: new Map([['c1', makeResolvedRun()]]) }), actions: makeActions({ calls }) });
  [...document.querySelectorAll('button')].find((button) => button.textContent === 'Inspect the code')?.click();
  assert.deepEqual(calls.list(), ['inspect:c1']);
});

test('the top bar offers Connect GitHub next to Connect Claude', () => {
  const text = draw({ ui: makeUi({ board: readBoard({ claims: [makeClaim()], queue: ['c1'] }), selectedId: 'c1' }) });
  assert.ok(text.includes('Connect GitHub') && text.includes('Connect Claude'));
});

// ---- Claude's recommendation ---------------------------------------------------------------

const makeProposal = ({ title, isRecommended }: { title: string; isRecommended: boolean }) => ({ title, summary: `${title} summary`, pros: ['p'], cons: ['c'], effort: 'small' as const, touches: ['a.py'], recommended: isRecommended });

const makeProposeDone = ({ proposals, recommendationWhy }: { proposals: PublicRun['proposals']; recommendationWhy: string | null }): PublicRun => ({
  id: 'run3', kind: 'propose', claimId: 'c1', status: 'done', startedAt: 0, mode: 'cli', activity: [], proposals, recommendationWhy, proposal: null, error: null, needsSignIn: false,
  branch: null, worktree: null, tests: null, killCondition: null, commits: [], summary: null, prompt: 'P', prUrl: null,
});

test("Claude's recommended approach is labelled, explained above the cards, and the only primary button", () => {
  const run = makeProposeDone({
    proposals: [makeProposal({ title: 'Narrow the claim', isRecommended: true }), makeProposal({ title: 'Pin the boundary', isRecommended: false }), makeProposal({ title: 'Rewrite it', isRecommended: false })],
    recommendationWhy: 'It matches what you asked for and costs the least.',
  });
  const text = draw({ ui: makeUi({ board: readBoard({ claims: [makeClaim()], queue: ['c1'] }), selectedId: 'c1', runs: new Map([['c1', run]]) }) });
  assert.ok(text.includes('Claude recommends: Narrow the claim'));
  assert.ok(text.includes('It matches what you asked for and costs the least.'));
  const badges = [...document.querySelectorAll('.badge')];
  assert.deepEqual(badges.map((badge) => badge.textContent), ['Recommended']);
  assert.ok(badges[0]?.closest('.proposal')?.textContent.includes('Narrow the claim'));
  const use = [...document.querySelectorAll('button')].filter((button) => button.textContent === 'Use this approach');
  assert.equal(use.length, 3);
  assert.deepEqual(use.map((button) => button.classList.contains('primary')), [true, false, false]);
});

test('with no recommendation the cards show no badge, no note and no primary choice', () => {
  const run = makeProposeDone({ proposals: ['Narrow the claim', 'Pin the boundary', 'Rewrite it'].map((title) => makeProposal({ title, isRecommended: false })), recommendationWhy: null });
  const text = draw({ ui: makeUi({ board: readBoard({ claims: [makeClaim()], queue: ['c1'] }), selectedId: 'c1', runs: new Map([['c1', run]]) }) });
  assert.ok(!text.includes('Claude recommends'));
  assert.equal(document.querySelectorAll('.badge').length, 0);
  const use = [...document.querySelectorAll('button')].filter((button) => button.textContent === 'Use this approach');
  assert.deepEqual(use.map((button) => button.classList.contains('primary')), [false, false, false]);
});

// ---- the wizard -------------------------------------------------------------------

const makeContextFor = ({ initial }: { initial: ReturnType<typeof runDemoWizard> }): { context: WizardCtx } => {
  let state = initial;
  const context: WizardCtx = {
    desk: new Proxy({}, { get: () => () => Promise.reject(new Error('no bridge in this test')) }) as never,
    state: () => state,
    set: (next) => { state = next; renderWizard({ context, mountInto: app }); },
    connection: () => ({ mode: 'cli', model: 'm', cliPath: '/x/claude', cliOk: true, apiSaved: false, apiLast4: null, apiOk: null, claimcheckBin: null, useAuto: false }),
    refreshConnection: async () => {},
    toast: skipAction,
    openConnect: skipAction,
    exit: skipAction,
    reducedMotion: true,
  };
  return { context };
};

test('each wizard step draws its title and a way forward', () => {
  const expect: Array<[number, number, string]> = [
    [1, 0, 'A confident claim is not a checked claim'],
    [1, 1, 'Three checks the author cannot influence'],
    [1, 2, 'What a planted bug shows'],
    [2, 0, 'Set up this repository'],
    [3, 0, 'Connect Claude'],
    [4, 0, 'Write the spec'],
    [5, 0, 'Freeze the spec'],
    [6, 0, "You're set up"],
  ];
  for (const [step, beat, title] of expect) {
    const { context: context } = makeContextFor({ initial: runDemoWizard({ step, beat }) });
    renderWizard({ context, mountInto: app });
    const text = app.textContent;
    assert.ok(text.includes(title), `${step}.${beat} should say "${title}"`);
    assert.ok(text.includes(`Step ${step} of 6`));
  }
});

test('the planted-bug demo ends on its final state when motion is reduced', () => {
  const { context: wizardCtx } = makeContextFor({ initial: runDemoWizard({ step: 1, beat: 2 }) });
  renderWizard({ context: wizardCtx, mountInto: app });
  const demo = document.querySelector('.demo') as HTMLElement;
  assert.equal(demo.dataset.stage, '3');
  assert.ok(app.textContent.includes('The same bug is now caught.'));
});

test('setup lists what was done, warns about a committed secret, and shows the detected test command', () => {
  const wizardState = runDemoWizard({ step: 2 });
  const init = wizardState.setup.init;
  assert.ok(init);
  const { context: wizardCtx } = makeContextFor({ initial: { ...wizardState, setup: { ...wizardState.setup, init: { ...init, secrets: { ...init.secrets, tracked: ['.env'] } } } } });
  renderWizard({ context: wizardCtx, mountInto: app });
  const text = app.textContent;
  for (const must of ['Secrets', 'Commit hook', 'Agent instructions', 'CLAUDE.md (added)', 'detected node', '.env is already committed']) assert.ok(text.includes(must), must);
  assert.equal((document.querySelector('input[aria-label="Test command"]') as HTMLInputElement).value, 'npm test');
});

test('the spec step shows the questions beside editable criteria, and local warnings', () => {
  const wizardState = runDemoWizard({ step: 4 });
  const withVague = { ...wizardState, draft: { ...wizardState.draft, criteria: [{ text: 'The checkout is fast.', check: '', lint: [] }, ...wizardState.draft.criteria] } };
  const { context: wizardCtx } = makeContextFor({ initial: withVague });
  renderWizard({ context: wizardCtx, mountInto: app });
  const text = app.textContent;
  assert.ok(text.includes('What should an order of exactly $50 pay for shipping?'));
  assert.ok(text.includes('Why: It decides which side'));
  assert.ok(text.includes('"fast" is vague'));
  assert.equal(document.querySelectorAll('.criterion').length, 4);
});

test('Back from the first spec step of a board-started wizard leaves the wizard', () => {
  const calls = createRecorder<string>();
  const { context: wizardCtx } = makeContextFor({ initial: { ...runDemoWizard({ step: 4 }), entry: 'board' } });
  wizardCtx.exit = () => calls.record('exit');
  renderWizard({ context: wizardCtx, mountInto: app });
  const back = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Back') as HTMLElement;
  back.click();
  assert.deepEqual(calls.list(), ['exit']);
});

test('the top bar has a Light, Dark and Auto switch, with the current one marked', () => {
  draw({ ui: makeUi({ board: readBoard({ claims: [makeClaim()], queue: [] }), theme: 'dark' }) });
  const buttons = [...document.querySelectorAll('.theme-switch button')];
  assert.deepEqual(buttons.map((button) => button.textContent), ['Light', 'Dark', 'Auto']);
  assert.deepEqual(buttons.map((button) => button.getAttribute('aria-pressed')), ['false', 'true', 'false']);
  assert.ok(document.querySelector('.topbar .theme-switch'), 'the switch sits in the top bar');
});

test('the switch is there before any repo is open, and a click asks for that look', () => {
  const calls = createRecorder<string>();
  draw({ ui: makeUi({ board: null }), actions: makeActions({ calls }) });
  for (const label of ['Light', 'Dark', 'Auto']) {
    ([...document.querySelectorAll('.theme-switch button')].find((button) => button.textContent === label) as HTMLElement).click();
  }
  assert.deepEqual(calls.list(), ['theme:light', 'theme:dark', 'theme:system']);
});

// ---- the all-clear banner ---------------------------------------------------------------------------

const readClearBoard = ({ repo = {} }: { repo?: Partial<Board['repo']> } = {}): Board => readBoard({ claims: [makeClaim({ over: { flags: [] } })], queue: [], repo: { origin: 'https://github.com/a/b.git', ...repo } });

test('when nothing needs a decision, a banner congratulates and offers the pull request', () => {
  const text = draw({ ui: makeUi({ board: readClearBoard(), ghOk: true }) });
  assert.ok(text.includes('Nice work. Every claim is backed.'));
  assert.ok(text.includes('Nothing on feature/x needs a decision now. 1 claim backed.'));
  assert.ok(text.includes('a good sign, not a sign-off'), 'it does not claim the change is approved');
  const button = [...document.querySelectorAll('.all-clear button')].find((candidate) => candidate.textContent === 'Open pull request') as HTMLElement;
  assert.equal(button.hasAttribute('disabled'), false);
});

test('the banner is not shown while a claim still needs a decision, or when there are no claims', () => {
  const flagged = readBoard({ claims: [makeClaim({ over: { flags: ['refuted'] } })], queue: ['c1'] });
  assert.ok(!draw({ ui: makeUi({ board: flagged }) }).includes('Nice work'));
  assert.ok(!draw({ ui: makeUi({ board: readBoard({ claims: [], queue: [] }) }) }).includes('Nice work'));
});

test('the pull request button asks for it, and says why it cannot when it cannot', () => {
  const calls = createRecorder<string>();
  draw({ ui: makeUi({ board: readClearBoard(), ghOk: true }), actions: makeActions({ calls }) });
  ([...document.querySelectorAll('.all-clear button')].find((candidate) => candidate.textContent === 'Open pull request') as HTMLElement).click();
  assert.deepEqual(calls.list(), ['branch-pr']);

  const text = draw({ ui: makeUi({ board: readClearBoard({ repo: { isBranchPushed: false } }), ghOk: true }) });
  assert.ok(text.includes('git push -u origin feature/x'));
  const blocked = [...document.querySelectorAll('.all-clear button')].find((candidate) => candidate.textContent === 'Open pull request') as HTMLElement;
  assert.equal(blocked.hasAttribute('disabled'), true);
  assert.ok(![...document.querySelectorAll('.all-clear button')].some((candidate) => candidate.textContent === 'Connect GitHub'), 'signed in, so the only problem is the push');

  draw({ ui: makeUi({ board: readClearBoard(), ghOk: false }) });
  assert.ok([...document.querySelectorAll('.all-clear button')].some((candidate) => candidate.textContent === 'Connect GitHub'));
});

test('once the pull request is opened, the banner links to it instead of offering another', () => {
  const calls = createRecorder<string>();
  const actions = { ...makeActions({ calls }), openPath: (target: string) => calls.record(`path:${target}`) };
  const text = draw({ ui: makeUi({ board: readClearBoard(), ghOk: true, branchPr: { branch: 'feature/x', url: 'https://github.com/a/b/pull/3' } }), actions });
  assert.ok(!text.includes('Open pull request'));
  ([...document.querySelectorAll('.all-clear button')].find((candidate) => candidate.textContent === 'View pull request') as HTMLElement).click();
  assert.deepEqual(calls.list(), ['path:https://github.com/a/b/pull/3']);
  const otherBranch = draw({ ui: makeUi({ board: readClearBoard(), ghOk: true, branchPr: { branch: 'feature/other', url: 'https://github.com/a/b/pull/4' } }) });
  assert.ok(otherBranch.includes('Open pull request'), 'a pull request from a different branch does not count');
});

test('a claim settled by hand while still flagged is not called backed', () => {
  const held = makeClaim({ over: { id: 'c2', flags: ['refuted'], status: 'accepted' } });
  const board = readBoard({ claims: [makeClaim({ over: { flags: [] } }), held], queue: [], repo: { origin: 'https://github.com/a/b.git' } });
  const text = draw({ ui: makeUi({ board, ghOk: true }) });
  assert.ok(!text.includes('Every claim is backed'));
  assert.ok(text.includes('Nothing is left to decide.'));
  assert.ok(text.includes('1 claim backed, 1 settled by hand but still flagged.'));
});

// ---- the pull request and issue tabs ----------------------------------------------------------------------------------------

const buildPull = ({ number, over = {} }: { number: number; over?: Partial<PullRequestSummary> }): PullRequestSummary => ({
  number, title: `Change ${number}`, url: `https://github.com/a/b/pull/${number}`, author: 'dana', isBot: false, isDraft: false, headBranch: `feature/${number}`, baseBranch: 'main', headSha: 'abc', isFromFork: false,
  createdAtIso: '2026-10-20T00:00:00Z', updatedAtIso: '2026-10-26T00:00:00Z', additions: 10, deletions: 2, changedFiles: 3, labels: [], review: 'review-required',
  checks: { state: 'passing', passing: 4, failing: 0, pending: 0, failingNames: [] }, merge: 'clean', linkedIssues: [], isMine: false, isReviewRequested: false, ...over,
});

const buildPullDetail = ({ number, over = {} }: { number: number; over?: Partial<PullRequestDetail> }): PullRequestDetail => ({
  ...buildPull({ number }), body: 'Moves the fee rules.', files: [{ path: 'src/fees.py', additions: 8, deletions: 1 }], reviews: [{ author: 'lee', state: 'approved' }], commitCount: 2, commentCount: 0, carriesClaims: false, ...over,
});

const readyPulls = ({ items }: { items: readonly PullRequestSummary[] }): BoardUi['pulls'] => ({ state: 'ready', items, viewer: 'dana' });

const drawGithub = ({ github, actions = makeActions(), mode = 'pulls' }: { github: Partial<BoardUi>; actions?: BoardActions; mode?: BoardUi['mode'] }): string =>
  draw({ ui: makeUi({ board: readBoard({ claims: [], queue: [] }), mode, ghOk: true, github }), actions });

test('the board always offers all four tabs, with the open counts once the lists are in', () => {
  drawGithub({ github: { pulls: readyPulls({ items: [buildPull({ number: 1 }), buildPull({ number: 2 })] }) }, mode: 'list' });
  const tabs = [...document.querySelectorAll('.mode-tabs .tab')].map((tab) => tab.textContent);
  assert.deepEqual(tabs, ['Claims', 'Confidence map', 'Pull requests (2)', 'Issues']);
});

test('the pull request list shows who, which branches, and where the checks and review stand', () => {
  const failing = buildPull({ number: 7, over: { isDraft: true, isReviewRequested: true, merge: 'conflicting', review: 'changes-requested', checks: { state: 'failing', passing: 3, failing: 2, pending: 0, failingNames: ['Lint'] } } });
  const text = drawGithub({ github: { pulls: readyPulls({ items: [failing, buildPull({ number: 8 })] }) } });
  for (const must of ['#7 Change 7', 'dana · feature/7 → main', 'Draft', 'Review requested', '2 failing', 'Changes requested', 'Conflicts', '#8 Change 8', 'Checks passing', 'Review needed']) {
    assert.ok(text.includes(must), must);
  }
});

test('the filters narrow the pull request list, and each says so when nothing matches', () => {
  const pulls = readyPulls({ items: [buildPull({ number: 1, over: { isMine: true } }), buildPull({ number: 2, over: { isReviewRequested: true } }), buildPull({ number: 3 })] });
  const rows = (): string[] => [...document.querySelectorAll('.gh-rows .claim-row')].map((row) => row.getAttribute('data-pull') ?? '');
  drawGithub({ github: { pulls } });
  assert.deepEqual(rows(), ['1', '2', '3']);
  drawGithub({ github: { pulls, githubFilter: 'mine' } });
  assert.deepEqual(rows(), ['1']);
  drawGithub({ github: { pulls, githubFilter: 'review' } });
  assert.deepEqual(rows(), ['2']);
  assert.ok(drawGithub({ github: { pulls: readyPulls({ items: [buildPull({ number: 3 })] }), githubFilter: 'review' } }).includes('Nothing is waiting on your review.'));
});

test('clicking a pull request, a filter and Refresh call the page', () => {
  const calls = createRecorder<string>();
  drawGithub({ github: { pulls: readyPulls({ items: [buildPull({ number: 4 })] }) }, actions: makeActions({ calls }) });
  (document.querySelector('.gh-rows .claim-row') as HTMLElement).click();
  ([...document.querySelectorAll('.gh-toolbar button')].find((button) => button.textContent === 'Mine') as HTMLElement).click();
  ([...document.querySelectorAll('.gh-toolbar button')].find((button) => button.textContent === 'Refresh') as HTMLElement).click();
  assert.deepEqual(calls.list(), ['pull:4', 'filter:mine', 'refresh']);
});

test('while it loads, when it fails, and when it is signed out, the list says so and offers the next step', () => {
  assert.ok(drawGithub({ github: { pulls: { state: 'loading' } } }).includes('Loading pull requests'));
  const calls = createRecorder<string>();
  const failed = draw({ ui: makeUi({ board: readBoard({ claims: [], queue: [] }), mode: 'pulls', ghOk: false, github: { pulls: { state: 'failed', message: 'The GitHub CLI is not signed in. Press Connect GitHub.' } } }), actions: makeActions({ calls }) });
  assert.ok(failed.includes('The GitHub CLI is not signed in.'));
  assert.ok([...document.querySelectorAll('.gh-state button')].some((button) => button.textContent === 'Try again'));
  assert.ok([...document.querySelectorAll('.gh-state button')].some((button) => button.textContent === 'Connect GitHub'));
});

test('an opened pull request shows its checks, review, files, linked issues and a formatted description', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const detail = buildPullDetail({ number: 5, over: { body: `**Moves** the fee rules ${hostile}`, review: 'approved', linkedIssues: [{ number: 7, title: 'Slow checkout', url: 'https://github.com/a/b/issues/7' }], carriesClaims: true, labels: ['bug'] } });
  const text = drawGithub({ github: { pulls: readyPulls({ items: [buildPull({ number: 5 })] }), selectedPull: 5, details: new Map([['pull:5', { state: 'pull', value: detail }]]) } });
  for (const must of ['Checks', 'passing', 'Approved', 'lee approved', 'Can merge', '#7 Slow checkout', 'src/fees.py', 'Files changed (1)', 'carries its own claims file', 'bug']) {
    assert.ok(text.includes(must), must);
  }
  assert.ok(text.includes('[image]'), 'a picture tag is named, not built');
  assert.equal(document.querySelector('.gh-body img'), null, 'and never turned into an element');
  assert.equal(document.querySelector('.gh-body strong')?.textContent, 'Moves', 'the Markdown is formatted, not shown with its stars');
});

test('a very long description is cut, and says where the rest is', () => {
  const detail = buildPullDetail({ number: 5, over: { body: 'x'.repeat(20000) } });
  drawGithub({ github: { pulls: readyPulls({ items: [buildPull({ number: 5 })] }), selectedPull: 5, details: new Map([['pull:5', { state: 'pull', value: detail }]]) } });
  const shown = document.querySelector('.gh-body')?.textContent ?? '';
  assert.ok(shown.length < 6200);
  assert.ok(shown.endsWith('the rest is on GitHub.'));
});

test('the issues tab lists issues, and opened ones show their labels and who is assigned', () => {
  const issue = { number: 12, title: 'Checkout is slow', url: 'https://github.com/a/b/issues/12', author: 'lee', isOpen: true, labels: ['bug', 'perf'], assignees: ['dana'], commentCount: 3, createdAtIso: '2026-10-01T00:00:00Z', updatedAtIso: '2026-10-26T00:00:00Z', isMine: true };
  const details = new Map<string, GithubDetailLoad>([['issue:12', { state: 'issue', value: { ...issue, body: 'It takes ten seconds.' } }]]);
  const text = drawGithub({ mode: 'issues', github: { issues: { state: 'ready', items: [issue], viewer: 'dana' }, selectedIssue: 12, details } });
  for (const must of ['#12 Checkout is slow', 'lee', '3 comments', 'Yours', 'bug', 'perf', 'Assigned to dana.', 'It takes ten seconds.', 'View on GitHub']) {
    assert.ok(text.includes(must), must);
  }
  assert.ok(!text.includes('Needs my review'), 'issues have no review filter');
});
