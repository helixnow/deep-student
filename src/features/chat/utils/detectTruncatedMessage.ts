export interface DetectTruncatedMessageInput {
  status?: string | null;
  finishReason?: string | null;
  truncated?: boolean;
  content: string;
  hasStreamingBlocks?: boolean;
}

const LENGTH_FINISH_REASONS = new Set(['length', 'max_tokens', 'max_output_tokens']);

const DANGLING_SUFFIX_RE = /(?:[：:，,、(\[（【+\-×÷=→⇒]|于是|因此|例如|包括|如下|建议写成|也就是说|换言之)$/;

function countFenceLines(text: string): number {
  const matches = text.match(/^[ \t]*```/gm);
  return matches ? matches.length : 0;
}

function countDisplayMathDelimiters(text: string): number {
  const matches = text.match(/\$\$/g);
  return matches ? matches.length : 0;
}

/**
 * 判断一条已完成渲染的助手消息是否可能在长度上限处被截断，以便在 UI 侧提供“继续生成”入口。
 */
export function isLikelyTruncatedAssistantMessage(input: DetectTruncatedMessageInput): boolean {
  if (input.hasStreamingBlocks) return false;
  if (input.status === 'streaming' || input.status === 'pending' || input.status === 'cancelled') {
    return false;
  }

  const trimmed = input.content.trim();
  if (!trimmed) return false;

  if (input.truncated === true) return true;

  const reason = input.finishReason?.trim().toLowerCase();
  if (reason && LENGTH_FINISH_REASONS.has(reason)) {
    return true;
  }

  // 启发式兜底只用于长文本，避免短句/标题结尾的冒号被误判
  if (trimmed.length < 200) return false;

  if (countFenceLines(trimmed) % 2 === 1) return true;
  if (countDisplayMathDelimiters(trimmed) % 2 === 1) return true;

  return DANGLING_SUFFIX_RE.test(trimmed);
}
