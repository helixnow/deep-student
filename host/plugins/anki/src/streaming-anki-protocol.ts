/**
 * `streaming_anki_service.rs` 的协议常量、模型包装 token 清理与流式事件载荷。
 *
 * 从 `streaming-anki.ts` 拆出（quality.md §2.4）；导出面由该模块重新聚合。
 */
import type { CriticSummary } from './anki-critic-prompt.ts';
import { criticSummaryWire } from './anki-critic-prompt.ts';
import type { AnkiLogger } from './logger.ts';
import { MODEL_SPECIAL_TOKENS } from '../../../platform/util/api.ts';
import { rustTrim, rustTrimStart } from '../../../platform/util/index.ts';

/** 模型包装 token 单源来自 F4 `host/platform/util`。 */
export { MODEL_SPECIAL_TOKENS };

// ============================================================================
// 常量（`streaming_anki_service.rs:24-60`）
// ============================================================================

export const RETRY_ASSIGNMENT_MARK = '[RETRY_ASSIGNED]';
export const CANCELLED_BY_USER_MSG = 'CANCELLED_BY_USER';
export const ERR_KEYWORD_TIMEOUT = '超时';
export const ERR_KEYWORD_TRUNCATED = '截断';
export const UNREADABLE_FRAGMENT_MSG = 'UNREADABLE_CARD_FRAGMENT';
export const QA_FLAGS_FIELD = '_qa_flags';
export const CARD_BUFFER_HARD_LIMIT = 1_000_000;
export const ERROR_CARD_RAW_PREVIEW_CHARS = 2000;

/**
 * `MODEL_SPECIAL_TOKENS` 单源来自 F4 `host/platform/util`。
 *
 * L16 的 `stripModelSpecialTokens` 是 Rust
 * `streaming_anki_service.rs` 的“纯 token 残片/JSON 外侧包装”清理，
 * 与 F4 的 `ModelWrapTokenStreamFilter`（按 provider 策略逐块过滤、
 * 保留正文/代码块字面 token）职责不同，不能直接互换。
 */

/**
 * `dstu-core/src/prompt_contracts.rs::LATEX_RULES`。
 *
 * 与聊天侧共享同一份契约；本 lane 只读引用该文案，不改写。
 */
export const LATEX_RULES = `<latex_rules version="1" priority="highest">
<description>数学公式输出规范，必须严格遵守</description>
<rules>
1. 任何数学表达式必须使用 $...$ (行内) 或 $$...$$ (块级) 包裹，分隔符必须成对闭合。
2. 禁止裸露 LaTeX：不得出现未被 $ 或 $$ 包裹的 \\frac、\\sqrt、\\int、\\sum、\\lim、上下标 ^/_ 等。
3. 严禁用任何形式的 Markdown 代码块（三反引号）包裹数学内容，包括 \`\`\`math、\`\`\`latex 等，全部改用 $/$$ 直接输出。
4. 禁止使用 \\(...\\) 与 \\[...\\] 作为分隔符。
5. 多行/展示型公式须使用 $$ 并独立成段，起止各占一行；行内使用单 $ 且不跨段落。
6. 仅使用 KaTeX 支持的命令；多字符上下标需加花括号；中文/非 ASCII 请置于 \\text{...}；矩阵使用 bmatrix 环境。
7. \\boxed{} 命令必须用 $...$ 包裹：正确格式为 $\\boxed{C}$，禁止使用 [\\boxed{C}] 等未包裹格式。
</rules>
<examples type="correct">
- 行内：$\\lim_{x\\to 0}\\frac{\\sin(ax)-\\sin(bx)}{x}=a-b$
- 块级：
$$
\\int_0^1 x^2\\,\\mathrm{d}x = \\tfrac{1}{3}
$$
</examples>
<examples type="incorrect">
- \\lim_{x\\to 0} \\frac{\\sin x}{x} （未包裹）
- \\( \\int_a^b f(x)\\,\\mathrm{d}x \\) （错误分隔符）
- \`\`\`math ... \`\`\` （代码块包裹，禁止！）
</examples>
<self_check>
发送前自检：若检测到数学符号未在 $ 或 $$ 内，请重写并补齐分隔符后再发送。
</self_check>
</latex_rules>`;

// ============================================================================
// 模型包装 token（`streaming_anki_service.rs:50-108`）
// ============================================================================

export function containsOnlyModelSpecialTokens(text: string): boolean {
  let remaining = rustTrim(text);
  let consumedToken = false;
  while (remaining !== '') {
    const token = MODEL_SPECIAL_TOKENS.find((candidate) => remaining.startsWith(candidate));
    if (token === undefined) return false;
    remaining = rustTrimStart(remaining.slice(token.length));
    consumedToken = true;
  }
  return consumedToken;
}

export function stripModelSpecialTokens(text: string): string {
  if (containsOnlyModelSpecialTokens(text)) return '';

  const trimmed = rustTrim(text);
  const jsonStart = trimmed.indexOf('{');
  const jsonEnd = trimmed.lastIndexOf('}');
  if (jsonStart >= 0 && jsonEnd >= 0) {
    const prefix = trimmed.slice(0, jsonStart);
    const suffix = trimmed.slice(jsonEnd + 1);
    const prefixIsToken = containsOnlyModelSpecialTokens(prefix);
    const suffixIsToken = containsOnlyModelSpecialTokens(suffix);
    const prefixIsNoise = rustTrim(prefix) === '' || prefixIsToken;
    const suffixIsNoise = rustTrim(suffix) === '' || suffixIsToken;
    if ((prefixIsToken || suffixIsToken) && prefixIsNoise && suffixIsNoise) {
      return trimmed.slice(jsonStart, jsonEnd + 1);
    }
  }
  return text;
}

/** 纯模型 token 错误卡无法通过重试修复（`error_content_is_repairable`）。 */
export function errorContentIsRepairable(content: string): boolean {
  if (content.startsWith('解析卡片失败:') && !content.includes('原始输出:')) {
    return false;
  }
  return /[\p{Alphabetic}\p{N}]/u.test(stripModelSpecialTokens(content));
}

// ============================================================================
// 流式统计与事件载荷
// ============================================================================

export interface StreamStats {
  card_count: number;
  failed_cards: number;
  duplicate_cards: number;
  dropped_fragments: number;
  flagged_cards: number;
}

export function defaultStreamStats(): StreamStats {
  return { card_count: 0, failed_cards: 0, duplicate_cards: 0, dropped_fragments: 0, flagged_cards: 0 };
}

export function statsHasWarnings(stats: StreamStats): boolean {
  return (
    stats.failed_cards > 0 ||
    stats.dropped_fragments > 0 ||
    stats.duplicate_cards > 0 ||
    stats.flagged_cards > 0
  );
}

export function statsHasAnySignal(stats: StreamStats): boolean {
  return stats.card_count > 0 || statsHasWarnings(stats);
}

/**
 * `build_critic_summary_event`（纯函数）。Rust `serde_json::to_value(summary)` 对只含数字/
 * 字符串/布尔/Option 的 `CriticSummary` 不会失败，`error!` 降级分支不可达，所以这里直接用
 * serde 形态对象，不再经 JSON 字符串往返。
 */
export function buildCriticSummaryEvent(
  taskId: string,
  documentId: string,
  summary: CriticSummary,
): Record<string, unknown> {
  const inner: Record<string, unknown> = criticSummaryWire(summary);
  inner.task_id = taskId;
  inner.document_id = documentId;
  return { CriticSummary: inner };
}

/** `build_task_completed_event`（纯函数）。 */
export function buildTaskCompletedEvent(
  taskId: string,
  documentId: string,
  stats: StreamStats,
  logger: Pick<AnkiLogger, 'error'> = { error() {} },
): Record<string, unknown> {
  try {
    return {
      TaskCompleted: {
        task_id: taskId,
        final_status: 'Completed',
        total_cards_generated: stats.card_count,
        document_id: documentId,
        failed_cards: stats.failed_cards,
        dropped_fragments: stats.dropped_fragments,
        duplicate_cards: stats.duplicate_cards,
        flagged_cards: stats.flagged_cards,
        completed_with_warnings: statsHasWarnings(stats),
      },
    };
  } catch (error) {
    logger.error('序列化 TaskCompleted 失败（降级为最小载荷）:', error);
    return { TaskCompleted: { task_id: taskId, document_id: documentId } };
  }
}
