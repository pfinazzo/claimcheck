/**
 * Nothing secret leaves the app: every channel to a model gets a planted secret and the test looks at
 * what actually crosses the boundary.
 *
 * @author Patrick Finazzo
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { requestProposalsWithStore, type ApiClient, type KeyStore } from '../src/lib/claude-api.ts';
import type { PromptContext } from '../src/shared/types.ts';
import { runClaude } from '../src/lib/claude-cli.ts';
import { readSafeRepoFile } from '../src/lib/fixer.ts';
import { buildImplementPrompt, buildProposePrompt, BLOCKED_TOOLS } from '../src/lib/prompts.ts';

const KEY = 'sk-ant-api03-aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1';
const PASSWORD_LINE = 'DB_PASSWORD = "Tr0ub4dor3xKcdZ9"';
const SECRETS = [KEY, 'Tr0ub4dor3xKcdZ9', 'hunter2hunter2'];

const makeContext = (): PromptContext => ({
  repo: { origin: 'https://dana:hunter2hunter2@github.com/acme/shop.git', path: 'C:/work/shop', branch: 'main', head: 'abcdef1234567' },
  config: { test_cmd: 'npm test' },
  claim: {
    id: 'c1',
    claim: `The client uses ${KEY} to call the api`,
    confidence: 0.9,
    criteria: [{ id: 1, text: 'Orders of $50 ship free.' }],
    verdict: { id: 'c1', verdict: 'REFUTED', reason: `the diff adds ${PASSWORD_LINE}`, evidence: [`+${PASSWORD_LINE}`], provider: 'stub', model: null, ts: '2026-01-01T00:00:00Z', runId: 'r1' },
    mutation: {
      total: 2, killed: 1, survived: 1, timeout: 0, catchRate: 0.5, ts: '2026-01-01T00:00:00Z', runId: 'r1',
      mutants: [{ outcome: 'survived', file: 'src/config.py', line_no: 3, original: `  token = "${KEY}"`, mutated: '  token = ""', cls: 'boundary' }],
    },
    killCondition: 'test: tests/test_shipping.py::test_a',
    files: ['src/config.py'],
    flags: ['refuted'],
    verifiedBy: ['cmd: pytest -q'],
    status: 'open',
    reopened: false,
    note: '',
    fix: null,
    history: [],
    risk: 0.5,
  },
});

const assertClean = ({ text, where }: { text: unknown; where: string }): void => {
  for (const secret of SECRETS) assert.ok(!String(text).includes(secret), `${secret} reached ${where}`);
};

test('the proposal and build prompts carry no secret from the claim, the evidence, the survivors or the remote url', () => {
  const promptContext = makeContext();
  assertClean({ text: buildProposePrompt({ context: promptContext }), where: 'the proposal prompt' });
  const proposal = { title: 't', summary: `use ${KEY}`, pros: [], cons: [], effort: 'small' as const, touches: ['src/a.py'], recommended: false };
  assertClean({ text: buildImplementPrompt({ context: promptContext, proposal, rejected: [] }), where: 'the build prompt' });
  assert.match(buildProposePrompt({ context: promptContext }), /\[REDACTED:/);
});

test('the API request is scrubbed even if the caller passes raw text', async () => {
  let sent: { system: string; messages: unknown } | undefined;
  const client: ApiClient = {
    messages: {
      create: (params) => {
        sent = params;
        return Promise.resolve({ content: [{ type: 'text', text: '{}' }] });
      },
    },
    models: { list: () => Promise.resolve({ 'data': [] }) },
  };
  const store: KeyStore = { saveKey: () => {}, hasKey: () => true, last4: () => null, clearKey: () => {}, loadKey: () => 'k' };
  await requestProposalsWithStore({
    store,
    system: `system with ${KEY}`,
    user: `user with ${PASSWORD_LINE} and ${KEY}`,
    schema: {},
    clientFactory: () => Promise.resolve(client),
  });
  assert.ok(sent);
  assertClean({ text: sent.system, where: 'the API system prompt' });
  assertClean({ text: JSON.stringify(sent.messages), where: 'the API user message' });
});

test('Claude Code gets the prompt on stdin, scrubbed, whatever built it', async () => {
  let stdin = '';
  const spawnFn = (() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: { on() {}, end: (entry: unknown) => { stdin = String(entry); } },
    });
    setTimeout(() => child.emit('close', 0), 5);
    return child;
  }) as never;
  await runClaude({ prompt: `look at ${KEY} and ${PASSWORD_LINE}`, bin: '/usr/bin/claude', spawnFn });
  assertClean({ text: stdin, where: 'Claude Code stdin' });
  assert.match(stdin, /look at \[REDACTED:anthropic-key\]/);
});

test('API mode file context: credential files are never read and other files are scrubbed', async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'out-'));
  const run = (...list: string[]) => execFileSync('git', list, { cwd: repo });
  run('init', '-q', '-b', 'main');
  mkdirSync(path.join(repo, 'src'));
  writeFileSync(path.join(repo, '.env'), 'TOKEN=abc123verylongsecretvalue\n');
  writeFileSync(path.join(repo, 'prod.env'), 'TOKEN=abc123verylongsecretvalue\n');
  writeFileSync(path.join(repo, 'src', 'config.py'), `${PASSWORD_LINE}\nx = 1\n`);
  assert.equal(await readSafeRepoFile({ repoPath: repo, ref: '.env' }), null);
  assert.equal(await readSafeRepoFile({ repoPath: repo, ref: 'prod.env' }), null);
  const text = await readSafeRepoFile({ repoPath: repo, ref: 'src/config.py' });
  assert.ok(text?.includes('x = 1'));
  assertClean({ text, where: 'API file context' });
});

test('Code mode may not read credential files, in any of the forms the shared cases name', () => {
  const denied = new Set(BLOCKED_TOOLS);
  for (const glob of ['./.env', '**/.env.*', '**/*.pem', '**/*.env', '**/secrets/**', '**/*.tfvars', '**/service-account*.json', '~/.ssh/**', '~/.aws/**', '~/.kube/**', '**/.git-credentials']) {
    assert.ok(denied.has(`Read(${glob})`), `Read(${glob}) is not denied`);
    assert.ok(denied.has(`Write(${glob})`), `Write(${glob}) is not denied`);
  }
  for (const text of ['Bash(cat *)', 'Bash(grep *)', 'Bash(curl *)', 'WebFetch', 'WebSearch']) assert.ok(denied.has(text), `${text} is not denied`);
});
