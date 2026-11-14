/**
 * 移动端 `dstu.agent-skills`（L07）：22 条技能命令与 `agentSkills` / `agentTools` 服务。
 *
 * 桌面入口 `index.ts` 的运行时闭包依赖 `node:fs` / `node:crypto` / `node:zlib` / `node:worker_threads`
 * （暂存目录 rename、同步 deflate、ZIP worker 池），移动端 Host（Worker + OPFS + SQLite WASM）没有这些能力。
 * 这个入口按“数据面可移植性”分两类：
 *
 * - **真实实现**：技能文件命令走 `ctx.files`（OPFS），`skill_import_zip` / tap / market 的 ZIP 读写走
 *   `platform/zip/core`（`CompressionStream`），升级检查、候选状态机、用量记账复用与桌面相同的仓储与
 *   纯逻辑（`taps-core` / `market-core` / `updates-core` / `skill-replay-core`）；
 * - **平台差异**：没有外部 PATH / Python 环境可探测，`skill_probe_requires` 一律返回未找到；
 *   `skill_create` 等命令是 async（OPFS 没有同步文件 API）。
 *
 * `agentTools` 只注册不依赖 Node 的 8 个执行器；PTC 解释器（nativeStarlark）、workshop 落盘、workbench 桥、
 * skill_install / skill_lifecycle 的聊天窗口桥接留在桌面入口。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { CommandError, definePlugin, type Disposer } from '../../kernel/api.ts';
import type { Commands } from '../../../contracts/ipc/generated/L07-agent-skills-ptc.ts';
import type { CryptoService } from '../../platform/crypto/api.ts';
import type { FilesService } from '../../platform/files/api.ts';
import type { HttpService } from '../../platform/http/api.ts';
import type { NativeOffice } from '../../platform/native/office/api.ts';
import type { SettingsService } from '../../platform/settings/api.ts';
import type { SqlExecutor } from '../../platform/storage/api.ts';
import type {
  AgentSkillsService, AgentToolsService, ReplayReport, SkillCandidatePromotion, SkillCandidateRollback,
  SkillCandidateSummary, SkillImportZipResult, SkillMarketDownloadScanResult, SkillMarketSearchResponse,
  SkillMarketSkillDetail, SkillMarketVerifyResult, SkillUpdateApplyResult, SkillUpdateCheckResult, TapCatalog,
  TapExportResult, ToolSchemaRegistry,
} from './api.ts';
import { extractFrontmatter, parseRequires } from './src/requires-core.ts';
import type { SkillRequires, SkillRequiresProbe } from './api.ts';
import { partitionRequires, invalidRequiresSorted } from './src/requires-core.ts';
import {
  learnedSkillsBase, promoteCandidateMobile, rollbackCandidateMobile, commandDisplayMessage,
} from './src/mobile/candidates.ts';
import { MobileSkillFiles } from './src/mobile/files.ts';
import { MobileSkillMarket } from './src/mobile/market.ts';
import { MobileSkillPackages } from './src/mobile/package.ts';
import { MobileSkillPaths } from './src/mobile/paths.ts';
import { MobileSkillTaps } from './src/mobile/taps.ts';
import { recordSkillActivation } from './src/skill-usage.ts';
import {
  listCandidateSummaries, normalizeCandidateId, normalizeListLimit, normalizeListStatus, replayCandidate,
} from './src/skill-replay-core.ts';
import { GLOBAL_MARKET_CACHE, HttpSkillMarketTransport, SkillMarketClient } from './src/market-core.ts';
import { SkillUpdates } from './src/updates-core.ts';
import { repackSkillSubdir } from './src/repack-core.ts';
import { AgentToolExecutorRegistry, type AgentToolExecutor } from './src/tools/executor-registry.ts';
import { SkillsToolExecutor } from './src/tools/skills-tool-executor.ts';
import { LlmUsageToolRuntimeExecutor } from './src/tools/llm-usage-tool-executor.ts';
import {
  McpManageToolExecutor, McpProposeToolExecutor, type McpToolExecutorDeps,
} from './src/tools/mcp-tool-executors.ts';
import {
  SkillMarketInstallToolExecutor, SkillMarketReadToolExecutor, type SkillMarketToolDeps,
} from './src/tools/skill-market-tool-executors.ts';
import { ConnectorChatToolExecutor } from './src/tools/connector-chat-executor.ts';
import { FetchChatToolExecutor } from './src/tools/fetch-chat-executor.ts';
import { injectToolSchemas } from './src/tools/injector.ts';
import {
  emitMcpListChanged, readMcpAllowUnapproved, readMcpToolsList, writeMcpAllowUnapproved, writeMcpToolsList,
} from './src/tools/mcp-settings-store.ts';
import { safeSessionDir } from '../agent-workspace/portable.ts';
import { posix } from '../../platform/util/path.ts';

function commandErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 移动端没有外部 PATH / Python；每个声明都按“未找到”回答，`invalid` 仍按 Rust 规则过滤。 */
export function mobileRequiresProbe(requires: SkillRequires): SkillRequiresProbe {
  const [valid, invalid] = partitionRequires(requires);
  const bins = valid.bins.map(name => ({ name, found: false }));
  const env = valid.env.map(name => ({ name, set: false }));
  const python_packages = valid.python_packages.map(name => ({ name, found: false }));
  return {
    bins,
    env,
    python_packages,
    invalid: invalidRequiresSorted(invalid),
    missing_count: bins.length + env.length + python_packages.length,
  };
}

export function mobileFormatMissingRequiresHints(probe: SkillRequiresProbe): string[] {
  return [
    ...probe.bins.filter(b => !b.found).map(b =>
      `${b.name} is not available on this device. This skill can only run on a desktop host.`),
    ...probe.env.filter(e => !e.set).map(e =>
      `Environment variable ${e.name} is not set. Ask the user to configure it in Settings before using this skill.`),
    ...probe.python_packages.filter(p => !p.found).map(p =>
      `Python package \`${p.name}\` is not importable on this device. This skill can only run on a desktop host.`),
  ];
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

class SkillsService extends Service implements AgentSkillsService {
  _files: MobileSkillFiles;
  _packages: MobileSkillPackages;
  _taps: MobileSkillTaps;
  _market: MobileSkillMarket;
  _updates: SkillUpdates;
  _db: () => SqlExecutor;
  _saveSetting: (key: string, value: string) => void;

  constructor(
    ctx: Context, files: MobileSkillFiles, packages: MobileSkillPackages, taps: MobileSkillTaps,
    market: MobileSkillMarket, updates: SkillUpdates, db: () => SqlExecutor,
    saveSetting: (key: string, value: string) => void,
  ) {
    super(ctx, 'agentSkills');
    this._files = files;
    this._packages = packages;
    this._taps = taps;
    this._market = market;
    this._updates = updates;
    this._db = db;
    this._saveSetting = saveSetting;
  }

  extractFrontmatter = extractFrontmatter;
  parseRequires = parseRequires;
  probeRequires = async (requires: SkillRequires) => mobileRequiresProbe(requires);
  formatMissingRequiresHints = mobileFormatMissingRequiresHints;
  getAllowedSkillsBases() { return this._files.getAllowedSkillsBases(); }

  commandMentionsSkillsDirectory(command: string): boolean {
    const normalized = command.replaceAll('\\', '/').toLowerCase();
    if (!normalized) return false;
    if (['.deep-student/skills', '.claude/skills', '.agents/skills', '.github/skills', 'skills-cursor']
      .some(pattern => normalized.includes(pattern))) return true;
    return this._files.getAllowedSkillsBases().some((base: string) => {
      const value = base.replaceAll('\\', '/').toLowerCase();
      return byteLength(value) >= 4 && normalized.includes(value);
    });
  }

  /**
   * 同步接口只有词法校验：OPFS 没有同步 `stat`。需要真实目录检查的调用方走
   * `MobileSkillFiles.canonicalizeSkillPackageRoot()`（异步，命令入口使用）。
   */
  canonicalizeSkillPackageRoot(path: string): string {
    return this._files.validatePath(path);
  }

  listDirectories(path: string) { return this._files.listDirectories(path); }
  listPackageFiles(path: string) { return this._files.listPackageFiles(path); }
  readFile(path: string) { return this._files.readFile(path); }
  create(basePath: string, skillId: string, content: string) { return this._files.create(basePath, skillId, content); }
  update(path: string, content: string) { return this._files.update(path, content); }
  delete(path: string) { return this._files.delete(path); }
  importZip(zipPath: string, basePath: string, overwrite: boolean, dryRun: boolean | null | undefined): Promise<SkillImportZipResult> {
    return this._packages.importZip(zipPath, basePath, overwrite, dryRun);
  }
  tapCatalog(repoUrl: string): Promise<TapCatalog> { return this._taps.catalog(repoUrl); }
  tapInstall(zipUrl: string, subdir: string, overwrite: boolean, dryRun: boolean | null | undefined, expectedPackageSha256: string | null | undefined): Promise<SkillImportZipResult> {
    return this._taps.install(zipUrl, subdir, overwrite, dryRun, expectedPackageSha256, this._saveSetting);
  }
  exportTap(skillIds: readonly string[], destPath: string): Promise<TapExportResult> {
    return this._taps.exportTap(skillIds, destPath);
  }
  marketSearch(q: string | null | undefined, limit: number | null | undefined, nonSuspiciousOnly: boolean | null | undefined, sort: string | null | undefined): Promise<SkillMarketSearchResponse> {
    return this._market.search(q, limit, nonSuspiciousOnly, sort);
  }
  marketDetail(slug: string): Promise<SkillMarketSkillDetail> { return this._market.detail(slug); }
  marketVerify(slug: string, version: string | null | undefined): Promise<SkillMarketVerifyResult> {
    return this._market.verify(slug, version);
  }
  marketDownloadAndScan(
    slug: string, version: string | null | undefined, install: boolean | null | undefined,
    overwrite: boolean | null | undefined, expectedPackageSha256: string | null | undefined,
    tempZipPath: string | null | undefined, declaredRiskLevel: string | null | undefined,
  ): Promise<SkillMarketDownloadScanResult> {
    return this._market.downloadAndScan(
      slug, version, install, overwrite, expectedPackageSha256, tempZipPath, declaredRiskLevel);
  }
  checkUpdates(skillIds: readonly string[] | null | undefined): Promise<SkillUpdateCheckResult[]> {
    return this._updates.check(skillIds);
  }
  updateFromSource(skillId: string): Promise<SkillUpdateApplyResult> {
    return this._updates.updateFromSource(skillId);
  }
  recordSkillActivation(skillId: string, sessionId?: string | null): null {
    try { recordSkillActivation(this._db(), skillId, sessionId); }
    catch (error) { throw new CommandError(commandErrorText(error)); }
    return null;
  }
  listSkillCandidates(status: string | null | undefined, limit: number | null | undefined): SkillCandidateSummary[] {
    return this._plain(() => listCandidateSummaries(
      this._db(), normalizeListStatus(status), normalizeListLimit(limit),
    ));
  }
  replaySkillCandidate(candidateId: string): ReplayReport {
    return this._plain(() => replayCandidate(this._db(), normalizeCandidateId(candidateId)));
  }
  async promoteSkillCandidate(candidateId: string): Promise<SkillCandidatePromotion> {
    return this._plainAsync(() => promoteCandidateMobile(
      this._db(), normalizeCandidateId(candidateId), learnedSkillsBase(this._files.paths), this._files.files,
    ));
  }
  async rollbackSkillCandidate(candidateId: string): Promise<SkillCandidateRollback> {
    return this._plainAsync(() => rollbackCandidateMobile(
      this._db(), normalizeCandidateId(candidateId), learnedSkillsBase(this._files.paths), this._files.files,
    ));
  }
  _plain<T>(operation: () => T): T {
    try { return operation(); }
    catch (error) { throw new CommandError(commandDisplayMessage(error)); }
  }
  async _plainAsync<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) { throw new CommandError(commandDisplayMessage(error)); }
  }
}

/** Cross-lane `agentTools`: executor registry, settings helpers and schema injection. */
class ToolingService extends Service implements AgentToolsService {
  _ctx: Context;
  _executors: AgentToolExecutorRegistry;

  constructor(ctx: Context) {
    super(ctx, 'agentTools');
    this._ctx = ctx;
    this._executors = new AgentToolExecutorRegistry();
  }

  registerToolExecutors(executors: readonly AgentToolExecutor[]): Disposer {
    return this._executors.register(executors);
  }

  toolExecutors(): readonly AgentToolExecutor[] {
    return this._executors.all();
  }

  readMcpToolsList(settings: SettingsService): Promise<unknown[]> { return readMcpToolsList(settings); }
  writeMcpToolsList(settings: SettingsService, list: readonly unknown[]): Promise<void> {
    return writeMcpToolsList(settings, list);
  }
  readMcpAllowUnapproved(settings: SettingsService): Promise<boolean> { return readMcpAllowUnapproved(settings); }
  writeMcpAllowUnapproved(settings: SettingsService, enabled: boolean): Promise<void> {
    return writeMcpAllowUnapproved(settings, enabled);
  }
  emitMcpListChanged(action: string): boolean { return emitMcpListChanged(this._ctx.backendEvents, action); }
  injectToolSchemas(
    schemaToolIds: readonly string[] | null | undefined,
    llmContext: Map<string, unknown>,
    registry: ToolSchemaRegistry,
  ): number {
    return injectToolSchemas(schemaToolIds, llmContext, registry, this._ctx.logger);
  }
}

const COMMANDS = [
  'skill_probe_requires', 'skill_list_directories', 'skill_list_package_files', 'skill_read_file',
  'skill_create', 'skill_update', 'skill_delete', 'skill_import_zip',
  'skill_tap_catalog', 'skill_tap_install', 'skill_export_tap',
  'skill_market_search', 'skill_market_skill_detail', 'skill_market_verify', 'skill_market_download_and_scan',
  'skill_check_updates', 'skill_update_from_source', 'chat_v2_record_skill_activation',
  'chat_v2_list_skill_candidates', 'chat_v2_replay_skill_candidate',
  'chat_v2_promote_skill_candidate', 'chat_v2_rollback_skill_candidate',
] as const;

export default definePlugin({
  meta: {
    id: 'dstu.agent-skills', lane: 'L07-agent-skills-ptc', platforms: ['mobile'],
    commands: [...COMMANDS],
    provides: ['agentSkills', 'agentTools'],
  },
  inject: ['paths', 'settings', 'storage', 'files'],
  apply(ctx) {
    const paths = new MobileSkillPaths({
      appDataDir: ctx.paths.appDataDir, home: ctx.paths.os.home, logger: ctx.logger,
    });
    const files = new MobileSkillFiles(ctx.files, paths, { warn: message => ctx.logger.warn(message) });
    const packages = new MobileSkillPackages(files, paths, { warn: message => ctx.logger.warn(message) });
    const http = (): HttpService | null => (ctx.get('http') as HttpService | undefined) ?? null;
    const saveSetting = (key: string, value: string): void => { ctx.settings.save(key, value); };
    const taps = new MobileSkillTaps(files, packages, http, { warn: message => ctx.logger.warn(message) });
    const marketClient = (): SkillMarketClient =>
      new SkillMarketClient(new HttpSkillMarketTransport(http), GLOBAL_MARKET_CACHE, repackSkillSubdir);
    const market = new MobileSkillMarket(
      marketClient(), packages, files, saveSetting, { warn: message => ctx.logger.warn(message) },
    );
    const updates = new SkillUpdates({
      settings: () => ctx.settings, packages, marketClient, http, logger: ctx.logger,
    });
    const usageDb = (): SqlExecutor => ctx.storage.database('chat_v2');
    const skills = new SkillsService(ctx, files, packages, taps, market, updates, usageDb, saveSetting);

    const tooling = new ToolingService(ctx);
    const mcpToolDeps: McpToolExecutorDeps = {
      settings: () => ctx.settings,
      events: () => ctx.backendEvents,
      // 移动端 Host 没有 MCP 传输探测（stdio 子进程 / 本地 socket），与 Rust `cfg(not(feature="mcp"))` 同一回复。
      tester: () => null,
      warn: message => ctx.logger.warn(message),
    };
    const marketToolDeps: SkillMarketToolDeps = {
      market: () => skills, warn: message => ctx.logger.warn(message),
    };
    tooling.registerToolExecutors([
      new SkillsToolExecutor(),
      new LlmUsageToolRuntimeExecutor(),
      new McpProposeToolExecutor(mcpToolDeps),
      new McpManageToolExecutor(mcpToolDeps),
      new SkillMarketReadToolExecutor(marketToolDeps),
      new SkillMarketInstallToolExecutor(marketToolDeps),
      new ConnectorChatToolExecutor({
        settings: () => ctx.settings,
        toolRegistry: () => ctx.get('mcp')?.registry ?? null,
        logger: ctx.logger,
      }),
      new FetchChatToolExecutor({
        settings: () => ctx.settings,
        artifactRoot: sessionId => posix.join(ctx.paths.appDataDir, 'chat_v2_artifacts', safeSessionDir(sessionId)),
        log: ctx.logger,
        http: () => (ctx.get('http') as HttpService | undefined) ?? null,
        files: () => (ctx.get('files') as FilesService | undefined) ?? null,
        crypto: () => (ctx.get('crypto') as CryptoService | undefined) ?? null,
        office: () => (ctx.get('nativeOffice') as NativeOffice | undefined) ?? null,
      }),
    ]);

    ctx.commands.register<Commands['skill_probe_requires']['args'], Commands['skill_probe_requires']['result']>(
      'skill_probe_requires',
      args => skills.probeRequires({
        bins: args.bins ?? [], env: args.env ?? [], python_packages: args.pythonPackages ?? [],
      }),
    );
    ctx.commands.register<Commands['skill_list_directories']['args'], Commands['skill_list_directories']['result']>(
      'skill_list_directories', ({ path }) => skills.listDirectories(path));
    ctx.commands.register<Commands['skill_list_package_files']['args'], Commands['skill_list_package_files']['result']>(
      'skill_list_package_files', ({ path }) => skills.listPackageFiles(path));
    ctx.commands.register<Commands['skill_read_file']['args'], Commands['skill_read_file']['result']>(
      'skill_read_file', ({ path }) => skills.readFile(path));
    ctx.commands.register<Commands['skill_create']['args'], Commands['skill_create']['result']>(
      'skill_create', ({ basePath, skillId, content }) => skills.create(basePath, skillId, content));
    ctx.commands.register<Commands['skill_update']['args'], Commands['skill_update']['result']>(
      'skill_update', ({ path, content }) => skills.update(path, content));
    ctx.commands.register<Commands['skill_delete']['args'], Commands['skill_delete']['result']>(
      'skill_delete', ({ path }) => skills.delete(path));
    ctx.commands.register<Commands['skill_import_zip']['args'], Commands['skill_import_zip']['result']>(
      'skill_import_zip',
      ({ zipPath, basePath, overwrite, dryRun }) => skills.importZip(zipPath, basePath, overwrite, dryRun));
    ctx.commands.register<Commands['skill_tap_catalog']['args'], Commands['skill_tap_catalog']['result']>(
      'skill_tap_catalog', ({ repoUrl }) => skills.tapCatalog(repoUrl));
    ctx.commands.register<Commands['skill_tap_install']['args'], Commands['skill_tap_install']['result']>(
      'skill_tap_install',
      ({ zipUrl, subdir, overwrite, dryRun, expectedPackageSha256 }) =>
        skills.tapInstall(zipUrl, subdir, overwrite, dryRun, expectedPackageSha256));
    ctx.commands.register<Commands['skill_export_tap']['args'], Commands['skill_export_tap']['result']>(
      'skill_export_tap', ({ skillIds, destPath }) => skills.exportTap(skillIds, destPath));
    ctx.commands.register<Commands['skill_market_search']['args'], Commands['skill_market_search']['result']>(
      'skill_market_search',
      ({ q, limit, nonSuspiciousOnly, sort }) => skills.marketSearch(q, limit, nonSuspiciousOnly, sort));
    ctx.commands.register<Commands['skill_market_skill_detail']['args'], Commands['skill_market_skill_detail']['result']>(
      'skill_market_skill_detail', ({ slug }) => skills.marketDetail(slug));
    ctx.commands.register<Commands['skill_market_verify']['args'], Commands['skill_market_verify']['result']>(
      'skill_market_verify', ({ slug, version }) => skills.marketVerify(slug, version));
    ctx.commands.register<Commands['skill_market_download_and_scan']['args'], Commands['skill_market_download_and_scan']['result']>(
      'skill_market_download_and_scan',
      ({ slug, version, install, overwrite, expectedPackageSha256, tempZipPath, declaredRiskLevel }) =>
        skills.marketDownloadAndScan(
          slug, version, install, overwrite, expectedPackageSha256, tempZipPath, declaredRiskLevel));
    ctx.commands.register<Commands['skill_check_updates']['args'], Commands['skill_check_updates']['result']>(
      'skill_check_updates', ({ skillIds }) => skills.checkUpdates(skillIds));
    ctx.commands.register<Commands['skill_update_from_source']['args'], Commands['skill_update_from_source']['result']>(
      'skill_update_from_source', ({ skillId }) => skills.updateFromSource(skillId));
    ctx.commands.register<Commands['chat_v2_record_skill_activation']['args'], Commands['chat_v2_record_skill_activation']['result']>(
      'chat_v2_record_skill_activation',
      ({ skillId, sessionId }) => skills.recordSkillActivation(skillId, sessionId));
    ctx.commands.register<Commands['chat_v2_list_skill_candidates']['args'], Commands['chat_v2_list_skill_candidates']['result']>(
      'chat_v2_list_skill_candidates', ({ status, limit }) => skills.listSkillCandidates(status, limit));
    ctx.commands.register<Commands['chat_v2_replay_skill_candidate']['args'], Commands['chat_v2_replay_skill_candidate']['result']>(
      'chat_v2_replay_skill_candidate', ({ candidateId }) => skills.replaySkillCandidate(candidateId));
    ctx.commands.register<Commands['chat_v2_promote_skill_candidate']['args'], Commands['chat_v2_promote_skill_candidate']['result']>(
      'chat_v2_promote_skill_candidate', ({ candidateId }) => skills.promoteSkillCandidate(candidateId));
    ctx.commands.register<Commands['chat_v2_rollback_skill_candidate']['args'], Commands['chat_v2_rollback_skill_candidate']['result']>(
      'chat_v2_rollback_skill_candidate', ({ candidateId }) => skills.rollbackSkillCandidate(candidateId));
  },
});

export { COMMANDS as AGENT_SKILLS_COMMANDS };
