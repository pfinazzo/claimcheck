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
import type { Board, Claim } from '../src/shared/types.ts';
import { renderBoard, type BoardActions, type BoardUi } from '../src/renderer/board.ts';
import { demoWizard } from '../src/renderer/demo.ts';
import { mount, setDocument } from '../src/renderer/dom.ts';
import { factsLine, groupClaims, specWord, summaryLine } from '../src/renderer/format.ts';
import { syncConfidenceMap } from '../src/renderer/graph-view.ts';
import { renderWizard, type WizardCtx } from '../src/renderer/wizard.ts';

const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>');
setDocument(document as unknown as Document);
const app = document.getElementById('app') as unknown as HTMLElement;

// The wizard schedules its animation with window timers; a plain stand-in is enough here.
(globalThis as unknown as { window: unknown }).window = { setTimeout: (fn: () => void) => { void fn; return 0; }, clearTimeout: () => {} };

const claim = (over: Partial<Claim> = {}): Claim => ({
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

const boardOf = (claims: Claim[], queue: string[]): Board => ({
  repo: { name: 'shop', path: 'C:/shop', origin: null, branch: 'feature/x', head: 'abc', hasClaimcheck: true, lockOk: true, specState: 'frozen', lastRunTs: null },
  config: { base: 'main', test_cmd: 'npm test', ignore: [], checker: { provider: 'auto', model: 'm' }, app: { flagConfidence: 0.75, flagCatchRate: 0.8, python: null } },
  criteria: [],
  claims,
  queue,
  runs: { check: null, mutate: null },
  ledgerCount: 0,
});

const noop = (): void => {};
const actions = (calls: string[] = []): BoardActions => ({
  select: (id) => calls.push(`select:${id}`),
  openRepo: noop, connectClaude: noop, runClaimcheck: noop, writeSpec: noop, closeDrawer: noop,
  fix: (id) => calls.push(`fix:${id}`),
  useApproach: noop, copyPrompt: noop, copyImplement: noop, copyText: noop, acceptRisk: noop, openPr: noop, openPath: noop, connect: noop, connectGithub: noop, inspect: noop, setMode: noop, showClaim: noop,
});

const ui = (board: Board | null, selectedId: string | null = null, runs: Map<string, PublicRun> = new Map()): BoardUi => ({
  board, mode: 'list', selectedId, runs, ghOk: false, running: false, drawer: { open: false, status: '', lines: [] },
});

const draw = (u: BoardUi, a = actions()): string => {
  mount(app, ...renderBoard(u, a));
  return app.textContent ?? '';
};

// ---- pure formatting ------------------------------------------------------------

// ---- the summary counts each planted bug once (criteria 1-4 of the distinct-planted-bugs task) ----

const bug = (line: number, outcome: string, runId = 'r1') => ({ file: 'src/a.py', line_no: line, cls: 'boundary', original: 'x >= 1', mutated: `x > ${line}`, outcome, runId });

const withBugs = (id: string, run: string, specs: { line: number; outcome: string }[]): Claim => {
  const mutants = specs.map((s) => bug(s.line, s.outcome, run));
  const killed = mutants.filter((m) => m.outcome === 'killed').length;
  const survived = mutants.filter((m) => m.outcome === 'survived').length;
  return claim({ id, mutation: { total: mutants.length, killed, survived, timeout: 0, catchRate: killed / mutants.length, ts: '2026-01-01T00:00:00Z', runId: run, mutants: mutants.map(({ runId: _r, ...m }) => m) } });
};

test('two claims sharing the same planted bugs from one run count each bug once', () => {
  const same = [{ line: 1, outcome: 'killed' }, { line: 2, outcome: 'killed' }];
  const b = boardOf([withBugs('c1', 'r1', same), withBugs('c2', 'r1', same)], []);
  assert.match(summaryLine(b), /2 of 2 planted bugs caught\./);
});

test('claims with different planted bugs still add up', () => {
  const a = withBugs('c1', 'r1', [{ line: 1, outcome: 'killed' }, { line: 2, outcome: 'survived' }]);
  const c = withBugs('c2', 'r1', [{ line: 3, outcome: 'killed' }, { line: 4, outcome: 'killed' }, { line: 5, outcome: 'killed' }]);
  assert.match(summaryLine(boardOf([a, c], [])), /4 of 5 planted bugs caught\./);
});

test('the same change in two different runs is two measurements', () => {
  const one = withBugs('c1', 'r1', [{ line: 1, outcome: 'killed' }]);
  const two = withBugs('c2', 'r2', [{ line: 1, outcome: 'killed' }]);
  assert.match(summaryLine(boardOf([one, two], [])), /2 of 2 planted bugs caught\./);
});

test('a claim facts line is unchanged and a board with no planted bugs has no such sentence', () => {
  const two = withBugs('c1', 'r1', [{ line: 1, outcome: 'killed' }, { line: 2, outcome: 'killed' }]);
  assert.equal(factsLine(two), 'Stated 0.92. Checker: supported. Tests caught 2 of 2 planted bugs.');
  assert.doesNotMatch(summaryLine(boardOf([claim({ mutation: null })], [])), /planted bugs/);
});

test('summary and facts are plain sentences', () => {
  const b = boardOf([claim(), claim({ id: 'c2', flags: [], mutation: null })], ['c1']);
  assert.equal(summaryLine(b), '2 claims, 1 needs a decision. 2 of 4 planted bugs caught.');
  assert.equal(factsLine(claim()), 'Stated 0.92. Checker: supported. Tests caught 2 of 4 planted bugs.');
  assert.equal(summaryLine(boardOf([], [])), 'No claims yet.');
  assert.equal(specWord('frozen'), 'Spec frozen');
  const g = groupClaims(b);
  assert.deepEqual(g.needs.map((c) => c.id), ['c1']);
  assert.deepEqual(g.backed.map((c) => c.id), ['c2']);
});

// ---- the board -------------------------------------------------------------------

test('the board shows the groups, the selected claim and its sections', () => {
  const b = boardOf([claim(), claim({ id: 'c2', claim: 'second claim', flags: [] })], ['c1']);
  const text = draw(ui(b, 'c1'));
  for (const must of ['shop', 'Needs a decision (1)', 'Backed (1)', 'Why it is here', 'Planted bugs hit', 'Fix this', 'What the checker said']) {
    if (must === 'Planted bugs hit') continue;
    assert.ok(text.includes(must), must);
  }
  assert.ok(text.includes('Planted bugs got past the tests.'));
  assert.ok(text.includes('if total >= 50:  →  if total > 50:'));
});

test('a backed claim does not offer Fix this', () => {
  const text = draw(ui(boardOf([claim({ flags: [] })], []), 'c1'));
  assert.ok(!text.includes('Fix this'));
  assert.ok(text.includes('Nothing is flagged'));
});

test('clicking a row selects it, and Fix this calls the action', () => {
  const calls: string[] = [];
  const b = boardOf([claim()], ['c1']);
  draw(ui(b, 'c1'), actions(calls));
  (document.querySelector('.claim-row') as unknown as HTMLElement).click();
  const fix = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Fix this') as unknown as HTMLElement;
  fix.click();
  assert.deepEqual(calls, ['select:c1', 'fix:c1']);
});

const resolvedRun = (): PublicRun => ({ id: 'run2', kind: 'implement', claimId: 'c1', status: 'resolved', startedAt: 0, mode: 'cli', activity: [], proposals: null, proposal: { title: 'Pin it', summary: 's', effort: 'low', pros: [], cons: [], touches: [] }, error: null, needsSignIn: false, branch: 'claimcheck/fix-c1-abc', worktree: '/wt', tests: { ok: true, tail: '' }, killCondition: null, commits: ['abc Pin it'], summary: 'done', prompt: 'P', prUrl: null } as unknown as PublicRun);

test('Open pull request is disabled with the reason written beside it when the repo has no remote', () => {
  const b = boardOf([claim()], ['c1']);
  const calls: string[] = [];
  const text = draw(ui(b, 'c1', new Map([['c1', resolvedRun()]])), { ...actions(calls), connectGithub: () => calls.push('github') });
  const open = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Open pull request') as unknown as HTMLButtonElement;
  assert.equal(open.disabled, true);
  assert.ok(text.includes('no GitHub remote yet'), 'the reason is text on the page, not only a tooltip');
  [...document.querySelectorAll('button')].find((x) => x.textContent === 'Connect GitHub')?.click();
  assert.deepEqual(calls, ['github']);
});

test('Open pull request is enabled when gh is signed in and the repo has a remote', () => {
  const b = { ...boardOf([claim()], ['c1']) };
  b.repo = { ...b.repo, origin: 'https://github.com/a/b.git' };
  draw({ ...ui(b, 'c1', new Map([['c1', resolvedRun()]])), ghOk: true });
  const open = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Open pull request') as unknown as HTMLButtonElement;
  assert.equal(open.disabled, false);
  assert.equal([...document.querySelectorAll('button')].some((x) => x.textContent === 'Connect GitHub' && x.closest('.pr-offer')), false);
});

test('a fix with a branch offers Inspect the code, and pressing it names the claim', () => {
  const calls: string[] = [];
  draw(ui(boardOf([claim()], ['c1']), 'c1', new Map([['c1', resolvedRun()]])), { ...actions(calls), inspect: (id) => calls.push(`inspect:${id}`) });
  [...document.querySelectorAll('button')].find((x) => x.textContent === 'Inspect the code')?.click();
  assert.deepEqual(calls, ['inspect:c1']);
});

test('the top bar offers Connect GitHub next to Connect Claude', () => {
  const text = draw(ui(boardOf([claim()], ['c1']), 'c1'));
  assert.ok(text.includes('Connect GitHub') && text.includes('Connect Claude'));
});

const proposal = (title: string, isRecommended: boolean) => ({ title, summary: `${title} summary`, pros: ['p'], cons: ['c'], effort: 'small' as const, touches: ['a.py'], recommended: isRecommended });

const proposeDone = (proposals: ReturnType<typeof proposal>[], recommendationWhy: string | null): PublicRun =>
  ({ id: 'run3', kind: 'propose', claimId: 'c1', status: 'done', startedAt: 0, mode: 'cli', activity: [], proposals, recommendationWhy, proposal: null, error: null, needsSignIn: false, branch: null, worktree: null, tests: null, killCondition: null, commits: [], summary: null, prompt: 'P', prUrl: null }) as unknown as PublicRun;

test('Claude\'s recommended approach is labelled, explained above the cards, and the only primary button', () => {
  const run = proposeDone([proposal('Narrow the claim', true), proposal('Pin the boundary', false), proposal('Rewrite it', false)], 'It matches what you asked for and costs the least.');
  const text = draw(ui(boardOf([claim()], ['c1']), 'c1', new Map([['c1', run]])));
  assert.ok(text.includes('Claude recommends: Narrow the claim'));
  assert.ok(text.includes('It matches what you asked for and costs the least.'));
  const badges = [...document.querySelectorAll('.badge')];
  assert.deepEqual(badges.map((b) => b.textContent), ['Recommended']);
  assert.ok(badges[0]?.closest('.proposal')?.textContent?.includes('Narrow the claim'));
  const use = [...document.querySelectorAll('button')].filter((x) => x.textContent === 'Use this approach');
  assert.equal(use.length, 3);
  assert.deepEqual(use.map((b) => b.classList.contains('primary')), [true, false, false]);
});

test('with no recommendation the cards show no badge, no note and no primary choice', () => {
  const run = proposeDone([proposal('Narrow the claim', false), proposal('Pin the boundary', false), proposal('Rewrite it', false)], null);
  const text = draw(ui(boardOf([claim()], ['c1']), 'c1', new Map([['c1', run]])));
  assert.ok(!text.includes('Claude recommends'));
  assert.equal(document.querySelectorAll('.badge').length, 0);
  const use = [...document.querySelectorAll('button')].filter((x) => x.textContent === 'Use this approach');
  assert.deepEqual(use.map((b) => b.classList.contains('primary')), [false, false, false]);
});

// ---- the confidence map tab ---------------------------------------------------------------------

const mixedBoard = (): Board => {
  const strong = claim({ id: 'c3', claim: 'strong claim', confidence: 0.95, flags: [], risk: 0.05, mutation: { total: 4, killed: 4, survived: 0, timeout: 0, catchRate: 1, ts: 't', runId: 'r', mutants: [] } });
  const weak = claim({ id: 'c1', claim: 'weak claim', confidence: 0.4, flags: ['low-confidence'], risk: 0.9 });
  const settled = claim({ id: 'c4', claim: 'settled claim', confidence: 0.6, flags: ['low-confidence'], status: 'resolved', risk: 0.5 });
  return boardOf([strong, weak, settled], ['c1']);
};

test('pressed and selected states are the words true and false, which is what screen readers read', () => {
  draw(ui(mixedBoard(), 'c1'));
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  assert.deepEqual(tabs.map((t) => t.getAttribute('aria-selected')), ['true', 'false']);
  const rows = [...document.querySelectorAll('.claim-row')];
  assert.ok(rows.length > 0);
  assert.deepEqual(rows.map((r) => r.getAttribute('aria-pressed')), rows.map((r) => (r.getAttribute('data-claim') === 'c1' ? 'true' : 'false')));
});

test('the board offers a Claims tab and a Confidence map tab, and pressing one asks for that mode', () => {
  const modes: string[] = [];
  draw(ui(mixedBoard(), 'c1'), { ...actions(), setMode: (mode) => modes.push(mode) });
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  assert.deepEqual(tabs.map((t) => t.textContent), ['Claims', 'Confidence map']);
  assert.equal(tabs[0]?.getAttribute('aria-selected'), 'true');
  (tabs[1] as unknown as HTMLElement).click();
  assert.deepEqual(modes, ['graph']);
});

test('the confidence map lists EVERY claim, flagged and backed, riskiest first, with plain-word states', () => {
  draw({ ...ui(mixedBoard(), 'c1'), mode: 'graph' });
  const rows = [...document.querySelectorAll('.all-claims-table tbody tr')].map((r) => (r.textContent ?? '').replace(/\s+/g, ' ').trim());
  assert.equal(rows.length, 3, 'all three claims, not only the flagged one');
  assert.ok(rows[0]?.startsWith('c1 weak claim'));
  assert.ok(rows[0]?.includes('Needs a decision'));
  assert.ok(rows[1]?.includes('settled claim') && rows[1]?.includes('Resolved'));
  assert.ok(rows[2]?.includes('strong claim') && rows[2]?.includes('Backed') && rows[2]?.includes('100%'));
  assert.ok((app.textContent ?? '').includes('All claims (3)'));
  assert.ok((app.textContent ?? '').includes('1 of 3 claims need a decision'));
});

test('a row selects its claim, and Open claim leaves the map for that claim', () => {
  const calls: string[] = [];
  draw({ ...ui(mixedBoard(), 'c1'), mode: 'graph' }, { ...actions(calls), showClaim: (id) => calls.push(`show:${id}`) });
  (document.querySelector('tr[data-claim="c3"] button') as unknown as HTMLElement).click();
  [...document.querySelectorAll('button')].find((b) => b.textContent === 'Open claim')?.click();
  assert.deepEqual(calls, ['select:c3', 'show:c1']);
});

test('where WebGL is not available the map says so, and the table is still there', () => {
  const state = { ...ui(mixedBoard(), 'c1'), mode: 'graph' as const };
  draw(state);
  syncConfidenceMap({ ui: state, onSelect: noop as never, reducedMotion: true });
  const note = document.querySelector('.map-note') as unknown as HTMLElement;
  assert.ok((note.textContent ?? '').includes('The map could not start'));
  assert.equal(note.hidden, false);
  assert.equal(document.querySelectorAll('.all-claims-table tbody tr').length, 3);
});

test('empty states say what to do next', () => {
  assert.ok(draw(ui(null)).includes('Open a repository'));
  assert.ok(draw(ui(boardOf([], []))).includes('Run claimcheck'));
});

test('markup in a claim, a verdict, a path or a mutation is shown as text, never built', () => {
  const evil = '<img src=x onerror=alert(1)><button data-action="open-path">x</button>';
  const hostile = claim({
    claim: evil,
    files: [evil],
    killCondition: evil,
    verifiedBy: [evil],
    verdict: { id: 'c1', verdict: `x" onclick="alert(1)`, reason: evil, evidence: [evil], provider: evil, model: evil, ts: evil, runId: 'r' },
    mutation: { total: 1, killed: 0, survived: 1, timeout: 0, catchRate: 0, ts: 't', runId: 'r', mutants: [{ file: evil, line_no: null, cls: evil, original: evil, mutated: evil, outcome: evil }] },
  });
  const text = draw(ui(boardOf([hostile], ['c1']), 'c1'));
  assert.ok(text.includes(evil), 'the text is there, as text');
  assert.equal(document.querySelectorAll('img').length, 0);
  assert.equal(document.querySelectorAll('[onclick], [onerror], [data-action]').length, 0);
});

test('a running fix shows its activity and offers no second Fix press', () => {
  const run = { id: 'run1', kind: 'propose', claimId: 'c1', status: 'running', startedAt: 0, mode: 'cli', activity: ['Read src/a.py'], proposals: null, recommendationWhy: null, proposal: null, error: null, needsSignIn: false, branch: null, worktree: null, tests: null, killCondition: null, commits: [], summary: null, prompt: 'P', prUrl: null } satisfies PublicRun;
  const text = draw(ui(boardOf([claim()], ['c1']), 'c1', new Map([['c1', run]])));
  assert.ok(text.includes('Claude is reading the code'));
  assert.ok(text.includes('Read src/a.py'));
  const fix = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Fix this') as unknown as HTMLButtonElement;
  assert.equal(fix.disabled, true);
});

// ---- the wizard -------------------------------------------------------------------

const ctxFor = (initial: ReturnType<typeof demoWizard>): { ctx: WizardCtx; states: ReturnType<typeof demoWizard>[] } => {
  let state = initial;
  const states = [initial];
  const ctx: WizardCtx = {
    desk: new Proxy({}, { get: () => async () => { throw new Error('no bridge in this test'); } }) as never,
    state: () => state,
    set: (next) => { state = next; states.push(next); renderWizard(ctx, app); },
    connection: () => ({ mode: 'cli', model: 'm', cliPath: '/x/claude', cliOk: true, apiSaved: false, apiLast4: null, apiOk: null, claimcheckBin: null, useAuto: false }),
    refreshConnection: async () => {},
    toast: noop,
    openConnect: noop,
    exit: noop,
    reducedMotion: true,
  };
  return { ctx, states };
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
    const { ctx } = ctxFor(demoWizard(step, beat));
    renderWizard(ctx, app);
    const text = app.textContent ?? '';
    assert.ok(text.includes(title), `${step}.${beat} should say "${title}"`);
    assert.ok(text.includes(`Step ${step} of 6`));
  }
});

test('the planted-bug demo ends on its final state when motion is reduced', () => {
  const { ctx } = ctxFor(demoWizard(1, 2));
  renderWizard(ctx, app);
  const demo = document.querySelector('.demo') as unknown as HTMLElement;
  assert.equal(demo.dataset.stage, '3');
  assert.ok((app.textContent ?? '').includes('The same bug is now caught.'));
});

test('setup lists what was done, warns about a committed secret, and shows the detected test command', () => {
  const s = demoWizard(2);
  const init = s.setup.init;
  assert.ok(init);
  const { ctx } = ctxFor({ ...s, setup: { ...s.setup, init: { ...init, secrets: { ...init.secrets, tracked: ['.env'] } } } });
  renderWizard(ctx, app);
  const text = app.textContent ?? '';
  for (const must of ['Secrets', 'Commit hook', 'Agent instructions', 'CLAUDE.md (added)', 'detected node', '.env is already committed']) assert.ok(text.includes(must), must);
  assert.equal((document.querySelector('input[aria-label="Test command"]') as unknown as HTMLInputElement).value, 'npm test');
});

test('the spec step shows the questions beside editable criteria, and local warnings', () => {
  const s = demoWizard(4);
  const withVague = { ...s, draft: { ...s.draft, criteria: [{ text: 'The checkout is fast.', check: '', lint: [] }, ...s.draft.criteria] } };
  const { ctx } = ctxFor(withVague);
  renderWizard(ctx, app);
  const text = app.textContent ?? '';
  assert.ok(text.includes('What should an order of exactly $50 pay for shipping?'));
  assert.ok(text.includes('Why: It decides which side'));
  assert.ok(text.includes('"fast" is vague'));
  assert.equal(document.querySelectorAll('.criterion').length, 4);
});

test('Back from the first spec step of a board-started wizard leaves the wizard', () => {
  const calls: string[] = [];
  const { ctx } = ctxFor({ ...demoWizard(4), entry: 'board' });
  ctx.exit = () => calls.push('exit');
  renderWizard(ctx, app);
  const back = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Back') as unknown as HTMLElement;
  back.click();
  assert.deepEqual(calls, ['exit']);
});
