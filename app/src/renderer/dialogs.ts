/**
 * The three small dialogs: open a repo, connect Claude, and "this repo can run commands".
 *
 * @author Patrick Finazzo
 */

import type { DeskBridge } from '../shared/ipc.ts';
import type { ConnectionSummary } from '../shared/types.ts';
import { makeElement, mount, type Child } from './dom.ts';
import { toText } from '../shared/text.ts';

export type DialogHost = {
  /** Fills the dialog and shows it. */
  show: (title: string, ...body: Child[]) => void;
  close: () => void;
  toast: (options: { text: string; bad?: boolean }) => void;
};

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-haiku-5-5'];

/** What the connection checks found; not checked yet shows nothing. */
const CLI_OK_TEXT = new Map<unknown, string>([
  [true, ' Signed in.'],
  [false, ' Not signed in.'],
]);
const API_OK_TEXT = new Map<unknown, string>([
  [true, ' It works.'],
  [false, ' It did not work.'],
]);

const renderButton = ({ label, onClick, cls = '' }: { label: string; onClick: () => void; cls?: string }): HTMLButtonElement => makeElement({ tag: 'button', props: { class: `btn ${cls}`.trim(), attrs: { type: 'button' }, on: { click: onClick } }, children: [label] });
const renderField = ({ label, list = [] }: { label: string; list?: readonly Child[] }): HTMLElement => makeElement({ tag: 'label', props: { class: 'field' }, children: [makeElement({ tag: 'span', props: {}, children: [label] }), ...list] });
const renderMessage = ({ error }: { error: unknown }): string => (error instanceof Error ? error.message : String(error));

export const openDialog = async ({ desk, host, onOpened }: { desk: DeskBridge; host: DialogHost; onOpened: () => void }): Promise<void> => {
  const recents = await desk.recents();
  const open = async ({ path }: { path?: string | undefined } = {}): Promise<void> => {
    try {
      const response = await desk.openRepo(path === undefined ? {} : { path });
      if (!response.ok) throw new Error(response.error);
      host.close();
      onOpened();
    } catch (error) {
      host.toast({ text: renderMessage({ error }), bad: true });
    }
  };
  host.show(
    'Open a repository',
    renderButton({ label: 'Choose a folder…', onClick: () => void open(), cls: 'primary' }),
    recents.length ? makeElement({ tag: 'p', props: { class: 'muted' }, children: ['Recent'] }) : makeElement({ tag: 'p', props: { class: 'muted' }, children: ['No recent repositories yet.'] }),
    makeElement({ tag: 'div', props: { class: 'stack' }, children: [...recents.map((text) => renderButton({ label: text, onClick: () => void open({ path: text }) }))] }),
  );
};

export const connectDialog = ({ desk, host, current, tab }: { desk: DeskBridge; host: DialogHost; current: ConnectionSummary | null; tab?: 'cli' | 'api' | undefined }): void => {
  const connectionSummary: ConnectionSummary = current ?? { mode: 'cli', model: 'claude-opus-5-5', cliPath: null, cliOk: null, apiSaved: false, apiLast4: null, apiOk: null, claimcheckBin: null, useAuto: false };
  const active = tab ?? connectionSummary.mode;
  const again = async (): Promise<void> => connectDialog({ desk, host, current: await desk.connect({}), tab: active });
  const guard = ({ callback }: { callback: () => Promise<void> }) => (): void => {
    callback().catch((error: unknown) => host.toast({ text: renderMessage({ error }), bad: true }));
  };

  const cliStatus = makeElement({ tag: 'p', props: { class: 'muted' }, children: [connectionSummary.cliPath ? `Found at ${connectionSummary.cliPath}.` : 'Claude Code was not found yet.', CLI_OK_TEXT.get(connectionSummary.cliOk) ?? ''] });
  const cliPath = makeElement({ tag: 'input', props: { attrs: { type: 'text', value: connectionSummary.cliPath ?? '', placeholder: 'Detected automatically' } } });
  const keyInput = makeElement({ tag: 'input', props: { attrs: { type: 'password', autocomplete: 'off', placeholder: connectionSummary.apiSaved ? `Saved. Ends in ${connectionSummary.apiLast4 ?? ''}` : 'sk-ant-…' } } });
  const keyStatus = makeElement({ tag: 'p', props: { class: 'muted' }, children: [connectionSummary.apiSaved ? `A key is saved (ends in ${connectionSummary.apiLast4 ?? ''}).` : 'No key saved.', API_OK_TEXT.get(connectionSummary.apiOk) ?? ''] });
  const model = makeElement({ tag: 'select', props: { attrs: { 'aria-label': 'Model' } }, children: [...MODELS.map((text) => makeElement({ tag: 'option', props: { attrs: { value: text, selected: text === connectionSummary.model } }, children: [text] }))] });
  const mode = makeElement({ tag: 'select', props: { attrs: { 'aria-label': 'Use for Fix this' } }, children: [makeElement({ tag: 'option', props: { attrs: { value: 'cli', selected: active === 'cli' } }, children: ['Claude Code'] }), makeElement({ tag: 'option', props: { attrs: { value: 'api', selected: active === 'api' } }, children: ['API key'] })] });

  const cliPane = makeElement({ tag: 'div', props: {}, children: [makeElement({ tag: 'p', props: { class: 'muted' }, children: ['Uses your own Claude Code sign-in. Proposals run read-only. Fixes run in a separate worktree with a short list of allowed tools.'] }), renderField({ label: 'Claude Code location', list: [makeElement({ tag: 'div', props: { class: 'row' }, children: [cliPath, renderButton({ label: 'Detect', onClick: guard({ callback: async () => { await desk.connect({ action: 'detect' }); await again(); } }) })] })] }), cliStatus, makeElement({ tag: 'div', props: { class: 'row' }, children: [renderButton({ label: 'Test', onClick: guard({ callback: async () => {
          cliStatus.textContent = 'Testing…';
          const rec = await desk.testConnection({ mode: 'cli' });
          cliStatus.textContent = rec.ok ? 'Signed in.' : `${toText({ value: rec.error, fallback: 'It did not work.' })}${rec.needsSignIn ? ' Press Sign in.' : ''}`;
        } }), cls: 'primary' }), renderButton({ label: 'Sign in', onClick: guard({ callback: async () => { await desk.connect({ action: 'sign-in' }); host.toast({ text: 'A terminal opened for the sign-in. Press Test when it is done.' }); } }) })] })] });
  const apiPane = makeElement({ tag: 'div', props: {}, children: [makeElement({ tag: 'p', props: { class: 'muted' }, children: ["The key is encrypted with your operating system's keychain and never written in plain text. API mode can propose fixes but cannot edit your repo."] }), renderField({ label: 'API key', list: [makeElement({ tag: 'div', props: { class: 'row' }, children: [keyInput, renderButton({ label: 'Save and test', onClick: guard({ callback: async () => {
      await desk.connect({ action: 'save-key', apiKey: keyInput.value, mode: 'api' });
      keyInput.value = '';
      keyStatus.textContent = 'Testing…';
      const rec = await desk.testConnection({ mode: 'api' });
      await again();
      host.toast({ text: rec.ok ? 'The key works.' : toText({ value: rec.error, fallback: 'The key did not work.' }), bad: !rec.ok });
    } }), cls: 'primary' }), connectionSummary.apiSaved ? renderButton({ label: 'Clear', onClick: guard({ callback: async () => { await desk.connect({ action: 'clear-key' }); await again(); } }) }) : null] })] }), keyStatus] });

  const tabs = makeElement({ tag: 'div', props: { class: 'tabs', attrs: { role: 'tablist' } }, children: [makeElement({ tag: 'button', props: { class: `tab${active === 'cli' ? ' active' : ''}`, attrs: { type: 'button', role: 'tab' }, on: { click: () => connectDialog({ desk, host, current: connectionSummary, tab: 'cli' }) } }, children: ['Claude Code'] }), makeElement({ tag: 'button', props: { class: `tab${active === 'api' ? ' active' : ''}`, attrs: { type: 'button', role: 'tab' }, on: { click: () => connectDialog({ desk, host, current: connectionSummary, tab: 'api' }) } }, children: ['API key'] })] });
  host.show(
    'Connect Claude',
    tabs,
    active === 'cli' ? cliPane : apiPane,
    renderField({ label: 'Model', list: [model] }),
    renderField({ label: 'Use for Fix this', list: [mode] }),
    renderButton({ label: 'Save', onClick: guard({ callback: async () => {
        await desk.connect({ mode: mode.value === 'api' ? 'api' : 'cli', model: model.value, ...(active === 'cli' && cliPath.value ? { cliPath: cliPath.value } : {}) });
        host.close();
        host.toast({ text: 'Saved.' });
      } }), cls: 'primary' }),
  );
};

export const showTrustDialog = ({ host, commands, onTrust }: { host: DialogHost; commands: readonly { label: string; command: string }[]; onTrust: () => void }): void => {
  host.show(
    'This repo can run commands on your computer',
    makeElement({ tag: 'p', props: { class: 'muted' }, children: ['Its config and claims name these commands, and running a check or a fix runs them. Read them before you go on. If they change later, you are asked again.'] }),
    makeElement({ tag: 'ul', props: { class: 'plain' }, children: [...commands.map((commandEntry) => makeElement({ tag: 'li', props: {}, children: [makeElement({ tag: 'strong', props: {}, children: [`${commandEntry.label}: `] }), makeElement({ tag: 'code', props: {}, children: [commandEntry.command] })] }))] }),
    makeElement({ tag: 'div', props: { class: 'row' }, children: [renderButton({ label: 'Run them', onClick: onTrust, cls: 'primary' }), renderButton({ label: 'Cancel', onClick: host.close })] }),
  );
};

export const showClearDialog = ({ element }: { element: HTMLElement }): void => mount({ parent: element });
