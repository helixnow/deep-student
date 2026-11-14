/**
 * G09 skill usage ledger and candidate library, ported from
 * `src-tauri/crates/dstu-agent/src/chat_v2/skill_usage.rs`.
 *
 * The SQL schema is the V20260909 chat_v2 migration. The pipeline hooks stay
 * available to L06 through exported functions; this module owns the DB writes,
 * candidate state machine and the `chat_v2_record_skill_activation` command.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { rustTrim, utf8ByteLength } from '../../../platform/util/index.ts';
import {
  SkillCandidateRepo, SkillUsageRepo, correctionTraceHash, messageExists,
  outcomeFromFinalizationVerdict, trajectoryTraceHash,
} from '../repository/skill-usage.ts';
import type {
  SkillOutcome,
} from '../repository/skill-usage.ts';

export const TRAJECTORY_MIN_DISTINCT_TOOLS = 3;

export {
  CandidateSourceKind, CandidateStatus, correctionTraceHash, messageExists,
  outcomeFromFinalizationVerdict, parseCandidateSourceKind, parseCandidateStatus,
  parseSkillOutcome, parseSkillUsageKind, SkillCandidateRepo, SkillOutcome,
  SkillUsageKind, SkillUsageRepo, trajectoryTraceHash,
} from '../repository/skill-usage.ts';
export type {
  NewSkillCandidate, NewSkillUsage, SkillCandidateRow, SkillUsageRow,
} from '../repository/skill-usage.ts';

// ------------------------------------------------------------------ pipeline hooks

export interface SkillToolResultInfo {
  toolName: string;
  success: boolean;
  input: unknown;
  output: unknown;
}

export interface SkillSendOptions {
  skipUserMessageSave?: boolean;
  executionAllowedTools?: string[];
  schemaToolIds?: string[];
}

export interface SkillUsageLogger {
  warn?(message: string): void;
}

const defaultUsageLogger: SkillUsageLogger = {
  warn: message => (globalThis as { process?: { emitWarning?(message: string): void } }).process?.emitWarning?.(message),
};

export interface SkillPipelineContext {
  sessionId: string;
  assistantMessageId: string;
  userMessageId: string;
  /** Epoch milliseconds (Rust `Instant` start time). */
  startTime: number;
  tokenUsage: { totalTokens: number };
  options: SkillSendOptions;
  toolResults: SkillToolResultInfo[];
  logger?: SkillUsageLogger;
}

export interface ToolCallTrace {
  name: string;
  success: boolean;
  loadedSkillIds: string[];
}

export interface TurnUsageSummary {
  sessionId: string;
  runId: string;
  userMessageId: string;
  latencyMs: number;
  totalTokens: number;
  correctionHint: boolean;
  finalizationVerdict?: string;
  tools: ToolCallTrace[];
}

const TOOL_PREFIXES = ['builtin-', 'builtin:', 'mcp_'] as const;

export function stripToolNamespace(toolName: string): string {
  for (const prefix of TOOL_PREFIXES) {
    if (toolName.startsWith(prefix)) return toolName.slice(prefix.length);
  }
  return toolName;
}

export function isLoadSkillsTool(toolName: string): boolean {
  return stripToolNamespace(toolName) === 'load_skills';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Parse the skills actually loaded by a successful `load_skills` call. */
export function parseLoadSkillsLoaded(result: SkillToolResultInfo): string[] {
  const input = asRecord(result.input);
  const rawSkills = input?.skills;
  let requested: string[];
  if (Array.isArray(rawSkills)) {
    requested = rawSkills.filter((item): item is string => typeof item === 'string')
      .map(item => item.trim()).filter(Boolean);
  } else if (typeof rawSkills === 'string') {
    requested = rawSkills.split(',').map(item => item.trim()).filter(Boolean);
  } else {
    requested = [];
  }
  if (!requested.length) return [];
  const output = asRecord(result.output);
  const payload = asRecord(output?.result);
  const rejected = asRecord(payload?.rejected_skills) ?? {};
  const seen = new Set<string>();
  const loaded: string[] = [];
  for (const id of requested) {
    if (Object.hasOwn(rejected, id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    loaded.push(id);
  }
  return loaded;
}

export function toolTrace(result: SkillToolResultInfo): ToolCallTrace {
  return {
    name: result.toolName,
    success: result.success,
    loadedSkillIds: result.success && isLoadSkillsTool(result.toolName)
      ? parseLoadSkillsLoaded(result) : [],
  };
}

export function detectCorrectionHint(options: SkillSendOptions): boolean {
  if (options.skipUserMessageSave !== true) return false;
  if (options.executionAllowedTools !== undefined) return false;
  return !(options.schemaToolIds?.some(id => id.startsWith('goal_')) ?? false);
}

/** Last `task_completed` tool result's `finalization.verdict`. */
export function finalizationVerdictOf(toolResults: readonly SkillToolResultInfo[]): string | undefined {
  for (let index = toolResults.length - 1; index >= 0; index--) {
    const output = asRecord(toolResults[index]!.output);
    if (output?.task_completed !== true) continue;
    const finalization = asRecord(output.finalization);
    const verdict = finalization?.verdict;
    return typeof verdict === 'string' ? verdict : undefined;
  }
  return undefined;
}

export function turnUsageSummaryFromCtx(ctx: SkillPipelineContext): TurnUsageSummary {
  const latencyMs = Math.min(Math.max(0, Date.now() - ctx.startTime), Number.MAX_SAFE_INTEGER);
  const finalizationVerdict = finalizationVerdictOf(ctx.toolResults);
  return {
    sessionId: ctx.sessionId,
    runId: ctx.assistantMessageId,
    userMessageId: ctx.userMessageId,
    latencyMs,
    totalTokens: ctx.tokenUsage.totalTokens,
    correctionHint: detectCorrectionHint(ctx.options),
    ...(finalizationVerdict !== undefined ? { finalizationVerdict } : {}),
    tools: ctx.toolResults.map(toolTrace),
  };
}

function processCorrection(
  db: SqlExecutor,
  summary: TurnUsageSummary,
  usageRepo: SkillUsageRepo,
  candidateRepo: SkillCandidateRepo,
): boolean {
  if (messageExists(db, summary.userMessageId)) {
    candidateRepo.insertIfNew({
      sourceKind: 'user_correction',
      sessionId: summary.sessionId,
      traceHash: correctionTraceHash(summary.sessionId, 'edit_and_resend', summary.userMessageId),
      draftPayloadJson: JSON.stringify({
        kind: 'user_correction',
        trigger: 'edit_and_resend',
        corrected_user_message_id: summary.userMessageId,
      }),
      evidenceRefsJson: JSON.stringify({
        run_id: summary.runId,
        corrected_user_message_id: summary.userMessageId,
      }),
    });
    return true;
  }

  if (usageRepo.runHasUsage(summary.runId)) {
    const correctedSkillIds = usageRepo.skillIdsForRun(summary.runId);
    usageRepo.markRunOutcome(summary.runId, 'user_corrected');
    candidateRepo.insertIfNew({
      sourceKind: 'user_correction',
      sessionId: summary.sessionId,
      traceHash: correctionTraceHash(summary.sessionId, 'retry', summary.runId),
      draftPayloadJson: JSON.stringify({
        kind: 'user_correction',
        trigger: 'retry',
        corrected_run_id: summary.runId,
        corrected_skill_ids: correctedSkillIds,
      }),
      evidenceRefsJson: JSON.stringify({
        run_id: summary.runId,
        corrected_run_id: summary.runId,
      }),
    });
    return true;
  }
  return false;
}

function writeOutcomeFailedCandidate(
  summary: TurnUsageSummary,
  loadedSkillIds: readonly string[],
  candidateRepo: SkillCandidateRepo,
): void {
  candidateRepo.insertIfNew({
    sourceKind: 'user_correction',
    sessionId: summary.sessionId,
    traceHash: correctionTraceHash(summary.sessionId, 'outcome_failed', summary.runId),
    draftPayloadJson: JSON.stringify({
      kind: 'user_correction',
      trigger: 'outcome_failed',
      corrected_run_id: summary.runId,
      corrected_skill_ids: [...loadedSkillIds],
      verdict: summary.finalizationVerdict ?? '',
    }),
    evidenceRefsJson: JSON.stringify({
      run_id: summary.runId,
      corrected_run_id: summary.runId,
    }),
  });
}

/** Turn-end core. Correction handling must precede writing this turn's rows. */
export function processTurn(db: SqlExecutor, summary: TurnUsageSummary): void {
  const usageRepo = new SkillUsageRepo(db);
  const candidateRepo = new SkillCandidateRepo(db);

  const isCorrection = summary.correctionHint
    ? processCorrection(db, summary, usageRepo, candidateRepo)
    : false;

  const loadCounts = new Map<string, number>();
  for (const tool of summary.tools) {
    for (const skillId of tool.loadedSkillIds) {
      loadCounts.set(skillId, (loadCounts.get(skillId) ?? 0) + 1);
    }
  }
  const loadedSkillIds = [...loadCounts.keys()].sort();
  for (const skillId of loadedSkillIds) {
    usageRepo.insert({
      skillId,
      taskSessionId: summary.sessionId,
      runId: summary.runId,
      kind: 'tool_load',
      loads: loadCounts.get(skillId) ?? 0,
      latencyMs: summary.latencyMs,
      tokens: summary.totalTokens,
    });
  }

  const finalOutcome = summary.finalizationVerdict === undefined
    ? undefined : outcomeFromFinalizationVerdict(summary.finalizationVerdict);
  if (finalOutcome !== undefined) {
    usageRepo.markRunOutcome(summary.runId, finalOutcome);
    if (finalOutcome === 'failed' && loadedSkillIds.length > 0) {
      writeOutcomeFailedCandidate(summary, loadedSkillIds, candidateRepo);
    }
  }

  if (!isCorrection && finalOutcome !== 'failed') {
    const seen = new Set<string>();
    const toolSequence: string[] = [];
    for (const tool of summary.tools) {
      if (!tool.success) continue;
      if (isLoadSkillsTool(tool.name)) continue;
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      toolSequence.push(tool.name);
    }
    if (toolSequence.length >= TRAJECTORY_MIN_DISTINCT_TOOLS) {
      const succeeded = summary.tools.filter(tool => tool.success).length;
      const failed = summary.tools.length - succeeded;
      candidateRepo.insertIfNew({
        sourceKind: 'trajectory',
        sessionId: summary.sessionId,
        traceHash: trajectoryTraceHash(summary.sessionId, toolSequence),
        draftPayloadJson: JSON.stringify({
          kind: 'trajectory',
          tool_sequence: toolSequence,
          tool_call_count: succeeded,
          failed_tool_call_count: failed,
          skills_loaded: loadedSkillIds,
          duration_ms: summary.latencyMs,
          total_tokens: summary.totalTokens,
        }),
        evidenceRefsJson: JSON.stringify({
          run_id: summary.runId,
          user_message_id: summary.userMessageId,
        }),
      });
    }
  }
}

/** Fire-and-forget turn-end hook (failures only warn). */
export async function onTurnCommitted(
  db: SqlExecutor,
  ctx: SkillPipelineContext,
  logger: SkillUsageLogger = ctx.logger ?? defaultUsageLogger,
): Promise<void> {
  const summary = turnUsageSummaryFromCtx(ctx);
  if (!summary.tools.length && !summary.correctionHint) return;
  try { processTurn(db, summary); }
  catch (error) {
    logger.warn?.(
      `[agent-skills] skill usage post-commit failed (non-fatal): session=${summary.sessionId}, run=${summary.runId}, err=${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Tool-loop hook: the `tool_loop` calls this right after `finalize_task_completion`. */
export function onTaskFinalized(db: SqlExecutor, ctx: SkillPipelineContext): void {
  onTaskFinalizedInner(
    db, ctx.assistantMessageId, ctx.toolResults, detectCorrectionHint(ctx.options), ctx.logger,
  );
}

/** Tool-loop finalization hook: mark already-written rows when safe. */
export function onTaskFinalizedInner(
  db: SqlExecutor,
  runId: string,
  toolResults: readonly SkillToolResultInfo[],
  correctionHint: boolean,
  logger: SkillUsageLogger = defaultUsageLogger,
): void {
  const verdict = finalizationVerdictOf(toolResults);
  if (verdict === undefined) return;
  const outcome = outcomeFromFinalizationVerdict(verdict);
  if (outcome === undefined || correctionHint) return;
  try { new SkillUsageRepo(db).markRunOutcome(runId, outcome); }
  catch (error) {
    logger.warn?.(
      `[agent-skills] outcome reflux at finalize failed (non-fatal): run=${runId}, err=${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * `chat_v2_record_skill_activation`: trim, then reject an empty id or one whose
 * UTF-8 byte length exceeds 255 (same check and message as Rust `String::len`).
 */
export function recordSkillActivation(
  db: SqlExecutor,
  skillIdInput: string,
  sessionId?: string | null,
): void {
  const skillId = rustTrim(skillIdInput);
  const length = utf8ByteLength(skillId);
  if (length === 0 || length > 255) throw new Error(`invalid skill_id length: ${length}`);
  new SkillUsageRepo(db).recordActivation(skillId, sessionId ?? null);
}
