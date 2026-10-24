/**
 * Pure rendering for the board: given the model and the view state, return
 * HTML strings. No DOM access here, so node:test can check the output.
 *
 * @author Patrick Finazzo
 */

import { transformOf } from './zoom.js';

export const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const FLAG_TEXT = {
  'low-confidence': 'the author was not sure',
  refuted: 'the independent check disagreed',
  unverified: 'nobody has checked this yet',
  'weak-tests': 'planted bugs got past the tests',
  'no-mutants': 'nothing to plant a bug into',
};

const VERDICT_CLASS = { SUPPORTED: 'ok', REFUTED: 'bad', UNVERIFIABLE: 'warn' };
const STATUS_CLASS = { open: '', fixing: 'warn', resolved: 'ok', accepted: 'violet', failed: 'bad' };

export const pct = (x) => (x === null || x === undefined ? 'n/a' : `${Math.round(x * 100)}%`);
export const short = (sha) => String(sha ?? '').slice(0, 7);

export const verdictPill = (claim) => {
  const v = claim.verdict?.verdict ?? 'UNCHECKED';
  return `<span class="pill verdict ${VERDICT_CLASS[v] ?? ''}" data-verdict="${esc(v)}">${esc(v.toLowerCase())}</span>`;
};

export const catchPill = (claim) => {
  const rate = claim.mutation?.catchRate ?? null;
  const cls = rate === null ? '' : rate >= 0.8 ? 'ok' : rate >= 0.5 ? 'warn' : 'bad';
  const label = claim.mutation ? `${pct(rate)} caught` : 'no mutate run';
  return `<span class="pill catch ${cls}" data-rate="${rate === null ? '' : rate}">${esc(label)}</span>`;
};

export const statusChip = (claim) =>
  `<span class="pill status ${STATUS_CLASS[claim.status] ?? ''}" data-status="${esc(claim.status)}">${esc(claim.status)}</span>`;

export const confidenceMeter = (claim) =>
  `<div class="confidence" data-value="${claim.confidence}"><div class="bar"><div class="fill" style="width:${Math.round(claim.confidence * 100)}%"></div></div><span class="num">${esc(claim.confidence.toFixed(2))}</span></div>`;

export const flagTags = (claim) =>
  claim.flags.length
    ? `<div class="tags">${claim.flags.map((f) => `<span class="tag ${f === 'refuted' ? 'bad' : f === 'low-confidence' || f === 'weak-tests' ? 'warn' : ''}">${esc(f)}</span>`).join('')}</div>`
    : '';

export const renderCard = (claim, selectedId) => {
  const classes = ['card', claim.status, claim.flags.length && (claim.status === 'open' || claim.status === 'fixing') ? 'flagged' : '', claim.id === selectedId ? 'selected' : ''].filter(Boolean).join(' ');
  return `<article class="${classes}" data-claim="${esc(claim.id)}">
  <div class="card-head"><span class="id">${esc(claim.id)}</span>${statusChip(claim)}<span class="risk" title="risk">risk ${claim.risk.toFixed(2)}</span></div>
  <div class="card-claim">${esc(claim.claim)}</div>
  <div class="meters">${confidenceMeter(claim)}${verdictPill(claim)}${catchPill(claim)}</div>
  ${flagTags(claim)}
  <div class="kill mono" title="kill condition">${esc(claim.killCondition)}</div>
  <div class="files" title="${esc(claim.files.join(', '))}">${claim.criteria.length ? `<span class="criteria">criteria ${esc(claim.criteria.map((c) => c.id).join(', '))}</span> · ` : ''}${esc(claim.files.join(', '))}</div>
</article>`;
};

export const renderHeader = (model, { running = false } = {}) => {
  if (!model) {
    return `<div class="brand"><span class="dot"></span>claimcheck <small>Desk</small></div><div class="spacer"></div><div class="actions"><button class="btn" data-action="open-repo">Open repo</button></div>`;
  }
  const { repo, connection } = model;
  const lock = repo.lockOk ? '<span class="pill ok">spec frozen</span>' : '<span class="pill bad">spec drifted</span>';
  const last = repo.lastRunTs ? `<span class="pill mono" title="last run">${esc(repo.lastRunTs.replace('T', ' ').replace('Z', ' UTC'))}</span>` : '<span class="pill warn">no runs yet</span>';
  const conn = connection
    ? connection.mode === 'api'
      ? `<span class="pill ${connection.apiSaved ? (connection.apiOk === false ? 'bad' : 'accent') : 'warn'}" data-action="connect">API key ${connection.apiSaved ? `····${esc(connection.apiLast4 ?? '')}` : 'not set'}</span>`
      : `<span class="pill ${connection.cliOk ? 'ok' : connection.cliPath ? 'accent' : 'warn'}" data-action="connect">Claude Code ${connection.cliOk ? 'signed in' : connection.cliPath ? 'found' : 'not found'}</span>`
    : '';
  return `<div class="brand"><span class="dot"></span>claimcheck <small>Desk</small></div>
<div class="crumbs"><span class="repo" title="${esc(repo.path)}">${esc(repo.name)}</span><span class="pill mono">${esc(repo.branch ?? '?')} @ ${esc(short(repo.head))}</span>${lock}${last}</div>
<div class="spacer"></div>
<div class="actions">${conn}<button class="btn sm" data-action="connect">Connect Claude</button><button class="btn sm" data-action="run-claimcheck" ${running ? 'disabled' : ''}>${running ? '<span class="spinner"></span>Running…' : 'Run claimcheck'}</button><button class="btn sm ghost" data-action="open-repo">Open repo</button></div>`;
};

export const renderQueue = (model, selectedId) => {
  const queue = model.queue.map((id) => model.claims.find((c) => c.id === id)).filter(Boolean);
  const rest = model.claims.filter((c) => !model.queue.includes(c.id));
  return `<section class="queue">
  <div class="section-title bad">Decision queue <span class="count">${queue.length}</span></div>
  ${queue.length ? queue.map((c) => renderCard(c, selectedId)).join('') : '<div class="muted" style="padding:8px 0 16px">Nothing needs a decision. Every claim is backed.</div>'}
  <div class="section-title" style="margin-top:18px">Backed or settled <span class="count">${rest.length}</span></div>
  ${rest.map((c) => renderCard(c, selectedId)).join('')}
</section>`;
};

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export const renderTiles = (model) => {
  const claims = model.claims;
  const refuted = claims.filter((c) => c.verdict?.verdict === 'REFUTED').length;
  const conf = mean(claims.map((c) => c.confidence));
  const rates = claims.map((c) => c.mutation?.catchRate).filter((r) => r !== null && r !== undefined);
  const rate = mean(rates);
  return `<div class="tiles">
  <div class="tile"><div class="label">Claims</div><div class="value">${claims.length}</div></div>
  <div class="tile"><div class="label">Need a decision</div><div class="value ${model.queue.length ? 'bad' : 'ok'}">${model.queue.length}</div></div>
  <div class="tile"><div class="label">Refuted</div><div class="value ${refuted ? 'bad' : ''}">${refuted}</div></div>
  <div class="tile"><div class="label">Stated confidence</div><div class="value">${conf === null ? '–' : conf.toFixed(2)}</div></div>
  <div class="tile"><div class="label">Bugs caught</div><div class="value ${rate === null ? '' : rate >= 0.8 ? 'ok' : rate >= 0.5 ? 'warn' : 'bad'}">${pct(rate)}</div></div>
</div>`;
};

const W = 600;
const H = 300;
const PAD = { l: 44, r: 16, t: 14, b: 32 };

export const scatterPoints = (model) =>
  model.claims.map((c) => ({
    id: c.id,
    x: PAD.l + c.confidence * (W - PAD.l - PAD.r),
    y: PAD.t + (1 - (c.mutation?.catchRate ?? 0)) * (H - PAD.t - PAD.b),
    verdict: c.verdict?.verdict ?? 'none',
    flagged: c.flags.length > 0 && (c.status === 'open' || c.status === 'fixing'),
    noRate: c.mutation?.catchRate === null || c.mutation?.catchRate === undefined,
  }));

export const renderScatter = (model, view, selectedId) => {
  const pts = scatterPoints(model);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const xOf = (v) => PAD.l + v * (W - PAD.l - PAD.r);
  const yOf = (v) => PAD.t + (1 - v) * (H - PAD.t - PAD.b);
  const grid = ticks.map((t) => `<line x1="${xOf(t)}" y1="${PAD.t}" x2="${xOf(t)}" y2="${H - PAD.b}"/><line x1="${PAD.l}" y1="${yOf(t)}" x2="${W - PAD.r}" y2="${yOf(t)}"/>`).join('');
  const xLabels = ticks.map((t) => `<text x="${xOf(t)}" y="${H - PAD.b + 14}" text-anchor="middle">${t}</text>`).join('');
  const yLabels = ticks.map((t) => `<text x="${PAD.l - 6}" y="${yOf(t) + 3}" text-anchor="end">${t}</text>`).join('');
  const zone = `<rect class="zone" x="${xOf(0.75)}" y="${yOf(0.8)}" width="${xOf(1) - xOf(0.75)}" height="${yOf(0) - yOf(0.8)}"/><text class="zone-label" x="${xOf(1) - 6}" y="${yOf(0) - 8}" text-anchor="end">sure but unproven</text>`;
  const dots = pts
    .map(
      (p) =>
        `<circle class="pt ${p.verdict} ${p.flagged ? 'flagged' : ''} ${p.id === selectedId ? 'selected' : ''}" data-claim="${esc(p.id)}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${p.id === selectedId ? 7 : 5.5}" ${p.noRate ? 'stroke-dasharray="2 2"' : ''}><title>${esc(p.id)}</title></circle><text class="pt-label" x="${(p.x + 9).toFixed(1)}" y="${(p.y + 3.5).toFixed(1)}">${esc(p.id)}</text>`,
    )
    .join('');
  return `<div class="chart">
  <div class="chart-head"><div class="section-title" style="margin:0">Stated confidence vs bugs caught</div><span class="hint">drag to pan · wheel to zoom · double-click to reset</span></div>
  <svg viewBox="0 0 ${W} ${H}" data-chart="scatter">
    <g class="plot" transform="${transformOf(view)}">
      <g class="grid">${grid}</g>
      ${zone}
      <g class="axis"><line x1="${PAD.l}" y1="${H - PAD.b}" x2="${W - PAD.r}" y2="${H - PAD.b}"/><line x1="${PAD.l}" y1="${PAD.t}" x2="${PAD.l}" y2="${H - PAD.b}"/>${xLabels}${yLabels}<text x="${(W + PAD.l) / 2}" y="${H - 4}" text-anchor="middle">confidence the author stated</text><text transform="translate(12 ${(H - PAD.b + PAD.t) / 2}) rotate(-90)" text-anchor="middle">planted bugs caught</text></g>
      ${dots}
    </g>
  </svg>
  <div class="legend"><span><i style="background:var(--ok)"></i>supported</span><span><i style="background:var(--bad)"></i>refuted</span><span><i style="background:var(--warn)"></i>unverifiable</span><span><i style="background:var(--faint)"></i>unchecked</span><span class="faint">hollow = flagged</span><span class="faint">dashed = no mutate run</span></div>
</div>`;
};

export const renderTable = (model, selectedId) => `<div class="section-title">All claims <span class="count">${model.claims.length}</span></div>
<table class="claims">
<thead><tr><th>id</th><th>claim</th><th>confidence</th><th>verdict</th><th>bugs caught</th><th>status</th></tr></thead>
<tbody>${model.claims
  .map(
    (c) => `<tr data-claim="${esc(c.id)}" class="${c.id === selectedId ? 'selected' : ''}"><td class="id">${esc(c.id)}</td><td>${esc(c.claim)}</td><td class="conf">${confidenceMeter(c)}</td><td>${verdictPill(c)}</td><td>${catchPill(c)}</td><td>${statusChip(c)}</td></tr>`,
  )
  .join('')}</tbody></table>`;

/** AC 10/11: the whole board as strings; `viewState` carries the open claim and the zoom. */
export const renderBoard = (model, viewState) => {
  const view = { selectedId: null, zoom: { k: 1, tx: 0, ty: 0 }, running: false, ...viewState };
  if (!model) {
    return {
      header: renderHeader(null),
      queue: '',
      center: `<div class="empty-state"><h2>Open a repository</h2><div>Pick a folder with a <code>.claimcheck/</code> inside. Run <code>claimcheck init</code> there first if it has none.</div><button class="btn primary" data-action="open-repo">Open repo</button></div>`,
      viewState: view,
    };
  }
  return {
    header: renderHeader(model, { running: view.running }),
    queue: renderQueue(model, view.selectedId),
    center: `${renderTiles(model)}${renderScatter(model, view.zoom, view.selectedId)}<section class="claims">${renderTable(model, view.selectedId)}</section>`,
    viewState: view,
  };
};
