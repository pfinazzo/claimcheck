/**
 * AC 1–3, 27: package shape, the preload surface, the hardening flags, no JavaScript source and no
 * innerHTML anywhere in the page, and a real Electron screenshot of the fixture repo.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { INVOKE_CHANNELS } from '../src/shared/ipc.ts';
import { buildFixtureRepo } from './fixture-repo.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

/** Every file under a folder, skipping what is installed or generated. */
const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};

const DESK_FUNCTIONS = ['openRepo', 'recents', 'getBoard', 'connect', 'testConnection', 'startPropose', 'startImplement', 'acceptRisk', 'copyPrompt', 'runClaimcheck', 'openPullRequest', 'openPath', 'wizardInit', 'wizardDraft', 'wizardFinish'];

test('AC 1: package.json shape', () => {
  const pkg = JSON.parse(read('package.json')) as { type: string; author: string; main: string; dependencies: Record<string, string>; devDependencies: Record<string, string>; scripts: Record<string, string> };
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.author, 'Patrick Finazzo');
  assert.equal(pkg.main, 'dist/main.mjs');
  assert.ok(pkg.dependencies['@anthropic-ai/sdk'] && pkg.dependencies['js-yaml']);
  for (const dev of ['electron', 'typescript', 'esbuild']) assert.ok(pkg.devDependencies[dev], dev);
  for (const s of ['start', 'test', 'screenshot', 'build', 'typecheck']) assert.ok(pkg.scripts[s], s);
  assert.ok(read('renderer/index.html').includes('<title>claimcheck Desk</title>'));
});

test('AC 2: the bridge exposes every call the page can make; main hardens the window', () => {
  const preload = read('src/preload.ts');
  assert.ok(preload.includes("exposeInMainWorld('desk'"));
  for (const fn of DESK_FUNCTIONS) assert.ok((INVOKE_CHANNELS as readonly string[]).includes(fn), fn);
  const main = read('src/main.ts');
  for (const flag of ['contextIsolation: true', 'nodeIntegration: false', 'sandbox: true']) assert.ok(main.includes(flag), flag);
});

test('AC 27: attribution on every source file', () => {
  const files = walk(ROOT).filter((f) => /\.(ts|html|css)$/.test(f) && !f.endsWith('.d.ts'));
  assert.ok(files.length > 20);
  for (const f of [...files, path.join(ROOT, 'package.json'), path.join(ROOT, 'README.md')]) {
    assert.ok(readFileSync(f, 'utf8').includes('Patrick Finazzo'), path.relative(ROOT, f));
  }
});

test('the app is TypeScript: no hand-written JavaScript source is left', () => {
  const js = walk(ROOT).filter((f) => /\.(js|mjs|cjs|jsx)$/.test(f));
  assert.deepEqual(js.map((f) => path.relative(ROOT, f)), []);
});

test('the page never builds markup from text: no innerHTML and friends, and a strict CSP', () => {
  const files = walk(path.join(ROOT, 'src', 'renderer')).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 6);
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), path.relative(ROOT, f));
  }
  const html = read('renderer/index.html');
  assert.ok(html.includes("script-src 'self'") && html.includes("default-src 'none'"));
  assert.ok(!html.includes('unsafe-inline') && !html.includes('unsafe-eval'));
  assert.ok(!/https?:\/\//.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'the page makes no external requests');
});

const pngSize = (buf: Buffer) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

test('AC 3: npm run screenshot writes a board PNG within 20 s', { timeout: 60000 }, () => {
  const electron = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
  if (!existsSync(electron)) {
    assert.fail('electron is not installed; run npm install');
  }
  assert.ok(existsSync(path.join(ROOT, 'dist', 'main.mjs')), 'run npm run build first');
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
