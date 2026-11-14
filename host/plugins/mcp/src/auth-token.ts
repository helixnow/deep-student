// Port of dstu-mcp/src/mcp/auth.rs token/origin helpers that do not need OAuth HTTP.

import { randomInt } from 'node:crypto';
import { isLoopbackHost } from '../../../platform/net-policy/index.ts';

export class McpAuthError extends Error {
  readonly code = 'AUTHENTICATION_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'McpAuthError';
  }
}

export interface OAuth2Token {
  accessToken: string;
  tokenType: string;
  expiresAt: Date | null;
  refreshToken: string | null;
  scopes: string[];
}

function authError(message: string): McpAuthError {
  return new McpAuthError(message);
}

function normalizeResourceUrl(raw: string): URL {
  const candidate = raw.includes('://') ? raw.trim() : `https://${raw.trim()}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch (error) {
    throw authError(`Invalid MCP OAuth resource URL: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed.hostname === '') throw authError('MCP OAuth resource URL is missing a host');
  if (parsed.username !== '' || parsed.password !== '') {
    throw authError('OAuth URL must not contain userinfo');
  }
  const scheme = parsed.protocol.endsWith(':') ? parsed.protocol.slice(0, -1) : parsed.protocol;
  if (scheme === 'https' || (scheme === 'http' && isLoopbackHost(parsed.hostname))) return parsed;
  throw authError('OAuth URLs must use HTTPS (HTTP is allowed only for loopback hosts)');
}

/** Normalized `scheme://host[:port]` binding for OAuth resource indicators. */
export function normalizeResourceOrigin(raw: string): string {
  return normalizeResourceUrl(raw).origin.toLowerCase();
}

export function isOAuthTokenExpired(token: OAuth2Token, now: Date = new Date()): boolean {
  return token.expiresAt !== null && now.getTime() >= token.expiresAt.getTime();
}

export function oauthTokenNeedsRefresh(token: OAuth2Token, now: Date = new Date()): boolean {
  return token.expiresAt !== null && now.getTime() + 5 * 60 * 1000 >= token.expiresAt.getTime();
}

const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function createLongLivedToken(provider: string): string {
  const token = Array.from({ length: 32 }, () => TOKEN_ALPHABET[randomInt(0, TOKEN_ALPHABET.length)]).join('');
  return `mcp_${provider}_${token}`;
}

export type McpAuthToken =
  | { kind: 'api_key'; key: string }
  | { kind: 'oauth2'; token: OAuth2Token };

/** `McpAuthManager::authenticate_modelscope`: API key wins; no key requires OAuth start. */
export function authenticateApiKey(apiKey: string | null): McpAuthToken {
  if (apiKey !== null) return { kind: 'api_key', key: apiKey };
  throw authError('OAuth 2.1 interactive flow requires start_oauth(server_id). '
    + 'Please use API Key authentication or call start_oauth.');
}

export type BearerTokenProvider = (serverId: string) => Promise<string | null>;

/**
 * `resolve_authorization_header`: API key wins; OAuth needs a server id and a
 * live bearer token from the injected auth service.
 */
export async function resolveAuthorizationHeader(
  serverId: string | null,
  apiKey: string | null,
  oauthConfigured: boolean,
  tokenProvider: BearerTokenProvider,
): Promise<string | null> {
  const trimmed = apiKey?.trim() ?? '';
  if (trimmed !== '') return `Bearer ${trimmed}`;
  if (!oauthConfigured) return null;
  if (serverId === null || serverId === '') {
    throw authError('OAuth configured but server_id missing for token lookup');
  }
  let token: string | null;
  try {
    token = await tokenProvider(serverId);
  } catch (error) {
    throw authError(`OAuth re-authorization required: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (token === null || token === '') {
    throw authError('OAuth re-authorization required: no token available');
  }
  return `Bearer ${token}`;
}
