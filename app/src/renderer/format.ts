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

export const formatPercent = ({ x }: { x: number | null | undefined }): string => (x === null || x === undefined ? 'n/a' : `${Math.round(x * 100)}%`);

export const formatPlural = ({ count, one, many = `${one}s` }: { count: number; one: string; many?: string }): string => `${count} ${count === 1 ? one : many}`;

const VERDICT_WORD = new Map<unknown, string>([
  ['SUPPORTED', 'supported'],
  ['REFUTED', 'refuted'],
  ['UNVERIFIABLE', 'unverifiable'],
]);

export const formatVerdictWord = ({ claim }: { claim: Pick<Claim, 'verdict'> }): string => {
  const value = claim.verdict?.verdict;
  return VERDICT_WORD.get(value) ?? 'not checked';
};

export const formatCaughtWords = ({ claim }: { claim: Pick<Claim, 'mutation'> }): string => {
  const mutation = claim.mutation;
  if (!mutation || mutation.total === 0) return 'no planted bugs run';
  return `tests caught ${mutation.killed + mutation.timeout} of ${mutation.total} planted bugs`;
};

/** One muted line under a claim: what the author said, what the checker said, what the tests did. */
export const formatFactsLine = ({ claim }: { claim: Claim }): string => {
  const stated = claim.confidence === null ? 'Confidence not stated' : `Stated ${claim.confidence.toFixed(2)}`;
  return `${stated}. Checker: ${formatVerdictWord({ claim })}. ${formatCaughtWords({ claim }).replace(/^./, (text) => text.toUpperCase())}.`;
};

export const isDecisionNeeded = ({ board, claim }: { board: Board; claim: Claim }): boolean => board.queue.includes(claim.id);

export type Groups = {
  needs: readonly Claim[];
  backed: readonly Claim[];
};

/** The decision queue in risk order, then everything else in file order. */
export const collectClaimGroups = ({ board }: { board: Board }): Groups => {
  const byId = new Map(board.claims.map((claim) => [claim.id, claim]));
  const needs = board.queue.map((id) => byId.get(id)).filter((claim): claim is Claim => claim !== undefined);
  const backed = board.claims.filter((claim) => !board.queue.includes(claim.id));
  return { needs, backed };
};

/** "none need a decision", "1 needs a decision", "3 need a decision". */
const describeNeeds = ({ needs }: { needs: number }): string => {
  if (needs === 0) return 'none need a decision';
  return `${needs} ${needs === 1 ? 'needs' : 'need'} a decision`;
};

export const formatSummaryLine = ({ board }: { board: Board }): string => {
  const count = board.claims.length;
  if (count === 0) return 'No claims yet.';
  const needs = board.queue.length;
  const head = `${formatPlural({ count, one: 'claim' })}, ${describeNeeds({ needs })}.`;
  // Claims that list the same file carry the same planted bugs, so count each bug once per run.
  const bugs = new Map<string, boolean>(
    board.claims.flatMap((claim) =>
      (claim.mutation?.mutants ?? [])
        .filter((mutant) => mutant.outcome === 'killed' || mutant.outcome === 'timeout' || mutant.outcome === 'survived')
        .map((mutant): [string, boolean] => [JSON.stringify([claim.mutation?.runId ?? '', mutant.file, mutant.line_no, mutant.cls, mutant.mutated]), mutant.outcome !== 'survived']),
    ),
  );
  const total = bugs.size;
  const caught = [...bugs.values()].filter(Boolean).length;
  return total === 0 ? head : `${head} ${caught} of ${total} planted bugs caught.`;
};

const SPEC_WORD: Record<Board['repo']['specState'], string> = {
  frozen: 'Spec frozen',
  drifted: 'Spec changed since it was frozen',
  draft: 'Spec not frozen yet',
  none: 'No spec yet',
};

export const formatSpecWord = ({ state }: { state: Board['repo']['specState'] }): string => SPEC_WORD[state];

export const formatShortHash = ({ height }: { height: string | null | undefined }): string => (height ? height.slice(0, 12) : '');
