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

export const formatUtcNow = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

export type OutcomeInput = {
  runId?: string | null;
  claimId: string;
  outcome: OutcomeRecord['outcome'];
  source: OutcomeRecord['outcome_source'];
  evidence?: string;
  ts?: string;
};

// A type guard must name the value it narrows, so it takes it positionally.
// eslint-disable-next-line no-restricted-syntax
const isOneOf = <T extends string>(allowed: readonly T[], value: unknown): value is T => (allowed as readonly unknown[]).includes(value);

const readTextField = ({ rec, key }: { rec: Record<string, unknown>; key: string }): string => {
  const value = rec[key];
  if (typeof value !== 'string') throw new Error(`${key} must be text`);
  return value;
};

/** Throws a plain message when a record would not be a valid outcome line. */
export const validateOutcome = ({ rec }: { rec: Record<string, unknown> }): OutcomeRecord => {
  for (const key of OUTCOME_KEYS) if (!(key in rec)) throw new Error(`outcome line missing ${key}`);
  if (rec.type !== 'outcome') throw new Error('type must be outcome');
  if (rec.v !== 1) throw new Error('v must be 1');
  const { outcome, outcome_source: source } = rec;
  if (!isOneOf(OUTCOMES, outcome)) throw new Error(`outcome must be one of ${OUTCOMES.join(',')}`);
  if (!isOneOf(SOURCES, source)) throw new Error(`outcome_source must be one of ${SOURCES.join(',')}`);
  return {
    ...rec,
    v: 1,
    type: 'outcome',
    ts: readTextField({ rec, key: 'ts' }),
    run_id: readTextField({ rec, key: 'run_id' }),
    claim_id: readTextField({ rec, key: 'claim_id' }),
    outcome,
    outcome_source: source,
    evidence: typeof rec.evidence === 'string' ? rec.evidence : '',
  };
};

export const buildOutcomeRecord = ({ runId, claimId, outcome, source, evidence, ts: timestamp = formatUtcNow() }: OutcomeInput): OutcomeRecord =>
  validateOutcome({ rec: { v: 1, type: 'outcome', ts: timestamp, run_id: runId ?? 'none', claim_id: claimId, outcome, outcome_source: source, evidence: evidence ?? '' } });

/** True when the file is non-empty and its last byte is not a newline (a torn last line). */
const isMissingTrailingNewline = ({ file }: { file: string }): boolean => {
  if (!existsSync(file)) return false;
  const size = statSync(file).size;
  if (size === 0) return false;
  const descriptor = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1);
    readSync(descriptor, buffer, 0, 1, size - 1);
    return buffer[0] !== 0x0a;
  } finally {
    closeSync(descriptor);
  }
};

const sortedJson = ({ record }: { record: Record<string, unknown> }): string => JSON.stringify(Object.fromEntries(Object.keys(record).toSorted().map((key) => [key, record[key]])));

// The ledger is a hash chain, the same one the CLI writes: each line carries `prev`, the SHA-256 of
// the previous line's text. The first chained line carries the hash of all older lines joined by
// newlines, or 64 zeros for an empty ledger. `claimcheck verify-ledger` checks it.
export const ZERO_HASH = '0'.repeat(64);

export const hashLine = ({ text }: { text: string }): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Non-blank lines without their line breaks (a Windows checkout may end lines in CRLF). */
export const readLedgerLines = ({ text }: { text: string }): string[] => text.split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line.trim() !== '');

const hasPrev = ({ text }: { text: string }): boolean => {
  try {
    const record: unknown = JSON.parse(text);
    return typeof record === 'object' && record !== null && !Array.isArray(record) && (record as Record<string, unknown>).prev != null;
  } catch {
    return false;
  }
};

/** The `prev` value the next line written must carry. */
export const findChainHead = ({ lines }: { lines: readonly string[] }): string => {
  const last = lines.at(-1);
  if (last === undefined) return ZERO_HASH;
  return hasPrev({ text: last }) ? hashLine({ text: last }) : hashLine({ text: lines.join('\n') });
};

/** Writes the line to a temp file, then appends those bytes in one write. */
export const appendOutcome = ({ repoPath, rec }: { repoPath: string; rec: OutcomeRecord }): string => {
  validateOutcome({ rec: { ...rec } });
  const dir = path.join(repoPath, '.claimcheck');
  mkdirSync(dir, { recursive: true });
  const ledger = path.join(dir, 'ledger.jsonl');
  const scratch = path.join(dir, `.ledger-${process.pid}-${Date.now()}.tmp`);
  const prev = findChainHead({ lines: readLedgerLines({ text: existsSync(ledger) ? readFileSync(ledger, 'utf8') : '' }) });
  const line = `${sortedJson({ record: { ...rec, prev } })}\n`;
  // A ledger whose last line lost its newline would fuse with ours and make both unreadable.
  const prefix = isMissingTrailingNewline({ file: ledger }) ? '\n' : '';
  writeFileSync(scratch, prefix + line, 'utf8');
  try {
    const payload = readFileSync(scratch);
    const descriptor = openSync(ledger, 'a');
    try {
      writeSync(descriptor, payload);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } finally {
    rmSync(scratch, { force: true });
  }
  return line;
};

const resolveStateFile = ({ repoPath }: { repoPath: string }): string => path.join(repoPath, '.claimcheck', 'app-state.json');

export const readAppState = ({ repoPath }: { repoPath: string }): AppState => {
  try {
    const payload: unknown = JSON.parse(readFileSync(resolveStateFile({ repoPath }), 'utf8'));
    if (payload && typeof payload === 'object' && 'claims' in payload && payload.claims && typeof payload.claims === 'object') return payload as AppState;
    return { claims: {} };
  } catch {
    return { claims: {} };
  }
};

export const updateAppState = ({ repoPath, claimId, patch }: { repoPath: string; claimId: string; patch: AppStateClaim }): AppStateClaim => {
  const state = readAppState({ repoPath });
  const next: AppStateClaim = { ...(state.claims[claimId] ?? {}), ...patch, updatedAt: formatUtcNow() };
  state.claims[claimId] = next;
  mkdirSync(path.dirname(resolveStateFile({ repoPath })), { recursive: true });
  writeFileSync(resolveStateFile({ repoPath }), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return next;
};
