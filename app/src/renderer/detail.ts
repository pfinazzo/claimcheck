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
    h('p', {}, h('span', { class: `pill ${verdictWord(claim).replace(' ', '-')}` }, verdictWord(claim)), v.reason ? ` ${v.reason}` : ''),
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
            h('td', {}, h('span', { class: `pill ${x.outcome === 'survived' || x.outcome === 'killed' || x.outcome === 'timeout' ? x.outcome : ''}`.trim() }, x.outcome)),
            h('td', { class: 'mono' }, `${x.file}${x.line_no === null ? '' : `:${x.line_no}`}`),
            h('td', { class: 'mono' }, `${x.original.trim()}  →  ${x.mutated.trim()}`),
          ),
        ),
      ),
    ),
  );
};

const historyLine = (r: LedgerRecord): string => {
  const ts = String(r.ts ?? '');
  if (r.type === 'claim') {
    const checkerInfo = r.checker as { verdict?: unknown } | undefined;
    const mut = r.mutation as { catch_rate?: number | null } | undefined;
    return `${ts}  claim run, confidence ${String(r.confidence)}, checker ${String(checkerInfo?.verdict ?? 'none')}, caught ${pct(mut?.catch_rate ?? null)}`;
  }
  return `${ts}  outcome ${String(r.outcome)} (${String(r.outcome_source)}) ${String(r.evidence ?? '')}`.trim();
};

const resultBlock = (label: string, r: ShellResult | null | undefined): HTMLElement | null => {
  if (!r) return null;
  const word = r.ok === true ? 'pass' : r.ok === 'manual' ? 'check by hand' : 'fail';
  return h('div', { class: `result ${r.ok === true ? 'pass' : r.ok === 'manual' ? 'manual' : 'fail'}` }, h('strong', {}, `${label}: ${word}`), r.tail ? code(r.tail) : null);
};

const activity = (run: PublicRun): HTMLElement => h('div', { class: 'activity' }, ...(run.activity.length ? run.activity.slice(-30).map((a) => h('div', {}, a)) : [h('div', {}, 'Starting…')]));

const proposalCard = (p: Proposal, i: number, run: PublicRun, claim: Claim, a: DetailActions): HTMLElement =>
  h(
    'div',
    { class: `proposal panel${p.recommended ? ' is-recommended' : ''}`, data: { proposal: i } },
    h('h4', {}, p.title, p.recommended ? h('span', { class: 'badge' }, 'Recommended') : null, h('span', { class: 'effort' }, ` ${p.effort} effort`)),
    muted(p.summary),
    h('div', { class: 'two' }, h('div', {}, h('strong', {}, 'Pros'), list(p.pros)), h('div', {}, h('strong', {}, 'Cons'), list(p.cons))),
    muted(`Touches: ${p.touches.join(', ') || 'not specified'}`),
    run.mode === 'api'
      ? button('Copy build prompt', () => a.copyImplement(claim.id, run.id, i), p.recommended ? 'primary' : '')
      : button('Use this approach', () => a.useApproach(claim.id, run.id, i), p.recommended ? 'primary' : ''),
  );

/** Claude's pick and its reason, above the cards. Shown only when Claude recommended one and said why. */
const recommendationNote = (run: PublicRun): HTMLElement | null => {
  const pick = run.proposals?.find((p) => p.recommended);
  if (!pick || !run.recommendationWhy) return null;
  return h('div', { class: 'recommendation panel', attrs: { role: 'note' } }, h('strong', {}, `Claude recommends: ${pick.title}`), h('p', {}, run.recommendationWhy));
};

/** The pull-request button. When it cannot work, it is disabled, the reason is written beside it, and Connect GitHub is one press away. */
const prButton = (claim: Claim, runId: string, prUrl: string | null | undefined, prBlocker: string | null, a: DetailActions): HTMLElement =>
  prUrl
    ? button('View pull request', () => a.openPath(prUrl))
    : h(
        'div',
        { class: 'pr-offer' },
        h('div', { class: 'row' }, button('Open pull request', () => a.openPr(claim.id, runId), 'primary', prBlocker !== null), prBlocker ? button('Connect GitHub', a.connectGithub) : null),
        prBlocker ? h('p', { class: 'muted pr-blocker', attrs: { role: 'status' } }, prBlocker) : null,
      );

/** Opens the code viewer. Offered only once a fix has a branch, because there is nothing to read before that. */
const inspectButton = (claim: Claim, branch: string | null | undefined, a: DetailActions): HTMLElement | null =>
  branch ? button('Inspect the code', () => a.inspect(claim.id)) : null;

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
export const renderFix = (claim: Claim, run: PublicRun | null, prBlocker: string | null, a: DetailActions): HTMLElement => {
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
        prButton(claim, fix.runId ?? '', fix.prUrl, prBlocker, a),
        inspectButton(claim, fix.branch, a),
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
      h('div', { class: 'row' }, inspectButton(claim, fix.branch, a), fix.worktree ? button('Open worktree', () => a.openPath(fix.worktree ?? '')) : null),
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
      recommendationNote(run),
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
      h('div', { class: 'row' }, inspectButton(claim, run.branch, a), run.worktree ? button('Open worktree', () => a.openPath(run.worktree ?? '')) : null),
      base,
    );
  }
  return wrap(
    'Resolved',
    h('p', {}, 'Tests pass on ', h('code', {}, run.branch ?? ''), `. ${run.summary ?? ''}`),
    resultBlock('Project tests', run.tests),
    resultBlock('Kill condition', run.killCondition),
    run.commits.length ? code(run.commits.join('\n')) : null,
    h('div', { class: 'row' }, prButton(claim, run.id, run.prUrl, prBlocker, a), inspectButton(claim, run.branch, a), button('Copy branch name', () => a.copyText(run.branch ?? '')), run.worktree ? button('Open worktree', () => a.openPath(run.worktree ?? '')) : null),
  );
};

const tile = (cls: string, label: string, value: string, note: string): HTMLElement =>
  h('div', { class: `tile ${cls}`.trim() }, h('span', { class: 'tile-label' }, label), h('span', { class: 'tile-value' }, value), h('span', { class: 'tile-note' }, note));

const VERDICT_TONES: Record<string, string> = { supported: 'ok', refuted: 'bad', unverifiable: 'warn', 'not checked': '' };

/** Three figures side by side: what the author stated, what the checker said, what the planted bugs showed. */
const evidenceTiles = (claim: Claim): HTMLElement => {
  const m = claim.mutation;
  const rate = m && m.total > 0 ? (m.killed + m.timeout) / m.total : null;
  const verdict = verdictWord(claim);
  return h(
    'div',
    { class: 'tiles' },
    tile(claim.confidence !== null && claim.confidence < 0.75 ? 'warn' : '', 'Stated confidence', claim.confidence === null ? '–' : claim.confidence.toFixed(2), claim.confidence === null ? 'not stated' : 'by the author'),
    tile(VERDICT_TONES[verdict] ?? '', 'Checker', verdict, claim.verdict ? `${claim.verdict.provider}${claim.verdict.model ? `, ${claim.verdict.model}` : ''}` : 'no run yet'),
    tile(rate === null ? '' : rate < 0.8 ? 'bad' : 'ok', 'Planted bugs caught', rate === null ? '–' : pct(rate), m && m.total > 0 ? `${m.killed + m.timeout} of ${m.total}` : 'no run yet'),
  );
};

export const renderDetail = (claim: Claim | null, run: PublicRun | null, prBlocker: string | null, a: DetailActions): HTMLElement => {
  if (!claim) return h('div', { class: 'detail panel empty' }, muted('Pick a claim to see why it needs a decision.'));
  // A fix that is under way or finished stays on top. Otherwise the evidence comes first, then the decision.
  const fixFirst = run !== null || claim.status !== 'open' || claim.fix !== null;
  const fixBlock = claim.flags.length > 0 || fixFirst ? renderFix(claim, run, prBlocker, a) : null;
  return h(
    'div',
    { class: 'detail panel' },
    h('header', { class: 'detail-head' }, h('p', { class: 'id mono' }, claim.id, claim.status === 'open' ? null : h('span', { class: 'pill' }, claim.status)), h('h2', {}, claim.claim), muted(factsLine(claim)), evidenceTiles(claim)),
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
