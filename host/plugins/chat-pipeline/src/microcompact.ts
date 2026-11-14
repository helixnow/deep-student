/**
 * chat_v2/pipeline/helpers.rs — microcompact layer: replace old tool outputs
 * with deterministic placeholders without touching persisted messages.
 *
 * The history message shape mirrors `dstu-core/src/models.rs::ChatMessage`
 * (L02 owns its generated contract); only the fields this layer reads/writes
 * are declared.
 */
import { estimateTokens } from './token-budget.ts';
import type { Model2HistoryMessage } from '../../llm/api.ts';

export const MICROCOMPACT_KEEP_RECENT_USER_TURNS = 3;
/** Tool outputs below this token count are not worth a placeholder. */
const MICROCOMPACT_MIN_TOKENS = 256;

/** llm_manager/transient_messages.rs */
export const TRANSIENT_SKILL_METADATA_KIND = 'skill_instruction';
export const TRANSIENT_REQUEST_ANCHOR_METADATA_KIND = 'request_context_anchor';

export interface LegacyToolCall {
  id: string;
  tool_name: string;
  args_json: unknown;
}

export interface LegacyToolResult {
  call_id: string;
  ok: boolean;
  error?: string | null;
  error_details?: unknown;
  data_json?: unknown;
  usage?: unknown;
  citations?: unknown;
}

/**
 * models.rs:108: serde(tag = "type", rename_all = "lowercase").
 * Share L02's public request union; image_url is the tag value, not a nested key.
 */
export type MultimodalContentPart = NonNullable<Model2HistoryMessage['multimodal_content']>[number];

export function textPart(text: string): MultimodalContentPart {
  return { type: 'text', text };
}

export function imagePart(mediaType: string, base64: string): MultimodalContentPart {
  return { type: 'image_url', mediaType, base64 };
}

export interface LegacyChatMessage {
  role: string;
  content: string;
  timestamp?: string;
  rag_sources?: unknown;
  memory_sources?: unknown;
  graph_sources?: unknown;
  web_search_sources?: unknown;
  image_paths?: string[] | null;
  overrides?: unknown;
  relations?: unknown;
  thought_signature?: string | null;
  persistent_stable_id?: string | null;
  doc_attachments?: { name: string; mime_type: string; size_bytes: number;
    text_content: string | null; base64_content: string | null }[] | null;
  /** DeepSeek thinking-mode reasoning_content replayed with tool calls. */
  thinking_content?: string | null;
  metadata?: unknown;
  tool_call?: LegacyToolCall | null;
  tool_result?: LegacyToolResult | null;
  /** Legacy image list (jpeg assumed) used when multimodal_content is absent. */
  image_base64?: string[] | null;
  multimodal_content?: MultimodalContentPart[] | null;
}

/** helpers.rs::make_empty_message — role/content only. */
export function makeEmptyMessage(role: string, content: string): LegacyChatMessage {
  return { role, content };
}

function escapeXmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** helpers.rs::make_transient_skill_message — request-only, never persisted. */
export function makeTransientSkillMessage(skillId: string, content: string): LegacyChatMessage {
  return {
    role: 'user',
    content: `<skill_instructions id="${escapeXmlAttr(skillId)}">\n${content}\n</skill_instructions>`,
    metadata: { kind: TRANSIENT_SKILL_METADATA_KIND, hidden: true, skillId },
  };
}

function metadataKind(message: LegacyChatMessage): string | null {
  const metadata = message.metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const kind = (metadata as Record<string, unknown>).kind;
  return typeof kind === 'string' ? kind : null;
}

function metadataHidden(message: LegacyChatMessage): boolean {
  const metadata = message.metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  return (metadata as Record<string, unknown>).hidden === true;
}

export function isTransientSkillMessage(message: LegacyChatMessage): boolean {
  return metadataKind(message) === TRANSIENT_SKILL_METADATA_KIND && metadataHidden(message);
}

export function isTransientLlmOnlyMessage(message: LegacyChatMessage): boolean {
  if (isTransientSkillMessage(message)) return true;
  return metadataKind(message) === TRANSIENT_REQUEST_ANCHOR_METADATA_KIND && metadataHidden(message);
}

/** Pinned messages never enter the placeholder boundary. */
export function isPinnedHistoryMessage(message: LegacyChatMessage): boolean {
  return isTransientLlmOnlyMessage(message) || metadataKind(message) === 'compaction_summary';
}

export interface MicrocompactAnchor {
  /** Active compaction record id; a change means a compaction event. */
  lineage: string | null;
  /** Head user turns allowed to be placeholder-ized. */
  eligible_user_turns: number;
}

/** Batch value under the current history: `U - K`. */
export function microcompactBatchEligibleTurns(history: readonly LegacyChatMessage[]): number {
  const userTurns = history.filter(message =>
    message.role === 'user' && !isPinnedHistoryMessage(message)).length;
  return Math.max(0, userTurns - MICROCOMPACT_KEEP_RECENT_USER_TURNS);
}

/**
 * Anchor advance decision. Without a compaction event (lineage unchanged) the
 * anchor is frozen, only defensively clamped to the current batch value.
 */
export function advanceMicrocompactAnchor(previous: MicrocompactAnchor | null,
  activeCompactionId: string | null, batchEligibleUserTurns: number):
  [MicrocompactAnchor, number] {
  if (previous !== null && previous.lineage === activeCompactionId) {
    const effective = Math.min(previous.eligible_user_turns, batchEligibleUserTurns);
    return [{ ...previous }, effective];
  }
  const anchor: MicrocompactAnchor = {
    lineage: activeCompactionId,
    eligible_user_turns: batchEligibleUserTurns,
  };
  return [{ ...anchor }, batchEligibleUserTurns];
}

/**
 * Replaces tool outputs of the oldest `eligibleUserTurns` user turns with a
 * deterministic placeholder. The most recent K turns always keep their full
 * output; tool call/result pairs stay intact (only content/data_json change).
 * Returns the number of replaced outputs.
 */
export function microcompactOldToolOutputs(history: LegacyChatMessage[],
  eligibleUserTurns: number): number {
  if (eligibleUserTurns === 0) return 0;

  const userIndices: number[] = [];
  history.forEach((message, index) => {
    if (message.role === 'user' && !isPinnedHistoryMessage(message)) userIndices.push(index);
  });

  const maxEligible = Math.max(0, userIndices.length - MICROCOMPACT_KEEP_RECENT_USER_TURNS);
  const eligible = Math.min(eligibleUserTurns, maxEligible);
  if (eligible === 0) return 0;
  const protectFrom = userIndices[eligible]!;

  const toolNames = new Map<string, string>();
  for (const message of history) {
    const call = message.tool_call;
    if (call !== undefined && call !== null) toolNames.set(call.id, call.tool_name);
  }

  let replaced = 0;
  for (let index = 0; index < protectFrom; index++) {
    const message = history[index]!;
    if (isPinnedHistoryMessage(message)) continue;
    const result = message.tool_result;
    if (result === undefined || result === null) continue;
    const tokens = estimateTokens(message.content);
    if (tokens < MICROCOMPACT_MIN_TOKENS) continue;
    const toolName = toolNames.get(result.call_id) ?? 'unknown';
    const placeholder = `[旧工具输出已省略：${toolName}，原约 ${tokens} tokens；原文保留在会话记录中]`;
    message.content = placeholder;
    result.data_json = placeholder;
    replaced++;
  }
  return replaced;
}

/** Tool call/result pairing check (validate_tool_chain). */
export function validateToolChain(history: readonly LegacyChatMessage[]): boolean {
  const pending = new Set<string>();
  for (const message of history) {
    const call = message.tool_call;
    if (call !== undefined && call !== null) pending.add(call.id);
    const result = message.tool_result;
    if (result !== undefined && result !== null) pending.delete(result.call_id);
  }
  return pending.size === 0;
}
