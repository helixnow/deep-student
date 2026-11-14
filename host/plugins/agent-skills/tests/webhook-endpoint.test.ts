/**
 * Parity between the portable webhook guard (`src/tools/webhook-endpoint.ts`, shared by the
 * mobile host) and the desktop transport rules in `platform/http/allowlisted-direct.ts`.
 * The transport contract is pinned too: one POST, identity encoding, no redirect following
 * and the 30 s deadline covering the body.
 */
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeWebhookHost as platformNormalize, validateWebhookEndpoint as platformValidate,
} from '../../../platform/http/allowlisted-direct.ts';
import {
  normalizeWebhookHost, postAllowlistedWebhook, validateWebhookEndpoint,
} from '../src/tools/webhook-endpoint.ts';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(closers.splice(0).map(close => close()));
});

async function receiver(
  respond: (body: string, headers: IncomingHttpHeaders) => { status?: number; body?: string; headers?: Record<string, string> },
): Promise<string> {
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk.toString();
    const result = respond(body, request.headers);
    response.writeHead(result.status ?? 200, result.headers ?? {});
    response.end(result.body ?? '');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
}

function outcome(validate: () => URL): string {
  try { return `ok:${validate().toString()}`; }
  catch (error) { return `${(error as Error).name}:${(error as { kind?: string }).kind}:${(error as Error).message}`; }
}

describe('webhook-endpoint parity', () => {
  it('normalizes hosts exactly like the platform transport', () => {
    for (const value of ['HOOKS.Example.com', 'hooks.example.com.', '[::1]', '[2001:db8::1]', '', ' localhost ']) {
      expect(normalizeWebhookHost(value)).toBe(platformNormalize(value));
    }
  });

  it('accepts and rejects the same endpoints with the same HttpError kind and text', () => {
    const cases: Array<[string, string[]]> = [
      ['https://Hooks.Example.com/x', ['HOOKS.example.com']],
      ['https://example.com./hook', ['example.com']],
      ['http://localhost/hook', ['localhost']],
      ['http://127.0.0.1:9000/hook', ['127.0.0.1']],
      ['http://[::1]/hook', ['::1']],
      ['https://192.168.1.2/hook', ['192.168.1.2']],
      ['https://example.com', ['example.com', 'other.example']],
      ['http://example.com', ['example.com']],
      ['http://localhost.evil.com', ['localhost.evil.com']],
      ['https://user:pass@example.com', ['example.com']],
      ['https://hooks.example.com.evil.com', ['hooks.example.com']],
      ['https://hooks.example.com', ['*.example.com']],
      ['https://hooks.example.com', []],
      ['not url', ['example.com']],
      ['', []],
    ];
    for (const [endpoint, allowed] of cases) {
      const portable = outcome(() => validateWebhookEndpoint(endpoint, allowed));
      const platform = outcome(() => platformValidate(endpoint, allowed));
      expect(portable, endpoint).toBe(platform);
    }
  });

  it('POSTs one identity-encoded request and does not follow redirects', async () => {
    const seen: Array<{ body: string; headers: IncomingHttpHeaders; calls: number }> = [];
    let calls = 0;
    const completed = await receiver((body, headers) => {
      calls++;
      seen.push({ body, headers, calls });
      return { body: '{"id":"msg-1"}' };
    });
    const response = await postAllowlistedWebhook(
      completed, ['127.0.0.1'], '{"hello":"你好"}', { 'content-type': 'application/json' },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'msg-1' });
    expect(calls).toBe(1);
    expect(seen[0]).toMatchObject({
      body: '{"hello":"你好"}',
      headers: { 'content-type': 'application/json', 'accept-encoding': 'identity' },
    });
  });

  it('refuses an unlisted host before opening a connection', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(postAllowlistedWebhook('https://evil.example/hook', ['good.example'], '{}', {}))
      .rejects.toMatchObject({ kind: 'BlockedDestination' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses a 30 s deadline', async () => {
    const deadline = vi.spyOn(AbortSignal, 'timeout');
    const endpoint = await receiver(() => ({ status: 204 }));
    await postAllowlistedWebhook(endpoint, ['127.0.0.1'], '{}', {});
    expect(deadline).toHaveBeenCalledWith(30_000);
  });

  it('returns redirect responses to the caller instead of following them', async () => {
    const target = await receiver(() => ({ body: 'target hit' }));
    const endpoint = await receiver(() => ({ status: 307, headers: { location: target } }));
    const response = await postAllowlistedWebhook(endpoint, ['127.0.0.1'], '{}', {});
    expect(response.status).toBe(307);
    expect(await response.text()).toBe('');
  });
});
