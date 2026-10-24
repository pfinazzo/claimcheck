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
import { parseToml } from './toml.mjs';

const execFileP = promisify(execFile);

export const CC = '.claimcheck';
export const STATUSES = ['open', 'fixing', 'resolved', 'accepted'];
export const HISTORY_LIMIT = 50;
const MUTANT_LIMIT = 1000;
const CRITERION_RE = /^- \[[ xX]\] (\d+)\. (.+)$/;
const VERDICT_WEIGHT = { REFUTED: 1.0, UNVERIFIABLE: 0.5, SUPPORTED: 0.0 };

export const APP_DEFAULTS = { flagConfidence: 0.75, flagCatchRate: 0.8, python: null };

/** A git ref that cannot be read as an option: no leading dash, no odd characters. */
export const SAFE_REF = /^(?!-)[\w./-]+$/;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const str = (v, fallback = '') => (typeof v === 'string' ? v : v === null || v === undefined ? fallback : String(v));
const strList = (v) => (Array.isArray(v) ? v : v === null || v === undefined ? [] : [v]).map((x) => str(x));
const finite = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const readText = async (file) => {
  try {
    return (await fs.readFile(file, 'utf8')).replace(/^﻿/, '');
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

/** AC 5: the number the queue sorts by. A missing confidence counts as 0, a verdict nobody knows as 0.75. */
export const riskOf = ({ confidence, verdict, catchRate }) => {
  const verdictWeight = typeof verdict === 'string' && Object.hasOwn(VERDICT_WEIGHT, verdict) ? VERDICT_WEIGHT[verdict] : 0.75;
  const conf = Number.isFinite(confidence) ? confidence : 0;
  const rate = Number.isFinite(catchRate) ? catchRate : 0;
  return Number(((1 - conf) * 0.4 + verdictWeight * 0.4 + (1 - rate) * 0.2).toFixed(4));
};

/** AC 6: why a claim needs a decision. A confidence that is missing or not a number counts as unsure. */
export const flagsOf = ({ confidence, verdict, mutation }, appConfig = APP_DEFAULTS) => {
  const flags = [];
  if (!Number.isFinite(confidence) || confidence < appConfig.flagConfidence) flags.push('low-confidence');
  if (verdict === 'REFUTED') flags.push('refuted');
  if (verdict !== 'SUPPORTED' && verdict !== 'REFUTED') flags.push('unverified');
  const total = mutation?.total ?? 0;
  const rate = mutation?.catchRate;
  if (total > 0 && (rate === null || rate === undefined || rate < appConfig.flagCatchRate)) flags.push('weak-tests');
  if (total === 0) flags.push('no-mutants');
  return flags;
};

export const inQueue = (claim) => claim.flags.length > 0 && (claim.status === 'open' || claim.status === 'fixing');

const runSortKey = (run) => `${str(run.ts)}|${str(run.run_id)}`;

const cleanVerdict = (v) => ({
  id: str(v.id),
  verdict: str(v.verdict),
  reason: str(v.reason),
  evidence: strList(v.evidence),
});

const cleanMutant = (m) => ({
  file: str(m.file),
  line_no: finite(m.line_no),
  cls: str(m.cls),
  original: str(m.original),
  mutated: str(m.mutated),
  outcome: str(m.outcome),
});

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
    if (!isObject(data)) continue;
    const base = { file: name, run_id: str(data.run_id), ts: str(data.ts) };
    if (name.endsWith('-check.json')) {
      check.push({
        ...base,
        provider: str(data.provider),
        model: data.model === null || data.model === undefined ? null : str(data.model),
        verdicts: (Array.isArray(data.verdicts) ? data.verdicts : []).filter(isObject).map(cleanVerdict),
      });
    } else if (name.endsWith('-mutate.json')) {
      mutate.push({
        ...base,
        mutants: (Array.isArray(data.mutants) ? data.mutants : []).filter(isObject).slice(0, MUTANT_LIMIT).map(cleanMutant),
        per_claim: isObject(data.per_claim) ? data.per_claim : {},
      });
    }
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
      const rec = JSON.parse(line);
      if (isObject(rec)) out.push(rec);
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

/** What a newest ledger outcome line says about a claim when app-state.json is missing (a fresh clone). */
const statusFromOutcome = (outcome) => {
  if (!outcome) return null;
  if (outcome.outcome === 'broken' && outcome.outcome_source === 'fix_commit') return 'resolved';
  if (outcome.outcome === 'held' && outcome.outcome_source === 'human') return 'accepted';
  return null;
};

const newestTs = (records) => records.map((r) => str(r.ts)).filter(Boolean).sort().at(-1) ?? '';

/** The whole board for one repo (AC 4). */
export const readBoard = async (repoPath) => {
  const repo = path.resolve(repoPath);
  const cc = path.join(repo, CC);
  const configText = await readText(path.join(cc, 'config.toml'));
  const configRaw = configText ? parseToml(configText) : {};
  const baseRaw = str(configRaw.base, 'main');
  const config = {
    base: SAFE_REF.test(baseRaw) ? baseRaw : 'main',
    test_cmd: typeof configRaw.test_cmd === 'string' && configRaw.test_cmd.trim() ? configRaw.test_cmd : 'python -m pytest -q',
    ignore: strList(configRaw.ignore),
    checker: { provider: str(configRaw.checker?.provider, 'claude'), model: str(configRaw.checker?.model, 'claude-opus-5-5') },
    app: { ...APP_DEFAULTS, ...(isObject(configRaw.app) ? configRaw.app : {}) },
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
  const appStateRaw = await readJson(path.join(cc, 'app-state.json'));
  const appState = isObject(appStateRaw) && isObject(appStateRaw.claims) ? appStateRaw : { claims: {} };

  const claims = (Array.isArray(claimsRaw?.claims) ? claimsRaw.claims : []).filter(isObject).map((raw) => {
    const id = str(raw.id);
    const files = strList(raw.files).map((f) => f.replace(/\\/g, '/'));
    const checkRun = runs.check.find((r) => r.verdicts.some((v) => v.id === id));
    const verdictRaw = checkRun?.verdicts.find((v) => v.id === id) ?? null;
    const verdict = verdictRaw ? { ...verdictRaw, provider: checkRun.provider, model: checkRun.model, ts: checkRun.ts, runId: checkRun.run_id } : null;
    const mutateRun = runs.mutate.find((r) => Object.hasOwn(r.per_claim, id));
    const mutants = mutateRun ? mutateRun.mutants.filter((m) => files.includes(m.file)) : [];
    const mutation = mutateRun ? { ...summarise(mutants), mutants, ts: mutateRun.ts, runId: mutateRun.run_id } : null;
    const state = isObject(appState.claims[id]) ? appState.claims[id] : {};
    const confidence = finite(raw.confidence);
    const catchRate = mutation?.catchRate ?? null;
    const history = ledger.filter((l) => l.claim_id === id);
    const claimLines = history.filter((l) => l.type === 'claim');
    const outcomes = history.filter((l) => l.type === 'outcome');
    const newestOutcome = [...outcomes].sort((a, b) => (str(a.ts) < str(b.ts) ? -1 : 1)).at(-1) ?? null;

    let status = STATUSES.includes(state.status) ? state.status : (statusFromOutcome(newestOutcome) ?? 'open');
    const flags = flagsOf({ confidence, verdict: verdict?.verdict, mutation }, config.app);
    // A fix that no longer holds: a later run flagged the claim again after it was resolved.
    let reopened = false;
    if (status === 'resolved' && flags.length > 0) {
      const resolvedAt = [str(state.status === 'resolved' ? state.updatedAt : ''), str(statusFromOutcome(newestOutcome) === 'resolved' ? newestOutcome.ts : '')].sort().at(-1);
      if (resolvedAt && newestTs(claimLines) > resolvedAt) {
        status = 'open';
        reopened = true;
      }
    }
    return {
      id,
      claim: str(raw.claim),
      confidence,
      criteria: (Array.isArray(raw.criteria) ? raw.criteria : []).map((cid) => ({ id: Number(cid), text: criteriaText.get(Number(cid)) ?? '' })),
      files,
      killCondition: str(raw.kill_condition),
      verifiedBy: strList(raw.verified_by),
      verdict,
      mutation,
      status,
      reopened,
      note: str(state.note),
      fix: isObject(state.fix) ? state.fix : null,
      history: history.slice(-HISTORY_LIMIT),
      risk: riskOf({ confidence: confidence ?? undefined, verdict: verdict?.verdict, catchRate }),
      flags,
    };
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
      specState: specText === null ? 'none' : lock ? (lockMatches({ specText, specBytes, lock }) ? 'frozen' : 'drifted') : 'draft',
      lastRunTs: timestamps.at(-1) ?? null,
    },
    config,
    criteria,
    claims,
    queue: claims.filter(inQueue).sort((a, b) => b.risk - a.risk).map((c) => c.id),
    runs: { check: runs.check[0] ?? null, mutate: runs.mutate[0] ?? null },
    ledgerCount: ledger.length,
  };
};
