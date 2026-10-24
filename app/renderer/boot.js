/**
 * Wires the pure renderers to the DOM and to window.desk. Keeps the open
 * claim and the scatter's pan/zoom across every live re-render.
 *
 * @author Patrick Finazzo
 */

import { esc, renderBoard } from './app.js';
import { renderPanel } from './panel.js';
import { applyDrag, applyWheel, reset } from './zoom.js';

const desk = window.desk;
const $ = (sel) => document.querySelector(sel);

const state = {
  board: null,
  view: { selectedId: null, zoom: reset(), running: false },
  runs: new Map(), // claimId -> latest run
  ghOk: false,
  connection: null,
  drawer: [],
};

const toast = (text, bad = false) => {
  const el = $('#toast');
  el.textContent = text;
  el.className = `toast ${bad ? 'bad' : ''}`;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), bad ? 6000 : 2800);
};

const selectedClaim = () => state.board?.claims.find((c) => c.id === state.view.selectedId) ?? null;

const render = () => {
  const out = renderBoard(state.board, state.view);
  $('#header').innerHTML = out.header;
  $('#queue').innerHTML = out.queue;
  $('#center').innerHTML = out.center;
  renderPanelOnly();
  if (!render.signalled && state.board) {
    render.signalled = true;
    requestAnimationFrame(() => desk.rendered?.());
  }
};

const renderPanelOnly = () => {
  const panel = $('#panel');
  const claim = selectedClaim();
  const scroll = panel.scrollTop;
  panel.classList.toggle('empty', !claim);
  panel.innerHTML = renderPanel(claim, claim ? state.runs.get(claim.id) ?? null : null, { ghOk: state.ghOk });
  panel.scrollTop = scroll;
};

const select = (id) => {
  state.view.selectedId = id;
  render();
};

// ---- board + run subscriptions ------------------------------------------
desk.onBoard((board) => {
  state.board = board;
  state.connection = board.connection;
  for (const run of board.runs?.fixes ?? []) state.runs.set(run.claimId, run);
  if (!state.view.selectedId && board.queue.length) state.view.selectedId = board.queue[0];
  render();
});

desk.onRunUpdate((update) => {
  if (update.type === 'run') {
    state.runs.set(update.run.claimId, update.run);
    if (update.run.claimId === state.view.selectedId) renderPanelOnly();
    return;
  }
  if (update.type === 'claimcheck') {
    const drawer = $('#drawer');
    drawer.hidden = false;
    if (update.status === 'running') {
      state.drawer = [];
      state.view.running = true;
      $('#drawer-status').textContent = 'running…';
      $('#header').innerHTML = renderBoard(state.board, state.view).header;
    }
    if (update.line) state.drawer.push(update.line);
    if (update.status === 'done') {
      state.view.running = false;
      $('#drawer-status').textContent = `exit ${update.exitCode}`;
      $('#header').innerHTML = renderBoard(state.board, state.view).header;
    }
    const out = $('#drawer-out');
    out.textContent = state.drawer.join('\n');
    out.scrollTop = out.scrollHeight;
  }
});

// ---- dialogs ---------------------------------------------------------------
const openDialog = async () => {
  const recents = await desk.recents();
  const dlg = $('#open');
  dlg.innerHTML = `<div class="dialog-head"><h2>Open a repository</h2><div class="spacer"></div><button class="btn sm ghost" data-close>✕</button></div>
<div class="dialog-body"><button class="btn primary" data-action="pick-folder">Choose a folder…</button>
<div class="muted" style="margin-top:12px">${recents.length ? 'Recent' : 'No recent repos yet.'}</div>
<div class="recents">${recents.map((p) => `<button class="btn" data-action="open-recent" data-path="${esc(p)}">${esc(p)}</button>`).join('')}</div></div>`;
  dlg.showModal();
};

const connectDialog = (tab) => {
  const c = state.connection ?? { mode: 'cli', model: 'claude-opus-5-5' };
  const active = tab ?? c.mode;
  const dlg = $('#connect');
  dlg.innerHTML = `<div class="dialog-head"><h2>Connect Claude</h2><div class="spacer"></div><button class="btn sm ghost" data-close>✕</button></div>
<div class="dialog-body">
  <div class="tabs"><span class="tab ${active === 'cli' ? 'active' : ''}" data-tab="cli">Claude Code CLI</span><span class="tab ${active === 'api' ? 'active' : ''}" data-tab="api">API key</span></div>
  <div data-tabpane="cli" class="${active === 'cli' ? '' : 'hidden'}">
    <div class="muted">Uses your own Claude Code sign-in. Proposals run read-only; fixes run in a separate worktree with a tool allowlist.</div>
    <div class="field"><label>claude executable</label><div class="row"><input type="text" data-field="cliPath" value="${esc(c.cliPath ?? '')}" placeholder="auto-detect" /><button class="btn" data-action="detect-cli">Detect</button></div>
    <div class="status-line" data-cli-status>${c.cliPath ? `found at <span class="mono">${esc(c.cliPath)}</span>` : 'not found yet'}${c.cliOk === true ? ' · <span style="color:var(--ok)">signed in</span>' : c.cliOk === false ? ' · <span style="color:var(--bad)">not signed in</span>' : ''}</div></div>
    <div class="fix-actions"><button class="btn primary" data-action="test-cli">Test</button><button class="btn" data-action="sign-in">Sign in</button></div>
  </div>
  <div data-tabpane="api" class="${active === 'api' ? '' : 'hidden'}">
    <div class="muted">The key is encrypted with your operating system's keychain and never written in plain text. API mode can propose fixes but cannot edit your repo.</div>
    <div class="field"><label>API key</label><div class="row"><input type="password" data-field="apiKey" placeholder="${c.apiSaved ? 'key saved · ends in ····' + esc(c.apiLast4 ?? '') : 'sk-ant-…'}" autocomplete="off" /><button class="btn primary" data-action="save-key">Save &amp; test</button>${c.apiSaved ? '<button class="btn danger" data-action="clear-key">Clear</button>' : ''}</div>
    <div class="status-line" data-api-status>${c.apiSaved ? `key saved · ends in ····${esc(c.apiLast4 ?? '')}` : 'no key saved'}${c.apiOk === true ? ' · <span style="color:var(--ok)">works</span>' : c.apiOk === false ? ' · <span style="color:var(--bad)">failed</span>' : ''}</div></div>
  </div>
  <div class="field"><label>model</label><select data-field="model">${['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-haiku-5-5'].map((m) => `<option ${m === c.model ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
  <div class="field"><label>use for Fix this</label><select data-field="mode"><option value="cli" ${active === 'cli' ? 'selected' : ''}>Claude Code CLI</option><option value="api" ${active === 'api' ? 'selected' : ''}>API key</option></select></div>
  <div class="fix-actions"><button class="btn" data-action="save-connection">Save</button></div>
</div>`;
  if (!dlg.open) dlg.showModal();
};

const setStatus = (sel, html) => {
  const el = $(sel);
  if (el) el.innerHTML = html;
};

// ---- actions ---------------------------------------------------------------
const guard = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (error) {
    toast(error.message ?? String(error), true);
  }
};

const actions = {
  'open-repo': guard(openDialog),
  'pick-folder': guard(async () => {
    const res = await desk.openRepo({});
    if (!res.ok) throw new Error(res.error);
    $('#open').close();
    state.view.selectedId = null;
  }),
  'open-recent': guard(async (el) => {
    const res = await desk.openRepo({ path: el.dataset.path });
    if (!res.ok) throw new Error(res.error);
    $('#open').close();
    state.view.selectedId = null;
  }),
  connect: guard(async () => connectDialog()),
  'detect-cli': guard(async () => {
    state.connection = await desk.connect({ action: 'detect' });
    connectDialog('cli');
  }),
  'test-cli': guard(async () => {
    setStatus('[data-cli-status]', '<span class="spinner"></span>testing…');
    const r = await desk.testConnection({ mode: 'cli' });
    setStatus('[data-cli-status]', r.ok ? `<span style="color:var(--ok)">signed in</span> · <span class="mono">${esc(r.path)}</span>` : `<span style="color:var(--bad)">${esc(r.error ?? 'failed')}</span>${r.needsSignIn ? ' — press Sign in' : ''}`);
  }),
  'sign-in': guard(async () => {
    await desk.connect({ action: 'sign-in' });
    toast('A terminal opened for the sign-in. Press Test when it is done.');
  }),
  'save-key': guard(async () => {
    const input = $('[data-field="apiKey"]');
    await desk.connect({ action: 'save-key', apiKey: input.value, mode: 'api' });
    input.value = '';
    setStatus('[data-api-status]', '<span class="spinner"></span>testing…');
    const r = await desk.testConnection({ mode: 'api' });
    state.connection = await desk.connect({});
    connectDialog('api');
    setStatus('[data-api-status]', r.ok ? `key saved · ends in ····${esc(r.last4 ?? '')} · <span style="color:var(--ok)">works</span>` : `<span style="color:var(--bad)">${esc(r.error ?? 'failed')}</span>`);
  }),
  'clear-key': guard(async () => {
    state.connection = await desk.connect({ action: 'clear-key' });
    connectDialog('api');
  }),
  'save-connection': guard(async () => {
    state.connection = await desk.connect({ mode: $('[data-field="mode"]').value, model: $('[data-field="model"]').value, cliPath: $('[data-field="cliPath"]')?.value ?? undefined });
    $('#connect').close();
    toast('Connection saved.');
  }),
  'run-claimcheck': guard(async () => {
    $('#drawer').hidden = false;
    await desk.runClaimcheck({});
  }),
  fix: guard(async (el) => {
    const run = await desk.startPropose({ claimId: el.dataset.claim });
    state.runs.set(el.dataset.claim, run);
    renderPanelOnly();
  }),
  'use-approach': guard(async (el) => {
    const run = await desk.startImplement({ claimId: el.dataset.claim, proposeRunId: el.dataset.run, choice: Number(el.dataset.choice) });
    state.runs.set(el.dataset.claim, run);
    renderPanelOnly();
  }),
  'copy-prompt': guard(async (el) => {
    const { text } = await desk.copyPrompt({ claimId: el.dataset.claim });
    const pre = $('[data-prompt-text]');
    if (pre) pre.textContent = text;
    toast('Prompt copied. Paste it into any Claude Code session.');
  }),
  'copy-implement': guard(async (el) => {
    const { text } = await desk.copyPrompt({ claimId: el.dataset.claim, kind: 'implement', proposeRunId: el.dataset.run, choice: Number(el.dataset.choice) });
    await navigator.clipboard?.writeText?.(text).catch(() => {});
    toast('Build prompt copied.');
  }),
  'copy-text': guard(async (el) => {
    await navigator.clipboard.writeText(el.dataset.text ?? '');
    toast('Copied.');
  }),
  'accept-risk-toggle': guard(async (el) => {
    $(`[data-accept-row="${CSS.escape(el.dataset.claim)}"]`)?.classList.toggle('hidden');
  }),
  'accept-risk': guard(async (el) => {
    const note = $(`[data-accept-note="${CSS.escape(el.dataset.claim)}"]`)?.value ?? '';
    if (!note.trim()) throw new Error('Write one line on why this risk is acceptable.');
    await desk.acceptRisk({ claimId: el.dataset.claim, note: note.trim() });
    toast('Accepted. It leaves the queue and stays in the ledger.');
  }),
  'open-pr': guard(async (el) => {
    el.disabled = true;
    const { url } = await desk.openPullRequest({ runId: el.dataset.run });
    toast(`Pull request opened: ${url}`);
  }),
  'open-path': guard(async (el) => {
    await desk.openPath({ target: el.dataset.target });
  }),
  'close-panel': guard(async () => select(null)),
};

document.addEventListener('click', (event) => {
  const closer = event.target.closest('[data-close]');
  if (closer) {
    closer.closest('dialog')?.close();
    return;
  }
  const tab = event.target.closest('[data-tab]');
  if (tab) {
    connectDialog(tab.dataset.tab);
    return;
  }
  const actionEl = event.target.closest('[data-action]');
  if (actionEl) {
    event.preventDefault();
    actions[actionEl.dataset.action]?.(actionEl);
    return;
  }
  const claimEl = event.target.closest('[data-claim]');
  if (claimEl && !event.target.closest('svg')) select(claimEl.dataset.claim);
});

$('#drawer-close').addEventListener('click', () => ($('#drawer').hidden = true));

// ---- scatter pan / zoom --------------------------------------------------
const svgPoint = (svg, event) => {
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  return { x: ((event.clientX - rect.left) / rect.width) * vb.width, y: ((event.clientY - rect.top) / rect.height) * vb.height };
};
const applyTransform = () => {
  const g = document.querySelector('svg[data-chart] g.plot');
  if (g) g.setAttribute('transform', `translate(${state.view.zoom.tx} ${state.view.zoom.ty}) scale(${state.view.zoom.k})`);
};
document.addEventListener(
  'wheel',
  (event) => {
    const svg = event.target.closest?.('svg[data-chart]');
    if (!svg) return;
    event.preventDefault();
    state.view.zoom = applyWheel(state.view.zoom, { ...svgPoint(svg, event), deltaY: event.deltaY });
    applyTransform();
  },
  { passive: false },
);
let drag = null;
document.addEventListener('mousedown', (event) => {
  const svg = event.target.closest?.('svg[data-chart]');
  if (!svg || event.button !== 0) return;
  drag = { svg, last: svgPoint(svg, event), moved: false };
});
document.addEventListener('mousemove', (event) => {
  if (!drag) return;
  const p = svgPoint(drag.svg, event);
  state.view.zoom = applyDrag(state.view.zoom, { dx: p.x - drag.last.x, dy: p.y - drag.last.y });
  drag.last = p;
  drag.moved = true;
  applyTransform();
});
document.addEventListener('mouseup', (event) => {
  if (drag && !drag.moved) {
    const dot = event.target.closest?.('circle[data-claim]');
    if (dot) select(dot.dataset.claim);
  }
  drag = null;
});
document.addEventListener('dblclick', (event) => {
  if (!event.target.closest?.('svg[data-chart]')) return;
  state.view.zoom = reset();
  applyTransform();
});

// ---- panel splitter --------------------------------------------------------
let splitting = null;
$('#splitter').addEventListener('mousedown', (e) => {
  splitting = { x: e.clientX, w: $('#panel').getBoundingClientRect().width };
  e.preventDefault();
});
document.addEventListener('mousemove', (e) => {
  if (!splitting) return;
  const w = Math.max(380, Math.min(window.innerWidth - 700, splitting.w - (e.clientX - splitting.x)));
  document.documentElement.style.setProperty('--panel-width', `${w}px`);
});
document.addEventListener('mouseup', () => (splitting = null));

// ---- boot ------------------------------------------------------------------
(async () => {
  render();
  try {
    state.ghOk = await desk.ghReady();
  } catch {
    state.ghOk = false;
  }
  const board = await desk.getBoard();
  if (board) {
    state.board = board;
    state.connection = board.connection;
    if (board.queue.length) state.view.selectedId = board.queue[0];
    render();
  }
})();
