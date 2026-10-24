/**
 * API-key mode: the key is encrypted with Electron's safeStorage and never
 * written in plain text; proposals come from the official SDK with
 * structured output.
 *
 * @author Patrick Finazzo
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { redactText } from './redact.mjs';

export const DEFAULT_MODEL = 'claude-opus-5-5';

/** A key store bound to a safeStorage implementation and a folder. */
export const createKeyStore = ({ safeStorage, dir }) => {
  const binFile = path.join(dir, 'secrets.bin');
  const metaFile = path.join(dir, 'secrets.meta.json');
  const readMeta = () => {
    try {
      return JSON.parse(readFileSync(metaFile, 'utf8'));
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
    /** Only the API client reads this; the renderer never sees it. */
    loadKey() {
      if (!existsSync(binFile)) return null;
      return safeStorage.decryptString(readFileSync(binFile));
    },
  };
};

const sdkClient = async (apiKey) => {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic({ apiKey });
};

export const testConnection = async ({ store, clientFactory = sdkClient }) => {
  const key = store.loadKey();
  if (!key) return { ok: false, error: 'No API key saved.' };
  try {
    const client = await clientFactory(key);
    const page = await client.models.list({ limit: 5 });
    const ids = (page?.data ?? []).map((m) => m.id);
    return { ok: true, models: ids, last4: store.last4() };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
};

/** One structured-output call. Returns the first text block (JSON text). */
export const propose = async ({ system, user, schema, model = DEFAULT_MODEL, client }) => {
  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema } },
  });
  if (response.stop_reason === 'refusal') throw new Error(`The model declined: ${response.stop_details?.explanation ?? 'no explanation'}`);
  const block = (response.content ?? []).find((b) => b.type === 'text');
  if (!block) throw new Error('The model returned no text block.');
  return block.text;
};

export const proposeWithStore = async ({ store, system, user, schema, model, clientFactory = sdkClient }) => {
  const key = store.loadKey();
  if (!key) throw new Error('No API key saved.');
  const client = await clientFactory(key);
  // last line of defence: nothing secret-looking leaves, whatever built the text
  return propose({ system: redactText(system).text, user: redactText(user).text, schema, model, client });
};
