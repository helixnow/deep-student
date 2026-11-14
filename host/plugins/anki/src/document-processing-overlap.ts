/**
 * 文档分段的相邻重叠：边界吸附、前后缀摘取与按 token 裁剪。
 */
import {
  byteIndexAtCharIndex,
  debugLog,
  firstParagraphStartByteIndex,
  firstSentenceEndByteIndex,
  lastParagraphStartByteIndex,
  lastSentenceEndByteIndex,
  utf8Length,
} from './document-processing-text.ts';
import { charCount, rustTrim, rustTrimEnd, rustTrimStart } from '../../../platform/util/index.ts';
import { estimateTokens } from './document-processing-segment.ts';
import { segmentWithoutOverlap } from './document-processing-segment.ts';

export function segmentWithOverlap(
  content: string,
  maxTokensPerSegment: number,
  overlapSize: number,
  snapBoundaries: boolean,
): string[] {
  // 首先进行无重叠分段
  const baseSegments = segmentWithoutOverlap(content, maxTokensPerSegment, snapBoundaries);

  // 如果只有一个分段，不需要重叠
  if (baseSegments.length <= 1) {
    return baseSegments;
  }

  debugLog(`[DOCUMENT_DEBUG] 应用重叠策略，基础分段数: ${baseSegments.length}`);

  const overlappedSegments: string[] = [];

  for (let i = 0; i < baseSegments.length; i += 1) {
    let coreSegment = baseSegments[i]!;
    let baseTokens = estimateTokens(coreSegment);
    let prefixInsert = '';
    let prefixTokens = 0;

    if (i > 0) {
      const prevSegment = baseSegments[i - 1]!;
      const overlapPrefix = getOverlapSuffix(prevSegment, overlapSize);
      if (overlapPrefix !== null) {
        const allowed = Math.max(0, maxTokensPerSegment - baseTokens);
        if (allowed > 0) {
          const prefixCandidate = rustTrimEnd(overlapPrefix);
          const candidateTokens = estimateTokens(prefixCandidate);
          let trimmedPrefix = prefixCandidate;
          if (candidateTokens > allowed) {
            trimmedPrefix = takeSuffixWithTokenLimit(prefixCandidate, allowed);
            debugLog(
              `[DOCUMENT_DEBUG] 分段${i + 1}前重叠裁剪: 原${candidateTokens}tokens → 裁剪后${estimateTokens(trimmedPrefix)}tokens (限制 ${allowed})`,
            );
          }
          const trimmedTokens = estimateTokens(trimmedPrefix);
          if (trimmedTokens > 0 && trimmedPrefix !== '') {
            prefixTokens = trimmedTokens;
            prefixInsert = trimmedPrefix;
            debugLog(
              `[DOCUMENT_DEBUG] 分段${i + 1}添加前重叠: ${utf8Length(prefixInsert)}字符 (${prefixTokens}tokens)`,
            );
          }
        }
      }
    }

    let suffixInsert = '';
    let suffixTokens = 0;

    if (i < baseSegments.length - 1) {
      const nextSegment = baseSegments[i + 1]!;
      const overlapSuffix = getOverlapPrefix(nextSegment, overlapSize);
      if (overlapSuffix !== null) {
        const allowed = Math.max(0, maxTokensPerSegment - (baseTokens + prefixTokens));
        if (allowed > 0) {
          const suffixCandidate = rustTrimStart(overlapSuffix);
          const candidateTokens = estimateTokens(suffixCandidate);
          let trimmedSuffix = suffixCandidate;
          if (candidateTokens > allowed) {
            trimmedSuffix = takePrefixWithTokenLimit(suffixCandidate, allowed);
            debugLog(
              `[DOCUMENT_DEBUG] 分段${i + 1}后重叠裁剪: 原${candidateTokens}tokens → 裁剪后${estimateTokens(trimmedSuffix)}tokens (限制 ${allowed})`,
            );
          }
          const trimmedTokens = estimateTokens(trimmedSuffix);
          if (trimmedTokens > 0 && trimmedSuffix !== '') {
            suffixTokens = trimmedTokens;
            suffixInsert = trimmedSuffix;
            debugLog(
              `[DOCUMENT_DEBUG] 分段${i + 1}添加后重叠: ${utf8Length(suffixInsert)}字符 (${suffixTokens}tokens)`,
            );
          }
        }
      }
    }

    let combinedTokens = baseTokens + prefixTokens + suffixTokens;
    if (combinedTokens > maxTokensPerSegment) {
      debugLog(
        `[DOCUMENT_DEBUG] 分段${i + 1}重叠后超出限制: ${combinedTokens} > ${maxTokensPerSegment}，开始裁剪`,
      );
      if (suffixTokens > 0) {
        const allowedForSuffix = Math.max(0, maxTokensPerSegment - (baseTokens + prefixTokens));
        if (allowedForSuffix === 0) {
          suffixInsert = '';
          suffixTokens = 0;
        } else if (suffixTokens > allowedForSuffix) {
          suffixInsert = takePrefixWithTokenLimit(suffixInsert, allowedForSuffix);
          suffixTokens = estimateTokens(suffixInsert);
        }
      }
      combinedTokens = baseTokens + prefixTokens + suffixTokens;

      if (combinedTokens > maxTokensPerSegment && prefixTokens > 0) {
        const allowedForPrefix = Math.max(0, maxTokensPerSegment - (baseTokens + suffixTokens));
        if (allowedForPrefix === 0) {
          prefixInsert = '';
          prefixTokens = 0;
        } else if (prefixTokens > allowedForPrefix) {
          prefixInsert = takeSuffixWithTokenLimit(prefixInsert, allowedForPrefix);
          prefixTokens = estimateTokens(prefixInsert);
        }
      }
      combinedTokens = baseTokens + prefixTokens + suffixTokens;

      if (combinedTokens > maxTokensPerSegment) {
        const allowedForBase = Math.max(0, maxTokensPerSegment - (prefixTokens + suffixTokens));
        if (allowedForBase === 0) {
          coreSegment = '';
          baseTokens = 0;
        } else if (baseTokens > allowedForBase) {
          coreSegment = takePrefixWithTokenLimit(coreSegment, allowedForBase);
          baseTokens = estimateTokens(coreSegment);
        }
      }
      combinedTokens = baseTokens + prefixTokens + suffixTokens;

      if (combinedTokens > maxTokensPerSegment && suffixTokens > 0) {
        suffixInsert = '';
        combinedTokens = baseTokens + prefixTokens;
      }
      if (combinedTokens > maxTokensPerSegment && prefixTokens > 0) {
        prefixInsert = '';
        combinedTokens = baseTokens;
      }
      if (combinedTokens > maxTokensPerSegment) {
        coreSegment = takePrefixWithTokenLimit(coreSegment, maxTokensPerSegment);
        baseTokens = estimateTokens(coreSegment);
        combinedTokens = baseTokens;
      }
      debugLog(`[DOCUMENT_DEBUG] 分段${i + 1}裁剪后 token=${combinedTokens}`);
    }

    const parts: string[] = [];
    if (prefixInsert !== '') {
      parts.push(rustTrimEnd(prefixInsert));
    }
    if (coreSegment !== '') {
      parts.push(coreSegment);
    }
    if (suffixInsert !== '') {
      parts.push(rustTrimStart(suffixInsert));
    }
    const finalSegment = parts.join('\n\n');
    const finalTokens = estimateTokens(finalSegment);
    if (finalTokens > maxTokensPerSegment) {
      debugLog(
        `[DOCUMENT_DEBUG] 分段${i + 1}最终兜底裁剪: ${finalTokens} > ${maxTokensPerSegment}`,
      );
      overlappedSegments.push(takePrefixWithTokenLimit(finalSegment, maxTokensPerSegment));
    } else {
      overlappedSegments.push(finalSegment);
    }
  }

  debugLog(`[DOCUMENT_DEBUG] 重叠处理完成，最终分段数: ${overlappedSegments.length}`);
  return overlappedSegments;
}

/** 取不超过 `maxTokens` 的最长前缀（按 char 边界，绝不切坏字符）。 */
export function takePrefixWithTokenLimit(text: string, maxTokens: number): string {
  if (maxTokens === 0 || text === '') {
    return '';
  }
  const collected: string[] = [];
  for (const ch of text) {
    collected.push(ch);
    if (estimateTokens(collected.join('')) > maxTokens) {
      collected.pop();
      break;
    }
  }
  while (collected.length > 0 && estimateTokens(collected.join('')) > maxTokens) {
    collected.pop();
  }
  return collected.join('');
}

/** 取不超过 `maxTokens` 的最长后缀（按 char 边界，绝不切坏字符）。 */
export function takeSuffixWithTokenLimit(text: string, maxTokens: number): string {
  if (maxTokens === 0 || text === '') {
    return '';
  }
  const chars = Array.from(text);
  const collected: string[] = [];
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    collected.push(chars[index]!);
    const candidate = [...collected].reverse().join('');
    if (estimateTokens(candidate) > maxTokens) {
      collected.pop();
      break;
    }
  }
  collected.reverse();
  while (collected.length > 0 && estimateTokens(collected.join('')) > maxTokens) {
    collected.shift();
  }
  return collected.join('');
}

/**
 * 将字节索引转换为字符索引。
 *
 * `byteIndex` 必须来自对同一字符串的 `find`/`rfind`（即落在字符边界上）。
 * 修复：旧实现对空字符串会 `0 - 1` 下溢 panic，现在用 saturating_sub 兜底。
 */
export function byteIndexToCharIndex(text: string, byteIndex: number): number {
  let count = 0;
  let byteOffset = 0;
  for (const ch of text) {
    if (byteOffset > byteIndex) break;
    count += 1;
    byteOffset += utf8Length(ch);
  }
  return Math.max(0, count - 1);
}

/**
 * 计算相邻段可借用的最大重叠字符数。
 *
 * 修复「重复 overlap」bug：旧实现在邻段长度 ≤ overlap_size 时直接返回整个邻段，
 * 两个短分段会互相完整包含对方（内容成倍重复 → 重复制卡）。
 * 现在重叠上限还受"邻段字符数的一半"约束，保证重叠只是边界上下文而非整段复制。
 */
export function effectiveOverlapChars(neighborCharCount: number, maxChars: number): number {
  return Math.min(maxChars, Math.trunc(neighborCharCount / 2));
}

/** 获取文本的前缀（用于重叠：作为上一段的后缀上下文）。 */
export function getOverlapPrefix(text: string, maxChars: number): string | null {
  const totalChars = charCount(text);
  const limit = effectiveOverlapChars(totalChars, maxChars);
  if (limit === 0) {
    return null;
  }

  // 安全地获取前缀（按字符数而非字节数）
  const prefix = Array.from(text).slice(0, limit).join('');

  // 尝试在句子边界处截断
  const sentenceByteIndex = lastSentenceEndByteIndex(prefix);
  if (sentenceByteIndex !== null) {
    const lastSentenceEndChars = byteIndexToCharIndex(prefix, sentenceByteIndex);
    if (lastSentenceEndChars > Math.trunc(limit / 2)) {
      // 确保不会截断太多
      return Array.from(prefix).slice(0, lastSentenceEndChars + 1).join('');
    }
  }

  // 尝试在段落边界处截断
  const paragraphByteIndex = lastParagraphStartByteIndex(prefix);
  if (paragraphByteIndex !== null) {
    const lastParagraphEndChars = byteIndexToCharIndex(prefix, paragraphByteIndex);
    if (lastParagraphEndChars > Math.trunc(limit / 2)) {
      return Array.from(prefix).slice(0, lastParagraphEndChars).join('');
    }
  }

  // 尝试在词边界处截断
  const spaceIndex = prefix.lastIndexOf(' ');
  const spaceByteIndex = spaceIndex < 0 ? null : utf8Length(prefix.slice(0, spaceIndex));
  if (spaceByteIndex !== null) {
    const lastSpaceChars = byteIndexToCharIndex(prefix, spaceByteIndex);
    if (lastSpaceChars > Math.trunc(limit / 2)) {
      return Array.from(prefix).slice(0, lastSpaceChars).join('');
    }
  }

  // 最后选择：直接返回安全截断的前缀
  return prefix;
}

/** 获取文本的后缀（用于重叠：作为下一段的前缀上下文）。 */
export function getOverlapSuffix(text: string, maxChars: number): string | null {
  const totalChars = charCount(text);
  const limit = effectiveOverlapChars(totalChars, maxChars);
  if (limit === 0) {
    return null;
  }

  // 安全地获取后缀（按字符数而非字节数）
  const suffix = Array.from(text).slice(totalChars - limit).join('');

  // 尝试在句子边界处开始
  const sentenceByteIndex = firstSentenceEndByteIndex(suffix);
  if (sentenceByteIndex !== null) {
    const firstSentenceStartChars = byteIndexToCharIndex(suffix, sentenceByteIndex);
    const remaining = Array.from(suffix).slice(firstSentenceStartChars + 1).join('');
    if (charCount(remaining) > Math.trunc(limit / 2)) {
      // 确保不会截断太多
      return rustTrim(remaining);
    }
  }

  // 尝试在段落边界处开始
  const paragraphByteIndex = firstParagraphStartByteIndex(suffix);
  if (paragraphByteIndex !== null) {
    const firstParagraphStartChars = byteIndexToCharIndex(suffix, paragraphByteIndex);
    const remaining = Array.from(suffix).slice(firstParagraphStartChars + 2).join('');
    if (charCount(remaining) > Math.trunc(limit / 2)) {
      return remaining;
    }
  }

  // 尝试在词边界处开始
  const spaceIndex = suffix.indexOf(' ');
  if (spaceIndex >= 0) {
    const firstSpaceChars = byteIndexToCharIndex(suffix, utf8Length(suffix.slice(0, spaceIndex)));
    const remaining = Array.from(suffix).slice(firstSpaceChars + 1).join('');
    if (charCount(remaining) > Math.trunc(limit / 2)) {
      return remaining;
    }
  }

  // 最后选择：直接返回安全截断的后缀
  return suffix;
}

/**
 * 把全局限额分配到各分段。
 *
 * F14：用户要「从长材料提炼少量卡」时，额度不能只喂给前面的分段，否则排在
 * 后面的章节（往往包含结论）会因零额度被永久跳过。这里改为**按全文等距抽样**
 * 分配，使抽样跨越开头到结尾：
 * - `total >= segments`：每段至少 1 张，余数按等距位置补充（不再全给前段）；
 * - `total < segments`：按等距位置选出 `total` 个分段各 1 张（首段与末段均
 *   可能入选），其余为 0；
 * - 总额度恒守恒（求和 == total）。
 * 按权重（各段文本量）分配总卡数：最大余数法，总量守恒；总量不超过段数时退回
 * {@link distributeGlobalMaxCards} 的等距抽样。权重全为 0 时按等分处理。
 */
