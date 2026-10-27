/**
 * The small dialogs: open a repo, connect Claude, connect GitHub, "this repo can run commands",
 * and the code viewer for a fix.
 *
 * @author Patrick Finazzo
 */

import type { DeskBridge } from '../shared/ipc.ts';
import { toBridgeFailure } from '../shared/ipc.ts';
import type { DiffFile } from '../shared/diff.ts';
import type { ConnectionSummary } from '../shared/types.ts';
import { h, mount, type Child } from './dom.ts';

export type DialogHost = {
  /** Fills the dialog and shows it. */
  show: (title: string, ...body: Child[]) => void;
  /** Like show, in a dialog wide enough for code. */
  showWide: (title: string, ...body: Child[]) => void;
  isOpen: () => boolean;
  close: () => void;
  toast: (text: string, bad?: boolean) => void;
};

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-haiku-5-5'];

const btn = (label: string, onClick: () => void, cls = ''): HTMLButtonElement => h('button', { class: `btn ${cls}`.trim(), attrs: { type: 'button' }, on: { click: onClick } }, label);
const field = (label: string, ...c: Child[]): HTMLElement => h('label', { class: 'field' }, h('span', {}, label), ...c);
const message = (e: unknown): string => toBridgeFailure(e).message;

export const openDialog = async (desk: DeskBridge, host: DialogHost, onOpened: () => void): Promise<void> => {
  const recents = await desk.recents();
  const open = async (path?: string): Promise<void> => {
    try {
      const res = await desk.openRepo(path === undefined ? {} : { path });
      if (!res.ok) throw new Error(res.error);
      host.close();
      onOpened();
    } catch (e) {
      host.toast(message(e), true);
    }
  };
  // A pasted path often arrives wrapped in quotes ("Copy as path" on Windows does that).
  const openTyped = (value: string): void => void open(value.trim().replace(/^"(.*)"$/, '$1'));
  const pathInput = h('input', {
    attrs: { type: 'text', id: 'repo-path', placeholder: 'C:\\Users\\you\\code\\my-project', autocomplete: 'off' },
    on: { keydown: (event) => { if ((event as KeyboardEvent).key === 'Enter') openTyped(pathInput.value); } },
  });
  host.show(
    'Open a repository',
    h('p', { class: 'muted' }, 'Pick any git repository on this computer. If it is not set up for claimcheck yet, Desk walks you through it.'),
    btn('Choose a folder…', () => void open(), 'primary'),
    h('label', { class: 'field', attrs: { for: 'repo-path' } }, h('span', {}, 'Or paste a folder path'), h('div', { class: 'row' }, pathInput, btn('Open', () => openTyped(pathInput.value)))),
    recents.length ? h('h3', {}, 'Recent') : h('p', { class: 'muted' }, 'No recent repositories yet.'),
    h(
      'div',
      { class: 'stack' },
      ...recents.map((folder) => h('button', { class: 'btn recent', attrs: { type: 'button' }, on: { click: () => void open(folder) } }, h('strong', {}, folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder), h('span', { class: 'muted' }, folder))),
    ),
  );
};

export const connectDialog = (desk: DeskBridge, host: DialogHost, current: ConnectionSummary | null, tab?: 'cli' | 'api'): void => {
  const c: ConnectionSummary = current ?? { mode: 'cli', model: 'claude-opus-5-5', cliPath: null, cliOk: null, apiSaved: false, apiLast4: null, apiOk: null, claimcheckBin: null, useAuto: false };
  const active = tab ?? c.mode;
  const again = async (): Promise<void> => connectDialog(desk, host, await desk.connect({}), active);
  const guard = (fn: () => Promise<void>) => (): void => {
    fn().catch((e) => host.toast(message(e), true));
  };

  const cliStatus = h('p', { class: 'muted' }, c.cliPath ? `Found at ${c.cliPath}.` : 'Claude Code was not found yet.', c.cliOk === true ? ' Signed in.' : c.cliOk === false ? ' Not signed in.' : '');
  const cliPath = h('input', { attrs: { type: 'text', value: c.cliPath ?? '', placeholder: 'Detected automatically' } });
  const keyInput = h('input', { attrs: { type: 'password', autocomplete: 'off', placeholder: c.apiSaved ? `Saved. Ends in ${c.apiLast4 ?? ''}` : 'sk-ant-…' } });
  const keyStatus = h('p', { class: 'muted' }, c.apiSaved ? `A key is saved (ends in ${c.apiLast4 ?? ''}).` : 'No key saved.', c.apiOk === true ? ' It works.' : c.apiOk === false ? ' It did not work.' : '');
  const model = h('select', { attrs: { 'aria-label': 'Model' } }, ...MODELS.map((m) => h('option', { attrs: { value: m, selected: m === c.model } }, m)));
  const mode = h('select', { attrs: { 'aria-label': 'Use for Fix this' } }, h('option', { attrs: { value: 'cli', selected: active === 'cli' } }, 'Claude Code'), h('option', { attrs: { value: 'api', selected: active === 'api' } }, 'API key'));

  const cliPane = h(
    'div',
    {},
    h('p', { class: 'muted' }, 'Uses your own Claude Code sign-in. Proposals run read-only. Fixes run in a separate worktree with a short list of allowed tools.'),
    field('Claude Code location', h('div', { class: 'row' }, cliPath, btn('Detect', guard(async () => { await desk.connect({ action: 'detect' }); await again(); })))),
    cliStatus,
    h(
      'div',
      { class: 'row' },
      btn(
        'Test',
        guard(async () => {
          cliStatus.textContent = 'Testing…';
          const r = await desk.testConnection({ mode: 'cli' });
          cliStatus.textContent = r.ok ? 'Signed in.' : `${String(r.error ?? 'It did not work.')}${r.needsSignIn ? ' Press Sign in.' : ''}`;
        }),
        'primary',
      ),
      btn('Sign in', guard(async () => { await desk.connect({ action: 'sign-in' }); host.toast('A terminal opened for the sign-in. Press Test when it is done.'); })),
    ),
  );
  const apiPane = h(
    'div',
    {},
    h('p', { class: 'muted' }, "The key is encrypted with your operating system's keychain and never written in plain text. API mode can propose fixes but cannot edit your repo."),
    field('API key', h('div', { class: 'row' }, keyInput, btn('Save and test', guard(async () => {
      await desk.connect({ action: 'save-key', apiKey: keyInput.value, mode: 'api' });
      keyInput.value = '';
      keyStatus.textContent = 'Testing…';
      const r = await desk.testConnection({ mode: 'api' });
      await again();
      host.toast(r.ok ? 'The key works.' : String(r.error ?? 'The key did not work.'), !r.ok);
    }), 'primary'), c.apiSaved ? btn('Clear', guard(async () => { await desk.connect({ action: 'clear-key' }); await again(); })) : null)),
    keyStatus,
  );

  const tabs = h(
    'div',
    { class: 'tabs', attrs: { role: 'tablist' } },
    h('button', { class: `tab${active === 'cli' ? ' active' : ''}`, attrs: { type: 'button', role: 'tab' }, on: { click: () => connectDialog(desk, host, c, 'cli') } }, 'Claude Code'),
    h('button', { class: `tab${active === 'api' ? ' active' : ''}`, attrs: { type: 'button', role: 'tab' }, on: { click: () => connectDialog(desk, host, c, 'api') } }, 'API key'),
  );
  host.show(
    'Connect Claude',
    tabs,
    active === 'cli' ? cliPane : apiPane,
    field('Model', model),
    field('Use for Fix this', mode),
    btn(
      'Save',
      guard(async () => {
        await desk.connect({ mode: mode.value === 'api' ? 'api' : 'cli', model: model.value, ...(active === 'cli' && cliPath.value ? { cliPath: cliPath.value } : {}) });
        host.close();
        host.toast('Saved.');
      }),
      'primary',
    ),
  );
};

// ---- GitHub ---------------------------------------------------------------------------------

type GitHubView = Awaited<ReturnType<DeskBridge['githubStatus']>>;

const SIGN_IN_POLL_MS = 3000;
const SIGN_IN_POLL_LIMIT = 60;
const GITHUB_CLI_URL = 'https://cli.github.com';

const statusRow = (label: string, isOk: boolean, detail: string): HTMLElement =>
  h('li', {}, h('strong', {}, `${label} `), h('span', { class: isOk ? 'good' : 'error' }, isOk ? 'Yes. ' : 'No. '), h('span', { class: 'muted' }, detail));

/**
 * Checks that GitHub can work for the open repo and, when it cannot, starts the sign-in.
 * Pressing Sign in opens gh's own browser login in a terminal, and this window watches for it to
 * finish. `onStatus` hears every status so the board can enable Open pull request without a restart.
 */
export const githubDialog = (desk: DeskBridge, host: DialogHost, onStatus: (status: GitHubView) => void): void => {
  let polls = 0;

  const draw = (status: GitHubView | null, note = ''): void => {
    if (!status) {
      host.show('Connect GitHub', h('p', { class: 'working' }, 'Checking GitHub…'));
      return;
    }
    onStatus(status);
    const origin = status.origin ?? '';
    host.show(
      'Connect GitHub',
      h('p', { class: 'muted' }, 'Desk opens pull requests with the GitHub CLI. It never sees your password or token: gh signs in through your browser and keeps the login itself.'),
      h(
        'ul',
        { class: 'checklist' },
        statusRow('GitHub CLI', status.isInstalled, status.isInstalled ? 'gh is installed.' : 'gh was not found on this computer.'),
        statusRow('Signed in', status.isSignedIn, status.isSignedIn ? (status.account ? `As ${status.account}.` : 'gh has a login.') : 'gh has no login yet.'),
        statusRow('This repo', Boolean(origin), !status.hasRepo ? 'No repo is open.' : origin || 'It has no origin remote.'),
      ),
      status.blocker ? h('p', { class: 'muted' }, status.blocker) : h('p', { class: 'good' }, 'GitHub is ready. Open pull request will work for this repo.'),
      note ? h('p', { class: 'working', attrs: { role: 'status' } }, note) : null,
      h(
        'div',
        { class: 'row' },
        !status.isInstalled ? btn('Install the GitHub CLI', () => void desk.openPath({ target: GITHUB_CLI_URL }).catch((e) => host.toast(message(e), true)), 'primary') : null,
        status.isInstalled && !status.isSignedIn ? btn('Sign in with GitHub', () => void startSignIn(status), 'primary') : null,
        btn('Check again', () => void check()),
        btn('Close', host.close, 'ghost'),
      ),
    );
  };

  const check = async (): Promise<void> => {
    draw(null);
    try {
      draw(await desk.githubStatus());
    } catch (e) {
      host.toast(message(e), true);
    }
  };

  /** Asks again every few seconds while the dialog is open, until gh reports a login or the limit is reached. */
  const poll = (): void => {
    window.setTimeout(() => {
      if (!host.isOpen() || polls >= SIGN_IN_POLL_LIMIT) return;
      polls += 1;
      desk
        .githubStatus()
        .then((next) => (next.isSignedIn ? draw(next, '') : poll()))
        // One failed check must not end the wait: the next poll tries again, up to the limit.
        .catch(poll);
    }, SIGN_IN_POLL_MS);
  };

  const startSignIn = async (status: GitHubView): Promise<void> => {
    try {
      await desk.githubSignIn();
      polls = 0;
      draw(status, 'A terminal window opened. Finish signing in there and in your browser. This window updates by itself when it is done.');
      poll();
    } catch (e) {
      host.toast(message(e), true);
    }
  };

  void check();
};

// ---- the code viewer ----------------------------------------------------------------------------------

type InspectedFix = Awaited<ReturnType<DeskBridge['inspectFix']>>;

const CHANGE_WORDS: Record<DiffFile['change'], string> = { added: 'new', deleted: 'deleted', renamed: 'renamed', modified: 'changed', binary: 'binary' };
const LINE_SIGNS = { added: '+', removed: '-', context: ' ' } as const;
const LONGEST_FILE_VIEW_LINES = 3000;

const lineNumber = (n: number | null): string => (n === null ? '' : String(n));

const fileView = (file: DiffFile): HTMLElement => {
  if (file.change === 'binary') return h('p', { class: 'muted' }, 'This is a binary file, so there is no text to show.');
  if (file.hunks.length === 0) return h('p', { class: 'muted' }, 'The file changed, but git reports no lines to show (for example a mode change or a plain rename).');
  const shown = { count: 0 };
  const hunks = file.hunks.map((hunk) =>
    h(
      'div',
      { class: 'hunk' },
      h('div', { class: 'hunk-head' }, hunk.header),
      ...hunk.lines
        .filter(() => (shown.count += 1) <= LONGEST_FILE_VIEW_LINES)
        .map((line) =>
          h(
            'div',
            { class: `diff-line ${line.kind}` },
            h('span', { class: 'ln' }, lineNumber(line.oldNumber)),
            h('span', { class: 'ln' }, lineNumber(line.newNumber)),
            h('span', { class: 'sign' }, LINE_SIGNS[line.kind]),
            h('span', { class: 'src' }, line.text || ' '),
          ),
        ),
    ),
  );
  const isCut = shown.count > LONGEST_FILE_VIEW_LINES;
  return h('div', {}, ...hunks, isCut ? h('p', { class: 'muted' }, `This file has more than ${LONGEST_FILE_VIEW_LINES} changed lines. Open the worktree to read the rest.`) : null);
};

/** Shows what Claude committed for a fix: the files, then each file's changes with line numbers. Read only. */
export const codeDialog = (host: DialogHost, fix: InspectedFix): void => {
  const files = fix.diff.files;
  if (files.length === 0) {
    host.show('The code Claude wrote', h('p', { class: 'muted' }, `${fix.branch} has no changes compared with ${fix.base} yet.`));
    return;
  }
  const totals = files.reduce((acc, file) => ({ added: acc.added + file.added, removed: acc.removed + file.removed }), { added: 0, removed: 0 });
  const list = h('ul', { class: 'plain code-files' });
  const pane = h('div', { class: 'code-pane' });
  const state = { selected: 0 };

  const drawPane = (): void => {
    const file = files[state.selected];
    mount(pane, file ? h('div', {}, h('h3', {}, file.path), fileView(file)) : null);
    pane.scrollTop = 0;
  };
  const drawList = (): void =>
    mount(
      list,
      ...files.map((file, index) =>
        h(
          'li',
          {},
          h(
            'button',
            {
              class: `code-file${index === state.selected ? ' is-selected' : ''}`,
              attrs: { type: 'button', 'aria-pressed': index === state.selected },
              on: {
                click: () => {
                  state.selected = index;
                  drawList();
                  drawPane();
                },
              },
            },
            h('span', { class: 'code-file-name' }, file.path),
            h('span', { class: 'code-file-stats' }, `${CHANGE_WORDS[file.change]}  +${file.added} -${file.removed}`),
          ),
        ),
      ),
    );
  drawList();
  drawPane();

  host.showWide(
    'The code Claude wrote',
    h('p', { class: 'muted' }, `${fix.branch} compared with ${fix.base}: ${files.length} ${files.length === 1 ? 'file' : 'files'}, ${totals.added} lines added, ${totals.removed} removed. Nothing here can be edited.`),
    fix.diff.isTruncated ? h('p', { class: 'error' }, 'This change is large, so the end of it is not shown. Open the worktree to read all of it.') : null,
    fix.commits.length ? h('details', { class: 'more' }, h('summary', {}, `${fix.commits.length} ${fix.commits.length === 1 ? 'commit' : 'commits'}`), h('pre', { class: 'code' }, fix.commits.join('\n'))) : null,
    h('div', { class: 'code-view' }, h('nav', { class: 'code-list', attrs: { 'aria-label': 'Changed files' } }, list), pane),
  );
};

export const trustDialog = (host: DialogHost, commands: { label: string; command: string }[], onTrust: () => void): void => {
  host.show(
    'This repo can run commands on your computer',
    h('p', { class: 'muted' }, 'Its config and claims name these commands, and running a check or a fix runs them. Read them before you go on. If they change later, you are asked again.'),
    h('ul', { class: 'plain' }, ...commands.map((c) => h('li', {}, h('strong', {}, `${c.label}: `), h('code', {}, c.command)))),
    h('div', { class: 'row' }, btn('Run them', onTrust, 'primary'), btn('Cancel', host.close)),
  );
};

export const clearDialog = (el: HTMLElement): void => mount(el);
