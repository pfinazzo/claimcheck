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
import { getDocument, h, type Child } from './dom.ts';
import { FLAG_TEXT, pct, plural, verdictWord } from './format.ts';

/** What the graph view needs from the board's page state. */
export type GraphUi = {
  board: Board | null;
  selectedId: string | null;
};

export type GraphActions = {
  select: (id: string | null) => void;
  /** Leaves the map for the list, with this claim open. */
  showClaim: (id: string) => void;
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

const CLAIM_STATE_WORDS: Record<Claim['status'], string> = { open: '', fixing: 'Fix in progress', resolved: 'Resolved', accepted: 'Accepted' };

// The one chart for the whole app. It is created on first use and kept, so its canvas survives page rebuilds.
let host: Host | null = null;

const legendItem = (swatch: string, text: string): HTMLElement => h('li', {}, h('span', { class: `swatch ${swatch}`, attrs: { 'aria-hidden': 'true' } }), text);

const ensureHost = (): Host => {
  if (host) return host;
  const canvas = getDocument().createElement('canvas');
  const overlay = h('div', { class: 'map-overlay', attrs: { 'aria-hidden': 'true' } });
  const tooltip = h('div', { class: 'map-tooltip' });
  tooltip.hidden = true;
  const stage = h('div', { class: 'map-stage', attrs: { role: 'img', 'aria-label': '3D confidence map. Every claim is a sphere placed by stated confidence, tests caught and the checker verdict. The table below lists the same claims with the same numbers.' } }, canvas, overlay, tooltip);
  const note = h('p', { class: 'muted map-note', attrs: { role: 'status' } });
  note.hidden = true;
  const root = h(
    'div',
    { class: 'map-card' },
    stage,
    h(
      'ul',
      { class: 'plain map-legend' },
      legendItem('zone', 'Red sheet: a flag line'),
      legendItem('good', 'Green box: backed on all three checks'),
      legendItem('bad', 'Needs a decision'),
      legendItem('accent', 'Backed'),
      legendItem('faint', 'Settled'),
      legendItem('ring', 'Ring: the checker refuted it'),
    ),
    h('p', { class: 'muted map-hint' }, 'Up is what the author stated, right is what the tests proved, and toward you is the independent checker\'s verdict. Drag to orbit, scroll to zoom, right-drag to pan, double-click to reset. Claims with the same numbers are spread a little so none hides another. "No run", "none" and "not checked" mean there was nothing to measure.'),
    note,
  );
  host = { root, stage, canvas, overlay, tooltip, note, start: null, signature: '', onSelect: () => {} };
  return host;
};

const selectionCard = (claim: Claim | null, a: GraphActions): HTMLElement => {
  if (!claim) return h('aside', { class: 'selection panel' }, h('h3', {}, 'Selected claim'), h('p', { class: 'muted' }, 'Click a dot on the map, or a row in the table, to see its claim here.'));
  const m = claim.mutation;
  const caught = m && m.total > 0 ? pct((m.killed + m.timeout) / m.total) : 'no run';
  return h(
    'aside',
    { class: 'selection panel' },
    h('h3', {}, `Selected claim ${claim.id}`),
    h('p', { class: 'selection-title' }, claim.claim),
    h('dl', { class: 'selection-facts' }, h('div', {}, h('dt', {}, 'Stated'), h('dd', {}, claim.confidence === null ? 'not stated' : claim.confidence.toFixed(2))), h('div', {}, h('dt', {}, 'Tests caught'), h('dd', {}, caught)), h('div', {}, h('dt', {}, 'Checker'), h('dd', {}, verdictWord(claim)))),
    claim.flags.length ? h('ul', { class: 'plain' }, ...claim.flags.map((flag) => h('li', { class: 'error' }, FLAG_TEXT[flag] ?? flag))) : h('p', { class: 'muted' }, 'Nothing is flagged on this claim.'),
    h('button', { class: 'btn primary', attrs: { type: 'button' }, on: { click: () => a.showClaim(claim.id) } }, 'Open claim'),
  );
};

const stateWord = (board: Board, claim: Claim): string => CLAIM_STATE_WORDS[claim.status] || (board.queue.includes(claim.id) ? 'Needs a decision' : 'Backed');

/** Every claim on the board, riskiest first, each as a row that selects it. */
const claimsTable = (board: Board, selectedId: string | null, a: GraphActions): HTMLElement => {
  const ordered = [...board.claims].sort((first, second) => second.risk - first.risk || first.id.localeCompare(second.id));
  return h(
    'section',
    { class: 'all-claims panel' },
    h('h3', {}, `All claims (${board.claims.length})`),
    h(
      'table',
      { class: 'all-claims-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Claim'), h('th', {}, 'Stated'), h('th', {}, 'Tests caught'), h('th', {}, 'Checker'), h('th', {}, 'State'))),
      h(
        'tbody',
        {},
        ...ordered.map((claim) => {
          const m = claim.mutation;
          const isFlagged = board.queue.includes(claim.id) && claim.status !== 'resolved' && claim.status !== 'accepted';
          return h(
            'tr',
            { class: claim.id === selectedId ? 'is-selected' : '', data: { claim: claim.id } },
            h('td', {}, h('button', { class: 'claim-link', attrs: { type: 'button', 'aria-pressed': claim.id === selectedId }, on: { click: () => a.select(claim.id) } }, h('span', { class: 'mono claim-id' }, claim.id), ' ', claim.claim)),
            h('td', { class: 'number' }, claim.confidence === null ? 'not stated' : claim.confidence.toFixed(2)),
            h('td', { class: 'number' }, m && m.total > 0 ? pct((m.killed + m.timeout) / m.total) : 'no run'),
            h('td', {}, verdictWord(claim)),
            h('td', { class: isFlagged ? 'error' : 'muted' }, stateWord(board, claim)),
          );
        }),
      ),
    ),
  );
};

/** The whole Confidence map tab. The chart itself is started by syncConfidenceMap once this is in the page. */
export const renderGraphView = (ui: GraphUi, a: GraphActions): Child[] => {
  const board = ui.board;
  if (!board) return [];
  const map = buildConfidenceMap({ board });
  const selected = board.claims.find((claim) => claim.id === ui.selectedId) ?? null;
  const needing = countNeedingDecision(map);
  return [
    h(
      'div',
      { class: 'graph-view' },
      h(
        'div',
        { class: 'graph-top' },
        h('section', { class: 'map-column panel' }, h('h3', {}, `Confidence map: ${needing === 0 ? 'no claim needs a decision' : `${needing} of ${plural(map.points.length, 'claim')} need a decision`}`), ensureHost().root),
        selectionCard(selected, a),
      ),
      claimsTable(board, ui.selectedId, a),
    ),
  ];
};

/**
 * Starts the chart the first time, then feeds it the board. Call it after the page from
 * renderGraphView is in the document, because the chart measures the space it was given.
 */
export const syncConfidenceMap = ({ ui, onSelect, reducedMotion }: { ui: GraphUi; onSelect: (id: string) => void; reducedMotion: boolean }): void => {
  const board = ui.board;
  if (!board) return;
  const current = ensureHost();
  current.onSelect = onSelect;
  if (!current.start) {
    current.start = startConfidenceMap({ stage: current.stage, canvas: current.canvas, overlay: current.overlay, tooltip: current.tooltip, reducedMotion, onSelect: (id) => current.onSelect(id) });
    if (current.start.status === 'unavailable') {
      current.note.hidden = false;
      current.note.textContent = `The map could not start (${current.start.reason}). The table has the same numbers.`;
    }
  }
  if (current.start.status !== 'ready') return;
  const map = buildConfidenceMap({ board });
  if (current.signature !== map.signature) {
    current.start.handle.setMap(map);
    current.signature = map.signature;
  }
  current.start.handle.setSelected(ui.selectedId);
  current.start.handle.drawNow();
};

/** Re-reads the page's colours, after the light or dark setting changed. */
export const refreshConfidenceMapTheme = (): void => {
  if (host?.start?.status !== 'ready') return;
  host.start.handle.setTheme();
  host.start.handle.drawNow();
};
