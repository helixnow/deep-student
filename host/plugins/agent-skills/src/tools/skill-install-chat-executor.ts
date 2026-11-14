/** roster.rs:97 `SkillInstallExecutor` (`skill_scan` / `skill_install`, skill_install_executor.rs:183-545). */
import type { HttpService } from '../../../../platform/http/api.ts';
import type { SettingsStore } from '../../../../platform/settings/api.ts';
import { now } from '../../../../platform/time/index.ts';
import type { SkillImportZipResult } from '../../api.ts';
import type { ExecutionContext, ToolCall, ToolExecutor, ToolResultInfo } from '../../../chat/api.ts';
import { downloadHttpsBytes, skillDownloadHttp } from '../http.ts';
import { formatMissingRequiresHints } from '../requires.ts';
import type { SkillPackages } from '../skill-package.ts';
import { DEFAULT_AGENT_SKILLS_BASE, readRuntimeZipBytes } from '../skill-package.ts';
import { MAX_SKILL_PACKAGE_ZIP_BYTES } from '../zip.ts';
import { chatV2Display } from './chat-v2-error.ts';
import {
  AGENT_INSTALLED_MARKER, INSTALL_SUCCESS_MESSAGE, POST_WRITE_TRUST_NEXT_STEP, PROVENANCE_SETTINGS_PREFIX, SKILL_INSTALL,
  SKILL_SCAN, SkillInstallExecutor, type ParsedSource,
} from './skill-install-executor.ts';

export interface SkillInstallChatToolDeps {
  packages(): Pick<SkillPackages, 'install' | 'prepare'>;
  /** `ctx.main_db` settings; null only warns (provenance stays in the marker file). */
  settings(): SettingsStore | null;
  /** `runtime_root_by_id(.., Some(root_id), true)` for `temp` / `artifacts`. */
  runtimeRoot(sessionId: string, skillPackageRoots: ReadonlyMap<string, string> | null, rootId: string): string;
  /** `normalize_runtime_relative_path(Some(rel))`. */
  normalizeRelativePath(raw: string): string;
  /** `ctx.http` for `source.url`. */
  http(): HttpService | null;
  download?: (url: string, maxBytes: number) => Promise<Uint8Array>;
  warn(message: string): void;
}

type Args = Record<string, unknown>;
const asArgs = (value: unknown): Args => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Args : {};
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

export class SkillInstallChatToolExecutor implements ToolExecutor {
  private readonly helpers = new SkillInstallExecutor();
  private readonly deps: SkillInstallChatToolDeps;
  constructor(deps: SkillInstallChatToolDeps) { this.deps = deps; }

  name(): string { return this.helpers.name(); }
  canHandle(toolName: string): boolean { return this.helpers.canHandle(toolName); }
  sensitivityLevel(toolName: string): 'low' | 'high' { return this.helpers.sensitivityLevel(toolName); }
  // RUST-FIX(RF-W02-skill-scan-loopback-approval): Rust keeps skill_scan Low even for a loopback source.url
  sensitivityLevelForCall(toolName: string, args: unknown): 'low' | 'high' { return this.helpers.sensitivityLevelForCall(toolName, args); }
  hasDynamicSensitivity(toolName: string): boolean { return this.helpers.hasDynamicSensitivity(toolName); }

  async execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    const started = Date.now();
    const short = SkillInstallExecutor.stripNamespace(call.name);
    ctx.emitToolCallStart(call.name, call.arguments, call.id);
    let output: unknown;
    let failure: string | null = null;
    try {
      if (short === SKILL_SCAN) output = await this.executeScan(call.arguments, ctx);
      else if (short === SKILL_INSTALL) output = await this.executeInstall(call.arguments, ctx);
      else throw new Error(`Unsupported skill install tool: ${short}`);
    } catch (error) { failure = errorText(error); }
    const durationMs = Date.now() - started;
    let result: ToolResultInfo;
    if (failure === null) {
      ctx.emitToolCallEnd({ result: output, durationMs });
      result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, output, success: true, durationMs };
    } else {
      ctx.emitToolCallError(failure);
      result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments,
        output: null, success: false, error: failure, durationMs };
    }
    try { ctx.saveToolBlock(result); }
    catch (error) { this.deps.warn(`[SkillInstallExecutor] Failed to save tool block: ${errorText(error)}`); }
    return result;
  }

  private async fetchZipBytes(source: ParsedSource, ctx: ExecutionContext): Promise<Uint8Array> {
    if (source.kind !== 'url') return this.readZipFromRuntime(source, ctx);
    if (this.deps.download !== undefined) return this.deps.download(source.detail, MAX_SKILL_PACKAGE_ZIP_BYTES);
    return downloadHttpsBytes(source.detail, MAX_SKILL_PACKAGE_ZIP_BYTES, skillDownloadHttp(() => this.deps.http()));
  }

  private async readZipFromRuntime(source: ParsedSource, ctx: ExecutionContext): Promise<Uint8Array> {
    const separator = source.detail.indexOf(':');
    if (separator < 0) throw new Error('Invalid runtime_path source detail');
    const rootId = source.detail.slice(0, separator);
    const relative = this.deps.normalizeRelativePath(source.detail.slice(separator + 1));
    const roots = ctx.skill_package_roots === null ? null : new Map(Object.entries(ctx.skill_package_roots));
    const root = this.deps.runtimeRoot(ctx.session_id, roots, rootId);
    return readRuntimeZipBytes(root, relative, source.summary);
  }

  private async executeScan(args: unknown, ctx: ExecutionContext): Promise<unknown> {
    const source = SkillInstallExecutor.parseSource(args);
    const bytes = await this.fetchZipBytes(source, ctx);
    let result: SkillImportZipResult;
    try { result = await this.deps.packages().install(bytes, DEFAULT_AGENT_SKILLS_BASE, false, true); }
    catch (error) { throw new Error(chatV2Display(error)); }
    let nextStep = 'After user confirms, call skill_install with the same source and expected_sha256 set to package_sha256 from this scan.';
    const payload: Record<string, unknown> = {
      skill_id: result.skill_id, package_sha256: result.package_sha256, risk_level: result.risk_level,
      risk_signals: result.risk_signals, scripts_count: result.scripts_count, references_count: result.references_count,
      allowed_tools_count: result.allowed_tools_count, source_summary: source.summary, install_path_preview: result.path,
      files_extracted: result.files_extracted,
    };
    const requires = result.requires ?? null;
    if (requires !== null) {
      payload.requires = requires;
      if (requires.missing_count > 0) {
        const hints = formatMissingRequiresHints(requires);
        if (hints.length > 0) payload.missing_requires_hints = hints;
        const missingPython = requires.python_packages.filter(pkg => !pkg.found).map(pkg => pkg.name);
        if (missingPython.length > 0) {
          nextStep = `Missing Python packages (${missingPython.join(', ')}). After user confirms, call skill_install with the same source and expected_sha256 set to package_sha256 from this scan; after trust is granted, propose local_shell_execute to install them (prefer \`uv pip install ...\` or \`python3 -m pip install ...\`).`;
        }
      }
    }
    payload.next_step = nextStep;
    return payload;
  }

  private async executeInstall(raw: unknown, ctx: ExecutionContext): Promise<unknown> {
    const args = asArgs(raw);
    const rawSha = args.expected_sha256 !== undefined ? args.expected_sha256 : args.expectedSha256;
    if (typeof rawSha !== 'string') throw new Error('expected_sha256 is required (use package_sha256 from skill_scan)');
    const expectedSha256 = SkillInstallExecutor.normalizeSha256(rawSha);
    const expectedSkillId = SkillInstallExecutor.expectedSkillId(args);
    const rawRisk = args.declared_risk_level !== undefined ? args.declared_risk_level : args.declaredRiskLevel;
    const declaredRisk = (typeof rawRisk === 'string' ? rawRisk : 'low').toLowerCase();
    if (declaredRisk !== 'low' && declaredRisk !== 'medium' && declaredRisk !== 'high') {
      throw new Error('declared_risk_level must be low, medium, or high');
    }
    const overwrite = typeof args.overwrite === 'boolean' ? args.overwrite : false;

    const source = SkillInstallExecutor.parseSource(args);
    const bytes = await this.fetchZipBytes(source, ctx);
    const actualSha256 = SkillInstallExecutor.sha256Hex(bytes);
    if (actualSha256 !== expectedSha256) {
      throw new Error(`Package SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}. The package may have changed since skill_scan — run skill_scan again.`);
    }

    let prepared;
    try { prepared = await this.deps.packages().prepare(bytes, DEFAULT_AGENT_SKILLS_BASE, overwrite); }
    catch (error) { throw new Error(chatV2Display(error)); }
    try {
      SkillInstallExecutor.verifyExpectedSkillId(expectedSkillId, prepared.result.skill_id);
      if (SkillInstallExecutor.riskRank(prepared.result.risk_level) > SkillInstallExecutor.riskRank(declaredRisk)) {
        throw new Error(`Detected risk_level '${prepared.result.risk_level}' is higher than declared_risk_level '${declaredRisk}'. Run skill_scan again and update declared_risk_level before installing.`);
      }
      const provenanceJson = JSON.stringify({
        sourceKind: source.kind, sourceDetail: source.detail, packageSha256: prepared.result.package_sha256,
        riskLevel: prepared.result.risk_level, installedAt: now().rfc3339, sessionId: ctx.session_id,
      }, null, 2);
      try { prepared.writeStagedFile(AGENT_INSTALLED_MARKER, new TextEncoder().encode(provenanceJson)); }
      catch (error) { throw new Error(`Failed to stage agent provenance marker: ${errorText(error)}`); }

      let installed: SkillImportZipResult, committed;
      try { [installed, committed] = prepared.commit(); }
      catch (error) { throw new Error(chatV2Display(error)); }
      const settings = this.deps.settings();
      if (settings === null) {
        this.deps.warn(`[SkillInstallExecutor] main_db unavailable; provenance for '${installed.skill_id}' written only to marker file`);
      } else {
        try { settings.save(`${PROVENANCE_SETTINGS_PREFIX}${installed.skill_id}`, provenanceJson); }
        catch (error) {
          const provenanceError = `Failed to persist skill provenance: ${errorText(error)}`;
          try { committed.rollback(); }
          catch (rollbackError) {
            throw new Error(`Failed to persist agent provenance (${provenanceError}), and failed to restore the previous skill (${chatV2Display(rollbackError)}).`);
          }
          throw new Error(`Failed to persist agent provenance (${provenanceError}); the previous skill was restored.`);
        }
      }
      committed.finalize();

      const requires = installed.requires ?? null;
      const missingHints = requires !== null && requires.missing_count > 0 ? formatMissingRequiresHints(requires) : [];
      let message = INSTALL_SUCCESS_MESSAGE;
      if (missingHints.length > 0) message += ' Some runtime dependencies are missing; see missing_requires_hints.';
      const output: Record<string, unknown> = {
        installed: true, skill_id: installed.skill_id, path: installed.path, package_sha256: installed.package_sha256,
        risk_level: installed.risk_level, risk_signals: installed.risk_signals, scripts_count: installed.scripts_count,
        references_count: installed.references_count, allowed_tools_count: installed.allowed_tools_count,
        source_summary: source.summary, trust_status: 'untrusted', message, next_step: POST_WRITE_TRUST_NEXT_STEP,
      };
      if (requires !== null) output.requires = requires;
      if (missingHints.length > 0) output.missing_requires_hints = missingHints;
      return output;
    } finally { prepared.dispose(); }
  }
}
