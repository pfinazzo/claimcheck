/**
 * The prompts the Fix flow sends, the shape proposals must have, and the tool
 * allowlists Claude runs under. Templates live in ../prompts/ so an edit takes
 * effect on the next run.
 *
 * @author Patrick Finazzo
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Proposal, PromptContext } from '../shared/types.ts';
import { resolveAppRoot } from './paths.ts';
import { redactText } from './redact.ts';
import { toText } from '../shared/text.ts';

const resolvePromptsDir = (): string => path.join(resolveAppRoot(), 'prompts');

export const CLOSING_SENTENCE =
  'Do not change any code yet. Propose three to four genuinely different ways to resolve this, each with pros, cons, effort (small, medium or large) and the files it touches, and wait for me to choose.';

export const PROPOSE_TOOLS: string[] = ['Read', 'Grep', 'Glob'];

/** Credential files, in the relative, home and any-depth forms Claude Code's deny rules understand. */
export const SECRET_PATHS = [
  './.env', './.env.*', '**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/id_rsa*', '**/id_ed25519*', '**/id_ecdsa*',
  '**/.npmrc', '**/.pypirc', '**/.netrc', '**/credentials*', '**/*.env', '**/*.jks', '**/*.keystore', '**/*.p8', '**/*.ppk', '**/*.kdbx', '**/*.gpg',
  '**/*.tfvars', '**/terraform.tfstate*', '**/service-account*.json', '**/*serviceaccount*.json', '**/client_secret*.json', '**/firebase-adminsdk*.json',
  '**/.git-credentials', '**/.htpasswd', '**/.pgpass', '**/secrets/**', '**/secrets.*', '**/secret.*', '**/.ssh/**', '**/.aws/**', '**/.kube/**', '**/.docker/**',
  '~/.ssh/**', '~/.aws/**', '~/.kube/**', '~/.docker/**', '~/.config/gh/**', '~/.gnupg/**', '~/.npmrc', '~/.netrc', '~/.git-credentials', '../**',
];

/** Files whose edit would change what the app or the repo's tooling runs, or the frozen contract. */
export const PROTECTED_WRITES = [
  './.claimcheck/config.toml', './.claimcheck/spec.md', './.claimcheck/spec.lock', './.claimcheck/ledger.jsonl', './.claimcheck/app-state.json',
  './.git/**', './.github/**', './.claude/**', './.husky/**',
];

export const IMPLEMENT_TOOLS = [
  'Read', 'Grep', 'Glob', 'Edit', 'Write', 'TodoWrite',
  'Bash(npm run *)', 'Bash(npm test *)', 'Bash(npm test)',
  'Bash(pnpm run *)', 'Bash(pnpm test *)', 'Bash(pnpm test)',
  'Bash(yarn run *)', 'Bash(yarn test *)', 'Bash(yarn test)',
  'Bash(npx vitest *)', 'Bash(npx jest *)', 'Bash(npx playwright *)',
  'Bash(npx prettier *)', 'Bash(npx eslint *)', 'Bash(npx tsc *)',
  'Bash(pytest *)', 'Bash(pytest)', 'Bash(python -m pytest *)', 'Bash(python3 -m pytest *)', 'Bash(py -3 -m pytest *)',
  'Bash(go test *)', 'Bash(go vet *)', 'Bash(go build *)', 'Bash(cargo test *)', 'Bash(cargo build *)', 'Bash(cargo check *)',
  'Bash(make test *)', 'Bash(make test)', 'Bash(make check)',
  'Bash(claimcheck run)', 'Bash(claimcheck run *)',
  'Bash(git status)', 'Bash(git status --short)', 'Bash(git diff)', 'Bash(git diff --stat)', 'Bash(git diff HEAD)', 'Bash(git diff HEAD --stat)',
  'Bash(git log --oneline)', 'Bash(git log --oneline -n *)', 'Bash(git show --stat HEAD)',
  'Bash(git add *)', 'Bash(git commit *)',
  'Bash(ls)', 'Bash(ls *)',
];

/**
 * Nothing in this list can be undone by a later allow. Claude never reads credential files, never
 * writes anywhere git or CI reads from, never edits the frozen spec or the app's own config, and
 * never uses the forms of git and sed that can write a file or reach the network. `cat`, `grep` and
 * `sed` are not allowed at all: the Read, Grep and Glob tools do the same job and obey these denies.
 */
export const BLOCKED_TOOLS = [
  'Bash(git push *)', 'Bash(git push)', 'Bash(git remote *)', 'Bash(git fetch *)', 'Bash(git pull *)', 'Bash(git clone *)',
  'Bash(git config *)', 'Bash(git -c *)', 'Bash(git * --output*)', 'Bash(git submodule *)', 'Bash(gh *)', 'Bash(curl *)', 'Bash(wget *)',
  'Bash(npm publish *)', 'Bash(npm install *)', 'Bash(npm i *)', 'Bash(pnpm add *)', 'Bash(yarn add *)',
  'Bash(pip install *)', 'Bash(pip3 install *)', 'Bash(uv add *)', 'Bash(cargo add *)',
  'Bash(cat *)', 'Bash(sed *)', 'Bash(grep *)', 'Bash(rg *)', 'Bash(find *)',
  'WebFetch', 'WebSearch',
  ...SECRET_PATHS.flatMap((filePath) => [`Read(${filePath})`, `Edit(${filePath})`, `Write(${filePath})`]),
  ...PROTECTED_WRITES.flatMap((filePath) => [`Edit(${filePath})`, `Write(${filePath})`]),
];

export const PROPOSALS_SCHEMA = {
  type: 'object',
  properties: {
    proposals: {
      type: 'array',
      minItems: 3,
      maxItems: 4,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          pros: { type: 'array', items: { type: 'string' } },
          cons: { type: 'array', items: { type: 'string' } },
          effort: { type: 'string', enum: ['small', 'medium', 'large'] },
          touches: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'summary', 'pros', 'cons', 'effort', 'touches'],
        additionalProperties: false,
      },
    },
  },
  required: ['proposals'],
  additionalProperties: false,
};

const readTemplate = ({ name }: { name: string }): string => readFileSync(path.join(resolvePromptsDir(), name), 'utf8');

const makeFill = ({ template, values }: { template: string; values: Record<string, unknown> }): string => template.replace(/\{\{(\w+)\}\}/g, (_: string, key: string) => toText({ value: values[key] }));

const formatBullet = ({ items, empty = '(none)' }: { items: readonly string[] | undefined; empty?: string }): string => (items?.length ? items.map((entry) => `- ${entry}`).join('\n') : empty);

/** The claim written out, shared by the propose and implement prompts. */
export const describeClaim = ({ context }: { context: PromptContext }): string => {
  const { claim } = context;
  const verdict = claim.verdict
    ? `${claim.verdict.verdict} — ${claim.verdict.reason || '(no reason given)'}`
    : 'no independent check has run yet';
  const evidence = formatBullet({ items: claim.verdict?.evidence ?? [], empty: '(none quoted)' });
  const survivors = (claim.mutation?.mutants ?? []).filter((mutant) => mutant.outcome === 'survived');
  const mutantLines = survivors.length
    ? survivors.map((mutant) => `- ${mutant.file}:${mutant.line_no}  ${mutant.original.trim()}  →  ${mutant.mutated.trim()}  (${mutant.cls})`).join('\n')
    : '(none survived)';
  const rate = claim.mutation?.catchRate;
  const catchLine = claim.mutation
    ? `${claim.mutation.killed + claim.mutation.timeout} of ${claim.mutation.total} planted bugs were caught (catch rate ${rate === null ? 'n/a' : rate})`
    : 'the mutation harness has not run';
  return [
    `Claim: ${claim.claim}`,
    `Stated confidence: ${claim.confidence}`,
    `Spec criteria it supports:\n${formatBullet({ items: claim.criteria.map((criterion) => `${criterion.id}. ${criterion.text}`) })}`,
    `Independent checker verdict: ${verdict}`,
    `Checker evidence (verbatim diff lines):\n${evidence}`,
    `Planted-bug results: ${catchLine}`,
    `Planted bugs the tests did NOT catch:\n${mutantLines}`,
    `Kill condition the author gave: ${claim.killCondition}`,
    `Files: ${claim.files.join(', ')}`,
    `Why it was flagged: ${claim.flags.join(', ') || 'manual'}`,
  ].join('\n\n');
};

const renderHeader = ({ context }: { context: PromptContext }): string =>
  [
    `Repository: ${context.repo.origin || '(no origin)'}`,
    `On this computer it is at: ${context.repo.path} (branch ${context.repo.branch} at ${String(context.repo.head ?? '').slice(0, 7)}). Work in that folder. Every path below is relative to it.`,
  ].join('\n');

/** AC 17. */
export const buildProposePrompt = ({ context }: { context: PromptContext }): string =>
  redactText({ input: `${renderHeader({ context })}\n\n${makeFill({ template: readTemplate({ name: 'propose.md' }), values: { claim: describeClaim({ context }), test_cmd: context.config.test_cmd } })}\n\n${CLOSING_SENTENCE}` }).text;

/** The build prompt for a chosen approach. */
export const buildImplementPrompt = ({ context, proposal, rejected = [] }: { context: PromptContext; proposal: Proposal; rejected?: readonly Proposal[] }): string =>
  redactText({ input: `${renderHeader({ context })}\n\n${makeFill({ template: readTemplate({ name: 'implement.md' }), values: {
    claim: describeClaim({ context }),
    proposal: [
      `Title: ${proposal.title}`,
      `Summary: ${proposal.summary}`,
      `Pros: ${proposal.pros.join('; ')}`,
      `Cons: ${proposal.cons.join('; ')}`,
      `Files it expects to touch: ${proposal.touches.join(', ')}`,
    ].join('\n'),
    rejected: rejected.length ? rejected.map((proposal) => `- ${proposal.title}: ${proposal.cons.join('; ')}`).join('\n') : '(none)',
    test_cmd: context.config.test_cmd,
    kill_condition: context.claim.killCondition,
  } })}` }).text;
