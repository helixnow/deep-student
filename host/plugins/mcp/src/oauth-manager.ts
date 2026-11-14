// Port of dstu-mcp/src/mcp/auth.rs + oauth_callback.rs.
// OAuth 2.1 PKCE (S256), RFC 8414 discovery, RFC 7591 DCR, local 127.0.0.1 callback
// and SecureStore persistence. HTTP/open-browser are injectable for hermetic tests.

import { toRfc3339Opts } from '../../../platform/time/index.ts';
import { isLoopbackHost } from '../../../platform/net-policy/index.ts';
import { epochNanosFromDate } from './time.ts';
import { createServer, type Server } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { SecureStore } from '../../../platform/secrets/api.ts';
import { McpAuthError, normalizeResourceOrigin, oauthTokenNeedsRefresh, isOAuthTokenExpired, type OAuth2Token } from './auth-token.ts';

export const OAUTH_CALLBACK_TIMEOUT_MS = 120_000;
const OAUTH_HTTP_TIMEOUT_MS = 10_000;
const DISCOVERY_MAX_DEPTH = 4;
const DISCOVERY_MAX_BYTES = 1024 * 1024;
const TOKEN_KEY_PREFIX = 'internal.oauth.mcp.';

export interface OAuthEndpoints {
  authorization: string;
  token: string;
  revocation: string | null;
  userinfo: string | null;
  registration: string | null;
}

export interface PersistedOAuthSession {
  token: OAuth2Token;
  client_id: string;
  client_secret: string | null;
  auth_url: string;
  token_url: string;
  redirect_uri: string;
  scopes: string[];
  resource_origin: string;
}

export interface StartOAuthParams {
  serverId: string;
  resourceUrl: string;
  clientId: string | null;
  clientSecret: string | null;
  scopes: string[];
  openBrowser: boolean;
  timeoutMs?: number;
}

export interface StartOAuthOptions {
  /** Cancels the flow at once (plugin stop). Rust has no counterpart: the process just exits. */
  signal?: AbortSignal;
}

export interface StartOAuthOutcome {
  server_id: string;
  access_token: string;
  token_type: string;
  expires_at: string | null;
  authorization_url: string;
  redirect_uri: string;
}

export type OAuthCallbackResult =
  | { kind: 'code'; code: string; state: string }
  | { kind: 'denied'; error: string }
  | { kind: 'state_mismatch' }
  | { kind: 'timeout' }
  | { kind: 'cancelled' };

export interface OAuthRuntime {
  fetch: typeof fetch;
  openUrl(url: string): Promise<void>;
  secureStore: SecureStore;
  now(): Date;
  callbackTimeoutMs?: number;
  /** Rust `warn!`/`error!`; logging never alters the OAuth flow. */
  log?: (level: 'warn' | 'error', message: string) => void;
}

function authError(message: string): McpAuthError {
  return new McpAuthError(message);
}

const CANCELLED_MESSAGE = 'OAuth authorization cancelled';

function httpSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
}

/**
 * One startOAuth run. `cancelled` is the Rust CancellationToken that `cancel_mcp_oauth`
 * flips and only the callback wait observes; `stop` aborts every step at once.
 */
interface OAuthFlow {
  cancelled: boolean;
  readonly stop: AbortController;
  listener: CallbackListener | null;
}

function oauthTimestamp(value: Date): string {
  return toRfc3339Opts(epochNanosFromDate(value), 'AutoSi', true);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateSecureOauthUrl(raw: string, label: string): URL {
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch (error) { throw authError(`Invalid ${label}: ${errorText(error)}`); }
  if (parsed.hostname === '') throw authError(`${label} is missing a host`);
  if (parsed.username !== '' || parsed.password !== '') throw authError(`${label} must not contain userinfo`);
  const scheme = parsed.protocol.endsWith(':') ? parsed.protocol.slice(0, -1) : parsed.protocol;
  if (scheme !== 'https' && !(scheme === 'http' && isLoopbackHost(parsed.hostname))) {
    throw authError('OAuth URLs must use HTTPS (HTTP is allowed only for loopback hosts)');
  }
  return parsed;
}

function normalizeResourceUrl(raw: string): URL {
  const candidate = raw.includes('://') ? raw.trim() : `https://${raw.trim()}`;
  return validateSecureOauthUrl(candidate, 'MCP OAuth resource URL');
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** serde_json `Value::get(key)`: None unless the value is an object holding the key. */
function jsonGet(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.prototype.hasOwnProperty.call(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

function tokenFromResponse(response: unknown, now: Date): OAuth2Token {
  const json = {
    access_token: jsonGet(response, 'access_token'), expires_in: jsonGet(response, 'expires_in'),
    token_type: jsonGet(response, 'token_type'), refresh_token: jsonGet(response, 'refresh_token'),
    scope: jsonGet(response, 'scope'),
  };
  const accessToken = typeof json.access_token === 'string' ? json.access_token : '';
  if (accessToken === '') throw authError('Token response missing access_token');
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : null;
  return {
    accessToken,
    tokenType: typeof json.token_type === 'string' ? json.token_type : 'Bearer',
    expiresAt: expiresIn === null ? null : new Date(now.getTime() + expiresIn * 1000),
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
    scopes: typeof json.scope === 'string' && json.scope !== ''
      ? json.scope.split(/\s+/u).filter(scope => scope !== '') : [],
  };
}

function persistedToToken(session: PersistedOAuthSession): OAuth2Token {
  return {
    accessToken: session.token.accessToken,
    tokenType: session.token.tokenType,
    expiresAt: session.token.expiresAt,
    refreshToken: session.token.refreshToken,
    scopes: [...session.token.scopes],
  };
}

function optionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string';
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function parseSession(raw: string): PersistedOAuthSession | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    const token = value.token;
    if (token === null || typeof token !== 'object' || Array.isArray(token)) return null;
    const tokenObject = token as Record<string, unknown>;
    if (typeof tokenObject.access_token !== 'string' || typeof tokenObject.token_type !== 'string'
      || !stringArray(tokenObject.scopes) || !optionalString(tokenObject.refresh_token)
      || !optionalString(tokenObject.expires_at)) return null;
    if (typeof value.client_id !== 'string' || typeof value.auth_url !== 'string'
      || typeof value.token_url !== 'string' || typeof value.redirect_uri !== 'string'
      || !stringArray(value.scopes) || !optionalString(value.client_secret)
      || (value.resource_origin !== undefined && typeof value.resource_origin !== 'string')) return null;
    const expiresRaw = tokenObject.expires_at;
    const expiresAt = typeof expiresRaw === 'string' ? new Date(expiresRaw) : null;
    return {
      token: {
        accessToken: tokenObject.access_token,
        tokenType: tokenObject.token_type,
        expiresAt: expiresAt !== null && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
        refreshToken: tokenObject.refresh_token ?? null,
        scopes: [...tokenObject.scopes],
      },
      client_id: value.client_id,
      client_secret: value.client_secret ?? null,
      auth_url: value.auth_url,
      token_url: value.token_url,
      redirect_uri: value.redirect_uri,
      scopes: [...value.scopes],
      resource_origin: value.resource_origin ?? '',
    };
  } catch { return null; }
}

function serializeSession(session: PersistedOAuthSession): string {
  return JSON.stringify({
    token: {
      access_token: session.token.accessToken,
      token_type: session.token.tokenType,
      expires_at: session.token.expiresAt === null ? null : oauthTimestamp(session.token.expiresAt),
      refresh_token: session.token.refreshToken,
      scopes: session.token.scopes,
    },
    client_id: session.client_id,
    client_secret: session.client_secret,
    auth_url: session.auth_url,
    token_url: session.token_url,
    redirect_uri: session.redirect_uri,
    scopes: session.scopes,
    resource_origin: session.resource_origin,
  });
}

interface RegisteredClient {
  clientId: string;
  clientSecret: string | null;
  endpoints: OAuthEndpoints;
  redirectUri: string;
}

export class McpOAuthManager {
  private readonly clients = new Map<string, RegisteredClient>();
  private readonly tokens = new Map<string, OAuth2Token>();
  private readonly sessions = new Map<string, PersistedOAuthSession>();
  private readonly refreshes = new Map<string, Promise<OAuth2Token>>();
  private readonly generations = new Map<string, number>();
  private readonly revoking = new Set<string>();
  private readonly verifiers = new Map<string, string>();
  private readonly cancels = new Map<string, { cancelled: boolean }>();
  private readonly flows = new Set<OAuthFlow>();
  private disposed = false;
  private readonly runtime: OAuthRuntime;

  constructor(runtime: OAuthRuntime) {
    this.runtime = runtime;
  }

  private tokenKey(serverId: string): string {
    return `${TOKEN_KEY_PREFIX}${serverId}`;
  }

  async persistSession(serverId: string, session: PersistedOAuthSession): Promise<void> {
    try {
      await this.runtime.secureStore.saveSecret(this.tokenKey(serverId), serializeSession(session));
    } catch (error) {
      throw authError(`Failed to persist OAuth token: ${errorText(error)}`);
    }
  }

  private async loadSessionFromDisk(serverId: string): Promise<PersistedOAuthSession | null> {
    try {
      const raw = await this.runtime.secureStore.getSecret(this.tokenKey(serverId));
      return raw === null ? null : parseSession(raw);
    } catch { return null; }
  }

  async registerOAuthClient(
    serverId: string, clientId: string, clientSecret: string | null,
    endpoints: OAuthEndpoints, redirectUri: string,
  ): Promise<void> {
    validateSecureOauthUrl(endpoints.authorization, 'authorization endpoint');
    validateSecureOauthUrl(endpoints.token, 'token endpoint');
    try { new URL(redirectUri); }
    catch (error) { throw authError(`Invalid redirect URI: ${errorText(error)}`); }
    this.clients.set(serverId, { clientId, clientSecret, endpoints, redirectUri });
  }

  async restoreSession(serverId: string): Promise<OAuth2Token | null> {
    if (this.revoking.has(serverId)) return null;
    const generation = this.generations.get(serverId) ?? 0;
    const session = await this.loadSessionFromDisk(serverId);
    if (session === null || (this.generations.get(serverId) ?? 0) !== generation) return null;
    await this.registerOAuthClient(serverId, session.client_id, session.client_secret, {
      authorization: session.auth_url, token: session.token_url,
      revocation: null, userinfo: null, registration: null,
    }, session.redirect_uri);
    if ((this.generations.get(serverId) ?? 0) !== generation) return null;
    this.tokens.set(serverId, persistedToToken(session));
    this.sessions.set(serverId, session);
    return persistedToToken(session);
  }

  async discoverOAuthEndpoints(resourceOrDomain: string, signal?: AbortSignal): Promise<OAuthEndpoints> {
    const initial = normalizeResourceUrl(resourceOrDomain);
    const visited = new Set<string>();
    return this.discoverInner(initial.toString(), visited, 0, signal);
  }

  private discoveryUrls(raw: string): string[] {
    const parsed = normalizeResourceUrl(raw);
    const base = parsed.origin;
    const urls = [
      `${base}/.well-known/oauth-authorization-server`,
      `${base}/.well-known/oauth-protected-resource`,
    ];
    const path = parsed.pathname.replace(/^\/+|\/+$/gu, '');
    if (path !== '') urls.push(`${base}/${path}/.well-known/oauth-authorization-server`);
    return urls;
  }

  private async discoverInner(
    raw: string, visited: Set<string>, depth: number, signal: AbortSignal | undefined,
  ): Promise<OAuthEndpoints> {
    if (depth > DISCOVERY_MAX_DEPTH) {
      throw authError('OAuth discovery exceeded authorization-server depth limit');
    }
    const normalized = normalizeResourceUrl(raw);
    const key = normalized.toString().replace(/\/+$/u, '');
    if (visited.has(key)) throw authError('OAuth discovery authorization-server cycle detected');
    visited.add(key);

    for (const candidate of this.discoveryUrls(normalized.toString())) {
      let response: Response;
      try {
        response = await this.runtime.fetch(candidate, { redirect: 'follow', signal: httpSignal(signal) });
      } catch {
        if (signal?.aborted === true) throw authError(CANCELLED_MESSAGE);
        continue;
      }
      if (!response.ok) continue;
      const contentLength = response.headers.get('content-length');
      if (contentLength !== null && Number(contentLength) > DISCOVERY_MAX_BYTES) {
        throw authError('OAuth discovery response exceeds size limit');
      }
      const text = await response.text();
      if (Buffer.byteLength(text) > DISCOVERY_MAX_BYTES) {
        throw authError('OAuth discovery response exceeds size limit');
      }
      let discovery: unknown;
      try { discovery = JSON.parse(text); }
      catch (error) { throw authError(`Invalid OAuth discovery response: ${errorText(error)}`); }

      const issuerValue = jsonGet(discovery, 'issuer');
      if (typeof issuerValue === 'string') {
        let issuer: URL;
        try { issuer = normalizeResourceUrl(issuerValue); }
        catch { throw authError('OAuth metadata contains an unsafe issuer'); }
        if (normalizeResourceOrigin(issuer.toString()) !== normalizeResourceOrigin(normalized.toString())) {
          throw authError('OAuth metadata issuer does not match the discovered authorization server');
        }
      }
      const serversValue = jsonGet(discovery, 'authorization_servers');
      const servers: unknown[] = Array.isArray(serversValue) ? serversValue : [];
      if (servers.length > 0 && typeof servers[0] === 'string') {
        normalizeResourceUrl(servers[0]);
        return this.discoverInner(servers[0], visited, depth + 1, signal);
      }
      if (jsonGet(discovery, 'authorization_endpoint') !== undefined) {
        const endpoint = (key: string, required: boolean): string | null => {
          const value = jsonGet(discovery, key);
          if (typeof value !== 'string') {
            if (required) throw authError(`Missing ${key}`);
            return null;
          }
          try { new URL(value); }
          catch (error) { throw authError(`Invalid ${key}: ${errorText(error)}`); }
          try { return validateSecureOauthUrl(value, key).toString(); }
          catch (error) { throw authError(`Unsafe ${key}: ${errorText(error)}`); }
        };
        return {
          authorization: endpoint('authorization_endpoint', true)!,
          token: endpoint('token_endpoint', true)!,
          revocation: endpoint('revocation_endpoint', false),
          userinfo: endpoint('userinfo_endpoint', false),
          registration: endpoint('registration_endpoint', false),
        };
      }
    }

    const origin = normalizeResourceOrigin(normalized.toString());
    this.runtime.log?.('warn', `OAuth discovery failed, using fallback endpoints for ${origin}`);
    return {
      authorization: `${origin}/oauth/authorize`,
      token: `${origin}/oauth/token`,
      revocation: `${origin}/oauth/revoke`,
      userinfo: `${origin}/oauth/userinfo`,
      registration: `${origin}/oauth/register`,
    };
  }

  async dynamicClientRegister(
    registrationEndpoint: string, redirectUri: string, clientName: string, signal?: AbortSignal,
  ): Promise<{ clientId: string; clientSecret: string | null }> {
    validateSecureOauthUrl(registrationEndpoint, 'registration endpoint');
    const response = await this.runtime.fetch(registrationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: 'native',
      }),
      signal: httpSignal(signal),
    });
    const text = await response.text();
    if (!response.ok) {
      throw authError(`Dynamic client registration failed (${response.status}). `
        + 'Provide a client_id or ensure the authorization server supports RFC 7591.');
    }
    let json: unknown;
    try { json = JSON.parse(text); }
    catch (error) { throw authError(`Invalid DCR response: ${errorText(error)}`); }
    const clientId = jsonGet(json, 'client_id');
    const clientSecret = jsonGet(json, 'client_secret');
    if (typeof clientId !== 'string') {
      throw authError('DCR response missing client_id');
    }
    return {
      clientId,
      clientSecret: typeof clientSecret === 'string' ? clientSecret : null,
    };
  }

  async generateAuthorizationUrl(provider: string, scopes: string[]): Promise<{ url: string; state: string }> {
    const client = this.clients.get(provider);
    if (client === undefined) throw authError(`OAuth client not registered: ${provider}`);
    const state = base64url(randomBytes(32));
    const { verifier, challenge } = pkcePair();
    this.verifiers.set(state, verifier);
    const url = new URL(client.endpoints.authorization);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', client.clientId);
    url.searchParams.set('redirect_uri', client.redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (scopes.length > 0) url.searchParams.set('scope', scopes.join(' '));
    return { url: url.toString(), state };
  }

  async exchangeCode(provider: string, code: string, state: string, signal?: AbortSignal): Promise<OAuth2Token> {
    const client = this.clients.get(provider);
    if (client === undefined) throw authError(`OAuth client not registered: ${provider}`);
    const verifier = this.verifiers.get(state);
    if (verifier === undefined) throw authError('Invalid CSRF token or PKCE verifier not found');
    this.verifiers.delete(state);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: client.redirectUri,
      client_id: client.clientId,
      code_verifier: verifier,
    });
    const response = await this.postToken(client, body, signal);
    const token = tokenFromResponse(response, this.runtime.now());
    this.tokens.set(provider, token);
    return token;
  }

  async refreshToken(provider: string, refreshToken: string): Promise<OAuth2Token> {
    if (this.revoking.has(provider)) throw authError('OAuth session revoked');
    const pending = this.refreshes.get(provider);
    if (pending !== undefined) return pending;
    const generation = this.generations.get(provider) ?? 0;
    const refresh = this.refreshTokenInner(provider, refreshToken, generation);
    this.refreshes.set(provider, refresh);
    try { return await refresh; }
    finally { if (this.refreshes.get(provider) === refresh) this.refreshes.delete(provider); }
  }

  private async refreshTokenInner(provider: string, refreshToken: string, generation: number): Promise<OAuth2Token> {
    const checkpoint = (): void => {
      if ((this.generations.get(provider) ?? 0) !== generation) throw authError('OAuth session revoked');
    };
    const client = this.clients.get(provider);
    if (client === undefined) throw authError(`OAuth client not registered: ${provider}`);
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.clientId,
    });
    const response = await this.postToken(client, body);
    const token = tokenFromResponse(response, this.runtime.now());
    if (token.refreshToken === null) token.refreshToken = refreshToken;
    checkpoint();
    const existing = this.sessions.get(provider) ?? await this.loadSessionFromDisk(provider);
    checkpoint();
    if (existing !== null) {
      const updated = { ...existing, token };
      await this.persistSession(provider, updated);
      checkpoint();
      this.sessions.set(provider, updated);
    }
    this.tokens.set(provider, token);
    return token;
  }

  private async postToken(client: RegisteredClient, body: URLSearchParams, signal?: AbortSignal): Promise<unknown> {
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (client.clientSecret !== null) {
      headers.authorization = `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`;
    }
    const response = await this.runtime.fetch(client.endpoints.token, {
      method: 'POST', headers, body: body.toString(),
      signal: httpSignal(signal),
    });
    const text = await response.text();
    if (!response.ok) throw authError(`Token exchange failed (HTTP ${response.status})`);
    try { return JSON.parse(text) as unknown; }
    catch { throw authError('Token exchange failed: invalid JSON response'); }
  }

  async getToken(provider: string): Promise<OAuth2Token | null> {
    const token = this.tokens.get(provider);
    if (token !== undefined) return token;
    return this.restoreSession(provider);
  }

  async getValidToken(provider: string): Promise<OAuth2Token> {
    const generation = this.generations.get(provider) ?? 0;
    const token = await this.getToken(provider);
    if ((this.generations.get(provider) ?? 0) !== generation) throw authError('OAuth session revoked');
    if (token !== null) {
      if (oauthTokenNeedsRefresh(token) && token.refreshToken !== null) {
        return this.refreshToken(provider, token.refreshToken);
      }
      if (!isOAuthTokenExpired(token, this.runtime.now())) return token;
    }
    throw authError(`No valid token for provider: ${provider}. Re-authorize required.`);
  }

  async getBearerTokenForResource(serverId: string, resourceUrl: string): Promise<string> {
    const requestedOrigin = normalizeResourceOrigin(resourceUrl);
    if (!this.sessions.has(serverId)) await this.restoreSession(serverId);
    const session = this.sessions.get(serverId);
    const boundOrigin = session?.resource_origin ?? '';
    if (boundOrigin === '') {
      throw authError('OAuth session predates resource binding; re-authorize required');
    }
    if (boundOrigin !== requestedOrigin) {
      throw authError(`OAuth token resource mismatch: authorized for ${boundOrigin}, requested ${requestedOrigin}`);
    }
    return (await this.getValidToken(serverId)).accessToken;
  }

  async revokeToken(provider: string): Promise<void> {
    this.generations.set(provider, (this.generations.get(provider) ?? 0) + 1);
    this.revoking.add(provider);
    this.tokens.delete(provider);
    this.sessions.delete(provider);
    // A save already in progress must finish before the final disk deletion.
    try {
      await this.refreshes.get(provider)?.catch(() => {}); // boundary-allow empty-catch: await in-flight refresh settlement before token deletion
      await this.runtime.secureStore.deleteSecret(this.tokenKey(provider));
    }
    catch (error) { throw authError(`Failed to delete OAuth token: ${errorText(error)}`); }
    finally { this.revoking.delete(provider); }
  }

  async cancelOAuth(serverId: string): Promise<void> {
    const cancel = this.cancels.get(serverId);
    if (cancel !== undefined) cancel.cancelled = true;
    this.cancels.delete(serverId);
  }

  async hasOAuthSession(serverId: string): Promise<boolean> {
    if (this.tokens.has(serverId)) return true;
    return (await this.loadSessionFromDisk(serverId)) !== null;
  }

  async hasOAuthSessionForResource(serverId: string, resourceUrl: string): Promise<boolean> {
    let requestedOrigin: string;
    try { requestedOrigin = normalizeResourceOrigin(resourceUrl); }
    catch { return false; }
    const session = this.sessions.get(serverId) ?? await this.loadSessionFromDisk(serverId);
    return session !== null && session.resource_origin !== ''
      && session.resource_origin === requestedOrigin;
  }

  async startOAuth(params: StartOAuthParams, options: StartOAuthOptions = {}): Promise<StartOAuthOutcome> {
    const resourceOrigin = normalizeResourceOrigin(params.resourceUrl);
    await this.cancelOAuth(params.serverId);
    const flow: OAuthFlow = { cancelled: false, stop: new AbortController(), listener: null };
    this.cancels.set(params.serverId, flow);
    this.flows.add(flow);
    const stop = (): void => { this.stopFlow(flow); };
    if (this.disposed || options.signal?.aborted === true) stop();
    else options.signal?.addEventListener('abort', stop, { once: true });
    const signal = flow.stop.signal;
    const checkpoint = (): void => { if (signal.aborted) throw authError(CANCELLED_MESSAGE); };
    try {
      checkpoint();
      const endpoints = await this.discoverOAuthEndpoints(params.resourceUrl, signal);
      checkpoint();
      const state = base64url(randomBytes(32));
      const listener = flow.listener = await this.bindCallback(state);
      checkpoint();
      const { clientId, clientSecret } = await this.resolveClient(params, endpoints, listener.redirectUri, signal);
      checkpoint();
      await this.registerOAuthClient(params.serverId, clientId, clientSecret, endpoints, listener.redirectUri);
      const authorization = await this.generateAuthorizationUrlWithState(
        params.serverId, params.scopes, state,
      );
      checkpoint();
      if (params.openBrowser) {
        try { await this.runtime.openUrl(authorization); }
        catch (error) {
          this.runtime.log?.('error', `Failed to open system browser: ${errorText(error)}`);
          throw authError(`Failed to open system browser: ${errorText(error)}`);
        }
      }
      const callback = await listener.wait(
        params.timeoutMs ?? this.runtime.callbackTimeoutMs ?? OAUTH_CALLBACK_TIMEOUT_MS, flow, signal,
      );
      if (callback.kind === 'state_mismatch') throw authError('OAuth callback rejected: state mismatch');
      if (callback.kind === 'denied') throw authError(`Authorization denied: ${callback.error}`);
      if (callback.kind === 'timeout') throw authError('OAuth authorization timed out (120s)');
      if (callback.kind === 'cancelled') throw authError(CANCELLED_MESSAGE);
      if (callback.state !== state) throw authError('OAuth state mismatch');
      const token = await this.exchangeCode(params.serverId, callback.code, state, signal);
      checkpoint();
      const session: PersistedOAuthSession = {
        token,
        client_id: clientId,
        client_secret: clientSecret,
        auth_url: endpoints.authorization,
        token_url: endpoints.token,
        redirect_uri: listener.redirectUri,
        scopes: params.scopes,
        resource_origin: resourceOrigin,
      };
      this.sessions.set(params.serverId, session);
      await this.persistSession(params.serverId, session);
      return {
        server_id: params.serverId,
        access_token: token.accessToken,
        token_type: token.tokenType,
        expires_at: token.expiresAt === null ? null : oauthTimestamp(token.expiresAt),
        authorization_url: authorization,
        redirect_uri: listener.redirectUri,
      };
    } finally {
      options.signal?.removeEventListener('abort', stop);
      // Rust drops the listener on every early return; close() is idempotent.
      flow.listener?.close();
      this.flows.delete(flow);
      // A replacement flow may already own this server's cancellation entry.
      if (this.cancels.get(params.serverId) === flow) this.cancels.delete(params.serverId);
    }
  }

  /** Plugin teardown: stop every running flow (closing its port) and refuse new ones. */
  dispose(): void {
    this.disposed = true;
    for (const flow of this.flows) this.stopFlow(flow);
  }

  private stopFlow(flow: OAuthFlow): void {
    flow.cancelled = true;
    flow.stop.abort(authError(CANCELLED_MESSAGE));
    flow.listener?.close();
  }

  private async resolveClient(
    params: StartOAuthParams, endpoints: OAuthEndpoints, redirectUri: string, signal?: AbortSignal,
  ): Promise<{ clientId: string; clientSecret: string | null }> {
    const provided = params.clientId?.trim() ?? '';
    if (provided !== '') return { clientId: provided, clientSecret: params.clientSecret };
    if (endpoints.registration !== null) {
      return this.dynamicClientRegister(endpoints.registration, redirectUri, 'Deep Student MCP', signal);
    }
    throw authError('No client_id provided and authorization server has no registration_endpoint '
      + '(RFC 7591). Configure client_id in the MCP server OAuth settings.');
  }

  private async generateAuthorizationUrlWithState(
    provider: string, scopes: string[], state: string,
  ): Promise<string> {
    const client = this.clients.get(provider);
    if (client === undefined) throw authError(`OAuth client not registered: ${provider}`);
    const { verifier, challenge } = pkcePair();
    this.verifiers.set(state, verifier);
    const url = new URL(client.endpoints.authorization);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', client.clientId);
    url.searchParams.set('redirect_uri', client.redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (scopes.length > 0) url.searchParams.set('scope', scopes.join(' '));
    return url.toString();
  }

  private async bindCallback(state: string): Promise<CallbackListener> {
    const server: Server = createServer();
    const listener = new CallbackListener(server, state, this.runtime.log);
    try { await listener.listen(); }
    catch (error) { listener.close(); throw error; }
    return listener;
  }
}

class CallbackListener {
  readonly server: Server;
  readonly state: string;
  redirectUri = '';
  private settle: ((result: OAuthCallbackResult) => void) | null = null;
  private result: Promise<OAuthCallbackResult> | null = null;
  private readonly log: ((level: 'warn' | 'error', message: string) => void) | undefined;

  constructor(
    server: Server, state: string,
    log?: (level: 'warn' | 'error', message: string) => void,
  ) {
    this.server = server;
    this.state = state;
    this.log = log;
  }

  async listen(): Promise<void> {
    this.result = new Promise<OAuthCallbackResult>(resolve => { this.settle = resolve; });
    // `oauth_callback.rs` logs connection errors and keeps serving.
    this.server.on('clientError', (error, socket) => {
      this.log?.('warn', `OAuth callback connection error: ${errorText(error)}`);
      socket.destroy();
    });
    this.server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method !== 'GET' || url.pathname !== '/auth/callback') {
        sendHtml(response, 404, false);
        return;
      }
      if (url.searchParams.get('state') !== this.state) {
        sendHtml(response, 400, false);
        return;
      }
      const error = url.searchParams.get('error');
      if (error !== null) {
        sendHtml(response, 400, false);
        this.settle?.({ kind: 'denied', error });
        return;
      }
      const code = url.searchParams.get('code');
      if (code === null || code === '') {
        sendHtml(response, 400, false);
        return;
      }
      sendHtml(response, 200, true);
      this.settle?.({ kind: 'code', code, state: this.state });
    });
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', error => { reject(authError(`Failed to bind OAuth callback listener: ${errorText(error)}`)); });
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address();
        if (address === null || typeof address === 'string') {
          reject(authError('Failed to read callback port'));
          return;
        }
        this.redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
        resolve();
      });
    });
  }

  wait(timeoutMs: number, cancel: { cancelled: boolean }, signal?: AbortSignal): Promise<OAuthCallbackResult> {
    if (this.result === null || signal?.aborted === true) {
      this.close();
      return Promise.resolve({ kind: 'cancelled' });
    }
    return new Promise<OAuthCallbackResult>(resolve => {
      const timer = setTimeout(() => { finish({ kind: 'timeout' }); }, timeoutMs);
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref();
      const poll = setInterval(() => {
        if (cancel.cancelled) finish({ kind: 'cancelled' });
      }, 25);
      if (typeof poll === 'object' && poll !== null && 'unref' in poll) poll.unref();
      const onAbort = (): void => { finish({ kind: 'cancelled' }); };
      signal?.addEventListener('abort', onAbort, { once: true });
      let settled = false;
      const finish = (result: OAuthCallbackResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        signal?.removeEventListener('abort', onAbort);
        this.close();
        resolve(result);
      };
      void this.result!.then(finish);
    });
  }

  close(): void {
    if (this.server.listening) this.server.close();
  }
}

function sendHtml(
  response: import('node:http').ServerResponse, status: number, success: boolean,
): void {
  const message = success
    ? 'Authorization complete. You can return to Deep Student.'
    : 'Authorization could not be completed. Return to Deep Student for details.';
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    'cache-control': 'no-store',
  });
  response.end(`<!doctype html><meta charset="utf-8"><title>Deep Student</title><p>${message}</p>`);
}

/** Test seam: construct a listener with a fixed state and read its redirect URI. */
export async function createCallbackListenerForTest(state: string): Promise<{
  redirectUri: string; wait(timeoutMs: number): Promise<OAuthCallbackResult>; close(): void;
}> {
  const server = createServer();
  const listener = new CallbackListener(server, state);
  await listener.listen();
  return {
    redirectUri: listener.redirectUri,
    wait: timeoutMs => listener.wait(timeoutMs, { cancelled: false }),
    close: () => listener.close(),
  };
}

export { randomUUID };
