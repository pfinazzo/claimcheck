/**
 * Why this file exists: the confidence map is a 3D chart that plots every claim by the three checks
 * claimcheck runs: what the author said (stated confidence), what the tests proved (the share of
 * planted bugs they caught) and what the independent checker decided (its verdict). Where a claim
 * lands, and whether it falls in a red flag area, is decided here in plain code so the page and the
 * tests agree, and so the Three.js scene only has to draw what it is given.
 *
 * @author Patrick Finazzo
 */

import type { Board } from './types.ts';

/** The drawn box in map units. The margin past 0 and 1 holds the "not measured" gutters. */
export const MAP_BOUNDS = { minX: -0.2, maxX: 1.06, minY: -0.2, maxY: 1.06, minZ: -0.2, maxZ: 1.06 } as const;

/** Where a claim with no number is drawn: in the gutter just before 0 on that axis. */
export const GUTTER = -0.1;

/**
 * The checker's verdict as a height on the third axis. A claim nobody has checked has no verdict, so
 * it sits in the gutter like a missing number on the other axes.
 */
export const CHECKER_LEVELS: ReadonlyMap<string, number> = new Map([
  ['refuted', 0],
  ['unverifiable', 0.5],
  ['supported', 1],
]);

/**
 * Below this checker level a claim is flagged, and at or above it the checker is satisfied. The board
 * flags a claim unless the checker said SUPPORTED, so refuted, unverifiable and not checked are all below it.
 */
export const CHECKER_FLAG_LINE = 0.75;

export type MapPoint = {
  id: string;
  title: string;
  /** What the author stated, 0 to 1, or null when none was stated. */
  confidence: number | null;
  /** The share of planted bugs the tests caught, 0 to 1, or null when no run covers the claim. */
  catchRate: number | null;
  /** The checker's word, lower case, or "not checked". */
  verdict: string;
  needsDecision: boolean;
  isSettled: boolean;
  isRefuted: boolean;
  /** Where the point is drawn, after the gutters and after nearby points are spread apart. */
  x: number;
  y: number;
  /** The checker's verdict as a height, or the gutter when nobody has checked the claim. */
  z: number;
};

export type ConfidenceMap = {
  points: readonly MapPoint[];
  /** Below this stated confidence a claim is flagged. */
  flagConfidence: number;
  /** Below this catch rate a claim is flagged. */
  flagCatchRate: number;
  /** Below this checker level a claim is flagged. */
  flagChecker: number;
  /** Changes whenever anything the map draws changes, so the page can skip a redraw. */
  signature: string;
};

const CELL = 0.02;
const SPREAD_STEP = 0.016;
const GOLDEN_ANGLE = 2.399963;
const EDGE_MARGIN = 0.02;

const clampTo = ({ value, low, high }: { value: number; low: number; high: number }): number => Math.min(high, Math.max(low, value));

const toCellKey = ({ point }: { point: MapPoint }): string => `${Math.round(point.x / CELL)}:${Math.round(point.y / CELL)}:${Math.round(point.z / CELL)}`;

/**
 * Claims with the same numbers would sit on one spot and hide each other. The first keeps the
 * spot and the rest fan out around it in a fixed pattern, so the picture is the same every time.
 */
const splitOverlappingPoints = ({ points }: { points: readonly MapPoint[] }): MapPoint[] => {
  const seen = new Map<string, number>();
  return points.map((point) => {
    const key = toCellKey({ point });
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    if (nth === 0) return point;
    const radius = SPREAD_STEP * Math.ceil(Math.sqrt(nth));
    const angle = nth * GOLDEN_ANGLE;
    return {
      ...point,
      x: clampTo({ value: point.x + Math.cos(angle) * radius, low: MAP_BOUNDS.minX + EDGE_MARGIN, high: MAP_BOUNDS.maxX - EDGE_MARGIN }),
      y: clampTo({ value: point.y + Math.sin(angle) * radius, low: MAP_BOUNDS.minY + EDGE_MARGIN, high: MAP_BOUNDS.maxY - EDGE_MARGIN }),
    };
  });
};

/** Every claim on the board as a point, with the two flag lines from the repo's config. */
export const buildConfidenceMap = ({ board }: { board: Board }): ConfidenceMap => {
  const flagged = new Set(board.queue);
  const placed: MapPoint[] = board.claims.map((claim) => {
    const catchRate = claim.mutation && claim.mutation.total > 0 ? claim.mutation.catchRate : null;
    const verdict = claim.verdict?.verdict.toLowerCase() ?? 'not checked';
    return {
      id: claim.id,
      title: claim.claim,
      confidence: claim.confidence,
      catchRate,
      verdict,
      needsDecision: flagged.has(claim.id),
      isSettled: claim.status === 'resolved' || claim.status === 'accepted',
      isRefuted: verdict === 'refuted',
      x: catchRate ?? GUTTER,
      y: claim.confidence ?? GUTTER,
      z: CHECKER_LEVELS.get(verdict) ?? GUTTER,
    };
  });
  const points = splitOverlappingPoints({ points: placed });
  const flagConfidence = board.config.app.flagConfidence;
  const flagCatchRate = board.config.app.flagCatchRate;
  const signature = JSON.stringify([flagConfidence, flagCatchRate, points.map((point) => [point.id, point.x, point.y, point.z, point.needsDecision, point.isSettled, point.isRefuted, point.title])]);
  return { points, flagConfidence, flagCatchRate, flagChecker: CHECKER_FLAG_LINE, signature };
};

/** How many claims still need a decision, for the heading over the map. Settled claims do not count. */
export const countNeedingDecision = ({ map }: { map: ConfidenceMap }): number => map.points.filter((point) => point.needsDecision && !point.isSettled).length;
