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
import { connectDialog, openDialog, showTrustDialog, type DialogHost } from './dialogs.ts';
import { runDemoWizard } from './demo.ts';
import { makeElement, mount } from './dom.ts';
import { renderWizard, type WizardCtx } from './wizard.ts';

const desk = window.desk;
const app = document.getElementById('app') as HTMLElement;
const dialog = document.getElementById('dialog') as HTMLDialogElement;
const toastEl = document.getElementById('toast') as HTMLElement;

const isReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const demoParam = new URLSearchParams(window.location.search).get('demo');

const ui: BoardUi = { board: null, selectedId: null, runs: new Map(), ghOk: false, running: false, drawer: { open: false, status: '', lines: [] } };
// What the page is showing right now, and its pending timers.
const page: { view: ViewName; wizard: WizardState | null; connection: ConnectionSummary | null; wasSignalled: boolean; toastTimer: number; saveTimer: number } = {
  view: 'empty',
  wizard: null,
  connection: null,
  wasSignalled: false,
  toastTimer: 0,
  saveTimer: 0,
};

const renderMessage = ({ error }: { error: unknown }): string => (error instanceof Error ? error.message : String(error));

// ---- toast and dialog host ------------------------------------------------------

const toast = ({ text, bad = false }: { text: string; bad?: boolean }): void => {
  toastEl.textContent = text;
  toastEl.className = `toast${bad ? ' bad' : ''}`;
  toastEl.hidden = false;
  window.clearTimeout(page.toastTimer);
  page.toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
  }, bad ? 6000 : 2800);
};

const host: DialogHost = {
  show: (title, ...body) => {
    mount({ parent: dialog, children: [makeElement({ tag: 'div', props: { class: 'dialog-head' }, children: [makeElement({ tag: 'h2', props: {}, children: [title] }), makeElement({ tag: 'button', props: { class: 'btn ghost', attrs: { type: 'button', 'aria-label': 'Close' }, on: { click: () => dialog.close() } }, children: ['Close'] })] }), makeElement({ tag: 'div', props: { class: 'dialog-body' }, children: [...body] })] });
    if (!dialog.open) dialog.showModal();
  },
  close: () => dialog.close(),
  toast,
};

// ---- drawing ---------------------------------------------------------------------
const readScroll = ({ sel }: { sel: string }): number => document.querySelector(sel)?.scrollTop ?? 0;

const renderAll = (): void => {
  if (page.view === 'wizard' && page.wizard) {
    renderWizard({ context: wizardCtx, mountInto: app });
  } else {
    const claimsTop = readScroll({ sel: '.claims' });
    const detailTop = readScroll({ sel: '.detail' });
    mount({ parent: app, children: [...(renderBoard({ ui, actions: boardActions }))] });
    const claims = document.querySelector('.claims');
    const detail = document.querySelector('.detail');
    if (claims) claims.scrollTop = claimsTop;
    if (detail) detail.scrollTop = detailTop;
  }
  if (!page.wasSignalled && (ui.board || page.wizard)) {
    page.wasSignalled = true;
    requestAnimationFrame(() => desk.rendered());
  }
};

// ---- the wizard's context --------------------------------------------------------

const wizardCtx: WizardCtx = {
  desk,
  state: () => page.wizard as WizardState,
  set: (next, options) => {
    page.wizard = next;
    if (!demoParam) {
      window.clearTimeout(page.saveTimer);
      page.saveTimer = window.setTimeout(() => void desk.wizardSave(next).catch(() => {}), 250);
    }
    if (options?.render !== false) renderAll();
  },
  connection: () => page.connection,
  refreshConnection: async () => {
    const value = await desk.getView();
    page.connection = value.connection;
    renderAll();
  },
  toast,
  openConnect: () => connectDialog({ desk, host, current: page.connection }),
  exit: () => {
    void (async () => {
      const response = await desk.wizardExit();
      if (!response.ok) {
        toast({ text: response.error, bad: true });
        return;
      }
      applyView({ value: await desk.getView() });
    })().catch((error: unknown) => toast({ text: renderMessage({ error }), bad: true }));
  },
  reducedMotion: isReducedMotion,
};

// ---- the board's actions ---------------------------------------------------------
const runGuarded = ({ callback }: { callback: () => Promise<void> }): void => {
  callback().catch((error: unknown) => toast({ text: renderMessage({ error }), bad: true }));
};

/** Runs a call that may need the person to confirm the repo's commands first. */
const runWithTrust = async ({ call }: { call: (trust: boolean) => Promise<unknown> }): Promise<void> => {
  try {
    await call(false);
  } catch (error) {
    const detailed = error as { code?: string; details?: { commands?: readonly { label: string; command: string }[] } };
    if (detailed.code !== 'needs-trust') throw error;
    showTrustDialog({ host, commands: detailed.details?.commands ?? [], onTrust: () => {
      host.close();
      runGuarded({ callback: async () => {
        await call(true);
      } });
    } });
  }
};

const select = ({ id }: { id: string | null }): void => {
  ui.selectedId = id;
  renderAll();
};

const boardActions: BoardActions = {
  select,
  openRepo: () => runGuarded({ callback: () => openDialog({ desk, host, onOpened: () => { ui.selectedId = null; } }) }),
  connectClaude: () => connectDialog({ desk, host, current: page.connection }),
  connect: () => connectDialog({ desk, host, current: page.connection }),
  runClaimcheck: () => runGuarded({ callback: () => runWithTrust({ call: async (trust) => { ui.drawer.open = true; await desk.runClaimcheck({ trust }); } }) }),
  writeSpec: () => runGuarded({ callback: async () => { await desk.wizardStart({ entry: 'board' }); applyView({ value: await desk.getView() }); } }),
  closeDrawer: () => {
    ui.drawer.open = false;
    renderAll();
  },
  fix: (claimId) => runGuarded({ callback: async () => { ui.runs.set(claimId, await desk.startPropose({ claimId })); renderAll(); } }),
  useApproach: (claimId, runId, choice) => runGuarded({ callback: () => runWithTrust({ call: async (trust) => { ui.runs.set(claimId, await desk.startImplement({ claimId, proposeRunId: runId, choice, trust })); renderAll(); } }) }),
  copyPrompt: (claimId) => runGuarded({ callback: async () => { await desk.copyPrompt({ claimId }); toast({ text: 'Prompt copied. Paste it into any Claude Code session.' }); } }),
  copyImplement: (claimId, runId, choice) => runGuarded({ callback: async () => { await desk.copyPrompt({ claimId, kind: 'implement', proposeRunId: runId, choice }); toast({ text: 'Build prompt copied.' }); } }),
  copyText: (text) => runGuarded({ callback: async () => { await navigator.clipboard.writeText(text); toast({ text: 'Copied.' }); } }),
  acceptRisk: (claimId, note) => runGuarded({ callback: async () => {
    if (!note.trim()) throw new Error('Write one line on why this risk is acceptable.');
    await desk.acceptRisk({ claimId, note: note.trim() });
    toast({ text: 'Accepted. It leaves the queue and stays in the ledger.' });
  } }),
  openPr: (claimId, runId) => runGuarded({ callback: async () => { const { url } = await desk.openPullRequest({ runId }); toast({ text: `Pull request opened: ${url}` }); void claimId; } }),
  openPath: (target) => runGuarded({ callback: async () => { await desk.openPath({ target }); } }),
};

// ---- state coming from the main process ------------------------------------------
const applyBoard = ({ board }: { board: Board }): void => {
  ui.board = board;
  page.connection = board.connection ?? page.connection;
  for (const run of (board.runs.fixes ?? []) as PublicRun[]) ui.runs.set(run.claimId, run);
  if (!ui.selectedId || !board.claims.some((claim) => claim.id === ui.selectedId)) ui.selectedId = board.queue[0] ?? board.claims[0]?.id ?? null;
};

const applyView = ({ value }: { value: Awaited<ReturnType<typeof desk.getView>> }): void => {
  page.view = value.view;
  page.wizard = value.wizard;
  page.connection = value.connection;
  if (value.board) applyBoard({ board: value.board });
  renderAll();
};

desk.onBoard((board) => {
  applyBoard({ board });
  if (page.view === 'board') renderAll();
});
desk.onView((value) => applyView({ value }));
desk.onRunUpdate((update: RunUpdate) => {
  if (update.type === 'run') {
    ui.runs.set(update.run.claimId, update.run);
    if (page.view === 'board') renderAll();
    return;
  }
  if (update.status === 'running') {
    ui.running = true;
    ui.drawer = { open: true, status: 'running…', lines: [] };
  }
  if (update.line) ui.drawer = { ...ui.drawer, lines: [...ui.drawer.lines, update.line] };
  if (update.status === 'done') {
    ui.running = false;
    ui.drawer.status = `finished with exit code ${update.exitCode ?? 'unknown'}`;
  }
  if (page.view === 'board') renderAll();
});

// ---- keyboard: arrows move through the claims ------------------------------------
document.addEventListener('keydown', (event) => {
  const element = document.activeElement as HTMLElement | null;
  if (!element?.classList.contains('claim-row') || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
  const rows = [...document.querySelectorAll<HTMLElement>('.claim-row')];
  const at = rows.indexOf(element);
  const next = rows[at + (event.key === 'ArrowDown' ? 1 : -1)];
  if (next) {
    event.preventDefault();
    select({ id: next.dataset.claim ?? null });
    document.querySelector<HTMLElement>(`.claim-row[data-claim="${CSS.escape(next.dataset.claim ?? '')}"]`)?.focus();
  }
});

// ---- boot ---------------------------------------------------------------------------
const startApp = async (): Promise<void> => {
  if (demoParam?.startsWith('wizard:')) {
    const parts = demoParam.split(':');
    const step = Number(parts[1]);
    const beat = Number(parts[2] ?? '0');
    page.view = 'wizard';
    page.wizard = runDemoWizard({ step: Number.isFinite(step) ? step : 1, beat });
    page.connection = { mode: 'cli', model: 'claude-opus-5-5', cliPath: 'C:/Users/dana/AppData/Roaming/npm/claude.cmd', cliOk: true, apiSaved: false, apiLast4: null, apiOk: null, claimcheckBin: null, useAuto: false };
    renderAll();
    return;
  }
  renderAll();
  try {
    ui.ghOk = await desk.ghReady();
  } catch {
    ui.ghOk = false;
  }
  applyView({ value: await desk.getView() });
};

void startApp();
