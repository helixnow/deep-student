/** roster.rs:99 `SkillLifecycleExecutor` (skill_lifecycle_executor.rs:165-650) bound to the chat ExecutionContext. */
import type { BackendEvents } from '../../../../kernel/api.ts';
import type { SettingsStore } from '../../../../platform/settings/api.ts';
import type { ExecutionContext, ToolCall, ToolExecutor, ToolResultInfo } from '../../../chat/api.ts';
import { SKILL_TRUST_KEY_PREFIX } from '../../../agent-workspace/api.ts';
import type { SkillFiles } from '../files.ts';
import { DEFAULT_AGENT_SKILLS_BASE } from '../skill-package.ts';
import { chatV2Display } from './chat-v2-error.ts';
import {
  BRIDGE_REQUEST_EVENT, BRIDGE_RESPONSE_PREFIX, BRIDGE_TIMEOUT_MS, PROVENANCE_SETTINGS_PREFIX, SKILL_REMOVE,
  SKILL_SET_ENABLED, SKILL_TRUST_REQUEST, SkillLifecycleExecutor, skillDescriptionFromValue, type SkillDescription,
} from './skill-lifecycle-executor.ts';
import { packageSha256, readPackageDirectory, workshopRisk } from './skill-workshop-package.ts';

export interface SkillLifecycleChatToolDeps {
  files(): Pick<SkillFiles, 'expandPath' | 'joinPath' | 'exists' | 'validatePath' | 'delete'>;
  /** `ctx.main_db` settings; null leaves provenance/trust records with a cleanup warning. */
  settings(): SettingsStore | null;
  events(): BackendEvents;
  warn(message: string): void;
  /** Test seams; default to `crypto.randomUUID` / `BRIDGE_TIMEOUT_MS`. */
  uuid?: () => string;
  bridgeTimeoutMs?: number;
}

type Args = Record<string, unknown>;
const asArgs = (value: unknown): Args => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Args : {};
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const optionalString = (value: unknown): string | null => typeof value === 'string' ? value : null;

const TRUST_FAILURE_NEXT_STEP = "Stop this skill's install/trust workflow and report the error truthfully. Do not inspect the package with workspace/shell tools, do not call load_skills, and do not retry unless a later user turn changes the state.";

export class SkillLifecycleChatToolExecutor implements ToolExecutor {
  private readonly helpers = new SkillLifecycleExecutor();
  private readonly deps: SkillLifecycleChatToolDeps;
  constructor(deps: SkillLifecycleChatToolDeps) { this.deps = deps; }

  name(): string { return this.helpers.name(); }
  canHandle(toolName: string): boolean { return this.helpers.canHandle(toolName); }
  sensitivityLevel(toolName: string): 'low' | 'medium' | 'high' { return this.helpers.sensitivityLevel(toolName); }
  sensitivityLevelForCall(toolName: string, args: unknown): 'low' | 'medium' | 'high' {
    return this.helpers.sensitivityLevelForCall(toolName, args);
  }
  hasDynamicSensitivity(toolName: string): boolean { return this.helpers.hasDynamicSensitivity(toolName); }

  async execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    const started = Date.now();
    const short = SkillLifecycleExecutor.stripNamespace(call.name);
    ctx.emitToolCallStart(call.name, call.arguments, call.id);
    let output: unknown;
    let failure: string | null = null;
    try {
      if (short === SKILL_SET_ENABLED) output = await this.executeSetEnabled(call.arguments, ctx);
      else if (short === SKILL_REMOVE) output = await this.executeRemove(call.arguments, ctx);
      else if (short === SKILL_TRUST_REQUEST) output = await this.executeTrustRequest(call.arguments, ctx);
      else throw new Error(`Unsupported skill lifecycle tool: ${short}`);
    } catch (error) { failure = errorText(error); }
    const durationMs = Date.now() - started;
    let result: ToolResultInfo;
    if (failure === null) {
      ctx.emitToolCallEnd({ result: output, durationMs });
      result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, output, success: true, durationMs };
    } else {
      ctx.emitToolCallError(failure);
      const args = asArgs(call.arguments);
      const failureOutput = short === SKILL_TRUST_REQUEST ? {
        status: 'error',
        action: args.action ?? null,
        skill_id: args.skill_id ?? null,
        terminal_for_skill_workflow: true,
        next_step: TRUST_FAILURE_NEXT_STEP,
      } : null;
      result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments,
        output: failureOutput, success: false, error: failure, durationMs };
    }
    try { ctx.saveToolBlock(result); }
    catch (error) { this.deps.warn(`[SkillLifecycleExecutor] Failed to save tool block: ${errorText(error)}`); }
    return result;
  }

  /** `bridge_call`: listen on the calling window before emitting, correlation id must echo back. */
  private async bridgeCall(ctx: ExecutionContext, command: string, args: unknown): Promise<unknown> {
    const signal = ctx.cancellation_token;
    if (signal?.aborted) throw new Error('Skill lifecycle call cancelled');
    const window = ctx.tryWindow();
    if (window === null) {
      throw new Error(`Skill lifecycle bridge requires the calling frontend window (ExecutionContext.window_ref) (command=${command})`);
    }
    const events = this.deps.events();
    const correlationId = (this.deps.uuid ?? (() => crypto.randomUUID()))();
    const timeoutMs = this.deps.bridgeTimeoutMs ?? BRIDGE_TIMEOUT_MS;
    let unlisten: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const response = await new Promise<unknown>((resolve, reject) => {
        onAbort = () => reject(new Error('Skill lifecycle call cancelled'));
        signal?.addEventListener('abort', onAbort, { once: true });
        unlisten = events.listenWindow(window, `${BRIDGE_RESPONSE_PREFIX}${correlationId}`, payload => {
          if (asArgs(payload).correlationId !== correlationId) return;
          resolve(payload);
        });
        timer = setTimeout(() => reject(new Error(
          `Skill lifecycle bridge timed out after ${timeoutMs}ms (command=${command}). The frontend bridge may not be ready.`,
        )), timeoutMs);
        try {
          events.emit(BRIDGE_REQUEST_EVENT, { correlationId, command, args, sessionId: ctx.session_id });
        } catch (error) {
          reject(new Error(`Skill lifecycle bridge emit failed: ${errorText(error)}`));
        }
      });
      if (signal?.aborted) throw new Error('Skill lifecycle call cancelled');
      const record = asArgs(response);
      if (typeof record.ok !== 'boolean') throw new Error('Skill lifecycle bridge protocol error: missing ok field');
      if (!record.ok) {
        throw new Error(`Skill lifecycle bridge rejected: ${optionalString(record.error) ?? 'unknown frontend bridge error'}`);
      }
      if (!('data' in record) || record.data === undefined) {
        throw new Error('Skill lifecycle bridge protocol error: ok=true requires data');
      }
      return record.data;
    } finally {
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      (unlisten as (() => void) | null)?.();
    }
  }

  private async describeSkill(ctx: ExecutionContext, skillId: string): Promise<SkillDescription> {
    return skillDescriptionFromValue(await this.bridgeCall(ctx, 'describe', { skillId }));
  }

  private async executeSetEnabled(rawArgs: unknown, ctx: ExecutionContext): Promise<unknown> {
    const skillId = SkillLifecycleExecutor.requiredSkillId(rawArgs);
    const enabled = asArgs(rawArgs).enabled;
    if (typeof enabled !== 'boolean') throw new Error('enabled is required (true = 启用, false = 停用)');
    const description = await this.describeSkill(ctx, skillId);
    if (!description.found) {
      throw new Error(`Skill '${skillId}' is not registered. Use self_inspect (section=skills) to list available skills.`);
    }
    const data = asArgs(await this.bridgeCall(ctx, 'set_enabled', { skillId, enabled }));
    const previousDisabled = typeof data.previousDisabled === 'boolean' ? data.previousDisabled : description.disabled;
    return {
      skill_id: skillId,
      enabled,
      previous_enabled: !previousDisabled,
      is_builtin: description.isBuiltin,
      message: enabled
        ? 'Skill enabled. It will participate in schema collection and activation from the next turn.'
        : 'Skill disabled. Already-loaded session copies are unaffected this turn; from the next turn it is excluded from schema collection, auto-activation, and manual selection. Files and definition are kept (use skill_remove to delete).',
    };
  }

  private agentSkillDir(skillId: string): string {
    const files = this.deps.files();
    const dir = files.joinPath(files.expandPath(DEFAULT_AGENT_SKILLS_BASE), skillId);
    try { files.validatePath(dir); }
    catch (error) { throw new Error(chatV2Display(error)); }
    return dir;
  }

  private async executeRemove(rawArgs: unknown, ctx: ExecutionContext): Promise<unknown> {
    const skillId = SkillLifecycleExecutor.requiredSkillId(rawArgs);
    let description: SkillDescription | null = null;
    try { description = await this.describeSkill(ctx, skillId); } catch { description = null; }
    // Bridge unavailability permits the on-disk fallback; turn cancellation does not.
    if (ctx.cancellation_token?.aborted) throw new Error('Skill lifecycle call cancelled');
    if (description?.found === true && description.isBuiltin) {
      throw new Error(`Skill '${skillId}' is builtin and cannot be removed. Use skill_set_enabled to disable it, or restore defaults in Skills management.`);
    }
    const dir = this.agentSkillDir(skillId);
    if (!this.deps.files().exists(dir)) {
      throw new Error(`Skill package '${skillId}' was not found under ${DEFAULT_AGENT_SKILLS_BASE}. Only packages in that directory can be removed by the agent; builtin skills can only be disabled, and skills in external directories must be managed in Skills management.`);
    }
    await this.deps.files().delete(dir);

    const cleanupWarnings: string[] = [];
    const settings = this.deps.settings();
    if (settings !== null) {
      try { settings.delete(`${PROVENANCE_SETTINGS_PREFIX}${skillId}`); }
      catch (error) { cleanupWarnings.push(`failed to delete provenance record: ${errorText(error)}`); }
      try { settings.delete(`${SKILL_TRUST_KEY_PREFIX}${skillId}`); }
      catch (error) { cleanupWarnings.push(`failed to delete trust record: ${errorText(error)}`); }
    } else {
      cleanupWarnings.push('main_db unavailable; provenance/trust records were not cleaned');
    }
    return {
      removed: true,
      skill_id: skillId,
      path: `${DEFAULT_AGENT_SKILLS_BASE}/${skillId}`,
      provenance_cleared: cleanupWarnings.length === 0,
      trust_record_cleared: cleanupWarnings.length === 0,
      message: 'Skill package removed. The skills registry will refresh automatically; this cannot be undone.',
      ...(cleanupWarnings.length > 0 ? { cleanup_warnings: cleanupWarnings } : {}),
    };
  }

  private trustedPackageRoot(description: SkillDescription, skillId: string): string {
    const packageRoot = description.packageRoot?.trim() ?? '';
    if (packageRoot === '') {
      throw new Error(`Skill '${skillId}' has no local package root to trust (builtin or virtual skills do not need trust).`);
    }
    if (packageRoot.startsWith('builtin://')) {
      throw new Error(`Skill '${skillId}' is builtin and is always trusted; no trust request is needed.`);
    }
    const files = this.deps.files();
    const expanded = files.expandPath(packageRoot);
    try { files.validatePath(expanded); }
    catch (error) { throw new Error(chatV2Display(error)); }
    return expanded;
  }

  private static scanInstalledPackage(root: string): [string, string, string[]] {
    const files = readPackageDirectory(root);
    const [riskLevel, riskSignals] = workshopRisk(files);
    return [packageSha256(files), riskLevel, riskSignals];
  }

  private async registeredLocalSkill(ctx: ExecutionContext, skillId: string): Promise<SkillDescription> {
    const description = await this.describeSkill(ctx, skillId);
    if (!description.found) throw new Error(`Skill '${skillId}' is not registered.`);
    if (description.isBuiltin) {
      throw new Error(`Skill '${skillId}' is builtin and is always trusted; no trust request is needed.`);
    }
    return description;
  }

  private async executeTrustInspect(rawArgs: unknown, ctx: ExecutionContext): Promise<unknown> {
    const skillId = SkillLifecycleExecutor.requiredSkillId(rawArgs);
    const description = await this.registeredLocalSkill(ctx, skillId);
    const root = this.trustedPackageRoot(description, skillId);
    const [sha256, riskLevel, riskSignals] = SkillLifecycleChatToolExecutor.scanInstalledPackage(root);
    return {
      action: 'inspect',
      skill_id: skillId,
      skill_name: description.name ?? null,
      trust_status: description.trustStatus ?? null,
      package_root: root,
      package_sha256: sha256,
      risk_level: riskLevel,
      risk_signals: riskSignals,
      next_step: 'Explain the reason and risk summary to the user, then call skill_trust_request with action=grant, the same skill_id, reason, expected_package_sha256 set to package_sha256, and declared_risk_level set to risk_level from this result. Grant requires user approval and cannot be remembered.',
    };
  }

  private async executeTrustGrant(rawArgs: unknown, ctx: ExecutionContext): Promise<unknown> {
    const skillId = SkillLifecycleExecutor.requiredSkillId(rawArgs);
    const args = asArgs(rawArgs);
    const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
    if (reason === '') throw new Error('reason is required for grant (shown to the user on the approval card)');
    const rawExpected = args.expected_package_sha256 ?? args.expectedPackageSha256;
    if (typeof rawExpected !== 'string') {
      throw new Error('expected_package_sha256 is required (use package_sha256 from action=inspect)');
    }
    const expected = SkillLifecycleExecutor.normalizeSha256(rawExpected, 'expected_package_sha256');
    const rawDeclared = args.declared_risk_level ?? args.declaredRiskLevel;
    const declaredRisk = (typeof rawDeclared === 'string' ? rawDeclared : 'low').toLowerCase();
    if (!['low', 'medium', 'high'].includes(declaredRisk)) {
      throw new Error('declared_risk_level must be low, medium, or high');
    }

    const description = await this.registeredLocalSkill(ctx, skillId);
    const root = this.trustedPackageRoot(description, skillId);
    const [current, riskLevel, riskSignals] = SkillLifecycleChatToolExecutor.scanInstalledPackage(root);
    if (current !== expected) {
      throw new Error(`Skill package changed since inspection: expected ${expected}, got ${current}. Run skill_trust_request with action=inspect again and show the user the new fingerprint.`);
    }
    if (SkillLifecycleExecutor.riskRank(riskLevel) > SkillLifecycleExecutor.riskRank(declaredRisk)) {
      throw new Error(`Detected risk_level '${riskLevel}' is higher than declared_risk_level '${declaredRisk}'. Run action=inspect again and update declared_risk_level before granting.`);
    }

    const grant = asArgs(await this.bridgeCall(ctx, 'trust_grant', { skillId }));
    const granted = optionalString(grant.packageSha256);
    if (granted !== null && granted !== expected) {
      let revoke: string;
      try {
        await this.bridgeCall(ctx, 'trust_revoke', { skillId });
        revoke = 'revoked';
      } catch (error) { revoke = `revoke also failed: ${errorText(error)}`; }
      throw new Error(`Trust binding mismatch: backend bound package ${granted}, but the approved fingerprint is ${expected}. The grant was revoked (${revoke}). Inspect again before retrying.`);
    }
    return {
      action: 'grant',
      granted: true,
      skill_id: skillId,
      reason,
      package_root: root,
      package_sha256: expected,
      risk_level: riskLevel,
      risk_signals: riskSignals,
      runtime_catalog_refresh: 'next_user_turn',
      load_skills_now: false,
      next_step: 'Do not call load_skills again in this tool loop. The trust grant succeeded, but this request keeps its immutable pre-grant runtime catalog snapshot. Tell the user the skill is trusted and will be loadable from their next message.',
      message: 'Trust granted, bound to the current package fingerprint. Any change to any package file invalidates the trust automatically and requires a new grant. The current request keeps its pre-grant runtime catalog snapshot; the trusted skill becomes loadable on the next user turn.',
    };
  }

  private executeTrustRequest(rawArgs: unknown, ctx: ExecutionContext): Promise<unknown> {
    const action = asArgs(rawArgs).action;
    if (typeof action !== 'string') return Promise.reject(new Error('action is required (inspect | grant)'));
    if (action === 'inspect') return this.executeTrustInspect(rawArgs, ctx);
    if (action === 'grant') return this.executeTrustGrant(rawArgs, ctx);
    return Promise.reject(new Error(`Unsupported action '${action}'. Allowed: inspect, grant`));
  }
}
