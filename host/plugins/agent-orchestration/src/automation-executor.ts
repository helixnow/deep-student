/**
 * `AutomationExecutor` (chat_v2/tools/automation_executor.rs): the nine automation_* agent tools over the
 * main-database automation repository, with agent-facing OCC errors and friendly hints.
 */
import type { ChatExecutionContext, ToolCall, ToolResultInfo } from '../../chat/api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import {
  automationToAgentListItem, cancelAutomationRun, createAutomation, deleteAutomation, listAutomationRunsPage,
  loadAutomations, scheduleToListItem, setAutomationEnabled, updateAutomationFull,
  type AutomationDefinition, type AutomationUpdateFields,
} from '../repository/automations.ts';
import { isAppError } from '../repository/automation-model.ts';
import { retryAutomationRunCore } from '../repository/automation-summary.ts';
import { MAX_AUTOMATIONS, MAX_PROMPT_LEN, computeNextTrigger, formatTimestampMillis, parseTimestampMillis,
  validateAutomationFields, DEFAULT_MAX_RETRIES, DEFAULT_RETRY_BACKOFF_SECS, DEFAULT_TIMEOUT_SECS,
  type AutomationSchedule } from './automation-schedule.ts';
import { serializeAutomationUpdateError } from './automation-errors.ts';
import { runAutomationNow, type AutomationRuntimeDeps } from './automation-runtime.ts';
import { normalizeTrustedProfile, type TrustedAutomationProfile } from './trusted-profile.ts';
import {
  AUTOMATION_DUPLICATE_CODE, AUTOMATION_TOOL_NAMES as TOOLS, PROPOSE_ALLOWED_KEYS, annotateOnceCompleted,
  automationSensitivityLevel, automationSensitivityLevelForCall, canHandleAutomationTool, describeSchedule,
  friendlyAutomationError, hasDynamicAutomationSensitivity, parseActionType, parseAgentFields, parseCatchUpPolicy,
  parseNullableSessionMode, parseNullableString, parseOptionalActionType, parseOptionalU64, parseRequiredString,
  parseRequiredVersion, parseToolSchedule, provided, rejectUnknownFields, stripToolNamespace, type JsonObject,
} from './automation-tool-args.ts';

const SET_ENABLED_ALLOWED_KEYS = ['id', 'expected_version', 'enabled'];
const UPDATE_ALLOWED_KEYS = ['id', 'expected_version', 'name', 'schedule', 'prompt', 'action_type', 'agent_prompt',
  'session_mode', 'model_id', 'catch_up_policy', 'max_retries', 'retry_backoff_seconds', 'timeout_seconds',
  'trusted_profile'];
const ID_ONLY_ALLOWED_KEYS = ['id'];
const ID_VERSION_ALLOWED_KEYS = ['id', 'expected_version'];
const RUNS_ALLOWED_KEYS = ['automation_id', 'status', 'page', 'page_size'];
const RUN_STATUS_VALUES = ['queued', 'running', 'retrying', 'success', 'error', 'timeout', 'spawn_error',
  'cancelled', 'skipped', 'heartbeat_ok'];
const RUNS_MAX_PAGE = 1_000_000;

export interface AutomationExecutorDeps {
  /** Rust `with_database` fallback when `ctx.main_db` is absent (the app's main `Database`). */
  database(): DatabaseHandle;
  runtime(): AutomationRuntimeDeps;
  emitChanged(action: string, automationId: string): void;
  warn(message: string): void;
}

const errorText = (error: unknown): string => isAppError(error) ? error.message
  : error instanceof Error ? error.message : String(error);
const asObject = (value: unknown): JsonObject | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
const pad = (value: number): string => String(value).padStart(2, '0');

/** Agent-facing OCC errors: conflicts serialize the truncated payload, everything else is the plain message. */
function occ<T>(work: () => T): T {
  try { return work(); }
  catch (error) { throw new Error(isAppError(error) ? serializeAutomationUpdateError(error, true) : errorText(error)); }
}

function parseTrustedProfile(value: unknown): TrustedAutomationProfile {
  try { return normalizeTrustedProfile(value); }
  catch (error) { throw new Error(`Invalid trusted_profile: ${errorText(error)}`); }
}

/** automation_executor.rs:121–148 (local time zone, Chinese phrasing for the model to relay). */
export function describeRelativeTime(targetMs: number, nowMs: number): string {
  const secs = Math.trunc((targetMs - nowMs) / 1000);
  if (secs <= 0) return '即将触发';
  const minutes = Math.trunc(secs / 60);
  if (minutes < 1) return '1 分钟内';
  if (minutes < 60) return `约 ${minutes} 分钟后`;
  const hours = Math.trunc(minutes / 60);
  if (hours < 24) {
    const rem = minutes % 60;
    return rem === 0 ? `约 ${hours} 小时后` : `约 ${hours} 小时 ${rem} 分钟后`;
  }
  const target = new Date(targetMs);
  const now = new Date(nowMs);
  const days = Math.round((Date.UTC(target.getFullYear(), target.getMonth(), target.getDate())
    - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86_400_000);
  const hhmm = `${pad(target.getHours())}:${pad(target.getMinutes())}`;
  if (days === 1) return `明天 ${hhmm}`;
  if (days === 2) return `后天 ${hhmm}`;
  return `${Math.max(days, 1)} 天后（${pad(target.getMonth() + 1)}-${pad(target.getDate())} ${hhmm}）`;
}

const sameSchedule = (left: AutomationSchedule, right: AutomationSchedule): boolean =>
  JSON.stringify(scheduleToListItem(left)) === JSON.stringify(scheduleToListItem(right));

function agentItem(automation: AutomationDefinition, nowMs: number): JsonObject {
  const item = automationToAgentListItem(automation, nowMs);
  annotateOnceCompleted(item);
  return item;
}

export class AutomationExecutor {
  private readonly deps: AutomationExecutorDeps;

  constructor(deps: AutomationExecutorDeps) { this.deps = deps; }

  canHandle(toolName: string): boolean { return canHandleAutomationTool(toolName); }

  private db(ctx: ChatExecutionContext): DatabaseHandle { return ctx.main_db ?? this.deps.database(); }

  private propose(args: unknown, ctx: ChatExecutionContext): JsonObject {
    rejectUnknownFields(args, PROPOSE_ALLOWED_KEYS);
    const name = parseRequiredString(args, 'name');
    const prompt = parseRequiredString(args, 'prompt');
    try { validateAutomationFields(name, prompt); } catch (error) { throw new Error(errorText(error)); }
    const scheduleValue = asObject(args)?.schedule;
    if (scheduleValue === undefined) throw new Error("'schedule' is required");
    const schedule = parseToolSchedule(scheduleValue);
    const enabledValue = provided(args, 'enabled');
    if (enabledValue !== undefined && typeof enabledValue !== 'boolean') throw new Error("'enabled' must be a boolean");
    const enabled = enabledValue ?? true;
    const actionType = parseActionType(args);
    const { agentPrompt, sessionMode, modelId } = parseAgentFields(args, actionType);
    const catchUpPolicy = parseCatchUpPolicy(args, true) ?? 'run_once';
    const maxRetries = parseOptionalU64(args, 'max_retries', 0, 10) ?? DEFAULT_MAX_RETRIES;
    const retryBackoffSeconds = parseOptionalU64(args, 'retry_backoff_seconds', 5, 86_400) ?? DEFAULT_RETRY_BACKOFF_SECS;
    const timeoutSeconds = parseOptionalU64(args, 'timeout_seconds', 30, 3_600) ?? DEFAULT_TIMEOUT_SECS;
    const trustedValue = provided(args, 'trusted_profile');
    const trustedProfile = trustedValue === undefined ? null : parseTrustedProfile(trustedValue);

    const db = this.db(ctx);
    let existing: AutomationDefinition[] | null = null;
    try { existing = loadAutomations(db); } catch { existing = null; }
    const duplicate = existing?.find(automation => rustTrim(automation.name) === name
      && rustTrim(automation.prompt) === prompt && automation.action_type === actionType
      && automation.agent_prompt === agentPrompt && sameSchedule(automation.schedule, schedule));
    if (duplicate !== undefined) {
      throw new Error(JSON.stringify({
        code: AUTOMATION_DUPLICATE_CODE, errorType: 'validation',
        message: `An identical automation already exists (id=${duplicate.id}, version=${duplicate.version}); not creating a duplicate.`,
        existing: agentItem(duplicate, Date.now()), retryable: false,
      }));
    }
    let definition: AutomationDefinition;
    try {
      definition = createAutomation(db, {
        name, schedule, prompt, enabled, action_type: actionType, heartbeat: false, agent_prompt: agentPrompt,
        session_mode: sessionMode, model_id: modelId, catch_up_policy: catchUpPolicy, max_retries: maxRetries,
        retry_backoff_seconds: retryBackoffSeconds, timeout_seconds: timeoutSeconds, trusted_profile: trustedProfile,
        source_session_id: ctx.session_id,
      });
    } catch (error) { throw new Error(errorText(error)); }
    const { id, version } = definition;
    this.deps.emitChanged('create', id);

    const nowMs = Date.now();
    let nextTriggerMs: number | null = null;
    if (enabled) {
      try { nextTriggerMs = computeNextTrigger(schedule, nowMs); } catch { nextTriggerMs = null; }
    }
    const nextTriggerRelative = nextTriggerMs === null ? null : describeRelativeTime(nextTriggerMs, nowMs);
    const scheduleDescription = describeSchedule(schedule);
    const behavior = actionType === 'notify'
      ? 'At the scheduled time the app will send a system notification and create a todo reminder; it will not run an agent task automatically.'
      : 'At the scheduled time the app will run a headless agent turn in an isolated session (frontend-bridge tools, ask_user and high-sensitivity tools are unavailable), then send a system notification with the result summary.';
    const firstRun = enabled ? `First run: ${nextTriggerRelative ?? 'unknown'}.`
      : 'It is currently disabled and will not run until enabled via automation_set_enabled.';
    return {
      status: 'created', id, version, name, enabled, action_type: actionType, session_mode: sessionMode ?? 'isolated',
      model_id: modelId, schedule: scheduleToListItem(schedule), schedule_description: scheduleDescription,
      next_trigger_at: nextTriggerMs === null ? 'unknown' : formatTimestampMillis(nextTriggerMs),
      next_trigger_relative: nextTriggerRelative,
      message: `Automation '${name}' created (${scheduleDescription}). ${firstRun} ${behavior} Use automation_list to review or automation_set_enabled to disable.`,
      storage: 'automation_definitions', previous: null, reversible: false, reversibleWithApproval: true,
      restoreWith: { tool: TOOLS.delete, arguments: { id, expected_version: version } },
      undoReason: 'Deleting a created automation is High risk and requires fresh user confirmation.',
    };
  }

  private list(ctx: ChatExecutionContext): JsonObject {
    const db = this.db(ctx);
    let automations: AutomationDefinition[];
    try { automations = loadAutomations(db); } catch (error) { throw new Error(errorText(error)); }
    const nowMs = Date.now();
    const items = automations.map((automation) => {
      const item = automationToAgentListItem(automation, nowMs);
      const next = typeof item.next_trigger_at === 'string' ? parseTimestampMillis(item.next_trigger_at) : null;
      item.next_trigger_relative = next === null ? null : describeRelativeTime(next, nowMs);
      item.schedule_description = describeSchedule(automation.schedule);
      annotateOnceCompleted(item);
      if (typeof item.last_run_at === 'string') {
        try {
          const run = listAutomationRunsPage(db, automation.id, 1, 0).runs[0];
          if (run !== undefined) {
            item.last_run_status = run.status;
            item.last_run_summary = run.summary;
            item.last_run_error = run.error;
          }
        } catch (error) {
          this.deps.warn(`[AutomationExecutor] last run lookup failed for '${automation.id}': ${errorText(error)}`);
        }
      }
      return item;
    });
    return { count: items.length, max: MAX_AUTOMATIONS, automations: items,
      capacity: `${items.length}/${MAX_AUTOMATIONS} 已使用，还可创建 ${Math.max(0, MAX_AUTOMATIONS - items.length)} 条` };
  }

  private setEnabled(args: unknown, ctx: ChatExecutionContext): JsonObject {
    rejectUnknownFields(args, SET_ENABLED_ALLOWED_KEYS);
    const id = parseRequiredString(args, 'id');
    const expectedVersion = parseRequiredVersion(args);
    const enabled = asObject(args)?.enabled;
    if (typeof enabled !== 'boolean') throw new Error("'enabled' is required and must be a boolean");
    const { previous, current } = occ(() => setAutomationEnabled(this.db(ctx), id, expectedVersion, enabled));
    this.deps.emitChanged('set_enabled', id);
    const nowMs = Date.now();
    const previousItem = agentItem(previous, nowMs);
    const currentItem = agentItem(current, nowMs);
    const state = enabled ? 'enabled' : 'disabled';
    return {
      success: true, status: state, id, name: current.name, enabled, version: current.version,
      next_trigger_at: typeof currentItem.next_trigger_at === 'string' ? currentItem.next_trigger_at : 'unknown',
      previous: previousItem, current: currentItem, reversible: true,
      restoreWith: { tool: TOOLS.setEnabled, arguments: { id, expected_version: current.version, enabled: previous.enabled } },
      message: `Automation '${current.name}' is now ${state}.${enabled ? '' : ' The scheduler will not trigger it until re-enabled.'}`,
    };
  }

  private update(args: unknown, ctx: ChatExecutionContext): JsonObject {
    rejectUnknownFields(args, UPDATE_ALLOWED_KEYS);
    const id = parseRequiredString(args, 'id');
    const expectedVersion = parseRequiredVersion(args);
    const fields: AutomationUpdateFields = {};
    if (provided(args, 'name') !== undefined) fields.name = parseRequiredString(args, 'name');
    const scheduleValue = provided(args, 'schedule');
    if (scheduleValue !== undefined) fields.schedule = parseToolSchedule(scheduleValue);
    if (provided(args, 'prompt') !== undefined) fields.prompt = parseRequiredString(args, 'prompt');
    const actionType = parseOptionalActionType(args);
    if (actionType !== null) fields.actionType = actionType;
    const agentPrompt = parseNullableString(args, 'agent_prompt', MAX_PROMPT_LEN);
    if (agentPrompt !== undefined) fields.agentPrompt = agentPrompt;
    const sessionMode = parseNullableSessionMode(args);
    if (sessionMode !== undefined) fields.sessionMode = sessionMode;
    const modelId = parseNullableString(args, 'model_id', null);
    if (modelId !== undefined) fields.modelId = modelId;
    const catchUpPolicy = parseCatchUpPolicy(args, false);
    if (catchUpPolicy !== null) fields.catchUpPolicy = catchUpPolicy;
    const maxRetries = parseOptionalU64(args, 'max_retries', 0, 10);
    if (maxRetries !== null) fields.maxRetries = maxRetries;
    const backoff = parseOptionalU64(args, 'retry_backoff_seconds', 5, 86_400);
    if (backoff !== null) fields.retryBackoffSeconds = backoff;
    const timeout = parseOptionalU64(args, 'timeout_seconds', 30, 3_600);
    if (timeout !== null) fields.timeoutSeconds = timeout;
    const object = asObject(args) ?? {};
    if (Object.hasOwn(object, 'trusted_profile')) {
      fields.trustedProfile = { value: object.trusted_profile === null ? null : parseTrustedProfile(object.trusted_profile) };
    }
    const { previous, current } = occ(() => updateAutomationFull(this.db(ctx), id, expectedVersion, fields));
    const nowMs = Date.now();
    const previousItem = agentItem(previous, nowMs);
    const currentItem = agentItem(current, nowMs);
    const nextTrigger = Object.hasOwn(currentItem, 'next_trigger_at') ? currentItem.next_trigger_at : null;
    this.deps.emitChanged('update', id);
    const directlyReversible = Array.from(previous.prompt).length <= 2_000
      && (previous.agent_prompt === null || Array.from(previous.agent_prompt).length <= 2_000);
    let restoreWith: JsonObject | null = null;
    if (directlyReversible) {
      const restoreArgs: JsonObject = {
        id, expected_version: current.version, name: previous.name, schedule: scheduleToListItem(previous.schedule),
        prompt: previous.prompt, action_type: previous.action_type, agent_prompt: previous.agent_prompt,
        session_mode: previous.session_mode, model_id: previous.model_id, catch_up_policy: previous.catch_up_policy,
        max_retries: previous.max_retries, retry_backoff_seconds: previous.retry_backoff_seconds,
        timeout_seconds: previous.timeout_seconds,
      };
      const exact = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
        typeof item === 'bigint' ? item.toString() : item);
      if (exact(previous.trusted_profile) !== exact(current.trusted_profile)) restoreArgs.trusted_profile = previous.trusted_profile;
      restoreWith = { tool: TOOLS.update, arguments: restoreArgs };
    }
    return {
      success: true, automation: structuredClone(currentItem), previous: previousItem, current: currentItem,
      nextTriggerAt: nextTrigger, reversible: directlyReversible, restoreWith,
      undoReason: directlyReversible ? null : '旧提示词超过 Agent 返回上限，无法在不泄漏/截断内容的情况下生成精确撤销参数',
    };
  }

  private delete(args: unknown, ctx: ChatExecutionContext): JsonObject {
    rejectUnknownFields(args, ID_VERSION_ALLOWED_KEYS);
    const id = parseRequiredString(args, 'id');
    const expectedVersion = parseRequiredVersion(args);
    const deleted = occ(() => deleteAutomation(this.db(ctx), id, expectedVersion));
    this.deps.emitChanged('delete', id);
    const item = agentItem(deleted, Date.now());
    return { success: true, automationId: id, deleted: structuredClone(item), previous: item, reversible: false, restoreWith: null };
  }

  private runNow(args: unknown): JsonObject {
    rejectUnknownFields(args, ID_VERSION_ALLOWED_KEYS);
    const id = parseRequiredString(args, 'id');
    const expectedVersion = parseRequiredVersion(args);
    const result = occ(() => runAutomationNow(this.deps.runtime(), id, expectedVersion));
    return { success: true, result, previous: null, reversible: false, restoreWith: null };
  }

  private runs(args: unknown, ctx: ChatExecutionContext): JsonObject {
    rejectUnknownFields(args, RUNS_ALLOWED_KEYS);
    const automationId = provided(args, 'automation_id') === undefined ? null : parseRequiredString(args, 'automation_id');
    let status: string | null = null;
    const statusValue = provided(args, 'status');
    if (statusValue !== undefined) {
      const trimmed = typeof statusValue === 'string' ? rustTrim(statusValue) : '';
      if (trimmed === '') throw new Error(`'status' must be one of: ${RUN_STATUS_VALUES.join(', ')}`);
      const raw = trimmed.replace(/[A-Z]/g, ch => ch.toLowerCase());
      if (!RUN_STATUS_VALUES.includes(raw)) throw new Error(`Invalid status '${raw}'. Allowed: ${RUN_STATUS_VALUES.join(', ')}`);
      status = raw;
    }
    const page = parseOptionalU64(args, 'page', 1, RUNS_MAX_PAGE) ?? 1;
    const pageSize = parseOptionalU64(args, 'page_size', 1, 20) ?? 20;
    const offset = (page - 1) * pageSize;
    let result: ReturnType<typeof listAutomationRunsPage>;
    try { result = listAutomationRunsPage(this.db(ctx), automationId, pageSize, offset); }
    catch (error) { throw new Error(errorText(error)); }
    const runs = status === null ? result.runs : result.runs.filter(run => run.status === status);
    return {
      runs, returned: runs.length, total: result.total, page, pageSize, hasMore: offset + pageSize < result.total,
      statusFilter: status,
      note: status === null ? null : 'status filter applied within this page; page through for more matches',
    };
  }

  private retryRun(args: unknown, ctx: ChatExecutionContext): JsonObject {
    rejectUnknownFields(args, ID_ONLY_ALLOWED_KEYS);
    const id = parseRequiredString(args, 'id');
    try { retryAutomationRunCore(this.db(ctx), id); } catch (error) { throw new Error(errorText(error)); }
    this.deps.emitChanged('retry', '');
    return { success: true, runId: id, reversible: false };
  }

  private cancelRun(args: unknown, ctx: ChatExecutionContext): JsonObject {
    rejectUnknownFields(args, ID_ONLY_ALLOWED_KEYS);
    const id = parseRequiredString(args, 'id');
    try { cancelAutomationRun(this.db(ctx), id); } catch (error) { throw new Error(errorText(error)); }
    this.deps.emitChanged('cancel_run', '');
    return { success: true, runId: id, reversible: false };
  }

  private dispatch(call: ToolCall, ctx: ChatExecutionContext): JsonObject {
    const args = call.arguments;
    switch (stripToolNamespace(call.name)) {
      case TOOLS.propose: return this.propose(args, ctx);
      case TOOLS.list: {
        const object = asObject(args);
        if (object !== null && Object.keys(object).length > 0) throw new Error('automation_list accepts no arguments');
        return this.list(ctx);
      }
      case TOOLS.setEnabled: return this.setEnabled(args, ctx);
      case TOOLS.update: return this.update(args, ctx);
      case TOOLS.delete: return this.delete(args, ctx);
      case TOOLS.runNow: return this.runNow(args);
      case TOOLS.runs: return this.runs(args, ctx);
      case TOOLS.retryRun: return this.retryRun(args, ctx);
      case TOOLS.cancelRun: return this.cancelRun(args, ctx);
      default: throw new Error(`Unknown automation tool: ${call.name}`);
    }
  }

  async execute(call: ToolCall, ctx: ChatExecutionContext): Promise<ToolResultInfo> {
    const started = performance.now();
    ctx.emitToolCallStart(call.name, call.arguments, call.id);
    let output: unknown;
    let error: string | null = null;
    try { output = this.dispatch(call, ctx); } catch (cause) { error = friendlyAutomationError(errorText(cause)); }
    const durationMs = Math.trunc(performance.now() - started);
    let result: ToolResultInfo;
    if (error === null) {
      ctx.emitToolCallEnd({ result: output, durationMs });
      result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, output,
        success: true, durationMs };
    } else {
      ctx.emitToolCallError(error);
      result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, output: null,
        success: false, error, durationMs };
    }
    try { ctx.saveToolBlock(result); }
    catch (cause) { this.deps.warn(`[AutomationExecutor] Failed to save tool block: ${errorText(cause)}`); }
    return result;
  }

  sensitivityLevel(toolName: string): 'high' | 'medium' | 'low' {
    return automationSensitivityLevel(toolName).toLowerCase() as 'high' | 'medium' | 'low';
  }
  sensitivityLevelForCall(toolName: string, args: unknown): 'high' | 'medium' | 'low' {
    return automationSensitivityLevelForCall(toolName, args).toLowerCase() as 'high' | 'medium' | 'low';
  }
  hasDynamicSensitivity(toolName: string): boolean { return hasDynamicAutomationSensitivity(toolName); }
  name(): string { return 'AutomationExecutor'; }
}
