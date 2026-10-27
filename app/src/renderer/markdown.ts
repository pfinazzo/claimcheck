/**
 * Shows a pull request's or issue's Markdown the way GitHub does: headings, lists, tables, code,
 * quotes, task lists, bold, italic, links.
 *
 * Why this is written by hand and not a library: the text comes from strangers. This file turns it
 * into a small tree of known node kinds, then builds each one with DOM calls. Nothing is ever
 * parsed as HTML, so a description can show bold text but cannot add a script, a form or an image
 * that loads from the internet. HTML tags in the text are dropped, and only http and https links
 * are kept.
 *
 * @author Patrick Finazzo
 */

import { makeElement, type Child } from './dom.ts';

// ---- the tree ------------------------------------------------------------------------------------------------------------

type InlineKind = 'text' | 'strong' | 'em' | 'del' | 'code' | 'link' | 'break';

export type InlineNode = { kind: InlineKind; text: string; url: string; children: readonly InlineNode[] };

type BlockKind = 'heading' | 'paragraph' | 'code' | 'quote' | 'list' | 'table' | 'rule';

export type ListItem = { checked: boolean | null; blocks: readonly Block[] };

export type Block = {
  kind: BlockKind;
  level: number;
  text: string;
  inline: readonly InlineNode[];
  blocks: readonly Block[];
  isOrdered: boolean;
  items: readonly ListItem[];
  header: readonly (readonly InlineNode[])[];
  rows: readonly (readonly (readonly InlineNode[])[])[];
};

const makeInline = ({ kind, text = '', url = '', children = [] }: { kind: InlineKind; text?: string; url?: string; children?: readonly InlineNode[] }): InlineNode => ({ kind, text, url, children });

const makeBlock = ({ kind, ...rest }: { kind: BlockKind } & Partial<Omit<Block, 'kind'>>): Block => ({ kind, level: 0, text: '', inline: [], blocks: [], isOrdered: false, items: [], header: [], rows: [], ...rest });

// ---- inline text ---------------------------------------------------------------------------------------------------------

const KNOWN_TAGS = 'details|summary|p|div|span|br|hr|img|a|b|i|em|strong|code|pre|ul|ol|li|table|thead|tbody|tr|td|th|h[1-6]|sub|sup|kbd|blockquote|picture|source|center|u|s|del|ins|mark|small|font';

const INLINE_PATTERN = new RegExp(
  [
    '(?<ticks>`{1,3})(?<code>[^`][\\s\\S]*?)\\k<ticks>(?!`)',
    '!\\[(?<imageAlt>[^\\]]*)\\]\\((?<imageUrl>[^)\\s]*)(?:\\s+"[^"]*")?\\)',
    '\\[(?<linkText>[^\\]]+)\\]\\((?<linkUrl>[^)\\s]+)(?:\\s+"[^"]*")?\\)',
    '(?<auto>https?:\\/\\/[^\\s<>()\\[\\]]*[^\\s<>()\\[\\].,;:!?\'"])',
    '\\*\\*(?<strong>[^*]+?)\\*\\*',
    '__(?<strongUnderscore>[^_]+?)__',
    '~~(?<del>[^~]+?)~~',
    '\\*(?<em>[^*\\s][^*]*?)\\*',
    '(?<![A-Za-z0-9])_(?<emUnderscore>[^_\\s][^_]*?)_(?![A-Za-z0-9])',
    `<(?<tagClose>\\/)?(?<tagName>${KNOWN_TAGS})(?<tagRest>\\s[^>]*)?\\/?>`,
    '(?<newline>\\n)',
  ].join('|'),
  'i',
);

/** Only web links are kept. A javascript: or file: link is shown as the words it was written with. */
const isWebUrl = ({ url }: { url: string }): boolean => {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
};

const readAlt = ({ tagRest }: { tagRest: string }): string => /\balt\s*=\s*"([^"]*)"/i.exec(tagRest)?.[1] ?? '';

const toImagePlaceholder = ({ alt }: { alt: string }): InlineNode => makeInline({ kind: 'text', text: alt ? `[image: ${alt}]` : '[image]' });

type InlineGroups = Record<string, string | undefined>;

const toTagNodes = ({ groups }: { groups: InlineGroups }): readonly InlineNode[] => {
  const name = (groups.tagName ?? '').toLowerCase();
  if (groups.tagClose) return [];
  if (name === 'br') return [makeInline({ kind: 'break' })];
  return name === 'img' ? [toImagePlaceholder({ alt: readAlt({ tagRest: groups.tagRest ?? '' }) })] : [];
};

const toLinkNodes = ({ text, url }: { text: string; url: string }): readonly InlineNode[] =>
  isWebUrl({ url }) ? [makeInline({ kind: 'link', url, children: parseInline({ text }) })] : parseInline({ text });

const WRAPPERS = new Map<string, InlineKind>([
  ['strong', 'strong'],
  ['strongUnderscore', 'strong'],
  ['del', 'del'],
  ['em', 'em'],
  ['emUnderscore', 'em'],
]);

const toWrappedNodes = ({ groups }: { groups: InlineGroups }): readonly InlineNode[] | null => {
  const [name, text] = [...WRAPPERS.keys()].map((key) => [key, groups[key]] as const).find(([, value]) => value !== undefined) ?? ['', undefined];
  const kind = WRAPPERS.get(name);
  return kind && text !== undefined ? [makeInline({ kind, children: parseInline({ text }) })] : null;
};

const toMatchedNodes = ({ groups }: { groups: InlineGroups }): readonly InlineNode[] => {
  if (groups.code !== undefined) return [makeInline({ kind: 'code', text: groups.code.trim() })];
  if (groups.imageAlt !== undefined) return [toImagePlaceholder({ alt: groups.imageAlt })];
  if (groups.linkText !== undefined) return toLinkNodes({ text: groups.linkText, url: groups.linkUrl ?? '' });
  if (groups.auto !== undefined) return [makeInline({ kind: 'link', url: groups.auto, children: [makeInline({ kind: 'text', text: groups.auto })] })];
  if (groups.newline !== undefined) return [makeInline({ kind: 'break' })];
  if (groups.tagName !== undefined) return toTagNodes({ groups });
  return toWrappedNodes({ groups }) ?? [];
};

/** Bold, italic, strikethrough, code, links and line breaks inside one run of text. Everything else stays as the words it is. */
export const parseInline = ({ text }: { text: string }): readonly InlineNode[] => {
  const match = INLINE_PATTERN.exec(text);
  if (!match) return text ? [makeInline({ kind: 'text', text })] : [];
  const before = text.slice(0, match.index);
  const after = text.slice(match.index + match[0].length);
  return [...(before ? [makeInline({ kind: 'text', text: before })] : []), ...toMatchedNodes({ groups: { ...match.groups } }), ...parseInline({ text: after })];
};

// ---- blocks --------------------------------------------------------------------------------------------------------------

type Step = { block: Block | null; next: number };

type Reader = (options: { lines: readonly string[]; index: number }) => Step | null;

const readLine = ({ lines, index }: { lines: readonly string[]; index: number }): string => lines[index] ?? '';

const isBlank = ({ line }: { line: string }): boolean => line.trim() === '';

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LIST_MARKER = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;

const readBlankLine: Reader = ({ lines, index }) => (isBlank({ line: readLine({ lines, index }) }) ? { block: null, next: index + 1 } : null);

const readFence: Reader = ({ lines, index }) => {
  const opening = FENCE.exec(readLine({ lines, index }));
  if (!opening) return null;
  const marker = opening[1] ?? '```';
  const bodyStart = index + 1;
  const closing = lines.findIndex((line, at) => at >= bodyStart && line.trim().startsWith(marker) && line.trim().replaceAll(marker[0] ?? '`', '') === '');
  const end = closing === -1 ? lines.length : closing;
  return { block: makeBlock({ kind: 'code', text: lines.slice(bodyStart, end).join('\n') }), next: closing === -1 ? end : end + 1 };
};

const readHeading: Reader = ({ lines, index }) => {
  const match = HEADING.exec(readLine({ lines, index }));
  return match ? { block: makeBlock({ kind: 'heading', level: (match[1] ?? '#').length, inline: parseInline({ text: match[2] ?? '' }) }), next: index + 1 } : null;
};

const readRule: Reader = ({ lines, index }) => (RULE.test(readLine({ lines, index })) ? { block: makeBlock({ kind: 'rule' }), next: index + 1 } : null);

const readQuote: Reader = ({ lines, index }) => {
  if (!QUOTE.test(readLine({ lines, index }))) return null;
  const length = lines.slice(index).findIndex((line) => !QUOTE.test(line));
  const quoted = lines.slice(index, length === -1 ? lines.length : index + length);
  return { block: makeBlock({ kind: 'quote', blocks: parseBlocks({ lines: quoted.map((line) => QUOTE.exec(line)?.[1] ?? '') }) }), next: index + quoted.length };
};

const countIndent = ({ line }: { line: string }): number => (/^\s*/.exec(line)?.[0] ?? '').replaceAll('\t', '    ').length;

const stripIndent = ({ line, width }: { line: string; width: number }): string => line.replaceAll('\t', '    ').slice(Math.min(width, countIndent({ line })));

/** The lines that belong to one list item: its own line, then every line indented beneath it. A blank line only continues the item if an indented line follows. */
const findItemEnd = ({ lines, from, indent }: { lines: readonly string[]; from: number; indent: number }): number => {
  const stop = lines.findIndex((line, at) => {
    if (at <= from) return false;
    if (isBlank({ line })) return !isIndentedAfter({ lines, at, indent });
    return countIndent({ line }) <= indent;
  });
  return stop === -1 ? lines.length : stop;
};

const isIndentedAfter = ({ lines, at, indent }: { lines: readonly string[]; at: number; indent: number }): boolean => {
  const nextLine = lines.slice(at).find((line) => !isBlank({ line }));
  return nextLine !== undefined && countIndent({ line: nextLine }) > indent;
};

const TASK = /^\[( |x|X)\]\s+(.*)$/;

const toListItem = ({ lines, indent }: { lines: readonly string[]; indent: number }): ListItem => {
  const first = LIST_MARKER.exec(lines[0] ?? '');
  const markerText = first?.[3] ?? '';
  const task = TASK.exec(markerText);
  const body = task?.[2] ?? markerText;
  const rest = lines.slice(1).map((line) => stripIndent({ line, width: indent + 2 }));
  return { checked: task ? task[1] !== ' ' : null, blocks: parseBlocks({ lines: [body, ...rest] }) };
};

/** Numbered items form one list, and each bullet character forms its own, as on GitHub. */
const toMarkerKind = ({ marker }: { marker: string }): string => (/^\d/.test(marker) ? 'ordered' : marker);

const readItems = ({ lines, index, indent, kind, found }: { lines: readonly string[]; index: number; indent: number; kind: string; found: readonly ListItem[] }): { items: readonly ListItem[]; next: number } => {
  const line = readLine({ lines, index });
  const marker = LIST_MARKER.exec(line);
  if (index >= lines.length || !marker || countIndent({ line }) !== indent || toMarkerKind({ marker: marker[2] ?? '' }) !== kind) return { items: found, next: index };
  const end = findItemEnd({ lines, from: index, indent });
  const afterBlank = isBlank({ line: readLine({ lines, index: end }) }) && index < lines.length ? end + 1 : end;
  return readItems({ lines, index: afterBlank, indent, kind, found: [...found, toListItem({ lines: lines.slice(index, end), indent })] });
};

const readList: Reader = ({ lines, index }) => {
  const first = LIST_MARKER.exec(readLine({ lines, index }));
  if (!first || RULE.test(readLine({ lines, index }))) return null;
  const indent = countIndent({ line: readLine({ lines, index }) });
  const { items, next } = readItems({ lines, index, indent, kind: toMarkerKind({ marker: first[2] ?? '' }), found: [] });
  return { block: makeBlock({ kind: 'list', isOrdered: /^\d/.test(first[2] ?? ''), items }), next };
};

const splitCells = ({ line }: { line: string }): readonly string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.replaceAll('\\|', '|').trim());

const readTable: Reader = ({ lines, index }) => {
  const header = readLine({ lines, index });
  if (!header.includes('|') || !TABLE_DIVIDER.test(readLine({ lines, index: index + 1 })) || !readLine({ lines, index: index + 1 }).includes('-')) return null;
  const bodyStart = index + 2;
  const length = lines.slice(bodyStart).findIndex((line) => isBlank({ line }) || !line.includes('|'));
  const end = length === -1 ? lines.length : bodyStart + length;
  return {
    block: makeBlock({
      kind: 'table',
      header: splitCells({ line: header }).map((cell) => parseInline({ text: cell })),
      rows: lines.slice(bodyStart, end).map((line) => splitCells({ line }).map((cell) => parseInline({ text: cell }))),
    }),
    next: end,
  };
};

const STRUCTURE_READERS: readonly Reader[] = [readFence, readHeading, readRule, readQuote, readList, readTable];

const readStructure: Reader = ({ lines, index }) => STRUCTURE_READERS.reduce<Step | null>((found, reader) => found ?? reader({ lines, index }), null);

const readParagraph: Reader = ({ lines, index }) => {
  const length = lines.slice(index + 1).findIndex((line, at) => isBlank({ line }) || readStructure({ lines, index: index + 1 + at }) !== null);
  const end = length === -1 ? lines.length : index + 1 + length;
  return { block: makeBlock({ kind: 'paragraph', inline: parseInline({ text: lines.slice(index, end).map((line) => line.trim()).join('\n') }) }), next: end };
};

const readBlock: Reader = ({ lines, index }) => readBlankLine({ lines, index }) ?? readStructure({ lines, index }) ?? readParagraph({ lines, index });

const collectBlocks = ({ lines, index, found }: { lines: readonly string[]; index: number; found: readonly Block[] }): readonly Block[] => {
  if (index >= lines.length) return found;
  const step = readBlock({ lines, index });
  return collectBlocks({ lines, index: Math.max(step?.next ?? index + 1, index + 1), found: step?.block ? [...found, step.block] : found });
};

/** Comments in a pull request template are for the writer, so they are not shown. */
const stripComments = ({ text }: { text: string }): string => text.replace(/<!--[\s\S]*?-->/g, '');

const parseBlocks = ({ lines }: { lines: readonly string[] }): readonly Block[] => collectBlocks({ lines, index: 0, found: [] });

/** The Markdown as a tree of known kinds of block. The page draws that tree, so nothing in the text can add anything else. */
export const parseMarkdown = ({ text }: { text: string }): readonly Block[] => parseBlocks({ lines: stripComments({ text }).replaceAll('\r\n', '\n').split('\n') });

// ---- drawing -------------------------------------------------------------------------------------------------------------

export type MarkdownOptions = { text: string; onOpenLink: (url: string) => void };

type DrawOptions = { onOpenLink: (url: string) => void };

const drawInlines = ({ inline, onOpenLink }: { inline: readonly InlineNode[] } & DrawOptions): Child[] => inline.map((node) => drawInline({ node, onOpenLink }));

const INLINE_TAGS = new Map<InlineKind, 'strong' | 'em' | 'del' | 'code'>([
  ['strong', 'strong'],
  ['em', 'em'],
  ['del', 'del'],
  ['code', 'code'],
]);

/** A link is a button: a real anchor would make the window navigate away from Desk. The address is its hover text. */
const drawLink = ({ node, onOpenLink }: { node: InlineNode } & DrawOptions): HTMLElement =>
  makeElement({ tag: 'button', props: { class: 'md-link', attrs: { type: 'button', title: node.url }, on: { click: () => onOpenLink(node.url) } }, children: drawInlines({ inline: node.children, onOpenLink }) });

const drawInline = ({ node, onOpenLink }: { node: InlineNode } & DrawOptions): Child => {
  if (node.kind === 'text') return node.text;
  if (node.kind === 'break') return makeElement({ tag: 'br' });
  if (node.kind === 'link') return drawLink({ node, onOpenLink });
  const tag = INLINE_TAGS.get(node.kind) ?? 'span';
  return makeElement({ tag, props: {}, children: node.kind === 'code' ? [node.text] : drawInlines({ inline: node.children, onOpenLink }) });
};

const HEADING_TAGS = new Map<number, 'h4' | 'h5' | 'h6'>([
  [1, 'h4'],
  [2, 'h4'],
  [3, 'h5'],
]);

const drawListItem = ({ listItem, onOpenLink }: { listItem: ListItem } & DrawOptions): HTMLElement =>
  makeElement({
    tag: 'li',
    props: { class: listItem.checked === null ? '' : 'md-task' },
    children: [listItem.checked === null ? null : makeElement({ tag: 'span', props: { class: 'md-check', attrs: { role: 'img', 'aria-label': listItem.checked ? 'done' : 'not done' } }, children: [listItem.checked ? '☑' : '☐'] }), ...drawBlocks({ blocks: listItem.blocks, onOpenLink })],
  });

const drawTable = ({ block, onOpenLink }: { block: Block } & DrawOptions): HTMLElement => {
  const drawRow = ({ cells, tag }: { cells: readonly (readonly InlineNode[])[]; tag: 'th' | 'td' }): HTMLElement =>
    makeElement({ tag: 'tr', props: {}, children: cells.map((cell) => makeElement({ tag, props: {}, children: drawInlines({ inline: cell, onOpenLink }) })) });
  return makeElement({
    tag: 'table',
    props: { class: 'md-table' },
    children: [makeElement({ tag: 'thead', props: {}, children: [drawRow({ cells: block.header, tag: 'th' })] }), makeElement({ tag: 'tbody', props: {}, children: block.rows.map((cells) => drawRow({ cells, tag: 'td' })) })],
  });
};

const BLOCK_DRAWERS = new Map<BlockKind, (options: { block: Block } & DrawOptions) => Child>([
  ['heading', ({ block, onOpenLink }) => makeElement({ tag: HEADING_TAGS.get(block.level) ?? 'h6', props: { class: 'md-heading' }, children: drawInlines({ inline: block.inline, onOpenLink }) })],
  ['paragraph', ({ block, onOpenLink }) => makeElement({ tag: 'p', props: {}, children: drawInlines({ inline: block.inline, onOpenLink }) })],
  ['code', ({ block }) => makeElement({ tag: 'pre', props: { class: 'code' }, children: [block.text] })],
  ['quote', ({ block, onOpenLink }) => makeElement({ tag: 'blockquote', props: {}, children: drawBlocks({ blocks: block.blocks, onOpenLink }) })],
  ['list', ({ block, onOpenLink }) => makeElement({ tag: block.isOrdered ? 'ol' : 'ul', props: { class: 'md-list' }, children: block.items.map((listItem) => drawListItem({ listItem, onOpenLink })) })],
  ['table', ({ block, onOpenLink }) => makeElement({ tag: 'div', props: { class: 'md-table-wrap' }, children: [drawTable({ block, onOpenLink })] })],
  ['rule', () => makeElement({ tag: 'hr' })],
]);

const drawBlocks = ({ blocks, onOpenLink }: { blocks: readonly Block[] } & DrawOptions): Child[] => blocks.map((block) => BLOCK_DRAWERS.get(block.kind)?.({ block, onOpenLink }) ?? null);

/** The Markdown as a block of page elements. Links call `onOpenLink` and never navigate the window. */
export const renderMarkdown = ({ text, onOpenLink }: MarkdownOptions): HTMLElement => makeElement({ tag: 'div', props: { class: 'markdown' }, children: drawBlocks({ blocks: parseMarkdown({ text }), onOpenLink }) });
