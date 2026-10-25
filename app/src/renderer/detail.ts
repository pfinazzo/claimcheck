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
  return makeElement({ tag: 'div', props: {}, children: [makeElement({ tag: 'p', props: {}, children: [makeElement({ tag: 'span', props: { class: `verdict ${formatVerdictWord({ claim }).replace(' ', '-')}` }, children: [formatVerdictWord({ claim })] }), value.reason ? `. ${value.reason}` : ''] }), who ? renderMuted(`By ${who}.`) : null, value.evidence.length ? renderCode({ text: value.evidence.join('\n') }) : null] });
};

const plantedBugs = ({ claim }: { claim: Claim }): HTMLElement => {
  const mutation = claim.mutation;
  if (!mutation || mutation.mutants.length === 0) return renderMuted('No planted-bug run covers these files yet.');
  return makeElement({ tag: 'div', props: {}, children: [renderMuted(`${formatCaughtWords({ claim }).replace(/^./, (text) => text.toUpperCase())} (${formatPercent({ x: mutation.catchRate })}).`), makeElement({ tag: 'table', props: { class: 'mutants' }, children: [makeElement({ tag: 'thead', props: {}, children: [makeElement({ tag: 'tr', props: {}, children: [makeElement({ tag: 'th', props: {}, children: ['Result'] }), makeElement({ tag: 'th', props: {}, children: ['Where'] }), makeElement({ tag: 'th', props: {}, children: ['Change'] })] })] }), makeElement({ tag: 'tbody', props: {}, children: [...mutation.mutants.map((x) =>
          makeElement({ tag: 'tr', props: { class: x.outcome === 'survived' ? 'survived' : '' }, children: [makeElement({ tag: 'td', props: {}, children: [x.outcome] }), makeElement({ tag: 'td', props: { class: 'mono' }, children: [`${x.file}${x.line_no === null ? '' : `:${x.line_no}`}`] }), makeElement({ tag: 'td', props: { class: 'mono' }, children: [`${x.original.trim()}  →  ${x.mutated.trim()}`] })] }),
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
  makeElement({ tag: 'div', props: { class: 'proposal', dataset: { proposal: index } }, children: [makeElement({ tag: 'h4', props: {}, children: [proposal.title, makeElement({ tag: 'span', props: { class: 'effort' }, children: [` ${proposal.effort} effort`] })] }), renderMuted(proposal.summary), makeElement({ tag: 'div', props: { class: 'two' }, children: [makeElement({ tag: 'div', props: {}, children: [makeElement({ tag: 'strong', props: {}, children: ['Pros'] }), list({ items: proposal.pros })] }), makeElement({ tag: 'div', props: {}, children: [makeElement({ tag: 'strong', props: {}, children: ['Cons'] }), list({ items: proposal.cons })] })] }), renderMuted(`Touches: ${proposal.touches.join(', ') || 'not specified'}`), run.mode === 'api'
      ? renderButton({ label: 'Copy build prompt', onClick: () => detailActions.copyImplement(claim.id, run.id, index) })
      : renderButton({ label: 'Use this approach', onClick: () => detailActions.useApproach(claim.id, run.id, index), cls: 'primary' })] });

const renderPrButton = ({ claim, runId, prUrl, ghOk, detailActions }: { claim: Claim; runId: string; prUrl: string | null | undefined; ghOk: boolean; detailActions: DetailActions }): HTMLElement =>
  prUrl
    ? renderButton({ label: 'View pull request', onClick: () => detailActions.openPath(prUrl) })
    : renderButton({ label: 'Open pull request', onClick: () => detailActions.openPr(claim.id, runId), cls: 'primary', disabled: !ghOk, title: ghOk ? '' : 'Run gh auth login first' });

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
export const renderFix = ({ claim, run, ghOk, detailActions }: { claim: Claim; run: PublicRun | null; ghOk: boolean; detailActions: DetailActions }): HTMLElement => {
  const prompt = renderPromptBlock({ claim, run });
  const base = renderBaseActions({ claim, run, detailActions });
  const wrap = ({ title, list = [] }: { title: string; list?: readonly Child[] }): HTMLElement => renderSection({ title, children: [...list] });

  if (claim.status === 'resolved' && claim.fix && (!run || run.status !== 'running')) {
    const fix = claim.fix as { approach?: string; branch?: string; worktree?: string; runId?: string; prUrl?: string | null; commits?: readonly string[]; tests?: ShellResult; killCondition?: ShellResult };
    return wrap({ title: 'Resolved', list: [makeElement({ tag: 'p', props: {}, children: [`Fixed with "${fix.approach ?? 'a fix'}" on `, makeElement({ tag: 'code', props: {}, children: [fix.branch ?? ''] }), '.'] }), renderResultBlock({ label: 'Project tests', shellResult: fix.tests }), renderResultBlock({ label: 'Kill condition', shellResult: fix.killCondition }), fix.commits?.length ? renderCode({ text: fix.commits.join('\n') }) : null, makeElement({ tag: 'div', props: { class: 'row' }, children: [renderPrButton({ claim, runId: fix.runId ?? '', prUrl: fix.prUrl, ghOk, detailActions }), renderButton({ label: 'Copy branch name', onClick: () => detailActions.copyText(fix.branch ?? '') }), fix.worktree ? renderButton({ label: 'Open worktree', onClick: () => detailActions.openPath(fix.worktree ?? '') }) : null] })] });
  }

  if (!run && claim.status === 'fixing' && claim.fix && typeof claim.fix.error === 'string') {
    const fix = claim.fix as { error?: string; branch?: string; approach?: string; worktree?: string; tests?: ShellResult; killCondition?: ShellResult };
    return wrap({ title: 'The last fix did not pass', list: [makeElement({ tag: 'p', props: {}, children: [fix.error ?? '', ' ', makeElement({ tag: 'code', props: {}, children: [fix.branch ?? ''] })] }), renderResultBlock({ label: 'Project tests', shellResult: fix.tests }), renderResultBlock({ label: 'Kill condition', shellResult: fix.killCondition }), fix.worktree ? renderButton({ label: 'Open worktree', onClick: () => detailActions.openPath(fix.worktree ?? '') }) : null, base, prompt] });
  }

  if (!run) {
    return wrap({ title: 'Fix this', list: [renderMuted('Claude reads the code without changing anything and proposes three or four ways to resolve this, each with pros and cons. You choose one. Claude builds it with tests on a new branch in a separate worktree, and the board updates when the tests pass.'), base, prompt] });
  }

  if (run.kind === 'propose') {
    if (run.status === 'running') return wrap({ title: 'Fix this', list: [makeElement({ tag: 'p', props: { class: 'working' }, children: ['Claude is reading the code and drafting approaches…'] }), renderActivity({ run }), base, prompt] });
    if (run.status === 'failed') {
      return wrap({ title: 'Fix this', list: [makeElement({ tag: 'p', props: { class: 'error' }, children: [`Could not get proposals. ${run.error ?? ''}`] }), run.needsSignIn ? renderButton({ label: 'Connect Claude', onClick: detailActions.connect }) : null, base, prompt] });
    }
    return wrap({ title: 'Choose an approach', list: [renderMuted(`Claude builds only the one you pick.${run.mode === 'api' ? ' API mode cannot edit your repo, so copy the build prompt into Claude Code instead.' : ''}`), ...(run.proposals ?? []).map((proposal, index) => renderProposalCard({ proposal, index, run, claim, detailActions })), base, prompt] });
  }

  if (run.status === 'running') {
    return wrap({ title: `Building "${run.proposal?.title ?? ''}"`, list: [makeElement({ tag: 'p', props: { class: 'working' }, children: ['Claude is working on ', makeElement({ tag: 'code', props: {}, children: [run.branch ?? ''] }), ' in a separate worktree. Nothing in your checkout changes.'] }), renderActivity({ run })] });
  }
  if (run.status === 'failed') {
    return wrap({ title: 'The fix did not pass', list: [makeElement({ tag: 'p', props: { class: 'error' }, children: [run.error ?? 'It failed.'] }), renderResultBlock({ label: 'Project tests', shellResult: run.tests }), renderResultBlock({ label: 'Kill condition', shellResult: run.killCondition }), renderActivity({ run }), run.worktree ? renderButton({ label: 'Open worktree', onClick: () => detailActions.openPath(run.worktree ?? '') }) : null, base] });
  }
  return wrap({ title: 'Resolved', list: [makeElement({ tag: 'p', props: {}, children: ['Tests pass on ', makeElement({ tag: 'code', props: {}, children: [run.branch ?? ''] }), `. ${run.summary ?? ''}`] }), renderResultBlock({ label: 'Project tests', shellResult: run.tests }), renderResultBlock({ label: 'Kill condition', shellResult: run.killCondition }), run.commits.length ? renderCode({ text: run.commits.join('\n') }) : null, makeElement({ tag: 'div', props: { class: 'row' }, children: [renderPrButton({ claim, runId: run.id, prUrl: run.prUrl, ghOk, detailActions }), renderButton({ label: 'Copy branch name', onClick: () => detailActions.copyText(run.branch ?? '') }), run.worktree ? renderButton({ label: 'Open worktree', onClick: () => detailActions.openPath(run.worktree ?? '') }) : null] })] });
};

export const renderDetail = ({ claim, run, ghOk, detailActions }: { claim: Claim | null; run: PublicRun | null; ghOk: boolean; detailActions: DetailActions }): HTMLElement => {
  if (!claim) return makeElement({ tag: 'div', props: { class: 'detail empty' }, children: [renderMuted('Pick a claim to see why it needs a decision.')] });
  // A fix that is under way or finished stays on top. Otherwise the evidence comes first, then the decision.
  const shouldFixFirst = run !== null || claim.status !== 'open' || claim.fix !== null;
  const fixBlock = claim.flags.length > 0 || shouldFixFirst ? renderFix({ claim, run, ghOk, detailActions }) : null;
  return makeElement({ tag: 'div', props: { class: 'detail' }, children: [makeElement({ tag: 'header', props: { class: 'detail-head' }, children: [makeElement({ tag: 'p', props: { class: 'id mono' }, children: [claim.id, claim.status === 'open' ? '' : `  ${claim.status}`] }), makeElement({ tag: 'h2', props: {}, children: [claim.claim] }), renderMuted(formatFactsLine({ claim }))] }), renderSection({ title: 'Why it is here', children: [renderWhyFlagged({ claim })] }), shouldFixFirst ? fixBlock : null, renderSection({ title: 'What the checker said', children: [checker({ claim })] }), renderSection({ title: 'Planted bugs', children: [plantedBugs({ claim })] }), shouldFixFirst ? null : fixBlock, renderSection({ title: 'Criteria it supports', children: [claim.criteria.length ? list({ items: claim.criteria.map((criterion) => `${criterion.id}. ${criterion.text || '(not in the frozen spec)'}`) }) : renderMuted('None cited.')] }), renderSection({ title: 'Kill condition', children: [renderCode({ text: claim.killCondition || '(none)' })] }), renderSection({ title: 'What the author said verified it', children: [list({ items: claim.verifiedBy })] }), renderSection({ title: 'Files', children: [makeElement({ tag: 'p', props: { class: 'mono' }, children: [claim.files.join('\n') || '(none)'] })] }), makeElement({ tag: 'details', props: { class: 'block' }, children: [makeElement({ tag: 'summary', props: {}, children: ['Ledger history'] }), claim.history.length ? renderCode({ text: claim.history.map((ledgerRecord) => renderHistoryLine({ ledgerRecord })).join('\n') }) : renderMuted('Nothing yet.')] })] });
};
