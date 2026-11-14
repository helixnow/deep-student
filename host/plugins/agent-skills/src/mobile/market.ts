/**
 * 移动端社区技能市场命令（搜索 / 详情 / 校验 / 下载并扫描）。
 *
 * 传输、缓存、JSON 解码与 provenance 编码都在 `market-core.ts`，与桌面同一实现；
 * 这里只补 `ctx.files` 版本的市场临时 zip：
 * - 扫描流程把下载的包写到 `<appData>/temp/skill-market/<slug>-<ms>.zip` 并返回路径；
 * - 安装流程只接受该目录内的 `.zip`（词法包含判断，OPFS 没有符号链接），读完即删；
 * - 24 小时前的残留包在每次写入前清理（对应 Rust `cleanup_stale_temp_artifacts`）。
 */
import type { HttpService } from '../../../../platform/http/api.ts';
import type {
  SkillMarketDownloadScanResult, SkillMarketSearchResponse, SkillMarketSkillDetail, SkillMarketVerifyResult,
} from '../../api.ts';
import { now as currentInstant } from '../../../../platform/time/index.ts';
import { posix } from '../../../../platform/util/path.ts';
import { MAX_SKILL_PACKAGE_ZIP_BYTES } from '../package-core.ts';
import {
  MARKET_DEFAULT_LIMIT, PROVENANCE_SETTINGS_PREFIX, TEMP_ARTIFACT_MAX_AGE_MS,
  type DownloadedPackage, type SkillMarketClient,
} from '../market-core.ts';
import { enforceInstallVerdict, enrichVerify, encodeSkillMarketProvenance, marketFailure, normalizeExpectedSha256 } from '../market-core.ts';
import { fail } from './paths.ts';
import { ioMessage, MobileSkillFiles } from './files.ts';
import { AGENT_INSTALLED_MARKER, DEFAULT_AGENT_SKILLS_BASE, MobileSkillPackages } from './package.ts';
import { isWithin } from './paths.ts';

export interface MobileMarketLogger {
  warn?(message: string): void;
}

interface TempArtifact {
  bytes: Uint8Array;
  cleanup: { dispose(): void };
}

export class MobileSkillMarket {
  private readonly client: SkillMarketClient;
  private readonly packages: MobileSkillPackages;
  private readonly files: MobileSkillFiles;
  private readonly saveSetting: (key: string, value: string) => void;
  private readonly logger: MobileMarketLogger;

  constructor(
    client: SkillMarketClient,
    packages: MobileSkillPackages,
    files: MobileSkillFiles,
    saveSetting: (key: string, value: string) => void,
    logger: MobileMarketLogger = {},
  ) {
    this.client = client;
    this.packages = packages;
    this.files = files;
    this.saveSetting = saveSetting;
    this.logger = logger;
  }

  private get tempDir(): string {
    return this.files.paths.marketTempDir;
  }

  private async cleanupStaleTempArtifacts(): Promise<void> {
    let entries;
    try { entries = await this.files.files.readDir(this.tempDir); }
    catch { return; }
    const now = Date.now();
    for (const entry of entries) {
      if (entry.kind !== 'file' || posix.extname(entry.name) !== '.zip') continue;
      let modifiedMs: number;
      try { modifiedMs = (await this.files.files.stat(entry.path)).modifiedMs; }
      catch { continue; }
      if (now - modifiedMs <= TEMP_ARTIFACT_MAX_AGE_MS) continue;
      try { await this.files.files.rm(entry.path, { force: true }); }
      catch (error) { this.logger.warn?.(`[agent-skills] failed to remove stale market temp artifact: ${ioMessage(error)}`); }
    }
  }

  async writeTempZip(slug: string, bytes: Uint8Array): Promise<string> {
    try { await this.files.files.mkdir(this.tempDir, { recursive: true }); }
    catch (error) { throw new Error(`Failed to create temp dir: ${ioMessage(error)}`); }
    await this.cleanupStaleTempArtifacts();
    const safe = [...slug].map(ch => /^[A-Za-z0-9_-]$/.test(ch) ? ch : '_').join('');
    const target = posix.join(this.tempDir, `${safe}-${Date.now()}.zip`);
    try { await this.files.files.writeBytes(target, bytes); }
    catch (error) { throw new Error(`Failed to write temp zip: ${ioMessage(error)}`); }
    return target;
  }

  async readBoundTempZip(target: string): Promise<TempArtifact> {
    const canonical = posix.normalize(target);
    if (!isWithin(canonical, this.tempDir) || posix.extname(canonical) !== '.zip') {
      throw new Error('Invalid community marketplace scan artifact path');
    }
    let stat;
    try { stat = await this.files.files.stat(canonical); }
    catch (error) { throw new Error(`Failed to inspect community marketplace scan artifact: ${ioMessage(error)}`); }
    if (stat.kind !== 'file' || stat.size > MAX_SKILL_PACKAGE_ZIP_BYTES) {
      throw new Error('Invalid or oversized community marketplace scan artifact');
    }
    let bytes: Uint8Array;
    try { bytes = await this.files.files.readBytes(canonical); }
    catch (error) { throw new Error(`Failed to read community marketplace scan artifact: ${ioMessage(error)}`); }
    return {
      bytes,
      cleanup: {
        dispose: () => { void this.files.files.rm(canonical, { force: true }).catch(() => undefined); },
      },
    };
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
        ? await this.client.listSkills(resolvedSort, resolvedLimit, resolvedFlag)
        : await this.client.search(query.trim(), resolvedLimit, resolvedFlag);
    } catch (error) { return marketFailure(error); }
    result.items = await enrichVerify(this.client, result.items, this.logger);
    return result;
  }

  async detail(slug: string): Promise<SkillMarketSkillDetail> {
    try { return await this.client.skillDetail(slug); }
    catch (error) { return marketFailure(error); }
  }

  async verify(slug: string, version: string | null | undefined): Promise<SkillMarketVerifyResult> {
    try { return await this.client.verify(slug, version ?? undefined); }
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
      try { resolvedVersion = (await this.client.verify(slug)).version; }
      catch (error) { resolutionErrors.push(`verify: ${ioMessage(error)}`); }
    }
    if (resolvedVersion.trim().length === 0) {
      try { resolvedVersion = (await this.client.skillDetail(slug)).version; }
      catch (error) { resolutionErrors.push(`detail: ${ioMessage(error)}`); }
    }
    if (resolvedVersion.length === 0) {
      fail('INVALID_INPUT',
        `Community marketplace version could not be resolved${resolutionErrors.length ? ` (${resolutionErrors.join('; ')})` : ''}`);
    }
    const provenance = encodeSkillMarketProvenance(slug, resolvedVersion);

    if (!shouldInstall) {
      let downloaded: DownloadedPackage;
      try { downloaded = await this.client.downloadPackageBytes(slug, resolvedVersion); }
      catch (error) { return marketFailure(error); }
      let tempPath: string;
      try { tempPath = await this.writeTempZip(slug, downloaded.bytes); }
      catch (error) { return fail('IO_ERROR', ioMessage(error)); }
      const scan = await this.packages.install(downloaded.bytes, DEFAULT_AGENT_SKILLS_BASE, allowOverwrite, true);
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
    catch (error) { return fail('INVALID_INPUT', ioMessage(error)); }
    if (tempZipPath === null || tempZipPath === undefined) {
      fail('INVALID_INPUT', 'tempZipPath from the confirmed community marketplace scan is required when installing');
    }

    let artifact: TempArtifact;
    try { artifact = await this.readBoundTempZip(tempZipPath); }
    catch (error) { return fail('INVALID_INPUT', ioMessage(error)); }
    try {
      let verdict: SkillMarketVerifyResult;
      try { verdict = await this.client.verify(slug, resolvedVersion); }
      catch (error) { return marketFailure(error); }
      try { enforceInstallVerdict(verdict, slug, resolvedVersion); }
      catch (error) { return fail('INVALID_INPUT', ioMessage(error)); }

      const prepared = await this.packages.prepare(artifact.bytes, DEFAULT_AGENT_SKILLS_BASE, allowOverwrite);
      try {
        if (prepared.result.package_sha256 !== expected) {
          fail('INVALID_INPUT',
            `Community marketplace package changed after confirmation: expected ${expected}, got ${prepared.result.package_sha256}`);
        }
        const declared = declaredRiskLevel?.trim();
        if (declared === undefined || !['low', 'medium', 'high'].includes(declared)) {
          fail('INVALID_INPUT', 'declaredRiskLevel is required when installing and must match the preceding scan');
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
        try { await prepared.writeStagedFile(AGENT_INSTALLED_MARKER, new TextEncoder().encode(provenanceJson)); }
        catch (error) { return fail('IO_ERROR', ioMessage(error)); }

        const [installedResult, committed] = await prepared.commit();
        const key = `${PROVENANCE_SETTINGS_PREFIX}${installedResult.skill_id}`;
        let persistError: unknown;
        try { this.saveSetting(key, provenanceJson); }
        catch (error) { persistError = error; }
        if (persistError !== undefined) {
          const message = ioMessage(persistError);
          try { await committed.rollback(); }
          catch (rollbackError) {
            fail('IO_ERROR',
              `Failed to persist skill market provenance (${message}), and rollback also failed (${ioMessage(rollbackError)}).`);
          }
          fail('IO_ERROR', `Failed to persist skill market provenance (${message}); the install was rolled back.`);
        }
        await committed.finalize();
        return {
          slug,
          version: resolvedVersion,
          provenance,
          sourceKind: 'confirmed-scan-artifact',
          scan: installedResult,
          installed: true,
        };
      } finally {
        await prepared.dispose();
      }
    } finally {
      artifact.cleanup.dispose();
    }
  }
}
