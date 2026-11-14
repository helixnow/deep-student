/**
 * Memory search-result compressor — TS mirror of
 * `dstu-memory/src/memory/compressor.rs`.
 *
 * The only external dependency is the L02 memory-decision completion port.
 * Failures (missing provider, model error, empty output) fall back to the
 * original results, matching the Rust warning-only degradation.
 */
import type { CompressedRetrievalMemory, MemoryDecisionCompletion, MemorySearchResult } from '../api.ts';

/** Rust `MAX_UNCOMPRESSED_CHARS`. */
export const MEMORY_COMPRESSION_MAX_CHARS = 300;
export const MEMORY_SUMMARY_TITLE = '用户记忆摘要';

/** Rust `CompressedMemoryResult::passthrough`. */
export function passthroughMemoryResults(
  results: readonly MemorySearchResult[],
): CompressedRetrievalMemory[] {
  return results.map(result => ({
    noteId: result.noteId,
    noteTitle: result.noteTitle,
    folderPath: result.folderPath,
    chunkText: result.chunkText,
    score: result.score,
    sourceNoteIds: [],
  }));
}

/** Rust `MemoryCompressor::build_prompt`. */
export function buildMemoryCompressionPrompt(query: string,
  results: readonly MemorySearchResult[]): string {
  let memoryLines = '';
  for (const [index, result] of results.entries()) {
    memoryLines += `${index + 1}. [${result.folderPath}] ${result.noteTitle}: ${result.chunkText}\n`;
  }
  return `你是一个记忆压缩助手。将以下用户记忆检索结果压缩为一段紧凑摘要，保留与当前查询最相关的信息。

## 当前查询
${query}

## 原始记忆（${results.length} 条）
${memoryLines}

## 压缩规则
1. 保留与查询直接相关的事实，删除不相关的
2. 合并重复/近似内容
3. 使用简短陈述句，用分号分隔
4. 保留 LaTeX 公式原样（如有）
5. 输出不超过 200 字
6. 只输出压缩结果，不要任何前缀或解释`;
}

function charCount(text: string): number {
  return Array.from(text).length;
}

/**
 * Rust `MemoryCompressor::compress`.
 *
 * `completion` is resolved lazily so a missing L02 provider follows the same
 * degradation path as a failed model call.
 */
export async function compressMemoryResults(
  completion: () => MemoryDecisionCompletion,
  query: string,
  results: readonly MemorySearchResult[],
  warn: (message: string) => void = () => undefined,
): Promise<CompressedRetrievalMemory[]> {
  if (results.length === 0) return [];
  const totalChars = results.reduce((sum, result) => sum + charCount(result.chunkText), 0);
  if (totalChars <= MEMORY_COMPRESSION_MAX_CHARS) return passthroughMemoryResults(results);

  const prompt = buildMemoryCompressionPrompt(query, results);
  let compressedText: string;
  try {
    const output = await completion().callMemoryDecisionRawPrompt(prompt);
    compressedText = output.assistant_message.trim();
  } catch (error) {
    warn(`[MemoryCompressor] LLM compression failed, using originals: ${error instanceof Error ? error.message : String(error)}`);
    return passthroughMemoryResults(results);
  }
  if (compressedText.length === 0) {
    warn('[MemoryCompressor] LLM returned empty, falling back to originals');
    return passthroughMemoryResults(results);
  }

  const sourceNoteIds = results.map(result => result.noteId);
  return [{
    noteId: null,
    noteTitle: MEMORY_SUMMARY_TITLE,
    folderPath: '',
    chunkText: `本条为 ${results.length} 条记忆的压缩摘要，可用 memory_read 按 sourceNoteIds 中的 ID 查看原文。\n${compressedText}`,
    score: results[0]?.score ?? 0.5,
    sourceNoteIds,
  }];
}
