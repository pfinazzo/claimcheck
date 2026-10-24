/**
 * Reads a repo's `.claimcheck/` folder into one board model: every claim with
 * the newest verdict and mutation result beside its stated confidence, plus
 * the risk score and flags that decide what lands in the decision queue.
 *
 * @author Patrick Finazzo
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import yaml from 'js-yaml';
import { parseToml } from './toml.mjs';

const execFileP = promisify(execFile);

export const CC = '.claimcheck';
export const STATUSES = ['open', 'fixing', 'resolved', 'accepted'];
const CRITERION_RE = /^- \[[ xX]\] (\d+)\. (.+)$/;
const VERDICT_WEIGHT = { REFUTED: 1.0, UNVERIFIABLE: 0.5, SUPPORTED: 0.0 };

export const APP_DEFAULTS = { flagConfidence: 0.75, flagCatchRate: 0.8, python: null };

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const readText = async (file) => {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
};

const readJson = async (file) => {
  const text = await readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const git = async (repo, args) => {
  try {
    const { stdout } = await execFileP('git', args, { cwd: repo, windowsHide: true });
    return stdout.trim();
  } catch {
    return null;
  }
};

/** Criteria from spec.md, the same regex the CLI uses. */
export const parseCriteria = (text) =>
  (text ?? '')
    .split(/\r?\n/)
    .map((line) => line.match(CRITERION_RE))
    .filter(Boolean)
    .map((m) => ({ id: Number(m[1]), text: m[2] }));

/** True when every criterion hash and the file hash match the lock, as `claimcheck spec verify` checks. */
export const lockMatches = ({ specText, specBytes, lock }) => {
  if (!lock || specText === null) return false;
  const current = new Map(parseCriteria(specText).map((c) => [c.id, sha256(c.text.trim())]));
  const locked = new Map((lock.criteria ?? []).map((c) => [Number(c.id), c.sha256]));
  if (current.size !== locked.size) return false;
  for (const [id, hash] of current) if (locked.get(id) !== hash) return false;
  return sha256(specBytes) === lock.spec_sha256;
};

/** AC 5: the number the queue sorts by. */
export const riskOf = ({ confidence, verdict, catchRate }) => {
  const verdictWeight = verdict in VERDICT_WEIGHT ? VERDICT_WEIGHT[verdict] : 0.75;
  const conf = Number.isFinite(confidence) ? confidence : 0;
  const rate = Number.isFinite(catchRate) ? catchRate : 0;
  return Number(((1 - conf) * 0.4 + verdictWeight * 0.4 + (1 - rate) * 0.2).toFixed(4));
};

/** AC 6: why a claim needs a decision. */
export const flagsOf = ({ confidence, verdict, mutation }, appConfig = APP_DEFAULTS) => {
  const flags = [];
  if (confidence < appConfig.flagConfidence) flags.push('low-confidence');
  if (verdict === 'REFUTED') flags.push('refuted');
  if (verdict === 'UNVERIFIABLE' || !verdict) flags.push('unverified');
  const total = mutation?.total ?? 0;
  const rate = mutation?.catchRate;
  if (total > 0 && (rate === null || rate === undefined || rate < appConfig.flagCatchRate)) flags.push('weak-tests');
  if (total === 0) flags.push('no-mutants');
  return flags;
};

export const inQueue = (claim) => claim.flags.length > 0 && (claim.status === 'open' || claim.status === 'fixing');

const runSortKey = (run) => `${run.ts ?? ''}|${run.run_id ?? ''}`;

const readRuns = async (runsDir) => {
  let names = [];
  try {
    names = await fs.readdir(runsDir);
  } catch {
    return { check: [], mutate: [] };
  }
  const check = [];
  const mutate = [];
  for (const name of names) {
    const data = await readJson(path.join(runsDir, name));
    if (!data) continue;
    if (name.endsWith('-check.json')) check.push({ file: name, ...data });
    else if (name.endsWith('-mutate.json')) mutate.push({ file: name, ...data });
  }
  const newestFirst = (a, b) => (runSortKey(a) < runSortKey(b) ? 1 : -1);
  check.sort(newestFirst);
  mutate.sort(newestFirst);
  return { check, mutate };
};

const readLedger = async (file) => {
  const text = await readText(file);
  if (!text) return [];
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a torn or foreign line is skipped, never fatal */
    }
  }
  return out;
};

const summarise = (mutants) => {
  const killed = mutants.filter((m) => m.outcome === 'killed').length;
  const survived = mutants.filter((m) => m.outcome === 'survived').length;
  const timeout = mutants.filter((m) => m.outcome === 'timeout').length;
  const total = killed + survived + timeout;
  return { total, killed, survived, timeout, catchRate: total ? Number(((killed + timeout) / total).toFixed(4)) : null };
};

/** The whole board for one repo (AC 4). */
export const readBoard = async (repoPath) => {
  const repo = path.resolve(repoPath);
  const cc = path.join(repo, CC);
  const configText = await readText(path.join(cc, 'config.toml'));
  const configRaw = configText ? parseToml(configText) : {};
  const config = {
    base: configRaw.base ?? 'main',
    test_cmd: configRaw.test_cmd ?? 'python -m pytest -q',
    ignore: configRaw.ignore ?? [],
    checker: { provider: configRaw.checker?.provider ?? 'claude', model: configRaw.checker?.model ?? 'claude-opus-5-5' },
    app: { ...APP_DEFAULTS, ...(configRaw.app ?? {}) },
  };

  const specText = await readText(path.join(cc, 'spec.md'));
  const specBytes = specText === null ? null : await fs.readFile(path.join(cc, 'spec.md'));
  const lock = await readJson(path.join(cc, 'spec.lock'));
  const criteria = parseCriteria(specText);
  const criteriaText = new Map(criteria.map((c) => [c.id, c.text]));

  const claimsText = await readText(path.join(cc, 'claims.yaml'));
  let claimsRaw = { claims: [] };
  try {
    claimsRaw = (claimsText && yaml.load(claimsText)) || { claims: [] };
  } catch {
    claimsRaw = { claims: [] };
  }

  const runs = await readRuns(path.join(cc, 'runs'));
  const ledger = await readLedger(path.join(cc, 'ledger.jsonl'));
  const appState = (await readJson(path.join(cc, 'app-state.json'))) ?? { claims: {} };

  const claims = (Array.isArray(claimsRaw.claims) ? claimsRaw.claims : []).map((raw) => {
    const id = String(raw.id ?? '');
    const files = (raw.files ?? []).map((f) => String(f).replace(/\\/g, '/'));
    const checkRun = runs.check.find((r) => (r.verdicts ?? []).some((v) => v.id === id));
    const verdictRaw = checkRun?.verdicts.find((v) => v.id === id) ?? null;
    const verdict = verdictRaw
      ? { ...verdictRaw, provider: checkRun.provider, model: checkRun.model, ts: checkRun.ts, runId: checkRun.run_id }
      : null;
    const mutateRun = runs.mutate.find((r) => r.per_claim && id in r.per_claim);
    const mutants = mutateRun ? (mutateRun.mutants ?? []).filter((m) => files.includes(m.file)) : [];
    const mutation = mutateRun ? { ...summarise(mutants), mutants, ts: mutateRun.ts, runId: mutateRun.run_id } : null;
    const state = appState.claims?.[id] ?? {};
    const confidence = Number(raw.confidence);
    const catchRate = mutation?.catchRate ?? null;
    const base = {
      id,
      claim: String(raw.claim ?? ''),
      confidence,
      criteria: (raw.criteria ?? []).map((cid) => ({ id: Number(cid), text: criteriaText.get(Number(cid)) ?? '' })),
      files,
      killCondition: String(raw.kill_condition ?? ''),
      verifiedBy: raw.verified_by ?? [],
      verdict,
      mutation,
      status: STATUSES.includes(state.status) ? state.status : 'open',
      note: state.note ?? '',
      fix: state.fix ?? null,
      history: ledger.filter((l) => l.claim_id === id),
      risk: riskOf({ confidence, verdict: verdict?.verdict, catchRate }),
    };
    return { ...base, flags: flagsOf({ confidence, verdict: verdict?.verdict, mutation }, config.app) };
  });

  const timestamps = [...runs.check, ...runs.mutate].map((r) => r.ts).filter(Boolean).sort();
  return {
    repo: {
      name: path.basename(repo),
      path: repo,
      origin: await git(repo, ['remote', 'get-url', 'origin']),
      branch: await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']),
      head: await git(repo, ['rev-parse', 'HEAD']),
      hasClaimcheck: configText !== null || claimsText !== null,
      lockOk: lockMatches({ specText, specBytes, lock }),
      lastRunTs: timestamps.at(-1) ?? null,
    },
    config,
    criteria,
    claims,
    queue: claims.filter(inQueue).sort((a, b) => b.risk - a.risk).map((c) => c.id),
    runs: { check: runs.check[0] ?? null, mutate: runs.mutate[0] ?? null },
    ledger,
  };
};
