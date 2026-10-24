/**
 * Pure rendering for the claim panel, including the Fix flow's states.
 *
 * @author Patrick Finazzo
 */

import { FLAG_TEXT, catchPill, confidenceMeter, esc, pct, statusChip, verdictPill } from './app.js';

const list = (items, empty = '(none)') => (items?.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : `<div class="faint">${empty}</div>`);

const mutantRows = (claim) => {
  const ms = claim.mutation?.mutants ?? [];
  if (!ms.length) return '<div class="faint">No mutate run for these files yet.</div>';
  return `<table class="mutants">${ms
    .map(
      (m) =>
        `<tr><td class="${m.outcome}">${esc(m.outcome)}</td><td>${esc(m.file)}:${m.line_no}</td><td>${esc(m.cls)}</td><td>${esc(m.original.trim())}<span class="arrow">→</span>${esc(m.mutated.trim())}</td></tr>`,
    )
    .join('')}</table>`;
};

const whyFlagged = (claim) =>
  claim.flags.length
    ? `<div class="callout">${claim.flags.map((f) => `<div><strong>${esc(f)}</strong> — ${esc(FLAG_TEXT[f] ?? '')}</div>`).join('')}</div>`
    : '<div class="callout ok">Nothing flagged. The author\'s confidence, the independent check and the planted bugs agree.</div>';

const proposalCard = (p, i, run, claim) => `<div class="proposal" data-proposal="${i}">
  <div class="title">${esc(p.title)}<span class="pill effort ${p.effort === 'large' ? 'bad' : p.effort === 'medium' ? 'warn' : 'ok'}">${esc(p.effort)}</span></div>
  <div class="muted">${esc(p.summary)}</div>
  <h4 class="pros">Pros</h4>${list(p.pros)}
  <h4 class="cons">Cons</h4>${list(p.cons)}
  <div class="touches">touches: ${esc(p.touches.join(', ') || '(unspecified)')}</div>
  <div class="fix-actions">${
    run.mode === 'api'
      ? `<button class="btn sm" data-action="copy-implement" data-run="${esc(run.id)}" data-choice="${i}" data-claim="${esc(claim.id)}">Copy build prompt</button>`
      : `<button class="btn sm primary" data-action="use-approach" data-run="${esc(run.id)}" data-choice="${i}" data-claim="${esc(claim.id)}">Use this approach</button>`
  }</div>
</div>`;

const activityFeed = (run) => `<div class="activity">${(run.activity ?? []).slice(-30).map((a) => `<div>${esc(a)}</div>`).join('') || '<div>starting…</div>'}</div>`;

const resultBlock = (label, r) => {
  if (!r) return '';
  const ok = r.ok === true ? 'ok' : r.ok === 'manual' ? 'warn' : 'bad';
  const head = r.ok === true ? 'pass' : r.ok === 'manual' ? 'manual check' : 'fail';
  return `<div class="callout ${ok}"><strong>${esc(label)}: ${head}</strong>${r.tail ? `<pre class="code">${esc(r.tail)}</pre>` : ''}</div>`;
};

export const renderFixArea = (claim, run, ghOk) => {
  const promptText = run?.prompt ?? claim.promptText ?? '';
  const prompt = `<details data-prompt-for="${esc(claim.id)}"><summary>See the prompt</summary><pre class="code" data-prompt-text>${promptText ? esc(promptText) : 'The prompt is built when a repo is open.'}</pre></details>`;
  const baseActions = `<div class="fix-actions">
    <button class="btn primary" data-action="fix" data-claim="${esc(claim.id)}" ${run && run.status === 'running' ? 'disabled' : ''}>Fix this</button>
    <button class="btn" data-action="copy-prompt" data-claim="${esc(claim.id)}">Copy prompt</button>
    <button class="btn ghost" data-action="accept-risk-toggle" data-claim="${esc(claim.id)}">Accept risk</button>
  </div>
  <div class="note-row hidden" data-accept-row="${esc(claim.id)}"><input type="text" placeholder="One line on why this is acceptable" data-accept-note="${esc(claim.id)}" /><button class="btn sm" data-action="accept-risk" data-claim="${esc(claim.id)}">Accept</button></div>`;

  if (claim.status === 'resolved' && claim.fix && (!run || run.status !== 'running')) {
    const fix = claim.fix;
    return `<div class="block"><h3>What the issue was</h3>${whyFlagged({ ...claim, flags: claim.flags.length ? claim.flags : ['resolved'] })}</div>
<div class="block"><h3>Now</h3>
  <div class="callout ok"><strong>Resolved with “${esc(fix.approach ?? 'a fix')}”</strong> on <code>${esc(fix.branch ?? '')}</code></div>
  ${resultBlock('Project tests', fix.tests)}${resultBlock('Kill condition', fix.killCondition)}
  ${fix.commits?.length ? `<pre class="code">${esc(fix.commits.join('\n'))}</pre>` : ''}
  <div class="fix-actions">
    ${fix.prUrl ? `<a class="btn" href="#" data-action="open-path" data-target="${esc(fix.prUrl)}">View pull request</a>` : `<button class="btn primary" data-action="open-pr" data-run="${esc(fix.runId ?? '')}" data-claim="${esc(claim.id)}" ${ghOk ? '' : 'disabled title="gh auth login first"'}>Open pull request</button>`}
    <button class="btn" data-action="copy-text" data-text="${esc(fix.branch ?? '')}">Copy branch name</button>
    <button class="btn ghost" data-action="open-path" data-target="${esc(fix.worktree ?? '')}">Open worktree</button>
  </div>
</div>`;
  }

  if (!run && claim.status === 'fixing' && claim.fix?.error) {
    const fix = claim.fix;
    return `<div class="block"><h3>The last fix did not pass</h3><div class="callout"><strong>${esc(fix.error)}</strong> on <code>${esc(fix.branch ?? '')}</code> (“${esc(fix.approach ?? '')}”)</div>${resultBlock('Project tests', fix.tests)}${resultBlock('Kill condition', fix.killCondition)}<div class="fix-actions"><button class="btn ghost" data-action="open-path" data-target="${esc(fix.worktree ?? '')}">Open worktree</button></div>${baseActions}${prompt}</div>`;
  }
  if (!run) return `<div class="block"><h3>Fix this</h3><div class="muted">Claude reads the code without changing anything and proposes three to four ways to resolve this, each with its pros and cons. You choose one; Claude builds it with tests on a new branch in a separate worktree, and the board updates when the tests pass.</div>${baseActions}${prompt}</div>`;

  if (run.kind === 'propose') {
    if (run.status === 'running') return `<div class="block"><h3>Fix this</h3><div class="callout accent"><span class="spinner"></span>Claude is reading the code and drafting approaches…</div>${activityFeed(run)}${baseActions}${prompt}</div>`;
    if (run.status === 'failed') return `<div class="block"><h3>Fix this</h3><div class="callout"><strong>Could not get proposals.</strong> ${esc(run.error ?? '')}${run.needsSignIn ? ' <button class="btn sm" data-action="connect">Sign in</button>' : ''}</div>${baseActions}${prompt}</div>`;
    return `<div class="block"><h3>Choose an approach</h3><div class="muted">Claude builds only the one you pick.${run.mode === 'api' ? ' API mode cannot edit your repo: copy the build prompt into Claude Code instead.' : ''}</div>${(run.proposals ?? []).map((p, i) => proposalCard(p, i, run, claim)).join('')}${baseActions}${prompt}</div>`;
  }

  // implement
  if (run.status === 'running') return `<div class="block"><h3>Building “${esc(run.proposal?.title ?? '')}”</h3><div class="callout warn"><span class="spinner"></span>Claude is working on <code>${esc(run.branch ?? '')}</code> in a separate worktree. Nothing in your checkout changes.</div>${activityFeed(run)}</div>`;
  if (run.status === 'failed') return `<div class="block"><h3>The fix did not pass</h3><div class="callout"><strong>${esc(run.error ?? 'failed')}</strong></div>${resultBlock('Project tests', run.tests)}${resultBlock('Kill condition', run.killCondition)}${activityFeed(run)}<div class="fix-actions"><button class="btn ghost" data-action="open-path" data-target="${esc(run.worktree ?? '')}">Open worktree</button></div>${baseActions}</div>`;
  return `<div class="block"><h3>Resolved</h3><div class="callout ok"><strong>Tests pass on <code>${esc(run.branch ?? '')}</code>.</strong> ${esc(run.summary ?? '')}</div>${resultBlock('Project tests', run.tests)}${resultBlock('Kill condition', run.killCondition)}${run.commits?.length ? `<pre class="code">${esc(run.commits.join('\n'))}</pre>` : ''}
  <div class="fix-actions">${run.prUrl ? `<a class="btn" href="#" data-action="open-path" data-target="${esc(run.prUrl)}">View pull request</a>` : `<button class="btn primary" data-action="open-pr" data-run="${esc(run.id)}" data-claim="${esc(claim.id)}" ${ghOk ? '' : 'disabled title="gh auth login first"'}>Open pull request</button>`}<button class="btn" data-action="copy-text" data-text="${esc(run.branch ?? '')}">Copy branch name</button><button class="btn ghost" data-action="open-path" data-target="${esc(run.worktree ?? '')}">Open worktree</button></div></div>`;
};

export const renderPanel = (claim, run, { ghOk = false } = {}) => {
  if (!claim) return '<div class="muted">Pick a claim to see why it was flagged and fix it.</div>';
  const v = claim.verdict;
  return `<div class="panel-head">
  <div class="eyebrow">${claim.flags.length ? '<span class="pill bad">needs a decision</span>' : '<span class="pill ok">backed</span>'}<span class="mono">${esc(claim.id)}</span></div>
  <h2>${esc(claim.claim)}</h2>
  <div class="chips">${statusChip(claim)}${verdictPill(claim)}${catchPill(claim)}<span class="pill mono">risk ${claim.risk.toFixed(2)}</span></div>
  <button class="btn sm ghost close" data-action="close-panel">✕</button>
</div>
<div class="panel-body">
  <div class="block"><h3>Why it is here</h3>${whyFlagged(claim)}</div>
  <div class="block"><h3>Stated confidence</h3>${confidenceMeter(claim)}</div>
  ${renderFixArea(claim, run, ghOk)}
  <div class="block"><h3>Criteria it supports</h3>${claim.criteria.length ? `<ul>${claim.criteria.map((c) => `<li><strong>${c.id}.</strong> ${esc(c.text || '(not in the frozen spec)')}</li>`).join('')}</ul>` : '<div class="faint">none cited</div>'}</div>
  <div class="block"><h3>Independent check</h3>${
    v
      ? `<dl class="kv"><dt>verdict</dt><dd>${verdictPill(claim)}</dd><dt>reason</dt><dd>${esc(v.reason || '(none)')}</dd><dt>by</dt><dd class="mono">${esc(v.provider)}${v.model ? ` · ${esc(v.model)}` : ''} · ${esc(v.ts ?? '')}</dd></dl>${v.evidence?.length ? `<pre class="code">${esc(v.evidence.join('\n'))}</pre>` : ''}`
      : '<div class="faint">No check has run. Press Run claimcheck.</div>'
  }</div>
  <div class="block"><h3>Planted bugs ${claim.mutation ? `· ${pct(claim.mutation.catchRate)} caught (${claim.mutation.killed + claim.mutation.timeout}/${claim.mutation.total})` : ''}</h3>${mutantRows(claim)}</div>
  <div class="block"><h3>Kill condition</h3><pre class="code">${esc(claim.killCondition)}</pre></div>
  <div class="block"><h3>What the author said verified it</h3>${list(claim.verifiedBy)}</div>
  <div class="block"><h3>Files</h3><div class="mono">${esc(claim.files.join('\n'))}</div></div>
  <div class="block"><h3>Ledger history</h3><div class="history">${
    claim.history.length
      ? claim.history.map((h) => `<div>${esc(h.ts)} · ${esc(h.type)} · ${h.type === 'claim' ? `conf ${h.confidence} · ${esc(h.checker?.verdict ?? '')} · caught ${pct(h.mutation?.catch_rate ?? null)}` : `${esc(h.outcome)} (${esc(h.outcome_source)}) ${esc(h.evidence ?? '')}`}</div>`).join('')
      : '<div class="faint">nothing yet</div>'
  }</div></div>
</div>`;
};
