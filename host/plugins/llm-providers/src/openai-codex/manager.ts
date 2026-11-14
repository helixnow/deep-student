import type { CodexAuthPhase, CodexAuthState, CodexAuthErrorDto, CodexLoginKind, JsonValue } from '../../api.ts';
import type { CodexUsageState } from './usage-state.ts';
import { decodeUtf8Lossy, decodeUtf8Strict, rustTrim, Utf8DecodeError } from '../../../../platform/util/portable.ts';
import { toBase64, utf8Decode } from '../../../../platform/crypto/encoding.ts';
import { field, parseJsonExact, string } from '../json.ts';
import { CodexAuthError } from './error.ts';
import { CodexEndpointConfig, buildCodexRequestHeaders } from './protocol.ts';
import { StoredCodexSession, CodexRequestAuth, redactAccountId, type BrowserLoginStart, type DeviceLoginStart } from './types.ts';
import type { CodexCredentialStore } from './store.ts';
import { generatePkce, buildAuthorizationUrl, extractAccountId, extractTokenMetadata, expiryFromResponse, mergeRefreshSession, validateRefreshIdentity,
  oauthRejection, oauthErrorCode, sanitizeOauthCode, requiredStringAlias, valueAsU64, clampBig, parseUsageSnapshot, decodeTokenResponse, type OAuthTokenResponse } from './manager-values.ts';
export { generatePkce, buildAuthorizationUrl, parseJwtClaims, accountIdFromClaims, mergeRefreshSession, validateRefreshIdentity, oauthRejection, requiredStringAlias, parseUsageSnapshot } from './manager-values.ts';

export interface ActiveAttempt {
  id: string;
  kind: CodexLoginKind;
  expiresAtUnixMs: number;
  authorizationUrl: string | null;
  verificationUrl: string | null;
  userCode: string | null;
  pollIntervalSeconds: number | null;
  previousPhase: CodexAuthPhase | null;
  cancel: AbortController;
}

/** 一次 OAuth HTTP 响应：状态、头与按上限读取的正文。`discard()` 中止连接并丢弃正文。 */
export interface CodexHttpResponse {
  readonly status: number;
  readonly headers: Headers;
  body(): Promise<Uint8Array>;
  discard(): void;
}

/** 回环回调服务收到的请求。 */
export interface OAuthCallbackRequest {
  readonly method: string;
  /** 原始请求行里的路径（浏览器回调携带 query）。 */
  readonly url: string;
}

/** 回环回调服务的应答；正文是给浏览器看的 HTML。 */
export interface OAuthCallbackReply {
  readonly status: number;
  readonly body: string;
}

/**
 * OAuth 浏览器登录的本地回环回调服务。桌面由 `node:http` 实现（插件入口注入）；
 * 移动端没有监听套接字，缺省时浏览器登录以 `CallbackBind` 失败，设备码流程不受影响。
 */
export type OAuthCallbackServerFactory = (
  ports: readonly number[],
  handler: (request: OAuthCallbackRequest) => Promise<OAuthCallbackReply>,
) => Promise<{ readonly port: number; close(): void }>;

/** 运行时能力注入：HTTP 传输与回调监听。缺省只用 Web 标准 API（移动端同一份实现）。 */
export interface CodexAuthCapabilities {
  /** 缺省全局 `fetch`（桌面与移动端都用 Host 提供的实现）。 */
  readonly fetch?: typeof fetch;
  readonly callbackServer?: OAuthCallbackServerFactory;
}

interface RuntimeState {
  session: StoredCodexSession | null;
  generation: number;
  phase: CodexAuthPhase;
  activeAttempt: ActiveAttempt | null;
  lastError: CodexAuthErrorDto | null;
  usage: { authenticatedRequests: number; refreshAttempts: number; refreshSuccesses: number; refreshFailures: number; unauthorizedRefreshes: number; lastRefreshAtUnixMs: number | null };
}
/** FIFO mutex corresponding to refresh_gate. State-only sections have no await. */
class RefreshGate {
  _tail: Promise<void> = Promise.resolve();
  async acquire(): Promise<() => void> {
    const previous = this._tail;
    let release!: () => void;
    this._tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    return release;
  }
}
const MAX_OAUTH_RESPONSE_BODY_BYTES = 512 * 1024;
const increment = (n: number) => Math.min(Number(18446744073709551615n), n + 1);
function basePhase(state: RuntimeState): CodexAuthPhase { return state.session ? 'authenticated' : 'signed_out'; }
function requiresReauthentication(state: RuntimeState): boolean { return state.phase === 'reauthentication_required' || state.activeAttempt?.previousPhase === 'reauthentication_required'; }
function stablePhase(state: RuntimeState, phase: CodexAuthPhase): void {
  if (state.activeAttempt) { state.activeAttempt.previousPhase = phase; state.phase = 'authorizing'; }
  else state.phase = phase;
}
function restorePhase(state: RuntimeState, previous: CodexAuthPhase | null): CodexAuthPhase {
  if (previous === 'reauthentication_required') return previous;
  if (previous === 'error' && !state.session) return previous;
  return basePhase(state);
}
function codexError(error: unknown, kind: 'CredentialStore' | 'Network', stage?: string): CodexAuthError {
  return error instanceof CodexAuthError ? error : new CodexAuthError(kind, { stage });
}
/** manager.rs Value `from_slice`: never repair malformed UTF-8 with U+FFFD. */
function parseResponseValue(bytes: Uint8Array): JsonValue | undefined {
  try { return parseJsonExact(decodeUtf8Strict(bytes)); }
  catch (error) {
    if (error instanceof Utf8DecodeError) return undefined;
    throw error;
  }
}
/** `tokio::time::sleep` 的可移植版本：中止时以 `AbortError` 拒绝。 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = (): void => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
function cancelled<T>(signal: AbortSignal, operation: Promise<T>): Promise<T> {
  if (signal.aborted) { void operation.catch(error => codexError(error, 'Network')); return Promise.reject(new CodexAuthError('Cancelled')); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new CodexAuthError('Cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}
function concatBytes(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

/** 浏览器登录进行中的回调频道：投递一次结果，其余请求按成功/失败应答。 */
interface BrowserLoginChannel {
  readonly server: { readonly port: number; close(): void };
  readonly callback: Promise<{ code?: string; denied?: string; reply: (success: boolean) => void }>;
  readonly extraReplies: Set<(success: boolean) => void>;
  readonly channel: { delivered: boolean; closed: boolean };
}

/** openai_codex/manager.rs. Async operations continue when a caller stops awaiting. */
export class CodexAuthManager {
  _store: CodexCredentialStore;
  _endpoints: CodexEndpointConfig;
  _version: string;
  _state: RuntimeState;
  _refreshGate = new RefreshGate();
  _fetch: typeof fetch;
  _callbackServer: OAuthCallbackServerFactory | undefined;
  constructor(store: CodexCredentialStore, version: string, endpoints: CodexEndpointConfig, session: StoredCodexSession | null,
    error: CodexAuthError | null = null, capabilities: CodexAuthCapabilities = {}) {
    this._store = store; this._version = version; this._endpoints = endpoints;
    this._fetch = capabilities.fetch ?? ((input, init) => fetch(input, init));
    this._callbackServer = capabilities.callbackServer;
    this._state = { session, generation: 1, phase: error ? 'error' : session ? 'authenticated' : 'signed_out', activeAttempt: null,
      lastError: error?.toDto() ?? null, usage: { authenticatedRequests: 0, refreshAttempts: 0, refreshSuccesses: 0, refreshFailures: 0, unauthorizedRefreshes: 0, lastRefreshAtUnixMs: null } };
  }
  static async create(store: CodexCredentialStore, version: string, endpoints = new CodexEndpointConfig(),
    capabilities: CodexAuthCapabilities = {}): Promise<CodexAuthManager> {
    try { return new CodexAuthManager(store, version, endpoints, await store.load(), null, capabilities); }
    catch (error) { return new CodexAuthManager(store, version, endpoints, null, codexError(error, 'CredentialStore'), capabilities); }
  }  async status(): Promise<CodexAuthState> {
    const state = this._state, session = state.session, attempt = state.activeAttempt;
    return { phase: state.phase, hasUsableSession: session !== null && !requiresReauthentication(state),
      accountHint: session && rustTrim(session.accountId) !== '' ? redactAccountId(session.accountId) : null,
      email: session?.email ?? null, planType: session?.planType ?? null, isFedramp: session?.isFedramp ?? false,
      expiresAtUnixMs: attempt !== null ? BigInt(attempt.expiresAtUnixMs) : session?.expiresAtUnixMs ?? null, generation: state.generation,
      activeLoginKind: attempt?.kind ?? null, activeAttemptId: attempt?.id ?? null, authorizationUrl: attempt?.authorizationUrl ?? null,
      verificationUrl: attempt?.verificationUrl ?? null, userCode: attempt?.userCode ?? null, pollIntervalSeconds: attempt?.pollIntervalSeconds ?? null,
      lastError: state.lastError === null ? null : { ...state.lastError } };
  }
  responsesEndpoint(): string { return this._endpoints.responsesUrl; }
  async markReauthenticationRequired(observedGeneration: number): Promise<boolean> {
    return this.markReauthenticationRequiredWithError(observedGeneration, new CodexAuthError('ReauthenticationRequired'));
  }
  markReauthenticationRequiredWithError(observedGeneration: number, error: CodexAuthError): boolean {
    if (this._state.generation !== observedGeneration) return false;
    this._state.lastError = error.toDto(); stablePhase(this._state, 'reauthentication_required'); return true;
  }
  async usageSnapshot(): Promise<CodexUsageState> {
    let auth = await this.requestAuth(false);
    let response = await this.fetchUsage(auth);
    if (response.status === 401) {
      response.discard();
      auth = await this.refreshAfterUnauthorized(auth.generation()); response = await this.fetchUsage(auth);
    }
    const status = response.status, bytes = await response.body();
    const body = parseResponseValue(bytes);
    if (status >= 200 && status < 300 && body === undefined) throw new CodexAuthError('MalformedResponse', { field: 'usage response' });
    if (status === 401) {
      const error = new CodexAuthError('OAuthRejected', { stage: 'usage', code: 'unauthorized_after_refresh', permanent: true, reauthRequired: true });
      this.markReauthenticationRequiredWithError(auth.generation(), error); throw error;
    }
    if (status < 200 || status >= 300) throw oauthRejection('usage', status, body ?? null);
    return parseUsageSnapshot(body!, BigInt(Date.now()));
  }
  fetchUsage(auth: CodexRequestAuth): Promise<CodexHttpResponse> {
    return this.request(this._endpoints.usageUrl, 'GET', buildCodexRequestHeaders(auth, `usage-${globalThis.crypto.randomUUID()}`, this._version), undefined, 'usage');
  }
  async requestAuth(forceRefresh = false): Promise<CodexRequestAuth> {
    const state = this._state;
    if (requiresReauthentication(state)) throw new CodexAuthError('ReauthenticationRequired');
    if (!state.session) throw new CodexAuthError('SignedOut');
    const generation = state.generation, expires = state.session.expiresAtUnixMs;
    if (forceRefresh || expires <= BigInt(Date.now()) + 300000n) {
      try { return await this.refreshInternal(generation, forceRefresh, false); }
      catch (error) {
        if (!(error instanceof CodexAuthError) || forceRefresh || error.class() !== 'transient' || expires <= BigInt(Date.now()) + 30000n) throw error;
      }
    }
    if (requiresReauthentication(state)) throw new CodexAuthError('ReauthenticationRequired');
    if (!state.session) throw new CodexAuthError('SignedOut');
    if (state.session.expiresAtUnixMs <= BigInt(Date.now())) throw new CodexAuthError('ReauthenticationRequired');
    state.usage.authenticatedRequests = increment(state.usage.authenticatedRequests);
    return new CodexRequestAuth(state.session, state.generation);
  }
  async refreshAfterUnauthorized(observedGeneration: number): Promise<CodexRequestAuth> {
    this._state.usage.unauthorizedRefreshes = increment(this._state.usage.unauthorizedRefreshes);
    return this.refreshInternal(observedGeneration, true, true);
  }
  async refreshInternal(observedGeneration: number, force: boolean, _fromUnauthorized: boolean): Promise<CodexRequestAuth> {
    const release = await this._refreshGate.acquire();
    try {
      const state = this._state;
      if (requiresReauthentication(state)) throw new CodexAuthError('ReauthenticationRequired');
      if (!state.session) throw new CodexAuthError('SignedOut');
      const current = state.session.clone();
      if (state.generation !== observedGeneration || !force && current.expiresAtUnixMs > BigInt(Date.now()) + 300000n) {
        state.usage.authenticatedRequests = increment(state.usage.authenticatedRequests);
        return new CodexRequestAuth(current, state.generation);
      }
      if (!state.activeAttempt) state.phase = 'refreshing';
      state.usage.refreshAttempts = increment(state.usage.refreshAttempts);
      let refreshed: StoredCodexSession;
      try {
        const tokens = await this.tokenRequest('refresh', [['grant_type', 'refresh_token'], ['refresh_token', current.refreshToken], ['client_id', this._endpoints.clientId]]);
        refreshed = mergeRefreshSession(current, tokens, BigInt(Date.now()));
      } catch (error) { const mapped = codexError(error, 'Network', 'refresh_task'); this.recordRefreshError(observedGeneration, mapped, false); throw mapped; }
      if (state.generation !== observedGeneration) {
        if (!state.session) throw new CodexAuthError('SignedOut');
        return new CodexRequestAuth(state.session, state.generation);
      }
      try {
        if (!state.session) throw new CodexAuthError('SignedOut');
        validateRefreshIdentity(state.session, current, refreshed);
      } catch (error) { const mapped = codexError(error, 'CredentialStore'); this.recordRefreshError(observedGeneration, mapped, false); throw mapped; }
      try { await this._store.save(refreshed.clone()); }
      catch (error) { const mapped = codexError(error, 'CredentialStore'); this.recordRefreshError(observedGeneration, mapped, true); throw mapped; }
      if (state.generation !== observedGeneration) {
        if (!state.session) throw new CodexAuthError('SignedOut');
        return new CodexRequestAuth(state.session, state.generation);
      }
      state.session = refreshed; state.generation = increment(state.generation); stablePhase(state, 'authenticated'); state.lastError = null;
      state.usage.refreshSuccesses = increment(state.usage.refreshSuccesses); state.usage.lastRefreshAtUnixMs = Date.now();
      state.usage.authenticatedRequests = increment(state.usage.authenticatedRequests);
      return new CodexRequestAuth(refreshed, state.generation);
    } finally { release(); }
  }
  recordRefreshError(generation: number, error: CodexAuthError, persistenceUncertain: boolean): void {
    const state = this._state; state.usage.refreshFailures = increment(state.usage.refreshFailures);
    if (state.generation !== generation) return;
    state.lastError = error.toDto();
    stablePhase(state, persistenceUncertain || error.class() === 'reauthentication_required' ? 'reauthentication_required' : state.session ? 'authenticated' : 'error');
  }
  sessionFromInitialTokens(tokens: OAuthTokenResponse): StoredCodexSession {
    const refreshToken = rustTrim(tokens.refresh_token ?? '');
    if (!refreshToken) throw new CodexAuthError('MalformedResponse', { field: 'refresh_token' });
    const accountId = extractAccountId(tokens);
    if (!accountId) throw new CodexAuthError('MissingAccountId');
    const metadata = extractTokenMetadata(tokens), now = BigInt(Date.now());
    return new StoredCodexSession({ schemaVersion: 1, accessToken: tokens.access_token, refreshToken, idToken: tokens.id_token,
      expiresAtUnixMs: expiryFromResponse(now, tokens.expires_in), accountId, email: metadata.email ?? null,
      planType: metadata.planType ?? null, isFedramp: metadata.isFedramp ?? false, lastRefreshAt: now });
  }
  installAttempt(attempt: ActiveAttempt): void {
    if (this._state.activeAttempt) throw new CodexAuthError('LoginBusy');
    attempt.previousPhase = this._state.phase; this._state.phase = 'authorizing'; this._state.lastError = null; this._state.activeAttempt = attempt;
  }
  async persistAndInstall(attemptId: string, session: StoredCodexSession): Promise<void> {
    try {
      const release = await this._refreshGate.acquire();
      try {
        if (this._state.activeAttempt?.id !== attemptId) throw new CodexAuthError('Cancelled');
        await this._store.save(session.clone());
        this._state.session = session; this._state.activeAttempt = null; this._state.generation = increment(this._state.generation);
        this._state.phase = 'authenticated'; this._state.lastError = null;
      } finally { release(); }
    } catch (error) {
      const mapped = codexError(error, 'CredentialStore'); this.finishAttemptError(attemptId, mapped); throw mapped;
    }
  }
  finishAttemptSuccess(attemptId: string): void {
    if (this._state.activeAttempt?.id !== attemptId) return;
    this._state.activeAttempt = null; this._state.phase = basePhase(this._state); this._state.lastError = null;
  }
  finishAttemptError(attemptId: string, error: CodexAuthError): void {
    const state = this._state;
    if (state.activeAttempt?.id !== attemptId) return;
    const previous = state.activeAttempt.previousPhase; state.activeAttempt = null; state.lastError = error.toDto();
    state.phase = error.class() === 'reauthentication_required' ? 'reauthentication_required' : state.phase === 'authorizing' ? restorePhase(state, previous) : basePhase(state);
  }
  async cancelLogin(attemptId: string): Promise<void> {
    const release = await this._refreshGate.acquire();
    try {
      const state = this._state, attempt = state.activeAttempt;
      if (!attempt || attempt.id !== attemptId) throw new CodexAuthError('AttemptNotFound');
      state.activeAttempt = null;
      if (state.phase === 'authorizing') state.phase = restorePhase(state, attempt.previousPhase);
      state.lastError = null; attempt.cancel.abort();
    } finally { release(); }
  }
  logout(): Promise<void> { return this.logoutTransaction(); }
  async logoutTransaction(): Promise<void> {
    const release = await this._refreshGate.acquire();
    try {
      const state = this._state, attempt = state.activeAttempt, refreshToken = state.session?.refreshToken;
      state.activeAttempt = null;
      if (attempt && state.phase === 'authorizing') state.phase = restorePhase(state, attempt.previousPhase);
      attempt?.cancel.abort();
      await this._store.delete();
      const late = state.activeAttempt as ActiveAttempt | null;
      state.activeAttempt = null; state.session = null; state.generation = increment(state.generation); state.phase = 'signed_out'; state.lastError = null;
      late?.cancel.abort();
      if (refreshToken !== undefined) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
        try {
          const response = await this.request(this._endpoints.revokeUrl, 'POST', { 'content-type': 'application/json' },
            JSON.stringify({ token: refreshToken, token_type_hint: 'refresh_token', client_id: this._endpoints.clientId }), 'revoke', controller.signal);
          response.discard();
        } catch (error) {
          // Rust discards revocation errors after local deletion has committed.
          if (!(error instanceof CodexAuthError)) throw error;
        } finally { clearTimeout(timer); }
      }
    } finally { release(); }
  }
  async startDeviceLogin(): Promise<DeviceLoginStart> {
    if (this._state.activeAttempt) throw new CodexAuthError('LoginBusy');
    const id = globalThis.crypto.randomUUID(), cancel = new AbortController(); let expires = Date.now() + 900000;
    this.installAttempt({ id, kind: 'device', expiresAtUnixMs: expires, authorizationUrl: null, verificationUrl: this._endpoints.deviceVerificationUrl,
      userCode: null, pollIntervalSeconds: null, previousPhase: null, cancel });
    let result: { deviceAuthId: string; userCode: string; interval: number; expiresIn: number | undefined };
    try { result = await cancelled(cancel.signal, this.requestDeviceCode(cancel.signal)); }
    catch (error) { const mapped = cancel.signal.aborted ? new CodexAuthError('Cancelled') : codexError(error, 'Network', 'device_authorization'); this.finishAttemptError(id, mapped); throw mapped; }
    if (result.expiresIn !== undefined) expires = Date.now() + Math.max(60, Math.min(900, result.expiresIn)) * 1000;
    const attempt = this._state.activeAttempt as ActiveAttempt | null;
    if (!attempt || attempt.id !== id || cancel.signal.aborted) throw new CodexAuthError('Cancelled');
    attempt.expiresAtUnixMs = expires; attempt.userCode = result.userCode; attempt.pollIntervalSeconds = result.interval;
    void this.runDeviceLogin(id, result.deviceAuthId, result.userCode, result.interval, expires, cancel);
    return { attemptId: id, verificationUrl: this._endpoints.deviceVerificationUrl, userCode: result.userCode, expiresAtUnixMs: expires, pollIntervalSeconds: result.interval };
  }
  async requestDeviceCode(signal: AbortSignal) {
    const response = await this.request(this._endpoints.deviceUserCodeUrl, 'POST', { 'user-agent': `deep-student/${this._version}`, 'content-type': 'application/json' }, JSON.stringify({ client_id: this._endpoints.clientId }), 'device_authorization', signal);
    const status = response.status, bytes = await response.body();
    const body = parseResponseValue(bytes);
    if (status < 200 || status >= 300) throw oauthRejection('device_authorization', status, body ?? null);
    if (body === undefined) throw new CodexAuthError('MalformedResponse', { field: 'device authorization response' });
    return { deviceAuthId: requiredStringAlias(body, ['device_auth_id'], 'device_auth_id'), userCode: requiredStringAlias(body, ['user_code', 'usercode'], 'user_code'),
      // manager.rs:746-751,425: u64 values clamped before narrowing.
      interval: Number(clampBig(valueAsU64(body, 'interval') ?? 5n, 1n, 60n)),
      expiresIn: ((seconds: bigint | undefined) => seconds === undefined ? undefined : Number(clampBig(seconds, 60n, 900n)))(valueAsU64(body, 'expires_in')) };
  }
  async runDeviceLogin(id: string, deviceAuthId: string, userCode: string, interval: number, expires: number, cancel: AbortController): Promise<void> {
    try {
      let failures = 0;
      while (true) {
        if (Date.now() >= expires) throw new CodexAuthError('Timeout');
        try { await delay((interval + 3) * 1000, cancel.signal); }
        catch (error) { if (cancel.signal.aborted) throw new CodexAuthError('Cancelled'); throw error; }
        try {
          // Rust does not cancel the in-flight poll itself; cancellation is checked on exchange/sleep.
          const response = await this.request(this._endpoints.deviceTokenUrl, 'POST', { 'user-agent': `deep-student/${this._version}`, 'content-type': 'application/json' }, JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }), 'device_poll');
          const status = response.status, bytes = await response.body(), body = parseResponseValue(bytes);
          if (status >= 200 && status < 300) {
            if (body === undefined) throw new CodexAuthError('MalformedResponse', { field: 'device poll response' });
            const tokens = await cancelled(cancel.signal, this.exchangeCode(requiredStringAlias(body, ['authorization_code'], 'authorization_code'), this._endpoints.deviceRedirectUrl,
              requiredStringAlias(body, ['code_verifier'], 'code_verifier'), cancel.signal));
            await this.persistAndInstall(id, this.sessionFromInitialTokens(tokens)); break;
          }
          const code = oauthErrorCode(body ?? null);
          if (status === 403 || status === 404 || code === 'authorization_pending' || code === 'slow_down') { failures = 0; continue; }
          throw oauthRejection('device_poll', status, body ?? null);
        } catch (error) {
          const mapped = codexError(error, 'Network', 'device_poll');
          if (mapped.class() === 'transient' && ++failures < 3) continue;
          throw mapped;
        }
      }
      this.finishAttemptSuccess(id);
    } catch (error) { this.finishAttemptError(id, codexError(error, 'Network', 'device_poll')); }
  }
  async startBrowserLogin(): Promise<BrowserLoginStart> {
    if (this._state.activeAttempt) throw new CodexAuthError('LoginBusy');
    if (this._callbackServer === undefined) throw new CodexAuthError('CallbackBind');
    const channel = { delivered: false, closed: false };
    let deliver!: (payload: { code?: string; denied?: string; reply: (success: boolean) => void }) => void;
    const callback = new Promise<{ code?: string; denied?: string; reply: (success: boolean) => void }>(resolve => { deliver = resolve; });
    const extraReplies = new Set<(success: boolean) => void>();
    let expectedState = '';
    const handler = (request: OAuthCallbackRequest): Promise<OAuthCallbackReply> => new Promise<OAuthCallbackReply>((resolve) => {
      const url = new URL(request.url, 'http://localhost');
      if (request.method !== 'GET' || url.pathname !== '/auth/callback') { resolve(htmlResponse(404, false)); return; }
      const params = Object.fromEntries(url.searchParams);
      if (params.state !== expectedState) { resolve(htmlResponse(400, false)); return; }
      const denied = params.error === undefined ? undefined : sanitizeOauthCode(params.error), code = params.code;
      if (denied === undefined && !code) { resolve(htmlResponse(400, false)); return; }
      if (channel.closed) { resolve(htmlResponse(410, false)); return; }
      const timer = setTimeout(() => reply(false), 90000);
      const reply = (success: boolean) => { clearTimeout(timer); extraReplies.delete(reply); resolve(htmlResponse(success ? 200 : 400, success)); };
      if (!channel.delivered) { channel.delivered = true; deliver({ code, denied, reply }); }
      else extraReplies.add(reply);
    });
    let server: { readonly port: number; close(): void };
    try { server = await this._callbackServer([1455, 1457], handler); }
    catch { throw new CodexAuthError('CallbackBind'); }
    const redirectUri = `http://localhost:${server.port}/auth/callback`, pkce = generatePkce();
    const state = toBase64(globalThis.crypto.getRandomValues(new Uint8Array(32)), { alphabet: 'url', padding: false });
    expectedState = state;
    const id = globalThis.crypto.randomUUID(), expiresAtUnixMs = Date.now() + 300000, cancel = new AbortController();
    const authorizationUrl = buildAuthorizationUrl(this._endpoints, redirectUri, pkce.challenge, state);
    try { this.installAttempt({ id, kind: 'browser', expiresAtUnixMs, authorizationUrl, verificationUrl: null, userCode: null, pollIntervalSeconds: null, previousPhase: null, cancel }); }
    catch (error) { server.close(); throw error; }
    void this.runBrowserLogin({ server, callback, extraReplies, channel }, id, redirectUri, pkce.verifier, cancel);
    return { attemptId: id, authorizationUrl, redirectUri, expiresAtUnixMs };
  }
  async runBrowserLogin(login: BrowserLoginChannel, id: string, redirectUri: string, verifier: string, cancel: AbortController): Promise<void> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 300000);
    let reply: ((success: boolean) => void) | undefined;
    try {
      const payload = await cancelled(cancel.signal, cancelled(timeout.signal, login.callback).catch(error => { if (timeout.signal.aborted) throw new CodexAuthError('Timeout'); throw error; }));
      reply = payload.reply;
      if (payload.denied !== undefined) { reply(false); throw new CodexAuthError('AuthorizationDenied', { code: payload.denied }); }
      const tokens = await cancelled(cancel.signal, this.exchangeCode(payload.code!, redirectUri, verifier, cancel.signal));
      await this.persistAndInstall(id, this.sessionFromInitialTokens(tokens)); reply(true); this.finishAttemptSuccess(id);
    } catch (error) { reply?.(false); this.finishAttemptError(id, codexError(error, 'Network', 'token_exchange')); }
    finally {
      clearTimeout(timer); login.channel.closed = true; cancel.abort(); login.server.close();
      for (const reply of login.extraReplies) reply(false);
    }
  }
  exchangeCode(code: string, redirectUri: string, verifier: string, signal?: AbortSignal): Promise<OAuthTokenResponse> {
    return this.tokenRequest('token_exchange', [['grant_type', 'authorization_code'], ['code', code], ['redirect_uri', redirectUri], ['client_id', this._endpoints.clientId], ['code_verifier', verifier]], signal);
  }
  async tokenRequest(stage: string, params: [string, string][], signal?: AbortSignal): Promise<OAuthTokenResponse> {
    const response = await this.request(this._endpoints.tokenUrl, 'POST', { 'user-agent': `deep-student/${this._version}`, 'content-type': 'application/x-www-form-urlencoded' }, new URLSearchParams(params).toString(), stage, signal);
    const status = response.status, bytes = await response.body();
    if (status < 200 || status >= 300) throw oauthRejection(stage, status, parseResponseValue(bytes) ?? null);
    // Successful OAuthTokenResponse is typed, not Value: its IgnoredAny byte/string
    // rules must be handled by the pending typed reader, not blanket UTF-8 rejection.
    const body = parseJsonExact(decodeUtf8Lossy(bytes));
    return decodeTokenResponse(body);
  }
  request(url: string, method: string, headers: Record<string, string>, body: string | undefined, stage: string, signal?: AbortSignal): Promise<CodexHttpResponse> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    const timer = setTimeout(abort, 60000);
    const external = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', external); };
    signal?.addEventListener('abort', external, { once: true });
    const settle = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', external); };
    return this._fetch(url, { method, headers, body: body ?? null, signal: controller.signal, redirect: 'manual' }).then(response => ({
      status: response.status,
      headers: response.headers,
      body: async (): Promise<Uint8Array> => {
        try { return await readResponseBody(response, controller, stage); }
        finally { settle(); }
      },
      discard: () => { settle(); controller.abort(); },
    }), () => { settle(); throw new CodexAuthError('Network', { stage }); });
  }
  dispose(): void { this._state.activeAttempt?.cancel.abort(); }
}
async function readResponseBody(response: Response, controller: AbortController, stage: string): Promise<Uint8Array> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_OAUTH_RESPONSE_BODY_BYTES) {
    controller.abort();
    throw new CodexAuthError('ResponseTooLarge', { stage });
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      size += bytes.length;
      if (size > MAX_OAUTH_RESPONSE_BODY_BYTES) {
        controller.abort();
        throw new CodexAuthError('ResponseTooLarge', { stage });
      }
      chunks.push(bytes);
    }
  } catch (error) {
    controller.abort();
    throw codexError(error, 'Network', stage);
  }
  return concatBytes(chunks, size);
}
function htmlResponse(status: number, success: boolean): OAuthCallbackReply {
  const message = success ? 'Authorization complete. You can return to Deep Student.' : 'Authorization could not be completed. Return to Deep Student for details.';
  return { status, body: `<!doctype html><meta charset="utf-8"><title>Deep Student</title><p>${message}</p>` };
}
