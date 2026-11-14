/**
 * Portable half of `skill-replay.ts` (G09 experience pipeline): candidate payload parsing,
 * drift probes, replay state machine, learned-skill rendering, summaries and normalizers.
 *
 * Everything here is pure or SQL-repository work (`repository/skill-usage.ts`), so the mobile
 * host runs the same code without `node:fs` / `node:crypto`. `skill-replay.ts` keeps the
 * filesystem half (read/write/rename of `~/.deep-student/skills`) and re-exports this module.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { sha256HexSync } from '../../../platform/crypto/sync.ts';
import { compareUtf8, utf8ByteLength } from '../../../platform/util/portable.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import type {
  CandidateSignalCounts, ReplayReport, SkillCandidateSummary,
} from '../api.ts';
import {
  CandidateSourceKind, CandidateStatus, SkillCandidateRepo, SkillUsageRepo,
  correctionTraceHash, messageExists, trajectoryTraceHash,
} from '../repository/skill-usage.ts';
import type { SkillCandidateRow } from '../repository/skill-usage.ts';
import { extractFrontmatter } from './requires-core.ts';
import { isPortableSkillPathComponent } from './package-core.ts';
import { now } from '../../../platform/time/index.ts';

/** list 命令的默认条数与上限（防御前端误传超大 limit 拖垮 IPC）。 */
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

// ------------------------------------------------------------------ drift codes

/** draft_payload_json 不是合法 JSON / 缺关键字段 / kind 与 source_kind 不符。 */
export const DRIFT_PAYLOAD_UNPARSEABLE = 'payload_unparseable';
/** evidence_refs_json 不是合法 JSON / 缺锚点字段。 */
export const DRIFT_EVIDENCE_UNPARSEABLE = 'evidence_unparseable';
/** 从 payload 原始输入重算的 trace_hash 与库存值不一致（完整性失败）。 */
export const DRIFT_TRACE_HASH_MISMATCH = 'trace_hash_mismatch';
/** trajectory：证据锚定的助手消息（run）已不在库中。 */
export const DRIFT_ANCHOR_RUN_MISSING = 'anchor_run_missing';
/** trajectory / edit 纠错：锚定的用户消息已不在库中。 */
export const DRIFT_ANCHOR_USER_MESSAGE_MISSING = 'anchor_user_message_missing';
/** trajectory：payload 声称加载了技能，但该 run 已无任何 usage 账目行。 */
export const DRIFT_USAGE_ROWS_MISSING = 'usage_rows_missing';
/** trajectory：payload 的 skills_loaded 集合与该 run 实际账目技能集合不一致。 */
export const DRIFT_SKILLS_DIVERGED = 'skills_diverged';
/** trajectory：该 run 的账目行出现 user_corrected / failed 终态。 */
export const DRIFT_OUTCOME_INVALIDATED = 'outcome_invalidated';
/** retry 纠错：被推翻 run 已无任何 usage 账目行。 */
export const DRIFT_ANCHOR_USAGE_MISSING = 'anchor_usage_missing';
/** retry 纠错：usage 行仍在，但 P0 写入候选时的 user_corrected 标记已丢失。 */
export const DRIFT_CORRECTION_MARK_MISSING = 'correction_mark_missing';
/** outcome_failed 反例：失败 run 的 usage 行仍在，但 failed 终态标记已丢失。 */
export const DRIFT_FAILURE_MARK_MISSING = 'failure_mark_missing';

export const G09_FRONTMATTER_SOURCE = 'g09_candidate';
export const LEARNED_WORKFLOW_PREFIX = 'learned-workflow-';
export const LEARNED_CORRECTION_PREFIX = 'learned-correction-';
export const SKILL_FILE_NAME = 'SKILL.md';
/** 回滚退役的归档子目录（点号前缀 → 技能目录扫描天然跳过）。 */
export const SKILL_ARCHIVE_SUBDIR = '.archive';

// ------------------------------------------------------------------ payload parsing

type JsonObject = Record<string, unknown>;

function asRecord(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject : undefined;
}

function asI64(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/** `parse_string_array`: array of strings, else None. */
function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return undefined;
    out.push(item);
  }
  return out;
}

export interface TrajectoryReconcileInput {
  toolSequence: string[];
  skillsLoaded: string[];
}

export function parseTrajectoryInput(payloadJson: string): TrajectoryReconcileInput | undefined {
  let payload: unknown;
  try { payload = JSON.parse(payloadJson); }
  catch { return undefined; }
  const record = asRecord(payload);
  if (record === undefined || record.kind !== 'trajectory') return undefined;
  const toolSequence = parseStringArray(record.tool_sequence);
  const skillsLoaded = parseStringArray(record.skills_loaded);
  if (toolSequence === undefined || skillsLoaded === undefined) return undefined;
  return { toolSequence, skillsLoaded };
}

export interface CorrectionReconcileInput {
  trigger: string;
  correctedRef: string;
}

export function parseCorrectionInput(payloadJson: string): CorrectionReconcileInput | undefined {
  let payload: unknown;
  try { payload = JSON.parse(payloadJson); }
  catch { return undefined; }
  const record = asRecord(payload);
  if (record === undefined || record.kind !== 'user_correction') return undefined;
  const trigger = record.trigger;
  if (typeof trigger !== 'string') return undefined;
  let refKey: string;
  if (trigger === 'edit_and_resend') refKey = 'corrected_user_message_id';
  else if (trigger === 'retry' || trigger === 'outcome_failed') refKey = 'corrected_run_id';
  else return undefined;
  const correctedRef = record[refKey];
  if (typeof correctedRef !== 'string') return undefined;
  return { trigger, correctedRef };
}

/** From-row trace hash recheck (pure; undefined = corrupted payload). */
export function recomputeTraceHash(row: SkillCandidateRow): string | undefined {
  if (row.sourceKind === 'trajectory') {
    const input = parseTrajectoryInput(row.draftPayloadJson);
    if (input === undefined) return undefined;
    return trajectoryTraceHash(row.sessionId, input.toolSequence);
  }
  const input = parseCorrectionInput(row.draftPayloadJson);
  if (input === undefined) return undefined;
  return correctionTraceHash(row.sessionId, input.trigger, input.correctedRef);
}

interface ReconcileOutcome {
  driftReasons: string[];
  recomputedTraceHash?: string;
}

function unparseableOutcome(): ReconcileOutcome {
  return { driftReasons: [DRIFT_PAYLOAD_UNPARSEABLE] };
}

export function reconcileProbes(db: SqlExecutor, row: SkillCandidateRow): ReconcileOutcome {
  return row.sourceKind === 'trajectory'
    ? reconcileTrajectory(db, row)
    : reconcileCorrection(db, row);
}

function reconcileTrajectory(db: SqlExecutor, row: SkillCandidateRow): ReconcileOutcome {
  const recomputed = recomputeTraceHash(row);
  const input = parseTrajectoryInput(row.draftPayloadJson);
  if (input === undefined) return unparseableOutcome();
  const driftReasons: string[] = [];
  if (recomputed !== row.traceHash) driftReasons.push(DRIFT_TRACE_HASH_MISMATCH);

  let evidence: unknown;
  try { evidence = JSON.parse(row.evidenceRefsJson); }
  catch { evidence = undefined; }
  const evidenceRecord = asRecord(evidence);
  const runId = evidenceRecord?.run_id;
  const userMessageId = evidenceRecord?.user_message_id;
  if (typeof runId !== 'string' || typeof userMessageId !== 'string') {
    driftReasons.push(DRIFT_EVIDENCE_UNPARSEABLE);
    return { driftReasons, ...(recomputed !== undefined ? { recomputedTraceHash: recomputed } : {}) };
  }

  if (!messageExists(db, runId)) driftReasons.push(DRIFT_ANCHOR_RUN_MISSING);
  if (!messageExists(db, userMessageId)) driftReasons.push(DRIFT_ANCHOR_USER_MESSAGE_MISSING);

  const usageRows = new SkillUsageRepo(db).listByRun(runId);
  if (input.skillsLoaded.length > 0 && usageRows.length === 0) {
    driftReasons.push(DRIFT_USAGE_ROWS_MISSING);
  } else {
    const actual = new Set(usageRows.map(usage => usage.skillId));
    const expected = new Set(input.skillsLoaded);
    if (actual.size !== expected.size || [...actual].some(id => !expected.has(id))) {
      driftReasons.push(DRIFT_SKILLS_DIVERGED);
    }
  }
  if (usageRows.some(usage => usage.outcome === 'user_corrected' || usage.outcome === 'failed')) {
    driftReasons.push(DRIFT_OUTCOME_INVALIDATED);
  }

  return { driftReasons, ...(recomputed !== undefined ? { recomputedTraceHash: recomputed } : {}) };
}

function reconcileCorrection(db: SqlExecutor, row: SkillCandidateRow): ReconcileOutcome {
  const recomputed = recomputeTraceHash(row);
  const input = parseCorrectionInput(row.draftPayloadJson);
  if (input === undefined) return unparseableOutcome();
  const driftReasons: string[] = [];
  if (recomputed !== row.traceHash) driftReasons.push(DRIFT_TRACE_HASH_MISMATCH);

  if (input.trigger === 'edit_and_resend') {
    if (!messageExists(db, input.correctedRef)) driftReasons.push(DRIFT_ANCHOR_USER_MESSAGE_MISSING);
  } else if (input.trigger === 'retry' || input.trigger === 'outcome_failed') {
    const usageRows = new SkillUsageRepo(db).listByRun(input.correctedRef);
    if (usageRows.length === 0) {
      driftReasons.push(DRIFT_ANCHOR_USAGE_MISSING);
    } else if (input.trigger === 'retry') {
      if (!usageRows.some(usage => usage.outcome === 'user_corrected')) {
        driftReasons.push(DRIFT_CORRECTION_MARK_MISSING);
      }
    } else if (!usageRows.some(usage => usage.outcome === 'failed')) {
      driftReasons.push(DRIFT_FAILURE_MARK_MISSING);
    }
  } else {
    // parseCorrectionInput already restricts the trigger enum; defensive only.
    driftReasons.push(DRIFT_PAYLOAD_UNPARSEABLE);
  }

  return { driftReasons, ...(recomputed !== undefined ? { recomputedTraceHash: recomputed } : {}) };
}

// ------------------------------------------------------------------ replay

/** 从回放入口状态到目标状态的合法迁移路径。 */
export function replayTransitions(
  from: CandidateStatus,
  target: CandidateStatus,
): Array<[CandidateStatus, CandidateStatus]> {
  const path: Array<[CandidateStatus, CandidateStatus]> = [];
  if (from === 'new') path.push(['new', 'screened']);
  path.push(['screened', 'replaying']);
  path.push(['replaying', target]);
  return path;
}

/** Dry-run replay. Read-only probes run before any state transition. */
export function replayCandidate(db: SqlExecutor, candidateId: string): ReplayReport {
  const repo = new SkillCandidateRepo(db);
  const row = repo.get(candidateId);
  if (row === undefined) throw new Error(`skill candidate not found: ${candidateId}`);
  if (row.status !== 'new' && row.status !== 'screened') {
    throw new Error(
      `skill candidate ${candidateId} is not replayable in status '${row.status}'`,
    );
  }
  const previousStatus = row.status;
  const outcome = reconcileProbes(db, row);
  const stillValid = outcome.driftReasons.length === 0
    && outcome.recomputedTraceHash === row.traceHash;
  const resultingStatus: CandidateStatus = stillValid ? 'passed' : 'failed';

  for (const [expected, next] of replayTransitions(previousStatus, resultingStatus)) {
    if (!repo.updateStatus(candidateId, expected, next)) {
      throw new Error(`skill candidate ${candidateId} status changed concurrently during replay`);
    }
  }

  return {
    candidateId,
    sourceKind: row.sourceKind,
    sessionId: row.sessionId,
    stillValid,
    driftReasons: outcome.driftReasons,
    traceHashStored: row.traceHash,
    traceHashRecomputed: outcome.recomputedTraceHash ?? null,
    traceHashMatches: outcome.recomputedTraceHash === row.traceHash,
    previousStatus,
    resultingStatus,
    replayedAt: now().rfc3339,
  };
}

// ------------------------------------------------------------------ rendering

/** 技能身份签名（确定性；不含 session）。 */
export function learnedSkillSignature(kind: string, parts: readonly string[]): string {
  // Same byte stream as the desktop `createHash('sha256')` chain: prefix, kind and each part
  // preceded by a newline.
  return sha256HexSync(`g09-learned-skill\n${kind}${parts.map(part => `\n${part}`).join('')}`).slice(0, 12);
}

function sortUtf8(values: string[]): string[] {
  return values.sort(compareUtf8);
}

export function deriveLearnedSkillId(row: SkillCandidateRow): string {
  let id: string;
  if (row.sourceKind === 'trajectory') {
    const input = parseTrajectoryInput(row.draftPayloadJson);
    if (input === undefined) {
      throw new Error(`skill candidate ${row.candidateId} trajectory payload missing tool_sequence`);
    }
    id = `${LEARNED_WORKFLOW_PREFIX}${learnedSkillSignature('workflow', [input.toolSequence.join(',')])}`;
  } else {
    const input = parseCorrectionInput(row.draftPayloadJson);
    if (input === undefined) {
      throw new Error(`skill candidate ${row.candidateId} user_correction payload missing trigger/anchor`);
    }
    let payload: unknown;
    try { payload = JSON.parse(row.draftPayloadJson); }
    catch (error) {
      throw new Error(`skill candidate ${row.candidateId} payload: ${error instanceof Error ? error.message : String(error)}`);
    }
    const skills = sortUtf8(stringArrayField(payload, 'corrected_skill_ids'));
    id = `${LEARNED_CORRECTION_PREFIX}${learnedSkillSignature('correction', [input.trigger, skills.join(',')])}`;
  }
  if (!isPortableSkillPathComponent(id)) {
    throw new Error(`derived learned skill id is not portable: ${id}`);
  }
  return id;
}

/** 剥离双引号与换行（防 frontmatter 注入）并按字符截断。 */
export function sanitizeInline(raw: string, maxLen: number): string {
  return Array.from(raw, ch => (ch === '"' ? '\'' : ch === '\n' || ch === '\r' ? ' ' : ch))
    .slice(0, maxLen)
    .join('')
    .trim();
}

export interface LearnedSkillDraft {
  skillId: string;
  markdown: string;
}

export interface InstalledLineage {
  source?: string;
  traceHash?: string;
  version?: number;
}

export function buildLearnedSkillDraft(row: SkillCandidateRow, version: number): LearnedSkillDraft {
  let payload: unknown;
  try { payload = JSON.parse(row.draftPayloadJson); }
  catch (error) {
    throw new Error(
      `skill candidate ${row.candidateId} draft payload is unparseable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const skillId = deriveLearnedSkillId(row);
  const payloadRecord = asRecord(payload) ?? {};
  let markdown: string;
  if (row.sourceKind === 'trajectory') {
    const input = parseTrajectoryInput(row.draftPayloadJson);
    if (input === undefined) {
      throw new Error(`skill candidate ${row.candidateId} trajectory payload missing tool_sequence`);
    }
    markdown = renderTrajectorySkill(row, payloadRecord, skillId, version, input);
  } else {
    const input = parseCorrectionInput(row.draftPayloadJson);
    if (input === undefined) {
      throw new Error(`skill candidate ${row.candidateId} user_correction payload missing trigger/anchor`);
    }
    markdown = renderCorrectionSkill(row, payloadRecord, skillId, version, input);
  }
  return { skillId, markdown };
}

function renderTrajectorySkill(
  row: SkillCandidateRow,
  payload: JsonObject,
  skillId: string,
  version: number,
  input: TrajectoryReconcileInput,
): string {
  const flow = input.toolSequence.map(tool => sanitizeInline(tool, 40));
  const flowText = flow.join(' → ');
  const steps = flow.map((tool, index) => `${index + 1}. \`${tool}\``).join('\n');
  const skillsText = input.skillsLoaded.length === 0
    ? '无'
    : input.skillsLoaded.map(id => `\`${sanitizeInline(id, 64)}\``).join('、');
  const toolCalls = asI64(payload.tool_call_count) ?? 0;
  const failedCalls = asI64(payload.failed_tool_call_count) ?? 0;
  const durationMs = asI64(payload.duration_ms) ?? 0;
  const totalTokens = asI64(payload.total_tokens) ?? 0;
  const description = sanitizeInline(
    `G09 习得工作流：${flowText}（成功轨迹沉淀，回放验证通过）`, 200,
  );
  return `---
name: ${skillId}
description: "${description}"
version: ${version}
source: ${G09_FRONTMATTER_SOURCE}
source_kind: trajectory
source_candidate_id: ${row.candidateId}
trace_hash: ${row.traceHash}
created_at: ${now().rfc3339}
---

# 习得工作流：${flowText}

> 本技能由 G09 经验管线从一次成功完成且回放对账通过的运行轨迹自动沉淀
> （候选 \`${row.candidateId}\`）。默认不受信：技能正文注入或包内脚本执行前，
> 需经 \`skill_trust_request\` 审查并授权。

## 何时使用

当任务可以拆解为「${flowText}」式的工具序列时，按本流程执行，可减少
逐步试探的轮次。

## 工作流程

${steps}

## 观测记录

- 工具调用：成功 ${toolCalls} 次 / 失败 ${failedCalls} 次
- 观测耗时约 ${durationMs} ms，token 消耗约 ${totalTokens}
- 同轮加载技能：${skillsText}
`;
}

function renderCorrectionSkill(
  row: SkillCandidateRow,
  payload: JsonObject,
  skillId: string,
  version: number,
  input: CorrectionReconcileInput,
): string {
  let triggerLabel: string;
  if (input.trigger === 'edit_and_resend') triggerLabel = '用户编辑并重发了上一条消息（上一轮回答被推翻）';
  else if (input.trigger === 'retry') triggerLabel = '用户重试了上一轮（原回答被推翻）';
  else if (input.trigger === 'outcome_failed') triggerLabel = '任务验收终态判定失败（partial/blocked）';
  else triggerLabel = '运行被判定为反例';
  const skills = stringArrayField(payload, 'corrected_skill_ids');
  const skillsText = skills.length === 0
    ? '无'
    : skills.map(id => `\`${sanitizeInline(id, 64)}\``).join('、');
  const verdict = typeof payload.verdict === 'string' ? payload.verdict : '';
  const verdictLine = verdict === '' ? '' : `\n- 验收终态：\`${sanitizeInline(verdict, 32)}\``;
  const description = sanitizeInline(`G09 习得反例：${triggerLabel}——避免重蹈`, 200);
  return `---
name: ${skillId}
description: "${description}"
version: ${version}
source: ${G09_FRONTMATTER_SOURCE}
source_kind: user_correction
source_candidate_id: ${row.candidateId}
trace_hash: ${row.traceHash}
created_at: ${now().rfc3339}
---

# 习得反例（避免重蹈）

> 本技能由 G09 经验管线从一条被用户纠错或验收判定失败的运行自动沉淀
> （候选 \`${row.candidateId}\`，反例）。默认不受信：技能正文注入或包内脚本
> 执行前，需经 \`skill_trust_request\` 审查并授权。

## 避免事项

- 触发信号：${triggerLabel}（\`${sanitizeInline(input.trigger, 32)}\`）
- 涉及技能：${skillsText}${verdictLine}

再次处理同类任务并准备加载上述技能时，先回顾上次被推翻/失败的原因，
确认前置条件与产出验收标准，再决定是否沿用原路径。
`;
}

function frontmatterValue(frontmatter: string, key: string): string | undefined {
  for (const line of frontmatter.split('\n')) {
    if (!line.startsWith(key)) continue;
    const rest = line.slice(key.length);
    if (!rest.startsWith(':')) continue;
    const value = rest.slice(1).trim().replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');
    if (value.length > 0) return value;
  }
  return undefined;
}

function parseU64(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const value = BigInt(raw);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}

// ------------------------------------------------------------------ list

/** 状态过滤参数解析，含任务层别名。 */
export function parseStatusFilter(raw: string): CandidateStatus | undefined {
  if (raw === 'pending') return 'new';
  if (raw === 'validated') return 'passed';
  if (raw === 'drifted') return 'failed';
  if (raw === 'promoted') return 'published';
  return CandidateStatus.All.find(status => status === raw);
}

function countStringArray(payload: unknown, key: string): number {
  const record = asRecord(payload);
  const value = record?.[key];
  return Array.isArray(value) ? value.length : 0;
}

function stringArrayField(payload: unknown, key: string): string[] {
  const record = asRecord(payload);
  return parseStringArray(record?.[key]) ?? [];
}

export function summaryFromRow(row: SkillCandidateRow): SkillCandidateSummary {
  let payload: unknown;
  try { payload = JSON.parse(row.draftPayloadJson); }
  catch { payload = undefined; }
  const signals: CandidateSignalCounts = {
    distinctTools: 0,
    toolCalls: 0,
    failedToolCalls: 0,
    skillsLoaded: 0,
    correctedSkills: 0,
  };
  let skillIds: string[] = [];
  if (payload !== undefined) {
    const record = asRecord(payload) ?? {};
    signals.distinctTools = countStringArray(payload, 'tool_sequence');
    signals.toolCalls = asI64(record.tool_call_count) ?? 0;
    signals.failedToolCalls = asI64(record.failed_tool_call_count) ?? 0;
    signals.skillsLoaded = countStringArray(payload, 'skills_loaded');
    signals.correctedSkills = countStringArray(payload, 'corrected_skill_ids');
    skillIds = row.sourceKind === 'trajectory'
      ? stringArrayField(payload, 'skills_loaded')
      : stringArrayField(payload, 'corrected_skill_ids');
  }
  return {
    candidateId: row.candidateId,
    sourceKind: row.sourceKind,
    status: row.status,
    sessionId: row.sessionId,
    traceHash: row.traceHash,
    skillIds,
    signals,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listCandidateSummaries(
  db: SqlExecutor,
  status: CandidateStatus | undefined,
  limit: number,
): SkillCandidateSummary[] {
  return new SkillCandidateRepo(db).listFiltered(status ?? null, limit).map(summaryFromRow);
}

/** Rust `str::trim` + `String::len` byte check for replay/promote/rollback. */
export function normalizeCandidateId(raw: string): string {
  const candidateId = rustTrim(raw);
  const length = utf8ByteLength(candidateId);
  if (length === 0 || length > 255) throw new Error(`invalid candidate_id length: ${length}`);
  return candidateId;
}

export function normalizeListStatus(raw: string | null | undefined): CandidateStatus | undefined {
  const trimmed = raw == null ? undefined : rustTrim(raw);
  if (trimmed === undefined || trimmed === '') return undefined;
  const status = parseStatusFilter(trimmed);
  if (status === undefined) throw new Error(`unknown skill candidate status filter: ${trimmed}`);
  return status;
}

export function normalizeListLimit(raw: number | null | undefined): number {
  // The IPC contract rejects non-u32 inputs before this helper. For accepted
  // inputs this preserves Rust's default 50 and min(MAX_LIST_LIMIT), including 0.
  const value = Math.trunc(raw ?? DEFAULT_LIST_LIMIT);
  return Math.max(0, Math.min(value, MAX_LIST_LIMIT));
}

/** Parse lineage from an installed SKILL.md body (the filesystem read stays in `skill-replay.ts`). */
export function parseInstalledLineage(content: string): InstalledLineage {
  const frontmatter = extractFrontmatter(content);
  if (frontmatter === null) return {};
  return {
    source: frontmatterValue(frontmatter, 'source'),
    traceHash: frontmatterValue(frontmatter, 'trace_hash'),
    version: parseU64(frontmatterValue(frontmatter, 'version')),
  };
}

/** `AGENT_INSTALLED.json` body for a learned skill written by `installLearnedSkill` (both platforms). */
export function learnedSkillMarker(
  row: SkillCandidateRow, draft: LearnedSkillDraft, version: number,
): { marker: Record<string, unknown>; contentSha256: string } {
  const contentSha256 = sha256HexSync(draft.markdown);
  return {
    contentSha256,
    marker: {
      sourceKind: G09_FRONTMATTER_SOURCE,
      proposalId: row.candidateId,
      contentSha256,
      packageSha256: contentSha256,
      packageVersion: version,
      files: [{
        path: SKILL_FILE_NAME,
        sha256: contentSha256,
        size: utf8ByteLength(draft.markdown),
      }],
      installedAt: now().rfc3339,
      sessionId: row.sessionId,
    },
  };
}

export function archiveStamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '');
}
