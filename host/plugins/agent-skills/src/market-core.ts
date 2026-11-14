/**
 * Portable half of the community skill marketplace (`skill_market_client.rs`): the
 * `ctx.http` transport with the Rust reqwest policy (10 s deadline, clawhub/GitHub
 * redirect allow-list, response size cap), the process-wide 5-minute GET cache, JSON
 * shapes, `SkillMarketClient` and the four-command facade.
 *
 * `skill-market.ts` re-exports everything here and keeps the desktop-only pieces: temp
 * zip artifacts on the OS temp dir, the Node zip worker for GitHub handoff repacking and
 * the tool executors. The mobile host passes its own artifact store (`ctx.files`) and
 * repack (`platform/zip/core`) through the same seams.
 */
import { CommandError } from '../../../kernel/api.ts';
import type { HttpService } from '../../../platform/http/api.ts';
import { UNSUPPORTED_ON_PLATFORM_PREFIX } from '../../../platform/storage/errors.ts';
import { now as currentInstant } from '../../../platform/time/index.ts';
import { sha256HexSync } from '../../../platform/crypto/sync.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';
import type {
  SkillImportZipResult, SkillMarketDownloadScanResult, SkillMarketSearchResponse, SkillMarketSkillCard,
  SkillMarketSkillDetail, SkillMarketVerifyResult,
} from '../api.ts';
import { MAX_SKILL_PACKAGE_ZIP_BYTES, type SkillFileBytes } from './package-core.ts';

export const COMMUNITY_SKILL_MARKET_BASE = 'https://clawhub.ai';
export const MARKET_REQUEST_TIMEOUT_MS = 10_000;
export const MARKET_CACHE_TTL_MS = 5 * 60 * 1000;
export const MARKET_MAX_429_RETRIES = 2;
export const MARKET_DEFAULT_LIMIT = 24;
export const MARKET_MAX_LIMIT = 50;
export const PROVENANCE_SETTINGS_PREFIX = 'skill.provenance.';
export const MARKET_USER_AGENT = 'DeepStudent-SkillMarket/1.0';
export const TEMP_ARTIFACT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MARKET_RESPONSE_EXTRA_BYTES = 1024 * 1024;
const MARKET_REDIRECT_LIMIT = 5;

export interface RawHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** Injectable HTTP transport (`SkillMarketTransport` in Rust). */
export interface SkillMarketTransport {
  send(method: string, url: string, jsonBody?: unknown): Promise<RawHttpResponse>;
}

export function isAllowedSkillMarketTransportUrl(value: URL): boolean {
  return value.protocol === 'https:'
    && ['clawhub.ai', 'github.com', 'codeload.github.com', 'api.github.com'].includes(value.hostname);
}

function fetchFailureCause(error: unknown): string {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * `ReqwestTransport` over the host's `ctx.http`: `destination: 'any'` like the Rust client (no address policy, system
 * proxy), redirects followed here so each hop gets the clawhub/GitHub allow-list.
 */
export class HttpSkillMarketTransport implements SkillMarketTransport {
  _http: () => HttpService | null;

  constructor(http: () => HttpService | null) {
    this._http = http;
  }

  async send(method: string, url: string, jsonBody?: unknown): Promise<RawHttpResponse> {
    const upper = method.toUpperCase();
    if (upper !== 'GET' && upper !== 'POST') throw new Error(`Unsupported HTTP method: ${upper}`);
    const http = this._http();
    if (http === null) {
      throw new Error(`${UNSUPPORTED_ON_PLATFORM_PREFIX}the community skill marketplace needs the ctx.http service, which this host does not provide`);
    }

    let current = url;
    let redirects = 0;
    let response: Response;
    // reqwest applies one client timeout to the whole request, including every
    // redirect hop and the body read. Create the deadline once instead of
    // resetting it per Location.
    const signal = AbortSignal.timeout(MARKET_REQUEST_TIMEOUT_MS);
    for (;;) {
      try {
        response = await http.fetch(current, {
          method: upper,
          destination: 'any',
          redirect: 'manual',
          headers: upper === 'POST' && jsonBody !== undefined
            ? { 'user-agent': MARKET_USER_AGENT, 'content-type': 'application/json' }
            : { 'user-agent': MARKET_USER_AGENT },
          body: upper === 'POST' && jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
          signal,
        });
      } catch (error) {
        // reqwest 0.11 `Error` Display: `error sending request for url (<url>): <source>`.
        const source = signal.aborted ? 'operation timed out' : fetchFailureCause(error);
        throw new Error(`Community skill marketplace request failed: error sending request for url (${current}): ${source}`);
      }
      if (response.status >= 300 && response.status < 400) {
        if (redirects >= MARKET_REDIRECT_LIMIT) {
          throw new Error('Community skill marketplace request failed: too many redirects');
        }
        const location = response.headers.get('location');
        if (location === null) break;
        let next: URL;
        try { next = new URL(location, current); }
        catch { break; }
        if (!isAllowedSkillMarketTransportUrl(next)) break;
        current = next.toString();
        redirects++;
        continue;
      }
      break;
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of response.headers) headers[key.toLowerCase()] = value;
    let body: Uint8Array;
    try { body = new Uint8Array(await response.arrayBuffer()); }
    catch (error) {
      throw new Error(`Community skill marketplace read body failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (body.length > MAX_SKILL_PACKAGE_ZIP_BYTES + MARKET_RESPONSE_EXTRA_BYTES) {
      throw new Error('Community skill marketplace response exceeds size limit');
    }
    return { status: response.status, headers, body };
  }
}

interface CacheEntry {
  storedAt: number;
  body: Uint8Array;
  status: number;
  headers: Record<string, string>;
}

export class ResponseCache {
  _entries = new Map<string, CacheEntry>();

  get(key: string): RawHttpResponse | undefined {
    const entry = this._entries.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() - entry.storedAt > MARKET_CACHE_TTL_MS) return undefined;
    return { status: entry.status, headers: { ...entry.headers }, body: new Uint8Array(entry.body) };
  }

  put(key: string, response: RawHttpResponse): void {
    if (response.status !== 200) return;
    this._entries.set(key, {
      storedAt: Date.now(),
      body: new Uint8Array(response.body),
      status: response.status,
      headers: { ...response.headers },
    });
    if (this._entries.size > 256) {
      for (const [staleKey, entry] of this._entries) {
        if (Date.now() - entry.storedAt > MARKET_CACHE_TTL_MS) this._entries.delete(staleKey);
      }
      while (this._entries.size > 256) this._entries.delete(this._entries.keys().next().value!);
    }
  }

  clear(): void {
    this._entries.clear();
  }
}

export const GLOBAL_MARKET_CACHE = new ResponseCache();

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface GitHubHandoff {
  sourceRef: string;
  repo: string;
  commit: string;
  path: string;
  contentHash?: string;
  archiveUrl: string;
}

export type DownloadPayload =
  | { kind: 'zip'; bytes: Uint8Array }
  | { kind: 'github-handoff'; handoff: GitHubHandoff };

export interface DownloadedPackage {
  bytes: Uint8Array;
  version: string;
  sourceKind: string;
  handoff?: GitHubHandoff;
}

/** GitHub handoff subdirectory repack; desktop wraps the zip worker, mobile the portable core. */
export type HandoffRepack = (zipBytes: Uint8Array, subdir: string, fallbackDirName: string) => Promise<Uint8Array>;

let defaultHandoffRepack: HandoffRepack = () => {
  throw new Error('Handoff repack failed: no zip runtime configured for this host');
};

/** Register the host's repack implementation (called once by `skill-market.ts` on desktop). */
export function setDefaultHandoffRepack(repack: HandoffRepack): void {
  defaultHandoffRepack = repack;
}

export function sha256Hex(bytes: Uint8Array): string {
  return sha256HexSync(bytes);
}

export function normalizeExpectedSha256(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (value.length !== 64 || !/^[0-9a-f]+$/.test(value)) {
    throw new Error('expectedPackageSha256 must be a 64-character SHA-256 digest');
  }
  return value;
}

export function validateHandoffDescriptor(handoff: GitHubHandoff): void {
  const repoParts = handoff.repo.split('/');
  if (repoParts.length !== 2 || repoParts.some(part => part.length === 0)) {
    throw new Error('Invalid GitHub handoff repo');
  }
  if (handoff.commit.length < 7 || handoff.commit.length > 64 || !/^[0-9a-fA-F]+$/.test(handoff.commit)) {
    throw new Error('GitHub handoff commit must be a hexadecimal commit id');
  }
  let parsed: URL;
  try { parsed = new URL(handoff.archiveUrl); }
  catch (error) {
    throw new Error(`Invalid GitHub handoff archiveUrl: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed.protocol !== 'https:' || !['github.com', 'codeload.github.com', 'api.github.com'].includes(parsed.hostname)) {
    throw new Error('GitHub handoff archiveUrl host is not allowed');
  }
  const expectedRepo = `/${repoParts[0]}/${repoParts[1]}`;
  if (!parsed.pathname.startsWith(expectedRepo)
    || !parsed.pathname.toLowerCase().includes(handoff.commit.toLowerCase())) {
    throw new Error('GitHub handoff archiveUrl does not match repo/commit');
  }
  if (handoff.contentHash !== undefined) {
    try { normalizeExpectedSha256(handoff.contentHash); }
    catch { throw new Error('GitHub handoff contentHash must be SHA-256'); }
  }
}

function parseHandoff(record: Record<string, unknown>): GitHubHandoff {
  const required = (key: string): string => {
    const value = record[key];
    if (typeof value !== 'string') throw new Error(`missing or invalid field \`${key}\``);
    return value;
  };
  const contentHash = record.contentHash;
  if (contentHash !== undefined && contentHash !== null && typeof contentHash !== 'string') {
    throw new Error('invalid field `contentHash`');
  }
  return {
    sourceRef: required('sourceRef'),
    repo: required('repo'),
    commit: required('commit'),
    path: required('path'),
    ...(typeof contentHash === 'string' ? { contentHash } : {}),
    archiveUrl: required('archiveUrl'),
  };
}

const utf8Decoder = () => new TextDecoder('utf-8');

/** Port of skill_market_client.rs:733 `classify_download_payload`. */
export function classifyDownloadPayload(contentType: string, body: Uint8Array): DownloadPayload {
  const ct = contentType.toLowerCase();
  const startsWithPk = body.length >= 2 && body[0] === 0x50 && body[1] === 0x4b;
  const looksJson = ct.includes('application/json')
    || ct.includes('text/json')
    || (body[0] === 0x7b && !startsWithPk);
  if (looksJson) {
    let parsed: unknown;
    try { parsed = JSON.parse(utf8Decoder().decode(body)); }
    catch (error) {
      throw new Error(`Community marketplace download returned JSON but not a GitHub handoff: ${error instanceof Error ? error.message : String(error)}`);
    }
    let handoff: GitHubHandoff;
    try {
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('expected a JSON object');
      }
      handoff = parseHandoff(parsed as Record<string, unknown>);
    } catch (error) {
      throw new Error(`Community marketplace download returned JSON but not a GitHub handoff: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (handoff.sourceRef !== 'public-github') {
      throw new Error(`Unsupported community marketplace handoff sourceRef: ${handoff.sourceRef}`);
    }
    if (!handoff.archiveUrl || !handoff.repo) throw new Error('Incomplete GitHub handoff descriptor');
    return { kind: 'github-handoff', handoff };
  }
  if (startsWithPk || ct.includes('application/zip') || ct.includes('application/octet-stream')) {
    if (body.length > MAX_SKILL_PACKAGE_ZIP_BYTES) throw new Error('Downloaded zip exceeds package size limit');
    return { kind: 'zip', bytes: new Uint8Array(body) };
  }
  throw new Error(
    `Unrecognized community marketplace download payload (content-type=${contentType}, first_bytes=[${[...body.slice(0, 8)].join(', ')}])`,
  );
}

export function parseRetryAfter(headers: Record<string, string>): number | undefined {
  const raw = headers['retry-after'];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  return Math.max(1, Number(trimmed)) * 1000;
}

export function cacheKey(method: string, url: string, jsonBody?: unknown): string {
  return jsonBody === undefined
    ? `${method.toUpperCase()}:${url}`
    : `${method.toUpperCase()}:${url}:${JSON.stringify(jsonBody)}`;
}

function previewText(body: Uint8Array): string {
  return [...utf8Decoder().decode(body)].slice(0, 200).join('');
}

function ensureOk(response: RawHttpResponse, label: string): void {
  if (response.status >= 200 && response.status < 300) return;
  throw new Error(`Community marketplace ${label} failed (HTTP ${response.status}): ${previewText(response.body)}`);
}

export function sanitizeSlug(slug: string): string {
  const trimmed = slug.trim();
  if (!trimmed
    || utf8ByteLength(trimmed) > 128
    || !/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error('Invalid community marketplace skill slug');
  }
  return trimmed;
}

export function urlencodingEncode(value: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(value)) {
    if ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)
      || (byte >= 0x30 && byte <= 0x39) || byte === 0x2d || byte === 0x5f || byte === 0x2e || byte === 0x7e) {
      out += String.fromCharCode(byte);
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

export function encodeSkillMarketProvenance(slug: string, version: string): string {
  return `skill_market:${slug}@${version}`;
}

export function decodeSkillMarketProvenance(detail: string): [string, string] {
  const trimmed = detail.trim();
  if (!trimmed.startsWith('skill_market:')) {
    throw new Error(`Invalid marketplace provenance (expected skill_market:slug@version): ${detail}`);
  }
  const rest = trimmed.slice('skill_market:'.length);
  const at = rest.lastIndexOf('@');
  const slugRaw = at < 0 ? rest : rest.slice(0, at);
  const versionRaw = at < 0 ? '' : rest.slice(at + 1);
  return [sanitizeSlug(slugRaw), versionRaw.trim()];
}

export function skillMarketVersionOutdated(installed: string, remote: string): boolean {
  return remote.trim().length > 0 && remote.trim() !== installed.trim();
}

export interface SkillMarketLogger {
  warn?(message: string): void;
}

const defaultCoreLogger: SkillMarketLogger = {};

export function enforceInstallVerdict(verdict: SkillMarketVerifyResult, slug: string, version: string): void {
  if (!verdict.ok || !verdict.securityPassed) {
    throw new Error(
      `Community marketplace security verification rejected ${slug}@${version}: ${verdict.reasons.join('; ')}`,
    );
  }
  if (verdict.slug !== slug || verdict.version !== version) {
    throw new Error('Community marketplace verification response does not match requested slug/version');
  }
}

// ------------------------------------------------------------------ JSON shapes

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label}: expected a JSON object`);
  }
  return value as JsonObject;
}

function optString(record: JsonObject, key: string, label: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${label}: field \`${key}\` must be a string`);
  return value;
}

function reqString(record: JsonObject, key: string, label: string): string {
  const value = optString(record, key, label);
  if (value === undefined) throw new Error(`${label}: missing field \`${key}\``);
  return value;
}

function optU64(record: JsonObject, key: string, label: string): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label}: field \`${key}\` must be an unsigned integer`);
  }
  return value;
}

function optStringArray(record: JsonObject, key: string, label: string): string[] | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new Error(`${label}: field \`${key}\` must be a string array`);
  }
  return value as string[];
}

function optObject(record: JsonObject, key: string, label: string): JsonObject | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  return objectValue(value, `${label}.${key}`);
}

interface MarketOwner {
  handle: string;
  displayName?: string;
}

function parseOwner(value: JsonObject | undefined, label: string): MarketOwner | undefined {
  if (value === undefined) return undefined;
  return { handle: reqString(value, 'handle', label), displayName: optString(value, 'displayName', label) };
}

interface MarketTags { latest?: string }
function parseTags(value: JsonObject | undefined, label: string): MarketTags | undefined {
  if (value === undefined) return undefined;
  return { latest: optString(value, 'latest', label) };
}

interface MarketStats { downloads?: number; stars?: number }
function parseStats(value: JsonObject | undefined, label: string): MarketStats | undefined {
  if (value === undefined) return undefined;
  return { downloads: optU64(value, 'downloads', label), stars: optU64(value, 'stars', label) };
}

function parseLatestVersion(value: JsonObject | undefined, label: string): { version: string } | undefined {
  if (value === undefined) return undefined;
  return { version: reqString(value, 'version', label) };
}

function parseJsonBody(body: Uint8Array, label: string): JsonObject {
  let parsed: unknown;
  try { parsed = JSON.parse(utf8Decoder().decode(body)); }
  catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return objectValue(parsed, label);
}

function parseVerify(record: JsonObject, label: string, fallbackSlug: string): SkillMarketVerifyResult {
  const security = optObject(record, 'security', label);
  return {
    ok: record.ok === true,
    decision: optString(record, 'decision', label) ?? '',
    reasons: optStringArray(record, 'reasons', label) ?? [],
    slug: optString(record, 'slug', label) ?? fallbackSlug,
    version: optString(record, 'version', label) ?? '',
    securityStatus: security === undefined ? 'unknown' : (optString(security, 'status', label) ?? 'unknown'),
    securityPassed: security !== undefined && security.passed === true,
    publisherHandle: optString(record, 'publisherHandle', label) ?? '',
    publisherDisplayName: optString(record, 'publisherDisplayName', label) ?? '',
  };
}

// ------------------------------------------------------------------ client

export class SkillMarketClient {
  _transport: SkillMarketTransport;
  _cache: ResponseCache;
  _repack: HandoffRepack;

  constructor(transport: SkillMarketTransport, cache: ResponseCache = new ResponseCache(), repack?: HandoffRepack) {
    this._transport = transport;
    this._cache = cache;
    this._repack = repack ?? ((bytes, subdir, fallback) => defaultHandoffRepack(bytes, subdir, fallback));
  }

  get cache(): ResponseCache { return this._cache; }
  get transport(): SkillMarketTransport { return this._transport; }

  async requestCached(method: string, url: string, jsonBody?: unknown): Promise<RawHttpResponse> {
    const key = cacheKey(method, url, jsonBody);
    if (method.toUpperCase() === 'GET') {
      const hit = this._cache.get(key);
      if (hit !== undefined) return hit;
    }
    let attempt = 0;
    for (;;) {
      const response = await this._transport.send(method, url, jsonBody);
      if (response.status === 429 && attempt < MARKET_MAX_429_RETRIES) {
        const wait = parseRetryAfter(response.headers) ?? 2000;
        await sleep(Math.min(wait, 30_000));
        attempt++;
        continue;
      }
      if (response.status === 429) {
        throw new Error(
          `RATE_LIMITED: Community skill marketplace rate limit exceeded (Retry-After=${response.headers['retry-after'] ?? 'unknown'})`,
        );
      }
      if (method.toUpperCase() === 'GET' && response.status === 200) this._cache.put(key, response);
      return response;
    }
  }

  async search(q: string, limit: number, nonSuspiciousOnly: boolean): Promise<SkillMarketSearchResponse> {
    const clamped = Math.max(1, Math.min(MARKET_MAX_LIMIT, Math.trunc(limit)));
    const url = `${COMMUNITY_SKILL_MARKET_BASE}/api/v1/search?q=${urlencodingEncode(q)}&limit=${clamped}&nonSuspiciousOnly=${nonSuspiciousOnly}`;
    const response = await this.requestCached('GET', url);
    ensureOk(response, 'search');
    const parsed = parseJsonBody(response.body, 'Invalid community marketplace search JSON');
    const resultsRaw = parsed.results ?? [];
    if (!Array.isArray(resultsRaw)) throw new Error('Invalid community marketplace search JSON: `results` must be an array');
    const items: SkillMarketSkillCard[] = resultsRaw.map(entry => {
      const item = objectValue(entry, 'Invalid community marketplace search JSON item');
      const owner = parseOwner(optObject(item, 'owner', 'Invalid community marketplace search JSON item'), 'Invalid community marketplace search JSON owner');
      return {
        slug: reqString(item, 'slug', 'Invalid community marketplace search JSON item'),
        displayName: optString(item, 'displayName', 'Invalid community marketplace search JSON item') ?? '',
        summary: optString(item, 'summary', 'Invalid community marketplace search JSON item') ?? '',
        version: optString(item, 'version', 'Invalid community marketplace search JSON item') ?? '',
        downloads: optU64(item, 'downloads', 'Invalid community marketplace search JSON item') ?? 0,
        ownerHandle: optString(item, 'ownerHandle', 'Invalid community marketplace search JSON item') ?? owner?.handle ?? '',
        stars: 0,
      };
    });
    return { mode: 'search', items };
  }

  async listSkills(sort: string, limit: number, nonSuspiciousOnly: boolean): Promise<SkillMarketSearchResponse> {
    const clamped = Math.max(1, Math.min(MARKET_MAX_LIMIT, Math.trunc(limit)));
    const resolvedSort = ['downloads', 'stars', 'trending'].includes(sort) ? sort : 'trending';
    const url = `${COMMUNITY_SKILL_MARKET_BASE}/api/v1/skills?sort=${resolvedSort}&limit=${clamped}&nonSuspiciousOnly=${nonSuspiciousOnly}`;
    const response = await this.requestCached('GET', url);
    ensureOk(response, 'skills');
    const parsed = parseJsonBody(response.body, 'Invalid community marketplace skills JSON');
    const itemsRaw = parsed.items ?? [];
    if (!Array.isArray(itemsRaw)) throw new Error('Invalid community marketplace skills JSON: `items` must be an array');
    const items: SkillMarketSkillCard[] = itemsRaw.map(entry => {
      const item = objectValue(entry, 'Invalid community marketplace skills JSON item');
      const label = 'Invalid community marketplace skills JSON item';
      const tags = parseTags(optObject(item, 'tags', label), label);
      const stats = parseStats(optObject(item, 'stats', label), label);
      const latest = parseLatestVersion(optObject(item, 'latestVersion', label), label);
      return {
        slug: reqString(item, 'slug', label),
        displayName: optString(item, 'displayName', label) ?? '',
        summary: optString(item, 'summary', label) ?? '',
        version: latest?.version ?? tags?.latest ?? '',
        downloads: stats?.downloads ?? 0,
        ownerHandle: '',
        stars: stats?.stars ?? 0,
      };
    });
    return { mode: 'list', items };
  }

  async skillDetail(slugInput: string): Promise<SkillMarketSkillDetail> {
    const slug = sanitizeSlug(slugInput);
    const url = `${COMMUNITY_SKILL_MARKET_BASE}/api/v1/skills/${urlencodingEncode(slug)}`;
    const response = await this.requestCached('GET', url);
    ensureOk(response, 'skill detail');
    const parsed = parseJsonBody(response.body, 'Invalid community marketplace detail JSON');
    const label = 'Invalid community marketplace detail JSON';
    const skill = optObject(parsed, 'skill', label);
    const skillLabel = 'Invalid community marketplace detail JSON skill';
    const tags = skill === undefined ? undefined : parseTags(optObject(skill, 'tags', skillLabel), skillLabel);
    const stats = skill === undefined ? undefined : parseStats(optObject(skill, 'stats', skillLabel), skillLabel);
    const latest = parseLatestVersion(optObject(parsed, 'latestVersion', label), label);
    const owner = parseOwner(optObject(parsed, 'owner', label), label);
    return {
      slug: (skill === undefined ? undefined : optString(skill, 'slug', skillLabel)) ?? slug,
      displayName: skill === undefined ? '' : (optString(skill, 'displayName', skillLabel) ?? ''),
      summary: skill === undefined ? '' : (optString(skill, 'summary', skillLabel) ?? ''),
      description: skill === undefined ? '' : (optString(skill, 'description', skillLabel) ?? ''),
      version: latest?.version ?? tags?.latest ?? '',
      downloads: stats?.downloads ?? 0,
      stars: stats?.stars ?? 0,
      ownerHandle: owner?.handle ?? '',
      ownerDisplayName: owner?.displayName ?? '',
    };
  }

  async verify(slugInput: string, version?: string): Promise<SkillMarketVerifyResult> {
    const slug = sanitizeSlug(slugInput);
    let url = `${COMMUNITY_SKILL_MARKET_BASE}/api/v1/skills/${urlencodingEncode(slug)}/verify`;
    const trimmedVersion = version?.trim();
    if (trimmedVersion) url += `?version=${urlencodingEncode(trimmedVersion)}`;
    const response = await this.requestCached('GET', url);
    ensureOk(response, 'verify');
    const parsed = parseJsonBody(response.body, 'Invalid community marketplace verify JSON');
    return parseVerify(parsed, 'Invalid community marketplace verify JSON', slug);
  }

  async securityVerdicts(items: ReadonlyArray<readonly [string, string]>): Promise<SkillMarketVerifyResult[]> {
    if (!items.length) return [];
    const payload = { items: items.map(([slug, version]) => ({ slug, version })) };
    const url = `${COMMUNITY_SKILL_MARKET_BASE}/api/v1/skills/-/security-verdicts`;
    const response = await this.requestCached('POST', url, payload);
    ensureOk(response, 'security-verdicts');
    const parsed = parseJsonBody(response.body, 'Invalid community marketplace security-verdicts JSON');
    const label = 'Invalid community marketplace security-verdicts JSON';
    const itemsRaw = parsed.items ?? [];
    if (!Array.isArray(itemsRaw)) throw new Error(`${label}: \`items\` must be an array`);
    return itemsRaw.map(entry => {
      const item = objectValue(entry, `${label} item`);
      const security = optObject(item, 'security', `${label} item`);
      return {
        ok: item.ok === true,
        decision: optString(item, 'decision', `${label} item`) ?? '',
        reasons: optStringArray(item, 'reasons', `${label} item`) ?? [],
        slug: optString(item, 'slug', `${label} item`) ?? optString(item, 'requestedSlug', `${label} item`) ?? '',
        version: optString(item, 'version', `${label} item`) ?? optString(item, 'requestedVersion', `${label} item`) ?? '',
        securityStatus: security === undefined ? 'unknown' : (optString(security, 'status', `${label} item`) ?? 'unknown'),
        securityPassed: security !== undefined && security.passed === true,
        publisherHandle: optString(item, 'publisherHandle', `${label} item`) ?? '',
        publisherDisplayName: optString(item, 'publisherDisplayName', `${label} item`) ?? '',
      };
    });
  }

  async downloadPackageBytes(slugInput: string, version?: string): Promise<DownloadedPackage> {
    const slug = sanitizeSlug(slugInput);
    let url = `${COMMUNITY_SKILL_MARKET_BASE}/api/v1/download?slug=${urlencodingEncode(slug)}`;
    const trimmedVersion = version?.trim();
    if (trimmedVersion) url += `&version=${urlencodingEncode(trimmedVersion)}`;

    const response = await this._transport.send('GET', url);
    if (response.status === 429) {
      const wait = parseRetryAfter(response.headers) ?? 2000;
      await sleep(Math.min(wait, 30_000));
      const retried = await this._transport.send('GET', url);
      if (retried.status === 429) {
        throw new Error('RATE_LIMITED: Community skill marketplace download rate limit exceeded');
      }
      return this._resolveDownloadResponse(slug, version, retried);
    }
    return this._resolveDownloadResponse(slug, version, response);
  }

  async _resolveDownloadResponse(slug: string, version: string | undefined, response: RawHttpResponse): Promise<DownloadedPackage> {
    if (response.status === 429) {
      throw new Error('RATE_LIMITED: Community skill marketplace download rate limit exceeded');
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Community skill marketplace download failed (HTTP ${response.status}): ${previewText(response.body)}`);
    }
    const contentType = response.headers['content-type'] ?? '';
    const payload = classifyDownloadPayload(contentType, response.body);
    if (payload.kind === 'zip') {
      return { bytes: payload.bytes, version: version ?? '', sourceKind: 'zip' };
    }
    const handoff = payload.handoff;
    validateHandoffDescriptor(handoff);
    const archiveBytes = await this._fetchUrlBytes(handoff.archiveUrl);
    const repackPath = handoff.path.replace(/^\/+|\/+$/g, '');
    let packageBytes: Uint8Array;
    if (repackPath.length === 0) {
      packageBytes = archiveBytes;
    } else {
      try {
        packageBytes = await this._repack(archiveBytes, repackPath, slug);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith('Handoff repack task failed:')) throw error;
        throw new Error(`Handoff repack failed: ${message}`);
      }
    }
    if (handoff.contentHash !== undefined) {
      const expected = normalizeExpectedSha256(handoff.contentHash);
      const actual = sha256Hex(packageBytes);
      if (actual !== expected) {
        throw new Error(`GitHub handoff contentHash mismatch: expected ${expected}, got ${actual}`);
      }
    }
    return { bytes: packageBytes, version: version ?? '', sourceKind: 'github-handoff', handoff };
  }

  async _fetchUrlBytes(url: string): Promise<Uint8Array> {
    if (!url.startsWith('https://')) throw new Error('Handoff archiveUrl must be https');
    if (!url.startsWith('https://api.github.com/')
      && !url.startsWith('https://codeload.github.com/')
      && !url.startsWith('https://github.com/')) {
      throw new Error(`Handoff archiveUrl host not allowed: ${[...url].slice(0, 80).join('')}`);
    }
    const response = await this._transport.send('GET', url);
    if (response.status === 429) {
      const wait = parseRetryAfter(response.headers) ?? 2000;
      await sleep(Math.min(wait, 30_000));
      const retried = await this._transport.send('GET', url);
      if (retried.status === 429) throw new Error('RATE_LIMITED: GitHub archive rate limit exceeded');
      if (retried.status < 200 || retried.status >= 300) {
        throw new Error(`Failed to download GitHub archive (HTTP ${retried.status})`);
      }
      if (retried.body.length > MAX_SKILL_PACKAGE_ZIP_BYTES) throw new Error('GitHub archive exceeds package size limit');
      return retried.body;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Failed to download GitHub archive (HTTP ${response.status})`);
    }
    if (response.body.length > MAX_SKILL_PACKAGE_ZIP_BYTES) throw new Error('GitHub archive exceeds package size limit');
    return response.body;
  }
}

/** Add advisory security badges to cards that already have a version. */
export async function enrichVerify(
  client: SkillMarketClient,
  input: SkillMarketSkillCard[],
  logger: SkillMarketLogger = defaultCoreLogger,
): Promise<SkillMarketSkillCard[]> {
  const withVersion: Array<[string, string]> = input
    .filter(item => item.version.length > 0)
    .slice(0, 100)
    .map(item => [item.slug, item.version] as [string, string]);
  if (!withVersion.length) return input;
  let verdicts: SkillMarketVerifyResult[];
  try { verdicts = await client.securityVerdicts(withVersion); }
  catch (error) {
    logger.warn?.(`[agent-skills] marketplace badge lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    return input;
  }
  const byKey = new Map(verdicts.map(verdict => [`${verdict.slug}@${verdict.version}`, verdict]));
  for (const item of input) {
    const verdict = byKey.get(`${item.slug}@${item.version}`);
    if (verdict === undefined) continue;
    item.verify = verdict;
    if (item.ownerHandle.length === 0) item.ownerHandle = verdict.publisherHandle;
  }
  return input;
}

// ------------------------------------------------------------------ commands

function marketCommandError(message: string): never {
  if (message.startsWith('RATE_LIMITED:')) {
    throw new CommandError(JSON.stringify({ code: 'OTHER', message }));
  }
  if (message.includes('Invalid') || message.includes('Unsupported') || message.includes('Incomplete')) {
    throw new CommandError(JSON.stringify({ code: 'INVALID_INPUT', message: `Invalid input: ${message}` }));
  }
  throw new CommandError(JSON.stringify({ code: 'IO_ERROR', message: `IO error: ${message}` }));
}

export function marketFailure(error: unknown): never {
  marketCommandError(error instanceof Error ? error.message : String(error));
}

/** Command-line error mapping reused by `SkillMarket`. */
export function failInvalidInput(message: string): never {
  throw new CommandError(JSON.stringify({ code: 'INVALID_INPUT', message: `Invalid input: ${message}` }));
}
