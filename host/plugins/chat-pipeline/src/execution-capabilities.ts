/** pipeline.rs owner capabilities composed by execution-runtime.ts: prompt sources, turn effects, usage, metadata. */
import type { Context } from '@deepseek-ai/cordis';
import { buildGoalUpdatedPayload, getGroupWithConn, getSessionWithConn, goalAddUsageWithConn, goalGetWithConn,
  type ChatV2Emitter, type GoalRecord } from '../../chat/api.ts';
import type { DatabaseHandle, InjectionBudgetService, LlmUsageService } from '../../../platform/storage/api.ts';
import type { AutoExtractFrequency, LearnerProfile, MemoryService } from '../../memory/api.ts';
import type { StandardModel2Output } from '../../llm/api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';
import { persistSessionMetadata } from '../repository/session-metadata.ts';
import type { SessionMetadataRuntime } from './execute.ts';
import type { RoundUsageRecord } from './tool-loop.ts';
import { errorMessage } from './tool-loop.ts';
import { extractCitedMemoryNoteIds } from './persistence.ts';
import { buildSessionMetadataPrompt, computeContentHash, fallbackSessionMetadata, parseSessionMetadataResponse,
  shouldGenerateSessionMetadata } from './summary.ts';

type Log = Pick<Context['logger'], 'warn' | 'debug' | 'info'> & Partial<Pick<Context['logger'], 'error'>>;
type Connection = () => DatabaseHandle;
const chars = (text: string) => [...text].length;

/** goal/mod.rs:43 format_active_goal_summary. */
export function formatActiveGoalSummary(goal: Pick<GoalRecord, 'objective' | 'status' | 'tokensUsed' | 'tokenBudget'>): string {
  let text = `目标：${goal.objective}\n状态：${goal.status}；已用 tokens：${goal.tokensUsed}`;
  if (goal.tokenBudget !== null) text += `；预算：${goal.tokenBudget}，剩余：${Math.max(goal.tokenBudget - goal.tokensUsed, 0)}`;
  return text;
}

/** prompt.rs:114 load_active_goal_summary. */
export function loadActiveGoalSummary(connection: Connection, log: Log, sessionId: string): string | null {
  let conn: DatabaseHandle;
  try { conn = connection(); }
  catch (error) {
    log.warn(`[ChatV2::pipeline] load_active_goal_summary: failed to get conn (session=${sessionId}): ${errorMessage(error)}; skipping goal injection`);
    return null;
  }
  let goal: GoalRecord | null;
  try { goal = goalGetWithConn(conn, sessionId); }
  catch (error) {
    log.warn(`[ChatV2::pipeline] load_active_goal_summary: failed to load goal (session=${sessionId}): ${errorMessage(error)}; skipping goal injection`);
    return null;
  }
  return goal !== null && goal.status === 'active' ? formatActiveGoalSummary(goal) : null;
}

export interface GoalUsageEvents { emit(channel: string, payload: unknown): void }

/** pipeline.rs:414 accumulate_goal_usage; windowless emitters skip only the broadcast. */
export function accumulateGoalUsage(connection: Connection, events: GoalUsageEvents, log: Log, sessionId: string,
  emitter: Pick<ChatV2Emitter, 'tryWindow'>, totalTokens: number, elapsedMs: number): void {
  const timeDeltaSeconds = Math.floor(elapsedMs / 1000);
  if (totalTokens <= 0 && timeDeltaSeconds <= 0) return;
  let conn: DatabaseHandle;
  try { conn = connection(); }
  catch (error) {
    log.warn(`[ChatV2::pipeline] accumulate_goal_usage: get_conn failed (session=${sessionId}): ${errorMessage(error)}`);
    return;
  }
  let goal: GoalRecord | null;
  try { goal = goalGetWithConn(conn, sessionId); }
  catch (error) {
    log.warn(`[ChatV2::pipeline] accumulate_goal_usage: load goal failed (session=${sessionId}): ${errorMessage(error)}`);
    return;
  }
  if (goal === null || (goal.status !== 'active' && goal.status !== 'waiting_user')) return;
  try { goalAddUsageWithConn(conn, sessionId, goal.goalId, totalTokens, timeDeltaSeconds); }
  catch (error) {
    log.warn(`[ChatV2::pipeline] accumulate_goal_usage: add usage failed (session=${sessionId}, goal=${goal.goalId}): ${errorMessage(error)}`);
    return;
  }
  let updated: GoalRecord | null;
  try { updated = goalGetWithConn(conn, sessionId); }
  catch (error) {
    log.warn(`[ChatV2::pipeline] accumulate_goal_usage: reload goal failed (session=${sessionId}): ${errorMessage(error)}`);
    return;
  }
  if (emitter.tryWindow() === null) return;
  try { events.emit(`chat_v2_session_${sessionId}`, buildGoalUpdatedPayload(sessionId, updated)); }
  catch (error) { log.warn(`[ChatV2::goal] Failed to emit goal_updated event: session=${sessionId}, error=${errorMessage(error)}`); }
}

export interface AgentsInstructionsPorts {
  connection: Connection;
  /** runtime_roots::workspace_root; throws when the owner cannot resolve it. */
  workspaceRoot(): string;
  loadAgentsInstructions(workspaceRoot: string | null): string | null;
  /** `Path::is_dir`: false on any metadata error. */
  isDirectory(path: string): boolean;
  cwd(): string | null;
  log: Log;
}

/** prompt.rs:200 resolve_session_workspace_root: group project root → workspace root → cwd. */
export function resolveSessionWorkspaceRoot(ports: AgentsInstructionsPorts, sessionId: string): string | null {
  const preferred = groupPreferredProjectRoot(ports, sessionId);
  if (preferred !== null && ports.isDirectory(preferred)) return preferred;
  try {
    const root = ports.workspaceRoot();
    if (ports.isDirectory(root)) return root;
  } catch (error) {
    ports.log.debug(`[ChatV2::pipeline] workspace runtime root unavailable for AGENTS.md (session=${sessionId}): ${errorMessage(error)}`);
  }
  return ports.cwd();
}

/** runtime_roots.rs:1429 resolve_group_preferred_runtime_root → project_root_path only. */
function groupPreferredProjectRoot(ports: AgentsInstructionsPorts, sessionId: string): string | null {
  let conn: DatabaseHandle;
  try { conn = ports.connection(); }
  catch (error) {
    ports.log.warn(`[runtime_roots] failed to open chat_v2 db while resolving preferred root for session '${sessionId}': ${errorMessage(error)}`);
    return null;
  }
  try {
    const session = getSessionWithConn(conn, sessionId);
    const groupId = session?.groupId == null ? '' : rustTrim(session.groupId);
    if (groupId === '') return null;
    const path = getGroupWithConn(conn, groupId)?.preferredProjectRootPath;
    return path == null || rustTrim(path) === '' ? null : rustTrim(path);
  } catch (error) {
    ports.log.warn(`[runtime_roots] failed to load session/group for preferred root (session '${sessionId}'): ${errorMessage(error)}`);
    return null;
  }
}

/** prompt.rs:194 load_project_agents_instructions. */
export function loadProjectAgentsInstructions(ports: AgentsInstructionsPorts, sessionId: string): string | null {
  return ports.loadAgentsInstructions(resolveSessionWorkspaceRoot(ports, sessionId));
}

/** tool_loop.rs:1618/1680 record_llm_usage_cache_ext(CallerType::ChatV2, …, duration None). */
export function recordRoundUsage(usage: Pick<LlmUsageService, 'recordLlmUsageCacheExt'>, record: RoundUsageRecord): void {
  usage.recordLlmUsageCacheExt({
    callerType: 'chat_v2', model: record.model, promptTokens: record.promptTokens,
    completionTokens: record.completionTokens, reasoningTokens: record.reasoningTokens,
    cachedTokens: record.cachedTokens, cacheWriteTokens: record.cacheWriteTokens, sessionId: record.sessionId,
    durationMs: null, success: record.success, errorMessage: record.errorMessage,
    adapter: record.protocol, tokenSource: record.tokenSource,
  });
}

export const LLM_NON_STREAM_TIMEOUT_MS = 120_000;

export interface SessionMetadataPorts {
  connection: Connection;
  callTitle(prompt: string, sessionId: string): Promise<Pick<StandardModel2Output, 'assistant_message'>>;
  log: Log;
  timeoutMs?: number;
}

/** summary.rs:51 generate_session_metadata + :293 should_generate_session_metadata. */
export function createSessionMetadataRuntime(ports: SessionMetadataPorts): SessionMetadataRuntime {
  const { log } = ports;
  const callForSummary = async (sessionId: string, prompt: string): Promise<string> => {
    const timeoutMs = ports.timeoutMs ?? LLM_NON_STREAM_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        log.error?.(`[ChatV2::pipeline] LLM summary call timeout after ${timeoutMs / 1000}s`);
        reject(new Error(`LLM summary call timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
    });
    try {
      const response = await Promise.race([ports.callTitle(prompt, sessionId).catch((error: unknown) => {
        throw new Error(`LLM call failed: ${errorMessage(error)}`);
      }), timeout]);
      return response.assistant_message.trim();
    } finally { clearTimeout(timer); }
  };
  return {
    async shouldGenerate(sessionId, userContent, assistantContent) {
      if (chars(userContent) < 10 && chars(assistantContent) < 20) {
        return shouldGenerateSessionMetadata(userContent, assistantContent, null, sessionId);
      }
      let session: { titleLocked: boolean; summaryHash: string | null } | null;
      try {
        const loaded = getSessionWithConn(ports.connection(), sessionId);
        session = loaded == null ? null : { titleLocked: loaded.titleLocked, summaryHash: loaded.summaryHash ?? null };
      } catch { return false; }
      return shouldGenerateSessionMetadata(userContent, assistantContent, session, sessionId);
    },
    async generate(sessionId, userContent, assistantContent, emitter) {
      log.info(`[ChatV2::pipeline] Generating session metadata for session=${sessionId}`);
      const assistantSummary = [...assistantContent].slice(0, 500).join('');
      const prompt = buildSessionMetadataPrompt(userContent, assistantContent);
      let metadata;
      try {
        metadata = parseSessionMetadataResponse(await callForSummary(sessionId, prompt));
        if (metadata === null) {
          log.warn('[ChatV2::pipeline] Failed to parse session metadata JSON; using local fallback');
          metadata = fallbackSessionMetadata(userContent);
        }
      } catch (error) {
        log.warn(`[ChatV2::pipeline] Failed to generate session metadata; using local fallback: ${errorMessage(error)}`);
        metadata = fallbackSessionMetadata(userContent);
      }
      if (metadata.title === '') {
        log.warn('[ChatV2::pipeline] Generated title is empty, skipping persist');
        return;
      }
      log.info(`[ChatV2::pipeline] Generated metadata for session=${sessionId}: title=${metadata.title}, tags=${JSON.stringify(metadata.tags)}`);
      const contentHash = computeContentHash(userContent, assistantSummary);
      let persisted: boolean;
      try { persisted = await persistSessionMetadata(ports.connection(), sessionId, metadata, contentHash); }
      catch (error) {
        (log.error ?? log.warn)(`[ChatV2::pipeline] Failed to persist session metadata: ${errorMessage(error)}`);
        return;
      }
      if (!persisted) {
        log.debug(`[ChatV2::pipeline] Skip persist metadata: session=${sessionId} not found or just locked`);
        return;
      }
      log.debug(`[ChatV2::pipeline] Session metadata persisted: session=${sessionId}, title=${metadata.title}, tags=${metadata.tags.length}`);
      emitter.emitSummaryUpdated(metadata.title, '');
    },
  };
}

/** Memory owner reads/writes used by profile injection (prompt.rs:236 load_user_profile). */
export type ProfileMemoryPort = Pick<MemoryService, 'isPrivacyMode' | 'getRootFolderId'
  | 'listCategorySummariesWithMembers' | 'getProfileSummary' | 'recordInjectionPresence'>;

export const PROFILE_MAX_CHARS = 2000;

const PRESENCE_THROTTLE_MS = 60 * 60 * 1000;
const PRESENCE_PRUNE_MS = 24 * 60 * 60 * 1000;
const lastPresenceMarkBySession = new Map<string, number>();

/** prompt.rs:383 should_mark_injection_presence: process-wide, at most once per session per hour. */
function shouldMarkInjectionPresence(sessionId: string): boolean {
  const now = Date.now();
  const last = lastPresenceMarkBySession.get(sessionId);
  if (last !== undefined && now - last < PRESENCE_THROTTLE_MS) return false;
  for (const [id, at] of lastPresenceMarkBySession) if (now - at >= PRESENCE_PRUNE_MS) lastPresenceMarkBySession.delete(id);
  lastPresenceMarkBySession.set(sessionId, now);
  return true;
}

/** prompt.rs:236 load_user_profile (category sections, whole-section 2000-char cap, legacy summary fallback). */
export function loadUserProfile(memory: ProfileMemoryPort, log: Log, sessionId: string,
  memoryEnabled: boolean | null | undefined): string | null {
  if (memoryEnabled === false) return null;
  try { if (memory.isPrivacyMode()) return null; }
  catch (error) {
    log.warn(`[ChatV2::pipeline] load_user_profile: failed to read privacy mode (session=${sessionId}): ${errorMessage(error)}; skipping profile injection`);
    return null;
  }
  let rootId: string | null;
  try { rootId = memory.getRootFolderId(); }
  catch (error) {
    log.warn(`[ChatV2::pipeline] load_user_profile: failed to resolve memory root folder (session=${sessionId}): ${errorMessage(error)}; skipping profile injection`);
    return null;
  }
  if (rootId === null) return null;
  const sections: string[] = [];
  const members: (readonly string[])[] = [];
  try {
    for (const { category, content, memberIds } of memory.listCategorySummariesWithMembers()) {
      sections.push(`### ${category}\n${content}`);
      members.push(memberIds);
    }
  } catch (error) {
    log.warn(`[ChatV2::pipeline] Failed to load category summaries (session=${sessionId}): ${errorMessage(error)}`);
  }
  if (sections.length === 0) {
    try { return memory.getProfileSummary(); }
    catch (error) {
      log.warn(`[ChatV2::pipeline] Failed to load user profile summary (session=${sessionId}): ${errorMessage(error)}`);
      return null;
    }
  }
  let total = 0;
  const kept: string[] = [];
  const injectedMemberIds: string[] = [];
  for (const [index, section] of sections.entries()) {
    const sectionChars = chars(section);
    if (total + sectionChars > PROFILE_MAX_CHARS && kept.length > 0) break;
    total += sectionChars + 2;
    kept.push(section);
    injectedMemberIds.push(...members[index]!);
  }
  if (injectedMemberIds.length > 0 && shouldMarkInjectionPresence(sessionId)) {
    const ids = [...new Set(injectedMemberIds)].sort(compareUtf8);
    setTimeout(() => {
      try { memory.recordInjectionPresence(ids); }
      catch (error) { log.warn(`[ChatV2::pipeline] record_injection_presence failed (session=${sessionId}): ${errorMessage(error)}`); }
    }, 0);
  }
  const combined = kept.join('\n\n');
  return kept.length < sections.length
    ? `${combined}\n\n（用户画像已截断 ${kept.length}/${sections.length} 个分类，完整信息请使用 builtin-memory_search 工具检索）`
    : combined;
}

export type LearnerProfileMemoryPort = Pick<MemoryService, 'isPrivacyMode' | 'loadProfile'
  | 'renderLearnerProfile' | 'isProfileContentEmpty'>;

/** prompt_builder.rs:1037 load_learner_profile_block: High-priority LearnerProfile budget allocation. */
export function loadLearnerProfileBlock(memory: LearnerProfileMemoryPort,
  budget: Pick<InjectionBudgetService, 'defaultConfig' | 'createManager' | 'newItem'>, log: Log,
  memoryEnabled: boolean | null | undefined): string | null {
  if (memoryEnabled === false) return null;
  try { if (memory.isPrivacyMode()) return null; }
  catch (error) {
    log.warn(`[PromptBuilder] Failed to read privacy mode: ${errorMessage(error)}; proceeding as non-privacy (unchanged behavior)`);
  }
  let profile: LearnerProfile | null;
  try { profile = memory.loadProfile(); }
  catch (error) {
    log.warn(`[PromptBuilder] Failed to load learner profile: ${errorMessage(error)}; skipping learner profile injection`);
    return null;
  }
  if (profile === null || memory.isProfileContentEmpty(profile)) return null;
  const manager = budget.createManager(budget.defaultConfig());
  manager.addItem(budget.newItem('LearnerProfile', memory.renderLearnerProfile(profile),
    2 as Parameters<InjectionBudgetService['newItem']>[2], 'learner_profile'));
  return manager.allocate().selected_items[0]?.content ?? null;
}

export type AutoExtractMemoryPort = Pick<MemoryService, 'getAutoExtractFrequency' | 'isPrivacyMode'
  | 'extractAndStoreMemory' | 'spawnPostWriteMaintenance' | 'recordUsed'>;
export interface AutoExtractToolResult { toolName: string; input: unknown; success?: boolean; output?: unknown }

/** memory/config.rs:100 content_min_chars. */
function contentMinChars(frequency: AutoExtractFrequency): number {
  return frequency === 'aggressive' ? 4 : frequency === 'balanced' ? 10 : Number.POSITIVE_INFINITY;
}

const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
const stringOr = (value: unknown, fallback: string) => typeof value === 'string' ? value : fallback;

/** persistence.rs:1664 race guard: the model already wrote fact memories this turn. */
export function llmWroteFactMemory(results: readonly AutoExtractToolResult[]): boolean {
  return results.some(result => {
    const name = result.toolName.startsWith('builtin-') ? result.toolName.slice('builtin-'.length) : result.toolName;
    if (name === 'memory_write' || name === 'memory_write_smart' || name === 'memory_update_by_id') {
      return stringOr(field(result.input, 'memory_type'), 'fact') === 'fact';
    }
    if (name === 'memory_write_batch') {
      const defaultType = stringOr(field(result.input, 'default_memory_type'), 'fact');
      const items = field(result.input, 'items');
      return Array.isArray(items)
        ? items.some(item => stringOr(field(item, 'memory_type'), defaultType) === 'fact')
        : defaultType === 'fact';
    }
    return false;
  });
}

/**
 * persistence.rs:1584 trigger_auto_memory_extraction_for_turn (gates run before the spawn).
 * Category refresh / evolution run through memory's post-write maintenance.
 */
export function triggerAutoMemoryExtractionForTurn(memory: AutoExtractMemoryPort, log: Log,
  memoryEnabled: boolean | null | undefined, userContent: string, assistantContent: string,
  toolResults: readonly AutoExtractToolResult[], logTag: string): Promise<void> | null {
  if (memoryEnabled === false) {
    log.debug(`[${logTag}] Session memory disabled, skipping auto-extraction`);
    return null;
  }
  // Citation usage is a local tag write and runs even when auto-extraction is gated off.
  const citedNoteIds = extractCitedMemoryNoteIds(assistantContent, toolResults);
  if (citedNoteIds.length > 0) {
    setTimeout(() => {
      log.debug(`[${logTag}] Recording citation usage for ${citedNoteIds.length} memories`);
      try { memory.recordUsed(citedNoteIds); }
      catch (error) { log.warn(`[${logTag}] record_used failed: ${errorMessage(error)}`); }
    }, 0);
  }
  let frequency: AutoExtractFrequency;
  try { frequency = memory.getAutoExtractFrequency(); } catch { frequency = 'balanced'; }
  if (frequency === 'off') {
    log.debug(`[${logTag}] Frequency=off, skipping auto-extraction`);
    return null;
  }
  let privacy = false;
  try { privacy = memory.isPrivacyMode(); } catch { privacy = false; }
  if (privacy) {
    log.debug(`[${logTag}] Privacy mode enabled, skipping auto-extraction`);
    return null;
  }
  const minChars = contentMinChars(frequency);
  if (chars(userContent) < minChars && chars(assistantContent) < minChars) return null;
  if (llmWroteFactMemory(toolResults)) {
    log.debug(`[${logTag}] Skipping auto-extraction: LLM already wrote fact memories this turn`);
    return null;
  }
  return (async () => {
    try {
      const count = await memory.extractAndStoreMemory(userContent, assistantContent);
      if (count > 0) log.info(`[${logTag}] Auto-extracted ${count} memories (frequency=${frequency})`);
      await memory.spawnPostWriteMaintenance();
    } catch (error) {
      log.warn(`[${logTag}] Auto-extraction failed (non-fatal): ${errorMessage(error)}`);
    }
  })();
}
