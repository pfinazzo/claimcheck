/**
 * The app's only writes into `.claimcheck/`: `outcome` lines on the ledger
 * (temp file first, then one append, like the CLI) and its own app-state.json.
 *
 * @author Patrick Finazzo
 */

import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, statSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { AppState, AppStateClaim, OutcomeRecord } from '../shared/types.ts';

export const OUTCOME_KEYS = ['v', 'type', 'ts', 'run_id', 'claim_id', 'outcome', 'outcome_source'] as const;
export const OUTCOMES = ['held', 'broken'] as const;
export const SOURCES = ['test_failure', 'revert', 'fix_commit', 'human'] as const;

export const utcNow = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

export type OutcomeInput = {
  runId?: string | null;
  claimId: string;
  outcome: OutcomeRecord['outcome'];
  source: OutcomeRecord['outcome_source'];
  evidence?: string;
  ts?: string;
};

const isOneOf = <T extends string>(allowed: readonly T[], value: unknown): value is T => (allowed as readonly unknown[]).includes(value);

const readTextField = (rec: Record<string, unknown>, key: string): string => {
  const value = rec[key];
  if (typeof value !== 'string') throw new Error(`${key} must be text`);
  return value;
};

/** Throws a plain message when a record would not be a valid outcome line. */
export const validateOutcome = (rec: Record<string, unknown>): OutcomeRecord => {
  for (const k of OUTCOME_KEYS) if (!(k in rec)) throw new Error(`outcome line missing ${k}`);
  if (rec.type !== 'outcome') throw new Error('type must be outcome');
  if (rec.v !== 1) throw new Error('v must be 1');
  const { outcome, outcome_source: source } = rec;
  if (!isOneOf(OUTCOMES, outcome)) throw new Error(`outcome must be one of ${OUTCOMES.join(',')}`);
  if (!isOneOf(SOURCES, source)) throw new Error(`outcome_source must be one of ${SOURCES.join(',')}`);
  return {
    ...rec,
    v: 1,
    type: 'outcome',
    ts: readTextField(rec, 'ts'),
    run_id: readTextField(rec, 'run_id'),
    claim_id: readTextField(rec, 'claim_id'),
    outcome,
    outcome_source: source,
    evidence: typeof rec.evidence === 'string' ? rec.evidence : '',
  };
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

// The ledger is a hash chain, the same one the CLI writes: each line carries `prev`, the SHA-256 of
// the previous line's text. The first chained line carries the hash of all older lines joined by
// newlines, or 64 zeros for an empty ledger. `claimcheck verify-ledger` checks it.
export const ZERO_HASH = '0'.repeat(64);

export const lineHash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Non-blank lines without their line breaks (a Windows checkout may end lines in CRLF). */
export const ledgerLines = (text: string): string[] => text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '');

const hasPrev = (text: string): boolean => {
  try {
    const obj: unknown = JSON.parse(text);
    return typeof obj === 'object' && obj !== null && !Array.isArray(obj) && (obj as Record<string, unknown>).prev != null;
  } catch {
    return false;
  }
};

/** The `prev` value the next line written must carry. */
export const chainHead = (lines: string[]): string => {
  const last = lines.at(-1);
  if (last === undefined) return ZERO_HASH;
  return hasPrev(last) ? lineHash(last) : lineHash(lines.join('\n'));
};

/** Writes the line to a temp file, then appends those bytes in one write. */
export const appendOutcome = (repoPath: string, rec: OutcomeRecord): string => {
  validateOutcome({ ...rec });
  const dir = path.join(repoPath, '.claimcheck');
  mkdirSync(dir, { recursive: true });
  const ledger = path.join(dir, 'ledger.jsonl');
  const tmp = path.join(dir, `.ledger-${process.pid}-${Date.now()}.tmp`);
  const prev = chainHead(ledgerLines(existsSync(ledger) ? readFileSync(ledger, 'utf8') : ''));
  const line = `${sortedJson({ ...rec, prev })}\n`;
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
    rmSync(tmp, { force: true });
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
