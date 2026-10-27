/**
 * Markdown in a pull request or issue: shown formatted, and never able to add anything but
 * formatting. Tests cover what GitHub people write most, and what a hostile description tries.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { mount, setDocument } from '../src/renderer/dom.ts';
import { parseInline, parseMarkdown, renderMarkdown } from '../src/renderer/markdown.ts';
import { createRecorder } from './helpers.ts';

const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>');
setDocument({ replacement: document });
const app = document.getElementById('app') as HTMLElement;

const drawText = ({ text, opened = createRecorder<string>() }: { text: string; opened?: ReturnType<typeof createRecorder<string>> }): HTMLElement => {
  mount({ parent: app, children: [renderMarkdown({ text, onOpenLink: (url) => opened.record(url) })] });
  return app;
};

test('headings, paragraphs, bold, italic, code and strikethrough are formatted', () => {
  const page = drawText({ text: '# Title\n\nSome **bold**, *italic*, __also bold__, ~~gone~~ and `code`.' });
  assert.equal(page.querySelector('h4')?.textContent, 'Title');
  assert.deepEqual([...page.querySelectorAll('strong')].map((node) => node.textContent), ['bold', 'also bold']);
  assert.equal(page.querySelector('em')?.textContent, 'italic');
  assert.equal(page.querySelector('del')?.textContent, 'gone');
  assert.equal(page.querySelector('p code')?.textContent, 'code');
  assert.ok(!page.textContent.includes('**'), 'no raw markers are left');
});

test('lists, nested lists and task lists draw as lists', () => {
  const page = drawText({ text: '- one\n- two\n  - nested\n- three\n\n1. first\n2. second\n\n- [x] done\n- [ ] not yet' });
  assert.equal(page.querySelectorAll('ul, ol').length, 4);
  assert.equal(page.querySelector('ul ul li')?.textContent, 'nested');
  assert.equal(page.querySelectorAll('ol li').length, 2);
  assert.deepEqual([...page.querySelectorAll('.md-check')].map((mark) => mark.getAttribute('aria-label')), ['done', 'not done']);
});

test('a table draws as a table, including pipes written inside a cell', () => {
  const page = drawText({ text: '| Claim | Confidence |\n| --- | --- |\n| c1: fees \\| taxes | 0.95 |\n| c2 | **0.60** |' });
  assert.deepEqual([...page.querySelectorAll('th')].map((cell) => cell.textContent), ['Claim', 'Confidence']);
  const rows = [...page.querySelectorAll('tbody tr')];
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.querySelector('td')?.textContent, 'c1: fees | taxes');
  assert.equal(rows[1]?.querySelector('strong')?.textContent, '0.60');
});

test('code fences keep their text exactly, including markers that would otherwise format', () => {
  const page = drawText({ text: 'Before\n\n```python\nx = **a**\n# not a heading\n```\n\nAfter' });
  assert.equal(page.querySelector('pre')?.textContent, 'x = **a**\n# not a heading');
  assert.equal(page.querySelector('h4'), null);
  assert.deepEqual([...page.querySelectorAll('p')].map((paragraph) => paragraph.textContent), ['Before', 'After']);
});

test('quotes, rules and line breaks are kept', () => {
  const page = drawText({ text: '> quoted **text**\n> second line\n\n---\n\nline one\nline two' });
  assert.equal(page.querySelector('blockquote strong')?.textContent, 'text');
  assert.ok(page.querySelector('hr'));
  const paragraphs = [...page.querySelectorAll('p')];
  assert.equal(paragraphs[paragraphs.length - 1]?.querySelectorAll('br').length, 1);
});

test('template comments are not shown, and the checklist after them still is', () => {
  const page = drawText({ text: '<!-- describe your change here -->\n## What changed\n<!-- another -->\n- [ ] tests added' });
  assert.ok(!page.textContent.includes('describe your change'));
  assert.equal(page.querySelector('h4')?.textContent, 'What changed');
  assert.equal(page.querySelectorAll('li').length, 1);
});

test('links open through the page, and only web links are links', () => {
  const opened = createRecorder<string>();
  const page = drawText({ text: 'See [the docs](https://example.com/docs), https://example.com/plain. and [bad](javascript:alert(1)) and [file](file:///c:/secret)', opened });
  const links = [...page.querySelectorAll('button.md-link')];
  assert.deepEqual(links.map((link) => link.textContent), ['the docs', 'https://example.com/plain']);
  (links[0] as HTMLElement).click();
  assert.deepEqual(opened.list(), ['https://example.com/docs']);
  assert.ok(page.textContent.includes('bad') && page.textContent.includes('file'), 'the words of an unsafe link are still shown');
  assert.equal(page.querySelector('a'), null, 'no anchor, so the window can never navigate');
});

test('HTML in a description is dropped and cannot become an element, a script or a remote image', () => {
  const page = drawText({ text: 'Hi <script>alert(1)</script><img src="https://evil.example/x.png" onerror="alert(1)" alt="a chart"> <b onclick="x()">bold?</b>\n\n<iframe src="https://evil.example"></iframe>\n\n<details><summary>More</summary>inside</details>' });
  for (const tag of ['script', 'img', 'iframe', 'details', 'summary', 'b']) assert.equal(page.querySelector(tag), null, tag);
  assert.ok(!page.innerHTML.includes('onerror') && !page.innerHTML.includes('onclick'));
  assert.ok(page.textContent.includes('[image: a chart]'), 'a picture is named, not loaded');
  assert.ok(page.textContent.includes('More') && page.textContent.includes('inside'));
});

test('a Markdown image is named and never loaded', () => {
  const page = drawText({ text: '![screenshot of the board](https://example.com/board.png)' });
  assert.equal(page.querySelector('img'), null);
  assert.ok(page.textContent.includes('[image: screenshot of the board]'));
});

test('unclosed and odd Markdown shows as text and does not crash or loop', () => {
  const odd = ['**never closed', '```\nnever closed fence', '[broken](', '| a | b |\n| nope', '> ', '- ', '* * *', '#', '\u0000\u0001', 'a'.repeat(50000), '*a '.repeat(3000), '- x\n'.repeat(2000), `${'> '.repeat(500)}deep`];
  odd.forEach((text) => assert.doesNotThrow(() => drawText({ text }), JSON.stringify(text.slice(0, 20))));
  assert.ok(drawText({ text: '**never closed' }).textContent.includes('**never closed'));
});

test('the tree has only the kinds the page knows how to draw', () => {
  const kinds = new Set(parseMarkdown({ text: '# a\n\npara\n\n- x\n\n> q\n\n```\nc\n```\n\n| a |\n| - |\n| b |\n\n---' }).map((block) => block.kind));
  assert.deepEqual([...kinds].toSorted(), ['code', 'heading', 'list', 'paragraph', 'quote', 'rule', 'table']);
  assert.deepEqual(parseInline({ text: '' }), []);
});
