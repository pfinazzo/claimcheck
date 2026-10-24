/**
 * Plain-language formatting for the board. Pure functions of the board model, so they are tested
 * without a page.
 *
 * @author Patrick Finazzo
 */

import type { Board, Claim } from '../shared/types.ts';

export const FLAG_TEXT: Record<string, string> = {
  'low-confidence': 'The author was not sure.',
  refuted: 'The independent check disagreed.',
  unverified: 'Nobody has checked this claim yet.',
  'weak-tests': 'Planted bugs got past the tests.',
  'no-mutants': 'There was nothing to plant a bug into.',
};

export const pct = (x: number | null | undefined): string => (x === null || x === undefined ? 'n/a' : `${Math.round(x * 100)}%`);

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export const verdictWord = (claim: Pick<Claim, 'verdict'>): string => {
  const v = claim.verdict?.verdict;
  return v === 'SUPPORTED' ? 'supported' : v === 'REFUTED' ? 'refuted' : v === 'UNVERIFIABLE' ? 'unverifiable' : 'not checked';
};

export const caughtWords = (claim: Pick<Claim, 'mutation'>): string => {
  const m = claim.mutation;
  if (!m || m.total === 0) return 'no planted bugs run';
  return `tests caught ${m.killed + m.timeout} of ${m.total} planted bugs`;
};

/** One muted line under a claim: what the author said, what the checker said, what the tests did. */
export const factsLine = (claim: Claim): string => {
  const stated = claim.confidence === null ? 'Confidence not stated' : `Stated ${claim.confidence.toFixed(2)}`;
  return `${stated}. Checker: ${verdictWord(claim)}. ${caughtWords(claim).replace(/^./, (c) => c.toUpperCase())}.`;
};

export const needsDecision = (board: Board, claim: Claim): boolean => board.queue.includes(claim.id);

export interface Groups {
  needs: Claim[];
  backed: Claim[];
}

/** The decision queue in risk order, then everything else in file order. */
export const groupClaims = (board: Board): Groups => {
  const byId = new Map(board.claims.map((c) => [c.id, c]));
  const needs = board.queue.map((id) => byId.get(id)).filter((c): c is Claim => c !== undefined);
  const backed = board.claims.filter((c) => !board.queue.includes(c.id));
  return { needs, backed };
};

export const summaryLine = (board: Board): string => {
  const n = board.claims.length;
  if (n === 0) return 'No claims yet.';
  const needs = board.queue.length;
  const head = `${plural(n, 'claim')}, ${needs === 0 ? 'none need a decision' : `${needs} ${needs === 1 ? 'needs' : 'need'} a decision`}.`;
  let caught = 0;
  let total = 0;
  for (const c of board.claims) {
    if (c.mutation && c.mutation.total > 0) {
      caught += c.mutation.killed + c.mutation.timeout;
      total += c.mutation.total;
    }
  }
  return total === 0 ? head : `${head} ${caught} of ${total} planted bugs caught.`;
};

export const specWord = (state: Board['repo']['specState']): string =>
  state === 'frozen' ? 'Spec frozen' : state === 'drifted' ? 'Spec changed since it was frozen' : state === 'draft' ? 'Spec not frozen yet' : 'No spec yet';

export const shortHash = (h: string | null | undefined): string => (h ? h.slice(0, 12) : '');
