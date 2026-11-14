/**
 * WAVE0 OAuth 2.1 authorization server mock for `start_mcp_oauth` (Rust `dstu-mcp/src/mcp/auth.rs`,
 * B `host/plugins/mcp/src/oauth-manager.ts`), on its own loopback origin so that a token bound to
 * `${mcp.oauth.resourceUrl}` is a different origin from `${mcp.url}` (auth.rs:619-645).
 *
 * Both clients try, in order (auth.rs:1044-1067): `{origin}/.well-known/oauth-authorization-server`,
 * `{origin}/.well-known/oauth-protected-resource`, `{origin}/{path}/.well-known/oauth-authorization-server`.
 * The origin-level documents are 404 here, so one origin can serve two profiles by resource path:
 *   `/dcr/mcp`              RFC 8414 metadata with a registration_endpoint (RFC 7591 DCR)
 *   `/no-registration/mcp`  the same metadata without one (auth.rs:724-733 rejects before any browser)
 *
 * Authorization auto-approves a client registered on this service: `GET …/oauth/authorize` answers
 * 302 to `redirect_uri?code=…&state=…` once the client, redirect_uri, `response_type=code` and an
 * S256 challenge check out. Any other client_id (e.g. a pre-configured one) gets 400 and no redirect
 * (RFC 6749 §4.1.2.1), so its flow waits for cancel or timeout. The token endpoint verifies PKCE.
 * Tokens carry no `expires_in`: both sides then persist `expires_at: null` instead of a clock value.
 * Identifiers are counters per reset (`wave0-dcr-1`, `wave0-code-1`, `wave0-access-1`, …).
 *
 * Plain Node TS (type-stripping safe).
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export const OAUTH_PROFILES = ['dcr', 'no-registration'] as const;
export type OAuthProfile = typeof OAUTH_PROFILES[number];

export interface OAuthRecord {
  kind: 'oauth';
  profile: OAuthProfile | null;
  endpoint: 'metadata' | 'register' | 'authorize' | 'token' | 'revoke' | 'not-found';
  method: string;
  /** Path and query as received (state, challenge and redirect port vary per run: evidence only). */
  path: string;
  headers: Record<string, string>;
  body: string;
  status: number;
  /** `metadata`, `registered`, `code`, `token`, `refreshed`, `revoked`, or the OAuth error code. */
  outcome: string;
  /** Response body, or the Location of a redirect. */
  response: string | null;
}

export interface OAuthServer {
  /** e.g. `http://127.0.0.1:47131` */
  readonly url: string;
  resourceUrl(profile: OAuthProfile): string;
  records(): OAuthRecord[];
  openCount(): number;
  /** Clears registrations, codes, tokens, counters and records; ends requests still open. */
  reset(): void;
  stop(): Promise<void>;
}

interface Client { id: string; redirectUris: string[] }
interface Grant { clientId: string; redirectUri: string; challenge: string; scope: string | null }

const base64url = (bytes: Buffer): string => bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function sortedHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const key of Object.keys(request.headers).sort()) {
    const value = request.headers[key];
    headers[key] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
  }
  return headers;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    request.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')); });
    request.on('error', reject);
  });
}

/** Client id and secret from HTTP Basic (RFC 6749 §2.3.1, form-urlencoded parts) or the form body. */
function clientCredentials(request: IncomingMessage, form: URLSearchParams): { id: string | null; secret: string | null } {
  const header = request.headers.authorization;
  if (typeof header === 'string' && /^basic /i.test(header)) {
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    const unescape = (value: string): string => decodeURIComponent(value.replace(/\+/g, ' '));
    if (colon >= 0) return { id: unescape(decoded.slice(0, colon)), secret: unescape(decoded.slice(colon + 1)) };
  }
  return { id: form.get('client_id'), secret: form.get('client_secret') };
}

export async function startOAuthServer(config: { host?: string; port?: number } = {}): Promise<OAuthServer> {
  const host = config.host ?? '127.0.0.1';
  let records: OAuthRecord[] = [];
  let clients = new Map<string, Client>();
  let grants = new Map<string, Grant>();
  let refreshTokens = new Map<string, { clientId: string; scope: string | null }>();
  let counters = { client: 0, code: 0, access: 0 };
  const inflight = new Set<ServerResponse>();
  const sockets = new Set<Socket>();
  let origin = '';

  const metadata = (profile: OAuthProfile): Record<string, unknown> => {
    const base = `${origin}/${profile}`;
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      revocation_endpoint: `${base}/oauth/revoke`,
      ...(profile === 'dcr' ? { registration_endpoint: `${base}/oauth/register` } : {}),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
      scopes_supported: ['mcp', 'mcp:tools'],
    };
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://oauth.invalid');
    const body = request.method === 'POST' ? await readBody(request) : '';
    const record = (fields: Pick<OAuthRecord, 'profile' | 'endpoint' | 'status' | 'outcome' | 'response'>): void => {
      records.push({ kind: 'oauth', ...fields, method: request.method ?? '', path: `${url.pathname}${url.search}`, headers: sortedHeaders(request), body });
    };
    const json = (fields: Pick<OAuthRecord, 'profile' | 'endpoint' | 'outcome'>, status: number, value: unknown): void => {
      const text = JSON.stringify(value);
      record({ ...fields, status, response: text });
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(text);
    };
    const match = /^\/([^/]+)(\/.*)$/.exec(url.pathname);
    const profile = OAUTH_PROFILES.find(name => name === match?.[1]) ?? null;
    const rest = match?.[2] ?? '';
    const notFound = (): void => {
      record({ profile, endpoint: 'not-found', status: 404, outcome: 'not-found', response: 'not found' });
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    };
    if (profile === null) { notFound(); return; }

    if (request.method === 'GET' && rest === '/mcp/.well-known/oauth-authorization-server') {
      json({ profile, endpoint: 'metadata', outcome: 'metadata' }, 200, metadata(profile));
      return;
    }

    if (request.method === 'POST' && rest === '/oauth/register' && profile === 'dcr') {
      const fields = { profile, endpoint: 'register' as const };
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { json({ ...fields, outcome: 'invalid_client_metadata' }, 400, { error: 'invalid_client_metadata', error_description: 'body is not JSON' }); return; }
      const uris = (parsed as { redirect_uris?: unknown } | null)?.redirect_uris;
      if (!Array.isArray(uris) || uris.length === 0 || !uris.every(uri => typeof uri === 'string')) {
        json({ ...fields, outcome: 'invalid_redirect_uri' }, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be a non-empty array of strings' });
        return;
      }
      counters.client += 1;
      const client: Client = { id: `wave0-dcr-${counters.client}`, redirectUris: uris as string[] };
      clients.set(client.id, client);
      const metadataIn = parsed as Record<string, unknown>;
      json({ ...fields, outcome: 'registered' }, 201, {
        client_id: client.id,
        client_name: metadataIn.client_name ?? null,
        redirect_uris: client.redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
      return;
    }

    if (request.method === 'GET' && rest === '/oauth/authorize') {
      const query = url.searchParams;
      const reject = (outcome: string, description: string): void => {
        record({ profile, endpoint: 'authorize', status: 400, outcome, response: description });
        response.writeHead(400, { 'content-type': 'text/plain' }).end(`${outcome}: ${description}`);
      };
      const client = clients.get(query.get('client_id') ?? '');
      if (client === undefined) { reject('invalid_client', 'client_id is not registered on this server'); return; }
      const redirectUri = query.get('redirect_uri') ?? '';
      if (!client.redirectUris.includes(redirectUri)) { reject('invalid_request', 'redirect_uri is not registered for this client'); return; }
      const target = new URL(redirectUri);
      const state = query.get('state');
      const challenge = query.get('code_challenge') ?? '';
      let problem: string | null = null;
      if (query.get('response_type') !== 'code') problem = 'unsupported_response_type';
      else if (query.get('code_challenge_method') !== 'S256' || challenge === '') problem = 'invalid_request';
      if (problem !== null) target.searchParams.set('error', problem);
      else {
        counters.code += 1;
        const code = `wave0-code-${counters.code}`;
        grants.set(code, { clientId: client.id, redirectUri, challenge, scope: query.get('scope') });
        target.searchParams.set('code', code);
      }
      if (state !== null) target.searchParams.set('state', state);
      record({ profile, endpoint: 'authorize', status: 302, outcome: problem ?? 'code', response: target.toString() });
      response.writeHead(302, { location: target.toString() }).end();
      return;
    }

    if (request.method === 'POST' && rest === '/oauth/token') {
      const fields = { profile, endpoint: 'token' as const };
      const form = new URLSearchParams(body);
      const credentials = clientCredentials(request, form);
      const fail = (error: string, description: string): void => { json({ ...fields, outcome: error }, 400, { error, error_description: description }); };
      const grantType = form.get('grant_type');
      const issue = (clientId: string, scope: string | null, outcome: string): void => {
        counters.access += 1;
        const refresh = `wave0-refresh-${counters.access}`;
        refreshTokens.set(refresh, { clientId, scope });
        json({ ...fields, outcome }, 200, {
          access_token: `wave0-access-${counters.access}`, token_type: 'Bearer', refresh_token: refresh, ...(scope === null ? {} : { scope }),
        });
      };
      if (grantType === 'authorization_code') {
        const code = form.get('code') ?? '';
        const grant = grants.get(code);
        if (grant === undefined) { fail('invalid_grant', 'unknown or used authorization code'); return; }
        grants.delete(code);
        if (credentials.id !== grant.clientId) { fail('invalid_client', 'client_id does not match the authorization code'); return; }
        if (form.get('redirect_uri') !== grant.redirectUri) { fail('invalid_grant', 'redirect_uri does not match the authorization request'); return; }
        const verifier = form.get('code_verifier') ?? '';
        if (base64url(createHash('sha256').update(verifier).digest()) !== grant.challenge) { fail('invalid_grant', 'PKCE code_verifier does not match the S256 challenge'); return; }
        issue(grant.clientId, grant.scope, 'token');
        return;
      }
      if (grantType === 'refresh_token') {
        const known = refreshTokens.get(form.get('refresh_token') ?? '');
        if (known === undefined || credentials.id !== known.clientId) { fail('invalid_grant', 'unknown refresh_token for this client'); return; }
        issue(known.clientId, known.scope, 'refreshed');
        return;
      }
      fail('unsupported_grant_type', `grant_type ${grantType ?? '(missing)'}`);
      return;
    }

    if (request.method === 'POST' && rest === '/oauth/revoke') {
      refreshTokens.delete(new URLSearchParams(body).get('token') ?? '');
      record({ profile, endpoint: 'revoke', status: 200, outcome: 'revoked', response: '' });
      response.writeHead(200).end();
      return;
    }
    notFound();
  };

  const server: Server = createServer((request, response) => {
    inflight.add(response);
    response.on('close', () => { inflight.delete(response); });
    handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' }).end(String(error));
      else response.destroy();
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => { sockets.delete(socket); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port ?? 0, host, () => { server.off('error', reject); resolve(); });
  });
  origin = `http://${host}:${(server.address() as AddressInfo).port}`;
  let stopped = false;

  return {
    url: origin,
    resourceUrl: profile => `${origin}/${profile}/mcp`,
    records: () => structuredClone(records),
    openCount: () => inflight.size,
    reset() {
      for (const response of [...inflight]) response.destroy();
      records = [];
      clients = new Map();
      grants = new Map();
      refreshTokens = new Map();
      counters = { client: 0, code: 0, access: 0 };
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const response of [...inflight]) response.destroy();
      await new Promise<void>(resolve => {
        server.close(() => { resolve(); });
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}
