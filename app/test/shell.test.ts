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
const read = ({ rel }: { rel: string }): string => readFileSync(path.join(ROOT, rel), 'utf8');

/** Every file under a folder, skipping what is installed or generated. */
const listFilesRecursively = ({ dir }: { dir: string }): string[] =>
  readdirSync(dir)
    .filter((name) => name !== 'node_modules' && name !== 'dist' && name !== '.git')
    .flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? listFilesRecursively({ dir: full }) : [full];
    });

const DESK_FUNCTIONS = ['openRepo', 'recents', 'getBoard', 'connect', 'testConnection', 'startPropose', 'startImplement', 'acceptRisk', 'copyPrompt', 'runClaimcheck', 'openPullRequest', 'openPath', 'wizardInit', 'wizardDraft', 'wizardFinish'];

test('AC 1: package.json shape', () => {
  const pkg = JSON.parse(read({ rel: 'package.json' })) as { type: string; author: string; main: string; dependencies: Record<string, string>; devDependencies: Record<string, string>; scripts: Record<string, string> };
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.author, 'Patrick Finazzo');
  assert.equal(pkg.main, 'dist/main.mjs');
  assert.ok(pkg.dependencies['@anthropic-ai/sdk'] && pkg.dependencies['js-yaml']);
  for (const dev of ['electron', 'typescript', 'esbuild']) assert.ok(pkg.devDependencies[dev], dev);
  for (const text of ['start', 'test', 'screenshot', 'build', 'typecheck']) assert.ok(pkg.scripts[text], text);
  assert.ok(read({ rel: 'renderer/index.html' }).includes('<title>claimcheck Desk</title>'));
});

test('AC 2: the bridge exposes every call the page can make; main hardens the window', () => {
  const preload = read({ rel: 'src/preload.ts' });
  assert.ok(preload.includes("exposeInMainWorld('desk'"));
  for (const functionName of DESK_FUNCTIONS) assert.ok((INVOKE_CHANNELS as readonly string[]).includes(functionName), functionName);
  const main = read({ rel: 'src/main.ts' });
  for (const flag of ['contextIsolation: true', 'nodeIntegration: false', 'sandbox: true']) assert.ok(main.includes(flag), flag);
});

test('AC 27: attribution on every source file', () => {
  const files = listFilesRecursively({ dir: ROOT }).filter((filePath) => /\.(ts|html|css)$/.test(filePath) && !filePath.endsWith('.d.ts'));
  assert.ok(files.length > 20);
  for (const text of [...files, path.join(ROOT, 'package.json'), path.join(ROOT, 'README.md')]) {
    assert.ok(readFileSync(text, 'utf8').includes('Patrick Finazzo'), path.relative(ROOT, text));
  }
});

test('the app is TypeScript: no hand-written JavaScript source is left', () => {
  const script = listFilesRecursively({ dir: ROOT }).filter((filePath) => /\.(js|mjs|cjs|jsx)$/.test(filePath));
  assert.deepEqual(script.map((filePath) => path.relative(ROOT, filePath)), []);
});

test('the page never builds markup from text: no innerHTML and friends, and a strict CSP', () => {
  const files = listFilesRecursively({ dir: path.join(ROOT, 'src', 'renderer') }).filter((filePath) => filePath.endsWith('.ts'));
  assert.ok(files.length >= 6);
  for (const filePath of files) {
    const text = readFileSync(filePath, 'utf8');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), path.relative(ROOT, filePath));
  }
  const html = read({ rel: 'renderer/index.html' });
  assert.ok(html.includes("script-src 'self'") && html.includes("default-src 'none'"));
  assert.ok(!html.includes('unsafe-inline') && !html.includes('unsafe-eval'));
  assert.ok(!/https?:\/\//.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'the page makes no external requests');
});

const readPngSize = ({ buffer }: { buffer: Buffer }) => ({ width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) });

test('AC 3: npm run screenshot writes a board PNG within 20 s', { timeout: 60000 }, () => {
  const electron = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
  if (!existsSync(electron)) {
    assert.fail('electron is not installed; run npm install');
  }
  assert.ok(existsSync(path.join(ROOT, 'dist', 'main.mjs')), 'run npm run build first');
  const repo = buildFixtureRepo();
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'desk-shot-')), 'board.png');
  const startTime = Date.now();
  const stdout = execFileSync(electron, ['.', '--screenshot', repo, out], { cwd: ROOT, timeout: 30000, shell: process.platform === 'win32', windowsHide: true }).toString();
  const elapsed = Date.now() - startTime;
  assert.ok(elapsed < 20000, `took ${elapsed} ms`);
  assert.match(stdout, /screenshot written/);
  assert.ok(statSync(out).size > 10000, 'png has content');
  const size = readPngSize({ buffer: readFileSync(out) });
  assert.ok(size.width >= 1200 && size.height >= 800, `size ${size.width}x${size.height}`);
});

test('styles use design tokens: no raw colors or pixel sizes outside the token blocks', () => {
  const css = readFileSync(path.join(ROOT, 'renderer', 'styles.css'), 'utf8');
  // Token blocks define the values; a media query cannot read a custom property, so its breakpoint stays literal.
  const body = css.replace(/:root\s*\{[^}]*\}/g, '').replace(/@media \(max-width: \d+px\)/g, '');
  assert.doesNotMatch(body, /#[0-9a-fA-F]{3,8}\b|\b\d+(\.\d+)?px\b/);
});
