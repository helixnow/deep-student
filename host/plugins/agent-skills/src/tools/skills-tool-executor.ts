/**
 * `SkillsExecutor::execute` (skills_executor.rs:321–729): `load_skills` validates against the trusted
 * runtime catalog carried by the execution context, records the loaded skills in the session skill
 * state (branch-local for parallel variants) and snapshots that change into the message metadata.
 */
import {
  getMessageWithConn, updateMessageWithConn, type ChatMessage, type ExecutionContext, type MessageMeta,
  type ReplaySkillPayloadSnapshot, type SessionSkillState, type SessionState, type SkillStateSnapshot,
  type ToolCall, type ToolResultInfo,
} from '../../../chat/api.ts';
import { compareUtf8 } from '../../../../platform/util/portable.ts';
import {
  SkillsExecutor, buildLoadSkillsOutput, classifyRequestedSkills, collectAvailableRuntimeSkillIds,
  formatAvailableSkillIdsHint, parseSkillsArgument, type LoadedToolOutput,
} from './skills-executor.ts';

interface SkillState {
  manualPinnedSkillIds: string[]; modeRequiredBundleIds: string[]; agenticSessionSkillIds: string[];
  branchLocalSkillIds: string[]; effectiveAllowedExternalServers: string[]; version: number; legacyMigrated: boolean | null;
}
interface SessionStateOwner {
  loadSessionState(sessionId: string): SessionState | null;
  updateSessionSkillStateV2(sessionId: string, state: SessionSkillState): void;
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string');
/** Rust `Vec<String>::sort` compares UTF-8 bytes. */
const byteOrder = (a: string, b: string): number => compareUtf8(a, b);
const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort(byteOrder);

function emptyState(legacyMigrated: boolean | null): SkillState {
  return { manualPinnedSkillIds: [], modeRequiredBundleIds: [], agenticSessionSkillIds: [], branchLocalSkillIds: [],
    effectiveAllowedExternalServers: [], version: 0, legacyMigrated };
}

/** types.rs:2610 `resolved_skill_state`: structured JSON when it deserializes, else `from_legacy`. */
export function resolvedSkillState(state: SessionState | null): SkillState {
  const parse = (raw: string | null | undefined): unknown => {
    if (raw == null) return undefined;
    try { return JSON.parse(raw) as unknown; } catch { return undefined; }
  };
  const structured = parse(state?.skillStateJson);
  if (structured !== null && typeof structured === 'object' && !Array.isArray(structured)) {
    const value = structured as Record<string, unknown>;
    const list = (key: string): string[] | null => value[key] === undefined || value[key] === null ? []
      : isStringArray(value[key]) ? [...value[key]] : null;
    const lists = ['manualPinnedSkillIds', 'modeRequiredBundleIds', 'agenticSessionSkillIds', 'branchLocalSkillIds',
      'effectiveAllowedExternalServers'].map(list);
    const version = value.version === undefined || value.version === null ? 0 : value.version;
    const legacy = value.legacyMigrated;
    if (lists.every(item => item !== null) && typeof version === 'number' && Number.isSafeInteger(version) && version >= 0
      && (legacy === undefined || legacy === null || typeof legacy === 'boolean')) {
      return { manualPinnedSkillIds: lists[0]!, modeRequiredBundleIds: lists[1]!, agenticSessionSkillIds: lists[2]!,
        branchLocalSkillIds: lists[3]!, effectiveAllowedExternalServers: lists[4]!, version,
        legacyMigrated: typeof legacy === 'boolean' ? legacy : null };
    }
  }
  const legacyList = (raw: string | null | undefined): string[] => {
    const parsed = parse(raw);
    return isStringArray(parsed) ? parsed : [];
  };
  return { ...emptyState(true), manualPinnedSkillIds: legacyList(state?.activeSkillIdsJson),
    agenticSessionSkillIds: legacyList(state?.loadedSkillIdsJson) };
}

const resolvedLoaded = (state: SkillState): string[] =>
  sortedUnique([...state.agenticSessionSkillIds, ...state.branchLocalSkillIds, ...state.modeRequiredBundleIds]);
const resolvedActive = (state: SkillState): string[] => sortedUnique(state.manualPinnedSkillIds);

/** `resolved_skill_state()` → `resolved_loaded_skill_ids()` / `resolved_active_skill_ids()`. */
export function resolvedSessionSkillIds(state: SessionState | null): { loaded: string[]; active: string[] } {
  const resolved = resolvedSkillState(state);
  return { loaded: resolvedLoaded(resolved), active: resolvedActive(resolved) };
}

/** `with_added_agentic_skills` / `with_added_branch_local_skills`. */
function withAdded(state: SkillState, key: 'agenticSessionSkillIds' | 'branchLocalSkillIds', ids: readonly string[]): SkillState {
  const merged = [...state[key]];
  for (const id of ids) if (!merged.includes(id)) merged.push(id);
  return { ...state, [key]: sortedUnique(merged), version: state.version + 1, legacyMigrated: false };
}

/** serde camelCase with `skip_serializing_if = "Vec::is_empty"`; version always present. */
function snapshot(state: SkillState): SkillStateSnapshot {
  const out: Record<string, unknown> = {};
  for (const key of ['manualPinnedSkillIds', 'modeRequiredBundleIds', 'agenticSessionSkillIds', 'branchLocalSkillIds',
    'effectiveAllowedExternalServers'] as const) if (state[key].length > 0) out[key] = [...state[key]];
  out.version = state.version;
  return out as SkillStateSnapshot;
}

function toSessionSkillState(state: SkillState): SessionSkillState {
  return { manualPinnedSkillIds: state.manualPinnedSkillIds, modeRequiredBundleIds: state.modeRequiredBundleIds,
    agenticSessionSkillIds: state.agenticSessionSkillIds, branchLocalSkillIds: state.branchLocalSkillIds,
    effectiveAllowedExternalServers: state.effectiveAllowedExternalServers, version: state.version,
    ...(state.legacyMigrated === null ? {} : { legacyMigrated: state.legacyMigrated }) };
}

const nonEmpty = (value: object | null | undefined): boolean => value != null && Object.keys(value).length > 0;

/** `ReplaySkillPayloadSnapshot::without_skill_contents` with serde's empty-collection skipping. */
function runtimeForMeta(previous: ReplaySkillPayloadSnapshot, activeSkillIds: string[],
  embedded: ExecutionContext['skill_embedded_tools']): ReplaySkillPayloadSnapshot {
  const out: Record<string, unknown> = {};
  if (activeSkillIds.length > 0) out.activeSkillIds = activeSkillIds;
  if (previous.executionAllowedTools != null) out.executionAllowedTools = previous.executionAllowedTools;
  if (nonEmpty(previous.skillDependencies)) out.skillDependencies = previous.skillDependencies;
  const tools = nonEmpty(previous.skillEmbeddedTools) ? previous.skillEmbeddedTools : embedded ?? {};
  if (nonEmpty(tools)) out.skillEmbeddedTools = tools;
  if ((previous.mcpToolSchemas?.length ?? 0) > 0) out.mcpToolSchemas = previous.mcpToolSchemas;
  if ((previous.selectedMcpServers?.length ?? 0) > 0) out.selectedMcpServers = previous.selectedMcpServers;
  return out as ReplaySkillPayloadSnapshot;
}

function previousRuntimeForMeta(previous: ReplaySkillPayloadSnapshot): ReplaySkillPayloadSnapshot {
  const { skillContents: _dropped, ...rest } = previous as ReplaySkillPayloadSnapshot & { skillContents?: unknown };
  return rest;
}

export class SkillsToolExecutor extends SkillsExecutor {
  async execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    const started = performance.now();
    const log = ctx.services.logger;
    const stripped = SkillsExecutor.stripPrefix(call.name);
    ctx.emitToolCallStart(call.name, call.arguments, call.id);
    log.info(`[SkillsExecutor] Executing ${stripped} with input: ${JSON.stringify(call.arguments)}`);
    const duration = () => Math.trunc(performance.now() - started);
    const fail = (error: string, output: unknown = null): ToolResultInfo => {
      ctx.emitToolCallError(error);
      return { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, output,
        success: false, error, durationMs: duration() };
    };
    if (stripped !== 'load_skills') return fail(`未知的 Skills 工具: ${call.name}`);

    const contents = ctx.skill_contents === null ? null : new Map(Object.entries(ctx.skill_contents));
    const admission = ctx.skill_admission_errors === null ? null : new Map(Object.entries(ctx.skill_admission_errors));
    const available = collectAvailableRuntimeSkillIds(contents, admission);
    let requested: string[];
    try { requested = parseLoadSkillsInput(call.arguments); }
    catch (cause) { return fail(`参数解析失败: ${errorText(cause)}. ${formatAvailableSkillIdsHint(available)}`); }
    const owner = ctx.services.chatSession as unknown as SessionStateOwner;
    if (requested.length === 0) {
      const output = buildLoadSkillsOutput({ requestedSkillIds: [], loadedSkillIds: [], alreadyLoadedSkillIds: [],
        missingSkillIds: [], rejectedSkills: new Map(), availableSkillIds: available,
        sessionLoadedSkillIds: this.currentLoaded(ctx, owner), loadedTools: [], skillStateVersion: 0,
        hasUntrustedRejection: false, includeAvailableHint: true });
      return fail(output.message, { result: output, durationMs: duration() });
    }

    const { loaded, notFound, rejected } = classifyRequestedSkills(requested, contents, admission);
    let sessionLoaded = [...loaded];
    let alreadyLoaded: string[] = [];
    let version = 0;
    const tools: LoadedToolOutput[] = [];
    for (const skillId of loaded) {
      for (const tool of ctx.skill_embedded_tools?.[skillId] ?? []) tools.push({ name: tool.name, skill_id: skillId });
    }
    tools.sort((a, b) => byteOrder(a.skill_id, b.skill_id) || byteOrder(a.name, b.name));
    const loadedTools = tools.filter((tool, index) => index === 0
      || tool.name !== tools[index - 1]!.name || tool.skill_id !== tools[index - 1]!.skill_id);

    if (ctx.chat_v2_db !== null) {
      let existing: SessionState | null | undefined;
      try { existing = owner.loadSessionState(ctx.session_id); }
      catch (cause) { log.warn(`[SkillsExecutor] Failed to load session skill state: session_id=${ctx.session_id}, error=${errorText(cause)}`); }
      if (existing !== undefined) {
        const previous = resolvedSkillState(existing);
        const previousLoaded = resolvedLoaded(previous);
        alreadyLoaded = loaded.filter(id => previousLoaded.includes(id));
        const next = withAdded(previous, ctx.variant_id !== null ? 'branchLocalSkillIds' : 'agenticSessionSkillIds', loaded);
        sessionLoaded = resolvedLoaded(next);
        version = next.version;
        try { owner.updateSessionSkillStateV2(ctx.session_id, toSessionSkillState(next)); }
        catch (cause) { log.warn(`[SkillsExecutor] Failed to persist session skill state: session_id=${ctx.session_id}, error=${errorText(cause)}`); }
        this.recordSnapshots(ctx, previous, next);
      }
    }

    const output = buildLoadSkillsOutput({ requestedSkillIds: requested, loadedSkillIds: loaded,
      alreadyLoadedSkillIds: alreadyLoaded, missingSkillIds: notFound, rejectedSkills: rejected, availableSkillIds: available,
      sessionLoadedSkillIds: sessionLoaded, loadedTools, skillStateVersion: version,
      hasUntrustedRejection: [...rejected.values()].some(reason => reason.toLowerCase().includes('untrusted')),
      includeAvailableHint: notFound.length > 0 || rejected.size > 0 });
    const durationMs = duration();
    const resultJson = { result: output, durationMs };
    const failed = output.status === 'error';
    if (failed) ctx.emitToolCallError(output.message);
    else ctx.emitter.emitEndWithMeta('tool_call', ctx.block_id, resultJson, ctx.variant_id, version, ctx.round_id);
    log.info(`[SkillsExecutor] load_skills persisted and synced: ${JSON.stringify(requested)}`);
    return failed
      ? { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, output: resultJson,
        success: false, error: output.message, durationMs }
      : { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, output: resultJson,
        success: true, durationMs };
  }

  private currentLoaded(ctx: ExecutionContext, owner: SessionStateOwner): string[] {
    if (ctx.chat_v2_db === null) return [];
    try { return resolvedLoaded(resolvedSkillState(owner.loadSessionState(ctx.session_id))); }
    catch { return []; }
  }

  /** skills_executor.rs:541–631: before/after snapshots on the message (and the active variant). */
  private recordSnapshots(ctx: ExecutionContext, previous: SkillState, next: SkillState): void {
    const log = ctx.services.logger;
    let conn;
    let message: ChatMessage | null;
    try { conn = ctx.chat_v2_db!.getConnSafe(); message = getMessageWithConn(conn, ctx.message_id); }
    catch (cause) {
      log.warn(`[SkillsExecutor] Failed to load message for skill snapshots: message_id=${ctx.message_id}, error=${errorText(cause)}`);
      return;
    }
    if (message === null) return;
    const meta: MessageMeta = { ...(message._meta ?? {}) };
    const previousRuntime: ReplaySkillPayloadSnapshot = meta.skillRuntimeAfter ?? meta.skillRuntimeBefore ?? {};
    const before = snapshot(previous), after = snapshot(next);
    const runtimeBefore = previousRuntimeForMeta(previousRuntime);
    const runtimeAfter = runtimeForMeta(previousRuntime, resolvedActive(next), ctx.skill_embedded_tools);
    if (ctx.variant_id !== null) {
      const variant = message.variants?.find(candidate => candidate.id === ctx.variant_id);
      if (variant !== undefined) {
        variant.meta = { ...(variant.meta ?? {}), skillSnapshotBefore: before, skillSnapshotAfter: after,
          skillRuntimeBefore: runtimeBefore, skillRuntimeAfter: runtimeAfter };
      }
    }
    message._meta = { ...meta, skillSnapshotBefore: before, skillSnapshotAfter: after, skillRuntimeBefore: runtimeBefore,
      skillRuntimeAfter: runtimeAfter, replaySource: 'current' };
    try { updateMessageWithConn(conn, message); }
    catch (cause) {
      log.warn(`[SkillsExecutor] Failed to update message skill snapshots: message_id=${ctx.message_id}, error=${errorText(cause)}`);
    }
  }
}

/** serde `LoadSkillsInput { skills }` with `deserialize_string_or_vec`. */
function parseLoadSkillsInput(args: unknown): string[] {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`invalid type: ${args === null ? 'null' : Array.isArray(args) ? 'sequence' : typeof args}, expected struct LoadSkillsInput`);
  }
  if (!Object.hasOwn(args, 'skills')) throw new Error('missing field `skills`');
  return parseSkillsArgument((args as Record<string, unknown>).skills);
}