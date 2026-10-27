/**
 * Why this file exists: the Confidence map tab. It puts the Three.js chart, a card for the
 * selected claim and a table of EVERY claim (flagged or backed) on one page. The chart's canvas
 * is created once and moved into each new page, because the board is rebuilt on every update and
 * a canvas rebuilt each time would flash and lose its zoom.
 *
 * @author Patrick Finazzo
 */

import { buildConfidenceMap, countNeedingDecision } from '../shared/confidence-map.ts';
import type { Board, Claim } from '../shared/types.ts';
import { startConfidenceMap, type MapStart } from './confidence-map.ts';
import { makeElement, readDocument } from './dom.ts';
import { FLAG_TEXT, formatPercent, formatPlural, formatVerdictWord } from './format.ts';

/** What the graph view needs from the board's page state. */
export type GraphUi = {
  board: Board | null;
  selectedId: string | null;
};

export type GraphActions = {
  select: (options: { id: string | null }) => void;
  /** Leaves the map for the list, with this claim open. */
  showClaim: (options: { id: string }) => void;
};

type Host = {
  root: HTMLElement;
  stage: HTMLElement;
  canvas: HTMLCanvasElement;
  overlay: HTMLElement;
  tooltip: HTMLElement;
  note: HTMLElement;
  start: MapStart | null;
  signature: string;
  onSelect: (id: string) => void;
};

const CLAIM_STATE_WORDS = new Map<string, string>([
  ['fixing', 'Fix in progress'],
  ['resolved', 'Resolved'],
  ['accepted', 'Accepted'],
]);

const SETTLED_STATUSES = new Set(['resolved', 'accepted']);

const MAP_HINT =
  'Up is what the author stated, right is what the tests proved, and toward you is the independent checker\'s verdict. Drag to orbit, scroll to zoom, right-drag to pan, double-click to reset. Claims with the same numbers are spread a little so none hides another. "No run", "none" and "not checked" mean there was nothing to measure.';

// The one chart for the whole app. It is created on first use and kept, so its canvas survives page rebuilds.
const hostHolder: { current: Host | null } = { current: null };

const renderLegendItem = ({ swatch, text }: { swatch: string; text: string }): HTMLElement =>
  makeElement({ tag: 'li', props: {}, children: [makeElement({ tag: 'span', props: { class: `swatch ${swatch}`, attrs: { 'aria-hidden': 'true' } } }), text] });

const buildHost = (): Host => {
  const canvas = readDocument().createElement('canvas');
  const overlay = makeElement({ tag: 'div', props: { class: 'map-overlay', attrs: { 'aria-hidden': 'true' } } });
  const tooltip = makeElement({ tag: 'div', props: { class: 'map-tooltip' } });
  tooltip.hidden = true;
  const stage = makeElement({
    tag: 'div',
    props: {
      class: 'map-stage',
      attrs: { role: 'img', 'aria-label': '3D confidence map. Every claim is a sphere placed by stated confidence, tests caught and the checker verdict. The table below lists the same claims with the same numbers.' },
    },
    children: [canvas, overlay, tooltip],
  });
  const note = makeElement({ tag: 'p', props: { class: 'muted map-note', attrs: { role: 'status' } } });
  note.hidden = true;
  const root = makeElement({
    tag: 'div',
    props: { class: 'map-card' },
    children: [
      stage,
      makeElement({
        tag: 'ul',
        props: { class: 'plain map-legend' },
        children: [
          renderLegendItem({ swatch: 'zone', text: 'Red sheet: a flag line' }),
          renderLegendItem({ swatch: 'good', text: 'Green box: backed on all three checks' }),
          renderLegendItem({ swatch: 'bad', text: 'Needs a decision' }),
          renderLegendItem({ swatch: 'accent', text: 'Backed' }),
          renderLegendItem({ swatch: 'faint', text: 'Settled' }),
          renderLegendItem({ swatch: 'ring', text: 'Ring: the checker refuted it' }),
        ],
      }),
      makeElement({ tag: 'p', props: { class: 'muted map-hint' }, children: [MAP_HINT] }),
      note,
    ],
  });
  return { root, stage, canvas, overlay, tooltip, note, start: null, signature: '', onSelect: () => undefined };
};

const ensureHost = (): Host => {
  const existing = hostHolder.current;
  if (existing) return existing;
  const created = buildHost();
  hostHolder.current = created;
  return created;
};

const renderSelectionCard = ({ claim, actions }: { claim: Claim | null; actions: GraphActions }): HTMLElement => {
  if (!claim) {
    return makeElement({
      tag: 'aside',
      props: { class: 'selection panel' },
      children: [makeElement({ tag: 'h3', props: {}, children: ['Selected claim'] }), makeElement({ tag: 'p', props: { class: 'muted' }, children: ['Click a dot on the map, or a row in the table, to see its claim here.'] })],
    });
  }
  const mutation = claim.mutation;
  const caught = mutation && mutation.total > 0 ? formatPercent({ x: (mutation.killed + mutation.timeout) / mutation.total }) : 'no run';
  const fact = ({ label, value }: { label: string; value: string }): HTMLElement =>
    makeElement({ tag: 'div', props: {}, children: [makeElement({ tag: 'dt', props: {}, children: [label] }), makeElement({ tag: 'dd', props: {}, children: [value] })] });
  return makeElement({
    tag: 'aside',
    props: { class: 'selection panel' },
    children: [
      makeElement({ tag: 'h3', props: {}, children: [`Selected claim ${claim.id}`] }),
      makeElement({ tag: 'p', props: { class: 'selection-title' }, children: [claim.claim] }),
      makeElement({
        tag: 'dl',
        props: { class: 'selection-facts' },
        children: [
          fact({ label: 'Stated', value: claim.confidence === null ? 'not stated' : claim.confidence.toFixed(2) }),
          fact({ label: 'Tests caught', value: caught }),
          fact({ label: 'Checker', value: formatVerdictWord({ claim }) }),
        ],
      }),
      claim.flags.length
        ? makeElement({ tag: 'ul', props: { class: 'plain' }, children: claim.flags.map((flag) => makeElement({ tag: 'li', props: { class: 'error' }, children: [FLAG_TEXT[flag] ?? flag] })) })
        : makeElement({ tag: 'p', props: { class: 'muted' }, children: ['Nothing is flagged on this claim.'] }),
      makeElement({ tag: 'button', props: { class: 'btn primary', attrs: { type: 'button' }, on: { click: () => actions.showClaim({ id: claim.id }) } }, children: ['Open claim'] }),
    ],
  });
};

const describeClaimState = ({ board, claim }: { board: Board; claim: Claim }): string => CLAIM_STATE_WORDS.get(claim.status) ?? (board.queue.includes(claim.id) ? 'Needs a decision' : 'Backed');

/** Every claim on the board, riskiest first, each as a row that selects it. */
const renderClaimsTable = ({ board, selectedId, actions }: { board: Board; selectedId: string | null; actions: GraphActions }): HTMLElement => {
  const ordered = board.claims.toSorted((first, second) => second.risk - first.risk || first.id.localeCompare(second.id));
  const renderRow = ({ claim }: { claim: Claim }): HTMLElement => {
    const mutation = claim.mutation;
    const isFlagged = board.queue.includes(claim.id) && !SETTLED_STATUSES.has(claim.status);
    return makeElement({
      tag: 'tr',
      props: { class: claim.id === selectedId ? 'is-selected' : '', dataset: { claim: claim.id } },
      children: [
        makeElement({
          tag: 'td',
          props: {},
          children: [
            makeElement({
              tag: 'button',
              props: { class: 'claim-link', attrs: { type: 'button', 'aria-pressed': claim.id === selectedId }, on: { click: () => actions.select({ id: claim.id }) } },
              children: [makeElement({ tag: 'span', props: { class: 'mono claim-id' }, children: [claim.id] }), ' ', claim.claim],
            }),
          ],
        }),
        makeElement({ tag: 'td', props: { class: 'number' }, children: [claim.confidence === null ? 'not stated' : claim.confidence.toFixed(2)] }),
        makeElement({ tag: 'td', props: { class: 'number' }, children: [mutation && mutation.total > 0 ? formatPercent({ x: (mutation.killed + mutation.timeout) / mutation.total }) : 'no run'] }),
        makeElement({ tag: 'td', props: {}, children: [formatVerdictWord({ claim })] }),
        makeElement({ tag: 'td', props: { class: isFlagged ? 'error' : 'muted' }, children: [describeClaimState({ board, claim })] }),
      ],
    });
  };
  return makeElement({
    tag: 'section',
    props: { class: 'all-claims panel' },
    children: [
      makeElement({ tag: 'h3', props: {}, children: [`All claims (${board.claims.length})`] }),
      makeElement({
        tag: 'table',
        props: { class: 'all-claims-table' },
        children: [
          makeElement({
            tag: 'thead',
            props: {},
            children: [makeElement({ tag: 'tr', props: {}, children: ['Claim', 'Stated', 'Tests caught', 'Checker', 'State'].map((label) => makeElement({ tag: 'th', props: {}, children: [label] })) })],
          }),
          makeElement({ tag: 'tbody', props: {}, children: ordered.map((claim) => renderRow({ claim })) }),
        ],
      }),
    ],
  });
};

/** The whole Confidence map tab. The chart itself is started by drawConfidenceMap once this is in the page. */
export const renderGraphView = ({ ui, actions }: { ui: GraphUi; actions: GraphActions }): HTMLElement => {
  const board = ui.board;
  if (!board) return makeElement({ tag: 'div', props: { class: 'graph-view' } });
  const map = buildConfidenceMap({ board });
  const selected = board.claims.find((claim) => claim.id === ui.selectedId) ?? null;
  const needing = countNeedingDecision({ map });
  const heading = needing === 0 ? 'no claim needs a decision' : `${needing} of ${formatPlural({ count: map.points.length, one: 'claim' })} need a decision`;
  return makeElement({
    tag: 'div',
    props: { class: 'graph-view' },
    children: [
      makeElement({
        tag: 'div',
        props: { class: 'graph-top' },
        children: [
          makeElement({ tag: 'section', props: { class: 'map-column panel' }, children: [makeElement({ tag: 'h3', props: {}, children: [`Confidence map: ${heading}`] }), ensureHost().root] }),
          renderSelectionCard({ claim: selected, actions }),
        ],
      }),
      renderClaimsTable({ board, selectedId: ui.selectedId, actions }),
    ],
  });
};

/**
 * Starts the chart the first time, then feeds it the board. Call it after the page from
 * renderGraphView is in the document, because the chart measures the space it was given.
 */
export const drawConfidenceMap = ({ ui, onSelect, reducedMotion }: { ui: GraphUi; onSelect: (id: string) => void; reducedMotion: boolean }): void => {
  const board = ui.board;
  if (!board) return;
  const host = ensureHost();
  host.onSelect = onSelect;
  host.start ??= startConfidenceMap({ stage: host.stage, canvas: host.canvas, overlay: host.overlay, tooltip: host.tooltip, reducedMotion, onSelect: (id) => host.onSelect(id) });
  const start = host.start;
  if (start.status === 'unavailable') {
    host.note.hidden = false;
    host.note.textContent = `The map could not start (${start.reason}). The table has the same numbers.`;
    return;
  }
  const map = buildConfidenceMap({ board });
  if (host.signature !== map.signature) {
    start.handle.setMap(map);
    host.signature = map.signature;
  }
  start.handle.setSelected(ui.selectedId);
  start.handle.drawNow();
};

/** Re-reads the page's colours, after the light or dark setting changed. */
export const refreshConfidenceMapTheme = (): void => {
  const start = hostHolder.current?.start;
  if (start?.status !== 'ready') return;
  start.handle.setTheme();
  start.handle.drawNow();
};
