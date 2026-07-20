/**
 * Chat V2 - 来源相关块稳定化 Hook
 *
 * 背景：流式期间每次 chunk flush 都让 content 块换新引用，
 * useMessageBlocks 返回的数组随之换引用。若直接以整条消息的
 * blocks 数组作为 extractSourcesFromMessageBlocks 的 useMemo 依赖，
 * sourceBundle 会在每次 flush 时重算并返回新对象，进而击穿下游
 * MemoizedBlock / CitationSourceContext / 来源面板的引用比较。
 *
 * 方案：先把块数组过滤为"仅来源相关块"，再与上一次的过滤结果逐一
 * 比较块引用——全部相同则复用旧数组引用。检索块在流式正文期间是
 * 稳定对象（status 落定后不再换引用），因此正文 flush 不再导致
 * 来源计算换引用；来源真正变化（检索块新增/状态变化/citations 到达）
 * 时块引用必然变化，仍会触发重算，行为不变。
 */

import { useRef } from 'react';
import type { Block } from '../../core/types/block';

/**
 * 来源相关的块类型。
 * 须与 sourceAdapter 的提取范围保持同步：
 * - KNOWLEDGE_RETRIEVAL_BLOCK_TYPES（rag/memory/web_search/multimodal_rag/academic_search，
 *   任意状态都参与：error → extractRetrievalErrors，pending/running → hasActiveRetrievalInBlocks）
 * - mcp_tool（toolOutput 可能包含来源）
 */
const SOURCE_RELEVANT_BLOCK_TYPES = new Set([
  'rag',
  'memory',
  'web_search',
  'multimodal_rag',
  'academic_search',
  'mcp_tool',
]);

/** 任意类型的块也可能通过 citations 字段携带来源（数据契约的正确方式） */
function isSourceRelevantBlock(block: Block): boolean {
  if (SOURCE_RELEVANT_BLOCK_TYPES.has(block.type)) return true;
  return !!(block.citations && block.citations.length > 0);
}

/**
 * 把消息块数组折叠为"仅来源相关块"的稳定数组：
 * 过滤结果与上一次逐引用相同时返回上一次的数组引用（保序）。
 */
export function useStableSourceBlocks(messageBlocks: Block[]): Block[] {
  const prevRef = useRef<Block[]>([]);
  const filtered = messageBlocks.filter(isSourceRelevantBlock);
  const prev = prevRef.current;
  if (filtered.length === prev.length && filtered.every((b, i) => b === prev[i])) {
    return prev;
  }
  prevRef.current = filtered;
  return filtered;
}
