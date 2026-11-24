/**
 * 批注正文与学生提交原文的对齐校验。
 *
 * 协议要求模型在批注正文中逐字复述学生原文，新增内容必须包裹在 `<ins>` 内。
 * 但部分模型（尤其多轮批改时）会私自在纯文本里夹带示范例句或扩写段落，
 * 导致未提交的 AI 文本伪装成学生原文展示。
 *
 * 本模块将纯文本片段按段/句与学生提交的 `originalText` 比对：
 * - 命中原文或 bigram 覆盖率达标 → 保持普通原文 (`text`)
 * - 明显不属于原文的长句/段落 → 降级标记为 `ins`（附 `inferredInsertion: true`），
 *   由渲染层以醒目的「建议补充」样式区分，绝不伪装为学生原文。
 */
import type { StreamingMarker } from './streamingMarkerParser';

/** 触发原文比对的最小有效字符数（不含空白与标点），避免误伤短衔接词/标点 */
const MIN_CHECK_CHARS = 10;

/** bigram 命中率低于该阈值视为模型私自补充的未提交文本 */
const ORIGINAL_CONTAINMENT_THRESHOLD = 0.45;

function normalizeForMatch(text: string): string {
  return text
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase();
}

function buildBigramSet(normalized: string): Set<string> {
  const bigrams = new Set<string>();
  const chars = Array.from(normalized);
  for (let i = 0; i < chars.length - 1; i += 1) {
    bigrams.add(chars[i] + chars[i + 1]);
  }
  return bigrams;
}

function bigramContainment(normalizedSegment: string, originalBigrams: Set<string>): number {
  const chars = Array.from(normalizedSegment);
  if (chars.length < 2) return 1;
  let hits = 0;
  const total = chars.length - 1;
  for (let i = 0; i < total; i += 1) {
    if (originalBigrams.has(chars[i] + chars[i + 1])) {
      hits += 1;
    }
  }
  return hits / total;
}

/**
 * 将纯文本按段落换行及句末标点切分为保序片段（拼接后与原串逐字一致）。
 */
function splitPreservingSentences(text: string): string[] {
  const result: string[] = [];
  // 先按换行保留段落边界
  const lineParts = text.split(/(\n+)/);
  for (const part of lineParts) {
    if (!part) continue;
    if (/^\n+$/.test(part)) {
      result.push(part);
      continue;
    }
    // 按中英文句末标点切分，保留句末标点与紧随的右引号/括号/空格
    const sentenceRegex = /[^。！？!?.]+(?:[。！？!?]+[”’」》"'）)\]]*\s*|\.(?=\s|$)[”’」》"'）)\]]*\s*|\.+|$)/g;
    let match: RegExpExecArray | null;
    let lastIndex = 0;
    while ((match = sentenceRegex.exec(part)) !== null) {
      if (match[0].length === 0) {
        sentenceRegex.lastIndex += 1;
        continue;
      }
      if (match.index > lastIndex) {
        result.push(part.slice(lastIndex, match.index));
      }
      result.push(match[0]);
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < part.length) {
      result.push(part.slice(lastIndex));
    }
  }
  return result;
}

function pushText(target: StreamingMarker[], content: string): void {
  if (!content) return;
  const last = target[target.length - 1];
  if (last && last.type === 'text') {
    last.content += content;
  } else {
    target.push({ type: 'text', content, isComplete: true });
  }
}

/**
 * 核验批注流中的 `text` 片段是否源自学生实际提交的 `originalText`。
 * 未提供 `originalText`（如纯图作文或历史兼容调用）时原样返回。
 */
export function reconcileMarkersWithOriginal(
  markers: StreamingMarker[],
  originalText?: string | null,
): StreamingMarker[] {
  if (!originalText || !originalText.trim()) return markers;
  const normalizedOriginal = normalizeForMatch(originalText);
  if (Array.from(normalizedOriginal).length < MIN_CHECK_CHARS) return markers;

  const originalBigrams = buildBigramSet(normalizedOriginal);
  const reconciled: StreamingMarker[] = [];
  let changed = false;

  for (const marker of markers) {
    if (marker.type !== 'text' || !marker.content) {
      reconciled.push(marker);
      continue;
    }

    const segments = splitPreservingSentences(marker.content);
    for (const seg of segments) {
      if (!seg) continue;
      if (/^\s+$/.test(seg)) {
        pushText(reconciled, seg);
        continue;
      }
      const norm = normalizeForMatch(seg);
      const normChars = Array.from(norm).length;
      if (
        normChars < MIN_CHECK_CHARS
        || normalizedOriginal.includes(norm)
        || bigramContainment(norm, originalBigrams) >= ORIGINAL_CONTAINMENT_THRESHOLD
      ) {
        pushText(reconciled, seg);
        continue;
      }

      // 识别为模型私自补充的未提交文本：保留前后空白为 text，正文转为建议补充 (ins)
      const leadingWs = seg.match(/^\s+/)?.[0] ?? '';
      const trailingWs = seg.match(/\s+$/)?.[0] ?? '';
      const core = seg.slice(leadingWs.length, seg.length - trailingWs.length);
      if (!core) {
        pushText(reconciled, seg);
        continue;
      }
      changed = true;
      if (leadingWs) pushText(reconciled, leadingWs);
      reconciled.push({
        type: 'ins',
        content: core,
        inferredInsertion: true,
        isComplete: true,
      });
      if (trailingWs) pushText(reconciled, trailingWs);
    }
  }

  return changed ? reconciled : markers;
}
