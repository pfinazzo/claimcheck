/**
 * The page: holds the state, draws the board or the wizard, and turns clicks into calls on
 * `window.desk`. Everything is built with DOM calls (see dom.ts), never innerHTML.
 *
 * @author Patrick Finazzo
 */

import type { PublicRun } from '../lib/fixer.ts';
import type { RunUpdate } from '../shared/ipc.ts';
import { toBridgeFailure } from '../shared/ipc.ts';
import { DEFAULT_THEME_CHOICE } from '../shared/theme.ts';
import type { Board, ConnectionSummary, ViewName } from '../shared/types.ts';
import type { WizardState } from '../shared/wizard-state.ts';
import { renderBoard, type BoardActions, type BoardUi } from './board.ts';
import { showCodeDialog } from './code-dialog.ts';
import { connectDialog, openDialog, showTrustDialog, type DialogHost } from './dialogs.ts';
import { DEMO_FIX, buildDemoGraphBoard, buildDemoProposeRun, runDemoWizard } from './demo.ts';
import { makeElement, mount, type Child } from './dom.ts';
import { showGithubDialog } from './github-dialog.ts';
import { refreshConfidenceMapTheme, drawConfidenceMap } from './graph-view.ts';
import { createScene } from './scene.ts';
import { renderWizard, type WizardCtx } from './wizard.ts';

const desk = window.desk;
const app = document.getElementById('app') as HTMLElement;
const dialog = document.getElementById('dialog') as HTMLDialogElement;
const toastEl = document.getElementById('toast') as HTMLElement;

const isReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const demoParam = new URLSearchParams(window.location.search).get('demo');

const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');
const sceneCanvas = document.getElementById('scene') as HTMLCanvasElement | null;
const scene = sceneCanvas ? createScene({ canvas: sceneCanvas, reducedMotion: isReducedMotion, theme: darkScheme.matches ? 'dark' : 'light' }) : null;
darkScheme.addEventListener('change', (event) => {
  scene?.setTheme(event.matches ? 'dark' : 'light');
  refreshConfidenceMapTheme();
});

const ui: BoardUi = { board: null, mode: 'list', selectedId: null, runs: new Map(), ghOk: false, theme: DEFAULT_THEME_CHOICE, running: false, drawer: { open: false, status: '', lines: [] } };
// What the page is showing right now, and its pending timers.
const page: { view: ViewName; wizard: WizardState | null; connection: ConnectionSummary | null; wasSignalled: boolean; toastTimer: number; saveTimer: number; shownBefore: string; didDemoAction: boolean } = {
  view: 'empty',
  wizard: null,
  connection: null,
  wasSignalled: false,
  toastTimer: 0,
  saveTimer: 0,
  shownBefore: '',
  didDemoAction: false,
};

/** What to tell the person about a failure. The bridge rejects with a plain object, so an Error is not the only shape. */
const renderMessage = ({ error }: { error: unknown }): string => toBridgeFailure({ error }).message;

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

const renderDialog = ({ title, body, isWide }: { title: string; body: readonly Child[]; isWide: boolean }): void => {
  dialog.classList.toggle('wide', isWide);
  mount({ parent: dialog, children: [makeElement({ tag: 'div', props: { class: 'dialog-head' }, children: [makeElement({ tag: 'h2', props: {}, children: [title] }), makeElement({ tag: 'button', props: { class: 'btn ghost', attrs: { type: 'button', 'aria-label': 'Close' }, on: { click: () => dialog.close() } }, children: ['Close'] })] }), makeElement({ tag: 'div', props: { class: 'dialog-body' }, children: [...body] })] });
  if (!dialog.open) dialog.showModal();
};

const host: DialogHost = {
  show: (title, ...body) => renderDialog({ title, body, isWide: false }),
  showWide: (title, ...body) => renderDialog({ title, body, isWide: true }),
  isOpen: () => dialog.open,
  close: () => dialog.close(),
  toast,
};

// ---- drawing ---------------------------------------------------------------------
const readScroll = ({ sel }: { sel: string }): number => document.querySelector(sel)?.scrollTop ?? 0;

/**
 * The panel's entrance animation plays only when what it shows changes: a new view, or a different
 * claim. A run update rebuilds the same panel many times a minute, and replaying it then flashes.
 */
const applyEntrance = (): void => {
  const showing = page.view === 'wizard' ? `wizard:${page.wizard?.step ?? ''}` : `board:${ui.selectedId ?? ''}`;
  if (showing === page.shownBefore) return;
  page.shownBefore = showing;
  document.querySelector('.detail, .wizard')?.classList.add('is-entering');
};

const renderAll = (): void => {
  if (page.view === 'wizard' && page.wizard) {
    renderWizard({ context: wizardCtx, mountInto: app });
  } else {
    const claimsTop = readScroll({ sel: '.claims' });
    const detailTop = readScroll({ sel: '.detail' });
    const graphTop = readScroll({ sel: '.graph-view' });
    mount({ parent: app, children: [...(renderBoard({ ui, actions: boardActions }))] });
    const claims = document.querySelector('.claims');
    const detail = document.querySelector('.detail');
    const graph = document.querySelector('.graph-view');
    if (claims) claims.scrollTop = claimsTop;
    if (detail) detail.scrollTop = detailTop;
    if (graph) graph.scrollTop = graphTop;
    if (graph) drawConfidenceMap({ ui, onSelect: (id) => select({ id }), reducedMotion: isReducedMotion });
  }
  applyEntrance();
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
    const failure = toBridgeFailure({ error });
    if (failure.code !== 'needs-trust') throw error;
    const details = failure.details as { commands?: readonly { label: string; command: string }[] } | null;
    showTrustDialog({ host, commands: details?.commands ?? [], onTrust: () => {
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
  connectGithub: () => showGithubDialog({ desk, host, onStatus: (status) => onGithubStatus({ status }) }),
  inspect: (claimId) => runGuarded({ callback: async () => { showCodeDialog({ host, fix: await desk.inspectFix({ claimId }) }); } }),
  setMode: ({ mode }) => {
    ui.mode = mode;
    renderAll();
  },
  setTheme: ({ choice }) => runGuarded({ callback: async () => {
    ui.theme = await desk.setTheme({ choice });
    renderAll();
  } }),
  showClaim: ({ id }) => {
    ui.selectedId = id;
    ui.mode = 'list';
    renderAll();
  },
  runClaimcheck: () => runGuarded({ callback: () => runWithTrust({ call: async (trust) => { await desk.runClaimcheck({ trust }); } }) }),
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
/** Heard from the GitHub dialog on every status, so Open pull request enables when sign-in finishes. */
const onGithubStatus = ({ status }: { status: { isSignedIn: boolean } }): void => {
  if (ui.ghOk === status.isSignedIn) return;
  ui.ghOk = status.isSignedIn;
  if (page.view === 'board') renderAll();
};

/** What `--view board:trust|github|code|open|propose|graph` screenshots do once the board is drawn: show what they name. */
const DEMO_ACTIONS = new Map<string, () => void>([
  ['board:trust', () => boardActions.runClaimcheck()],
  ['board:github', () => boardActions.connectGithub()],
  ['board:open', () => boardActions.openRepo()],
  ['board:code', () => showCodeDialog({ host, fix: DEMO_FIX })],
  [
    'board:propose',
    () => {
      const claimId = ui.selectedId ?? '';
      ui.runs.set(claimId, buildDemoProposeRun({ claimId }));
      renderAll();
    },
  ],
  [
    'board:graph',
    () => {
      ui.mode = 'graph';
      ui.selectedId = 'c6';
      renderAll();
    },
  ],
]);

const runDemoAction = (): void => {
  const action = DEMO_ACTIONS.get(demoParam ?? '');
  if (!action || page.didDemoAction) return;
  page.didDemoAction = true;
  window.setTimeout(action, 0);
};

const applyBoard = ({ board: fresh }: { board: Board }): void => {
  // `--view board:graph` adds sample claims, and every refresh of the board would otherwise remove them.
  const board = demoParam === 'board:graph' ? buildDemoGraphBoard({ board: fresh }) : fresh;
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
  runDemoAction();
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

// ---- coming back to the window --------------------------------------------------------
// A remote added or a gh sign-in done in a terminal is picked up here, so a disabled button
// that explained itself enables without a restart.
const refreshOnFocus = async (): Promise<void> => {
  if (page.view !== 'board' || !ui.board) return;
  try {
    ui.ghOk = await desk.ghReady();
    const board = await desk.getBoard();
    if (board) applyBoard({ board });
    renderAll();
  } catch {
    // The repo was busy or closing when the window was focused; the next focus tries again.
    return;
  }
};

window.addEventListener('focus', () => void refreshOnFocus());

// ---- boot ---------------------------------------------------------------------------
const startApp = async (): Promise<void> => {
  try {
    ui.theme = await desk.getTheme();
  } catch {
    ui.theme = DEFAULT_THEME_CHOICE;
  }
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
