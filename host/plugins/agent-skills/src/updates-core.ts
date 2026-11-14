/**
 * Portable skill update checking and one-click updates (`skill_updates.rs`).
 *
 * Provenance records live in the main `settings` table under `skill.provenance.<skillId>`.
 * Only `url`, `tap` and `skill_market` sources can be re-fetched; everything else is
 * reported as non-checkable.
 *
 * Because the installer lifecycle differs per host (desktop staging + rename, mobile
 * `ctx.files`), this module only depends on the `UpdatePackages` seam and on injected
 * repo-fetch/repack functions. `skill-updates.ts` re-exports it for the desktop host;
 * `src/mobile/updates.ts` binds the mobile installer.
 */
import { sha256HexSync } from '../../../platform/crypto/sync.ts';
import type { HttpService } from '../../../platform/http/api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { now } from '../../../platform/time/index.ts';
import type { SkillImportZipResult, SkillUpdateApplyResult, SkillUpdateCheckResult } from '../api.ts';
import { fail } from './errors-core.ts';
import { downloadHttpsBytes, skillDownloadHttp } from './http.ts';
import {
  decodeSkillMarketProvenance, encodeSkillMarketProvenance, PROVENANCE_SETTINGS_PREFIX,
  skillMarketVersionOutdated, type SkillMarketClient,
} from './market-core.ts';
import { MAX_SKILL_PACKAGE_ZIP_BYTES } from './package-core.ts';
import { decodeTapSourceDetail, fetchRepoZip, repoNameFromZipUrl } from './taps-core.ts';
import { repackSkillSubdir as portableRepack } from './repack-core.ts';

export interface StoredProvenance {
  sourceKind: string;
  sourceDetail: string;
  packageSha256: string;
  riskLevel: string;
  installedAt: string;
  sessionId: string;
  marketSlug?: string;
  marketVersion?: string;
}

export function isValidSkillId(skillId: string): boolean {
  return skillId.length > 0 && /^[A-Za-z0-9_-]+$/.test(skillId);
}

/** Parse the camelCase provenance record written by installers. */
export function parseStoredProvenance(raw: string): StoredProvenance {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('expected a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const required = (key: string): string => {
    const value = record[key];
    if (typeof value !== 'string') throw new Error(`missing field \`${key}\``);
    return value;
  };
  const optional = (key: string): string => {
    const value = record[key];
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw new Error(`field \`${key}\` must be a string`);
    return value;
  };
  const optionalNullable = (key: string): string | undefined => {
    const value = record[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw new Error(`field \`${key}\` must be a string`);
    return value;
  };
  return {
    sourceKind: required('sourceKind'),
    sourceDetail: required('sourceDetail'),
    packageSha256: required('packageSha256'),
    riskLevel: optional('riskLevel'),
    installedAt: optional('installedAt'),
    sessionId: optional('sessionId'),
    ...(optionalNullable('marketSlug') !== undefined ? { marketSlug: optionalNullable('marketSlug') } : {}),
    ...(optionalNullable('marketVersion') !== undefined ? { marketVersion: optionalNullable('marketVersion') } : {}),
  };
}

function loadProvenance(settings: SettingsStore, skillId: string): StoredProvenance {
  const key = `${PROVENANCE_SETTINGS_PREFIX}${skillId}`;
  let raw: string | null;
  try { raw = settings.get(key); }
  catch (error) {
    return fail('IO_ERROR', `Failed to read skill provenance: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw === null || raw === undefined) {
    fail('RESOURCE_NOT_FOUND',
      `No install provenance recorded for skill '${skillId}'; only link/zip-installed skills can be update-checked`);
  }
  try { return parseStoredProvenance(raw); }
  catch (error) {
    return fail('IO_ERROR', `Corrupted provenance record for skill '${skillId}': ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** `resolve_skill_market_identity`: explicit provenance fields win over sourceDetail. */
export function resolveSkillMarketIdentity(
  provenance: StoredProvenance,
  logger: SkillUpdateLogger = defaultUpdateLogger,
): [string, string] {
  const explicitSlug = provenance.marketSlug?.trim();
  if (explicitSlug) {
    const explicitVersion = provenance.marketVersion?.trim();
    let version = explicitVersion ?? '';
    if (!version) {
      try { version = decodeSkillMarketProvenance(provenance.sourceDetail)[1]; }
      catch (error) {
        logger.warn?.(`[agent-skills] failed to decode market provenance: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return [explicitSlug, version];
  }
  return decodeSkillMarketProvenance(provenance.sourceDetail);
}

export function isRefetchableKind(sourceKind: string): boolean {
  return sourceKind === 'url' || sourceKind === 'tap' || sourceKind === 'skill_market';
}

export interface SkillUpdateLogger {
  warn?(message: string): void;
}

// Portable default: hosts that want warnings pass their own logger (`skill-updates.ts`
// keeps the desktop plugin's `ctx.logger`; nothing here may touch `process`).
const defaultUpdateLogger: SkillUpdateLogger = {};

export const AGENT_INSTALLED_MARKER = 'AGENT_INSTALLED.json';
export const DEFAULT_AGENT_SKILLS_BASE = '~/.deep-student/skills';

/** 两端安装器共有的提交生命周期（桌面同步暂存 / 移动端 ctx.files）。 */
export interface UpdateCommittedPackage {
  rollback(): Promise<void> | void;
  finalize(): Promise<void> | void;
}

export interface UpdatePreparedPackage {
  result: SkillImportZipResult;
  writeStagedFile(relative: string, bytes: Uint8Array): Promise<void> | void;
  commit(): Promise<[SkillImportZipResult, UpdateCommittedPackage]> | [SkillImportZipResult, UpdateCommittedPackage];
  dispose(): Promise<void> | void;
}

export interface UpdatePackages {
  install(zipBytes: Uint8Array, basePath: string, overwrite: boolean, dryRun: boolean): Promise<SkillImportZipResult>;
  prepare(zipBytes: Uint8Array, basePath: string, overwrite: boolean): Promise<UpdatePreparedPackage>;
}

export interface SkillUpdateDeps {
  settings: () => SettingsStore;
  packages: UpdatePackages;
  marketClient: () => SkillMarketClient;
  /** `ctx.http` for url / tap re-downloads. */
  http: () => HttpService | null;
  /** Tap repack implementation; desktop binds the Node worker, mobile the portable core. */
  repack?: SkillSubdirRepack;
  /** Repository zip fetch override (tests / hosts with a custom downloader). */
  fetchRepo?: RepoZipFetcher;
  logger?: SkillUpdateLogger;
}

export type RepoZipFetcher = (
  candidates: readonly string[],
) => Promise<[Uint8Array, string]>;

/**
 * Re-fetch canonical package bytes: url → direct zip; tap → repo zip repack;
 * skill_market → market download (including GitHub handoff).
 */
export interface RefetchDeps {
  fetchRepo?: RepoZipFetcher;
  repack?: SkillSubdirRepack;
}

export type SkillSubdirRepack = (zipBytes: Uint8Array, subdir: string, fallbackDirName: string) => Promise<Uint8Array>;

/** Hosts that do not inject a worker use the portable ZIP core (Node 26 and mobile both have it). */
const defaultRepack: SkillSubdirRepack = (zipBytes, subdir, fallbackDirName) =>
  portableRepack(zipBytes, subdir, fallbackDirName);

export async function refetchPackageBytes(
  provenance: StoredProvenance,
  marketClient: () => SkillMarketClient,
  http: () => HttpService | null,
  logger: SkillUpdateLogger = defaultUpdateLogger,
  deps: RefetchDeps | RepoZipFetcher = {},
): Promise<{ bytes: Uint8Array; remoteVersion?: string }> {
  // Older callers passed the repo fetcher as the fifth argument; keep that shape working.
  const options: RefetchDeps = typeof deps === 'function' ? { fetchRepo: deps } : deps;
  const fetchRepo = options.fetchRepo ?? (candidates => fetchRepoZip(candidates, skillDownloadHttp(http)));
  if (provenance.sourceKind === 'url') {
    const bytes = await downloadHttpsBytes(provenance.sourceDetail, MAX_SKILL_PACKAGE_ZIP_BYTES, skillDownloadHttp(http));
    return { bytes };
  }
  if (provenance.sourceKind === 'tap') {
    const [zipUrl, subdir] = decodeTapSourceDetail(provenance.sourceDetail);
    const [repoBytes, resolvedUrl] = await fetchRepo([zipUrl]);
    const fallback = repoNameFromZipUrl(resolvedUrl);
    const bytes = await (options.repack ?? defaultRepack)(repoBytes, subdir, fallback);
    return { bytes };
  }
  if (provenance.sourceKind === 'skill_market') {
    const [slug] = resolveSkillMarketIdentity(provenance, logger);
    const client = marketClient();
    let remoteVersion = '';
    try { remoteVersion = (await client.skillDetail(slug)).version; }
    catch (error) {
      logger.warn?.(`[agent-skills] failed to resolve market detail: ${error instanceof Error ? error.message : String(error)}`);
    }
    const downloaded = await client.downloadPackageBytes(slug, remoteVersion || undefined);
    return { bytes: downloaded.bytes, remoteVersion: downloaded.version || remoteVersion };
  }
  throw new Error(`Source kind '${provenance.sourceKind}' is not refetchable`);
}

function resultBase(
  skillId: string, provenance: StoredProvenance, checkable: boolean,
): SkillUpdateCheckResult {
  return {
    skillId,
    checkable,
    updateAvailable: false,
    sourceKind: provenance.sourceKind,
    sourceSummary: provenance.sourceDetail,
    currentSha256: provenance.packageSha256,
    remoteSha256: null,
    error: null,
  };
}

async function checkSkillMarketOne(
  skillId: string,
  provenance: StoredProvenance,
  marketClient: () => SkillMarketClient,
  logger: SkillUpdateLogger,
): Promise<SkillUpdateCheckResult> {
  let slug: string;
  let installedVersion: string;
  try { [slug, installedVersion] = resolveSkillMarketIdentity(provenance, logger); }
  catch (error) {
    return { ...resultBase(skillId, provenance, true), error: error instanceof Error ? error.message : String(error) };
  }

  let client: SkillMarketClient;
  try { client = marketClient(); }
  catch (error) {
    return {
      ...resultBase(skillId, provenance, true),
      currentVersion: installedVersion,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const remoteVersion = (await client.skillDetail(slug)).version;
    const outdated = skillMarketVersionOutdated(installedVersion, remoteVersion);
    return {
      ...resultBase(skillId, provenance, true),
      updateAvailable: outdated,
      currentVersion: installedVersion,
      ...(remoteVersion.length > 0 ? { remoteVersion } : {}),
    };
  } catch (error) {
    return {
      ...resultBase(skillId, provenance, true),
      currentVersion: installedVersion,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkOne(
  skillId: string,
  provenance: StoredProvenance,
  marketClient: () => SkillMarketClient,
  http: () => HttpService | null,
  logger: SkillUpdateLogger,
  refetch: RefetchDeps,
): Promise<SkillUpdateCheckResult> {
  if (provenance.sourceKind === 'skill_market') {
    return checkSkillMarketOne(skillId, provenance, marketClient, logger);
  }
  if (!isRefetchableKind(provenance.sourceKind)) {
    return resultBase(skillId, provenance, false);
  }
  try {
    const { bytes } = await refetchPackageBytes(provenance, marketClient, http, logger, refetch);
    const remote = createSha256(bytes);
    return {
      ...resultBase(skillId, provenance, true),
      updateAvailable: remote !== provenance.packageSha256,
      remoteSha256: remote,
    };
  } catch (error) {
    return {
      ...resultBase(skillId, provenance, true),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function createSha256(bytes: Uint8Array): string {
  return sha256HexSync(bytes);
}

export class SkillUpdates {
  _deps: SkillUpdateDeps;
  _logger: SkillUpdateLogger;

  constructor(deps: SkillUpdateDeps) {
    this._deps = deps;
    this._logger = deps.logger ?? defaultUpdateLogger;
  }

  async check(skillIds?: readonly string[] | null): Promise<SkillUpdateCheckResult[]> {
    const settings = this._settings();
    let entries;
    try { entries = settings.listByPrefix(PROVENANCE_SETTINGS_PREFIX); }
    catch (error) {
      return fail('IO_ERROR', `Failed to list skill provenance: ${error instanceof Error ? error.message : String(error)}`);
    }
    const filter = skillIds === null || skillIds === undefined ? null : new Set(skillIds);
    const targets: Array<[string, StoredProvenance]> = [];
    for (const entry of entries) {
      if (!entry.key.startsWith(PROVENANCE_SETTINGS_PREFIX)) continue;
      const skillId = entry.key.slice(PROVENANCE_SETTINGS_PREFIX.length);
      if (!isValidSkillId(skillId)) continue;
      if (filter !== null && !filter.has(skillId)) continue;
      try { targets.push([skillId, parseStoredProvenance(entry.value)]); }
      catch (error) {
        this._logger.warn?.(
          `[agent-skills] skipping corrupted provenance for '${skillId}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const results: SkillUpdateCheckResult[] = [];
    for (const [skillId, provenance] of targets) {
      results.push(await checkOne(skillId, provenance, this._deps.marketClient, this._deps.http, this._logger, {
        ...(this._deps.fetchRepo !== undefined ? { fetchRepo: this._deps.fetchRepo } : {}),
        ...(this._deps.repack !== undefined ? { repack: this._deps.repack } : {}),
      }));
    }
    return results;
  }

  async updateFromSource(skillIdInput: string): Promise<SkillUpdateApplyResult> {
    const settings = this._settings();
    const skillId = skillIdInput.trim();
    if (!isValidSkillId(skillId)) {
      fail('INVALID_INPUT', 'Skill ID can only contain letters, numbers, hyphens, and underscores');
    }
    const provenance = loadProvenance(settings, skillId);
    if (!isRefetchableKind(provenance.sourceKind)) {
      fail('INVALID_INPUT',
        `Skill '${skillId}' was installed from a non-refetchable source (${provenance.sourceKind}); reinstall it manually`);
    }

    let bytes: Uint8Array;
    let marketRemoteVersion: string | undefined;
    try {
      const refetched = await refetchPackageBytes(provenance, this._deps.marketClient, this._deps.http, this._logger, {
        ...(this._deps.fetchRepo !== undefined ? { fetchRepo: this._deps.fetchRepo } : {}),
        ...(this._deps.repack !== undefined ? { repack: this._deps.repack } : {}),
      });
      bytes = refetched.bytes;
      marketRemoteVersion = refetched.remoteVersion;
    } catch (error) {
      return fail('IO_ERROR', error instanceof Error ? error.message : String(error));
    }
    const remoteSha256 = createSha256(bytes);

    const marketVersionBumped = provenance.sourceKind === 'skill_market'
      && marketRemoteVersion !== undefined
      && skillMarketVersionOutdated(installedMarketVersion(provenance), marketRemoteVersion);

    if (remoteSha256 === provenance.packageSha256 && !marketVersionBumped) {
      return {
        skillId,
        updated: false,
        packageSha256: provenance.packageSha256,
        riskLevel: provenance.riskLevel,
        path: '',
        trustStatus: 'unchanged',
      };
    }

    const scan = await this._deps.packages.install(bytes, DEFAULT_AGENT_SKILLS_BASE, true, true);
    if (scan.skill_id !== skillId) {
      fail('INVALID_INPUT',
        `Upstream package now installs '${scan.skill_id}' instead of '${skillId}'; refusing to update. Reinstall it as a new skill if intended.`);
    }

    const prepared = await this._deps.packages.prepare(bytes, DEFAULT_AGENT_SKILLS_BASE, true);
    try {
      let sourceDetail = provenance.sourceDetail;
      let marketSlug: string | undefined;
      let marketVersion: string | undefined;
      if (provenance.sourceKind === 'skill_market') {
        try { [marketSlug] = resolveSkillMarketIdentity(provenance, this._logger); }
        catch (error) { return fail('INVALID_INPUT', error instanceof Error ? error.message : String(error)); }
        marketVersion = marketRemoteVersion !== undefined && marketRemoteVersion.trim().length > 0
          ? marketRemoteVersion
          : (provenance.marketVersion ?? 'unknown');
        sourceDetail = encodeSkillMarketProvenance(marketSlug, marketVersion);
      }

      const newProvenance: Record<string, unknown> = {
        sourceKind: provenance.sourceKind,
        sourceDetail,
        packageSha256: prepared.result.package_sha256,
        riskLevel: prepared.result.risk_level,
        installedAt: now().rfc3339,
        sessionId: provenance.sessionId,
        updatedFromSha256: provenance.packageSha256,
      };
      if (marketSlug !== undefined) newProvenance.marketSlug = marketSlug;
      if (marketVersion !== undefined) newProvenance.marketVersion = marketVersion;
      const provenanceJson = JSON.stringify(newProvenance, null, 2);
      try { await prepared.writeStagedFile(AGENT_INSTALLED_MARKER, new TextEncoder().encode(provenanceJson)); }
      catch (error) { return fail('IO_ERROR', error instanceof Error ? error.message : String(error)); }

      const [installed, committed] = await prepared.commit();
      const key = `${PROVENANCE_SETTINGS_PREFIX}${skillId}`;
      let persistError: unknown;
      try { settings.save(key, provenanceJson); }
      catch (error) { persistError = error; }
      if (persistError !== undefined) {
        const message = persistError instanceof Error ? persistError.message : String(persistError);
        try { await committed.rollback(); }
        catch (rollbackError) {
          fail('IO_ERROR',
            `Failed to persist updated provenance (${message}), and failed to restore the previous skill (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}).`);
        }
        fail('IO_ERROR', `Failed to persist updated provenance (${message}); the previous skill was restored.`);
      }
      await committed.finalize();

      return {
        skillId,
        updated: true,
        packageSha256: installed.package_sha256,
        riskLevel: installed.risk_level,
        path: installed.path,
        trustStatus: 'untrusted',
      };
    } finally {
      prepared.dispose();
    }
  }

  _settings(): SettingsStore {
    return this._deps.settings();
  }
}

function installedMarketVersion(provenance: StoredProvenance): string {
  if (provenance.marketVersion !== undefined) return provenance.marketVersion;
  try { return resolveSkillMarketIdentity(provenance)[1]; }
  catch { return ''; }
}
