/**
 * The app's only writes into `.claimcheck/`: `outcome` lines on the ledger
 * (temp file first, then one append, like the CLI) and its own app-state.json.
 *
 * @author Patrick Finazzo
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { AppState, AppStateClaim, OutcomeRecord } from '../shared/types.ts';

export const OUTCOME_KEYS = ['v', 'type', 'ts', 'run_id', 'claim_id', 'outcome', 'outcome_source'] as const;
export const OUTCOMES = ['held', 'broken'] as const;
export const SOURCES = ['test_failure', 'revert', 'fix_commit', 'human'] as const;

export const utcNow = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

export interface OutcomeInput {
  runId?: string | null;
  claimId: string;
  outcome: OutcomeRecord['outcome'];
  source: OutcomeRecord['outcome_source'];
  evidence?: string;
  ts?: string;
}

/** Throws a plain message when a record would not be a valid outcome line. */
export const validateOutcome = (rec: Record<string, unknown>): OutcomeRecord => {
  for (const k of OUTCOME_KEYS) if (!(k in rec)) throw new Error(`outcome line missing ${k}`);
  if (rec.type !== 'outcome') throw new Error('type must be outcome');
  if (!(OUTCOMES as readonly unknown[]).includes(rec.outcome)) throw new Error(`outcome must be one of ${OUTCOMES.join(',')}`);
  if (!(SOURCES as readonly unknown[]).includes(rec.outcome_source)) throw new Error(`outcome_source must be one of ${SOURCES.join(',')}`);
  return rec as unknown as OutcomeRecord;
};

export const outcomeRecord = ({ runId, claimId, outcome, source, evidence, ts = utcNow() }: OutcomeInput): OutcomeRecord =>
  validateOutcome({ v: 1, type: 'outcome', ts, run_id: runId ?? 'none', claim_id: claimId, outcome, outcome_source: source, evidence: evidence ?? '' });

/** True when the file is non-empty and its last byte is not a newline (a torn last line). */
const lacksTrailingNewline = (file: string): boolean => {
  if (!existsSync(file)) return false;
  const size = statSync(file).size;
  if (size === 0) return false;
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, size - 1);
    return buf[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
};

const sortedJson = (obj: Record<string, unknown>): string => JSON.stringify(Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]])));

/** Writes the line to a temp file, then appends those bytes in one write. */
export const appendOutcome = (repoPath: string, rec: OutcomeRecord): string => {
  validateOutcome({ ...rec });
  const dir = path.join(repoPath, '.claimcheck');
  mkdirSync(dir, { recursive: true });
  const ledger = path.join(dir, 'ledger.jsonl');
  const tmp = path.join(dir, `.ledger-${process.pid}-${Date.now()}.tmp`);
  const line = `${sortedJson({ ...rec })}\n`;
  // A ledger whose last line lost its newline would fuse with ours and make both unreadable.
  const prefix = lacksTrailingNewline(ledger) ? '\n' : '';
  writeFileSync(tmp, prefix + line, 'utf8');
  try {
    const data = readFileSync(tmp);
    const fd = openSync(ledger, 'a');
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
  }
  return line;
};

const stateFile = (repoPath: string): string => path.join(repoPath, '.claimcheck', 'app-state.json');

export const readAppState = (repoPath: string): AppState => {
  try {
    const data: unknown = JSON.parse(readFileSync(stateFile(repoPath), 'utf8'));
    if (data && typeof data === 'object' && 'claims' in data && data.claims && typeof data.claims === 'object') return data as AppState;
    return { claims: {} };
  } catch {
    return { claims: {} };
  }
};

export const updateAppState = (repoPath: string, claimId: string, patch: AppStateClaim): AppStateClaim => {
  const state = readAppState(repoPath);
  const next: AppStateClaim = { ...(state.claims[claimId] ?? {}), ...patch, updatedAt: utcNow() };
  state.claims[claimId] = next;
  mkdirSync(path.dirname(stateFile(repoPath)), { recursive: true });
  writeFileSync(stateFile(repoPath), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return next;
};
