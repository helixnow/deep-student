import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import type { JsonValue } from '../api.ts';
import plugin from '../index.ts';
import { CodexAuthManager } from '../src/openai-codex/manager.ts';
import { prepareProviderRequest, sendCodexRequestWithSingleRefresh } from '../src/openai-codex/prepare.ts';
import { CODEX_CREDENTIAL_KEY, CODEX_RESPONSES_ENDPOINT, CodexEndpointConfig } from '../src/openai-codex/protocol.ts';
import type { CodexCredentialStore } from '../src/openai-codex/store.ts';
import { StoredCodexSession } from '../src/openai-codex/types.ts';

class MemorySettings implements SettingsStore {
  values = new Map<string, string>();
  save(key: string, value: string) { this.values.set(key, value); }
  get(key: string) { return this.values.get(key) ?? null; }
  delete(key: string) { return this.values.delete(key); }
  listByPrefix(prefix: string) {
    return [...this.values].filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value, updatedAt: '2026-11-03T00:00:00+00:00' }));
  }
  deleteByPrefix(prefix: string) { let n = 0; for (const key of [...this.values.keys()]) if (key.startsWith(prefix)) { this.values.delete(key); n++; } return n; }
  async saveSecret(key: string, value: string) { this.save(key, value); }
  async getSecret(key: string) { return this.get(key); }
  async deleteSecret(key: string) { return this.delete(key); }
}

class MemoryStore implements CodexCredentialStore {
  value: StoredCodexSession | null;
  constructor(session: StoredCodexSession) { this.value = session; }
  async load() { return this.value?.clone() ?? null; }
  async save(value: StoredCodexSession) { this.value = value.clone(); }
  async delete() { this.value = null; }
}

const storedSession = (accessToken = 'access-secret') => new StoredCodexSession({
  schemaVersion: 1, accessToken, refreshToken: 'refresh-secret', idToken: null,
  expiresAtUnixMs: BigInt(Date.now()) + 3_600_000n, accountId: 'account-1', email: 'user@example.com',
  planType: 'plus', isFedramp: false, lastRefreshAt: null,
});

const sessionJson = (accountId = 'account-1', accessToken = 'access-secret') => JSON.stringify({
  schemaVersion: 1, accessToken, refreshToken: 'refresh-secret', idToken: null,
  expiresAtUnixMs: Date.now() + 3_600_000, accountId, email: 'user@example.com',
  planType: 'plus', isFedramp: false, lastRefreshAt: null,
});

async function hostWithSession(
  endpoints?: CodexEndpointConfig, session = sessionJson(),
) {
  const settings = new MemorySettings();
  settings.save(CODEX_CREDENTIAL_KEY, session);
  const host = endpoints === undefined
    ? await createTestHost({
      plugins: [plugin],
      provide: { settings },
      app: { version: '0.11.0' },
    })
    : await createTestHost({
      plugins: [[plugin, { codexEndpoints: endpoints }]],
      provide: { settings },
      app: { version: '0.11.0' },
    });
  return { host, settings };
}

const config = {
  authMode: 'openai_codex_oauth',
  providerType: 'openai_codex',
  apiProtocol: 'openai_responses',
  supportsOpenaiResponses: true,
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5',
  apiKey: '',
  headers: { 'x-proxy-group': 'codex-pool' },
};

const requestBody: JsonValue = {
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
};

const jwt = (payload: unknown) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
const tokenResponse = (access: string) => ({
  access_token: access,
  refresh_token: 'refreshed-refresh',
  id_token: jwt({ chatgpt_account_id: 'account-1' }),
  expires_in: 3600,
});

const servers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of servers.splice(0)) await close(); });

async function server(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void) {
  const http = createServer((req, res) => handler(req, res));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('expected TCP address');
  servers.push(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${address.port}/`;
}

describe('llmCodexAuth service', () => {
  it('uses the same active manager as the auth_status command', async () => {
    const { host } = await hostWithSession();
    try {
      const service = host.ctx.llmCodexAuth;
      const status = await service.status();
      // Same manager/state, with D3 conversion only on the IPC result's timestamp.
      expect({ ...status, expiresAtUnixMs: status.expiresAtUnixMs === null ? null : Number(status.expiresAtUnixMs) })
        .toEqual(await host.invoke('openai_codex_auth_status'));

      const auth = await service.requestAuth();
      expect(auth.accessToken()).toBe('access-secret');
      expect(auth.accountId()).toBe('account-1');

      // A mutation through the service is visible to the IPC command: both
      // paths must hold the same manager, not a second credential copy.
      await service.markReauthenticationRequired(status.generation);
      const after = await host.invoke<{ phase: string }>('openai_codex_auth_status');
      expect(after.phase).toBe('reauthentication_required');
    } finally { await host.dispose(); }
  });

  it('prepares a Responses request with OAuth headers and prompt cache key', async () => {
    const { host } = await hostWithSession();
    try {
      const adapter = host.ctx.llmAdapters.createAdapter('openai_responses');
      const prepared = await host.ctx.llmCodexAuth.prepareRequest(
        adapter, config, requestBody, { sessionId: 'sess-1' },
      );
      expect(prepared.url).toBe(CODEX_RESPONSES_ENDPOINT);
      expect(prepared.codex).toEqual({ generation: 1, sessionId: 'sess-1' });
      const headers = Object.fromEntries(prepared.headers);
      expect(headers.authorization).toBe('Bearer access-secret');
      expect(headers['chatgpt-account-id']).toBe('account-1');
      expect(headers['x-proxy-group']).toBe('codex-pool');
      expect(headers['content-type']).toBe('application/json');

      const body = prepared.body as { [key: string]: unknown };
      expect(body.store).toBe(false);
      expect(body.stream).toBe(true);
      expect(body.prompt_cache_key).toBe('sess-1');
      expect(Array.isArray(body.input)).toBe(true);
      expect(body.temperature).toBeUndefined();
      expect(body.max_output_tokens).toBeUndefined();
    } finally { await host.dispose(); }
  });

  it('rejects a non-Responses Codex configuration with the Rust message', async () => {
    const { host } = await hostWithSession();
    try {
      const adapter = host.ctx.llmAdapters.createAdapter('openai_responses');
      await expect(host.ctx.llmCodexAuth.prepareRequest(adapter, {
        ...config, apiProtocol: 'openai_chat_completions', supportsOpenaiResponses: false, providerType: 'openai',
      }, requestBody)).rejects.toMatchObject({
        error_type: 'Configuration',
        message: 'OpenAI Codex OAuth 仅支持 OpenAI Responses 协议',
      });
    } finally { await host.dispose(); }
  });
});

describe('Codex single-refresh send', () => {
  it('does not trust BOM-prefixed JSON in JWT claims during refresh', async () => {
    const malformedClaims = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('\ufeff{"chatgpt_account_id":"other-account"}').toString('base64url')}.sig`;
    const base = await server((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...tokenResponse('renewed-access'), id_token: malformedClaims }));
    });
    const { host } = await hostWithSession(CodexEndpointConfig.forTest(base));
    try {
      // manager.rs:1343 serde_json::from_slice(decoded).ok(): BOM is not JSON
      // whitespace. Ignore malformed claims and retain the current account.
      const auth = await host.ctx.llmCodexAuth.requestAuth(true);
      expect(auth.accountId()).toBe('account-1');
      expect(auth.accessToken()).toBe('renewed-access');
      expect((await host.ctx.llmCodexAuth.status()).phase).toBe('authenticated');
    } finally { await host.dispose(); }
  });

  it('refreshes once on 401 and retries with the new token', async () => {
    const { host } = await hostWithSession();
    let responseCalls = 0;
    let tokenCalls = 0;
    const authorizations: string[] = [];
    const base = await server((req, res) => {
      if (req.url === '/oauth/token') {
        tokenCalls += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(tokenResponse('refreshed-access')));
        return;
      }
      responseCalls += 1;
      authorizations.push(String(req.headers.authorization));
      if (responseCalls === 1) { res.writeHead(401); res.end('unauthorized'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const manager = await CodexAuthManager.create(new MemoryStore(storedSession()), '0.11.0', CodexEndpointConfig.forTest(base));
    try {
      const adapter = host.ctx.llmAdapters.createAdapter('openai_responses');
      const prepared = await prepareProviderRequest(
        manager, adapter, config, requestBody, { sessionId: 'sess-1' }, undefined, '0.11.0',
      );
      const response = await sendCodexRequestWithSingleRefresh(manager, prepared, { version: '0.11.0' });
      expect(response.status).toBe(200);
      expect(responseCalls).toBe(2);
      expect(tokenCalls).toBe(1);
      expect(authorizations).toEqual(['Bearer access-secret', 'Bearer refreshed-access']);
      expect((await manager.status()).generation).toBe(2);
    } finally {
      await manager.dispose();
      await host.dispose();
    }
  });

  it('marks reauthentication required on a second 401', async () => {
    const { host } = await hostWithSession();
    let tokenCalls = 0;
    const base = await server((req, res) => {
      if (req.url === '/oauth/token') {
        tokenCalls += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(tokenResponse('refreshed-access')));
        return;
      }
      res.writeHead(401); res.end('unauthorized');
    });
    const manager = await CodexAuthManager.create(new MemoryStore(storedSession()), '0.11.0', CodexEndpointConfig.forTest(base));
    try {
      const adapter = host.ctx.llmAdapters.createAdapter('openai_responses');
      const prepared = await prepareProviderRequest(
        manager, adapter, config, requestBody, { sessionId: 'sess-1' }, undefined, '0.11.0',
      );
      await expect(sendCodexRequestWithSingleRefresh(manager, prepared, { version: '0.11.0' }))
        .rejects.toMatchObject({
          error_type: 'Configuration',
          message: 'OpenAI Codex 授权已失效，请在模型设置中重新登录',
        });
      expect(tokenCalls).toBe(1);
      expect((await manager.status()).lastError?.code).toBe('reauthentication_required');
    } finally {
      await manager.dispose();
      await host.dispose();
    }
  });
});

describe('Codex request preparation branches (03.a/03.d)', () => {
  it('normalizes protocol whitespace with Rust str::trim, including NEL', async () => {
    const { host } = await hostWithSession();
    try {
      const adapter = host.ctx.llmAdapters.createAdapter('openai_responses');
      // llm_manager/mod.rs:3775-3776,3990-3998: NEL is Unicode White_Space;
      // the explicit chat protocol still overrides Responses capability.
      await expect(host.ctx.llmCodexAuth.prepareRequest(adapter, {
        ...config, apiProtocol: '\u0085OPENAI_CHAT_COMPLETIONS\u0085',
      }, requestBody)).rejects.toMatchObject({
        error_type: 'Configuration', message: 'OpenAI Codex OAuth 仅支持 OpenAI Responses 协议',
      });
      const prepared = await host.ctx.llmCodexAuth.prepareRequest(adapter, {
        ...config, providerType: 'openai', supportsOpenaiResponses: false,
        apiProtocol: '\u0085OPENAI_RESPONSES\u0085',
      }, requestBody);
      expect(prepared.url).toBe(CODEX_RESPONSES_ENDPOINT);
      expect(prepared.codex?.generation).toBe(1);
    } finally { await host.dispose(); }
  });

  it('does not trim BOM into an explicit non-Responses protocol', async () => {
    const { host } = await hostWithSession();
    try {
      // BOM is not Rust White_Space. This spelling is unknown, so the existing
      // Responses capability/provider fallback applies instead of explicit chat.
      const prepared = await host.ctx.llmCodexAuth.prepareRequest(
        host.ctx.llmAdapters.createAdapter('openai_responses'), {
          ...config, apiProtocol: '\ufeffopenai_chat_completions\ufeff',
        }, requestBody,
      );
      expect(prepared.url).toBe(CODEX_RESPONSES_ENDPOINT);
      expect(prepared.codex?.generation).toBe(1);
    } finally { await host.dispose(); }
  });

  it('lets explicit non-Responses protocols win over capability/providerType', async () => {
    const { host } = await hostWithSession();
    try {
      const service = host.ctx.llmCodexAuth;
      const adapter = host.ctx.llmAdapters.createAdapter('openai_responses');
      for (const apiProtocol of [
        'openai_chat_completions', 'anthropic_messages', 'google_generate_content',
      ]) {
        await expect(service.prepareRequest(adapter, {
          ...config, apiProtocol, supportsOpenaiResponses: true, providerType: 'openai_codex',
        }, requestBody)).rejects.toMatchObject({
          error_type: 'Configuration',
          message: 'OpenAI Codex OAuth 仅支持 OpenAI Responses 协议',
        });
      }

      // Authoritative L02 result overrides a misleading local capability flag.
      await expect(service.prepareRequest(adapter, {
        ...config, apiProtocol: null, effectiveApiProtocol: 'openai_chat_completions',
        supportsOpenaiResponses: true, providerType: 'openai_codex',
      }, requestBody)).rejects.toMatchObject({
        error_type: 'Configuration',
        message: 'OpenAI Codex OAuth 仅支持 OpenAI Responses 协议',
      });

      const prepared = await service.prepareRequest(adapter, {
        ...config, apiProtocol: null, effectiveApiProtocol: 'openai_responses',
        supportsOpenaiResponses: false, providerType: 'openai',
      }, requestBody, { sessionId: 'sess-authoritative' });
      expect(prepared.codex).toEqual({ generation: 1, sessionId: 'sess-authoritative' });
    } finally { await host.dispose(); }
  });

  it('warns on invalid/conflicting configured headers and preserves OAuth precedence', async () => {
    const { host } = await hostWithSession();
    const warn = vi.spyOn(host.ctx.logger, 'warn');
    try {
      const adapter = host.ctx.llmAdapters.createAdapter('openai_responses');
      const prepared = await host.ctx.llmCodexAuth.prepareRequest(adapter, {
        ...config,
        headers: {
          authorization: 'Bearer custom',
          'content-type': 'text/plain',
          'bad header': 'ignored',
          'x-newline': 'a\nb',
          'x-keep': 'yes',
        },
      }, requestBody);
      const headers = Object.fromEntries(prepared.headers);
      expect(headers.authorization).toBe('Bearer access-secret');
      expect(headers['content-type']).toBe('application/json');
      expect(headers['x-keep']).toBe('yes');
      expect(headers['bad header']).toBeUndefined();
      expect(headers['x-newline']).toBeUndefined();

      const messages = warn.mock.calls.map(call => String(call[0]));
      expect(messages).toContain('[LLM Headers] Ignoring invalid vendor-configured header name: bad header');
      expect(messages).toContain('[LLM Headers] Ignoring invalid value for vendor-configured header: x-newline');
      expect(messages).toContain('[LLM Headers] Ignoring configured content-type because the provider transport owns it');
    } finally {
      warn.mockRestore();
      await host.dispose();
    }
  });

  it('maps header generation failures to a Configuration context', async () => {
    const { host } = await hostWithSession(undefined, sessionJson('bad\naccount'));
    try {
      const adapter = host.ctx.llmAdapters.createAdapter('openai_responses');
      await expect(host.ctx.llmCodexAuth.prepareRequest(adapter, config, requestBody))
        .rejects.toMatchObject({
          error_type: 'Configuration',
          message: 'OpenAI Codex 登录状态不可用（构建请求头），请在模型设置中重新登录',
        });
    } finally { await host.dispose(); }
  });
});

describe('Codex response normalization / bridge / timeout (03.b/03.c/03.e)', () => {
  it('passes through non-ASCII Content-Type values like HeaderValue::to_str failure', async () => {
    let calls = 0;
    const contentTypes = ['\u00a0text/event-stream\u00a0', 'text/event-stream; note="\u00a0"'];
    const base = await server((_req, res) => {
      res.writeHead(200, { 'content-type': contentTypes[calls++]! });
      res.end('opaque passthrough');
    });
    const { host } = await hostWithSession(CodexEndpointConfig.forTest(base));
    try {
      const prepared = await host.ctx.llmCodexAuth.prepareRequest(
        host.ctx.llmAdapters.createAdapter('openai_responses'), config, requestBody,
      );
      for (const contentType of contentTypes) {
        const response = await host.ctx.llmCodexAuth.sendWithSingleRefresh(prepared);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe(contentType);
        expect(await response.text()).toBe('opaque passthrough');
      }
    } finally { await host.dispose(); }
  });

  it('keeps a leading UTF-8 BOM when normalizing error bodies and retains lossy decoding', async () => {
    let calls = 0;
    const bodies = [
      Buffer.from('\ufeff{"error":{"code":"custom_code"}}'),
      Buffer.from('{"error":{"code":"custom_code"}}'),
      Buffer.concat([Buffer.from('{"error":{"code":"custom_code","message":"'), Buffer.from([0xff]), Buffer.from('"}}')]),
    ];
    const base = await server((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(bodies[calls++]!);
    });
    const { host } = await hostWithSession(CodexEndpointConfig.forTest(base));
    try {
      const prepared = await host.ctx.llmCodexAuth.prepareRequest(
        host.ctx.llmAdapters.createAdapter('openai_responses'), config, requestBody,
      );
      // Rust String::from_utf8_lossy preserves BOM; serde then rejects the first
      // JSON document. Without BOM, lossy invalid bytes still allow custom_code.
      for (const code of ['http_400', 'custom_code', 'custom_code']) {
        const response = await host.ctx.llmCodexAuth.sendWithSingleRefresh(prepared);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: { code, message: 'OpenAI Codex request failed' } });
      }
    } finally { await host.dispose(); }
  });

  it('preserves the leading BOM before the Codex SSE parser instead of repairing its first data line', async () => {
    const base = await server((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('\ufeffdata: {"type":"response.output_text.delta","delta":"not a recognized data line"}\n\ndata: [DONE]\n\n');
    });
    const { host } = await hostWithSession(CodexEndpointConfig.forTest(base));
    try {
      const prepared = await host.ctx.llmCodexAuth.prepareRequest(
        host.ctx.llmAdapters.createAdapter('openai_responses'), config, requestBody,
      );
      // Rust String::from_utf8 preserves BOM; protocol.rs:446 sees no data:
      // prefix on the first line, and finish() rejects the lack of JSON events.
      await expect(host.ctx.llmCodexAuth.sendWithSingleRefresh(prepared)).rejects.toMatchObject({
        error_type: 'LLM', message: 'OpenAI Codex 响应流不完整或格式无效',
      });
    } finally { await host.dispose(); }
  });

  it('normalizes 404 usage-limit errors to 429 and sanitizes upstream bodies', async () => {
    let calls = 0;
    const base = await server((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'usage_limit_reached', message: 'upstream-secret' } }));
        return;
      }
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('<html>upstream-secret</html>');
    });
    const { host } = await hostWithSession(CodexEndpointConfig.forTest(base));
    try {
      const adapter = host.ctx.llmAdapters.createAdapter('openai_responses');
      const prepared = await host.ctx.llmCodexAuth.prepareRequest(
        adapter, config, requestBody, { sessionId: 'sess-errors' },
      );

      const usage = await host.ctx.llmCodexAuth.sendWithSingleRefresh(prepared);
      expect(usage.status).toBe(429);
      expect(usage.headers.get('content-type')).toBe('application/json; charset=utf-8');
      const usageText = await usage.text();
      expect(JSON.parse(usageText)).toEqual({
        error: { code: 'usage_limit_reached', message: 'OpenAI Codex request failed' },
      });
      expect(usageText).not.toContain('upstream-secret');

      const invalid = await host.ctx.llmCodexAuth.sendWithSingleRefresh(prepared);
      expect(invalid.status).toBe(400);
      const invalidText = await invalid.text();
      expect(JSON.parse(invalidText)).toEqual({
        error: { code: 'http_400', message: 'OpenAI Codex request failed' },
      });
      expect(invalidText).not.toContain('upstream-secret');
    } finally { await host.dispose(); }
  });

  it('keeps Rust error-code Option-chain order when the first string sanitizes empty', async () => {
    let calls = 0;
    const bodies = [
      '{"error":{"code":""},"code":"other"}',
      '{"error":{"code":"!!!"},"code":"other"}',
      '{"error":"","code":"other"}',
    ];
    const base = await server((_req, res) => {
      const body = bodies[calls] ?? bodies[bodies.length - 1]!;
      calls += 1;
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(body);
    });
    const { host } = await hostWithSession(CodexEndpointConfig.forTest(base));
    try {
      const adapter = host.ctx.llmAdapters.createAdapter('openai_responses');
      const prepared = await host.ctx.llmCodexAuth.prepareRequest(
        adapter, config, requestBody, { sessionId: 'sess-code-order' },
      );
      for (let index = 0; index < bodies.length; index += 1) {
        const response = await host.ctx.llmCodexAuth.sendWithSingleRefresh(prepared);
        expect(response.status).toBe(400);
        const payload = await response.json() as { error: { code: string } };
        expect(payload.error.code).toBe('http_400');
      }
      expect(calls).toBe(bodies.length);
    } finally { await host.dispose(); }
  });

  it('rejects an oversized Codex error body', async () => {
    const oversized = 'x'.repeat(256 * 1024 + 1);
    const base = await server((_req, res) => {
      res.writeHead(400, {
        'content-type': 'text/plain',
        'content-length': String(Buffer.byteLength(oversized)),
      });
      res.end(oversized);
    });
    const { host } = await hostWithSession(CodexEndpointConfig.forTest(base));
    try {
      const adapter = host.ctx.llmAdapters.createAdapter('openai_responses');
      const prepared = await host.ctx.llmCodexAuth.prepareRequest(
        adapter, config, requestBody, { sessionId: 'sess-limit' },
      );
      await expect(host.ctx.llmCodexAuth.sendWithSingleRefresh(prepared)).rejects.toMatchObject({
        error_type: 'LLM',
        message: 'OpenAI Codex 错误响应超过大小限制',
      });
    } finally { await host.dispose(); }
  });

  it('applies timeout independently to each POST across a 401 refresh', async () => {
    let responseCalls = 0;
    const base = await server((req, res) => {
      if (req.url === '/oauth/token') {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(tokenResponse('refreshed-access')));
        }, 300);
        return;
      }
      responseCalls += 1;
      if (responseCalls === 1) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('unauthorized');
        return;
      }
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }, 250);
    });
    const { host } = await hostWithSession(CodexEndpointConfig.forTest(base));
    try {
      const adapter = host.ctx.llmAdapters.createAdapter('openai_responses');
      const prepared = await host.ctx.llmCodexAuth.prepareRequest(
        adapter, config, requestBody, { sessionId: 'sess-timeout' },
      );
      // 300ms refresh + 250ms second POST > 500ms total, but each POST alone
      // stays below the 500ms per-attempt timeout.
      const response = await host.ctx.llmCodexAuth.sendWithSingleRefresh(
        prepared, { timeoutMs: 500 },
      );
      expect(response.status).toBe(200);
      expect(responseCalls).toBe(2);
    } finally { await host.dispose(); }
  });

  it('bridges a successful SSE response to canonical non-stream JSON', async () => {
    const sse = [
      'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5"}}',
      '',
      'data: {"type":"response.output_text.delta","delta":"hi"}',
      '',
      'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5","status":"completed","output":[{"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"hi"}]}],"usage":{"input_tokens":1,"output_tokens":1}}}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n');
    const base = await server((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse);
    });
    const { host } = await hostWithSession(CodexEndpointConfig.forTest(base));
    try {
      const adapter = host.ctx.llmAdapters.createAdapter('openai_responses');
      const prepared = await host.ctx.llmCodexAuth.prepareRequest(
        adapter, config, requestBody, { sessionId: 'sess-bridge' },
      );
      const response = await host.ctx.llmCodexAuth.sendWithSingleRefresh(prepared);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
      const body = await response.json() as {
        status: string;
        output: Array<{ content: Array<{ text: string }> }>;
      };
      expect(body.status).toBe('completed');
      expect(body.output[0]!.content[0]!.text).toBe('hi');
    } finally { await host.dispose(); }
  });

  it('maps malformed SSE to the Rust LLM error', async () => {
    const base = await server((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: not-json\n\n');
    });
    const { host } = await hostWithSession(CodexEndpointConfig.forTest(base));
    try {
      const adapter = host.ctx.llmAdapters.createAdapter('openai_responses');
      const prepared = await host.ctx.llmCodexAuth.prepareRequest(
        adapter, config, requestBody, { sessionId: 'sess-bad-sse' },
      );
      await expect(host.ctx.llmCodexAuth.sendWithSingleRefresh(prepared)).rejects.toMatchObject({
        error_type: 'LLM',
        message: 'OpenAI Codex 响应流不完整或格式无效',
      });
    } finally { await host.dispose(); }
  });
});
