/** R5-M1: Rust MemoryService::write_smart_with_source, service.rs:1968-2175. */
import type { MemoryDecisionCompletion, MemorySearchResult, SmartWriteOutput } from '../api.ts';
import { countActiveMemories, countIndexedMemoryUnits } from '../repository/dedup-readiness.ts';
import { buildDecisionPrompt, parseDecisionResponse, type MemoryDecisionResponse } from './llm-decision.ts';
import { errorText } from './memory-utils.ts';
import type { WriteStoreHost } from './write-store.ts';
import { f32 } from './f32.ts';

export type SmartWriteSource = 'handler' | 'tool_call' | 'auto_extract';
export interface FactDecisionHost extends WriteStoreHost {
  readonly decisionBreaker: FactDecisionBreaker;
  searchForDedup(content: string): Promise<MemorySearchResult[]>;
  memoryDecisionCompletion(): MemoryDecisionCompletion;
  debug(message: string): void;
}
export type FactPlan = { kind: 'skip'; output: SmartWriteOutput } | {
  kind: 'decision'; decision: MemoryDecisionResponse; similar: MemorySearchResult[];
  needsDedupReview: boolean;
};

/** Rust's process-wide breaker statics: one instance per memory plugin, shared by every write path. */
export class FactDecisionBreaker {
  consecutiveFailures = 0;
  openUntilMs = 0;
}
const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 10 * 60 * 1000;

function skipped(reason: string): FactPlan {
  return { kind: 'skip', output: { noteId: '', event: 'SKIPPED', isNew: false,
    confidence: 1, reason, resourceId: null, downgraded: false } };
}

function logBreaker(host: FactDecisionHost, opened: boolean, source: SmartWriteSource): void {
  const { consecutiveFailures } = host.decisionBreaker;
  host.audit({ source, operation: 'decision_breaker', success: true,
    event: opened ? 'OPEN' : 'CLOSE',
    reason: opened
      ? `LLM 决策连续失败 ${consecutiveFailures} 次（阈值 5），熔断开启，冷却 10 分钟`
      : 'LLM 决策恢复成功，熔断关闭',
    extraJson: JSON.stringify({ consecutiveFailures, cooldownMs: COOLDOWN_MS }) });
}

function detectNotReady(host: FactDecisionHost): number | null {
  let active: number;
  try { active = countActiveMemories(host.db, host.rootId()); }
  catch (error) {
    host.debug(`[Memory] 索引就绪性判定失败（统计活跃记忆）: ${errorText(error)}`);
    return null;
  }
  if (active < 3) return null;
  try { return countIndexedMemoryUnits(host.db, host.rootId()) === 0 ? active : null; }
  catch (error) {
    host.debug(`[Memory] 索引就绪性判定失败（统计索引单元）: ${errorText(error)}`);
    return null;
  }
}

/** No transaction is held while retrieval or the decision model is awaited. */
export async function planFactWrite(host: FactDecisionHost, title: string, content: string,
  folder: string | null | undefined, source: SmartWriteSource, sessionId: string | null): Promise<FactPlan> {
  let similar: MemorySearchResult[];
  let searchDegraded = false;
  try { similar = await host.searchForDedup(content); }
  catch (error) {
    host.warn(`[Memory] Similar search failed (embedding unavailable?), skipping dedup: ${errorText(error)}`);
    searchDegraded = true;
    similar = [];
  }
  let needsDedupReview = false;
  if (!searchDegraded && similar.length === 0) {
    const active = detectNotReady(host);
    if (active !== null) {
      host.warn(`[Memory] 去重索引未就绪（活跃记忆 ${active} 条、已索引单元 0），来源=${source}：相似检索空结果不可信`);
      if (source === 'auto_extract') {
        return skipped(`去重索引未就绪（活跃记忆 ${active} 条、已索引单元 0），自动提取写入已跳过以避免批量重复`);
      }
      needsDedupReview = true;
    }
  }

  let decision: MemoryDecisionResponse;
  const now = Date.now();
  const breaker = host.decisionBreaker;
  if (similar.length > 0 && breaker.openUntilMs > now) {
    if (source === 'auto_extract') {
      host.warn(`[Memory] LLM 决策熔断中（连续失败 ${breaker.consecutiveFailures} 次），来源=${source}：自动提取写入已跳过`);
      return skipped(`记忆决策服务不可用（连续失败 ${breaker.consecutiveFailures} 次，熔断冷却中），自动提取写入已跳过`);
    }
    host.warn(`[Memory] LLM 决策熔断中（连续失败 ${breaker.consecutiveFailures} 次），来源=${source}：跳过决策调用并降级为 ADD`);
    host.audit({ source, operation: 'write_smart', success: true, title, contentPreview: content,
      folder: folder ?? null, event: 'DECISION_UNAVAILABLE',
      reason: `决策服务熔断中（连续失败 ${breaker.consecutiveFailures} 次），显式写入降级为 ADD`,
      sessionId, extraJson: '{"decision_unavailable":true}' });
    decision = { event: 'ADD', target_note_id: null, confidence: f32(0.6),
      reason: '记忆决策服务不可用（熔断冷却中），降级为新增' };
  } else if (similar.length === 0) {
    // MemoryLLMDecision::decide does not call the model or affect the breaker for no hits.
    decision = { event: 'ADD', target_note_id: null, confidence: 1,
      reason: '没有相似的现有记忆，直接新增' };
  } else {
    // An unpublished owner API is an integration blocker, not a model-call failure. Resolve
    // it outside the Rust model-error fallback: do not fabricate a provider or silently ADD.
    const completion = host.memoryDecisionCompletion();
    try {
      let response: string;
      try {
        response = (await completion.callMemoryDecisionRawPrompt(buildDecisionPrompt(content, title,
          similar.map(hit => ({ note_id: hit.noteId, title: hit.noteTitle,
            content_preview: hit.chunkText }))))).assistant_message;
      } catch (error) { throw new Error(`LLM 调用失败: ${errorText(error)}`); }
      const parsed = parseDecisionResponse(response);
      if (parsed === null) {
        host.warn('[MemoryLLMDecision] 所有 JSON 解析策略失败, raw(前300): '
          + Array.from(response).slice(0, 300).join(''));
        throw new Error('LLM 决策响应 JSON 解析失败');
      }
      decision = parsed;
      host.info(`[MemoryLLMDecision] event=${decision.event}, target=${rustTarget(decision.target_note_id)}, `
        + `confidence=${decision.confidence.toFixed(2)}, reason=${decision.reason}`);
      breaker.consecutiveFailures = 0;
      if (breaker.openUntilMs !== 0) {
        breaker.openUntilMs = 0;
        host.info('[Memory] LLM 决策恢复成功，熔断关闭');
        logBreaker(host, false, source);
      }
    } catch (error) {
      breaker.consecutiveFailures += 1;
      const newlyOpened = breaker.consecutiveFailures >= FAILURE_THRESHOLD && breaker.openUntilMs <= now;
      if (breaker.consecutiveFailures >= FAILURE_THRESHOLD) breaker.openUntilMs = now + COOLDOWN_MS;
      host.warn(`[Memory] LLM 决策失败（连续第 ${breaker.consecutiveFailures} 次），来源=${source}，降级为 ADD: ${errorText(error)}`);
      if (newlyOpened) {
        host.warn(`[Memory] LLM 决策熔断开启：连续失败 ${breaker.consecutiveFailures} 次达到阈值 5，冷却 10 分钟内自动提取写入将被跳过`);
        logBreaker(host, true, source);
      }
      decision = { event: 'ADD', target_note_id: null, confidence: f32(0.6),
        reason: `LLM 决策失败（${errorText(error)}），降级为新增` };
    }
  }
  host.info(`[Memory] Smart write decision: ${decision.event}, target=${rustTarget(decision.target_note_id)}, `
    + `confidence=${decision.confidence.toFixed(2)}`);
  return { kind: 'decision', decision, similar, needsDedupReview };
}

function rustTarget(target: string | null): string {
  return target === null ? 'None' : `Some(${JSON.stringify(target)})`;
}
