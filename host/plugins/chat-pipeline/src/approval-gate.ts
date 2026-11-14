/** hooks.rs:152–1110 + 1153–1560 — default hook chain: ApprovalGateHook (admission) then TaskAuditHook.
 * L03 owns the gate order and every branch; classification/policy/approval storage are owner ports.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ChatV2Emitter, ToolResultInfo } from '../../chat/api.ts';
import type { AuthorityState, JsonValue, PermissionPreset, ToolSensitivity } from '../api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import {
  askBlockStructuredOutput, evaluateAuthorityGate, planBindingSatisfiesToolApproval, planCallBindingKey,
  requiresToolApproval, type PlanGateManager,
} from './authority-mode.ts';
import { ToolAdmission } from './hooks.ts';
import { budgetExceededMessage, ONE_TOOL_CALL, treeKeyForSession, tryConsume } from './budget.ts';
import type { ShellCommandGuardDecision } from '../../agent-workspace/api.ts';
import * as chatApi from '../../chat/api.ts';

/** grants.rs registry published by L04 (chat api.ts lookupGrantForSession/ensureGrantLive/grantDenialMessage).
 * The registry is process state owned by L04; before that export is integrated nothing can register a
 * grant, which is Rust's `lookup_grant_for_session(..) == None` branch.
 */
interface GrantRegistryApi {
  lookupGrantForSession(sessionId: string): { grantId: string } | null;
  ensureGrantLive(grant: { grantId: string }): 'revoked' | 'expired' | null;
  grantDenialMessage(denial: 'revoked' | 'expired', grantId: string, toolName: string): string;
}
export function grantDenialForSession(sessionId: string, toolName: string,
  api: Partial<GrantRegistryApi> = chatApi as unknown as Partial<GrantRegistryApi>): string | null {
  if (typeof api.lookupGrantForSession !== 'function' || typeof api.ensureGrantLive !== 'function'
    || typeof api.grantDenialMessage !== 'function') return null;
  const grant = api.lookupGrantForSession(sessionId);
  if (grant === null) return null;
  const denial = api.ensureGrantLive(grant);
  return denial === null ? null : api.grantDenialMessage(denial, grant.grantId, toolName);
}

type Log = Pick<Context['logger'], 'info' | 'warn' | 'error' | 'debug'>;
export interface GateToolCall { id: string; name: string; arguments: JsonValue }

/** hooks.rs ToolHookContext */
export interface ToolHookContext {
  toolCall: GateToolCall; blockId: string; emitter: ChatV2Emitter; sessionId: string; messageId: string;
  variantId: string | null; skillStateVersion: number | null; roundId: string | null;
  skillPackageRoots: Record<string, string> | null; executionAllowedTools: string[] | null;
  cancellation: AbortSignal | null; memoryEnabled: boolean; ragEnabled: boolean; webSearchEnabled: boolean;
}

/** Plan state written through the L04 owner (types.rs PlanAuthorityState). */
export interface PendingPlan { planId: string; markApproved(ttlSecs: number): void }
export interface ApprovalWait { approved: boolean; reason: string | null }
/** approval_manager.rs surface used by request_tool_approval. */
export interface ToolApprovalManagerPort {
  defaultTimeout(): number;
  checkSessionRemembered(sessionId: string, toolName: string, args: JsonValue): boolean | null;
  registerWithPermissionPreset(sessionId: string, toolCallId: string, toolName: string, args: JsonValue,
    preset: PermissionPreset, sensitivity: ToolSensitivity): Promise<ApprovalWait>;
  cancelWithSession(sessionId: string, toolCallId: string): void;
  generateDescription(toolName: string, args: JsonValue): string;
}
/** Owner classification/policy calls (approval_scope, tool_policy, shell_command_policy, headless, grants). */
export interface ApprovalGatePorts {
  killSwitchError(): string | null;
  executionPolicyAllows(toolName: string, args: JsonValue, allowed: readonly string[] | null): boolean;
  trustedAutomationError(sessionId: string, toolName: string, args: JsonValue): string | null;
  trustedAutomationPreauthorized(sessionId: string, toolName: string, args: JsonValue): boolean;
  isLocalShell(toolName: string, args: JsonValue): boolean;
  isExternalMcp(toolName: string, args: JsonValue): boolean;
  immutableGuard(call: GateToolCall): ShellCommandGuardDecision | null;
  /** shell_command_policy::enforce_for_call; null when the call is not a shell-runtime call. */
  shellCommandDecision(call: GateToolCall, isLocalShell: boolean): { deny: boolean;
    applyToSensitivity(sensitivity: ToolSensitivity | null): ToolSensitivity | null } | null;
  resolveLocalShellApprovalArguments(call: GateToolCall, emitter: ChatV2Emitter, sessionId: string,
    skillPackageRoots: Record<string, string> | null): { ok: true; value: JsonValue | null } | { ok: false; error: string };
  runtimeRootBinding(args: JsonValue): string | null;
  runtimeScopeKey(toolName: string, args: JsonValue): string;
  baseSensitivity(toolName: string, args: JsonValue): ToolSensitivity | null;
  effectiveSensitivity(base: ToolSensitivity | null, toolName: string, args: JsonValue): ToolSensitivity | null;
  authorityState(sessionId: string): AuthorityState;
  consumePlanBinding(sessionId: string, bindingKey: string, now: Date): boolean;
  newPendingPlan(summary: string, bindingKey: string): PendingPlan;
  setPlanState(sessionId: string, plan: PendingPlan | null): void;
  isPrivilegeEscalation(toolName: string, args: JsonValue): boolean;
  neverRememberApproval(toolName: string, args: JsonValue): boolean;
  redactForDisplay(toolName: string, args: JsonValue): JsonValue;
  runtimeApprovalScope(toolName: string, args: JsonValue, sensitivity: string): JsonValue;
  approvalManager: ToolApprovalManagerPort | null;
  planGates: PlanGateManager;
}

type Outcome = { kind: 'approved' } | { kind: 'rejected'; reason: string | null } | { kind: 'timeout' }
  | { kind: 'channelClosed' } | { kind: 'cancelled' };
export type ToolGateOutcome = { kind: 'proceed' } | { kind: 'block'; result: ToolResultInfo };

/** hooks.rs:200 preflight_blocked_result */
export function preflightBlockedResult(ctx: ToolHookContext, ports: Pick<ApprovalGatePorts, 'redactForDisplay'>,
  error: string): ToolResultInfo {
  const call = ctx.toolCall;
  const display = ports.redactForDisplay(call.name, call.arguments);
  ctx.emitter.emitStartWithMeta('tool_call', ctx.messageId, ctx.blockId,
    { toolName: call.name, toolInput: display, toolCallId: call.id }, ctx.variantId, ctx.skillStateVersion, ctx.roundId);
  ctx.emitter.emitErrorWithMeta('tool_call', ctx.blockId, error, ctx.variantId, ctx.skillStateVersion, ctx.roundId);
  return { toolCallId: call.id, blockId: ctx.blockId, toolName: call.name, input: display, output: null,
    success: false, error };
}

/** hooks.rs:1129 wait_oneshot_with_optional_cancel → 'cancelled' | 'timeout' | settled value/closed. */
async function waitWithCancel<T>(pending: Promise<T>, timeoutSecs: number, signal: AbortSignal | null):
  Promise<{ kind: 'cancelled' } | { kind: 'timeout' } | { kind: 'closed' } | { kind: 'ok'; value: T }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let remove = () => {};
  const races: Promise<{ kind: 'cancelled' } | { kind: 'timeout' } | { kind: 'closed' } | { kind: 'ok'; value: T }>[] = [
    pending.then(value => ({ kind: 'ok' as const, value }), () => ({ kind: 'closed' as const })),
    new Promise(resolve => { timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutSecs * 1000); }),
  ];
  if (signal !== null) {
    races.push(new Promise(resolve => {
      const abort = () => resolve({ kind: 'cancelled' });
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      remove = () => signal.removeEventListener('abort', abort);
    }));
  }
  try { return await Promise.race(races); } finally { clearTimeout(timer); remove(); }
}
const userReason = (reason: string | null) => {
  if (reason === null) return null;
  const trimmed = rustTrim(reason);
  return trimmed === '' || trimmed === 'user_rejected' || trimmed === 'timeout' ? null : reason;
};

export class ApprovalGateHook {
  private readonly ports: ApprovalGatePorts;
  private readonly log: Log;
  constructor(ports: ApprovalGatePorts, log: Log) { this.ports = ports; this.log = log; }

  /** hooks.rs:254 before_tool */
  async beforeTool(ctx: ToolHookContext, admission: ToolAdmission): Promise<ToolGateOutcome> {
    const { ports, log } = this;
    const call = ctx.toolCall;
    const block = (message: string): ToolGateOutcome => ({ kind: 'block', result: preflightBlockedResult(ctx, ports, message) });
    const killed = ports.killSwitchError();
    if (killed !== null) {
      log.warn(`[ChatV2::pipeline] KillSwitch blocked tool '${call.name}' before authority/approval`);
      const display = ports.redactForDisplay(call.name, call.arguments);
      ctx.emitter.emitStartWithMeta('tool_call', ctx.messageId, ctx.blockId, { toolName: call.name, toolInput: display,
        toolCallId: call.id, killSwitchBlocked: true }, ctx.variantId, ctx.skillStateVersion, ctx.roundId);
      ctx.emitter.emitErrorWithMeta('tool_call', ctx.blockId, killed, ctx.variantId, ctx.skillStateVersion, ctx.roundId);
      return { kind: 'block', result: { toolCallId: call.id, blockId: ctx.blockId, toolName: call.name, input: display,
        output: { killSwitchBlocked: true, message: killed }, success: false, error: killed } };
    }
    const shortName = canonicalShortName(call.name);
    const grant = grantDenialForSession(ctx.sessionId, call.name);
    if (grant !== null) {
      log.warn(`[ChatV2::pipeline] DelegatedGrant gate blocked tool '${call.name}': ${grant}`);
      return block(grant);
    }
    const treeKey = treeKeyForSession(ctx.sessionId);
    if (treeKey !== null) {
      const consumed = tryConsume(treeKey, ONE_TOOL_CALL);
      if (consumed.ok === false) {
        const message = budgetExceededMessage(consumed.exceeded, call.name);
        log.warn(`[ChatV2::pipeline] Tree budget gate blocked tool '${call.name}': ${message}`);
        return block(message);
      }
    }
    if (!ports.executionPolicyAllows(call.name, call.arguments, ctx.executionAllowedTools)) {
      log.warn(`[ChatV2::pipeline] Tool blocked by runtime execution allowlist: tool=${call.name}, allowed_count=${ctx.executionAllowedTools?.length ?? 0}`);
      return block(`当前运行时未允许调用工具 '${call.name}'，工具调用已被后端拦截`);
    }
    const automation = ports.trustedAutomationError(ctx.sessionId, call.name, call.arguments);
    if (automation !== null) {
      log.warn(`[ChatV2::pipeline] Trusted automation profile blocked tool '${call.name}': ${automation}`);
      return block(automation);
    }
    const isMemory = shortName.startsWith('memory_');
    const isRag = shortName.startsWith('rag_') || shortName === 'unified_search' || shortName === 'multimodal_search';
    if (isMemory && !ctx.memoryEnabled) return block('memory 功能已关闭，工具调用被拦截');
    if (isRag && !ctx.ragEnabled) return block('RAG 功能已关闭，工具调用被拦截');
    if (shortName === 'web_search' && !ctx.webSearchEnabled) return block('WebSearch 功能已关闭，工具调用被拦截');
    const isLocalShell = ports.isLocalShell(call.name, call.arguments);
    const isExternalMcp = ports.isExternalMcp(call.name, call.arguments);
    const guard = ports.immutableGuard(call);
    if (guard?.effect === 'deny') return block('终端命令被不可覆盖的灾难命令守卫拒绝');
    const shellDecision = ports.shellCommandDecision(call, isLocalShell);
    if (shellDecision?.deny) return block('终端命令被用户配置的拒绝规则拦截');
    const resolved = ports.resolveLocalShellApprovalArguments(call, ctx.emitter, ctx.sessionId, ctx.skillPackageRoots);
    if (resolved.ok === false) return block(`无法绑定本地终端审批作用域: ${resolved.error}`);
    const approvalArguments = resolved.value ?? call.arguments;
    const expectedBinding = ports.runtimeRootBinding(approvalArguments);
    const expectedScopeKey = expectedBinding === null ? null : ports.runtimeScopeKey(call.name, approvalArguments);
    const sensitivity = ports.baseSensitivity(call.name, call.arguments);
    let effective = ports.effectiveSensitivity(sensitivity, call.name, call.arguments);
    if (shellDecision !== null) effective = shellDecision.applyToSensitivity(effective);
    const planKey = planCallBindingKey(call.name, approvalArguments, ctx.roundId);
    let authority: AuthorityState;
    try { authority = ports.authorityState(ctx.sessionId); }
    catch (error) {
      log.error(`[ChatV2::pipeline] Failed to load authority mode for ${ctx.sessionId}: ${errorText(error)}; refusing tool`);
      return block('无法读取会话权限状态，已安全阻止工具执行');
    }
    let planJustApproved = false;
    const decision = evaluateAuthorityGate(authority, call.name, effective, planKey, new Date());
    if (decision.kind === 'blockAsk') {
      log.info(`[ChatV2::pipeline] AuthorityGate Ask blocked write tool '${decision.toolName}'`);
      const display = ports.redactForDisplay(call.name, call.arguments);
      ctx.emitter.emitStartWithMeta('tool_call', ctx.messageId, ctx.blockId, { toolName: call.name, toolInput: display,
        toolCallId: call.id, authorityBlocked: true, authorityMode: 'ask', suggestedMode: 'plan' },
      ctx.variantId, ctx.skillStateVersion, ctx.roundId);
      ctx.emitter.emitErrorWithMeta('tool_call', ctx.blockId, decision.message, ctx.variantId, ctx.skillStateVersion, ctx.roundId);
      return { kind: 'block', result: { toolCallId: call.id, blockId: ctx.blockId, toolName: call.name, input: display,
        output: askBlockStructuredOutput(decision.toolName), success: false, error: decision.message } };
    }
    if (decision.kind === 'waitPlanGate') {
      const outcome = await this.requestPlanGate(ctx, approvalArguments, decision.summary, planKey);
      switch (outcome.kind) {
        case 'approved': planJustApproved = true; break;
        case 'rejected': return block(outcome.reason === null ? '用户拒绝了计划执行' : `用户拒绝了计划执行。用户说明：${outcome.reason}`);
        case 'timeout': return block('计划确认等待超时，请重试');
        case 'channelClosed': return block('计划确认通道异常关闭，请重试');
        case 'cancelled': return block('流已取消，计划确认中止');
      }
    }
    const guardAsks = guard?.effect === 'ask';
    const privilege = ports.isPrivilegeEscalation(call.name, call.arguments);
    const planCovers = planBindingSatisfiesToolApproval(authority, planKey, privilege, planJustApproved, new Date());
    const approvalRequired = planCovers ? false
      : requiresToolApproval(authority, sensitivity, effective, guardAsks, isExternalMcp, privilege);
    if (privilege && approvalRequired && authority.authorityMode === 'craft'
      && (authority.permissionPreset === 'full_access' || authority.permissionPreset === 'danger_full_access')) {
      log.info(`[ChatV2::audit] privilege_escalation=true approval_forced=true permission_preset=${authority.permissionPreset} session=${ctx.sessionId} tool_call_id=${call.id} tool=${call.name}`);
    }
    let satisfied = false;
    const trusted = !guardAsks && ports.trustedAutomationPreauthorized(ctx.sessionId, call.name, call.arguments);
    if (trusted && approvalRequired) {
      satisfied = true;
      log.info(`[ChatV2::pipeline] trusted_automation_preauthorized: skipping ApprovalManager for tool '${call.name}' (session=${ctx.sessionId}, tool_call_id=${call.id}, sensitivity=${effective === null ? 'None' : `Some(${cap(effective)})`})`);
    }
    if (approvalRequired && !trusted) {
      const manager = ports.approvalManager;
      if (manager === null) {
        log.error(`[ChatV2::pipeline] Refusing ${effective === null ? 'None' : `Some(${cap(effective)})`} tool '${call.name}' because ApprovalManager is unavailable`);
        return block('审批服务不可用，已阻止中高风险工具执行');
      }
      const irreversible = ports.neverRememberApproval(call.name, approvalArguments);
      const canRemember = !guardAsks && authority.authorityMode === 'craft' && authority.permissionPreset === 'relaxed'
        && sensitivity === 'medium' && effective === 'medium' && !irreversible;
      const remembered = canRemember ? manager.checkSessionRemembered(ctx.sessionId, call.name, approvalArguments) : null;
      if (remembered !== null) {
        log.info(`[ChatV2::pipeline] Tool ${call.name} approval remembered: ${remembered} (persisted=false)`);
        if (!remembered) return block('用户已拒绝此工具执行');
        satisfied = true;
      } else {
        const actual: ToolSensitivity = guardAsks || sensitivity === 'high' || effective === 'high' ? 'high'
          : effective ?? sensitivity ?? 'medium';
        const preset: PermissionPreset = authority.authorityMode === 'craft' ? authority.permissionPreset : 'cautious';
        const outcome = await this.requestToolApproval(ctx, approvalArguments, actual, preset, manager);
        switch (outcome.kind) {
          case 'approved': satisfied = true; break;
          case 'rejected': return block(outcome.reason === null ? '用户拒绝执行此工具' : `用户拒绝执行此工具。用户说明：${outcome.reason}`);
          case 'timeout': return block('工具审批等待超时，请重试');
          case 'channelClosed': return block('工具审批通道异常关闭，请重试');
          case 'cancelled': return block('流已取消，工具审批中止');
        }
      }
    }
    if (expectedBinding !== null) {
      const rebound = ports.resolveLocalShellApprovalArguments(call, ctx.emitter, ctx.sessionId, ctx.skillPackageRoots);
      if (rebound.ok === false) return block(`本地终端运行时作用域在审批后发生变化: ${rebound.error}`);
      if (rebound.value === null) return block('本地终端审批绑定在执行前丢失');
      if (ports.runtimeRootBinding(rebound.value) !== expectedBinding
        || expectedScopeKey !== ports.runtimeScopeKey(call.name, rebound.value)) {
        log.warn(`[ChatV2::pipeline] Runtime-root approval binding changed before shell exec: tool_call_id=${call.id}`);
        return block('本地终端运行时目录、访问权限、环境或可读范围在审批后发生变化，请重新审批');
      }
    }
    const killedLate = ports.killSwitchError();
    if (killedLate !== null) return block(killedLate);
    if (ctx.cancellation?.aborted) return block('流已取消，工具执行中止');
    let current: AuthorityState;
    try { current = ports.authorityState(ctx.sessionId); }
    catch (error) {
      log.error(`[ChatV2::pipeline] Authority re-check failed for ${ctx.sessionId}: ${errorText(error)}`);
      return block('执行前无法复核会话权限，已安全阻止工具执行');
    }
    const currentCovers = planBindingSatisfiesToolApproval(current, planKey, privilege, planJustApproved, new Date());
    const currentRequired = !currentCovers
      && requiresToolApproval(current, sensitivity, effective, guardAsks, isExternalMcp, privilege);
    if (currentRequired && !satisfied) return block('会话审批策略在执行前发生变化，当前调用需要重新审批');
    const recheck = evaluateAuthorityGate(current, call.name, effective, planKey, new Date());
    if (recheck.kind === 'allow') {
      if (current.authorityMode === 'plan') {
        let consumed: boolean;
        try { consumed = ports.consumePlanBinding(ctx.sessionId, planKey, new Date()); }
        catch (error) {
          log.error(`[ChatV2::pipeline] Failed to consume plan approval: ${errorText(error)}`);
          return block('无法原子消费计划批准，已安全阻止工具执行');
        }
        if (!consumed) return block('计划批准已被消费或与当前调用不匹配，请重新确认');
      }
    } else if (recheck.kind === 'blockAsk') return block(recheck.message);
    else return block('计划批准已过期或与当前工具调用不匹配，请重新确认');
    if (guardAsks) admission.markImmutableGuardAsks();
    if (approvalRequired) admission.markApprovalRequired();
    if (satisfied) admission.markApprovalSatisfied();
    if (isExternalMcp) admission.markExternalMcp();
    if (trusted) admission.markTrustedAutomationPreauthorized();
    admission.recordAuthorityAdmission(current.authorityMode, current.permissionPreset);
    return { kind: 'proceed' };
  }

  /** hooks.rs:1274 request_tool_approval */
  private async requestToolApproval(ctx: ToolHookContext, approvalArguments: JsonValue, sensitivity: ToolSensitivity,
    preset: PermissionPreset, manager: ToolApprovalManagerPort): Promise<Outcome> {
    const { ports, log } = this;
    const call = ctx.toolCall;
    const timeout = manager.defaultTimeout();
    const approvalBlockId = `approval_${call.id}`;
    const request = { sessionId: ctx.sessionId, toolCallId: call.id, toolName: call.name,
      arguments: ports.redactForDisplay(call.name, approvalArguments), sensitivity, permissionPreset: preset,
      description: manager.generateDescription(call.name, approvalArguments), timeoutSeconds: timeout,
      runtimeScope: ports.runtimeApprovalScope(call.name, approvalArguments, sensitivity) };
    const pending = manager.registerWithPermissionPreset(ctx.sessionId, call.id, call.name, approvalArguments, preset, sensitivity);
    log.info(`[ChatV2::pipeline] Emitting tool approval request: tool=${call.name}, sensitivity=${cap(sensitivity)}`);
    log.debug(`[ChatV2::pipeline] tool approval block mapping: tool_block_id=${ctx.blockId}, approval_block_id=${approvalBlockId}`);
    ctx.emitter.emitStart('tool_approval_request', ctx.messageId, approvalBlockId, request, null);
    const waited = await waitWithCancel(pending, timeout, ctx.cancellation);
    switch (waited.kind) {
      case 'cancelled':
        log.info(`[ChatV2::pipeline] Stream cancelled while waiting approval for tool: ${call.name}`);
        manager.cancelWithSession(ctx.sessionId, call.id);
        ctx.emitter.emitError('tool_approval_request', approvalBlockId, 'approval_cancelled', null);
        return { kind: 'cancelled' };
      case 'ok': {
        log.info(`[ChatV2::pipeline] Received approval response: approved=${waited.value.approved}`);
        ctx.emitter.emitEnd('tool_approval_request', approvalBlockId,
          { toolCallId: call.id, approved: waited.value.approved, reason: waited.value.reason }, null);
        return waited.value.approved ? { kind: 'approved' } : { kind: 'rejected', reason: userReason(waited.value.reason) };
      }
      case 'closed':
        log.warn('[ChatV2::pipeline] Approval channel closed unexpectedly');
        ctx.emitter.emitError('tool_approval_request', approvalBlockId, 'approval_channel_closed', null);
        manager.cancelWithSession(ctx.sessionId, call.id);
        return { kind: 'channelClosed' };
      case 'timeout':
        log.warn(`[ChatV2::pipeline] Approval timeout for tool: ${call.name}`);
        manager.cancelWithSession(ctx.sessionId, call.id);
        ctx.emitter.emitError('tool_approval_request', approvalBlockId, 'approval_timeout', null);
        return { kind: 'timeout' };
    }
  }

  /** hooks.rs:1428 request_plan_gate */
  private async requestPlanGate(ctx: ToolHookContext, approvalArguments: JsonValue, summary: string,
    bindingKey: string): Promise<Outcome> {
    const { ports, log } = this;
    const call = ctx.toolCall;
    const manager = ports.planGates;
    const timeout = manager.defaultTimeout();
    const pendingPlan = ports.newPendingPlan(summary, bindingKey);
    const planBlockId = `plan_gate_${call.id}`;
    try { ports.setPlanState(ctx.sessionId, pendingPlan); }
    catch (error) { log.warn(`[ChatV2::pipeline] Failed to persist pending plan for ${ctx.sessionId}: ${errorText(error)}`); }
    const request = { sessionId: ctx.sessionId, planId: pendingPlan.planId, toolCallId: call.id, toolName: call.name,
      summary, timeoutSeconds: timeout, arguments: ports.redactForDisplay(call.name, approvalArguments) };
    const pending = manager.register(ctx.sessionId, call.id, pendingPlan.planId);
    log.info(`[ChatV2::pipeline] Emitting plan_gate: planId=${pendingPlan.planId}, tool=${call.name}, round=${ctx.roundId === null ? 'None' : `Some(${JSON.stringify(ctx.roundId)})`}`);
    ctx.emitter.emitStart('plan_gate', ctx.messageId, planBlockId, request, null);
    // Rust `let _ = set_session_plan_state(.., None)`: the clearing result is intentionally discarded.
    const clear = (): boolean => { try { ports.setPlanState(ctx.sessionId, null); return true; } catch { return false; } };
    const waited = await waitWithCancel(pending, timeout, ctx.cancellation);
    switch (waited.kind) {
      case 'cancelled':
        log.info(`[ChatV2::pipeline] Stream cancelled while waiting plan_gate for tool: ${call.name}`);
        manager.cancel(ctx.sessionId, call.id); clear();
        ctx.emitter.emitError('plan_gate', planBlockId, 'plan_gate_cancelled', null);
        return { kind: 'cancelled' };
      case 'ok': {
        const response = waited.value;
        ctx.emitter.emitEnd('plan_gate', planBlockId, { planId: pendingPlan.planId, toolCallId: call.id,
          approved: response.approved, reason: response.reason ?? null }, null);
        if (response.approved) {
          pendingPlan.markApproved(30 * 60);
          try { ports.setPlanState(ctx.sessionId, pendingPlan); }
          catch (error) {
            log.error(`[ChatV2::pipeline] Failed to persist approved plan ${pendingPlan.planId}: ${errorText(error)}`);
            return { kind: 'rejected', reason: 'failed to persist plan approval' };
          }
          return { kind: 'approved' };
        }
        clear();
        return { kind: 'rejected', reason: userReason(response.reason ?? null) };
      }
      case 'closed':
        log.warn('[ChatV2::pipeline] Plan gate channel closed unexpectedly');
        manager.cancel(ctx.sessionId, call.id); clear();
        ctx.emitter.emitError('plan_gate', planBlockId, 'plan_gate_channel_closed', null);
        return { kind: 'channelClosed' };
      case 'timeout':
        log.warn(`[ChatV2::pipeline] Plan gate timeout for tool: ${call.name}`);
        manager.cancel(ctx.sessionId, call.id); clear();
        ctx.emitter.emitError('plan_gate', planBlockId, 'plan_gate_timeout', null);
        return { kind: 'timeout' };
    }
  }
}

/** hooks.rs:1014–1104 TaskAuditHook::after_tool */
export function taskAuditAfterTool(ctx: ToolHookContext, admission: ToolAdmission, result: ToolResultInfo, log: Log): void {
  const call = ctx.toolCall;
  const authority = admission.authorityAdmission();
  if (authority !== null) {
    const [mode, preset] = authority;
    if (admission.isExternalMcp && mode === 'craft' && (preset === 'full_access' || preset === 'danger_full_access')) {
      log.info(`[ChatV2::audit] external_mcp=true approval_bypassed=true permission_preset=${preset} local_shell_sandbox_guaranteed=false runtime_roots_guaranteed=false command_guard_guaranteed=false session=${ctx.sessionId} tool_call_id=${call.id} tool=${call.name} success=${result.success}`);
      if (isObject(result.output)) {
        result.output.external_mcp_security_boundary = { approval_bypassed: true, permission_preset: preset,
          local_shell_sandbox_guaranteed: false, runtime_roots_guaranteed: false, command_guard_guaranteed: false };
      }
    }
  }
  if (admission.trustedAutomationPreauthorized) {
    if (isObject(result.output) && !('trusted_automation_preauthorized' in result.output)) {
      result.output.trusted_automation_preauthorized = true;
    }
    log.info(`[ChatV2::pipeline] tool '${call.name}' executed under trusted_automation_preauthorized (session=${ctx.sessionId}, tool_call_id=${call.id}, success=${result.success})`);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const cap = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
/** hooks.rs:1260 canonical_tool_short_name */
export function canonicalShortName(name: string): string {
  for (const prefix of ['builtin-', 'builtin:', 'mcp.tools.', 'mcp_']) if (name.startsWith(prefix)) return name.slice(prefix.length);
  return name;
}
