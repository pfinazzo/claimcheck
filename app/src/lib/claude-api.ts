/**
 * API-key mode: the key is encrypted with Electron's safeStorage and never
 * written in plain text; proposals come from the official SDK with
 * structured output.
 *
 * @author Patrick Finazzo
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { redactText } from './redact.ts';
import { API_TIMEOUT_MS } from './timeouts.ts';

export const DEFAULT_MODEL = 'claude-opus-5-5';

export type SafeStorageLike = {
  isEncryptionAvailable?: () => boolean;
  encryptString: (text: string) => Buffer;
  decryptString: (payload: Buffer) => string;
};

export type KeyStore = {
  saveKey: (key: string) => void;
  hasKey: () => boolean;
  last4: () => string | null;
  clearKey: () => void;
  /** Only the API client reads this; the renderer never sees it. */
  loadKey: () => string | null;
};

/** The slice of the Anthropic SDK the app uses, so tests can pass a fake. */
export type ApiClient = {
  messages: {
    create: (params: {
      model: string;
      max_tokens: number;
      system: string;
      messages: readonly { role: 'user'; content: string }[];
      output_config: { format: { type: 'json_schema'; schema: Record<string, unknown> } };
    }) => Promise<{ stop_reason?: string | null; stop_details?: { explanation?: string | null } | null; content?: readonly { type: string; text?: string }[] }>;
  };
  // `data` is quoted because it is the SDK's own field name, not one of ours.
  models: { list: (params: { limit: number }) => Promise<{ 'data'?: readonly { id: string }[] }> };
};

export type ClientFactory = (options: { apiKey: string }) => Promise<ApiClient>;

/** A key store bound to a safeStorage implementation and a folder. */
export const createKeyStore = ({ safeStorage, dir }: { safeStorage: SafeStorageLike | null | undefined; dir: string }): KeyStore => {
  const binFile = path.join(dir, 'secrets.bin');
  const metaFile = path.join(dir, 'secrets.meta.json');
  const readMeta = (): { last4?: string } => {
    try {
      const payload: unknown = JSON.parse(readFileSync(metaFile, 'utf8'));
      return payload && typeof payload === 'object' ? (payload) : {};
    } catch {
      return {};
    }
  };
  return {
    saveKey(key) {
      if (!safeStorage?.isEncryptionAvailable?.()) throw new Error('This computer cannot encrypt the key (safeStorage unavailable).');
      mkdirSync(dir, { recursive: true });
      writeFileSync(binFile, safeStorage.encryptString(String(key)));
      writeFileSync(metaFile, JSON.stringify({ last4: String(key).slice(-4), savedAt: new Date().toISOString() }), 'utf8');
    },
    hasKey: () => existsSync(binFile),
    last4: () => readMeta().last4 ?? null,
    clearKey() {
      for (const text of [binFile, metaFile]) if (existsSync(text)) unlinkSync(text);
    },
    loadKey() {
      if (!existsSync(binFile) || !safeStorage) return null;
      return safeStorage.decryptString(readFileSync(binFile));
    },
  };
};

const createSdkClient: ClientFactory = async ({ apiKey }) => {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey, timeout: API_TIMEOUT_MS });
  return {
    messages: { create: (params) => client.messages.create({ ...params, messages: [...params.messages], stream: false }) },
    models: { list: (query) => client.models.list(query) },
  };
};

export type ConnectionTest = { ok: true; models: readonly string[]; last4: string | null } | { ok: false; error: string };

export const testConnection = async ({ store, clientFactory = createSdkClient }: { store: KeyStore; clientFactory?: ClientFactory }): Promise<ConnectionTest> => {
  const key = store.loadKey();
  if (!key) return { ok: false, error: 'No API key saved.' };
  try {
    const client = await clientFactory({ apiKey: key });
    const page = await client.models.list({ limit: 5 });
    const ids = (page.data ?? []).map((model) => model.id);
    return { ok: true, models: ids, last4: store.last4() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

export type ProposeInput = {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  model?: string | undefined;
  client: ApiClient;
};

/** One structured-output call. Returns the first text block (JSON text). */
export const requestProposals = async ({ system, user, schema, model = DEFAULT_MODEL, client }: ProposeInput): Promise<string> => {
  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema } },
  });
  if (response.stop_reason === 'refusal') throw new Error(`The model declined: ${response.stop_details?.explanation ?? 'no explanation'}`);
  const block = (response.content ?? []).find((block) => block.type === 'text');
  if (!block || typeof block.text !== 'string') throw new Error('The model returned no text block.');
  return block.text;
};

export const requestProposalsWithStore = async ({
  store,
  system,
  user,
  schema,
  model,
  clientFactory = createSdkClient,
}: {
  store: KeyStore;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  model?: string | undefined;
  clientFactory?: ClientFactory;
}): Promise<string> => {
  const key = store.loadKey();
  if (!key) throw new Error('No API key saved.');
  const client = await clientFactory({ apiKey: key });
  // last line of defence: nothing secret-looking leaves, whatever built the text
  return requestProposals({ system: redactText({ input: system }).text, user: redactText({ input: user }).text, schema, model, client });
};
