/**
 * Building the page without innerHTML. Every piece of text goes in as a text node, so a claim, a
 * verdict or a file name read from someone else's repo can never become markup or an attribute.
 *
 * @author Patrick Finazzo
 */

// The document the helpers build into; tests swap in their own.
const documentHolder: { doc: Document | null } = {
  doc: typeof document === 'undefined' ? null : document,
};

/** Tests give the helpers a DOM of their own. */
export const setDocument = ({ replacement }: { replacement: Document }): void => {
  documentHolder.doc = replacement;
};

export const readDocument = (): Document => {
  if (!documentHolder.doc) throw new Error('No document: call setDocument first.');
  return documentHolder.doc;
};

export type Child = Node | string | number | null | undefined | false;

export type Props = {
  class?: string;
  /** Plain attributes: id, type, value, placeholder, title, href, disabled, hidden... */
  attrs?: Record<string, string | number | boolean | null | undefined>;
  dataset?: Record<string, string | number | null | undefined>;
  on?: Partial<Record<'click' | 'input' | 'change' | 'keydown' | 'submit' | 'toggle', (event: Event) => void>>;
};

/** Create an element. `props` and children are all optional. */
export const makeElement = <K extends keyof HTMLElementTagNameMap>({ tag, props = {}, children = [] }: { tag: K; props?: Props; children?: readonly Child[] }): HTMLElementTagNameMap[K] => {
  const element = readDocument().createElement(tag);
  if (props.class) element.className = props.class;
  for (const [key, value] of Object.entries(props.attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    element.setAttribute(key, value === true ? '' : String(value));
  }
  for (const [dataKey, dataValue] of Object.entries(props.dataset ?? {})) {
    if (dataValue !== null && dataValue !== undefined) element.dataset[dataKey] = String(dataValue);
  }
  for (const [name, handler] of Object.entries(props.on ?? {})) {
    element.addEventListener(name, handler);
  }
  append({ parent: element, children });
  return element;
};

export const append = ({ parent, children }: { parent: Node; children: readonly Child[] }): void => {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' || typeof child === 'number' ? readDocument().createTextNode(String(child)) : child);
  }
};

/** Replace everything inside a node. */
export const mount = ({ parent, children = [] }: { parent: Node; children?: readonly Child[] }): void => {
  while (parent.firstChild) parent.removeChild(parent.firstChild);
  append({ parent, children });
};

export const makeText = ({ text }: { text: string }): Text => readDocument().createTextNode(text);

export const makeFragment = (...children: Child[]): DocumentFragment => {
  const fragment = readDocument().createDocumentFragment();
  append({ parent: fragment, children });
  return fragment;
};
