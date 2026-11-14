import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import plugin from '../index.ts';
import { CODEX_CREDENTIAL_KEY, CodexEndpointConfig } from '../src/openai-codex/protocol.ts';
import { DatabaseCodexCredentialStore } from '../src/openai-codex/store.ts';
import { expiryFromResponse, parseUsageSnapshot } from '../src/openai-codex/manager-values.ts';
import { codexUsageToWire } from '../src/openai-codex/usage-wire.ts';
import * as usageWire from '../src/openai-codex/usage-wire.ts';
import type { CodexAuthStatus, CodexUsageSnapshot } from '../api.ts';

// dstu-llm serde_json uses `arbitrary_precision` (src-tauri/crates/dstu-llm/Cargo.toml:40):
// integer serde fields / `as_u64` / `as_i64` see the JSON literal, so `1.0` is not an
// integer and the full 64-bit range is accepted. These tests go through the plugin's
// IPC commands and the shared llmCodexAuth service, with raw JSON text on the wire.

class MemorySettings implements SettingsStore {
  values = new Map<string, string>();
  save(key: string, value: string) { this.values.set(key, value); }
  get(key: string) { return this.values.get(key) ?? null; }
  delete(key: string) { return this.values.delete(key); }
  listByPrefix(prefix: string) {
    return [...this.values].filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value, updatedAt: '2026-11-04T00:00:00+00:00' }));
  }
  deleteByPrefix(prefix: string) { let n = 0; for (const key of [...this.values.keys()]) if (key.startsWith(prefix)) { this.values.delete(key); n++; } return n; }
  async saveSecret(key: string, value: string) { this.save(key, value); }
  async getSecret(key: string) { return this.get(key); }
  async deleteSecret(key: string) { return this.delete(key); }
}

const session = (overrides: Record<string, string>) => {
  const fields: Record<string, string> = {
    schemaVersion: '1', accessToken: '"access-secret"', refreshToken: '"refresh-secret"', idToken: 'null',
    expiresAtUnixMs: String(Date.now() + 3_600_000), accountId: '"account-1"', email: 'null', planType: '"plus"',
    isFedramp: 'false', lastRefreshAt: 'null', ...overrides,
  };
  return `{${Object.entries(fields).map(([key, value]) => `"${key}":${value}`).join(',')}}`;
};

async function rawServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const http = createServer(handler);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { base: `http://127.0.0.1:${address.port}/`, close: () => new Promise<void>(resolve => http.close(() => resolve())) };
}
const sendRaw = (res: ServerResponse, body: string, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(body);
};

async function host(stored: string, base?: string) {
  const settings = new MemorySettings();
  settings.save(CODEX_CREDENTIAL_KEY, stored);
  const test = base === undefined
    ? await createTestHost({ plugins: [plugin], provide: { settings }, app: { version: '0.11.0' } })
    : await createTestHost({ plugins: [[plugin, { codexEndpoints: CodexEndpointConfig.forTest(base) }]], provide: { settings }, app: { version: '0.11.0' } });
  return { test, settings };
}

describe('codex integer width (serde arbitrary_precision)', () => {
  it('requestAuth keeps the stored i64 expiry exact before any IPC boundary', async () => {
    for (const expiry of ['9007199254740993', '9007199254740992', '9223372036854775807']) {
      const { test } = await host(session({ expiresAtUnixMs: expiry, lastRefreshAt: '-9223372036854775808' }));
      try {
        const auth = await test.ctx.llmCodexAuth.requestAuth(false);
        // types.rs CodexRequestAuth::expires_at_unix_ms -> i64, not an IPC DTO.
        expect(BigInt(auth.expiresAtUnixMs())).toBe(BigInt(expiry));
        expect(auth.expiresAtUnixMs()).toBe(BigInt(expiry));
        // Host service and IPC have different boundaries: only IPC may round.
        expect((await test.ctx.llmCodexAuth.status()).expiresAtUnixMs).toBe(BigInt(expiry));
        expect((await test.invoke<CodexAuthStatus>('openai_codex_auth_status')).expiresAtUnixMs).toBe(Number(expiry));
      } finally { await test.dispose(); }
    }
  });

  it('credential persistence roundtrips both full-i64 time fields without Number', async () => {
    for (const lastRefreshAt of ['-9223372036854775808', '9007199254740993', '9223372036854775807']) {
      const { test, settings } = await host(session({ expiresAtUnixMs: '9223372036854775807', lastRefreshAt }));
      try {
        // The same production store class used by the command/service manager.
        const store = new DatabaseCodexCredentialStore(settings);
        const loaded = (await store.load())!;
        expect(loaded.expiresAtUnixMs).toBe(9223372036854775807n);
        expect(loaded.lastRefreshAt).toBe(BigInt(lastRefreshAt));
        await store.save(loaded.clone());
        const raw = settings.get(CODEX_CREDENTIAL_KEY)!;
        expect(raw).toContain('"expiresAtUnixMs":9223372036854775807');
        expect(raw).toContain(`"lastRefreshAt":${lastRefreshAt}`);
        const reloaded = (await store.load())!;
        expect(reloaded.lastRefreshAt).toBe(BigInt(lastRefreshAt));
        expect((await test.ctx.llmCodexAuth.requestAuth(false)).expiresAtUnixMs()).toBe(9223372036854775807n);
      } finally { await test.dispose(); }
    }
  });

  it('token expires_in clamps as i64 before exact expiry arithmetic and persistence', async () => {
    for (const [expiresIn, seconds] of [['-9223372036854775808', 60n], ['9223372036854775807', 86400n]] as const) {
      const http = await rawServer((req, res) => {
        if (req.url === '/oauth/token') sendRaw(res, `{"access_token":"renewed","expires_in":${expiresIn}}`);
        else sendRaw(res, '{}', 404);
      });
      const { test, settings } = await host(session({}), http.base);
      try {
        const before = BigInt(Date.now());
        const auth = await test.ctx.llmCodexAuth.requestAuth(true);
        const after = BigInt(Date.now());
        expect(typeof auth.expiresAtUnixMs()).toBe('bigint');
        expect(auth.expiresAtUnixMs() >= before + seconds * 1000n).toBe(true);
        expect(auth.expiresAtUnixMs() <= after + seconds * 1000n).toBe(true);
        const reloaded = (await new DatabaseCodexCredentialStore(settings).load())!;
        expect(reloaded.expiresAtUnixMs).toBe(auth.expiresAtUnixMs());
        expect(reloaded.lastRefreshAt! >= before && reloaded.lastRefreshAt! <= after).toBe(true);
      } finally { await test.dispose(); await http.close(); }
    }
  });

  it('expiry_from_response follows i64 saturating_add over the full supported i64 domain', () => {
    // manager.rs:1794-1798: independent arithmetic vectors complement the real refresh path above.
    expect(expiryFromResponse(9007199254740993n, 60n)).toBe(9007199254800993n);
    expect(expiryFromResponse(9223372036854775806n, 60n)).toBe(9223372036854775807n);
    expect(expiryFromResponse(-9223372036854775808n, -9223372036854775808n)).toBe(-9223372036854715808n);
    expect(expiryFromResponse(0n, null)).toBe(3600000n);
  });

  it('stored session rejects float literals and out-of-range i64 like StoredCodexSession serde', async () => {
    for (const overrides of <Record<string, string>[]>[
      { schemaVersion: '1.0' },
      { schemaVersion: '257' },
      { expiresAtUnixMs: `${Date.now() + 3_600_000}.0` },
      { expiresAtUnixMs: '9223372036854775808' },
      { lastRefreshAt: '1e3' },
    ]) {
      const { test } = await host(session(overrides));
      try {
        const status = await test.invoke<CodexAuthStatus>('openai_codex_auth_status');
        expect(status.phase, JSON.stringify(overrides)).toBe('error');
        expect(status.lastError?.code).toBe('credential_store_failed');
      } finally { await test.dispose(); }
    }
  });

  it('stored session accepts the full i64 range beyond 2^53 (D3: IPC number like serde_json)', async () => {
    const { test } = await host(session({ expiresAtUnixMs: '9007199254740993', lastRefreshAt: '-9223372036854775808' }));
    try {
      const status = await test.invoke<CodexAuthStatus>('openai_codex_auth_status');
      expect(status.phase).toBe('authenticated');
      expect(status.hasUsableSession).toBe(true);
      expect(status.expiresAtUnixMs).toBe(9007199254740992);
    } finally { await test.dispose(); }
  });

  it('token response expires_in: Option<i64> rejects float literals as MalformedResponse', async () => {
    let tokenCalls = 0;
    const http = await rawServer((req, res) => {
      if (req.url === '/oauth/token') { tokenCalls++; sendRaw(res, '{"access_token":"new-access","expires_in":3600.0}'); }
      else sendRaw(res, '{}', 404);
    });
    const { test } = await host(session({}), http.base);
    try {
      await expect(test.ctx.llmCodexAuth.requestAuth(true)).rejects.toMatchObject({
        kind: 'MalformedResponse', detail: expect.objectContaining({ field: 'token response' }),
      });
      expect(tokenCalls).toBe(1);
    } finally { await test.dispose(); await http.close(); }
  });

  it('usage integers follow value_as_u64 / timestamp_at / u64 saturating and i64 wrapping arithmetic', async () => {
    const http = await rawServer((req, res) => {
      if (req.url === '/wham/usage') {
        sendRaw(res, '{"rate_limits_by_limit_id":{'
          + '"float":{"primary":{"used_percent":5,"window_seconds":18000.0,"resets_at":2000000000.0}},'
          + '"huge":{"primary":{"window_seconds":18446744073709551615,"resets_at":9007199254740993}},'
          + '"wrap":{"primary":{"window_minutes":"+7","resets_in_seconds":18446744073709551615}}}}');
      } else sendRaw(res, '{}', 404);
    });
    const { test } = await host(session({}), http.base);
    try {
      const usage = await test.invoke<CodexUsageSnapshot>('openai_codex_usage');
      const fetchedSeconds = BigInt(Math.trunc(usage.fetchedAt / 1000));
      const byId = usage.rateLimitsByLimitId!;
      // as_u64/as_i64 reject `18000.0` / `2000000000.0`; only used_percent survives.
      expect(byId.float!.primary).toEqual({ usedPercent: 5 });
      // u64::MAX.saturating_add(59) / 60; i64 timestamp beyond 2^53.
      expect(byId.huge!.primary).toEqual({ windowDurationMins: Number(18446744073709551615n / 60n), resetsAt: 9007199254740992 });
      // u64::from_str accepts "+7"; `u64::MAX as i64` is -1, so resets_at = fetched/1000 - 1.
      expect(byId.wrap!.primary).toEqual({ windowDurationMins: 7, resetsAt: Number(fetchedSeconds - 1n) });
    } finally { await test.dispose(); await http.close(); }
  });

  it('attachment preview usize accepts values beyond 2^53 instead of a JS safe-integer cap', async () => {
    const { test } = await host(session({}));
    try {
      const page = test.ctx.llmMultimodal.parseAttachmentPreviewPage({ pageIndex: 2 ** 60, width: 4294967295 });
      expect(page).toEqual({ page_index: 2n ** 60n, width: 4294967295 });
      expect(() => test.ctx.llmMultimodal.parseAttachmentPreviewPage({ pageIndex: 0, width: 4294967296 }))
        .toThrow('invalid type for `width`');
      expect(() => test.ctx.llmMultimodal.parseAttachmentPreviewPage({ pageIndex: -1 }))
        .toThrow('invalid type for `page_index`');
    } finally { await test.dispose(); }
  });
});

// serde struct deserialization rejects a repeated known field (`duplicate field`); an alias
// fills the same slot as its canonical name; unknown keys are ignored even when repeated.
// JSON.parse would keep the last value, so these go through raw text.
describe('serde struct duplicate fields and recursion limit', () => {
  it('loads stored-session sequences with default tails and exact i64 fields', async () => {
    const cases = [
      { raw: '[1,"access-secret","refresh-secret",null,9007199254740993,"account-1"]', expiry: 9007199254740993n, refreshed: null, fedramp: false,
        metadata: { idToken: null, email: null, planType: null } },
      { raw: '[1,"access-secret","refresh-secret","id-secret",9223372036854775807,"account-1","mail@example.com","pro",true,-9223372036854775808]', expiry: 9223372036854775807n, refreshed: -9223372036854775808n, fedramp: true,
        metadata: { idToken: 'id-secret', email: 'mail@example.com', planType: 'pro' } },
    ];
    for (const vector of cases) {
      const { test, settings } = await host(vector.raw);
      try {
        const status = await test.ctx.llmCodexAuth.status();
        expect(status.phase).toBe('authenticated');
        expect(status.isFedramp).toBe(vector.fedramp);
        const auth = await test.ctx.llmCodexAuth.requestAuth(false);
        expect(auth.accessToken()).toBe('access-secret');
        expect(auth.accountId()).toBe('account-1');
        expect(auth.expiresAtUnixMs()).toBe(vector.expiry);
        const store = new DatabaseCodexCredentialStore(settings), loaded = (await store.load())!;
        expect(loaded.lastRefreshAt).toBe(vector.refreshed);
        expect(loaded).toMatchObject({ ...vector.metadata, refreshToken: 'refresh-secret' });
        // Rust Serialize emits the canonical object even when Deserialize read a sequence.
        await store.save(loaded.clone());
        expect(settings.get(CODEX_CREDENTIAL_KEY)).toContain('"schemaVersion":1');
        expect((await store.load())!.expiresAtUnixMs).toBe(vector.expiry);
      } finally { await test.dispose(); }
    }
  });

  it('stored-session sequences reject missing required slots, extras and invalid known fields', async () => {
    for (const raw of [
      '[1,"a","r",null,9007199254740993]',
      '[1,"a","r",null,9007199254740993,"account",null,null,true,null,0]',
      '[1,"a","r",null,9007199254740993,"account",null,null,null]',
      '[1.0,"a","r",null,9007199254740993,"account"]',
      '[1,"a","r",null,9007199254740993,"account",null,null,false,-0]',
    ]) {
      const { test } = await host(raw);
      try {
        const status = await test.invoke<CodexAuthStatus>('openai_codex_auth_status');
        expect(status.phase, raw).toBe('error');
        expect(status.lastError?.code).toBe('credential_store_failed');
      } finally { await test.dispose(); }
    }
  });

  it('refresh accepts token-response sequences and preserves default/explicit expiry semantics', async () => {
    for (const [raw, lifetime] of [['["new-access"]', 3600000n], ['["new-access",null,null,9223372036854775807]', 86400000n]] as const) {
      const http = await rawServer((_req, res) => sendRaw(res, raw));
      const { test, settings } = await host(session({}), http.base);
      try {
        const before = BigInt(Date.now());
        const auth = await test.ctx.llmCodexAuth.requestAuth(true);
        expect(auth.accessToken()).toBe('new-access');
        expect(auth.accountId()).toBe('account-1');
        expect(auth.expiresAtUnixMs() >= before + lifetime).toBe(true);
        expect(auth.expiresAtUnixMs() <= BigInt(Date.now()) + lifetime).toBe(true);
        expect(await new DatabaseCodexCredentialStore(settings).load()).toMatchObject({
          refreshToken: 'refresh-secret', idToken: null, expiresAtUnixMs: auth.expiresAtUnixMs(),
        });
      } finally { await test.dispose(); await http.close(); }
    }
  });

  it('token-response sequences retain typed validation before the empty-access-token rule', async () => {
    for (const [raw, field] of [
      ['[]', 'token response'],
      ['["new-access",null,null,null,0]', 'token response'],
      ['["new-access",false]', 'token response'],
      ['["new-access",null,null,-0]', 'token response'],
      ['[" "]', 'access_token'],
      ['[" ",null,null,null,0]', 'token response'],
    ] as const) {
      const http = await rawServer((_req, res) => sendRaw(res, raw));
      const { test } = await host(session({}), http.base);
      try {
        await expect(test.ctx.llmCodexAuth.requestAuth(true), raw).rejects.toMatchObject({
          kind: 'MalformedResponse', detail: expect.objectContaining({ field }),
        });
      } finally { await test.dispose(); await http.close(); }
    }
  }, 15000);

  it('stored session JSON with a repeated StoredCodexSession field is a credential-store error', async () => {
    const valid = session({});
    for (const stored of [
      valid.replace('{', '{"accessToken":"first",'),
      valid.replace('{', '{"lastRefreshAt":null,'),
      valid.replace('{', '{"schemaVersion":1,'),
    ]) {
      const { test } = await host(stored);
      try {
        const status = await test.invoke<CodexAuthStatus>('openai_codex_auth_status');
        expect(status.phase, stored).toBe('error');
        expect(status.lastError?.code).toBe('credential_store_failed');
      } finally { await test.dispose(); }
    }
  });

  it('stored session JSON with repeated unknown keys or snake_case spellings stays accepted', async () => {
    const stored = session({}).replace('{', '{"extra":1,"extra":2,"access_token":"x","access_token":"y",');
    const { test } = await host(stored);
    try {
      const status = await test.invoke<CodexAuthStatus>('openai_codex_auth_status');
      expect(status.phase).toBe('authenticated');
      expect(status.hasUsableSession).toBe(true);
    } finally { await test.dispose(); }
  });

  it('token response with a repeated OAuthTokenResponse field is MalformedResponse', async () => {
    const http = await rawServer((req, res) => {
      if (req.url === '/oauth/token') sendRaw(res, '{"access_token":"a","refresh_token":"r","expires_in":3600,"expires_in":3600}');
      else sendRaw(res, '{}', 404);
    });
    const { test } = await host(session({}), http.base);
    try {
      await expect(test.ctx.llmCodexAuth.requestAuth(true)).rejects.toMatchObject({
        kind: 'MalformedResponse', detail: expect.objectContaining({ field: 'token response' }),
      });
    } finally { await test.dispose(); await http.close(); }
  });

  it('attachment preview text seam judges integer literals, 64-bit range and duplicates from the text', async () => {
    const { test } = await host(session({}));
    const parse = (text: string) => test.ctx.llmMultimodal.parseAttachmentPreviewJson(text);
    try {
      expect(parse('{"pages":[{"pageIndex":18446744073709551615,"blobHash":"h"}],"totalPages":9007199254740993,"unknown":1,"unknown":2}'))
        .toEqual({ pages: [{ page_index: 18446744073709551615n, blob_hash: 'h' }], page_count: 9007199254740993n });
      // usize values stay exact inside the Host: 2^53 and 2^53+1 are distinct page indices.
      const [a, b] = parse('{"pages":[{"page_index":9007199254740992},{"page_index":9007199254740993}]}').pages;
      expect(a!.page_index).toBe(9007199254740992n);
      expect(b!.page_index).toBe(9007199254740993n);
      expect(a!.page_index === b!.page_index).toBe(false);
      expect(() => parse('{"pages":[{"page_index":1.0}]}')).toThrow('invalid type for `page_index`');
      expect(() => parse('{"pages":[],"dpi":1e2}')).toThrow('invalid type for `dpi`');
      expect(() => parse('{"pages":[{"page_index":18446744073709551616}]}')).toThrow('invalid type for `page_index`');
      expect(() => parse('{"pages":[{"page_index":0,"pageIndex":0}]}')).toThrow('duplicate field `page_index`');
      expect(() => parse('{"pages":[{"page_index":0,"width":1,"width":1}]}')).toThrow('duplicate field `width`');
      expect(() => parse('{"pages":[],"pages":[]}')).toThrow('duplicate field `pages`');
      expect(() => parse('{"pages":[]')).toThrow('invalid JSON');
    } finally { await test.dispose(); }
  });

  it('preview accepts the existing valid unknown-field depth 127 vector', async () => {
    const { test } = await host(session({}));
    const nested = (depth: number) => `{"pages":[],"x":${'['.repeat(depth - 1)}${']'.repeat(depth - 1)}}`;
    try {
      expect(test.ctx.llmMultimodal.parseAttachmentPreviewJson(nested(127))).toEqual({ pages: [] });
    } finally { await test.dispose(); }
  });

  it('preview accepts the corrected pending unknown-field depth 128 vector', async () => {
    const { test } = await host(session({}));
    try {
      // PENDING.md / R1 c7bd5d5ce: IgnoredAny does not spend typed recursion depth.
      const text = `{"pages":[],"x":${'['.repeat(127)}${']'.repeat(127)}}`;
      expect(test.ctx.llmMultimodal.parseAttachmentPreviewJson(text)).toEqual({ pages: [] });
    } finally { await test.dispose(); }
  });
});

// serde_json `from_str::<Value>` (serde_json 1.0.149 read.rs:900-960, validate=true) rejects
// unpaired UTF-16 surrogate escapes that JSON.parse accepts; arbitrary_precision stores `-0`
// as the i64 0 (de.rs parse_any_number), so Value::as_u64 accepts it. Direct typed
// integer fields instead call deserialize_number/parse_integer and reject F64(-0).
describe('serde_json Value lexical acceptance', () => {
  it('stream chunks with lone surrogate escapes are skipped like a serde parse error', async () => {
    const { test } = await host(session({}));
    try {
      const adapter = test.ctx.llmAdapters.createAdapter('openai');
      for (const escape of ['\\ud800', '\\udc00', '\\ud800x', '\\ud800\\u0041']) {
        expect(adapter.parseStream(`data: {"choices":[{"delta":{"content":"a${escape}"}}]}`), escape).toEqual([]);
      }
      expect(adapter.parseStream('data: {"choices":[{"delta":{"content":"\\ud83d\\ude00"}}]}'))
        .toEqual([{ type: 'ContentChunk', value: '😀' }]);
    } finally { await test.dispose(); }
  });

  it('stored session with a lone surrogate escape is a credential-store error', async () => {
    const { test } = await host(session({ email: '"a\\udfff@example.com"' }));
    try {
      const status = await test.invoke<CodexAuthStatus>('openai_codex_auth_status');
      expect(status.phase).toBe('error');
      expect(status.lastError?.code).toBe('credential_store_failed');
    } finally { await test.dispose(); }
  });

  it('typed integer fields reject -0 while Value integers still accept zero', async () => {
    const { test } = await host(session({ schemaVersion: '1', lastRefreshAt: '-0' }));
    try {
      const status = await test.invoke<CodexAuthStatus>('openai_codex_auth_status');
      expect(status.phase).toBe('error');
      expect(status.lastError?.code).toBe('credential_store_failed');
      const parse = (text: string) => test.ctx.llmMultimodal.parseAttachmentPreviewJson(text);
      expect(() => parse('{"pages":[{"page_index":-0}]}')).toThrow('invalid type for `page_index`');
      expect(() => parse('{"pages":[],"dpi":-0}')).toThrow('invalid type for `dpi`');
      expect(() => parse('{"pages":[],"page_count":-0}')).toThrow('invalid type for `page_count`');
      expect(parse('{"pages":[{"page_index":0}],"dpi":0}')).toEqual({ pages: [{ page_index: 0n }], dpi: 0 });
      const [usage] = test.ctx.llmAdapters.createAdapter('gemini')
        .parseStream('data: {"usageMetadata":{"promptTokenCount":-0,"cachedContentTokenCount":-0}}');
      expect(usage).toMatchObject({ type: 'Usage', value: { prompt_tokens: 0, cached_tokens: 0 } });
    } finally { await test.dispose(); }
  });

  it('OAuth typed expires_in rejects -0 but accepts the integer 0 before clamping', async () => {
    for (const expiresIn of ['-0', '0']) {
      const http = await rawServer((req, res) => {
        if (req.url === '/oauth/token') sendRaw(res, `{"access_token":"new-access","expires_in":${expiresIn}}`);
        else sendRaw(res, '{}', 404);
      });
      const { test } = await host(session({}), http.base);
      try {
        if (expiresIn === '-0') {
          await expect(test.ctx.llmCodexAuth.requestAuth(true)).rejects.toMatchObject({
            kind: 'MalformedResponse', detail: expect.objectContaining({ field: 'token response' }),
          });
        } else {
          const before = BigInt(Date.now());
          const auth = await test.ctx.llmCodexAuth.requestAuth(true);
          expect(auth.expiresAtUnixMs() >= before + 60000n).toBe(true);
          expect(auth.expiresAtUnixMs() <= BigInt(Date.now()) + 60000n).toBe(true);
        }
      } finally { await test.dispose(); await http.close(); }
    }
  });

  it('Value depth still follows serde_json recursion limit 128 on provider stream data', async () => {
    const { test } = await host(session({}));
    try {
      const adapter = test.ctx.llmAdapters.createAdapter('openai');
      const nested = (depth: number) => `data: {"usage":{},"x":${'['.repeat(depth - 1)}${']'.repeat(depth - 1)}}`;
      expect(adapter.parseStream(nested(127))).toEqual([{ type: 'Usage', value: {} }]);
      expect(adapter.parseStream(nested(128))).toEqual([]);
    } finally { await test.dispose(); }
  });
});

// Adapter/OCR paths: `as_i64`/`as_u64` see the literal (arbitrary_precision), `as i32` truncates
// the exact i64, and `as_f64` drops non-finite values (serde_json number.rs:170).
describe('provider stream integers and floats follow serde_json Value accessors', () => {
  it('anthropic usage: as_i64 rejects 1.0, `as i32` wraps the exact value, merged start usage keeps literals', async () => {
    const { test } = await host(session({}));
    try {
      const adapter = test.ctx.llmAdapters.createAdapter('anthropic');
      const start = adapter.parseStream('data: {"type":"message_start","message":{"usage":{"input_tokens":5.0,"cache_read_input_tokens":9007199254740993}}}');
      expect(start).toMatchObject([{ type: 'Usage', value: { input_tokens: 0, cached_tokens: 9007199254740992 } }]);
      const merged = adapter.parseStream('data: {"type":"message_delta","delta":{"usage":{"input_tokens":0,"output_tokens":4294967297}}}');
      // input_tokens stays 0: the start value `5.0` is not an i64; 2^32+1 `as i32` is 1.
      expect(merged).toMatchObject([{ type: 'Usage', value: { input_tokens: 0, output_tokens: 1, total_tokens: 1, cached_tokens: 9007199254740992 } }]);
    } finally { await test.dispose(); }
  });

  it('gemini stream usage casts the i64 counts with `as i32`; responses output_index ignores 1.0', async () => {
    const { test } = await host(session({}));
    try {
      const gemini = test.ctx.llmAdapters.createAdapter('gemini');
      const [usage] = gemini.parseStream('data: {"usageMetadata":{"promptTokenCount":2147483648,"candidatesTokenCount":1.0,"thoughtsTokenCount":2147483648}}');
      expect(usage).toMatchObject({ type: 'Usage', value: {
        prompt_tokens: -2147483648, completion_tokens: 0, total_tokens: -2147483648, reasoning_tokens: 2147483648,
      } });
      const responses = test.ctx.llmAdapters.createAdapter('openai_responses');
      const added = responses.parseStream('data: {"type":"response.output_item.added","output_index":1.0,"item":{"type":"function_call","id":"fc","call_id":"c","name":"f","arguments":"","index":3}}');
      expect(added).toMatchObject([{ type: 'ToolCall', value: { index: 3 } }]);
    } finally { await test.dispose(); }
  });

  it('paddle grounding drops non-finite score and bbox values like as_f64', async () => {
    const { test } = await host(session({}));
    try {
      const adapter = test.ctx.llmOcr.createAdapter('paddle_ocr_vl');
      const result = adapter.parseResponse('{"blocks":[{"type":"text","text":"a","score":1e400,"bbox":[0.1,0.1,0.2,1e400]},{"text":"b","score":0.5,"bbox":[0.1,0.1,0.2,0.2]}]}', 100, 100, 0, '/p.png', 'grounding');
      expect(result.regions[0]).toEqual({ label: 'text', text: 'a' });
      expect(result.regions[1]).toMatchObject({ label: 'text', text: 'b', confidence: 0.5 });
    } finally { await test.dispose(); }
  });
});

describe('Codex HTTP Value bodies preserve serde from_slice UTF-8 semantics', () => {
  const invalidString = (prefix: string, suffix: string) => Buffer.concat([
    Buffer.from(prefix), Buffer.from([0xff]), Buffer.from(suffix),
  ]);

  it('usage and device authorization reject invalid UTF-8 instead of accepting a replacement character', async () => {
    const http = await rawServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/wham/usage') {
        res.end(invalidString('{"rate_limit":{"primary":{"used_percent":5},"limit_name":"', '"}}'));
      } else if (req.url === '/device/usercode') {
        res.end(invalidString('{"device_auth_id":"device-1","user_code":"', '"}'));
      } else res.end('{}');
    });
    const { test } = await host(session({}), http.base);
    try {
      // manager.rs:276 / 734 map serde_json::from_slice failures to MalformedResponse,
      // then the real IPC command maps that error to the fixed frontend string.
      await expect(test.invoke('openai_codex_usage')).rejects.toBe('OpenAI Codex authentication request failed');
      await expect(test.invoke('openai_codex_login_start', { flow: 'device' }))
        .rejects.toBe('OpenAI Codex authentication request failed');
    } finally { await test.dispose(); await http.close(); }
  });

  it('invalid UTF-8 OAuth error bodies fall back to Value::Null rather than forcing reauthentication', async () => {
    const http = await rawServer((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(invalidString('{"error":"invalid_grant","note":"', '"}'));
    });
    const { test } = await host(session({}), http.base);
    try {
      // manager.rs:1844-1845 `from_slice(body).unwrap_or(Value::Null)`.
      await expect(test.ctx.llmCodexAuth.requestAuth(true)).rejects.toMatchObject({
        kind: 'OAuthRejected', detail: expect.objectContaining({ code: 'http_400', reauthRequired: false }),
      });
      expect((await test.ctx.llmCodexAuth.status()).phase).toBe('authenticated');
    } finally { await test.dispose(); await http.close(); }
  });

  it('device polling reports a malformed Value body before exchanging a repaired authorization code', async () => {
    let exchanges = 0;
    const http = await rawServer((req, res) => {
      if (req.url === '/device/usercode') {
        sendRaw(res, '{"device_auth_id":"device-1","user_code":"code-1","interval":1}');
      } else if (req.url === '/device/token') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(invalidString('{"authorization_code":"', '","code_verifier":"v"}'));
      } else {
        exchanges++;
        sendRaw(res, '{"access_token":"not-a-jwt","refresh_token":"r"}');
      }
    });
    const { test } = await host(session({}), http.base);
    try {
      await test.invoke('openai_codex_login_start', { flow: 'device' });
      const deadline = performance.now() + 10000;
      let status = await test.ctx.llmCodexAuth.status();
      while (status.activeAttemptId !== null && performance.now() < deadline) {
        await delay(25);
        status = await test.ctx.llmCodexAuth.status();
      }
      expect(status.activeAttemptId).toBeNull();
      expect(status.lastError).toMatchObject({ code: 'malformed_response', message: 'OAuth response was malformed: device poll response' });
      expect(exchanges).toBe(0);
    } finally { await test.dispose(); await http.close(); }
  }, 15000);

  it('a valid UTF-8 replacement character is legal JSON data and stays accepted', async () => {
    const http = await rawServer((_req, res) => {
      sendRaw(res, '{"rate_limit":{"primary":{"used_percent":5},"limit_name":"�"}}');
    });
    const { test } = await host(session({}), http.base);
    try {
      const usage = await test.invoke<CodexUsageSnapshot>('openai_codex_usage');
      expect(usage.rateLimits?.limitName).toBe('�');
      expect(usage.rateLimits?.primary?.usedPercent).toBe(5);
    } finally { await test.dispose(); await http.close(); }
  });
});

describe('Codex rate-limit f64 serialization at the IPC boundary', () => {
  it('keeps fetchedAt division and reset arithmetic exact at signed i64 bounds', () => {
    // manager.rs:1745 divides i64 with truncation toward zero, then adds the
    // u64-as-i64 seconds using release-mode wrapping. Do not divide a Number.
    const low = parseUsageSnapshot({ rate_limit: { primary: { resets_in_seconds: '18446744073709551615' } } }, -9223372036854775808n);
    expect(low.fetchedAt).toBe(-9223372036854775808n);
    expect(low.rateLimits!.primary!.resetsAt).toBe(-9223372036854776n);
    const high = parseUsageSnapshot({ rate_limit: { primary: { resets_in_seconds: '9223372036854775807' } } }, 9223372036854775807n);
    expect(high.fetchedAt).toBe(9223372036854775807n);
    expect(high.rateLimits!.primary!.resetsAt).toBe(-9214148664817921034n);
  });

  it('keeps full-width rate-limit integers exact until the real IPC encoder', async () => {
    const http = await rawServer((_req, res) => {
      sendRaw(res, '{"rate_limits_by_limit_id":{'
        + '"a":{"primary":{"window_duration_mins":9007199254740992,"resets_at":9223372036854775807}},'
        + '"b":{"primary":{"window_duration_mins":9007199254740993,"resets_at":-9223372036854775808}},'
        + '"max":{"primary":{"window_duration_mins":18446744073709551615,"resets_in_seconds":18446744073709551615}}}}');
    });
    // A call-through spy observes actual manager output without substituting
    // parser/HTTP/encoder behavior or supplying a synthetic result.
    const encoder = vi.spyOn(usageWire, 'codexUsageToWire');
    const { test } = await host(session({}), http.base);
    try {
      const before = BigInt(Date.now());
      const wire = await test.invoke<CodexUsageSnapshot>('openai_codex_usage');
      const after = BigInt(Date.now());
      expect(encoder).toHaveBeenCalledTimes(1);
      const internal = encoder.mock.calls[0]![0];
      const limits = internal.rateLimitsByLimitId!;
      // Check actual lost value before asserting the bigint representation.
      expect(BigInt(limits.b!.primary!.windowDurationMins!)).toBe(9007199254740993n);
      expect(limits.a!.primary!.windowDurationMins).toBe(9007199254740992n);
      expect(limits.b!.primary!.windowDurationMins).toBe(9007199254740993n);
      expect(limits.a!.primary!.resetsAt).toBe(9223372036854775807n);
      expect(limits.b!.primary!.resetsAt).toBe(-9223372036854775808n);
      expect(limits.max!.primary!.windowDurationMins).toBe(18446744073709551615n);
      expect(limits.max!.primary!.resetsAt).toBe(BigInt(internal.fetchedAt) / 1000n - 1n);
      expect(typeof internal.fetchedAt).toBe('bigint');
      expect(internal.fetchedAt >= before && internal.fetchedAt <= after).toBe(true);
      // Only the separate IPC copy may round, and the call must not mutate Host state.
      expect(wire.rateLimitsByLimitId!.b!.primary!.windowDurationMins).toBe(9007199254740992);
      expect(wire.rateLimitsByLimitId!.max!.primary!.windowDurationMins).toBe(Number(18446744073709551615n));
      expect(limits.b!.primary!.windowDurationMins).toBe(9007199254740993n);
    } finally { encoder.mockRestore(); await test.dispose(); await http.close(); }
  });

  it('keeps the parsed Host NaN unchanged while producing an independent wire copy', () => {
    const snapshot = parseUsageSnapshot({ rate_limit: { primary: { used_percent: 'NaN' } } }, 1700n);
    const wire = codexUsageToWire(snapshot);
    expect(Number.isNaN(snapshot.rateLimits!.primary!.usedPercent)).toBe(true);
    expect(Number.isNaN(snapshot.rateLimitsByLimitId!.codex!.primary!.usedPercent)).toBe(true);
    expect(wire.rateLimits!.primary).toHaveProperty('usedPercent', null);
    expect(wire.rateLimitsByLimitId!.codex!.primary).toHaveProperty('usedPercent', null);
    expect(wire.rateLimits!.primary).not.toBe(snapshot.rateLimits!.primary);
  });

  it('encodes measured NaN percentages as null without omitting them or changing finite values', async () => {
    const http = await rawServer((_req, res) => {
      sendRaw(res, JSON.stringify({ rate_limits_by_limit_id: {
        alpha: { primary: { used_percent: 'NaN', remaining_percent: 25 }, secondary: { remaining_percent: 'NaN' } },
        beta: { primary: { used_percent: 'inf' }, secondary: { used_percent: '-inf' } },
        gamma: { primary: { window_seconds: 3600 } },
      } }));
    });
    const { test } = await host(session({}), http.base);
    try {
      // manager.rs:1766-1771 allows str::parse::<f64>("NaN"); clamp keeps NaN.
      // Some(NaN) serializes to a present JSON null (serde_json1.0.149 ser.rs:169-178).
      const usage = await test.invoke<CodexUsageSnapshot>('openai_codex_usage');
      expect(usage.rateLimits?.primary).toHaveProperty('usedPercent', null);
      const limits = usage.rateLimitsByLimitId!;
      expect(limits.alpha!.primary).toHaveProperty('usedPercent', null);
      expect(limits.alpha!.secondary).toHaveProperty('usedPercent', null);
      expect(limits.beta!.primary).toEqual({ usedPercent: 100 });
      expect(limits.beta!.secondary).toEqual({ usedPercent: 0 });
      expect(limits.gamma!.primary).toEqual({ windowDurationMins: 60 });
      expect(limits.gamma!.primary).not.toHaveProperty('usedPercent');
    } finally { await test.dispose(); await http.close(); }
  });
});
