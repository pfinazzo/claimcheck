/**
 * AC 1–3, 27: package shape, the preload surface, the hardening flags, and a
 * real Electron screenshot of the fixture repo.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildFixtureRepo } from './fixture-repo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const DESK_FUNCTIONS = ['openRepo', 'recents', 'getBoard', 'onBoard', 'connect', 'testConnection', 'startPropose', 'startImplement', 'onRunUpdate', 'acceptRisk', 'copyPrompt', 'runClaimcheck', 'openPullRequest', 'openPath'];

test('AC 1: package.json shape', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.author, 'Patrick Finazzo');
  assert.ok(pkg.dependencies['@anthropic-ai/sdk'] && pkg.dependencies['js-yaml']);
  assert.ok(pkg.devDependencies.electron);
  for (const s of ['start', 'test', 'screenshot']) assert.ok(pkg.scripts[s], s);
  assert.ok(read('renderer/index.html').includes('<title>claimcheck Desk</title>'));
});

test('AC 2: preload exposes exactly the desk surface; main hardens the window', () => {
  const preload = read('preload.cjs');
  assert.ok(preload.includes("exposeInMainWorld('desk'"));
  for (const fn of DESK_FUNCTIONS) assert.ok(new RegExp(`\\b${fn}:`).test(preload), fn);
  const main = read('main.mjs');
  for (const flag of ['contextIsolation: true', 'nodeIntegration: false', 'sandbox: true']) assert.ok(main.includes(flag), flag);
});

test('AC 27: attribution on every app source file', () => {
  const files = ['package.json', 'main.mjs', 'preload.cjs', 'renderer/app.js', 'renderer/index.html', 'README.md'];
  for (const f of files) assert.ok(read(f).includes('Patrick Finazzo'), f);
  const libDir = path.join(ROOT, 'lib');
  for (const f of ['store.mjs', 'watcher.mjs', 'claude-cli.mjs', 'claude-api.mjs', 'prompts.mjs', 'fixer.mjs', 'ledger.mjs', 'gh.mjs', 'runner.mjs', 'recents.mjs', 'desk-api.mjs', 'toml.mjs']) {
    assert.ok(readFileSync(path.join(libDir, f), 'utf8').includes('@author Patrick Finazzo'), f);
  }
});

const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

test('AC 3: npm run screenshot writes a board PNG within 20 s', { timeout: 60000 }, () => {
  const electron = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
  if (!existsSync(electron)) {
    assert.fail('electron is not installed; run npm install');
  }
  const repo = buildFixtureRepo();
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'desk-shot-')), 'board.png');
  const t0 = Date.now();
  const stdout = execFileSync(electron, ['.', '--screenshot', repo, out], { cwd: ROOT, timeout: 30000, shell: process.platform === 'win32', windowsHide: true }).toString();
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 20000, `took ${elapsed} ms`);
  assert.match(stdout, /screenshot written/);
  assert.ok(statSync(out).size > 10000, 'png has content');
  const size = pngSize(readFileSync(out));
  assert.ok(size.width >= 1200 && size.height >= 800, `size ${size.width}x${size.height}`);
});
