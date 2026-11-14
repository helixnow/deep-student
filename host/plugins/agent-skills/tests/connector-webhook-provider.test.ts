import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { postAllowlistedDirect, validateWebhookEndpoint } from '../../../platform/http/allowlisted-direct.ts';
import { createWebhookProvider, WEBHOOK_ALLOWED_HOSTS_KEY } from '../src/tools/connector-webhook-provider.ts';
import type { ConnectorSettings, ProviderOperation } from '../src/tools/connector-executor.ts';

const SECRET = 'webhook-test-secret';
const SECRET_KEY = 'connectors.webhook.test.api_key';
const op: ProviderOperation = { operationId: 'op-1', idempotencyKey: 'key-1', action: 'mail:send',
  body: { operation_id: 'op-1', idempotency_key: 'key-1', action: 'mail:send', payload: { subject: '你好' } } };
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await Promise.all(closers.splice(0).map(close => close())); });

async function receiver(respond: (body: string, headers: IncomingHttpHeaders, response: ServerResponse) => void) {
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk.toString();
    respond(body, request.headers, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
}

function settings(allowed: string | null = '["127.0.0.1"]', secret: string | null = SECRET): ConnectorSettings {
  return {
    getSetting(key) { expect(key).toBe(WEBHOOK_ALLOWED_HOSTS_KEY); return allowed; },
    getSecret(key) { expect(key).toBe(SECRET_KEY); return secret; },
  };
}
function provider(endpoint: string, store = settings()) {
  return createWebhookProvider({ endpoint, secretSettingKey: SECRET_KEY }, store);
}

describe('Rust DS webhook provider', () => {
  it.each([null, '', 'not json', '{}', '[1]', '[]', '["other.example"]'])('fails closed for allowed hosts %s', allowed => {
    expect(() => provider('http://127.0.0.1:9000/hook', settings(allowed))).toThrow(/allowed-hosts/);
  });

  it('requires secure-store keys and propagates read failure without leaking secret details', () => {
    const read = vi.fn();
    expect(() => createWebhookProvider({ endpoint: 'https://example.com', secretSettingKey: 'plain' },
      { getSetting: read, getSecret: read })).toThrow(/not a sensitive key/);
    expect(read).not.toHaveBeenCalled();
    expect(() => provider('http://127.0.0.1', settings(undefined, null))).toThrow(/secret is not configured/);
    expect(() => provider('http://127.0.0.1', { ...settings(), getSecret() { throw new Error(SECRET); } }))
      .toThrow('failed to read webhook secret from the secure setting store (fail-closed)');
    expect(() => provider('http://127.0.0.1', { ...settings(), getSetting() { throw new Error(SECRET); } }))
      .toThrow(/allowed-hosts/);
  });

  it('validates HTTPS, exact case-insensitive whitelist and the localhost HTTP exception', () => {
    for (const endpoint of ['http://example.com', 'http://localhost.evil.com', 'https://user:pass@example.com', 'not url']) {
      expect(() => validateWebhookEndpoint(endpoint, ['example.com', 'localhost.evil.com'])).toThrow();
    }
    expect(validateWebhookEndpoint('https://Hooks.Example.com/x', ['HOOKS.example.com']).hostname).toBe('hooks.example.com');
    expect(validateWebhookEndpoint('https://192.168.1.2/hook', ['192.168.1.2']).hostname).toBe('192.168.1.2');
    expect(validateWebhookEndpoint('http://[::1]/hook', ['::1']).hostname).toBe('[::1]');
    expect(() => validateWebhookEndpoint('https://hooks.example.com.evil.com', ['hooks.example.com'])).toThrow();
    expect(() => validateWebhookEndpoint('https://hooks.example.com', ['*.example.com'])).toThrow();
  });

  it('POSTs the exact UTF-8 body with independently verified HMAC, ignoring proxy environment', async () => {
    const deadline = vi.spyOn(AbortSignal, 'timeout');
    const requests: unknown[] = [];
    const endpoint = await receiver((body, headers, response) => {
      requests.push({ body, headers });
      response.end('{"id":"msg-1","thread_id":"t-1"}');
    });
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy']) vi.stubEnv(name, 'http://127.0.0.1:1');
    vi.stubEnv('NO_PROXY', '');
    const hook = provider(endpoint);
    expect(JSON.stringify(hook)).not.toContain(SECRET);
    expect(await hook.submit(op)).toEqual({ externalOperationId: 'msg-1', result: { id: 'msg-1', thread_id: 't-1' } });
    expect(deadline).toHaveBeenCalledWith(30_000);
    expect(requests).toMatchObject([{ body: JSON.stringify(op.body), headers: {
      'content-type': 'application/json', 'x-ds-idempotency-key': 'key-1',
      'x-ds-signature': `sha256=${createHmac('sha256', SECRET).update(JSON.stringify(op.body)).digest('hex')}`,
    } }]);
  });

  it.each([[200, null], [204, null], [409, null], [408, 'transient'], [429, 'transient'], [500, 'transient'],
    [400, 'permanent'], [401, 'permanent'], [302, 'permanent']] as const)('classifies HTTP %s as %s', async (status, kind) => {
    const endpoint = await receiver((_body, _headers, response) => { response.statusCode = status; response.end(); });
    const result = provider(endpoint).submit(op);
    if (kind) await expect(result).rejects.toMatchObject({ kind });
    else await expect(result).resolves.toEqual({ externalOperationId: null, result: {} });
  });

  it('never follows redirects or sends a signed request to the redirect target', async () => {
    const target = vi.fn();
    const destination = await receiver((_body, _headers, response) => { target(); response.end('{}'); });
    const endpoint = await receiver((_body, _headers, response) => {
      response.writeHead(307, { location: destination }); response.end();
    });
    await expect(provider(endpoint).submit(op)).rejects.toMatchObject({ kind: 'permanent' });
    expect(target).not.toHaveBeenCalled();
    await expect(postAllowlistedDirect(endpoint, [], '{}', {})).rejects.toMatchObject({ kind: 'BlockedDestination' });
  });

  it('the 30s deadline also aborts stalled response bodies with submit/lookup-safe classification', async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const deadline = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      expect(ms).toBe(30_000);
      return realTimeout(50); // exercise the production abort path without waiting 30s
    });
    const endpoint = await receiver((_body, _headers, response) => {
      response.writeHead(200); response.write('{'); // receipt never finishes
    });
    await expect(provider(endpoint).submit(op)).rejects.toMatchObject({ kind: 'unknown' });
    await expect(provider(endpoint).lookup('key')).rejects.toMatchObject({ kind: 'transient' });
    expect(deadline).toHaveBeenCalledTimes(2);
  });

  it.each(['invalid json', 'declared oversize', 'chunked oversize', 'truncated'])('submit %s is unknown but lookup body-read failure is transient', async mode => {
    const endpoint = await receiver((_body, _headers, response) => {
      if (mode === 'invalid json') response.end('not json');
      else if (mode === 'declared oversize') { response.setHeader('content-length', 1024 * 1024 + 1); response.end('x'); }
      else if (mode === 'truncated') { response.setHeader('content-length', 100); response.write('x'); setImmediate(() => response.destroy()); }
      else { response.write('x'.repeat(700_000)); response.end('x'.repeat(700_000)); }
    });
    await expect(provider(endpoint).submit(op)).rejects.toMatchObject({ kind: 'unknown' });
    await expect(provider(endpoint).lookup('key')).rejects.toMatchObject({ kind: mode === 'invalid json' ? 'unknown' : 'transient' });
  });

  it('lookup signs the lookup envelope and distinguishes found, never submitted, and unknown', async () => {
    const endpoint = await receiver((body, headers, response) => {
      const key = JSON.parse(body).lookup.idempotency_key;
      expect(headers['x-ds-idempotency-key']).toBe(key);
      expect(headers['x-ds-signature']).toBe(`sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`);
      if (key === '404') { response.statusCode = 404; response.end(); }
      else if (key === 'miss') response.end('{"found":false}');
      else if (key === 'hit') response.end('{"found":true,"external_operation_id":"ext-9","receipt":{"id":"other"}}');
      else if (key === 'fallback') response.end('{"found":true,"result":{"messageId":"fallback"}}');
      else response.end('{"found":"true"}');
    });
    const hook = provider(endpoint);
    await expect(hook.lookup('hit')).resolves.toEqual({ externalOperationId: 'ext-9', receipt: { id: 'other' } });
    await expect(hook.lookup('fallback')).resolves.toEqual({ externalOperationId: 'fallback', receipt: { messageId: 'fallback' } });
    await expect(hook.lookup('miss')).resolves.toBeNull();
    await expect(hook.lookup('404')).resolves.toBeNull();
    await expect(hook.lookup('unknown')).rejects.toMatchObject({ kind: 'unknown' });
  });
});
