/**
 * AC 15: the key never touches disk in plain text; propose uses structured output.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_MODEL, createKeyStore, propose, proposeWithStore, testConnection, type ApiClient } from '../src/lib/claude-api.ts';

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
  decryptString: (buf: Buffer) => Buffer.from(buf.map((b) => b ^ 0x5a)).toString('utf8'),
};

test('AC 15: saved key is encrypted on disk, last4 only in meta, clear removes both', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'desk-keys-'));
  const store = createKeyStore({ safeStorage: fakeSafeStorage, dir });
  assert.equal(store.hasKey(), false);
  const key = 'sk-ant-api03-FAKEKEY-abcd';
  store.saveKey(key);
  assert.equal(store.hasKey(), true);
  for (const f of readdirSync(dir)) {
    const bytes = readFileSync(path.join(dir, f));
    assert.ok(!bytes.includes(Buffer.from(key)), `${f} must not contain the key`);
    assert.ok(!bytes.includes(Buffer.from('FAKEKEY')), `${f} must not contain the key body`);
  }
  assert.equal(store.last4(), 'abcd');
  assert.equal(store.loadKey(), key);
  store.clearKey();
  assert.equal(store.hasKey(), false);
  assert.equal(store.loadKey(), null);
});

test('AC 15: propose calls messages.create with structured output and returns the text block', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client: ApiClient = {
    messages: {
      create: (req) => {
        calls.push(req);
        return Promise.resolve({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"proposals":[]}' }] });
      },
    },
    models: { list: () => Promise.resolve({ data: [] }) },
  };
  const schema = { type: 'object' };
  const text = await propose({ system: 'SYS', user: 'USER', schema, client });
  assert.equal(text, '{"proposals":[]}');
  const req = calls[0] ?? {};
  assert.equal(req.model, DEFAULT_MODEL);
  assert.equal(req.max_tokens, 16000);
  assert.equal(req.system, 'SYS');
  assert.deepEqual(req.messages, [{ role: 'user', content: 'USER' }]);
  assert.deepEqual(req.output_config, { format: { type: 'json_schema', schema } });
  assert.ok(!('thinking' in req));
});

test('propose surfaces a refusal as an error', async () => {
  const client: ApiClient = {
    messages: { create: () => Promise.resolve({ stop_reason: 'refusal', stop_details: { explanation: 'nope' }, content: [] }) },
    models: { list: () => Promise.resolve({ data: [] }) },
  };
  await assert.rejects(propose({ system: 's', user: 'u', schema: {}, client }), /declined: nope/);
});

test('testConnection and proposeWithStore go through the store and a client factory', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'desk-keys-'));
  const store = createKeyStore({ safeStorage: fakeSafeStorage, dir });
  assert.deepEqual(await testConnection({ store }), { ok: false, error: 'No API key saved.' });
  store.saveKey('sk-test-1234');
  const seenKeys: string[] = [];
  const clientFactory = async (key: string): Promise<ApiClient> => {
    seenKeys.push(key);
    return {
      models: { list: async () => ({ data: [{ id: 'claude-opus-5-5' }] }) },
      messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":1}' }] }) },
    };
  };
  const res = await testConnection({ store, clientFactory });
  assert.deepEqual(res, { ok: true, models: ['claude-opus-5-5'], last4: '1234' });
  assert.equal(await proposeWithStore({ store, system: 's', user: 'u', schema: {}, clientFactory }), '{"ok":1}');
  assert.deepEqual(seenKeys, ['sk-test-1234', 'sk-test-1234']);
});
