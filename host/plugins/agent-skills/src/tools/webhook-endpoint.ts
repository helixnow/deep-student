/**
 * Webhook whitelist validation and the POST transport used by the connector provider.
 *
 * `platform/http/allowlisted-direct.ts` is desktop-only (undici `Agent`, `NO_READ_TIMEOUTS`) and
 * therefore not part of the mobile Host closure. The rules below are the same ones
 * (`normalizeWebhookHost` / `validateWebhookEndpoint`); `tests/webhook-endpoint.test.ts` pins
 * parity with the platform implementation, and the transport keeps the same observable contract:
 * one request, `redirect: 'manual'`, identity encoding and a 30 s deadline covering the body.
 */
import { HttpError } from '../../../../platform/http/api.ts';

export function normalizeWebhookHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
}

export function validateWebhookEndpoint(raw: string, allowedHosts: readonly string[]): URL {
  let url: URL;
  try { url = new URL(raw.trim()); }
  catch { throw new HttpError('InvalidUrl', '', 'webhook endpoint is not a URL'); }
  const host = normalizeWebhookHost(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(host))) {
    throw new HttpError('InvalidUrl', '', 'webhook endpoint must use HTTPS (plain HTTP is only allowed for localhost)');
  }
  if (url.username || url.password) {
    throw new HttpError('InvalidUrl', '', 'webhook endpoint must not embed userinfo credentials');
  }
  if (!allowedHosts.some(entry => normalizeWebhookHost(entry.trim()) === host)) {
    throw new HttpError('BlockedDestination', '', `webhook endpoint host '${url.hostname}' is not in the allowed-hosts whitelist`);
  }
  return url;
}

/** One request per operation; the deadline also covers response-body consumption. */
export async function postAllowlistedWebhook(
  endpoint: string, allowedHosts: readonly string[], body: string, headers: Readonly<Record<string, string>>,
): Promise<Response> {
  const url = validateWebhookEndpoint(endpoint, allowedHosts);
  return globalThis.fetch(url, {
    method: 'POST',
    headers: { 'accept-encoding': 'identity', ...headers },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
}
