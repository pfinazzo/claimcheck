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

export const DEFAULT_MODEL = 'claude-opus-5-5';

export interface SafeStorageLike {
  isEncryptionAvailable?: () => boolean;
  encryptString: (text: string) => Buffer;
  decryptString: (data: Buffer) => string;
}

export interface KeyStore {
  saveKey: (key: string) => void;
  hasKey: () => boolean;
  last4: () => string | null;
  clearKey: () => void;
  /** Only the API client reads this; the renderer never sees it. */
  loadKey: () => string | null;
}

/** The slice of the Anthropic SDK the app uses, so tests can pass a fake. */
export interface ApiClient {
  messages: {
    create: (params: {
      model: string;
      max_tokens: number;
      system: string;
      messages: { role: 'user'; content: string }[];
      output_config: { format: { type: 'json_schema'; schema: unknown } };
    }) => Promise<{ stop_reason?: string | null; stop_details?: { explanation?: string } | null; content?: { type: string; text?: string }[] }>;
  };
  models: { list: (params: { limit: number }) => Promise<{ data?: { id: string }[] }> };
}

export type ClientFactory = (apiKey: string) => Promise<ApiClient>;

/** A key store bound to a safeStorage implementation and a folder. */
export const createKeyStore = ({ safeStorage, dir }: { safeStorage: SafeStorageLike | null | undefined; dir: string }): KeyStore => {
  const binFile = path.join(dir, 'secrets.bin');
  const metaFile = path.join(dir, 'secrets.meta.json');
  const readMeta = (): { last4?: string } => {
    try {
      const data: unknown = JSON.parse(readFileSync(metaFile, 'utf8'));
      return data && typeof data === 'object' ? (data as { last4?: string }) : {};
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
      for (const f of [binFile, metaFile]) if (existsSync(f)) unlinkSync(f);
    },
    loadKey() {
      if (!existsSync(binFile) || !safeStorage) return null;
      return safeStorage.decryptString(readFileSync(binFile));
    },
  };
};

const sdkClient: ClientFactory = async (apiKey) => {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic({ apiKey }) as unknown as ApiClient;
};

export type ConnectionTest = { ok: true; models: string[]; last4: string | null } | { ok: false; error: string };

export const testConnection = async ({ store, clientFactory = sdkClient }: { store: KeyStore; clientFactory?: ClientFactory }): Promise<ConnectionTest> => {
  const key = store.loadKey();
  if (!key) return { ok: false, error: 'No API key saved.' };
  try {
    const client = await clientFactory(key);
    const page = await client.models.list({ limit: 5 });
    const ids = (page?.data ?? []).map((m) => m.id);
    return { ok: true, models: ids, last4: store.last4() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

export interface ProposeInput {
  system: string;
  user: string;
  schema: unknown;
  model?: string | undefined;
  client: ApiClient;
}

/** One structured-output call. Returns the first text block (JSON text). */
export const propose = async ({ system, user, schema, model = DEFAULT_MODEL, client }: ProposeInput): Promise<string> => {
  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema } },
  });
  if (response.stop_reason === 'refusal') throw new Error(`The model declined: ${response.stop_details?.explanation ?? 'no explanation'}`);
  const block = (response.content ?? []).find((b) => b.type === 'text');
  if (!block || typeof block.text !== 'string') throw new Error('The model returned no text block.');
  return block.text;
};

export const proposeWithStore = async ({
  store,
  system,
  user,
  schema,
  model,
  clientFactory = sdkClient,
}: {
  store: KeyStore;
  system: string;
  user: string;
  schema: unknown;
  model?: string | undefined;
  clientFactory?: ClientFactory;
}): Promise<string> => {
  const key = store.loadKey();
  if (!key) throw new Error('No API key saved.');
  const client = await clientFactory(key);
  // last line of defence: nothing secret-looking leaves, whatever built the text
  return propose({ system: redactText(system).text, user: redactText(user).text, schema, model, client });
};
