import { sha256Sync } from '../../../../platform/crypto/sync.ts';
import { toBase64, fromBase64 } from '../../../../platform/crypto/encoding.ts';
import type { JsonValue } from '../../api.ts';
import type { CodexUsageState, CodexRateLimitsState, CodexRateLimitWindowState } from './usage-state.ts';
import { decodeUtf8Strict, rustTrim, Utf8DecodeError } from '../../../../platform/util/portable.ts';
import { parseRfc3339 } from '../../../../platform/time/index.ts';
import { array, duplicateField, object, string, field, f64, parseJson, parseRustF64, fieldI64, fieldU64, typedI64, U64_MAX, I64_MIN, I64_MAX } from '../json.ts';
import { CodexAuthError } from './error.ts';
import { CODEX_ORIGINATOR, OPENAI_OAUTH_SCOPE, type CodexEndpointConfig } from './protocol.ts';
import { StoredCodexSession } from './types.ts';

export interface OAuthTokenResponse { access_token: string; refresh_token: string | null; id_token: string | null; expires_in: bigint | null }
const TOKEN_FIELDS = [['access_token'], ['refresh_token'], ['id_token'], ['expires_in']];
/** manager.rs:95-103: map or sequence, with defaults on the last three slots. */
export function decodeTokenResponse(body: JsonValue | undefined): OAuthTokenResponse {
  const obj = object(body), sequence = array(body);
  const get = (name: string, index: number) => sequence === undefined ? obj?.[name] : sequence[index];
  const access = get('access_token', 0), refresh = get('refresh_token', 1), id = get('id_token', 2);
  const rawExpiry = get('expires_in', 3);
  const expiresIn = rawExpiry === undefined || rawExpiry === null ? null
    : typedI64(body, sequence === undefined ? 'expires_in' : '3');
  if ((!obj && sequence === undefined) || (sequence !== undefined && sequence.length > TOKEN_FIELDS.length)
    || duplicateField(body, TOKEN_FIELDS) !== undefined || typeof access !== 'string'
    || ![refresh, id].every(item => item === undefined || item === null || typeof item === 'string')
    || expiresIn === undefined) throw new CodexAuthError('MalformedResponse', { field: 'token response' });
  if (!rustTrim(access)) throw new CodexAuthError('MalformedResponse', { field: 'access_token' });
  return { access_token: access, refresh_token: string(refresh) ?? null, id_token: string(id) ?? null, expires_in: expiresIn };
}
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = toBase64(globalThis.crypto.getRandomValues(new Uint8Array(64)), { alphabet: 'url' });
  return { verifier, challenge: toBase64(sha256Sync(verifier), { alphabet: 'url' }) };
}
export function buildAuthorizationUrl(endpoints: CodexEndpointConfig, redirectUri: string, challenge: string, state: string): string {
  const url = new URL(endpoints.authorizeUrl);
  for (const [key, value] of [['response_type', 'code'], ['client_id', endpoints.clientId], ['redirect_uri', redirectUri],
    ['scope', OPENAI_OAUTH_SCOPE], ['code_challenge', challenge], ['code_challenge_method', 'S256'],
    ['id_token_add_organizations', 'true'], ['codex_cli_simplified_flow', 'true'], ['state', state], ['originator', CODEX_ORIGINATOR]] as [string, string][]) url.searchParams.append(key, value);
  return url.href;
}
export function parseJwtClaims(token: string): JsonValue | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const payload = parts[1]!;
  if (!/^[A-Za-z0-9_-]*$/.test(payload) || payload.length % 4 === 1) return undefined;
  const decoded = fromBase64(payload, { alphabet: 'url' });
  if (toBase64(decoded, { alphabet: 'url' }) !== payload) return undefined;
  // manager.rs:1343 parses the decoded bytes directly: a BOM is not JSON
  // whitespace and must not be stripped as TextDecoder would do by default.
  try { return parseJson(decodeUtf8Strict(decoded)); }
  catch (error) { if (error instanceof Utf8DecodeError) return undefined; throw error; }
}
export function accountIdFromClaims(claims: JsonValue): string | undefined {
  const selected = string(field(claims, 'chatgpt_account_id'))
    ?? string(field(field(claims, 'https://api.openai.com/auth'), 'chatgpt_account_id'))
    ?? string(field(array(field(claims, 'organizations'))?.[0], 'id'));
  const trimmed = selected === undefined ? undefined : rustTrim(selected);
  return trimmed || undefined;
}
export function extractAccountId(tokens: OAuthTokenResponse): string | undefined {
  const id = tokens.id_token === null ? undefined : parseJwtClaims(tokens.id_token);
  const access = parseJwtClaims(tokens.access_token);
  return (id === undefined ? undefined : accountIdFromClaims(id)) ?? (access === undefined ? undefined : accountIdFromClaims(access));
}
function firstField(value: JsonValue | undefined, keys: string[]): JsonValue | undefined {
  const obj = object(value);
  if (!obj) return undefined;
  for (const key of keys) if (Object.hasOwn(obj, key)) return obj[key];
  return undefined;
}
function bool(value: JsonValue | undefined): boolean | undefined { return typeof value === 'boolean' ? value : undefined; }
function metadataFromClaims(claims: JsonValue | undefined) {
  const auth = field(claims, 'https://api.openai.com/auth'), profile = field(claims, 'https://api.openai.com/profile');
  const email = string(field(claims, 'email')) ?? string(field(auth, 'email')) ?? string(field(profile, 'email'));
  const plan = string(firstField(claims, ['chatgpt_plan_type', 'plan_type'])) ?? string(firstField(auth, ['chatgpt_plan_type', 'plan_type']));
  const fedramp = bool(field(claims, 'is_fedramp')) ?? bool(firstField(auth, ['chatgpt_account_is_fedramp', 'is_fedramp']));
  return { email: email === undefined ? undefined : rustTrim(email) || undefined, planType: plan === undefined ? undefined : rustTrim(plan) || undefined, isFedramp: fedramp };
}
export function extractTokenMetadata(tokens: OAuthTokenResponse) {
  const primary = metadataFromClaims(tokens.id_token === null ? undefined : parseJwtClaims(tokens.id_token));
  const secondary = metadataFromClaims(parseJwtClaims(tokens.access_token));
  return { email: primary.email ?? secondary.email, planType: primary.planType ?? secondary.planType, isFedramp: primary.isFedramp ?? secondary.isFedramp };
}
/** manager.rs:1794-1798: i64 clamp, saturating_mul(1000), saturating_add(now). */
export function expiryFromResponse(now: bigint, expiresIn: bigint | null): bigint {
  const seconds = clampBig(expiresIn ?? 3600n, 60n, 86400n);
  return clampBig(now + seconds * 1000n, I64_MIN, I64_MAX);
}
export function mergeRefreshSession(current: StoredCodexSession, tokens: OAuthTokenResponse, refreshedAtUnixMs: bigint): StoredCodexSession {
  const currentId = rustTrim(current.accountId);
  if (!currentId) throw new CodexAuthError('MissingAccountId');
  const incoming = extractAccountId(tokens);
  if (incoming !== undefined && incoming !== currentId) throw new CodexAuthError('AccountChanged');
  const metadata = extractTokenMetadata(tokens);
  return new StoredCodexSession({ schemaVersion: 1, accessToken: tokens.access_token, refreshToken: rustTrim(tokens.refresh_token ?? '') || current.refreshToken,
    idToken: rustTrim(tokens.id_token ?? '') || current.idToken, expiresAtUnixMs: expiryFromResponse(refreshedAtUnixMs, tokens.expires_in),
    accountId: incoming ?? currentId, email: metadata.email ?? current.email, planType: metadata.planType ?? current.planType,
    isFedramp: metadata.isFedramp ?? current.isFedramp, lastRefreshAt: refreshedAtUnixMs });
}
export function validateRefreshIdentity(live: StoredCodexSession, requested: StoredCodexSession, refreshed: StoredCodexSession): void {
  const ids = [live, requested, refreshed].map(session => rustTrim(session.accountId));
  if (ids.some(id => id === '')) throw new CodexAuthError('MissingAccountId');
  if (ids[0] !== ids[1] || ids[2] !== ids[1]) throw new CodexAuthError('AccountChanged');
}
export function sanitizeOauthCode(value: string): string { return value.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'oauth_error'; }
export function oauthErrorCode(body: JsonValue): string {
  const code = string(field(field(body, 'error'), 'code')) ?? string(field(body, 'error')) ?? string(field(body, 'code'))
    ?? string(field(field(body, 'detail'), 'code')) ?? string(field(field(body, 'error'), 'type'));
  return code === undefined ? 'http_error' : sanitizeOauthCode(code);
}
export function oauthRejection(stage: string, status: number, body: JsonValue): CodexAuthError {
  let code = oauthErrorCode(body);
  if (code === 'http_error') code = `http_${status}`;
  const reauthRequired = stage === 'refresh' && ['invalid_grant', 'invalid_token', 'unauthorized'].includes(code);
  const rateLimited = ['usage_limit_reached', 'usage_not_included', 'rate_limit_exceeded', 'slow_down'].includes(code);
  const permanent = reauthRequired || status >= 400 && status < 500 && status !== 408 && status !== 429 && !rateLimited && code !== 'temporarily_unavailable';
  return new CodexAuthError('OAuthRejected', { stage, code, permanent, reauthRequired });
}
export function requiredStringAlias(value: JsonValue, fields: string[], errorField: string): string {
  let found: string | undefined;
  for (const key of fields) { found = string(field(value, key)); if (found !== undefined) break; }
  const trimmed = rustTrim(found ?? '');
  if (!trimmed) throw new CodexAuthError('MalformedResponse', { field: errorField });
  return trimmed;
}
/** manager.rs:1913 `value_as_u64(holder[key])`: `as_u64` or Rust `u64::from_str`. */
export function valueAsU64(holder: JsonValue | undefined, key: string): bigint | undefined {
  const value = field(holder, key);
  if (typeof value === 'string') {
    if (!/^\+?\d+$/.test(value)) return undefined;
    const n = BigInt(value); return n <= U64_MAX ? n : undefined;
  }
  return fieldU64(holder, key);
}
export const clampBig = (value: bigint, min: bigint, max: bigint): bigint => value < min ? min : value > max ? max : value;
function stringAt(value: JsonValue, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = string(field(value, key));
    if (v !== undefined) return [...rustTrim(v)].slice(0, 128).join('') || undefined;
  }
  return undefined;
}
function numberAt(value: JsonValue, keys: string[]): number | undefined {
  for (const key of keys) {
    const v = field(value, key);
    // manager.rs:1770 `as_f64` (non-finite filtered under arbitrary_precision) then `str::parse::<f64>`.
    const number = f64(v);
    if (number !== undefined) return number;
    if (typeof v === 'string') {
      const parsed = parseRustF64(v);
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}
function integerAt(value: JsonValue, keys: string[]): bigint | undefined {
  for (const key of keys) { const v = valueAsU64(value, key); if (v !== undefined) return v; }
  return undefined;
}
/** manager.rs:1779 `timestamp_at`: as_i64 → i64::from_str → RFC3339 `timestamp()`. */
function timestampAt(value: JsonValue, keys: string[]): bigint | undefined {
  for (const key of keys) {
    const v = field(value, key);
    if (v === undefined) continue;
    const exact = fieldI64(value, key);
    if (exact !== undefined) return exact;
    if (typeof v === 'string') {
      if (/^[-+]?\d+$/.test(v)) { const n = BigInt(v); if (n >= I64_MIN && n <= I64_MAX) return n; }
      const parsed = parseRfc3339(v);
      if (parsed !== null) return BigInt(Math.floor(parsed.millis / 1000));
    }
  }
  return undefined;
}
function parseWindow(value: JsonValue, fetchedAt: bigint): CodexRateLimitWindowState | undefined {
  const remaining = numberAt(value, ['remaining_percent', 'remainingPercent']);
  const rawUsed = numberAt(value, ['used_percent', 'usedPercent']) ?? (remaining === undefined ? undefined : 100 - remaining);
  const usedPercent = rawUsed === undefined ? undefined : Math.max(0, Math.min(100, rawUsed));
  const seconds = integerAt(value, ['limit_window_seconds', 'limitWindowSeconds', 'window_seconds', 'windowSeconds']);
  // u64 `saturating_add(59) / 60`; `fetched/1000 + seconds as i64` wraps in release builds.
  const minutes = integerAt(value, ['window_duration_mins', 'windowDurationMins', 'window_minutes', 'windowMinutes'])
    ?? (seconds === undefined ? undefined : (seconds + 59n > U64_MAX ? U64_MAX : seconds + 59n) / 60n);
  const resetsIn = integerAt(value, ['resets_in_seconds', 'resetsInSeconds']);
  const resetsAtExact = timestampAt(value, ['resets_at', 'resetsAt', 'reset_at', 'resetAt', 'reset_time'])
    ?? (resetsIn === undefined ? undefined : BigInt.asIntN(64, fetchedAt / 1000n + BigInt.asIntN(64, resetsIn)));
  // These are Host fields, not IPC: keep the exact result through the manager.
  const windowDurationMins = minutes;
  const resetsAt = resetsAtExact;
  if (usedPercent === undefined && windowDurationMins === undefined && resetsAt === undefined) return undefined;
  return { ...(usedPercent === undefined ? {} : { usedPercent }), ...(windowDurationMins === undefined ? {} : { windowDurationMins }), ...(resetsAt === undefined ? {} : { resetsAt }) };
}
function parseLimits(outer: JsonValue, fallbackId: string | undefined, plan: string | undefined, fetchedAt: bigint): CodexRateLimitsState | undefined {
  const value = firstField(outer, ['rate_limit', 'rateLimit']) ?? outer;
  const first = firstField(value, ['primary', 'primary_window', 'primaryWindow']), second = firstField(value, ['secondary', 'secondary_window', 'secondaryWindow']);
  const primary = first === undefined ? undefined : parseWindow(first, fetchedAt), secondary = second === undefined ? undefined : parseWindow(second, fetchedAt);
  if (!primary && !secondary) return undefined;
  const limitId = stringAt(value, ['limit_id', 'limitId']) ?? stringAt(outer, ['limit_id', 'limitId', 'metered_feature', 'meteredFeature']) ?? fallbackId;
  const limitName = stringAt(outer, ['limit_name', 'limitName']) ?? stringAt(value, ['limit_name', 'limitName']);
  const planType = stringAt(value, ['plan_type', 'planType']) ?? plan;
  return { ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}), ...(limitId === undefined ? {} : { limitId }), ...(limitName === undefined ? {} : { limitName }), ...(planType === undefined ? {} : { planType }) };
}
function looksLikeLimit(value: JsonValue): boolean { return ['primary', 'primary_window', 'primaryWindow', 'secondary', 'secondary_window', 'secondaryWindow'].some(key => Object.hasOwn(object(value) ?? {}, key)); }
export function parseUsageSnapshot(body: JsonValue, fetchedAt: bigint): CodexUsageState {
  const plan = stringAt(body, ['plan_type', 'planType']);
  const byId: Record<string, CodexRateLimitsState> = {};
  const insert = (id: string, value: JsonValue, replace = true) => {
    const parsed = parseLimits(value, id, plan, fetchedAt);
    if (parsed && (replace || !Object.hasOwn(byId, id))) Object.defineProperty(byId, id, { value: parsed, enumerable: true, configurable: true, writable: true });
  };
  for (const [id, value] of Object.entries(object(firstField(body, ['rate_limits_by_limit_id', 'rateLimitsByLimitId'])) ?? {})) insert(id, value);
  for (const value of array(firstField(body, ['additional_rate_limits', 'additionalRateLimits'])) ?? []) insert(stringAt(value, ['limit_id', 'limitId', 'metered_feature', 'meteredFeature', 'limit_name', 'limitName']) ?? `additional_${Object.keys(byId).length + 1}`, value);
  const entries = firstField(body, ['rate_limits', 'rateLimits']);
  if (Array.isArray(entries)) for (const value of entries) {
    const parsed = parseLimits(value, undefined, plan, fetchedAt);
    if (parsed) Object.defineProperty(byId, parsed.limitId ?? `limit_${Object.keys(byId).length + 1}`, { value: parsed, enumerable: true, configurable: true, writable: true });
  }
  else if (object(entries)) {
    if (looksLikeLimit(entries!)) insert('codex', entries!, false);
    else for (const [id, value] of Object.entries(object(entries)!)) insert(id, value, false);
  }
  for (const [key, id] of [['rate_limit', 'codex'], ['rateLimit', 'codex'], ['code_review_rate_limit', 'codex_review'], ['codeReviewRateLimit', 'codex_review']] as [string, string][]) {
    const value = field(body, key); if (value !== undefined) insert(id, value, false);
  }
  if (Object.keys(byId).length === 0 && looksLikeLimit(body)) insert('codex', body);
  const rateLimits = byId.codex ?? Object.values(byId)[0];
  return { ...(rateLimits ? { rateLimits: structuredClone(rateLimits) } : {}), ...(Object.keys(byId).length ? { rateLimitsByLimitId: byId } : {}), fetchedAt };
}
