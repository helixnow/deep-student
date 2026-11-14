/** Operator-configured webhook channel: exact host whitelist, no proxy, no redirects.
 * Unlike public-pinned, explicitly whitelisted private destinations are permitted.
 */
import { Agent } from 'undici';
import { HttpError } from './api.ts';
import { NO_READ_TIMEOUTS } from './proxy.ts';

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

/** One request per agent; the 30s deadline covers response-body consumption too. */
export async function postAllowlistedDirect(
  endpoint: string, allowedHosts: readonly string[], body: string, headers: Readonly<Record<string, string>>,
): Promise<Response> {
  const url = validateWebhookEndpoint(endpoint, allowedHosts);
  const agent = new Agent({ ...NO_READ_TIMEOUTS, connect: { timeout: 30_000, rejectUnauthorized: true } });
  try {
    const response = await globalThis.fetch(url, {
      method: 'POST', headers: { 'accept-encoding': 'identity', ...headers }, body,
      redirect: 'manual', signal: AbortSignal.timeout(30_000), dispatcher: agent,
    } as RequestInit);
    void agent.close();
    return response;
  } catch (error) {
    void agent.destroy();
    throw error;
  }
}
