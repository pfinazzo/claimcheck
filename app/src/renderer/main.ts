/**
 * The page: holds the state, draws the board or the wizard, and turns clicks into calls on
 * `window.desk`. Everything is built with DOM calls (see dom.ts), never innerHTML.
 *
 * @author Patrick Finazzo
 */

import type { PublicRun } from '../lib/fixer.ts';
import type { RunUpdate } from '../shared/ipc.ts';
import type { Board, ConnectionSummary, ViewName } from '../shared/types.ts';
import type { WizardState } from '../shared/wizard-state.ts';
import { renderBoard, type BoardActions, type BoardUi } from './board.ts';
import { connectDialog, openDialog, trustDialog, type DialogHost } from './dialogs.ts';
import { demoWizard } from './demo.ts';
import { h, mount, type Child } from './dom.ts';
import { renderWizard, type WizardCtx } from './wizard.ts';

const desk = window.desk;
const app = document.getElementById('app') as HTMLElement;
const dialog = document.getElementById('dialog') as HTMLDialogElement;
const toastEl = document.getElementById('toast') as HTMLElement;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const demoParam = new URLSearchParams(window.location.search).get('demo');

const ui: BoardUi = { board: null, selectedId: null, runs: new Map(), ghOk: false, running: false, drawer: { open: false, status: '', lines: [] } };
let view: ViewName = 'empty';
let wizard: WizardState | null = null;
let connection: ConnectionSummary | null = null;
let signalled = false;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---- toast and dialog host ------------------------------------------------------
let toastTimer = 0;
const toast = (text: string, bad = false): void => {
  toastEl.textContent = text;
  toastEl.className = `toast${bad ? ' bad' : ''}`;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
  }, bad ? 6000 : 2800);
};

const host: DialogHost = {
  show: (title, ...body) => {
    mount(dialog, h('div', { class: 'dialog-head' }, h('h2', {}, title), h('button', { class: 'btn ghost', attrs: { type: 'button', 'aria-label': 'Close' }, on: { click: () => dialog.close() } }, 'Close')), h('div', { class: 'dialog-body' }, ...body));
    if (!dialog.open) dialog.showModal();
  },
  close: () => dialog.close(),
  toast,
};

// ---- drawing ---------------------------------------------------------------------
const scrollOf = (sel: string): number => document.querySelector(sel)?.scrollTop ?? 0;

const renderAll = (): void => {
  if (view === 'wizard' && wizard) {
    renderWizard(wizardCtx, app);
  } else {
    const claimsTop = scrollOf('.claims');
    const detailTop = scrollOf('.detail');
    mount(app, ...(renderBoard(ui, boardActions) as Child[]));
    const claims = document.querySelector('.claims');
    const detail = document.querySelector('.detail');
    if (claims) claims.scrollTop = claimsTop;
    if (detail) detail.scrollTop = detailTop;
  }
  if (!signalled && (ui.board || wizard)) {
    signalled = true;
    requestAnimationFrame(() => desk.rendered());
  }
};

// ---- the wizard's context --------------------------------------------------------
let saveTimer = 0;
const wizardCtx: WizardCtx = {
  desk,
  state: () => wizard as WizardState,
  set: (next, options) => {
    wizard = next;
    if (!demoParam) {
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => void desk.wizardSave(next).catch(() => {}), 250);
    }
    if (options?.render !== false) renderAll();
  },
  connection: () => connection,
  refreshConnection: async () => {
    const v = await desk.getView();
    connection = v.connection;
    renderAll();
  },
  toast,
  openConnect: () => connectDialog(desk, host, connection),
  exit: () => {
    void (async () => {
      const res = await desk.wizardExit();
      if (!res.ok) {
        toast(res.error, true);
        return;
      }
      applyView(await desk.getView());
    })().catch((e) => toast(message(e), true));
  },
  reducedMotion,
};

// ---- the board's actions ---------------------------------------------------------
const guard = (fn: () => Promise<void>): void => {
  fn().catch((e) => toast(message(e), true));
};

/** Runs a call that may need the person to confirm the repo's commands first. */
const withTrust = async (call: (trust: boolean) => Promise<unknown>): Promise<void> => {
  try {
    await call(false);
  } catch (e) {
    const err = e as { code?: string; details?: { commands?: { label: string; command: string }[] } };
    if (err.code !== 'needs-trust') throw e;
    trustDialog(host, err.details?.commands ?? [], () => {
      host.close();
      guard(async () => {
        await call(true);
      });
    });
  }
};

const select = (id: string | null): void => {
  ui.selectedId = id;
  renderAll();
};

const boardActions: BoardActions = {
  select,
  openRepo: () => guard(() => openDialog(desk, host, () => { ui.selectedId = null; })),
  connectClaude: () => connectDialog(desk, host, connection),
  connect: () => connectDialog(desk, host, connection),
  runClaimcheck: () => guard(() => withTrust(async (trust) => { ui.drawer.open = true; await desk.runClaimcheck({ trust }); })),
  writeSpec: () => guard(async () => { await desk.wizardStart({ entry: 'board' }); applyView(await desk.getView()); }),
  closeDrawer: () => {
    ui.drawer.open = false;
    renderAll();
  },
  fix: (claimId) => guard(async () => { ui.runs.set(claimId, await desk.startPropose({ claimId })); renderAll(); }),
  useApproach: (claimId, runId, choice) => guard(() => withTrust(async (trust) => { ui.runs.set(claimId, await desk.startImplement({ claimId, proposeRunId: runId, choice, trust })); renderAll(); })),
  copyPrompt: (claimId) => guard(async () => { await desk.copyPrompt({ claimId }); toast('Prompt copied. Paste it into any Claude Code session.'); }),
  copyImplement: (claimId, runId, choice) => guard(async () => { await desk.copyPrompt({ claimId, kind: 'implement', proposeRunId: runId, choice }); toast('Build prompt copied.'); }),
  copyText: (text) => guard(async () => { await navigator.clipboard.writeText(text); toast('Copied.'); }),
  acceptRisk: (claimId, note) => guard(async () => {
    if (!note.trim()) throw new Error('Write one line on why this risk is acceptable.');
    await desk.acceptRisk({ claimId, note: note.trim() });
    toast('Accepted. It leaves the queue and stays in the ledger.');
  }),
  openPr: (claimId, runId) => guard(async () => { const { url } = await desk.openPullRequest({ runId }); toast(`Pull request opened: ${url}`); void claimId; }),
  openPath: (target) => guard(async () => { await desk.openPath({ target }); }),
};

// ---- state coming from the main process ------------------------------------------
const applyBoard = (board: Board): void => {
  ui.board = board;
  connection = board.connection ?? connection;
  for (const run of (board.runs.fixes ?? []) as PublicRun[]) ui.runs.set(run.claimId, run);
  if (!ui.selectedId || !board.claims.some((c) => c.id === ui.selectedId)) ui.selectedId = board.queue[0] ?? board.claims[0]?.id ?? null;
};

const applyView = (v: Awaited<ReturnType<typeof desk.getView>>): void => {
  view = v.view;
  wizard = v.wizard;
  connection = v.connection;
  if (v.board) applyBoard(v.board);
  renderAll();
};

desk.onBoard((board) => {
  applyBoard(board);
  if (view === 'board') renderAll();
});
desk.onView(applyView);
desk.onRunUpdate((update: RunUpdate) => {
  if (update.type === 'run') {
    ui.runs.set(update.run.claimId, update.run);
    if (view === 'board') renderAll();
    return;
  }
  if (update.status === 'running') {
    ui.running = true;
    ui.drawer = { open: true, status: 'running…', lines: [] };
  }
  if (update.line) ui.drawer.lines.push(update.line);
  if (update.status === 'done') {
    ui.running = false;
    ui.drawer.status = `finished with exit code ${update.exitCode ?? 'unknown'}`;
  }
  if (view === 'board') renderAll();
});

// ---- keyboard: arrows move through the claims ------------------------------------
document.addEventListener('keydown', (event) => {
  const el = document.activeElement as HTMLElement | null;
  if (!el?.classList.contains('claim-row') || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
  const rows = [...document.querySelectorAll<HTMLElement>('.claim-row')];
  const at = rows.indexOf(el);
  const next = rows[at + (event.key === 'ArrowDown' ? 1 : -1)];
  if (next) {
    event.preventDefault();
    select(next.dataset.claim ?? null);
    document.querySelector<HTMLElement>(`.claim-row[data-claim="${CSS.escape(next.dataset.claim ?? '')}"]`)?.focus();
  }
});

// ---- boot ---------------------------------------------------------------------------
const boot = async (): Promise<void> => {
  if (demoParam?.startsWith('wizard:')) {
    const parts = demoParam.split(':');
    const step = Number(parts[1]);
    const beat = Number(parts[2] ?? '0');
    view = 'wizard';
    wizard = demoWizard(Number.isFinite(step) ? step : 1, beat);
    connection = { mode: 'cli', model: 'claude-opus-5-5', cliPath: 'C:/Users/dana/AppData/Roaming/npm/claude.cmd', cliOk: true, apiSaved: false, apiLast4: null, apiOk: null, claimcheckBin: null, useAuto: false };
    renderAll();
    return;
  }
  renderAll();
  try {
    ui.ghOk = await desk.ghReady();
  } catch {
    ui.ghOk = false;
  }
  applyView(await desk.getView());
};

void boot();
