/**
 * Rust `agent_wiring/plugins.rs` `ResearchInsightHints::existence_hints`：chat-pipeline 每轮
 * 组装 system prompt 前的被动灵感提示（存在级只给标题）。
 *
 * - 披露策略：`load_policy` + 三本账校准；用户禁用时每轮一条 `silence_user_disabled`；
 * - 查询（trim 后）不足 4 个字符直接返回；
 * - 无候选记 `silence_no_match`，其余候选按 `decide_passive` 记披露或沉默事件；
 * - 事件 id 确定（重试/变体幂等），`shown_count` 只在事件真正插入时累加；
 * - 任何失败降级为 `null`，不阻塞主流程。
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import { bumpInsightStat, recallFts } from '../repository/insight-cards.ts';
import { recordInsightEventIdempotent } from '../repository/insight.ts';
import {
  calibratePolicyFromLedger, decidePassive, filterContent, loadPolicy, type SilenceReason,
} from './disclosure.ts';

/** Rust `InsightHintRequest`（vfs/main 连接由服务自身解析）。 */
export interface InsightHintRequest {
  sessionId: string;
  userMessageId: string;
  userContent: string;
}

export interface InsightHintsDeps {
  vfsDb(): SqlExecutor;
  mainDb(): SqlExecutor | null;
  warn(message: string): void;
}

const SILENCE_EVENTS: Record<SilenceReason, string> = {
  no_match: 'silence_no_match',
  low_confidence: 'silence_low_confidence',
  budget: 'silence_budget',
  user_disabled: 'silence_user_disabled',
};

function ignoreFailure(write: () => unknown): void {
  try { write(); } catch { /* boundary-allow empty-catch: Rust `let _ = ...` 显式忽略被动记账失败 */ }
}

export function existenceHints(deps: InsightHintsDeps, request: InsightHintRequest): string | null {
  const vfs = deps.vfsDb();
  const policy = calibratePolicyFromLedger(vfs, loadPolicy(deps.mainDb()));
  const record = (insightId: string | null, eventType: string, level: string): boolean =>
    recordInsightEventIdempotent(vfs, request.sessionId, request.userMessageId, insightId, eventType, level);

  if (!policy.enabled) {
    ignoreFailure(() => record(null, 'silence_user_disabled', 'hidden'));
    return null;
  }

  const query = rustTrim(request.userContent);
  if ([...query].length < 4) return null;

  let candidates;
  try {
    candidates = recallFts(vfs, query, policy.max_per_turn * 2);
  } catch (error) {
    deps.warn(`[ChatV2::pipeline] insight passive recall failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  if (candidates.length === 0) {
    ignoreFailure(() => record(null, 'silence_no_match', 'hidden'));
    return null;
  }

  const outcomes = decidePassive(policy, candidates.map(candidate => ({ confidence: candidate.confidence })));
  const lines: string[] = [];
  candidates.forEach((candidate, index) => {
    const outcome = outcomes[index]!;
    if (outcome.kind === 'disclose') {
      const [title] = filterContent(outcome.level, candidate.card.title, '', '');
      let inserted = false;
      try { inserted = record(candidate.card.id, 'shown_existence', outcome.level); } catch { inserted = false; }
      if (inserted) ignoreFailure(() => bumpInsightStat(vfs, candidate.card.id, 'shown_count'));
      lines.push(`- [灵感] ${title}`);
    } else {
      ignoreFailure(() => record(candidate.card.id, SILENCE_EVENTS[outcome.reason], 'hidden'));
    }
  });
  return lines.length === 0 ? null : lines.join('\n');
}
