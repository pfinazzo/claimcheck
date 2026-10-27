/**
 * The right-hand side of the board: one claim in plain sections, and the Fix flow in its states.
 * Built with DOM calls only, so nothing read from a repo can turn into markup.
 *
 * @author Patrick Finazzo
 */

import type { PublicRun, ShellResult } from '../lib/fixer.ts';
import type { Claim, LedgerRecord, Proposal } from '../shared/types.ts';
import { makeElement, type Child } from './dom.ts';
import { FLAG_TEXT, formatCaughtWords, formatFactsLine, formatPercent, formatVerdictWord } from './format.ts';
import { toText } from '../shared/text.ts';

export type DetailActions = {
  fix: (claimId: string) => void;
  useApproach: (claimId: string, runId: string, choice: number) => void;
  copyPrompt: (claimId: string) => void;
  copyImplement: (claimId: string, runId: string, choice: number) => void;
  copyText: (text: string) => void;
  acceptRisk: (claimId: string, note: string) => void;
  openPr: (claimId: string, runId: string) => void;
  openPath: (target: string) => void;
  connect: () => void;
  connectGithub: () => void;
  /** Opens the viewer on the code committed for this claim's fix. */
  inspect: (claimId: string) => void;
};

const renderSection = ({ title, children = [] }: { title: string; children?: readonly Child[] }): HTMLElement => makeElement({ tag: 'section', props: { class: 'block' }, children: [makeElement({ tag: 'h3', props: {}, children: [title] }), ...children] });
const renderMuted = (...list: Child[]): HTMLElement => makeElement({ tag: 'p', props: { class: 'muted' }, children: [...list] });
const renderCode = ({ text }: { text: string }): HTMLElement => makeElement({ tag: 'pre', props: { class: 'code' }, children: [text] });
const list = ({ items, empty = 'None.' }: { items: readonly string[]; empty?: string }): HTMLElement => (items.length ? makeElement({ tag: 'ul', props: {}, children: [...items.map((entry) => makeElement({ tag: 'li', props: {}, children: [entry] }))] }) : renderMuted(empty));
const renderButton = ({ label, onClick, cls = '', disabled = false, title = '' }: { label: string; onClick: () => void; cls?: string; disabled?: boolean; title?: string }): HTMLButtonElement =>
  makeElement({ tag: 'button', props: { class: `btn ${cls}`.trim(), attrs: { type: 'button', disabled, title: title || null }, on: { click: onClick } }, children: [label] });

const renderWhyFlagged = ({ claim }: { claim: Claim }): HTMLElement =>
  claim.flags.length
    ? makeElement({ tag: 'ul', props: { class: 'plain' }, children: [...claim.flags.map((text) => makeElement({ tag: 'li', props: {}, children: [FLAG_TEXT[text] ?? text] }))] })
    : renderMuted("Nothing is flagged. The author's confidence, the independent check and the planted bugs agree.");

const checker = ({ claim }: { claim: Claim }): HTMLElement => {
  const value = claim.verdict;
  if (!value) return renderMuted('No check has run yet. Press Run claimcheck.');
  const who = [value.provider, value.model, value.ts].filter(Boolean).join(', ');
  return makeElement({ tag: 'div', props: {}, children: [makeElement({ tag: 'p', props: {}, children: [makeElement({ tag: 'span', props: { class: `pill ${formatVerdictWord({ claim }).replace(' ', '-')}` }, children: [formatVerdictWord({ claim })] }), value.reason ? ` ${value.reason}` : ''] }), who ? renderMuted(`By ${who}.`) : null, value.evidence.length ? renderCode({ text: value.evidence.join('\n') }) : null] });
};

const plantedBugs = ({ claim }: { claim: Claim }): HTMLElement => {
  const mutation = claim.mutation;
  if (!mutation || mutation.mutants.length === 0) return renderMuted('No planted-bug run covers these files yet.');
  return makeElement({ tag: 'div', props: {}, children: [renderMuted(`${formatCaughtWords({ claim }).replace(/^./, (text) => text.toUpperCase())} (${formatPercent({ x: mutation.catchRate })}).`), makeElement({ tag: 'table', props: { class: 'mutants' }, children: [makeElement({ tag: 'thead', props: {}, children: [makeElement({ tag: 'tr', props: {}, children: [makeElement({ tag: 'th', props: {}, children: ['Result'] }), makeElement({ tag: 'th', props: {}, children: ['Where'] }), makeElement({ tag: 'th', props: {}, children: ['Change'] })] })] }), makeElement({ tag: 'tbody', props: {}, children: [...mutation.mutants.map((x) =>
          makeElement({ tag: 'tr', props: { class: x.outcome === 'survived' ? 'survived' : '' }, children: [makeElement({ tag: 'td', props: {}, children: [makeElement({ tag: 'span', props: { class: `pill ${MUTANT_PILLS.has(x.outcome) ? x.outcome : ''}`.trim() }, children: [x.outcome] })] }), makeElement({ tag: 'td', props: { class: 'mono' }, children: [`${x.file}${x.line_no === null ? '' : `:${x.line_no}`}`] }), makeElement({ tag: 'td', props: { class: 'mono' }, children: [`${x.original.trim()}  →  ${x.mutated.trim()}`] })] }),
        )] })] })] });
};

const renderHistoryLine = ({ ledgerRecord }: { ledgerRecord: LedgerRecord }): string => {
  const timestamp = toText({ value: ledgerRecord.ts });
  if (ledgerRecord.type === 'claim') {
    const checkerInfo = ledgerRecord.checker as { verdict?: unknown } | undefined;
    const mut = ledgerRecord.mutation as { catch_rate?: number | null } | undefined;
    return `${timestamp}  claim run, confidence ${toText({ value: ledgerRecord.confidence })}, checker ${toText({ value: checkerInfo?.verdict, fallback: 'none' })}, caught ${formatPercent({ x: mut?.catch_rate ?? null })}`;
  }
  return `${timestamp}  outcome ${toText({ value: ledgerRecord.outcome })} (${toText({ value: ledgerRecord.outcome_source })}) ${toText({ value: ledgerRecord.evidence })}`.trim();
};

/** How a test or kill-condition result reads (pass, check by hand, else fail) and the class that colours it. */
const RESULT_WORD = new Map<unknown, string>([
  [true, 'pass'],
  ['manual', 'check by hand'],
]);
const RESULT_CLASS = new Map<unknown, string>([
  [true, 'pass'],
  ['manual', 'manual'],
]);

const renderResultBlock = ({ label, shellResult: row }: { label: string; shellResult: ShellResult | null | undefined }): HTMLElement | null => {
  if (!row) return null;
  const word = RESULT_WORD.get(row.ok) ?? 'fail';
  return makeElement({ tag: 'div', props: { class: `result ${RESULT_CLASS.get(row.ok) ?? 'fail'}` }, children: [makeElement({ tag: 'strong', props: {}, children: [`${label}: ${word}`] }), row.tail ? renderCode({ text: row.tail }) : null] });
};

const renderActivity = ({ run }: { run: PublicRun }): HTMLElement => makeElement({ tag: 'div', props: { class: 'activity' }, children: [...(run.activity.length ? run.activity.slice(-30).map((text) => makeElement({ tag: 'div', props: {}, children: [text] })) : [makeElement({ tag: 'div', props: {}, children: ['Starting…'] })])] });

const renderProposalCard = ({ proposal, index, run, claim, detailActions }: { proposal: Proposal; index: number; run: PublicRun; claim: Claim; detailActions: DetailActions }): HTMLElement =>
  makeElement({ tag: 'div', props: { class: `proposal panel${proposal.recommended ? ' is-recommended' : ''}`, dataset: { proposal: index } }, children: [makeElement({ tag: 'h4', props: {}, children: [proposal.title, proposal.recommended ? makeElement({ tag: 'span', props: { class: 'badge' }, children: ['Recommended'] }) : null, makeElement({ tag: 'span', props: { class: 'effort' }, children: [` ${proposal.effort} effort`] })] }), renderMuted(proposal.summary), makeElement({ tag: 'div', props: { class: 'two' }, children: [makeElement({ tag: 'div', props: {}, children: [makeElement({ tag: 'strong', props: {}, children: ['Pros'] }), list({ items: proposal.pros })] }), makeElement({ tag: 'div', props: {}, children: [makeElement({ tag: 'strong', props: {}, children: ['Cons'] }), list({ items: proposal.cons })] })] }), renderMuted(`Touches: ${proposal.touches.join(', ') || 'not specified'}`), run.mode === 'api'
      ? renderButton({ label: 'Copy build prompt', onClick: () => detailActions.copyImplement(claim.id, run.id, index), cls: proposal.recommended ? 'primary' : '' })
      : renderButton({ label: 'Use this approach', onClick: () => detailActions.useApproach(claim.id, run.id, index), cls: proposal.recommended ? 'primary' : '' })] });

const MUTANT_PILLS = new Set(['killed', 'survived', 'timeout']);

const VERDICT_TONES = new Map<string, string>([
  ['supported', 'ok'],
  ['refuted', 'bad'],
  ['unverifiable', 'warn'],
]);

const renderEvidenceTile = ({ tone, label, value, note }: { tone: string; label: string; value: string; note: string }): HTMLElement =>
  makeElement({
    tag: 'div',
    props: { class: `tile ${tone}`.trim() },
    children: [
      makeElement({ tag: 'span', props: { class: 'tile-label' }, children: [label] }),
      makeElement({ tag: 'span', props: { class: 'tile-value' }, children: [value] }),
      makeElement({ tag: 'span', props: { class: 'tile-note' }, children: [note] }),
    ],
  });

/** The planted-bug tile is red when the tests are weak, green when they are not, and plain when nothing was measured. */
const toCatchTone = ({ rate, hasWeakTests }: { rate: number | null; hasWeakTests: boolean }): string => {
  if (rate === null) return '';
  return hasWeakTests ? 'bad' : 'ok';
};

/** Three figures side by side: what the author stated, what the checker said, what the planted bugs showed. */
const renderEvidenceTiles = ({ claim }: { claim: Claim }): HTMLElement => {
  const mutation = claim.mutation;
  const hasRun = mutation !== null && mutation.total > 0;
  const rate = hasRun ? (mutation.killed + mutation.timeout) / mutation.total : null;
  const verdict = formatVerdictWord({ claim });
  return makeElement({
    tag: 'div',
    props: { class: 'tiles' },
    children: [
      renderEvidenceTile({ tone: claim.flags.includes('low-confidence') ? 'warn' : '', label: 'Stated confidence', value: claim.confidence === null ? '–' : claim.confidence.toFixed(2), note: claim.confidence === null ? 'not stated' : 'by the author' }),
      renderEvidenceTile({ tone: VERDICT_TONES.get(verdict) ?? '', label: 'Checker', value: verdict, note: claim.verdict ? [claim.verdict.provider, claim.verdict.model].filter(Boolean).join(', ') : 'no run yet' }),
      renderEvidenceTile({ tone: toCatchTone({ rate, hasWeakTests: claim.flags.includes('weak-tests') }), label: 'Planted bugs caught', value: rate === null ? '–' : formatPercent({ x: rate }), note: hasRun ? `${mutation.killed + mutation.timeout} of ${mutation.total}` : 'no run yet' }),
    ],
  });
};

/** Claude's pick and its reason, above the cards. Shown only when Claude recommended one and said why. */
const renderRecommendationNote = ({ run }: { run: PublicRun }): HTMLElement | null => {
  const pick = run.proposals?.find((proposal) => proposal.recommended);
  if (!pick || !run.recommendationWhy) return null;
  return makeElement({
    tag: 'div',
    props: { class: 'recommendation panel', attrs: { role: 'note' } },
    children: [makeElement({ tag: 'strong', props: {}, children: [`Claude recommends: ${pick.title}`] }), makeElement({ tag: 'p', props: {}, children: [run.recommendationWhy] })],
  });
};

/** Opens the code viewer. Offered only once a fix has a branch, because there is nothing to read before that. */
const renderInspectButton = ({ claim, branch, detailActions }: { claim: Claim; branch: string | null | undefined; detailActions: DetailActions }): HTMLElement | null =>
  branch ? renderButton({ label: 'Inspect the code', onClick: () => detailActions.inspect(claim.id) }) : null;

/** The pull-request button. When it cannot work, it is disabled, the reason is written beside it, and Connect GitHub is one press away. */
const renderPrButton = ({ claim, runId, prUrl, prBlocker, detailActions }: { claim: Claim; runId: string; prUrl: string | null | undefined; prBlocker: string | null; detailActions: DetailActions }): HTMLElement => {
  if (prUrl) return renderButton({ label: 'View pull request', onClick: () => detailActions.openPath(prUrl) });
  return makeElement({
    tag: 'div',
    props: { class: 'pr-offer' },
    children: [
      makeElement({
        tag: 'div',
        props: { class: 'row' },
        children: [renderButton({ label: 'Open pull request', onClick: () => detailActions.openPr(claim.id, runId), cls: 'primary', disabled: prBlocker !== null }), prBlocker ? renderButton({ label: 'Connect GitHub', onClick: detailActions.connectGithub }) : null],
      }),
      prBlocker ? makeElement({ tag: 'p', props: { class: 'muted pr-blocker', attrs: { role: 'status' } }, children: [prBlocker] }) : null,
    ],
  });
};

/** The three actions every flagged claim offers, plus the one-line accept-risk form. */
const renderBaseActions = ({ claim, run, detailActions }: { claim: Claim; run: PublicRun | null; detailActions: DetailActions }): HTMLElement => {
  const note = makeElement({ tag: 'input', props: { attrs: { type: 'text', placeholder: 'One line on why this is acceptable', 'aria-label': 'Why this risk is acceptable' } } });
  return makeElement({ tag: 'div', props: { class: 'actions-block' }, children: [makeElement({ tag: 'div', props: { class: 'row' }, children: [renderButton({ label: 'Fix this', onClick: () => detailActions.fix(claim.id), cls: 'primary', disabled: run?.status === 'running' }), renderButton({ label: 'Copy prompt', onClick: () => detailActions.copyPrompt(claim.id) })] }), makeElement({ tag: 'details', props: { class: 'accept' }, children: [makeElement({ tag: 'summary', props: {}, children: ['Accept the risk'] }), makeElement({ tag: 'div', props: { class: 'row' }, children: [note, renderButton({ label: 'Accept', onClick: () => detailActions.acceptRisk(claim.id, note.value) })] })] })] });
};

const renderPromptBlock = ({ claim, run }: { claim: Claim; run: PublicRun | null }): HTMLElement => {
  const text = run?.prompt ?? claim.promptText ?? '';
  return makeElement({ tag: 'details', props: {}, children: [makeElement({ tag: 'summary', props: {}, children: ['See the prompt'] }), makeElement({ tag: 'pre', props: { class: 'code', dataset: { promptText: '1' } }, children: [text || 'The prompt is built when a repo is open.'] })] });
};

/** The Fix flow, one state at a time. */
export const renderFix = ({ claim, run, prBlocker, detailActions }: { claim: Claim; run: PublicRun | null; prBlocker: string | null; detailActions: DetailActions }): HTMLElement => {
  const prompt = renderPromptBlock({ claim, run });
  const base = renderBaseActions({ claim, run, detailActions });
  const wrap = ({ title, list = [] }: { title: string; list?: readonly Child[] }): HTMLElement => renderSection({ title, children: [...list] });

  if (claim.status === 'resolved' && claim.fix && (!run || run.status !== 'running')) {
    const fix = claim.fix as { approach?: string; branch?: string; worktree?: string; runId?: string; prUrl?: string | null; commits?: readonly string[]; tests?: ShellResult; killCondition?: ShellResult };
    return wrap({ title: 'Resolved', list: [makeElement({ tag: 'p', props: {}, children: [`Fixed with "${fix.approach ?? 'a fix'}" on `, makeElement({ tag: 'code', props: {}, children: [fix.branch ?? ''] }), '.'] }), renderResultBlock({ label: 'Project tests', shellResult: fix.tests }), renderResultBlock({ label: 'Kill condition', shellResult: fix.killCondition }), fix.commits?.length ? renderCode({ text: fix.commits.join('\n') }) : null, makeElement({ tag: 'div', props: { class: 'row' }, children: [renderPrButton({ claim, runId: fix.runId ?? '', prUrl: fix.prUrl, prBlocker, detailActions }), renderInspectButton({ claim, branch: fix.branch, detailActions }), renderButton({ label: 'Copy branch name', onClick: () => detailActions.copyText(fix.branch ?? '') }), fix.worktree ? renderButton({ label: 'Open worktree', onClick: () => detailActions.openPath(fix.worktree ?? '') }) : null] })] });
  }

  if (!run && claim.status === 'fixing' && claim.fix && typeof claim.fix.error === 'string') {
    const fix = claim.fix as { error?: string; branch?: string; approach?: string; worktree?: string; tests?: ShellResult; killCondition?: ShellResult };
    return wrap({ title: 'The last fix did not pass', list: [makeElement({ tag: 'p', props: {}, children: [fix.error ?? '', ' ', makeElement({ tag: 'code', props: {}, children: [fix.branch ?? ''] })] }), renderResultBlock({ label: 'Project tests', shellResult: fix.tests }), renderResultBlock({ label: 'Kill condition', shellResult: fix.killCondition }), makeElement({ tag: 'div', props: { class: 'row' }, children: [renderInspectButton({ claim, branch: fix.branch, detailActions }), fix.worktree ? renderButton({ label: 'Open worktree', onClick: () => detailActions.openPath(fix.worktree ?? '') }) : null] }), base, prompt] });
  }

  if (!run) {
    return wrap({ title: 'Fix this', list: [renderMuted('Claude reads the code without changing anything and proposes three or four ways to resolve this, each with pros and cons. You choose one. Claude builds it with tests on a new branch in a separate worktree, and the board updates when the tests pass.'), base, prompt] });
  }

  if (run.kind === 'propose') {
    if (run.status === 'running') return wrap({ title: 'Fix this', list: [makeElement({ tag: 'p', props: { class: 'working' }, children: ['Claude is reading the code and drafting approaches…'] }), renderActivity({ run }), base, prompt] });
    if (run.status === 'failed') {
      return wrap({ title: 'Fix this', list: [makeElement({ tag: 'p', props: { class: 'error' }, children: [`Could not get proposals. ${run.error ?? ''}`] }), run.needsSignIn ? renderButton({ label: 'Connect Claude', onClick: detailActions.connect }) : null, base, prompt] });
    }
    return wrap({ title: 'Choose an approach', list: [renderMuted(`Claude builds only the one you pick.${run.mode === 'api' ? ' API mode cannot edit your repo, so copy the build prompt into Claude Code instead.' : ''}`), renderRecommendationNote({ run }), ...(run.proposals ?? []).map((proposal, index) => renderProposalCard({ proposal, index, run, claim, detailActions })), base, prompt] });
  }

  if (run.status === 'running') {
    return wrap({ title: `Building "${run.proposal?.title ?? ''}"`, list: [makeElement({ tag: 'p', props: { class: 'working' }, children: ['Claude is working on ', makeElement({ tag: 'code', props: {}, children: [run.branch ?? ''] }), ' in a separate worktree. Nothing in your checkout changes.'] }), renderActivity({ run })] });
  }
  if (run.status === 'failed') {
    return wrap({ title: 'The fix did not pass', list: [makeElement({ tag: 'p', props: { class: 'error' }, children: [run.error ?? 'It failed.'] }), renderResultBlock({ label: 'Project tests', shellResult: run.tests }), renderResultBlock({ label: 'Kill condition', shellResult: run.killCondition }), renderActivity({ run }), makeElement({ tag: 'div', props: { class: 'row' }, children: [renderInspectButton({ claim, branch: run.branch, detailActions }), run.worktree ? renderButton({ label: 'Open worktree', onClick: () => detailActions.openPath(run.worktree ?? '') }) : null] }), base] });
  }
  return wrap({ title: 'Resolved', list: [makeElement({ tag: 'p', props: {}, children: ['Tests pass on ', makeElement({ tag: 'code', props: {}, children: [run.branch ?? ''] }), `. ${run.summary ?? ''}`] }), renderResultBlock({ label: 'Project tests', shellResult: run.tests }), renderResultBlock({ label: 'Kill condition', shellResult: run.killCondition }), run.commits.length ? renderCode({ text: run.commits.join('\n') }) : null, makeElement({ tag: 'div', props: { class: 'row' }, children: [renderPrButton({ claim, runId: run.id, prUrl: run.prUrl, prBlocker, detailActions }), renderInspectButton({ claim, branch: run.branch, detailActions }), renderButton({ label: 'Copy branch name', onClick: () => detailActions.copyText(run.branch ?? '') }), run.worktree ? renderButton({ label: 'Open worktree', onClick: () => detailActions.openPath(run.worktree ?? '') }) : null] })] });
};

/**
 * What a person does when a claim needs nothing from them. Without it the pane ends after the
 * evidence and the reader is left guessing whether anything is expected.
 */
const renderNextSteps = (): HTMLElement =>
  renderSection({
    title: 'What to do next',
    children: [
      makeElement({ tag: 'p', props: {}, children: ['Nothing on this claim needs a decision. You can leave it as it is.'] }),
      makeElement({ tag: 'ol', props: {}, children: [
        makeElement({ tag: 'li', props: {}, children: ['Look at the other claims in the list, and at the Confidence map. A red claim there still needs you.'] }),
        makeElement({ tag: 'li', props: {}, children: ['When every claim is backed, your change is ready to merge.'] }),
        makeElement({ tag: 'li', props: {}, children: ['After your next commit, press Run claimcheck. It checks every claim again.'] }),
      ] }),
    ],
  });

export const renderDetail = ({ claim, run, prBlocker, detailActions }: { claim: Claim | null; run: PublicRun | null; prBlocker: string | null; detailActions: DetailActions }): HTMLElement => {
  if (!claim) return makeElement({ tag: 'div', props: { class: 'detail panel empty' }, children: [renderMuted('Pick a claim to see why it needs a decision.')] });
  // A fix that is under way or finished stays on top. Otherwise the evidence comes first, then the decision.
  const shouldFixFirst = run !== null || claim.status !== 'open' || claim.fix !== null;
  const isBacked = claim.flags.length === 0 && !shouldFixFirst;
  const fixBlock = claim.flags.length > 0 || shouldFixFirst ? renderFix({ claim, run, prBlocker, detailActions }) : null;
  return makeElement({ tag: 'div', props: { class: 'detail panel' }, children: [makeElement({ tag: 'header', props: { class: 'detail-head' }, children: [makeElement({ tag: 'p', props: { class: 'id mono' }, children: [claim.id, claim.status === 'open' ? null : makeElement({ tag: 'span', props: { class: 'pill' }, children: [claim.status] })] }), makeElement({ tag: 'h2', props: {}, children: [claim.claim] }), renderMuted(formatFactsLine({ claim })), renderEvidenceTiles({ claim })] }), renderSection({ title: 'Why it is here', children: [renderWhyFlagged({ claim })] }), isBacked ? renderNextSteps() : null, shouldFixFirst ? fixBlock : null, renderSection({ title: 'What the checker said', children: [checker({ claim })] }), renderSection({ title: 'Planted bugs', children: [plantedBugs({ claim })] }), shouldFixFirst ? null : fixBlock, renderSection({ title: 'Criteria it supports', children: [claim.criteria.length ? list({ items: claim.criteria.map((criterion) => `${criterion.id}. ${criterion.text || '(not in the frozen spec)'}`) }) : renderMuted('None cited.')] }), renderSection({ title: 'Kill condition', children: [renderCode({ text: claim.killCondition || '(none)' })] }), renderSection({ title: 'What the author said verified it', children: [list({ items: claim.verifiedBy })] }), renderSection({ title: 'Files', children: [makeElement({ tag: 'p', props: { class: 'mono' }, children: [claim.files.join('\n') || '(none)'] })] }), makeElement({ tag: 'details', props: { class: 'block' }, children: [makeElement({ tag: 'summary', props: {}, children: ['Ledger history'] }), claim.history.length ? renderCode({ text: claim.history.map((ledgerRecord) => renderHistoryLine({ ledgerRecord })).join('\n') }) : renderMuted('Nothing yet.')] })] });
};
