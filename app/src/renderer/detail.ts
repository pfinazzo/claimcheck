/**
 * The right-hand side of the board: one claim in plain sections, and the Fix flow in its states.
 * Built with DOM calls only, so nothing read from a repo can turn into markup.
 *
 * @author Patrick Finazzo
 */

import type { PublicRun, ShellResult } from '../lib/fixer.ts';
import type { Claim, LedgerRecord, Proposal } from '../shared/types.ts';
import { h, type Child } from './dom.ts';
import { FLAG_TEXT, caughtWords, factsLine, pct, verdictWord } from './format.ts';
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

const section = (title: string, ...children: Child[]): HTMLElement => h('section', { class: 'block' }, h('h3', {}, title), ...children);
const muted = (...c: Child[]): HTMLElement => h('p', { class: 'muted' }, ...c);
const code = (s: string): HTMLElement => h('pre', { class: 'code' }, s);
const list = (items: string[], empty = 'None.'): HTMLElement => (items.length ? h('ul', {}, ...items.map((i) => h('li', {}, i))) : muted(empty));
const button = (label: string, onClick: () => void, cls = '', disabled = false, title = ''): HTMLButtonElement =>
  h('button', { class: `btn ${cls}`.trim(), attrs: { type: 'button', disabled, title: title || null }, on: { click: onClick } }, label);

const whyFlagged = (claim: Claim): HTMLElement =>
  claim.flags.length
    ? h('ul', { class: 'plain' }, ...claim.flags.map((f) => h('li', {}, FLAG_TEXT[f] ?? f)))
    : muted("Nothing is flagged. The author's confidence, the independent check and the planted bugs agree.");

const checker = (claim: Claim): HTMLElement => {
  const v = claim.verdict;
  if (!v) return muted('No check has run yet. Press Run claimcheck.');
  const who = [v.provider, v.model, v.ts].filter(Boolean).join(', ');
  return h(
    'div',
    {},
    h('p', {}, h('span', { class: `verdict ${verdictWord(claim).replace(' ', '-')}` }, verdictWord(claim)), v.reason ? `. ${v.reason}` : ''),
    who ? muted(`By ${who}.`) : null,
    v.evidence.length ? code(v.evidence.join('\n')) : null,
  );
};

const plantedBugs = (claim: Claim): HTMLElement => {
  const m = claim.mutation;
  if (!m || m.mutants.length === 0) return muted('No planted-bug run covers these files yet.');
  return h(
    'div',
    {},
    muted(`${caughtWords(claim).replace(/^./, (c) => c.toUpperCase())} (${pct(m.catchRate)}).`),
    h(
      'table',
      { class: 'mutants' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Result'), h('th', {}, 'Where'), h('th', {}, 'Change'))),
      h(
        'tbody',
        {},
        ...m.mutants.map((x) =>
          h(
            'tr',
            { class: x.outcome === 'survived' ? 'survived' : '' },
            h('td', {}, x.outcome),
            h('td', { class: 'mono' }, `${x.file}${x.line_no === null ? '' : `:${x.line_no}`}`),
            h('td', { class: 'mono' }, `${x.original.trim()}  →  ${x.mutated.trim()}`),
          ),
        ),
      ),
    ),
  );
};

const historyLine = (r: LedgerRecord): string => {
  const ts = toText({ value: r.ts });
  if (r.type === 'claim') {
    const checkerInfo = r.checker as { verdict?: unknown } | undefined;
    const mut = r.mutation as { catch_rate?: number | null } | undefined;
    return `${ts}  claim run, confidence ${toText({ value: r.confidence })}, checker ${toText({ value: checkerInfo?.verdict, fallback: 'none' })}, caught ${pct(mut?.catch_rate ?? null)}`;
  }
  return `${ts}  outcome ${toText({ value: r.outcome })} (${toText({ value: r.outcome_source })}) ${toText({ value: r.evidence })}`.trim();
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

const resultBlock = (label: string, r: ShellResult | null | undefined): HTMLElement | null => {
  if (!r) return null;
  const word = RESULT_WORD.get(r.ok) ?? 'fail';
  return h('div', { class: `result ${RESULT_CLASS.get(r.ok) ?? 'fail'}` }, h('strong', {}, `${label}: ${word}`), r.tail ? code(r.tail) : null);
};

const activity = (run: PublicRun): HTMLElement => h('div', { class: 'activity' }, ...(run.activity.length ? run.activity.slice(-30).map((a) => h('div', {}, a)) : [h('div', {}, 'Starting…')]));

const proposalCard = (p: Proposal, i: number, run: PublicRun, claim: Claim, a: DetailActions): HTMLElement =>
  h(
    'div',
    { class: 'proposal', data: { proposal: i } },
    h('h4', {}, p.title, h('span', { class: 'effort' }, ` ${p.effort} effort`)),
    muted(p.summary),
    h('div', { class: 'two' }, h('div', {}, h('strong', {}, 'Pros'), list(p.pros)), h('div', {}, h('strong', {}, 'Cons'), list(p.cons))),
    muted(`Touches: ${p.touches.join(', ') || 'not specified'}`),
    run.mode === 'api'
      ? button('Copy build prompt', () => a.copyImplement(claim.id, run.id, i))
      : button('Use this approach', () => a.useApproach(claim.id, run.id, i), 'primary'),
  );

const prButton = (claim: Claim, runId: string, prUrl: string | null | undefined, ghOk: boolean, a: DetailActions): HTMLElement =>
  prUrl
    ? button('View pull request', () => a.openPath(prUrl))
    : button('Open pull request', () => a.openPr(claim.id, runId), 'primary', !ghOk, ghOk ? '' : 'Run gh auth login first');

/** The three actions every flagged claim offers, plus the one-line accept-risk form. */
const baseActions = (claim: Claim, run: PublicRun | null, a: DetailActions): HTMLElement => {
  const note = h('input', { attrs: { type: 'text', placeholder: 'One line on why this is acceptable', 'aria-label': 'Why this risk is acceptable' } });
  return h(
    'div',
    { class: 'actions-block' },
    h(
      'div',
      { class: 'row' },
      button('Fix this', () => a.fix(claim.id), 'primary', run?.status === 'running'),
      button('Copy prompt', () => a.copyPrompt(claim.id)),
    ),
    h(
      'details',
      { class: 'accept' },
      h('summary', {}, 'Accept the risk'),
      h('div', { class: 'row' }, note, button('Accept', () => a.acceptRisk(claim.id, note.value))),
    ),
  );
};

const promptBlock = (claim: Claim, run: PublicRun | null): HTMLElement => {
  const text = run?.prompt ?? claim.promptText ?? '';
  return h('details', {}, h('summary', {}, 'See the prompt'), h('pre', { class: 'code', data: { promptText: '1' } }, text || 'The prompt is built when a repo is open.'));
};

/** The Fix flow, one state at a time. */
export const renderFix = (claim: Claim, run: PublicRun | null, ghOk: boolean, a: DetailActions): HTMLElement => {
  const prompt = promptBlock(claim, run);
  const base = baseActions(claim, run, a);
  const wrap = (title: string, ...c: Child[]): HTMLElement => section(title, ...c);

  if (claim.status === 'resolved' && claim.fix && (!run || run.status !== 'running')) {
    const fix = claim.fix as { approach?: string; branch?: string; worktree?: string; runId?: string; prUrl?: string | null; commits?: string[]; tests?: ShellResult; killCondition?: ShellResult };
    return wrap(
      'Resolved',
      h('p', {}, `Fixed with "${fix.approach ?? 'a fix'}" on `, h('code', {}, fix.branch ?? ''), '.'),
      resultBlock('Project tests', fix.tests),
      resultBlock('Kill condition', fix.killCondition),
      fix.commits?.length ? code(fix.commits.join('\n')) : null,
      h(
        'div',
        { class: 'row' },
        prButton(claim, fix.runId ?? '', fix.prUrl, ghOk, a),
        button('Copy branch name', () => a.copyText(fix.branch ?? '')),
        fix.worktree ? button('Open worktree', () => a.openPath(fix.worktree ?? '')) : null,
      ),
    );
  }

  if (!run && claim.status === 'fixing' && claim.fix && typeof claim.fix.error === 'string') {
    const fix = claim.fix as { error?: string; branch?: string; approach?: string; worktree?: string; tests?: ShellResult; killCondition?: ShellResult };
    return wrap(
      'The last fix did not pass',
      h('p', {}, fix.error ?? '', ' ', h('code', {}, fix.branch ?? '')),
      resultBlock('Project tests', fix.tests),
      resultBlock('Kill condition', fix.killCondition),
      fix.worktree ? button('Open worktree', () => a.openPath(fix.worktree ?? '')) : null,
      base,
      prompt,
    );
  }

  if (!run) {
    return wrap(
      'Fix this',
      muted('Claude reads the code without changing anything and proposes three or four ways to resolve this, each with pros and cons. You choose one. Claude builds it with tests on a new branch in a separate worktree, and the board updates when the tests pass.'),
      base,
      prompt,
    );
  }

  if (run.kind === 'propose') {
    if (run.status === 'running') return wrap('Fix this', h('p', { class: 'working' }, 'Claude is reading the code and drafting approaches…'), activity(run), base, prompt);
    if (run.status === 'failed') {
      return wrap('Fix this', h('p', { class: 'error' }, `Could not get proposals. ${run.error ?? ''}`), run.needsSignIn ? button('Connect Claude', a.connect) : null, base, prompt);
    }
    return wrap(
      'Choose an approach',
      muted(`Claude builds only the one you pick.${run.mode === 'api' ? ' API mode cannot edit your repo, so copy the build prompt into Claude Code instead.' : ''}`),
      ...(run.proposals ?? []).map((p, i) => proposalCard(p, i, run, claim, a)),
      base,
      prompt,
    );
  }

  if (run.status === 'running') {
    return wrap(`Building "${run.proposal?.title ?? ''}"`, h('p', { class: 'working' }, 'Claude is working on ', h('code', {}, run.branch ?? ''), ' in a separate worktree. Nothing in your checkout changes.'), activity(run));
  }
  if (run.status === 'failed') {
    return wrap(
      'The fix did not pass',
      h('p', { class: 'error' }, run.error ?? 'It failed.'),
      resultBlock('Project tests', run.tests),
      resultBlock('Kill condition', run.killCondition),
      activity(run),
      run.worktree ? button('Open worktree', () => a.openPath(run.worktree ?? '')) : null,
      base,
    );
  }
  return wrap(
    'Resolved',
    h('p', {}, 'Tests pass on ', h('code', {}, run.branch ?? ''), `. ${run.summary ?? ''}`),
    resultBlock('Project tests', run.tests),
    resultBlock('Kill condition', run.killCondition),
    run.commits.length ? code(run.commits.join('\n')) : null,
    h('div', { class: 'row' }, prButton(claim, run.id, run.prUrl, ghOk, a), button('Copy branch name', () => a.copyText(run.branch ?? '')), run.worktree ? button('Open worktree', () => a.openPath(run.worktree ?? '')) : null),
  );
};

export const renderDetail = (claim: Claim | null, run: PublicRun | null, ghOk: boolean, a: DetailActions): HTMLElement => {
  if (!claim) return h('div', { class: 'detail empty' }, muted('Pick a claim to see why it needs a decision.'));
  // A fix that is under way or finished stays on top. Otherwise the evidence comes first, then the decision.
  const fixFirst = run !== null || claim.status !== 'open' || claim.fix !== null;
  const fixBlock = claim.flags.length > 0 || fixFirst ? renderFix(claim, run, ghOk, a) : null;
  return h(
    'div',
    { class: 'detail' },
    h('header', { class: 'detail-head' }, h('p', { class: 'id mono' }, claim.id, claim.status === 'open' ? '' : `  ${claim.status}`), h('h2', {}, claim.claim), muted(factsLine(claim))),
    section('Why it is here', whyFlagged(claim)),
    fixFirst ? fixBlock : null,
    section('What the checker said', checker(claim)),
    section('Planted bugs', plantedBugs(claim)),
    fixFirst ? null : fixBlock,
    section('Criteria it supports', claim.criteria.length ? list(claim.criteria.map((c) => `${c.id}. ${c.text || '(not in the frozen spec)'}`)) : muted('None cited.')),
    section('Kill condition', code(claim.killCondition || '(none)')),
    section('What the author said verified it', list(claim.verifiedBy)),
    section('Files', h('p', { class: 'mono' }, claim.files.join('\n') || '(none)')),
    h('details', { class: 'block' }, h('summary', {}, 'Ledger history'), claim.history.length ? code(claim.history.map(historyLine).join('\n')) : muted('Nothing yet.')),
  );
};
