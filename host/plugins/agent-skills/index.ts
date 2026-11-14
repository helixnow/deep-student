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
  AgentSkillsService, AgentToolsService, SkillImportZipResult, SkillMarketDownloadScanResult,
  SkillMarketSearchResponse, SkillMarketSkillDetail, SkillMarketVerifyResult, SkillUpdateApplyResult,
  SkillUpdateCheckResult, ReplayReport, SkillCandidatePromotion, SkillCandidateRollback,
  SkillCandidateSummary, TapCatalog, TapExportResult, ToolSchemaRegistry,
} from './api.ts';
import { extractFrontmatter, parseRequires, probeRequires, formatMissingRequiresHints } from './src/requires.ts';
import { SkillFiles } from './src/files.ts';
import { stopIdleZipWorkers } from './src/workers/zip-pool.ts';
import { SkillPackages, type VirtualZipReader } from './src/skill-package.ts';
import { SkillTaps } from './src/skill-taps.ts';
import { SkillMarket, skillMarketClient } from './src/skill-market.ts';
import { SkillUpdates } from './src/skill-updates.ts';
import { recordSkillActivation } from './src/skill-usage.ts';
import {
  learnedSkillsBase, listCandidateSummaries, normalizeCandidateId, normalizeListLimit,
  normalizeListStatus, promoteCandidateWithBase, replayCandidate, rollbackCandidateWithBase,
} from './src/skill-replay.ts';
import { injectToolSchemas } from './src/tools/injector.ts';
import { AgentToolExecutorRegistry, type AgentToolExecutor } from './src/tools/executor-registry.ts';
import { PtcToolExecutor } from './src/tools/ptc-tool-executor.ts';
import { SkillWorkshopToolExecutor } from './src/tools/skill-workshop-tool-executor.ts';
import { SkillsToolExecutor } from './src/tools/skills-tool-executor.ts';
import { LlmUsageToolRuntimeExecutor } from './src/tools/llm-usage-tool-executor.ts';
import { createMcpConnectionTester, McpManageToolExecutor, McpProposeToolExecutor, type McpToolExecutorDeps }
  from './src/tools/mcp-tool-executors.ts';
import { SkillMarketInstallToolExecutor, SkillMarketReadToolExecutor, type SkillMarketToolDeps }
  from './src/tools/skill-market-tool-executors.ts';
import { WorkbenchChatToolExecutor, workbenchGateEnvironment } from './src/tools/workbench-chat-executor.ts';
import { ConnectorChatToolExecutor } from './src/tools/connector-chat-executor.ts';
import { FetchChatToolExecutor } from './src/tools/fetch-chat-executor.ts';
import { SkillInstallChatToolExecutor } from './src/tools/skill-install-chat-executor.ts';
import { SkillLifecycleChatToolExecutor } from './src/tools/skill-lifecycle-chat-executor.ts';
import type { FeatureFlagsService } from '../../platform/storage/api.ts';
import { testHttp, testSse, testStdio, testStreamableHttpRmcp, testWebSocket } from '../mcp/api.ts';
import { artifactRoot, normalizeRuntimeRelativePath, runtimeRootById, sessionRoot } from '../agent-workspace/api.ts';
import {
  emitMcpListChanged, readMcpAllowUnapproved, readMcpToolsList, writeMcpAllowUnapproved,
  writeMcpToolsList,
} from './src/tools/mcp-settings-store.ts';

/**
 * Android SAF / content:// reads go through `tauri-plugin-fs` + ContentResolver, which
 * only exists on mobile. The Electron host is desktop-only, so a virtual URI fails with
 * the same user-visible error the desktop Rust build produces (see native-needs.md).
 */
function desktopVirtualZipReader(uri: string): Uint8Array {
  throw new Error(`virtual file URI is not readable on this platform: ${uri}`);
}

function desktopVirtualWriter(_staged: string, target: string): void {
  throw new Error(`virtual file URI is not writable on this platform: ${target}`);
}

class SkillsService extends Service implements AgentSkillsService {
  _files: SkillFiles;
  _packages: SkillPackages;
  _taps: SkillTaps;
  _market: SkillMarket;
  _updates: SkillUpdates;
  _db: () => SqlExecutor;
  _readVirtual: VirtualZipReader;
  _saveSetting: (key: string, value: string) => void;
  constructor(
    ctx: Context, packages: SkillPackages, taps: SkillTaps, market: SkillMarket, updates: SkillUpdates,
    db: () => SqlExecutor, readVirtual: VirtualZipReader, saveSetting: (key: string, value: string) => void,
  ) {
    super(ctx, 'agentSkills');
    this._files = packages._files;
    this._packages = packages;
    this._taps = taps;
    this._market = market;
    this._updates = updates;
    this._db = db;
    this._readVirtual = readVirtual;
    this._saveSetting = saveSetting;
  }
  extractFrontmatter = extractFrontmatter;
  parseRequires = parseRequires;
  probeRequires = probeRequires;
  formatMissingRequiresHints = formatMissingRequiresHints;
  getAllowedSkillsBases() { return this._files.getAllowedSkillsBases(); }
  commandMentionsSkillsDirectory(command: string) { return this._files.commandMentionsSkillsDirectory(command); }
  canonicalizeSkillPackageRoot(path: string) { return this._files.canonicalizeSkillPackageRoot(path); }
  listDirectories(path: string) { return this._files.listDirectories(path); }
  listPackageFiles(path: string) { return this._files.listPackageFiles(path); }
  readFile(path: string) { return this._files.readFile(path); }
  create(basePath: string, skillId: string, content: string) { return this._files.create(basePath, skillId, content); }
  update(path: string, content: string) { return this._files.update(path, content); }
  delete(path: string) { return this._files.delete(path); }
  importZip(zipPath: string, basePath: string, overwrite: boolean, dryRun: boolean | null | undefined): Promise<SkillImportZipResult> {
    return this._packages.importZip(zipPath, basePath, overwrite, dryRun, this._readVirtual);
  }
  tapCatalog(repoUrl: string): Promise<TapCatalog> { return this._taps.catalog(repoUrl); }
  tapInstall(zipUrl: string, subdir: string, overwrite: boolean, dryRun: boolean | null | undefined, expectedPackageSha256: string | null | undefined): Promise<SkillImportZipResult> {
    return this._taps.install(zipUrl, subdir, overwrite, dryRun, expectedPackageSha256, this._saveSetting);
  }
  exportTap(skillIds: readonly string[], destPath: string): Promise<TapExportResult> {
    return this._taps.exportTap(skillIds, destPath, desktopVirtualWriter);
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
    return this._market.downloadAndScan(slug, version, install, overwrite, expectedPackageSha256, tempZipPath, declaredRiskLevel);
  }
  checkUpdates(skillIds: readonly string[] | null | undefined): Promise<SkillUpdateCheckResult[]> {
    return this._updates.check(skillIds);
  }
  updateFromSource(skillId: string): Promise<SkillUpdateApplyResult> {
    return this._updates.updateFromSource(skillId);
  }
  recordSkillActivation(skillId: string, sessionId?: string | null): null {
    try { recordSkillActivation(this._db(), skillId, sessionId); }
    catch (error) {
      // Rust `Result<(), String>`: plain string, not the ChatV2Error JSON envelope.
      throw new CommandError(commandErrorText(error));
    }
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
  promoteSkillCandidate(candidateId: string): SkillCandidatePromotion {
    return this._plain(() => promoteCandidateWithBase(
      this._db(), normalizeCandidateId(candidateId), learnedSkillsBase(this._files),
      this.ctx.logger,
    ));
  }
  rollbackSkillCandidate(candidateId: string): SkillCandidateRollback {
    return this._plain(() => rollbackCandidateWithBase(
      this._db(), normalizeCandidateId(candidateId), learnedSkillsBase(this._files),
    ));
  }
  _plain<T>(operation: () => T): T {
    try { return operation(); }
    catch (error) { throw new CommandError(commandErrorText(error)); }
  }
}

function commandErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  readMcpToolsList(settings: SettingsService): Promise<unknown[]> {
    return readMcpToolsList(settings);
  }
  writeMcpToolsList(settings: SettingsService, list: readonly unknown[]): Promise<void> {
    return writeMcpToolsList(settings, list);
  }
  readMcpAllowUnapproved(settings: SettingsService): Promise<boolean> {
    return readMcpAllowUnapproved(settings);
  }
  writeMcpAllowUnapproved(settings: SettingsService, enabled: boolean): Promise<void> {
    return writeMcpAllowUnapproved(settings, enabled);
  }
  emitMcpListChanged(action: string): boolean {
    return emitMcpListChanged(this._ctx.backendEvents, action);
  }
  injectToolSchemas(
    schemaToolIds: readonly string[] | null | undefined,
    llmContext: Map<string, unknown>,
    registry: ToolSchemaRegistry,
  ): number {
    return injectToolSchemas(schemaToolIds, llmContext, registry, this._ctx.logger);
  }
}

export default definePlugin({
  meta: {
    id: 'dstu.agent-skills', lane: 'L07-agent-skills-ptc',
    commands: [
      'skill_probe_requires', 'skill_list_directories', 'skill_list_package_files', 'skill_read_file',
      'skill_create', 'skill_update', 'skill_delete', 'skill_import_zip',
      'skill_tap_catalog', 'skill_tap_install', 'skill_export_tap',
      'skill_market_search', 'skill_market_skill_detail', 'skill_market_verify', 'skill_market_download_and_scan',
      'skill_check_updates', 'skill_update_from_source', 'chat_v2_record_skill_activation',
      'chat_v2_list_skill_candidates', 'chat_v2_replay_skill_candidate',
      'chat_v2_promote_skill_candidate', 'chat_v2_rollback_skill_candidate',
    ],
    provides: ['agentSkills', 'agentTools'],
  },
  inject: ['paths', 'settings', 'storage'],
  apply(ctx) {
    const files = new SkillFiles(ctx.paths, ctx.logger);
    const packages = new SkillPackages(files, ctx.logger);
    ctx.effect(() => () => { void stopIdleZipWorkers(); });
    const http = (): HttpService | null => (ctx.get('http') as HttpService | undefined) ?? null;
    const taps = new SkillTaps(files, packages, ctx.paths.appDataDir, http, ctx.logger);
    const saveSetting = (key: string, value: string): void => {
      ctx.settings.save(key, value);
    };
    const marketClient = skillMarketClient(http);
    const market = new SkillMarket(marketClient, packages, saveSetting, ctx.logger);
    const settingsStore = (): SettingsService => ctx.settings;
    const updates = new SkillUpdates({
      settings: settingsStore, packages, marketClient: () => marketClient, http, logger: ctx.logger,
    });
    const usageDb = (): SqlExecutor => ctx.storage.database('chat_v2');
    const skills = new SkillsService(
      ctx, packages, taps, market, updates, usageDb, desktopVirtualZipReader, saveSetting,
    );
    const tooling = new ToolingService(ctx);
    const mcpTester = createMcpConnectionTester({ testStdio, testSse, testHttp, testWebSocket, testStreamableHttpRmcp },
      (level, message) => ctx.log.logger('dstu_mcp::mcp::test_helpers')[level](message));
    const mcpToolDeps: McpToolExecutorDeps = {
      settings: () => ctx.settings, events: () => ctx.backendEvents, tester: () => mcpTester,
      warn: message => ctx.logger.warn(message),
    };
    const marketToolDeps: SkillMarketToolDeps = { market: () => skills, warn: message => ctx.logger.warn(message) };
    // Rust `pipeline.rs:155-180` registers the real `PtcExecutor` in the central
    // registry. L04's registry consumes this registration and supplies
    // `admitted_tool_dispatcher`; script calls stay under central admission.
    // `SkillWorkshopExecutor` is the App roster entry from `pipeline/roster.rs:72`.
    tooling.registerToolExecutors([
      new PtcToolExecutor({
        logger: ctx.logger,
        nativeStarlark: () => {
          const service = ctx.get('nativeStarlark');
          if (service === undefined) throw new Error('ptc_run requires the nativeStarlark service');
          return service;
        },
        artifactRoot: sessionId => sessionRoot(ctx.app.dataDir, sessionId, 'artifact', false).path,
      }),
      new SkillWorkshopToolExecutor({
        files, appDataDir: () => ctx.paths.appDataDir, settings: () => ctx.settings, logger: ctx.logger,
      }),
      // roster.rs:75 `SkillsExecutor` (`load_skills`, progressive disclosure).
      new SkillsToolExecutor(),
      // roster.rs:69 `LlmUsageToolExecutor` (read-only usage ledger queries).
      new LlmUsageToolRuntimeExecutor(),
      new McpProposeToolExecutor(mcpToolDeps),
      new McpManageToolExecutor(mcpToolDeps),
      new SkillMarketReadToolExecutor(marketToolDeps),
      new SkillMarketInstallToolExecutor(marketToolDeps),
      // roster.rs:126 ACR `workbench_*` desktop control over the calling window.
      new WorkbenchChatToolExecutor({
        events: () => ctx.backendEvents,
        gates: () => workbenchGateEnvironment({
          settings: ctx.settings, featureFlags: ctx.get('featureFlags') as FeatureFlagsService | undefined, app: ctx.app,
        }),
        logger: ctx.logger,
      }),
      // roster.rs:50 connector draft/confirm/commit over the chat_v2 ledger and the MCP tool registry.
      new ConnectorChatToolExecutor({
        settings: () => ctx.settings, toolRegistry: () => ctx.get('mcp')?.registry ?? null, logger: ctx.logger,
      }),
      // roster.rs:54 `web_fetch` (ctx.http `public-pinned`: every hop resolved, checked and pinned by the transport).
      new FetchChatToolExecutor({
        settings: () => ctx.settings,
        artifactRoot: sessionId => artifactRoot(ctx.app.dataDir, sessionId, true).path,
        log: ctx.logger,
        http: () => (ctx.get('http') as HttpService | undefined) ?? null,
        files: () => (ctx.get('files') as FilesService | undefined) ?? null,
        crypto: () => (ctx.get('crypto') as CryptoService | undefined) ?? null,
        office: () => (ctx.get('nativeOffice') as NativeOffice | undefined) ?? null,
      }),
      // roster.rs:97 `skill_scan` / `skill_install` into ~/.deep-student/skills with provenance.
      new SkillInstallChatToolExecutor({
        packages: () => packages,
        settings: () => ctx.settings,
        runtimeRoot: (sessionId, roots, rootId) => runtimeRootById(
          { settings: ctx.settings, windowsFiles: ctx.get('nativeWindowsFiles'), dataDir: ctx.app.dataDir, logger: ctx.logger },
          sessionId, roots, rootId, true).path,
        normalizeRelativePath: raw => normalizeRuntimeRelativePath(raw),
        http,
        warn: message => ctx.logger.warn(message),
      }),
      // roster.rs:99 `skill_set_enabled` / `skill_remove` / `skill_trust_request` via the skill-lifecycle window bridge.
      new SkillLifecycleChatToolExecutor({
        files: () => files,
        settings: () => ctx.settings,
        events: () => ctx.backendEvents,
        warn: message => ctx.logger.warn(message),
      }),
    ]);
    ctx.commands.register<Commands['skill_probe_requires']['args'], Commands['skill_probe_requires']['result']>(
      'skill_probe_requires', args => skills.probeRequires({ bins: args.bins ?? [], env: args.env ?? [], python_packages: args.pythonPackages ?? [] }),
    );
    ctx.commands.register<Commands['skill_list_directories']['args'], Commands['skill_list_directories']['result']>('skill_list_directories', ({ path }) => skills.listDirectories(path));
    ctx.commands.register<Commands['skill_list_package_files']['args'], Commands['skill_list_package_files']['result']>('skill_list_package_files', ({ path }) => skills.listPackageFiles(path));
    ctx.commands.register<Commands['skill_read_file']['args'], Commands['skill_read_file']['result']>('skill_read_file', ({ path }) => skills.readFile(path));
    ctx.commands.register<Commands['skill_create']['args'], Commands['skill_create']['result']>('skill_create', ({ basePath, skillId, content }) => skills.create(basePath, skillId, content));
    ctx.commands.register<Commands['skill_update']['args'], Commands['skill_update']['result']>('skill_update', ({ path, content }) => skills.update(path, content));
    ctx.commands.register<Commands['skill_delete']['args'], Commands['skill_delete']['result']>('skill_delete', ({ path }) => skills.delete(path));
    ctx.commands.register<Commands['skill_import_zip']['args'], Commands['skill_import_zip']['result']>(
      'skill_import_zip', ({ zipPath, basePath, overwrite, dryRun }) => skills.importZip(zipPath, basePath, overwrite, dryRun),
    );
    ctx.commands.register<Commands['skill_tap_catalog']['args'], Commands['skill_tap_catalog']['result']>(
      'skill_tap_catalog', ({ repoUrl }) => skills.tapCatalog(repoUrl),
    );
    ctx.commands.register<Commands['skill_tap_install']['args'], Commands['skill_tap_install']['result']>(
      'skill_tap_install', ({ zipUrl, subdir, overwrite, dryRun, expectedPackageSha256 }) =>
        skills.tapInstall(zipUrl, subdir, overwrite, dryRun, expectedPackageSha256),
    );
    ctx.commands.register<Commands['skill_export_tap']['args'], Commands['skill_export_tap']['result']>(
      'skill_export_tap', ({ skillIds, destPath }) => skills.exportTap(skillIds, destPath),
    );
    ctx.commands.register<Commands['skill_market_search']['args'], Commands['skill_market_search']['result']>(
      'skill_market_search', ({ q, limit, nonSuspiciousOnly, sort }) =>
        skills.marketSearch(q, limit, nonSuspiciousOnly, sort),
    );
    ctx.commands.register<Commands['skill_market_skill_detail']['args'], Commands['skill_market_skill_detail']['result']>(
      'skill_market_skill_detail', ({ slug }) => skills.marketDetail(slug),
    );
    ctx.commands.register<Commands['skill_market_verify']['args'], Commands['skill_market_verify']['result']>(
      'skill_market_verify', ({ slug, version }) => skills.marketVerify(slug, version),
    );
    ctx.commands.register<Commands['skill_market_download_and_scan']['args'], Commands['skill_market_download_and_scan']['result']>(
      'skill_market_download_and_scan',
      ({ slug, version, install, overwrite, expectedPackageSha256, tempZipPath, declaredRiskLevel }) =>
        skills.marketDownloadAndScan(slug, version, install, overwrite, expectedPackageSha256, tempZipPath, declaredRiskLevel),
    );
    ctx.commands.register<Commands['skill_check_updates']['args'], Commands['skill_check_updates']['result']>(
      'skill_check_updates', ({ skillIds }) => skills.checkUpdates(skillIds),
    );
    ctx.commands.register<Commands['skill_update_from_source']['args'], Commands['skill_update_from_source']['result']>(
      'skill_update_from_source', ({ skillId }) => skills.updateFromSource(skillId),
    );
    ctx.commands.register<Commands['chat_v2_record_skill_activation']['args'], Commands['chat_v2_record_skill_activation']['result']>(
      'chat_v2_record_skill_activation', ({ skillId, sessionId }) => skills.recordSkillActivation(skillId, sessionId),
    );
    ctx.commands.register<Commands['chat_v2_list_skill_candidates']['args'], Commands['chat_v2_list_skill_candidates']['result']>(
      'chat_v2_list_skill_candidates', ({ status, limit }) => skills.listSkillCandidates(status, limit),
    );
    ctx.commands.register<Commands['chat_v2_replay_skill_candidate']['args'], Commands['chat_v2_replay_skill_candidate']['result']>(
      'chat_v2_replay_skill_candidate', ({ candidateId }) => skills.replaySkillCandidate(candidateId),
    );
    ctx.commands.register<Commands['chat_v2_promote_skill_candidate']['args'], Commands['chat_v2_promote_skill_candidate']['result']>(
      'chat_v2_promote_skill_candidate', ({ candidateId }) => skills.promoteSkillCandidate(candidateId),
    );
    ctx.commands.register<Commands['chat_v2_rollback_skill_candidate']['args'], Commands['chat_v2_rollback_skill_candidate']['result']>(
      'chat_v2_rollback_skill_candidate', ({ candidateId }) => skills.rollbackSkillCandidate(candidateId),
    );
  },
});
