/** history.rs:828–1119 and context.rs:638–752 — shared live/replay data shaping. */
import type { CanonicalContentPart, ChatMessage, MessageBlock, MessageMeta, ToolResultInfo } from '../../chat/api.ts';
import type { BlockReplayData, JsonValue } from '../api.ts';
import { sanitizeRetrievalOutputForLlm } from './citations.ts';
import type { LegacyChatMessage } from './microcompact.ts';
import { nowEpochNanos, toRfc3339Opts } from '../../../platform/time/index.ts';
import { cloneAgentJson } from '../../../kernel/agent-api.ts';

export function historyMessage(role: string, content: string): LegacyChatMessage {
  return { role, content, timestamp: toRfc3339Opts(nowEpochNanos(), 'AutoSi', true),
    thinking_content: null, thought_signature: null, image_base64: null, doc_attachments: null,
    multimodal_content: null, tool_call: null, tool_result: null, persistent_stable_id: null, metadata: null,
    rag_sources: null, memory_sources: null, graph_sources: null, web_search_sources: null,
    image_paths: null, overrides: null, relations: null };
}

export function filterBlocksForActiveVariant(message: ChatMessage, blocks: MessageBlock[]): MessageBlock[] {
  if (!message.variants?.length) return blocks;
  const owned = new Set(message.variants.flatMap(variant => variant.blockIds));
  const active = new Set(message.variants.find(variant => variant.id === message.activeVariantId)?.blockIds ?? message.blockIds);
  return blocks.filter(block => !owned.has(block.id) || active.has(block.id));
}

export function restoreWorkspaceInjections(blocks: readonly MessageBlock[], messages: LegacyChatMessage[],
  lastUser: number | null): number | null {
  for (const block of blocks) {
    if (block.type !== 'workspace_injection' || block.content == null || block.content === '') continue;
    const message = historyMessage('user', block.content);
    const meta = block.toolOutput as Record<string, unknown> | null | undefined;
    message.metadata = { workspace_injection: true, workspace_id: meta?.workspace_id ?? null };
    messages.splice(Math.min(lastUser ?? messages.length, messages.length), 0, message);
    if (lastUser !== null) lastUser++;
  }
  return lastUser;
}

export function isToolCallBlock(block: MessageBlock): boolean {
  return block.toolName != null && ['mcp_tool', 'ask_user', 'memory', 'web_search', 'graph', 'rag',
    'insight_recall', 'academic_search', 'sleep', 'subagent_embed', 'workbench_ops'].includes(block.type);
}

function toolPair(id: string, name: string, input: unknown, output: unknown, success: boolean,
  error: string | null, roundText: string, reasoning: string | null, signature: string | null,
  reasoningItem: unknown): [LegacyChatMessage, LegacyChatMessage] {
  const assistant = historyMessage('assistant', roundText);
  assistant.thinking_content = reasoning;
  assistant.thought_signature = signature;
  assistant.tool_call = { id, tool_name: name, args_json: cloneAgentJson(input) };
  assistant.metadata = reasoningItem === undefined ? null : { openai_responses_reasoning_item: structuredClone(reasoningItem) };
  const sanitized = success ? sanitizeRetrievalOutputForLlm(name, output as JsonValue) : null;
  const content = !success && error != null && error !== '' ? `Error: ${error}` : JSON.stringify(sanitized ?? output) ?? '';
  const tool = historyMessage('tool', content);
  tool.tool_result = { call_id: id, ok: success, error, error_details: null,
    data_json: cloneAgentJson(output), usage: null, citations: null };
  return [assistant, tool];
}

export function buildToolRoundMessages(meta: MessageMeta | null | undefined, replay: BlockReplayData | undefined,
  block: MessageBlock, entryThinking: string | null): [LegacyChatMessage, LegacyChatMessage] {
  const id = replay?.toolCallId == null || replay.toolCallId === '' ? `tc_${block.id.replaceAll('blk_', '')}` : replay.toolCallId;
  const result = meta?.toolResults?.find(value => value.blockId === block.id || value.toolCallId === id);
  return toolPair(id, block.toolName ?? '', block.toolInput ?? null, block.toolOutput ?? null,
    block.status === 'success', block.error ?? null, replay?.roundText ?? '',
    result?.reasoningContent ?? entryThinking, result?.thoughtSignature ?? null, meta?.responseReasoningItems?.[id]);
}

export function allToolResultsToMessages(results: readonly ToolResultInfo[], roundTexts: ReadonlyMap<string, string>,
  reasoningItems: ReadonlyMap<string, unknown>): LegacyChatMessage[] {
  return results.flatMap(result => toolPair(result.toolCallId ?? '', result.toolName, result.input, result.output,
    result.success, result.error ?? null, result.toolCallId == null ? '' : roundTexts.get(result.toolCallId) ?? '',
    result.reasoningContent ?? null, result.thoughtSignature ?? null,
    result.toolCallId == null ? undefined : reasoningItems.get(result.toolCallId)));
}

export function activeVariantArtifactsByUser(messages: readonly ChatMessage[]): Map<string, CanonicalContentPart[]> {
  const result = new Map<string, CanonicalContentPart[]>();
  for (let i = 0; i + 1 < messages.length; i++) {
    const user = messages[i]!, assistant = messages[i + 1]!;
    if (user.role !== 'user' || assistant.role !== 'assistant') continue;
    const artifacts = assistant.variants?.find(v => v.id === assistant.activeVariantId)?.meta?.canonicalArtifacts;
    if (artifacts?.length) result.set(user.id, structuredClone(artifacts));
  }
  return result;
}

export function canonicalContentForHistory(message: ChatMessage, artifacts?: CanonicalContentPart[]): CanonicalContentPart[] | null {
  let canonical = structuredClone(message._meta?.canonicalContent ?? []);
  if (artifacts !== undefined) canonical = [...canonical.filter(part => part.type !== 'derived_artifact_ref'), ...structuredClone(artifacts)];
  return canonical.length ? canonical : null;
}

type Log = { warn(message: string): void };
export function validateToolChain(messages: readonly LegacyChatMessage[], logger: Log): boolean {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.tool_call != null) pending.add(message.tool_call.id);
    if (message.tool_result != null) pending.delete(message.tool_result.call_id);
  }
  if (pending.size) logger.warn(`[ChatV2::pipeline] Incomplete tool chain detected: ${pending.size} pending call(s): ${JSON.stringify([...pending])}`);
  return pending.size === 0;
}

export function repairToolChain(messages: LegacyChatMessage[], logger: Log): void {
  const calls = new Set(messages.flatMap(m => m.tool_call == null ? [] : [m.tool_call.id]));
  const results = new Set(messages.flatMap(m => m.tool_result == null ? [] : [m.tool_result.call_id]));
  const kept = messages.filter(m => m.tool_result == null || calls.has(m.tool_result.call_id));
  const dropped = messages.length - kept.length;
  messages.splice(0, messages.length, ...kept);
  const dangling = [...calls].filter(id => !results.has(id));
  let synthesized = 0;
  for (const id of dangling) {
    const index = messages.findIndex(m => m.tool_call?.id === id);
    if (index < 0) continue;
    let at = index + 1;
    while (at < messages.length && messages[at]!.tool_result != null) at++;
    const placeholder = 'Error: tool result unavailable (execution was interrupted before a result was recorded)';
    const message = historyMessage('tool', placeholder);
    message.tool_result = { call_id: id, ok: false, error: placeholder, error_details: null, data_json: null, usage: null, citations: null };
    messages.splice(at, 0, message); synthesized++;
  }
  if (dropped || synthesized) logger.warn(`[ChatV2::pipeline] Repaired broken tool chain: dropped ${dropped} orphan tool result(s), synthesized ${synthesized} placeholder result(s) for dangling call(s): ${JSON.stringify(dangling)}`);
}
