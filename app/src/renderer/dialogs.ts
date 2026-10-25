/**
 * The three small dialogs: open a repo, connect Claude, and "this repo can run commands".
 *
 * @author Patrick Finazzo
 */

import type { DeskBridge } from '../shared/ipc.ts';
import type { ConnectionSummary } from '../shared/types.ts';
import { h, mount, type Child } from './dom.ts';

export type DialogHost = {
  /** Fills the dialog and shows it. */
  show: (title: string, ...body: Child[]) => void;
  close: () => void;
  toast: (text: string, bad?: boolean) => void;
};

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-haiku-5-5'];

const btn = (label: string, onClick: () => void, cls = ''): HTMLButtonElement => h('button', { class: `btn ${cls}`.trim(), attrs: { type: 'button' }, on: { click: onClick } }, label);
const field = (label: string, ...c: Child[]): HTMLElement => h('label', { class: 'field' }, h('span', {}, label), ...c);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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
  host.show(
    'Open a repository',
    btn('Choose a folder…', () => void open(), 'primary'),
    recents.length ? h('p', { class: 'muted' }, 'Recent') : h('p', { class: 'muted' }, 'No recent repositories yet.'),
    h('div', { class: 'stack' }, ...recents.map((p) => btn(p, () => void open(p)))),
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

export const trustDialog = (host: DialogHost, commands: { label: string; command: string }[], onTrust: () => void): void => {
  host.show(
    'This repo can run commands on your computer',
    h('p', { class: 'muted' }, 'Its config and claims name these commands, and running a check or a fix runs them. Read them before you go on. If they change later, you are asked again.'),
    h('ul', { class: 'plain' }, ...commands.map((c) => h('li', {}, h('strong', {}, `${c.label}: `), h('code', {}, c.command)))),
    h('div', { class: 'row' }, btn('Run them', onTrust, 'primary'), btn('Cancel', host.close)),
  );
};

export const clearDialog = (el: HTMLElement): void => mount(el);
