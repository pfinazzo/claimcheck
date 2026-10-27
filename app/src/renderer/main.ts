/**
 * The page: holds the state, draws the board or the wizard, and turns clicks into calls on
 * `window.desk`. Everything is built with DOM calls (see dom.ts), never innerHTML.
 *
 * @author Patrick Finazzo
 */

import type { PublicRun } from '../lib/fixer.ts';
import type { RunUpdate } from '../shared/ipc.ts';
import { toBridgeFailure } from '../shared/ipc.ts';
import type { Board, ConnectionSummary, ViewName } from '../shared/types.ts';
import type { WizardState } from '../shared/wizard-state.ts';
import { renderBoard, type BoardActions, type BoardUi } from './board.ts';
import { codeDialog, connectDialog, githubDialog, openDialog, trustDialog, type DialogHost } from './dialogs.ts';
import { DEMO_FIX, demoGraphBoard, demoProposeRun, demoWizard } from './demo.ts';
import { h, mount, type Child } from './dom.ts';
import { refreshConfidenceMapTheme, syncConfidenceMap } from './graph-view.ts';
import { createScene } from './scene.ts';
import { renderWizard, type WizardCtx } from './wizard.ts';

const desk = window.desk;
const app = document.getElementById('app') as HTMLElement;
const dialog = document.getElementById('dialog') as HTMLDialogElement;
const toastEl = document.getElementById('toast') as HTMLElement;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const demoParam = new URLSearchParams(window.location.search).get('demo');
const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');
const sceneCanvas = document.getElementById('scene') as HTMLCanvasElement | null;
const scene = sceneCanvas ? createScene({ canvas: sceneCanvas, reducedMotion, theme: darkScheme.matches ? 'dark' : 'light' }) : null;
darkScheme.addEventListener('change', (event) => {
  scene?.setTheme(event.matches ? 'dark' : 'light');
  refreshConfidenceMapTheme();
});


const ui: BoardUi = { board: null, mode: 'list', selectedId: null, runs: new Map(), ghOk: false, running: false, drawer: { open: false, status: '', lines: [] } };
let view: ViewName = 'empty';
let wizard: WizardState | null = null;
let connection: ConnectionSummary | null = null;
let signalled = false;

const message = (e: unknown): string => toBridgeFailure(e).message;

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

const fillDialog = ({ title, body, isWide }: { title: string; body: Child[]; isWide: boolean }): void => {
  dialog.classList.toggle('wide', isWide);
  mount(dialog, h('div', { class: 'dialog-head' }, h('h2', {}, title), h('button', { class: 'btn ghost', attrs: { type: 'button', 'aria-label': 'Close' }, on: { click: () => dialog.close() } }, 'Close')), h('div', { class: 'dialog-body' }, ...body));
  if (!dialog.open) dialog.showModal();
};

const host: DialogHost = {
  show: (title, ...body) => fillDialog({ title, body, isWide: false }),
  showWide: (title, ...body) => fillDialog({ title, body, isWide: true }),
  isOpen: () => dialog.open,
  close: () => dialog.close(),
  toast,
};

// ---- drawing ---------------------------------------------------------------------
const scrollOf = (sel: string): number => document.querySelector(sel)?.scrollTop ?? 0;

/**
 * The panel's entrance animation plays only when what it shows changes: a new view, or a different
 * claim. A run update rebuilds the same panel many times a minute, and replaying it then flashes.
 */
let shownBefore = '';
const markEntering = (): void => {
  const showing = view === 'wizard' ? `wizard:${wizard?.step ?? ''}` : `board:${ui.selectedId ?? ''}`;
  if (showing === shownBefore) return;
  shownBefore = showing;
  document.querySelector('.detail, .wizard')?.classList.add('is-entering');
};

const renderAll = (): void => {
  if (view === 'wizard' && wizard) {
    renderWizard(wizardCtx, app);
  } else {
    const claimsTop = scrollOf('.claims');
    const detailTop = scrollOf('.detail');
    const graphTop = scrollOf('.graph-view');
    mount(app, ...(renderBoard(ui, boardActions) as Child[]));
    const claims = document.querySelector('.claims');
    const detail = document.querySelector('.detail');
    const graph = document.querySelector('.graph-view');
    if (claims) claims.scrollTop = claimsTop;
    if (detail) detail.scrollTop = detailTop;
    if (graph) graph.scrollTop = graphTop;
    if (graph) syncConfidenceMap({ ui, onSelect: select, reducedMotion });
  }
  markEntering();
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
    const failure = toBridgeFailure(e);
    if (failure.code !== 'needs-trust') throw e;
    const details = failure.details as { commands?: { label: string; command: string }[] } | null;
    trustDialog(host, details?.commands ?? [], () => {
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
  setMode: (mode) => {
    ui.mode = mode;
    renderAll();
  },
  showClaim: (id) => {
    ui.selectedId = id;
    ui.mode = 'list';
    renderAll();
  },
  connectGithub: () => githubDialog(desk, host, onGithubStatus),
  inspect: (claimId) => guard(async () => { codeDialog(host, await desk.inspectFix({ claimId })); }),
  runClaimcheck: () => guard(() => withTrust(async (trust) => { await desk.runClaimcheck({ trust }); })),
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
/** What `--view board:trust|github|code` screenshots do once the board is drawn: open the dialog they show. */
const DEMO_ACTIONS: Record<string, () => void> = {
  'board:trust': () => boardActions.runClaimcheck(),
  'board:github': () => boardActions.connectGithub(),
  'board:open': () => boardActions.openRepo(),
  'board:graph': () => {
    ui.mode = 'graph';
    ui.selectedId = 'c6';
    renderAll();
  },
  'board:propose': () => {
    const claimId = ui.selectedId ?? '';
    ui.runs.set(claimId, demoProposeRun(claimId));
    renderAll();
  },
  'board:code': () => codeDialog(host, DEMO_FIX),
};
let didDemoAction = false;
const runDemoAction = (): void => {
  const action = DEMO_ACTIONS[demoParam ?? ''];
  if (!action || didDemoAction) return;
  didDemoAction = true;
  window.setTimeout(action, 0);
};

/** Heard from the GitHub dialog on every status, so Open pull request enables when sign-in finishes. */
const onGithubStatus = (status: { isSignedIn: boolean }): void => {
  if (ui.ghOk === status.isSignedIn) return;
  ui.ghOk = status.isSignedIn;
  if (view === 'board') renderAll();
};

const applyBoard = (fresh: Board): void => {
  // `--view board:graph` adds sample claims, and every refresh of the board would otherwise remove them.
  const board = demoParam === 'board:graph' ? demoGraphBoard(fresh) : fresh;
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
  runDemoAction();
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

// ---- coming back to the window --------------------------------------------------------
// A remote added or a gh sign-in done in a terminal is picked up here, so a disabled button
// that explained itself enables without a restart.
window.addEventListener('focus', () => {
  if (view !== 'board' || !ui.board) return;
  void (async () => {
    ui.ghOk = await desk.ghReady().catch(() => false);
    const board = await desk.getBoard();
    if (board) applyBoard(board);
    renderAll();
  })().catch(() => {});
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
