/**
 * Canned wizard states for `--view wizard:N` screenshots. Plain data, no calls to the main process.
 *
 * @author Patrick Finazzo
 */

import type { PublicRun } from '../lib/fixer.ts';
import type { Board, Claim, Mutant } from '../shared/types.ts';
import { parseUnifiedDiff } from '../shared/diff.ts';
import type { CcInit, CcFinish } from '../shared/types.ts';
import { initialWizard, type WizardState } from '../shared/wizard-state.ts';

const init: CcInit = {
  repo: 'C:/work/checkout-service',
  config: 'created',
  stack: { name: 'node', test_cmd: 'npm test', others: [] },
  hook: { status: 'installed', path: '.git/hooks/pre-commit' },
  secrets: { created: true, added: ['.env', '.env.*', '!.env.example', '*.pem', '*.key'], tracked: [] },
  gitignore_added: ['.claimcheck/runs/', '.claimcheck/mutate.lock'],
  agent_docs: [{ path: 'CLAUDE.md', action: 'added' }],
  ci: null,
  next: 'write_spec',
};

const finish: CcFinish = {
  spec_path: '.claimcheck/spec.md',
  criteria: 3,
  frozen: true,
  lock_sha256: 'f484e3228c8c6b6fa429482a862a647914da4b67000e02bdf54c30e5c38c4227',
  branch: 'task/orders-of-50-or-more',
  commit: '2dc0946a1b3c5d7e9f',
};

const DEMO_DIFF = [
  'diff --git a/.claimcheck/config.toml b/.claimcheck/config.toml',
  '--- a/.claimcheck/config.toml',
  '+++ b/.claimcheck/config.toml',
  '@@ -1,4 +1,4 @@',
  ' base = "main"',
  '-test_cmd = \'node -e "process.exit(0)"\'',
  '+test_cmd = "python -m pytest -q"',
  ' ignore = []',
  ' ',
  'diff --git a/tests/test_calc.py b/tests/test_calc.py',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/tests/test_calc.py',
  '@@ -0,0 +1,9 @@',
  '+from src.calc import is_adult',
  '+',
  '+',
  '+def test_is_adult_at_the_boundary():',
  '+    assert is_adult(17) is False',
  '+    assert is_adult(18) is True',
  '+    assert is_adult(19) is True',
].join('\n');

type DemoClaim = { id: string; claim: string; confidence: number | null; catchRate: number | null; verdict: 'SUPPORTED' | 'UNVERIFIABLE' | 'REFUTED' | null; status?: Claim['status'] };

const DEMO_CLAIMS: readonly DemoClaim[] = [
  { id: 'c1', claim: 'shipping_fee returns 0 for orders of $50 or more', confidence: 0.92, catchRate: 0.5, verdict: 'SUPPORTED' },
  { id: 'c2', claim: 'coupons never stack with a sale price', confidence: 0.6, catchRate: 0.4, verdict: 'REFUTED' },
  { id: 'c3', claim: 'delivery windows parse hours and minutes', confidence: 0.95, catchRate: 1, verdict: 'SUPPORTED' },
  { id: 'c4', claim: 'a failed payment is retried with backoff', confidence: 0.9, catchRate: 0.9, verdict: 'SUPPORTED' },
  { id: 'c5', claim: 'cart totals use the price list for the locale', confidence: 0.88, catchRate: 0.8, verdict: 'SUPPORTED' },
  { id: 'c6', claim: 'tax is rounded half-up to the cent', confidence: 0.97, catchRate: 0.5, verdict: 'SUPPORTED' },
  { id: 'c7', claim: 'the order webhook ignores a repeated event id', confidence: 0.55, catchRate: 0.9, verdict: 'SUPPORTED' },
  { id: 'c8', claim: 'receipt export escapes quotes in csv', confidence: 0.82, catchRate: 0.7, verdict: 'SUPPORTED' },
  { id: 'c9', claim: 'timestamps are stored in UTC', confidence: 0.93, catchRate: null, verdict: 'SUPPORTED' },
  { id: 'c10', claim: 'the order list keeps a stable page order', confidence: 0.35, catchRate: 0.4, verdict: 'REFUTED' },
  { id: 'c11', claim: 'the rate limit resets every hour', confidence: 0.7, catchRate: 0.9, verdict: 'SUPPORTED' },
  { id: 'c12', claim: 'the email check accepts a plus sign', confidence: 0.99, catchRate: 0.2, verdict: 'REFUTED' },
  { id: 'c13', claim: 'a null cart is rejected', confidence: 0.91, catchRate: 0.9, verdict: 'UNVERIFIABLE' },
  { id: 'c14', claim: 'logs redact payment keys', confidence: 0.9, catchRate: 0.9, verdict: 'SUPPORTED' },
  { id: 'c15', claim: 'config merging is deep', confidence: null, catchRate: 0.7, verdict: null },
  { id: 'c16', claim: 'the retry limit is enforced', confidence: 0.6, catchRate: 1, verdict: 'SUPPORTED', status: 'resolved' },
];

const PLANTED_BUGS_PER_CLAIM = 10;
const DEMO_BUG_KINDS = ['boundary', 'sign_flip', 'off_by_one', 'swap_args'] as const;

/** Planted bugs for a sample claim: the share the tests caught matches the claim's catch rate exactly. */
const buildDemoMutants = ({ index, catchRate }: { index: number; catchRate: number }): Mutant[] =>
  Array.from({ length: PLANTED_BUGS_PER_CLAIM }, (_, piece) => ({
    file: 'src/checkout.py',
    line_no: index * 20 + piece + 1,
    cls: DEMO_BUG_KINDS[piece % DEMO_BUG_KINDS.length] ?? 'boundary',
    original: 'total >= limit',
    mutated: 'total > limit',
    outcome: piece < Math.round(catchRate * PLANTED_BUGS_PER_CLAIM) ? 'killed' : 'survived',
  }));

const buildDemoClaim = ({ entry, index, flagConfidence, flagCatchRate }: { entry: DemoClaim; index: number; flagConfidence: number; flagCatchRate: number }): Claim => {
  // The same rules the board uses (flagsOf in lib/store.ts): a claim is flagged unless every check is satisfied.
  const flags = [
    ...(entry.confidence === null || entry.confidence < flagConfidence ? ['low-confidence'] : []),
    ...(entry.verdict === 'REFUTED' ? ['refuted'] : []),
    ...(entry.verdict !== 'SUPPORTED' && entry.verdict !== 'REFUTED' ? ['unverified'] : []),
    ...(entry.catchRate !== null && entry.catchRate < flagCatchRate ? ['weak-tests'] : []),
    ...(entry.catchRate === null ? ['no-mutants'] : []),
  ];
  const mutants = entry.catchRate === null ? [] : buildDemoMutants({ index, catchRate: entry.catchRate });
  const killed = mutants.filter((mutant) => mutant.outcome === 'killed').length;
  return {
    id: entry.id,
    claim: entry.claim,
    confidence: entry.confidence,
    criteria: [],
    files: ['src/checkout.py'],
    killCondition: 'test: tests/test_checkout.py',
    verifiedBy: [],
    verdict: entry.verdict ? { id: entry.id, verdict: entry.verdict, reason: '', evidence: [], provider: 'claude', model: null, ts: '2026-10-26T00:00:00Z', runId: 'demo' } : null,
    mutation: entry.catchRate === null ? null : { total: mutants.length, killed, survived: mutants.length - killed, timeout: 0, catchRate: killed / mutants.length, mutants, ts: '2026-10-26T00:00:00Z', runId: 'demo' },
    status: entry.status ?? 'open',
    reopened: false,
    note: '',
    fix: null,
    history: [],
    risk: 1 - (entry.confidence ?? 0.5) * (entry.catchRate ?? 0.5),
    flags,
  };
};

/** The board with a coherent set of sample claims for one project, for `--view board:graph`, so the map has something to show. */
export const buildDemoGraphBoard = ({ board }: { board: Board }): Board => {
  const { flagConfidence, flagCatchRate } = board.config.app;
  const claims = DEMO_CLAIMS.map((entry, index) => buildDemoClaim({ entry, index, flagConfidence, flagCatchRate }));
  const queue = claims
    .filter((claim) => claim.flags.length > 0 && claim.status === 'open')
    .toSorted((first, second) => second.risk - first.risk)
    .map((claim) => claim.id);
  return { ...board, claims, queue };
};

/** A finished board for `--view board:clear`: the sample claims, all backed, on a pushed branch with a remote. */
export const buildDemoClearBoard = ({ board }: { board: Board }): Board => {
  const { flagConfidence, flagCatchRate } = board.config.app;
  const claims = DEMO_CLAIMS.slice(0, 6).map((entry, index) => buildDemoClaim({ entry: { ...entry, confidence: Math.max(entry.confidence ?? 0, 0.9), catchRate: 1, verdict: 'SUPPORTED', status: 'open' }, index, flagConfidence, flagCatchRate }));
  return { ...board, claims, queue: [], repo: { ...board.repo, branch: 'feature/checkout-fees', origin: 'https://github.com/dana/checkout-service.git', isBranchPushed: true } };
};

/** Canned proposals for `--view board:propose`, with the recommended one first as the real parser orders them. */
export const buildDemoProposeRun = ({ claimId }: { claimId: string }): PublicRun => ({
  id: 'demo-propose',
  kind: 'propose',
  claimId,
  status: 'done',
  startedAt: 0,
  mode: 'cli',
  activity: [],
  proposals: [
    { title: 'Add boundary tests and make the test command run them', summary: 'The code is already right, but no test calls is_adult and the configured test command runs nothing. Add a test at 17, 18 and 19 and point the test command at pytest.', pros: ['Kills both surviving planted bugs', 'Touches no production code', 'Fixes the empty test command for every later claim'], cons: ['Changes the project test command, which other claims share'], effort: 'small', touches: ['tests/test_calc.py', '.claimcheck/config.toml'], recommended: true },
    { title: 'Narrow the claim', summary: 'Say only that is_adult(18) is True, and drop the "inclusive" wording the tests cannot check.', pros: ['Smallest change', 'Makes the claim honest today'], cons: ['Leaves the boundary unproven', 'Does not fix the empty test command'], effort: 'small', touches: ['.claimcheck/claims.yaml'], recommended: false },
    { title: 'Rewrite is_adult as a table-driven function', summary: 'Replace the comparison with a lookup that names each threshold, then test every row.', pros: ['Every threshold is explicit'], cons: ['Bigger change for a one-line function', 'Strains the project rule to keep functions simple'], effort: 'medium', touches: ['src/calc.py', 'tests/test_calc.py'], recommended: false },
  ],
  recommendationWhy: 'You asked for age 18 to count as an adult, and the tests never check that boundary, so adding them proves the code you already have instead of changing it. The claim-narrowing option is cheaper but leaves the boundary unproven, and the rewrite changes working code for no gain.',
  proposal: null,
  error: null,
  needsSignIn: false,
  branch: null,
  worktree: null,
  tests: null,
  killCondition: null,
  commits: [],
  summary: null,
  prompt: null,
  prUrl: null,
});

/** A canned fix for `--view board:code`, so the viewer can be rendered without a real Claude run. */
export const DEMO_FIX = {
  branch: 'claimcheck/fix-c2-4bb2c768',
  base: 'main',
  commits: ['4bb2c76 Add boundary tests and make the test command run them'],
  diff: parseUnifiedDiff({ text: DEMO_DIFF }),
};

/** The wizard as it looks at step N (1 to 6). Welcome has three beats: 1 is the first, the others come from the URL. */
export const runDemoWizard = ({ step, beat = 0 }: { step: number; beat?: number }): WizardState => {
  const base = initialWizard({ entry: 'first-run', repo: 'C:/work/checkout-service' });
  const withSetup: WizardState = { ...base, setup: { init, testCmd: 'npm test', ci: false } };
  const draft = {
    criteria: [
      { text: 'An order whose subtotal is exactly $50.00 pays $0 shipping.', check: 'shipping fee for a $50.00 subtotal is 0', lint: [] },
      { text: 'An order whose subtotal is under $50.00 pays $5 shipping.', check: 'shipping fee for a $49.99 subtotal is 5', lint: [] },
      { text: 'The subtotal is measured after discounts and before tax.', check: 'a $60 order with a $15 discount pays $5 shipping', lint: [] },
    ],
    out_of_scope: ['International shipping rates'],
    concerns: ['Criterion 1 assumes the threshold is inclusive. Question 1 confirms it.'],
    ready: false,
  };
  const questions = [
    { id: 'q1', text: 'What should an order of exactly $50 pay for shipping?', why: 'It decides which side of the boundary criterion 1 lands on.' },
    { id: 'q2', text: 'Does the $50 include tax and discounts, or only the item subtotal?', why: 'The threshold has to be measured on one agreed number.' },
  ];
  const doneState = (): WizardState => ({ ...withSetup, step: 'done', goal: 'Orders of $50 or more should ship free.', started: true, draft: { ...draft, ready: true }, freeze: { makeBranch: true, branch: '', outcome: finish } });
  const stateByStep = new Map<number, () => WizardState>([
    [1, () => ({ ...base, beat: Math.min(Math.max(beat, 0), 2) })],
    [2, () => ({ ...withSetup, step: 'setup' })],
    [3, () => ({ ...withSetup, step: 'connect' })],
    [4, () => ({ ...withSetup, step: 'spec', goal: 'Orders of $50 or more should ship free, and everything else pays a $5 flat fee.', started: true, rounds: [], current: { questions, answers: ['Yes, exactly $50 ships free.', ''] }, draft })],
    [5, () => ({ ...withSetup, step: 'freeze', goal: 'Orders of $50 or more should ship free.', started: true, draft: { ...draft, ready: true } })],
  ]);
  return (stateByStep.get(step) ?? doneState)();
};
