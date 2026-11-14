/** DS webhook receiver contract, ported from connector_providers/webhook.rs. */
import { hmacSync } from '../../../../platform/crypto/sync.ts';
import { toHex } from '../../../../platform/crypto/encoding.ts';
import { isSensitiveKey } from '../../../../platform/secrets/sensitive-key.ts';
import { postAllowlistedWebhook, validateWebhookEndpoint } from './webhook-endpoint.ts';
import {
  extractExternalOperationId, ProviderError, type ConnectorProvider, type ConnectorSettings,
  type ProviderOperation, type ProviderOutcome, type ProviderReceipt, type WebhookConfig,
} from './connector-executor.ts';

export const WEBHOOK_ALLOWED_HOSTS_KEY = 'connectors.webhook.allowed_hosts';
const MAX_RESPONSE_BYTES = 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Closure keeps the secret out of inspect/JSON/debug output. Settings reads fail closed. */
export function createWebhookProvider(config: WebhookConfig, settings: ConnectorSettings): ConnectorProvider {
  if (!isSensitiveKey(config.secretSettingKey)) {
    throw ProviderError.permanent(`webhook secretSettingKey '${config.secretSettingKey}' is not a sensitive key; refusing to read secrets from plaintext settings`);
  }
  let allowed: string[];
  try {
    const raw = settings.getSetting(WEBHOOK_ALLOWED_HOSTS_KEY);
    if (raw === null) throw new Error('not configured');
    const parsed: unknown = JSON.parse(raw.trim());
    if (!Array.isArray(parsed) || !parsed.every(host => typeof host === 'string')) throw new Error('not a JSON string array');
    allowed = parsed;
  } catch {
    throw ProviderError.permanent('webhook allowed-hosts setting is missing or not a JSON string array (fail-closed)');
  }
  let endpoint: URL;
  try { endpoint = validateWebhookEndpoint(config.endpoint, allowed); }
  catch (error) { throw ProviderError.permanent((error as Error).message); }
  let secret: string | null;
  try { secret = settings.getSecret(config.secretSettingKey); }
  catch { throw ProviderError.permanent('failed to read webhook secret from the secure setting store (fail-closed)'); }
  if (secret === null) throw ProviderError.permanent('webhook secret is not configured (fail-closed)');
  const signingKey = secret;

  async function post(value: unknown, key: string): Promise<Response> {
    let body: string;
    try { body = JSON.stringify(value); }
    catch { throw ProviderError.permanent('failed to serialize webhook request body'); }
    try {
      return await postAllowlistedWebhook(endpoint.href, allowed, body, {
        'Content-Type': 'application/json', 'X-DS-Idempotency-Key': key,
        'X-DS-Signature': `sha256=${toHex(hmacSync('SHA-256', signingKey, body))}`,
      });
    } catch {
      // Do not include transport exceptions: they may contain URL/header details.
      throw ProviderError.transient(`webhook request to ${endpoint.hostname} failed or timed out after 30s`);
    }
  }

  function classify(response: Response): void {
    if (response.ok || response.status === 409) return;
    void response.body?.cancel();
    if ([408, 429].includes(response.status) || response.status >= 500) {
      throw ProviderError.transient(`webhook endpoint returned HTTP ${response.status}`);
    }
    throw ProviderError.permanent(`webhook endpoint rejected the request with HTTP ${response.status}`);
  }

  async function read(response: Response, lookup: boolean): Promise<string> {
    const failure = lookup ? ProviderError.transient : ProviderError.unknown;
    const reader = response.body?.getReader();
    if (!reader) return '';
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new Error('cap');
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new Error('cap');
        chunks.push(value);
      }
    } catch {
      await reader.cancel().catch(() => {}); // boundary-allow empty-catch: response read already failed; best-effort cancellation must not replace submit Unknown / lookup Transient classification
      throw failure(`failed to read webhook response body within the ${MAX_RESPONSE_BYTES}-byte cap`);
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder().decode(bytes);
  }

  return {
    name: () => 'webhook',
    async submit(op: ProviderOperation): Promise<ProviderReceipt> {
      const response = await post(op.body, typeof op.body.idempotency_key === 'string' ? op.body.idempotency_key : '');
      classify(response);
      const body = await read(response, false);
      let result: unknown;
      try { result = body === '' ? {} : JSON.parse(body); }
      catch { throw ProviderError.unknown(`webhook endpoint returned HTTP ${response.status} with a non-JSON body`); }
      return { externalOperationId: extractExternalOperationId(result), result };
    },
    async lookup(idempotencyKey: string): Promise<ProviderOutcome | null> {
      const response = await post({ lookup: { idempotency_key: idempotencyKey } }, idempotencyKey);
      if (response.status === 404) { await response.body?.cancel(); return null; }
      classify(response);
      let parsed: Record<string, unknown>;
      const body = await read(response, true);
      try { parsed = record(JSON.parse(body)); }
      catch { throw ProviderError.unknown('webhook lookup returned a non-JSON body'); }
      if (typeof parsed.found !== 'boolean') throw ProviderError.unknown("webhook lookup response is missing a boolean 'found'");
      if (!parsed.found) return null;
      const receipt = 'receipt' in parsed ? parsed.receipt : 'result' in parsed ? parsed.result : {};
      return {
        externalOperationId: typeof parsed.external_operation_id === 'string' ? parsed.external_operation_id : extractExternalOperationId(receipt),
        receipt,
      };
    },
  };
}
