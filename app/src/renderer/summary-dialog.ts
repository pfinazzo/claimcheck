/**
 * Why this file exists: posting on someone else's pull request is public and cannot be taken back,
 * so Desk shows the exact comment first, formatted the way GitHub will show it, and posts it only
 * when the person presses the button.
 *
 * @author Patrick Finazzo
 */

import type { PullRequestSummaryPreview } from '../shared/github.ts';
import type { DialogHost } from './dialogs.ts';
import { makeElement } from './dom.ts';
import { renderMarkdown } from './markdown.ts';

export type SummaryDialogOptions = {
  host: DialogHost;
  preview: PullRequestSummaryPreview;
  onPost: () => void;
  onOpenLink: (url: string) => void;
};

const renderButton = ({ label, onClick, cls = '' }: { label: string; onClick: () => void; cls?: string }): HTMLButtonElement =>
  makeElement({ tag: 'button', props: { class: `btn ${cls}`.trim(), attrs: { type: 'button' }, on: { click: onClick } }, children: [label] });

/** Shows the comment that would be posted on the pull request. Nothing is sent until Post comment is pressed. */
export const showSummaryDialog = ({ host, preview, onPost, onOpenLink }: SummaryDialogOptions): void => {
  host.showWide(
    `Post on pull request #${preview.number}`,
    makeElement({ tag: 'p', props: { class: 'muted' }, children: ['This is the exact comment. It is posted on GitHub from your account, and only when you press Post comment.'] }),
    makeElement({ tag: 'div', props: { class: 'gh-body summary-preview' }, children: [renderMarkdown({ text: preview.body, onOpenLink })] }),
    makeElement({ tag: 'div', props: { class: 'row' }, children: [renderButton({ label: 'Post comment', onClick: onPost, cls: 'primary' }), renderButton({ label: 'Cancel', onClick: () => host.close() })] }),
  );
};
