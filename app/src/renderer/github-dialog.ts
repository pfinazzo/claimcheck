/**
 * Why this file exists: the Connect GitHub dialog. It checks that GitHub can work for the open repo
 * and, when it cannot, starts the sign-in. Pressing Sign in opens gh's own browser login in a
 * terminal, and this window watches for it to finish. Desk never sees a password or a token.
 *
 * @author Patrick Finazzo
 */

import type { DeskBridge } from '../shared/ipc.ts';
import { renderButton, renderMessage, type DialogHost } from './dialogs.ts';
import { makeElement } from './dom.ts';

type GitHubView = Awaited<ReturnType<DeskBridge['githubStatus']>>;

const SIGN_IN_POLL_MS = 3000;
const SIGN_IN_POLL_LIMIT = 60;
const GITHUB_CLI_URL = 'https://cli.github.com';

const waitMs = ({ ms }: { ms: number }): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const renderStatusRow = ({ label, isOk, detail }: { label: string; isOk: boolean; detail: string }): HTMLElement =>
  makeElement({
    tag: 'li',
    props: {},
    children: [makeElement({ tag: 'strong', props: {}, children: [`${label} `] }), makeElement({ tag: 'span', props: { class: isOk ? 'good' : 'error' }, children: [isOk ? 'Yes. ' : 'No. '] }), makeElement({ tag: 'span', props: { class: 'muted' }, children: [detail] })],
  });

const describeSignedIn = ({ status }: { status: GitHubView }): string => {
  if (!status.isSignedIn) return 'gh has no login yet.';
  return status.account ? `As ${status.account}.` : 'gh has a login.';
};

const describeRepo = ({ status }: { status: GitHubView }): string => {
  if (!status.hasRepo) return 'No repo is open.';
  return status.origin || 'It has no origin remote.';
};

/**
 * Checks that GitHub can work for the open repo and, when it cannot, starts the sign-in.
 * `onStatus` hears every status so the board can enable Open pull request without a restart.
 */
export const showGithubDialog = ({ desk, host, onStatus }: { desk: DeskBridge; host: DialogHost; onStatus: (status: GitHubView) => void }): void => {
  const draw = ({ status, note = '' }: { status: GitHubView | null; note?: string }): void => {
    if (!status) {
      host.show('Connect GitHub', makeElement({ tag: 'p', props: { class: 'working' }, children: ['Checking GitHub…'] }));
      return;
    }
    onStatus(status);
    host.show(
      'Connect GitHub',
      makeElement({ tag: 'p', props: { class: 'muted' }, children: ['Desk opens pull requests with the GitHub CLI. It never sees your password or token: gh signs in through your browser and keeps the login itself.'] }),
      makeElement({
        tag: 'ul',
        props: { class: 'checklist' },
        children: [
          renderStatusRow({ label: 'GitHub CLI', isOk: status.isInstalled, detail: status.isInstalled ? 'gh is installed.' : 'gh was not found on this computer.' }),
          renderStatusRow({ label: 'Signed in', isOk: status.isSignedIn, detail: describeSignedIn({ status }) }),
          renderStatusRow({ label: 'This repo', isOk: Boolean(status.origin), detail: describeRepo({ status }) }),
        ],
      }),
      status.blocker ? makeElement({ tag: 'p', props: { class: 'muted' }, children: [status.blocker] }) : makeElement({ tag: 'p', props: { class: 'good' }, children: ['GitHub is ready. Open pull request will work for this repo.'] }),
      note ? makeElement({ tag: 'p', props: { class: 'working', attrs: { role: 'status' } }, children: [note] }) : null,
      makeElement({
        tag: 'div',
        props: { class: 'row' },
        children: [
          status.isInstalled ? null : renderButton({ label: 'Install the GitHub CLI', onClick: () => void desk.openPath({ target: GITHUB_CLI_URL }).catch((error: unknown) => host.toast({ text: renderMessage({ error }), bad: true })), cls: 'primary' }),
          status.isInstalled && !status.isSignedIn ? renderButton({ label: 'Sign in with GitHub', onClick: () => void startSignIn({ status }), cls: 'primary' }) : null,
          renderButton({ label: 'Check again', onClick: () => void check() }),
          renderButton({ label: 'Close', onClick: host.close, cls: 'ghost' }),
        ],
      }),
    );
  };

  const check = async (): Promise<void> => {
    draw({ status: null });
    try {
      draw({ status: await desk.githubStatus() });
    } catch (error) {
      host.toast({ text: renderMessage({ error }), bad: true });
    }
  };

  /** One status check while waiting for the sign-in. A failed check is not the end of the wait, so it reads as "not signed in yet". */
  const checkOnce = async (): Promise<GitHubView | null> => {
    try {
      return await desk.githubStatus();
    } catch {
      return null;
    }
  };

  /** Asks again every few seconds while the dialog is open, until gh reports a login or the attempts run out. */
  const pollForSignIn = async ({ attemptsLeft }: { attemptsLeft: number }): Promise<void> => {
    if (attemptsLeft <= 0 || !host.isOpen()) return;
    await waitMs({ ms: SIGN_IN_POLL_MS });
    if (!host.isOpen()) return;
    const next = await checkOnce();
    if (next?.isSignedIn) {
      draw({ status: next });
      return;
    }
    await pollForSignIn({ attemptsLeft: attemptsLeft - 1 });
  };

  const startSignIn = async ({ status }: { status: GitHubView }): Promise<void> => {
    try {
      await desk.githubSignIn();
    } catch (error) {
      host.toast({ text: renderMessage({ error }), bad: true });
      return;
    }
    draw({ status, note: 'A terminal window opened. Finish signing in there and in your browser. This window updates by itself when it is done.' });
    await pollForSignIn({ attemptsLeft: SIGN_IN_POLL_LIMIT });
  };

  void check();
};
