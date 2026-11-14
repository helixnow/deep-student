/**
 * chat_v2/pipeline/compaction/budget.rs — token budget and compaction triggers.
 *
 * All values mirror the Rust `u32`/`usize` arithmetic, including saturating
 * adds and float-to-int truncation for thresholds.
 */
import type { ChatMessage, MessageBlock, TokenUsage } from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import { estimateTokensWithModel } from './token-budget.ts';

/** Log surface matching compaction/budget.rs trigger logs. */
export interface CompactionBudgetLog { info(message: string): void }
let compactionBudgetLogger: CompactionBudgetLog = { info() {} };
export function configureCompactionBudgetLogger(logger: CompactionBudgetLog): void {
  compactionBudgetLogger = logger;
}

/** llm_manager/compaction_budget.rs */
export const TRIGGER_RATIO = 0.85;
export const DEFAULT_CONTEXT_WINDOW = 32_768;
export const DEFAULT_MAX_OUTPUT = 8_192;
export const TAIL_PRESERVE_RATIO = 0.25;
export const MIN_TAIL_TOKENS = 2_000;
export const MAX_TAIL_TOKENS = 64_000;
export const HEAD_USER_TURNS = 2;
export const SUMMARY_INPUT_RATIO = 0.7;
export const MIN_SUMMARY_INPUT_TOKENS = 2_000;
export const MAX_SUMMARY_INPUT_TOKENS = 120_000;

/** Minimal view of llm_manager::ApiConfig consumed by the budget helpers. */
export interface CompactionModelConfig {
  model?: string | null;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  maxTokensLimit?: number | null;
}

/** Minimal view of PipelineContext.token_usage / options. */
export interface CompactionTriggerState {
  tokenUsage: Pick<TokenUsage, 'promptTokens' | 'completionTokens' | 'totalTokens'> & {
    lastRoundPromptTokens?: number | null;
  };
  options: { contextLimit?: number | null };
}

const U32_MAX = 0xffff_ffff;
const saturatingAdd = (a: number, b: number): number => Math.min(a + b, U32_MAX);
const saturatingSub = (a: number, b: number): number => (a > b ? a - b : 0);

/** budget.rs::usable_tokens */
export function usableTokens(config: CompactionModelConfig | null | undefined): number {
  const configured = config?.contextWindow;
  const context = configured === undefined || configured === null ? DEFAULT_CONTEXT_WINDOW : configured;
  if (context === 0) return 0;
  const maxOutput = config
    ? (() => {
        const requested = (config.maxOutputTokens ?? 0) > 0 ? config.maxOutputTokens! : DEFAULT_MAX_OUTPUT;
        const limit = config.maxTokensLimit;
        return limit !== undefined && limit !== null && limit > 0 ? Math.min(requested, limit) : requested;
      })()
    : DEFAULT_MAX_OUTPUT;
  return saturatingSub(context, Math.min(maxOutput, Math.floor(context / 2)));
}

/** budget.rs::effective_usable_tokens */
export function effectiveUsableTokens(config: CompactionModelConfig | null | undefined,
  contextLimit: number | null | undefined): number {
  const providerBudget = usableTokens(config);
  return contextLimit === undefined || contextLimit === null
    ? providerBudget
    : Math.min(providerBudget, contextLimit);
}

/** Rust `(x as f64 * ratio) as u32`: truncation toward zero, saturating at u32. */
const thresholdOf = (usable: number): number => Math.min(Math.trunc(usable * TRIGGER_RATIO), U32_MAX);

function usedBase(state: CompactionTriggerState): number {
  const lastRound = state.tokenUsage.lastRoundPromptTokens;
  if (lastRound !== undefined && lastRound !== null && lastRound > 0) return lastRound;
  return Math.max(state.tokenUsage.totalTokens,
    saturatingAdd(state.tokenUsage.promptTokens, state.tokenUsage.completionTokens));
}

/** budget.rs::should_compact (checkpoint A) */
export function shouldCompact(state: CompactionTriggerState,
  config: CompactionModelConfig | null | undefined): boolean {
  const usable = effectiveUsableTokens(config, state.options.contextLimit);
  if (usable === 0) return false;
  const used = usedBase(state);
  const threshold = thresholdOf(usable);
  const trigger = used >= threshold;
  if (trigger) {
    compactionBudgetLogger.info(`[compaction] trigger@A: used=${used}`
      + ` threshold=${threshold} usable=${usable}`);
  }
  return trigger;
}

/** budget.rs::should_compact_after_tool (checkpoint B) */
export function shouldCompactAfterTool(state: CompactionTriggerState,
  config: CompactionModelConfig | null | undefined, predictedToolOutputTokens: number): boolean {
  const usable = effectiveUsableTokens(config, state.options.contextLimit);
  if (usable === 0) return false;
  const base = usedBase(state);
  const predictedNextPrompt = saturatingAdd(base, predictedToolOutputTokens);
  const threshold = thresholdOf(usable);
  const trigger = predictedNextPrompt >= threshold;
  if (trigger) {
    compactionBudgetLogger.info(`[compaction] trigger@B: predicted_next=${predictedNextPrompt}`
      + ` threshold=${threshold} usable=${usable} (base=${base},`
      + ` tool_delta=${predictedToolOutputTokens})`);
  }
  return trigger;
}

function serialize(value: unknown): string {
  return JSON.stringify(value) ?? '';
}

/** budget.rs::estimate_json_tokens — `usize as u32` wraps modulo 2^32. */
export function estimateJsonTokens(value: unknown, modelId?: string | null): number {
  return estimateTokensWithModel(serialize(value), modelId) >>> 0;
}

/**
 * budget.rs::estimate_message_tokens — includes content/thinking/tool payloads
 * and charges a fixed 8192 tokens per image.
 */
export function estimateMessageTokens(msg: ChatMessage,
  blocksByMsg: ReadonlyMap<string, readonly MessageBlock[]>, modelId?: string | null): number {
  let text = '';
  for (const block of blocksByMsg.get(msg.id) ?? []) {
    if (block.content !== undefined && block.content !== null) text += `${block.content}\n`;
    if (block.toolInput !== undefined && block.toolInput !== null) text += `${serialize(block.toolInput)}\n`;
    if (block.toolOutput !== undefined && block.toolOutput !== null) text += `${serialize(block.toolOutput)}\n`;
    if (block.error !== undefined && block.error !== null) text += `${block.error}\n`;
  }
  const canonical = msg._meta?.canonicalContent;
  const images = canonical !== undefined && canonical !== null
    ? canonical.filter(part => part.type === 'image_ref').length
    : (msg.attachments ?? []).filter(item => item.mimeType.startsWith('image/')).length;
  return estimateTokensWithModel(text, modelId) + images * 8_192;
}
