import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { stringifyJsonLossless, type DbJson } from '../../sync/api.ts';
import { CodexAuthManager, generatePkce, parseJwtClaims, accountIdFromClaims, mergeRefreshSession, validateRefreshIdentity, oauthRejection, buildAuthorizationUrl, requiredStringAlias, parseUsageSnapshot } from '../src/openai-codex/manager.ts';
import { CodexEndpointConfig, OPENAI_OAUTH_SCOPE, CODEX_ORIGINATOR } from '../src/openai-codex/protocol.ts';
import { StoredCodexSession } from '../src/openai-codex/types.ts';
import { CodexAuthError } from '../src/openai-codex/error.ts';
import type { CodexCredentialStore } from '../src/openai-codex/store.ts';
import type { ActiveAttempt } from '../src/openai-codex/manager.ts';
import type { JsonValue } from '../api.ts';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const jwt = (payload: JsonValue) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
const tokenResponse = (account: string | null, access: string, refresh: string | null) => ({ access_token: access, refresh_token: refresh, id_token: account === null ? null : jwt({ chatgpt_account_id: account }), expires_in: 3600n });
const stored = (accountId = 'account-1', accessToken = 'access-secret') => new StoredCodexSession({ schemaVersion: 1, accessToken, refreshToken: 'refresh-secret', idToken: null, expiresAtUnixMs: BigInt(Date.now()) + 3600000n, accountId, email: null, planType: 'plus', isFedramp: false, lastRefreshAt: BigInt(Date.now()) });
const attempt = (id: string, kind: 'browser' | 'device' = 'browser'): ActiveAttempt => ({ id, kind, expiresAtUnixMs: Date.now() + 60000, authorizationUrl: null, verificationUrl: null, userCode: null, pollIntervalSeconds: null, previousPhase: null, cancel: new AbortController() });
class MemoryStore implements CodexCredentialStore {
  value: StoredCodexSession | null = null;
  saveCount = 0;
  failSave = false;
  failDelete = false;
  saveStarted = deferred();
  deleteStarted = deferred();
  saveRelease?: Promise<void>;
  deleteRelease?: Promise<void>;
  async load() { return this.value?.clone() ?? null; }
  async save(value: StoredCodexSession) {
    this.saveCount++; this.saveStarted.resolve();
    await this.saveRelease;
    if (this.failSave) throw new CodexAuthError('CredentialStore');
    this.value = value.clone();
  }
  async delete() {
    this.deleteStarted.resolve(); await this.deleteRelease;
    if (this.failDelete) throw new CodexAuthError('CredentialStore');
    this.value = null;
  }
}
async function manager(store = new MemoryStore(), base = 'http://127.0.0.1:9999/') {
  return CodexAuthManager.create(store, '0.11.0', CodexEndpointConfig.forTest(base));
}
async function server(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const errors: unknown[] = [];
  const http = createServer((req, res) => { Promise.resolve(handler(req, res)).catch(error => { errors.push(error); res.destroy(error as Error); }); });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('expected TCP address');
  return { base: `http://127.0.0.1:${address.port}/`, close: async () => {
    http.closeAllConnections(); await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    expect(errors).toEqual([]);
  } };
}
function json(res: ServerResponse, value: DbJson, status = 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(stringifyJsonLossless(value)); }
const kind = (name: string) => expect.objectContaining({ kind: name });
async function stillPending(promise: Promise<unknown>) {
  const pending = Symbol('pending');
  expect(await Promise.race([promise.then(value => value, error => error), delay(50, pending)])).toBe(pending);
}

it('pkce_uses_s256_and_rfc_length_verifier', () => {
  const pkce = generatePkce();
  expect(pkce.verifier.length).toBeGreaterThanOrEqual(43); expect(pkce.verifier.length).toBeLessThanOrEqual(128);
  expect(pkce.challenge).toBe(createHash('sha256').update(pkce.verifier).digest('base64url'));
  expect(pkce.challenge).not.toContain('=');
});
it('jwt_claims_use_root_then_namespaced_then_organization', () => {
  expect(accountIdFromClaims(parseJwtClaims(jwt({ chatgpt_account_id: 'root', 'https://api.openai.com/auth': { chatgpt_account_id: 'nested' } }))!)).toBe('root');
  expect(accountIdFromClaims(parseJwtClaims(jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'nested' } }))!)).toBe('nested');
  expect(accountIdFromClaims(parseJwtClaims(jwt({ organizations: [{ id: 'org-1' }] }))!)).toBe('org-1');
});
it('malformed_jwt_is_rejected', () => {
  expect(parseJwtClaims('not-a-jwt')).toBeUndefined(); expect(parseJwtClaims('a.b.c.d')).toBeUndefined();
});
it('initial_tokens_require_account_id', async () => {
  const auth = await manager();
  expect(() => auth.sessionFromInitialTokens(tokenResponse(null, 'new-access', 'new-refresh'))).toThrow(kind('MissingAccountId'));
});
it('refresh_merge_retains_rotating_fields_when_omitted', () => {
  const current = stored('account-1', 'old-access');
  current.refreshToken = 'old-refresh'; current.idToken = 'old-id'; current.email = 'old@example.com'; current.isFedramp = true;
  const merged = mergeRefreshSession(current, tokenResponse(null, 'new-access', null), 1000n);
  expect(merged.refreshToken).toBe('old-refresh'); expect(merged.accountId).toBe('account-1'); expect(merged.accessToken).toBe('new-access');
  expect(merged.idToken).toBe('old-id'); expect(merged.email).toBe('old@example.com'); expect(merged.planType).toBe('plus');
  expect(merged.isFedramp).toBe(true); expect(merged.lastRefreshAt).toBe(1000n);
});
it('refresh_merge_rejects_account_switch', () => {
  expect(() => mergeRefreshSession(stored('account-1', 'old-access'), tokenResponse('account-2', 'new-access', 'new-refresh'), 1000n)).toThrow(kind('AccountChanged'));
});
it('refresh_commit_rejects_live_account_change_or_missing_identity', () => {
  const requested = stored('account-1', 'old-access'), refreshed = stored('account-1', 'new-access');
  expect(() => validateRefreshIdentity(stored('account-2', 'newer-access'), requested, refreshed)).toThrow(kind('AccountChanged'));
  expect(() => validateRefreshIdentity(requested, requested, stored(' ', 'new-access'))).toThrow(kind('MissingAccountId'));
});
it('nested_usage_limit_error_is_safely_mapped_as_transient', () => {
  const error = oauthRejection('usage', 404, { error: { code: 'usage_limit_reached', message: 'sensitive upstream detail' } });
  expect(error).toMatchObject({ kind: 'OAuthRejected', detail: { code: 'usage_limit_reached', permanent: false, reauthRequired: false } });
  expect(error.toDto().message).not.toContain('sensitive upstream detail');
});
it('authorization_url_contains_exact_openai_flow_fields', () => {
  const url = new URL(buildAuthorizationUrl(CodexEndpointConfig.forTest('http://127.0.0.1:9999/'), 'http://localhost:1455/auth/callback', 'challenge', 'state'));
  expect(url.searchParams.get('scope')).toBe(OPENAI_OAUTH_SCOPE);
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true');
  expect(url.searchParams.get('id_token_add_organizations')).toBe('true');
  expect(url.searchParams.get('originator')).toBe(CODEX_ORIGINATOR);
});
it('device_user_code_accepts_both_server_spellings', () => {
  expect(requiredStringAlias({ user_code: 'ABCD-EFGH' }, ['user_code', 'usercode'], 'user_code')).toBe('ABCD-EFGH');
  expect(requiredStringAlias({ usercode: 'WXYZ-1234' }, ['user_code', 'usercode'], 'user_code')).toBe('WXYZ-1234');
});
it('cancelled_or_failed_reauthentication_login_preserves_required_phase', async () => {
  const store = new MemoryStore(); store.value = stored(); const auth = await manager(store);
  expect(await auth.markReauthenticationRequired(1)).toBe(true);
  auth.installAttempt(attempt('cancelled')); await auth.cancelLogin('cancelled');
  expect((await auth.status()).phase).toBe('reauthentication_required');
  auth.installAttempt(attempt('failed')); auth.finishAttemptError('failed', new CodexAuthError('Timeout'));
  expect((await auth.status()).phase).toBe('reauthentication_required');
});
it('authorizing_status_reports_if_the_existing_session_remains_usable', async () => {
  const store = new MemoryStore(); store.value = stored(); const auth = await manager(store);
  auth.installAttempt(attempt('relogin'));
  const status = await auth.status(); expect(status.phase).toBe('authorizing'); expect(status.hasUsableSession).toBe(true);
  expect(await auth.markReauthenticationRequired(status.generation)).toBe(true);
  expect((await auth.status()).phase).toBe('authorizing'); expect((await auth.status()).hasUsableSession).toBe(false);
});
it('stale_cancel_id_does_not_cancel_new_attempt', async () => {
  const auth = await manager(); auth.installAttempt(attempt('new-attempt', 'device'));
  await expect(auth.cancelLogin('stale-attempt')).rejects.toThrow(kind('AttemptNotFound'));
  expect((await auth.status()).activeAttemptId).toBe('new-attempt');
});
it('completed_save_wins_over_concurrent_cancel', async () => {
  const store = new MemoryStore(), release = deferred(); store.saveRelease = release.promise;
  const auth = await manager(store); auth.installAttempt(attempt('saving'));
  const persist = auth.persistAndInstall('saving', stored('account-1', 'new-access'));
  await store.saveStarted.promise;
  expect((await auth.status()).phase).toBe('authorizing');
  const cancel = auth.cancelLogin('saving'); await stillPending(cancel);
  release.resolve(); await persist;
  await expect(cancel).rejects.toThrow(kind('AttemptNotFound'));
  expect(store.saveCount).toBe(1); expect((await store.load())!.accessToken).toBe('new-access');
  expect((await auth.status()).phase).toBe('authenticated'); expect((await auth.status()).activeAttemptId).toBeNull();
});
it('dropped_persist_waiter_still_cleans_up_a_failed_save', async () => {
  const store = new MemoryStore(), release = deferred(); store.saveRelease = release.promise; store.failSave = true;
  const auth = await manager(store); auth.installAttempt(attempt('failed-save'));
  const detached = auth.persistAndInstall('failed-save', stored('account-1', 'must-not-install')).catch(error => error);
  await store.saveStarted.promise; release.resolve(); await detached;
  const status = await auth.status(); expect(status.activeAttemptId).toBeNull(); expect(status.phase).toBe('signed_out');
  expect(status.lastError?.code).toBe('credential_store_failed'); expect(await store.load()).toBeNull();
});
it('failed_logout_delete_preserves_memory_and_persisted_session', async () => {
  const store = new MemoryStore(); store.value = stored('account-1', 'still-authenticated'); store.failDelete = true;
  const auth = await manager(store, 'http://127.0.0.1:9/'), before = await auth.status();
  await expect(auth.logout()).rejects.toThrow(kind('CredentialStore'));
  const after = await auth.status(); expect(after.phase).toBe('authenticated'); expect(after.generation).toBe(before.generation); expect(after.accountHint).toBe(before.accountHint);
  expect((await store.load())!.accessToken).toBe('still-authenticated'); expect((await auth.requestAuth(false)).generation()).toBe(before.generation);
});
it('logout_cancels_attempt_installed_before_transaction_gets_gate', async () => {
  const auth = await manager(), release = await auth._refreshGate.acquire();
  const logout = auth.logoutTransaction(), login = attempt('early-login'); auth.installAttempt(login);
  expect(login.cancel.signal.aborted).toBe(false); release(); await logout;
  expect(login.cancel.signal.aborted).toBe(true); expect((await auth.status()).phase).toBe('signed_out'); expect((await auth.status()).activeAttemptId).toBeNull();
});
it('logout_cancels_attempt_installed_while_delete_is_blocked', async () => {
  const store = new MemoryStore(), release = deferred(); store.value = stored('account-1', 'old-access'); store.deleteRelease = release.promise;
  const auth = await manager(store, 'http://127.0.0.1:9/'), logout = auth.logout();
  await store.deleteStarted.promise;
  const login = attempt('login-during-delete', 'device'); auth.installAttempt(login);
  expect(login.cancel.signal.aborted).toBe(false); release.resolve(); await logout;
  expect(login.cancel.signal.aborted).toBe(true); expect(await store.load()).toBeNull();
  expect((await auth.status()).phase).toBe('signed_out'); expect((await auth.status()).activeAttemptId).toBeNull();
});
it('logout_holds_commit_gate_until_old_token_revocation_finishes', async () => {
  const started = deferred(), release = deferred();
  const http = await server(async (req, res) => { if (req.url === '/oauth/revoke') { started.resolve(); await release.promise; json(res, {}); } else json(res, {}, 404); });
  try {
    const store = new MemoryStore(); store.value = stored('account-1', 'old-access'); const auth = await manager(store, http.base);
    const logout = auth.logout(); await started.promise;
    auth.installAttempt(attempt('new-login'));
    const persist = auth.persistAndInstall('new-login', stored('account-1', 'new-login-access')); await stillPending(persist);
    release.resolve(); await logout; await persist;
    expect((await store.load())!.accessToken).toBe('new-login-access'); expect((await auth.status()).phase).toBe('authenticated');
  } finally { release.resolve(); await http.close(); }
});
it('stale_reauthentication_signal_cannot_poison_newer_session', async () => {
  const store = new MemoryStore(); store.value = stored('account-1', 'old-access'); const auth = await manager(store);
  const generation = (await auth.requestAuth(false)).generation();
  auth._state.session = stored('account-1', 'new-access'); auth._state.generation = generation + 1; auth._state.phase = 'authenticated';
  expect(await auth.markReauthenticationRequired(generation)).toBe(false); expect((await auth.status()).phase).toBe('authenticated');
  auth.installAttempt(attempt('reauth-login')); expect(await auth.markReauthenticationRequired(generation + 1)).toBe(true);
  expect((await auth.status()).phase).toBe('authorizing'); await auth.cancelLogin('reauth-login'); expect((await auth.status()).phase).toBe('reauthentication_required');
});
it('cancel_winning_refresh_gate_prevents_persistence', async () => {
  const store = new MemoryStore(), auth = await manager(store); auth.installAttempt(attempt('cancelling', 'device'));
  const release = await auth._refreshGate.acquire(), cancel = auth.cancelLogin('cancelling');
  await stillPending(cancel);
  const persist = auth.persistAndInstall('cancelling', stored('account-1', 'must-not-save')); await stillPending(persist);
  release(); await cancel; await expect(persist).rejects.toThrow(kind('Cancelled'));
  expect(await store.load()).toBeNull(); expect((await auth.status()).phase).toBe('signed_out'); expect((await auth.status()).activeAttemptId).toBeNull();
});
it('successful_install_is_atomic_and_finish_success_is_idempotent', async () => {
  const store = new MemoryStore(), auth = await manager(store); auth.installAttempt(attempt('success'));
  await auth.persistAndInstall('success', stored('account-1', 'new-access'));
  const committed = await auth.status(); expect(committed.phase).toBe('authenticated'); expect(committed.generation).toBe(2);
  expect(committed.activeAttemptId).toBeNull(); expect(committed.lastError).toBeNull();
  auth.finishAttemptSuccess('success'); auth.finishAttemptSuccess('success'); const finished = await auth.status();
  expect(finished.phase).toBe(committed.phase); expect(finished.generation).toBe(committed.generation); expect(finished.accountHint).toBe(committed.accountHint);
  expect(finished.activeAttemptId).toBeNull(); expect((await store.load())!.accessToken).toBe('new-access');
});
it('device_start_cancelled_during_initial_request_does_not_resurrect_attempt', async () => {
  const started = deferred(), release = deferred();
  const http = await server(async (_req, res) => { started.resolve(); await release.promise; json(res, {}); });
  try {
    const auth = await manager(new MemoryStore(), http.base), start = auth.startDeviceLogin(); await started.promise;
    await auth.cancelLogin((await auth.status()).activeAttemptId!);
    await expect(start).rejects.toThrow(kind('Cancelled')); expect((await auth.status()).activeAttemptId).toBeNull();
  } finally { release.resolve(); await http.close(); }
});
it('refresh_generation_is_rechecked_before_persisting_tokens', async () => {
  const started = deferred(), release = deferred();
  const http = await server(async (_req, res) => { started.resolve(); await release.promise; json(res, tokenResponse('account-1', 'refreshed-access', 'refreshed-refresh')); });
  try {
    const store = new MemoryStore(); store.value = stored('account-1', 'old-access'); const auth = await manager(store, http.base);
    const refresh = auth.refreshInternal(1, true, false); await started.promise;
    auth._state.generation = 2; auth._state.phase = 'authenticated'; auth._state.session!.accessToken = 'newer-access'; release.resolve();
    expect((await refresh).generation()).toBe(2); expect((await store.load())!.accessToken).toBe('old-access');
  } finally { release.resolve(); await http.close(); }
});
it('dropped_refresh_waiter_still_commits_without_hiding_active_login', async () => {
  const started = deferred(), release = deferred();
  const http = await server(async (_req, res) => { started.resolve(); await release.promise; json(res, tokenResponse('account-1', 'rotated-access', 'rotated-refresh')); });
  try {
    const store = new MemoryStore(); store.value = stored('account-1', 'old-access'); const auth = await manager(store, http.base);
    const detached = auth.refreshInternal(1, true, false); await started.promise;
    auth.installAttempt(attempt('login-during-refresh', 'device')); expect((await auth.status()).phase).toBe('authorizing');
    release.resolve(); await detached;
    expect((await store.load())!.accessToken).toBe('rotated-access'); const status = await auth.status();
    expect(status.generation).toBe(2); expect(status.phase).toBe('authorizing'); expect(status.activeAttemptId).toBe('login-during-refresh');
    await auth.cancelLogin('login-during-refresh'); expect((await auth.status()).phase).toBe('authenticated');
  } finally { release.resolve(); await http.close(); }
});
it('failed_refresh_persistence_requires_reauth_without_hiding_active_login', async () => {
  const http = await server((_req, res) => json(res, tokenResponse('account-1', 'rotated-access', 'rotated-refresh')));
  const release = deferred();
  try {
    const store = new MemoryStore(); store.value = stored('account-1', 'old-access'); store.saveRelease = release.promise; store.failSave = true;
    const auth = await manager(store, http.base), refresh = auth.refreshInternal(1, true, false); await store.saveStarted.promise;
    auth.installAttempt(attempt('active-login', 'device')); release.resolve(); await expect(refresh).rejects.toThrow(kind('CredentialStore'));
    const status = await auth.status(); expect(status.phase).toBe('authorizing'); expect(status.activeAttemptId).toBe('active-login'); expect(status.lastError?.code).toBe('credential_store_failed');
    expect((await store.load())!.accessToken).toBe('old-access'); await expect(auth.requestAuth(false)).rejects.toThrow(kind('ReauthenticationRequired'));
    await auth.cancelLogin('active-login'); expect((await auth.status()).phase).toBe('reauthentication_required'); await expect(auth.requestAuth(false)).rejects.toThrow(kind('ReauthenticationRequired'));
  } finally { release.resolve(); await http.close(); }
});
it('status_never_exposes_tokens', async () => {
  const store = new MemoryStore(); store.value = stored('account-123456789'); store.value.idToken = 'id-secret'; store.value.email = 'user@example.com';
  const auth = await manager(store), serialized = stringifyJsonLossless(await auth.status());
  for (const secret of ['access-secret', 'refresh-secret', 'id-secret', 'account-123456789']) expect(serialized).not.toContain(secret);
  expect(serialized).toContain('***456789');
});
it('usage_fixture_is_parsed_into_frontend_shape', () => {
  const parsed = parseUsageSnapshot({ plan_type: 'pro', rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 2000000000 }, secondary_window: { remaining_percent: '58', window_seconds: 604800, resets_in_seconds: 60 } }, code_review_rate_limit: { primary_window: { usedPercent: 9, windowDurationMins: 1440, resetsAt: '2030-01-01T00:00:00Z' } }, additional_rate_limits: [{ limit_name: 'Deep review', metered_feature: 'codex_review_deep', rate_limit: { primary_window: { used_percent: 12, window_seconds: 3600 } } }] }, 1000000n);
  expect(parsed.rateLimits?.limitId).toBe('codex'); expect(parsed.rateLimits?.planType).toBe('pro'); expect(parsed.rateLimits?.primary?.usedPercent).toBe(25);
  // Rust's internal window_duration_mins is u64; the value/direction stay 300.
  expect(parsed.rateLimits?.primary?.windowDurationMins).toBe(300n); expect(parsed.rateLimits?.secondary?.usedPercent).toBe(42);
  expect(parsed.rateLimitsByLimitId).toHaveProperty('codex_review'); expect(parsed.rateLimitsByLimitId?.codex_review_deep?.limitName).toBe('Deep review');
});
it('usage_snapshot_uses_oauth_headers_over_http', async () => {
  let sawAuth = false;
  const http = await server((req, res) => { sawAuth = req.url === '/wham/usage' && req.headers.authorization === 'Bearer access-secret' && req.headers['chatgpt-account-id'] === 'account-1'; json(res, { plan_type: 'plus', rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 2000000000 } } }); });
  try { const store = new MemoryStore(); store.value = stored(); const auth = await manager(store, http.base); const usage = await auth.usageSnapshot(); expect(sawAuth).toBe(true); expect(usage.rateLimits?.primary?.usedPercent).toBe(12); }
  finally { await http.close(); }
});
it('usage_second_unauthorized_marks_the_refreshed_generation', async () => {
  let count = 0;
  const http = await server((req, res) => { if (req.url === '/oauth/token') json(res, tokenResponse('account-1', 'refreshed-access', 'refreshed-refresh')); else if (req.url === '/wham/usage') { count++; json(res, { error: { code: 'invalid_token' } }, 401); } else json(res, {}, 404); });
  try { const store = new MemoryStore(); store.value = stored('account-1', 'old-access'); const auth = await manager(store, http.base);
    await expect(auth.usageSnapshot()).rejects.toThrow(expect.objectContaining({ kind: 'OAuthRejected', detail: expect.objectContaining({ stage: 'usage', reauthRequired: true }) }));
    expect(count).toBe(2); expect((await auth.status()).generation).toBe(2); expect((await auth.status()).phase).toBe('reauthentication_required');
  } finally { await http.close(); }
});
it('usage_snapshot_rejects_oversized_body', async () => {
  const http = await server((_req, res) => { res.end(Buffer.alloc(512 * 1024 + 1, 'x')); });
  try { const store = new MemoryStore(); store.value = stored(); const auth = await manager(store, http.base); await expect(auth.usageSnapshot()).rejects.toThrow(expect.objectContaining({ kind: 'ResponseTooLarge', detail: expect.objectContaining({ stage: 'usage' }) })); }
  finally { await http.close(); }
});
