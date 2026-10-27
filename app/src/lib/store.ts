/**
 * Reads a repo's `.claimcheck/` folder into one board model: every claim with
 * the newest verdict and mutation result beside its stated confidence, plus
 * the risk score and flags that decide what lands in the decision queue.
 *
 * Everything in `.claimcheck/` can be written by someone else (a cloned repo),
 * so every field is coerced to the type the rest of the app expects.
 *
 * @author Patrick Finazzo
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import yaml from 'js-yaml';
import type {
  AppSettings, AppState, Board, BoardConfig, CheckRun, Claim, ClaimStatus, Criterion, LedgerRecord, Mutant, MutateRun, MutationInfo, SpecLock,
} from '../shared/types.ts';
import { parseToml } from './toml.ts';
import { toText } from '../shared/text.ts';
import { GIT_TIMEOUT_MS } from './timeouts.ts';
import { parseJsonOrUndefined } from '../shared/json.ts';

const runExecFile = promisify(execFile);

type Raw = Record<string, unknown>;

export const CLAIMCHECK_DIR = '.claimcheck';
export const STATUSES: readonly ClaimStatus[] = ['open', 'fixing', 'resolved', 'accepted'];
export const HISTORY_LIMIT = 50;
const MUTANT_LIMIT = 1000;
const CRITERION_RE = /^- \[[ xX]\] (\d+)\. (.+)$/;
const VERDICT_WEIGHT: Record<string, number> = { REFUTED: 1.0, UNVERIFIABLE: 0.5, SUPPORTED: 0.0 };

export const APP_DEFAULTS: AppSettings = { flagConfidence: 0.75, flagCatchRate: 0.8, python: null };

/** A git ref that cannot be read as an option: no leading dash, no odd characters. */
export const SAFE_REF = /^(?!-)[\w./-]+$/;

type SpecState = 'none' | 'draft' | 'frozen' | 'drifted';

/** No spec file, a spec without a lock (draft), or a locked spec that still matches (frozen) or not (drifted). */
const toSpecState = ({ hasSpec, isLocked, lockOk }: { hasSpec: boolean; isLocked: boolean; lockOk: boolean }): SpecState => {
  if (!hasSpec) return 'none';
  if (!isLocked) return 'draft';
  return lockOk ? 'frozen' : 'drifted';
};

const sha256 = ({ payload }: { payload: string | Buffer }): string => createHash('sha256').update(payload).digest('hex');

const toStringOrEmpty = ({ value, fallback = '' }: { value: unknown; fallback?: string }): string => toText({ value: value, fallback });
const toStringList = ({ value }: { value: unknown }): string[] => {
  if (value === null || value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map((x) => toStringOrEmpty({ value: x }));
};
const toFiniteNumber = ({ value }: { value: unknown }): number | null => (value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null);
// A type guard must name the value it narrows, so it takes it positionally.
// eslint-disable-next-line no-restricted-syntax
const isObject = (value: unknown): value is Raw => value !== null && typeof value === 'object' && !Array.isArray(value);

const readText = async ({ file }: { file: string }): Promise<string | null> => {
  try {
    return (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
};

const readJson = async ({ file }: { file: string }): Promise<unknown> => {
  const text = await readText({ file });
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const runGit = async ({ repo, argList }: { repo: string; argList: readonly string[] }): Promise<string | null> => {
  try {
    const { stdout } = await runExecFile('git', argList, { cwd: repo, windowsHide: true, timeout: GIT_TIMEOUT_MS });
    return stdout.trim();
  } catch {
    return null;
  }
};

/** Criteria from spec.md, the same regex the CLI uses. */
export const parseCriteria = ({ text }: { text: string | null }): Criterion[] =>
  (text ?? '')
    .split(/\r?\n/)
    .map((line) => line.match(CRITERION_RE))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({ id: Number(match[1]), text: match[2] ?? '' }));

/** True when every criterion hash and the file hash match the lock, as `claimcheck spec verify` checks. */
export const isLockMatching = ({ specText, specBytes, lock }: { specText: string | null; specBytes: Buffer | null; lock: unknown }): boolean => {
  if (!isObject(lock) || specText === null || specBytes === null) return false;
  const line = lock as SpecLock;
  const current = new Map(parseCriteria({ text: specText }).map((criterion) => [criterion.id, sha256({ payload: criterion.text.trim() })]));
  const locked = new Map((Array.isArray(line.criteria) ? line.criteria : []).filter(isObject).map((raw) => [Number(raw.id), toStringOrEmpty({ value: raw.sha256 })] as const));
  if (current.size !== locked.size) return false;
  for (const [id, hash] of current) if (locked.get(id) !== hash) return false;
  // spec.md is hashed the way the CLI does: no BOM, LF newlines
  const raw = specBytes[0] === 0xef && specBytes[1] === 0xbb && specBytes[2] === 0xbf ? specBytes.subarray(3) : specBytes;
  const normalised = Buffer.from(raw.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  return sha256({ payload: normalised }) === line.spec_sha256 || sha256({ payload: specBytes }) === line.spec_sha256;
};

type RiskInput = {
  confidence: number | null | undefined;
  verdict: string | null | undefined;
  catchRate: number | null | undefined;
};

/** AC 5: the number the queue sorts by. A missing confidence counts as 0, a verdict nobody knows as 0.75. */
export const readRisk = ({ confidence, verdict, catchRate }: RiskInput): number => {
  const weight = typeof verdict === 'string' && Object.hasOwn(VERDICT_WEIGHT, verdict) ? VERDICT_WEIGHT[verdict] : undefined;
  const verdictWeight = weight ?? 0.75;
  const conf = typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : 0;
  const rate = typeof catchRate === 'number' && Number.isFinite(catchRate) ? catchRate : 0;
  return Number(((1 - conf) * 0.4 + verdictWeight * 0.4 + (1 - rate) * 0.2).toFixed(4));
};

type FlagInput = {
  confidence: number | null | undefined;
  verdict: string | null | undefined;
  mutation: Pick<MutationInfo, 'total' | 'catchRate'> | null | undefined;
};

/** AC 6: why a claim needs a decision. A confidence that is missing or not a number counts as unsure. */
export const readFlags = ({ confidence, verdict, mutation, appConfig = APP_DEFAULTS }: FlagInput & { appConfig?: AppSettings }): string[] => {
  const total = mutation?.total ?? 0;
  const rate = mutation?.catchRate;
  const checks: readonly [string, boolean][] = [
    ['low-confidence', typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < appConfig.flagConfidence],
    ['refuted', verdict === 'REFUTED'],
    ['unverified', verdict !== 'SUPPORTED' && verdict !== 'REFUTED'],
    ['weak-tests', total > 0 && (rate === null || rate === undefined || rate < appConfig.flagCatchRate)],
    ['no-mutants', total === 0],
  ];
  return checks.filter(([, isRaised]) => isRaised).map(([flag]) => flag);
};

export const isInQueue = ({ claim }: { claim: Pick<Claim, 'flags' | 'status'> }): boolean => claim.flags.length > 0 && (claim.status === 'open' || claim.status === 'fixing');

const runSortKey = ({ run }: { run: { ts: string; run_id: string } }): string => `${run.ts}|${run.run_id}`;

const cleanVerdict = ({ value }: { value: Raw }): CheckRun['verdicts'][number] => ({
  id: toStringOrEmpty({ value: value.id }),
  verdict: toStringOrEmpty({ value: value.verdict }),
  reason: toStringOrEmpty({ value: value.reason }),
  evidence: toStringList({ value: value.evidence }),
});

const cleanMutant = ({ raw }: { raw: Raw }): Mutant => ({
  file: toStringOrEmpty({ value: raw.file }),
  line_no: toFiniteNumber({ value: raw.line_no }),
  cls: toStringOrEmpty({ value: raw.cls }),
  original: toStringOrEmpty({ value: raw.original }),
  mutated: toStringOrEmpty({ value: raw.mutated }),
  outcome: toStringOrEmpty({ value: raw.outcome }),
});

/** A `<run>-check.json` file's contents, cleaned. */
const toCheckRun = ({ name, raw: payload }: { name: string; raw: Raw }): CheckRun => ({
  file: name,
  run_id: toStringOrEmpty({ value: payload.run_id }),
  ts: toStringOrEmpty({ value: payload.ts }),
  provider: toStringOrEmpty({ value: payload.provider }),
  model: payload.model === null || payload.model === undefined ? null : toStringOrEmpty({ value: payload.model }),
  verdicts: (Array.isArray(payload.verdicts) ? payload.verdicts : []).filter(isObject).map((value) => cleanVerdict({ value })),
});

/** A `<run>-mutate.json` file's contents, cleaned. */
const toMutateRun = ({ name, raw: payload }: { name: string; raw: Raw }): MutateRun => ({
  file: name,
  run_id: toStringOrEmpty({ value: payload.run_id }),
  ts: toStringOrEmpty({ value: payload.ts }),
  mutants: (Array.isArray(payload.mutants) ? payload.mutants : []).filter(isObject).slice(0, MUTANT_LIMIT).map((raw) => cleanMutant({ raw })),
  per_claim: isObject(payload.per_claim) ? payload.per_claim : {},
});

const readRuns = async ({ runsDir }: { runsDir: string }): Promise<{ check: readonly CheckRun[]; mutate: readonly MutateRun[] }> => {
  let names: string[] = [];
  try {
    names = await fs.readdir(runsDir);
  } catch {
    return { check: [], mutate: [] };
  }
  const files = await Promise.all(names.map(async (name) => ({ name, raw: await readJson({ file: path.join(runsDir, name) }) })));
  const newestFirst = ({ left, right }: { left: { ts: string; run_id: string }; right: { ts: string; run_id: string } }): number => (runSortKey({ run: left }) < runSortKey({ run: right }) ? 1 : -1);
  const check = files.flatMap(({ name, raw }) => (name.endsWith('-check.json') && isObject(raw) ? [toCheckRun({ name, raw })] : [])).toSorted((left, right) => newestFirst({ left, right }));
  const mutate = files.flatMap(({ name, raw }) => (name.endsWith('-mutate.json') && isObject(raw) ? [toMutateRun({ name, raw })] : [])).toSorted((left, right) => newestFirst({ left, right }));
  return { check, mutate };
};

const readLedger = async ({ file }: { file: string }): Promise<LedgerRecord[]> => {
  const text = await readText({ file });
  if (!text) return [];
  // A torn or foreign line is not JSON. It is skipped, so one bad line never hides the rest.
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => parseJsonOrUndefined({ text: line }))
    .filter((parsed) => isObject(parsed));
};

const summarizeRun = ({ mutants }: { mutants: readonly Mutant[] }): Pick<MutationInfo, 'total' | 'killed' | 'survived' | 'timeout' | 'catchRate'> => {
  const killed = mutants.filter((mutant) => mutant.outcome === 'killed').length;
  const survived = mutants.filter((mutant) => mutant.outcome === 'survived').length;
  const timeout = mutants.filter((mutant) => mutant.outcome === 'timeout').length;
  const total = killed + survived + timeout;
  return { total, killed, survived, timeout, catchRate: total ? Number(((killed + timeout) / total).toFixed(4)) : null };
};

/** What a newest ledger outcome line says about a claim when app-state.json is missing (a fresh clone). */
const toStatusFromOutcome = ({ outcome }: { outcome: LedgerRecord | null }): ClaimStatus | null => {
  if (!outcome) return null;
  if (outcome.outcome === 'broken' && outcome.outcome_source === 'fix_commit') return 'resolved';
  if (outcome.outcome === 'held' && outcome.outcome_source === 'human') return 'accepted';
  return null;
};

const findNewestTimestamp = ({ records }: { records: readonly LedgerRecord[] }): string => records.map((ledgerRecord) => toStringOrEmpty({ value: ledgerRecord.ts })).filter(Boolean).toSorted().at(-1) ?? '';

// A type guard must name the value it narrows, so it takes it positionally.
// eslint-disable-next-line no-restricted-syntax
const isStatus = (value: unknown): value is ClaimStatus => typeof value === 'string' && (STATUSES as readonly string[]).includes(value);

/** The whole board for one repo (AC 4). */
export const readBoard = async ({ repoPath }: { repoPath: string }): Promise<Board> => {
  const repo = path.resolve(repoPath);
  const cc = path.join(repo, CLAIMCHECK_DIR);
  const configText = await readText({ file: path.join(cc, 'config.toml') });
  const configRaw: Raw = configText ? parseToml({ input: configText }) : {};
  const baseRaw = toStringOrEmpty({ value: configRaw.base, fallback: 'main' });
  const checkerRaw = isObject(configRaw.checker) ? configRaw.checker : {};
  const appRaw = isObject(configRaw.app) ? configRaw.app : {};
  const config: BoardConfig = {
    base: SAFE_REF.test(baseRaw) ? baseRaw : 'main',
    test_cmd: typeof configRaw.test_cmd === 'string' && configRaw.test_cmd.trim() ? configRaw.test_cmd : 'python -m pytest -q',
    ignore: toStringList({ value: configRaw.ignore }),
    checker: { provider: toStringOrEmpty({ value: checkerRaw.provider, fallback: 'claude' }), model: toStringOrEmpty({ value: checkerRaw.model, fallback: 'claude-opus-5-5' }) },
    app: {
      flagConfidence: toFiniteNumber({ value: appRaw.flagConfidence }) ?? APP_DEFAULTS.flagConfidence,
      flagCatchRate: toFiniteNumber({ value: appRaw.flagCatchRate }) ?? APP_DEFAULTS.flagCatchRate,
      python: typeof appRaw.python === 'string' && appRaw.python ? appRaw.python : APP_DEFAULTS.python,
    },
  };

  const specText = await readText({ file: path.join(cc, 'spec.md') });
  const specBytes = specText === null ? null : await fs.readFile(path.join(cc, 'spec.md'));
  const lock = await readJson({ file: path.join(cc, 'spec.lock') });
  const criteria = parseCriteria({ text: specText });
  const criteriaText = new Map(criteria.map((criterion) => [criterion.id, criterion.text]));

  const claimsText = await readText({ file: path.join(cc, 'claims.yaml') });
  let claimsList: unknown[] = [];
  try {
    const parsed: unknown = claimsText ? yaml.load(claimsText) : null;
    if (isObject(parsed) && Array.isArray(parsed.claims)) claimsList = parsed.claims;
  } catch {
    claimsList = [];
  }

  const runs = await readRuns({ runsDir: path.join(cc, 'runs') });
  const ledger = await readLedger({ file: path.join(cc, 'ledger.jsonl') });
  const appStateRaw = await readJson({ file: path.join(cc, 'app-state.json') });
  const appState: AppState = isObject(appStateRaw) && isObject(appStateRaw.claims) ? (appStateRaw as AppState) : { claims: {} };

  const claims: Claim[] = claimsList.filter(isObject).map((raw) => {
    const id = toStringOrEmpty({ value: raw.id });
    const files = toStringList({ value: raw.files }).map((filePath) => filePath.replace(/\\/g, '/'));
    const checkRun = runs.check.find((checkRun) => checkRun.verdicts.some((value) => value.id === id));
    const verdictRaw = checkRun?.verdicts.find((value) => value.id === id) ?? null;
    const verdict = verdictRaw && checkRun ? { ...verdictRaw, provider: checkRun.provider, model: checkRun.model, ts: checkRun.ts, runId: checkRun.run_id } : null;
    const mutateRun = runs.mutate.find((mutateRun) => Object.hasOwn(mutateRun.per_claim, id));
    const mutants = mutateRun ? mutateRun.mutants.filter((mutant) => files.includes(mutant.file)) : [];
    const mutation: MutationInfo | null = mutateRun ? { ...summarizeRun({ mutants }), mutants, ts: mutateRun.ts, runId: mutateRun.run_id } : null;
    const stateRaw = appState.claims[id];
    const state = isObject(stateRaw) ? stateRaw : {};
    const confidence = toFiniteNumber({ value: raw.confidence });
    const catchRate = mutation?.catchRate ?? null;
    const history = ledger.filter((line) => line.claim_id === id);
    const claimLines = history.filter((line) => line.type === 'claim');
    const outcomes = history.filter((line) => line.type === 'outcome');
    const newestOutcome = outcomes.toSorted((left, right) => (toStringOrEmpty({ value: left.ts }) < toStringOrEmpty({ value: right.ts }) ? -1 : 1)).at(-1) ?? null;

    let status: ClaimStatus = isStatus(state.status) ? state.status : (toStatusFromOutcome({ outcome: newestOutcome }) ?? 'open');
    const flags = readFlags({ confidence, verdict: verdict?.verdict, mutation, appConfig: config.app });
    // A fix that no longer holds: a later run flagged the claim again after it was resolved.
    let isReopened = false;
    if (status === 'resolved' && flags.length > 0) {
      const outcomeResolved = toStatusFromOutcome({ outcome: newestOutcome }) === 'resolved' && newestOutcome ? toStringOrEmpty({ value: newestOutcome.ts }) : '';
      const resolvedAt = [toStringOrEmpty({ value: state.status === 'resolved' ? state.updatedAt : '' }), outcomeResolved].toSorted().at(-1);
      if (resolvedAt && findNewestTimestamp({ records: claimLines }) > resolvedAt) {
        status = 'open';
        isReopened = true;
      }
    }
    return {
      id,
      claim: toStringOrEmpty({ value: raw.claim }),
      confidence,
      criteria: (Array.isArray(raw.criteria) ? raw.criteria : []).map((cid) => ({ id: Number(cid), text: criteriaText.get(Number(cid)) ?? '' })),
      files,
      killCondition: toStringOrEmpty({ value: raw.kill_condition }),
      verifiedBy: toStringList({ value: raw.verified_by }),
      verdict,
      mutation,
      status,
      reopened: isReopened,
      note: toStringOrEmpty({ value: state.note }),
      fix: isObject(state.fix) ? state.fix : null,
      history: history.slice(-HISTORY_LIMIT),
      risk: readRisk({ confidence, verdict: verdict?.verdict, catchRate }),
      flags,
    };
  });

  const timestamps = [...runs.check, ...runs.mutate].map((run) => run.ts).filter(Boolean).toSorted();
  const isLockOk = isLockMatching({ specText, specBytes, lock });
  const branch = await runGit({ repo, argList: ['rev-parse', '--abbrev-ref', 'HEAD'] });
  const remoteBranches = branch ? await runGit({ repo, argList: ['branch', '--remotes', '--contains', 'HEAD', '--list', `origin/${branch}`] }) : null;
  return {
    repo: {
      name: path.basename(repo),
      path: repo,
      origin: await runGit({ repo, argList: ['remote', 'get-url', 'origin'] }),
      branch,
      head: await runGit({ repo, argList: ['rev-parse', 'HEAD'] }),
      hasClaimcheck: configText !== null || claimsText !== null,
      lockOk: isLockOk,
      specState: toSpecState({ hasSpec: specText !== null, isLocked: Boolean(lock), lockOk: isLockOk }),
      lastRunTs: timestamps.at(-1) ?? null,
      isBranchPushed: Boolean(remoteBranches),
    },
    config,
    criteria,
    claims,
    queue: claims.filter((claim) => isInQueue({ claim })).toSorted((left, right) => right.risk - left.risk).map((claim) => claim.id),
    runs: { check: runs.check[0] ?? null, mutate: runs.mutate[0] ?? null },
    ledgerCount: ledger.length,
  };
};
