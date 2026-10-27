/**
 * Building the page without innerHTML. Every piece of text goes in as a text node, so a claim, a
 * verdict or a file name read from someone else's repo can never become markup or an attribute.
 *
 * @author Patrick Finazzo
 */

let doc: Document | null = typeof document === 'undefined' ? null : document;

/** Tests give the helpers a DOM of their own. */
export const setDocument = (d: Document): void => {
  doc = d;
};

export const getDocument = (): Document => {
  if (!doc) throw new Error('No document: call setDocument first.');
  return doc;
};

export type Child = Node | string | number | null | undefined | false;

export type Props = {
  class?: string;
  /** Plain attributes: id, type, value, placeholder, title, href, disabled, hidden... */
  attrs?: Record<string, string | number | boolean | null | undefined>;
  data?: Record<string, string | number | null | undefined>;
  on?: Partial<Record<'click' | 'input' | 'change' | 'keydown' | 'submit' | 'toggle', (event: Event) => void>>;
};

/** Create an element. `props` and children are all optional. */
export const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] => {
  const el = getDocument().createElement(tag);
  if (props.class) el.className = props.class;
  for (const [k, v] of Object.entries(props.attrs ?? {})) {
    // ARIA states are words, not flags: a pressed button is aria-pressed="true", and an unpressed one says "false".
    if (k.startsWith('aria-') && typeof v === 'boolean') {
      el.setAttribute(k, String(v));
      continue;
    }
    if (v === null || v === undefined || v === false) continue;
    el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const [k, v] of Object.entries(props.data ?? {})) {
    if (v !== null && v !== undefined) el.dataset[k] = String(v);
  }
  for (const [name, handler] of Object.entries(props.on ?? {})) {
    if (handler) el.addEventListener(name, handler);
  }
  append(el, children);
  return el;
};

export const append = (parent: Node, children: Child[]): void => {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'string' || typeof c === 'number' ? getDocument().createTextNode(String(c)) : c);
  }
};

/** Replace everything inside a node. */
export const mount = (parent: Node, ...children: Child[]): void => {
  while (parent.firstChild) parent.removeChild(parent.firstChild);
  append(parent, children);
};

export const text = (s: string): Text => getDocument().createTextNode(s);

export const frag = (...children: Child[]): DocumentFragment => {
  const f = getDocument().createDocumentFragment();
  append(f, children);
  return f;
};
