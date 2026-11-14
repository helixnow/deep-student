/**
 * Community skill marketplace: desktop host side of `skill_market_client.rs`.
 *
 * The transport / cache / JSON shapes / `SkillMarketClient` / provenance codec are portable and
 * live in `market-core.ts` (shared with the mobile host). This module re-exports them unchanged
 * and adds the desktop-only pieces: OS temp zip artifacts, the Node zip worker for GitHub
 * handoff repacks, the four-command facade and the agent tool executors.
 */
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HttpService } from '../../../platform/http/api.ts';
import { now as currentInstant } from '../../../platform/time/index.ts';
import type {
  SkillMarketDownloadScanResult, SkillMarketSearchResponse, SkillMarketSkillDetail, SkillMarketVerifyResult,
} from '../api.ts';
import { fail } from './files.ts';
import { DEFAULT_AGENT_SKILLS_BASE, MAX_SKILL_PACKAGE_ZIP_BYTES, type SkillPackages } from './skill-package.ts';
import { isZipWorkerInfrastructureError, runZipTask } from './workers/zip-pool.ts';
import {
  GLOBAL_MARKET_CACHE, MARKET_DEFAULT_LIMIT, PROVENANCE_SETTINGS_PREFIX, TEMP_ARTIFACT_MAX_AGE_MS,
  HttpSkillMarketTransport, SkillMarketClient, enrichVerify, encodeSkillMarketProvenance,
  enforceInstallVerdict, marketFailure, normalizeExpectedSha256, setDefaultHandoffRepack,
  type DownloadedPackage, type SkillMarketLogger,
} from './market-core.ts';

// Portable marketplace API: same values `api.ts` re-exports.
export {
  COMMUNITY_SKILL_MARKET_BASE, GLOBAL_MARKET_CACHE, HttpSkillMarketTransport, MARKET_CACHE_TTL_MS,
  MARKET_DEFAULT_LIMIT, MARKET_MAX_429_RETRIES, MARKET_MAX_LIMIT, MARKET_REQUEST_TIMEOUT_MS,
  MARKET_USER_AGENT, PROVENANCE_SETTINGS_PREFIX, ResponseCache, SkillMarketClient,
  TEMP_ARTIFACT_MAX_AGE_MS, cacheKey, classifyDownloadPayload, decodeSkillMarketProvenance,
  encodeSkillMarketProvenance, enrichVerify, enforceInstallVerdict, isAllowedSkillMarketTransportUrl,
  marketFailure, normalizeExpectedSha256, parseRetryAfter, sanitizeSlug, sha256Hex,
  skillMarketVersionOutdated, urlencodingEncode, validateHandoffDescriptor,
} from './market-core.ts';
export type {
  DownloadPayload, DownloadedPackage, GitHubHandoff, HandoffRepack, RawHttpResponse, SkillMarketLogger,
  SkillMarketTransport,
} from './market-core.ts';

// GitHub handoff repacks stay on the Node zip worker (desktop only); the mobile host injects
// its own portable-core repack into `SkillMarketClient`.
setDefaultHandoffRepack((zipBytes, subdir, fallbackDirName) => runZipTask<Uint8Array>('repackSkillSubdir', {
  zipBytes, subdir, fallbackDirName,
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (isZipWorkerInfrastructureError(error)) throw new Error(`Handoff repack task failed: ${message}`);
  throw error;
}));

const TEMP_ARTIFACT_DIR = 'deep-student-skill-market';

const defaultMarketLogger: SkillMarketLogger = {
  warn: message => process.emitWarning(message),
};

function tempArtifactDir(): string {
  return path.join(tmpdir(), TEMP_ARTIFACT_DIR);
}

export function shouldRemoveTempArtifact(modifiedMs: number, nowMs: number): boolean {
  return nowMs - modifiedMs > TEMP_ARTIFACT_MAX_AGE_MS;
}

function cleanupStaleTempArtifacts(dir: string, logger: SkillMarketLogger): void {
  let entries: string[];
  try { entries = readdirSync(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn?.(`[agent-skills] failed to list market temp dir: ${(error as Error).message}`);
    }
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    const target = path.join(dir, name);
    if (path.extname(target) !== '.zip') continue;
    let metadata;
    try { metadata = statSync(target); }
    catch (error) {
      logger.warn?.(`[agent-skills] failed to inspect market temp artifact: ${(error as Error).message}`);
      continue;
    }
    if (metadata.isFile() && shouldRemoveTempArtifact(metadata.mtimeMs, now)) {
      try { rmSync(target, { force: true }); }
      catch (error) { logger.warn?.(`[agent-skills] failed to remove stale market temp artifact: ${(error as Error).message}`); }
    }
  }
}

/** Port of skill_market_client.rs:857 `write_temp_zip`. */
export function writeTempZip(
  slug: string,
  bytes: Uint8Array,
  logger: SkillMarketLogger = defaultMarketLogger,
): string {
  const dir = tempArtifactDir();
  try { mkdirSync(dir, { recursive: true }); }
  catch (error) { throw new Error(`Failed to create temp dir: ${(error as Error).message}`); }
  cleanupStaleTempArtifacts(dir, logger);
  const safe = [...slug].map(ch => /^[A-Za-z0-9_-]$/.test(ch) ? ch : '_').join('');
  const target = path.join(dir, `${safe}-${process.pid}-${Date.now()}.zip`);
  try { writeFileSync(target, bytes); }
  catch (error) { throw new Error(`Failed to write temp zip: ${(error as Error).message}`); }
  return target;
}

export class TempArtifactCleanup {
  _path: string;
  _logger: SkillMarketLogger;
  constructor(target: string, logger: SkillMarketLogger = defaultMarketLogger) {
    this._path = target;
    this._logger = logger;
  }

  dispose(): void {
    try { rmSync(this._path, { force: true }); }
    catch (error) { this._logger.warn?.(`[agent-skills] failed to remove market scan artifact: ${(error as Error).message}`); }
  }
}

/** Port of skill_market_client.rs:923 `read_bound_temp_zip`. */
export function readBoundTempZip(
  target: string,
  logger: SkillMarketLogger = defaultMarketLogger,
): { bytes: Uint8Array; cleanup: TempArtifactCleanup } {
  const base = tempArtifactDir();
  let canonicalBase: string;
  try { canonicalBase = realpathSync(base); }
  catch (error) {
    throw new Error(`Community marketplace scan artifact directory is unavailable: ${(error as Error).message}`);
  }
  let canonical: string;
  try { canonical = realpathSync(target); }
  catch (error) {
    throw new Error(`Community marketplace scan artifact is unavailable: ${(error as Error).message}`);
  }
  const relative = path.relative(canonicalBase, canonical);
  if (relative.startsWith('..') || path.isAbsolute(relative) || path.extname(canonical) !== '.zip') {
    throw new Error('Invalid community marketplace scan artifact path');
  }
  let metadata;
  try { metadata = lstatSync(canonical); }
  catch (error) {
    throw new Error(`Failed to inspect community marketplace scan artifact: ${(error as Error).message}`);
  }
  if (!metadata.isFile() || metadata.size > MAX_SKILL_PACKAGE_ZIP_BYTES) {
    throw new Error('Invalid or oversized community marketplace scan artifact');
  }
  let bytes: Uint8Array;
  try { bytes = readFileSync(canonical); }
  catch (error) { throw new Error(`Failed to read community marketplace scan artifact: ${(error as Error).message}`); }
  return { bytes: new Uint8Array(bytes), cleanup: new TempArtifactCleanup(canonical, logger) };
}

export interface MarketSettingsWriter {
  (key: string, value: string): void;
}

export class SkillMarket {
  _client: SkillMarketClient;
  _packages: SkillPackages;
  _saveSetting: MarketSettingsWriter;
  _logger: SkillMarketLogger;

  constructor(
    client: SkillMarketClient,
    packages: SkillPackages,
    saveSetting: MarketSettingsWriter,
    logger: SkillMarketLogger = defaultMarketLogger,
  ) {
    this._client = client;
    this._packages = packages;
    this._saveSetting = saveSetting;
    this._logger = logger;
  }

  async search(
    q: string | null | undefined,
    limit: number | null | undefined,
    nonSuspiciousOnly: boolean | null | undefined,
    sort: string | null | undefined,
  ): Promise<SkillMarketSearchResponse> {
    const resolvedLimit = limit ?? MARKET_DEFAULT_LIMIT;
    const resolvedFlag = nonSuspiciousOnly ?? true;
    const resolvedSort = sort ?? 'trending';
    const query = q ?? '';
    let result: SkillMarketSearchResponse;
    try {
      result = query.trim().length === 0
        ? await this._client.listSkills(resolvedSort, resolvedLimit, resolvedFlag)
        : await this._client.search(query.trim(), resolvedLimit, resolvedFlag);
    } catch (error) { return marketFailure(error); }
    result.items = await enrichVerify(this._client, result.items, this._logger);
    return result;
  }

  async detail(slug: string): Promise<SkillMarketSkillDetail> {
    try { return await this._client.skillDetail(slug); }
    catch (error) { return marketFailure(error); }
  }

  async verify(slug: string, version: string | null | undefined): Promise<SkillMarketVerifyResult> {
    try { return await this._client.verify(slug, version ?? undefined); }
    catch (error) { return marketFailure(error); }
  }

  async downloadAndScan(
    slug: string,
    version: string | null | undefined,
    install: boolean | null | undefined,
    overwrite: boolean | null | undefined,
    expectedPackageSha256: string | null | undefined,
    tempZipPath: string | null | undefined,
    declaredRiskLevel: string | null | undefined,
  ): Promise<SkillMarketDownloadScanResult> {
    const shouldInstall = install ?? false;
    const allowOverwrite = overwrite ?? false;

    let resolvedVersion = version ?? '';
    const resolutionErrors: string[] = [];
    if (resolvedVersion.trim().length === 0) {
      try {
        const verdict = await this._client.verify(slug);
        resolvedVersion = verdict.version;
      } catch (error) {
        resolutionErrors.push(`verify: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (resolvedVersion.trim().length === 0) {
      try {
        const detail = await this._client.skillDetail(slug);
        resolvedVersion = detail.version;
      } catch (error) {
        resolutionErrors.push(`detail: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (resolvedVersion.length === 0) {
      fail('INVALID_INPUT', `Community marketplace version could not be resolved${resolutionErrors.length ? ` (${resolutionErrors.join('; ')})` : ''}`);
    }
    const provenance = encodeSkillMarketProvenance(slug, resolvedVersion);

    if (!shouldInstall) {
      let downloaded: DownloadedPackage;
      try { downloaded = await this._client.downloadPackageBytes(slug, resolvedVersion); }
      catch (error) { return marketFailure(error); }
      let tempPath: string;
      try { tempPath = writeTempZip(slug, downloaded.bytes, this._logger); }
      catch (error) { return fail('IO_ERROR', error instanceof Error ? error.message : String(error)); }
      const scan = await this._packages.install(
        downloaded.bytes, DEFAULT_AGENT_SKILLS_BASE, allowOverwrite, true,
      );
      return {
        slug,
        version: resolvedVersion,
        provenance,
        tempZipPath: tempPath,
        sourceKind: downloaded.sourceKind,
        scan,
        installed: false,
      };
    }

    if (expectedPackageSha256 === null || expectedPackageSha256 === undefined) {
      fail('INVALID_INPUT', 'expectedPackageSha256 is required when installing a community marketplace skill');
    }
    let expected: string;
    try { expected = normalizeExpectedSha256(expectedPackageSha256); }
    catch (error) { return fail('INVALID_INPUT', error instanceof Error ? error.message : String(error)); }
    if (tempZipPath === null || tempZipPath === undefined) {
      fail('INVALID_INPUT', 'tempZipPath from the confirmed community marketplace scan is required when installing');
    }

    let artifact: { bytes: Uint8Array; cleanup: TempArtifactCleanup };
    try { artifact = readBoundTempZip(tempZipPath, this._logger); }
    catch (error) { return fail('INVALID_INPUT', error instanceof Error ? error.message : String(error)); }
    try {
      let verdict: SkillMarketVerifyResult;
      try { verdict = await this._client.verify(slug, resolvedVersion); }
      catch (error) { return marketFailure(error); }
      try { enforceInstallVerdict(verdict, slug, resolvedVersion); }
      catch (error) { return fail('INVALID_INPUT', error instanceof Error ? error.message : String(error)); }

      const prepared = await this._packages.prepare(artifact.bytes, DEFAULT_AGENT_SKILLS_BASE, allowOverwrite);
      try {
        if (prepared.result.package_sha256 !== expected) {
          fail('INVALID_INPUT',
            `Community marketplace package changed after confirmation: expected ${expected}, got ${prepared.result.package_sha256}`);
        }
        const declared = declaredRiskLevel?.trim();
        if (declared === undefined || !['low', 'medium', 'high'].includes(declared)) {
          fail('INVALID_INPUT',
            'declaredRiskLevel is required when installing and must match the preceding scan');
        }
        if (prepared.result.risk_level !== declared) {
          fail('INVALID_INPUT',
            `Community marketplace risk changed after confirmation: declared ${declared}, detected ${prepared.result.risk_level}`);
        }

        const provenanceJson = JSON.stringify({
          sourceKind: 'skill_market',
          sourceDetail: provenance,
          packageSha256: prepared.result.package_sha256,
          riskLevel: prepared.result.risk_level,
          installedAt: currentInstant().rfc3339,
          sessionId: 'skills_management',
          marketSlug: slug,
          marketVersion: resolvedVersion,
        }, null, 2);
        try { prepared.writeStagedFile('AGENT_INSTALLED.json', Buffer.from(provenanceJson)); }
        catch (error) { return fail('IO_ERROR', error instanceof Error ? error.message : String(error)); }

        const [installedResult, committed] = prepared.commit();
        const key = `${PROVENANCE_SETTINGS_PREFIX}${installedResult.skill_id}`;
        let persistError: unknown;
        try { this._saveSetting(key, provenanceJson); }
        catch (error) { persistError = error; }
        if (persistError !== undefined) {
          const message = persistError instanceof Error ? persistError.message : String(persistError);
          try { committed.rollback(); }
          catch (rollbackError) {
            fail('IO_ERROR',
              `Failed to persist skill market provenance (${message}), and rollback also failed (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}).`);
          }
          fail('IO_ERROR', `Failed to persist skill market provenance (${message}); the install was rolled back.`);
        }
        committed.finalize();
        return {
          slug,
          version: resolvedVersion,
          provenance,
          sourceKind: 'confirmed-scan-artifact',
          scan: installedResult,
          installed: true,
        };
      } finally {
        prepared.dispose();
      }
    } finally {
      artifact.cleanup.dispose();
    }
  }
}

/** The plugin's client: requests go through `ctx.http`, responses share the process-wide 5-minute cache. */
export function skillMarketClient(http: () => HttpService | null): SkillMarketClient {
  return new SkillMarketClient(new HttpSkillMarketTransport(http), GLOBAL_MARKET_CACHE);
}

// ---------------------------------------------------------- agent tool executors

export const SKILL_MARKET_SEARCH_TOOL = 'skill_market_search';
export const SKILL_MARKET_DETAIL_TOOL = 'skill_market_skill_detail';
export const SKILL_MARKET_VERIFY_TOOL = 'skill_market_verify';
export const SKILL_MARKET_DOWNLOAD_SCAN_TOOL = 'skill_market_download_and_scan';

export type MarketToolSensitivity = 'low' | 'medium' | 'high';
export type MarketToolConcurrency = 'read_only' | 'serial';

function marketShortName(toolName: string): string {
  if (toolName.startsWith('builtin-')) return toolName.slice(8);
  if (toolName.startsWith('mcp_')) return toolName.slice(4);
  return toolName;
}

/** Read-only marketplace search/detail executor (`SkillMarketReadToolExecutor`). */
export class SkillMarketReadToolExecutor {
  canHandle(toolName: string): boolean {
    const short = marketShortName(toolName);
    return short === SKILL_MARKET_SEARCH_TOOL || short === SKILL_MARKET_DETAIL_TOOL;
  }

  sensitivityLevel(_toolName: string): MarketToolSensitivity { return 'low'; }
  concurrencyClass(_toolName: string): MarketToolConcurrency { return 'read_only'; }
  name(): string { return 'SkillMarketReadToolExecutor'; }
}

/** Verification/download executor with dynamic install sensitivity. */
export class SkillMarketInstallToolExecutor {
  canHandle(toolName: string): boolean {
    const short = marketShortName(toolName);
    return short === SKILL_MARKET_VERIFY_TOOL || short === SKILL_MARKET_DOWNLOAD_SCAN_TOOL;
  }

  sensitivityLevel(toolName: string): MarketToolSensitivity {
    return marketShortName(toolName) === SKILL_MARKET_VERIFY_TOOL ? 'low' : 'high';
  }

  sensitivityLevelForCall(
    toolName: string,
    argumentsValue: unknown,
  ): MarketToolSensitivity {
    const record = typeof argumentsValue === 'object' && argumentsValue !== null
      && !Array.isArray(argumentsValue)
      ? argumentsValue as Record<string, unknown> : {};
    if (marketShortName(toolName) === SKILL_MARKET_DOWNLOAD_SCAN_TOOL
      && record.install !== true) {
      return 'medium';
    }
    return this.sensitivityLevel(toolName);
  }

  hasDynamicSensitivity(toolName: string): boolean {
    return marketShortName(toolName) === SKILL_MARKET_DOWNLOAD_SCAN_TOOL;
  }

  concurrencyClass(toolName: string): MarketToolConcurrency {
    return marketShortName(toolName) === SKILL_MARKET_VERIFY_TOOL ? 'read_only' : 'serial';
  }

  name(): string { return 'SkillMarketInstallToolExecutor'; }
}
