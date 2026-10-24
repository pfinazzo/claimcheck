/**
 * The app's only writes into `.claimcheck/`: `outcome` lines on the ledger
 * (temp file first, then one append, like the CLI) and its own app-state.json.
 *
 * @author Patrick Finazzo
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';

export const OUTCOME_KEYS = ['v', 'type', 'ts', 'run_id', 'claim_id', 'outcome', 'outcome_source'];
export const OUTCOMES = ['held', 'broken'];
export const SOURCES = ['test_failure', 'revert', 'fix_commit', 'human'];

export const utcNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

export const outcomeRecord = ({ runId, claimId, outcome, source, evidence, ts = utcNow() }) => {
  const rec = { v: 1, type: 'outcome', ts, run_id: runId ?? 'none', claim_id: claimId, outcome, outcome_source: source, evidence: evidence ?? '' };
  validateOutcome(rec);
  return rec;
};

export const validateOutcome = (rec) => {
  for (const k of OUTCOME_KEYS) if (!(k in rec)) throw new Error(`outcome line missing ${k}`);
  if (rec.type !== 'outcome') throw new Error('type must be outcome');
  if (!OUTCOMES.includes(rec.outcome)) throw new Error(`outcome must be one of ${OUTCOMES}`);
  if (!SOURCES.includes(rec.outcome_source)) throw new Error(`outcome_source must be one of ${SOURCES}`);
  return rec;
};

/** True when the file is non-empty and its last byte is not a newline (a torn last line). */
const lacksTrailingNewline = (file) => {
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

const sortedJson = (obj) => JSON.stringify(Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]])));

/** Writes the line to a temp file, then appends those bytes in one write. */
export const appendOutcome = (repoPath, rec) => {
  validateOutcome(rec);
  const dir = path.join(repoPath, '.claimcheck');
  mkdirSync(dir, { recursive: true });
  const ledger = path.join(dir, 'ledger.jsonl');
  const tmp = path.join(dir, `.ledger-${process.pid}-${Date.now()}.tmp`);
  const line = `${sortedJson(rec)}\n`;
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

const stateFile = (repoPath) => path.join(repoPath, '.claimcheck', 'app-state.json');

export const readAppState = (repoPath) => {
  try {
    const data = JSON.parse(readFileSync(stateFile(repoPath), 'utf8'));
    return data && typeof data === 'object' && data.claims ? data : { claims: {} };
  } catch {
    return { claims: {} };
  }
};

export const updateAppState = (repoPath, claimId, patch) => {
  const state = readAppState(repoPath);
  state.claims[claimId] = { ...(state.claims[claimId] ?? {}), ...patch, updatedAt: utcNow() };
  mkdirSync(path.dirname(stateFile(repoPath)), { recursive: true });
  writeFileSync(stateFile(repoPath), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return state.claims[claimId];
};
