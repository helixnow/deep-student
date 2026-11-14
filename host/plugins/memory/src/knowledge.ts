/**
 * Knowledge extraction pure layer — TS mirror of
 * `src-tauri/src/chat_v2/tools/knowledge_executor.rs` routing and response
 * parsing (the LLM call and VFS ingestion stay out of scope).
 */
import { stripToolNamespace } from './paper-save.ts';

export const KNOWLEDGE_EXTRACT_TOOL = 'knowledge_extract';
export type ToolSensitivity = 'low' | 'medium' | 'high';

export interface KnowledgeCandidate {
  content: string;
  category: string;
}

export function knowledgeCanHandle(toolName: string): boolean {
  return stripToolNamespace(toolName) === KNOWLEDGE_EXTRACT_TOOL;
}

export function knowledgeSensitivity(): ToolSensitivity {
  return 'low';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rust `parse_extraction_response` (code fences tolerated, malformed array errors). */
export function parseExtractionResponse(response: string): KnowledgeCandidate[] {
  const trimmed = response.trim();
  const cleaned = trimmed
    .replace(/^(?:```json)+/, '')
    .replace(/^(?:```)+/, '')
    .replace(/(?:```)+$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    throw new Error(`JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error('响应不是 JSON 数组');

  const candidates: KnowledgeCandidate[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    const content = item['content'];
    const category = item['category'];
    if (typeof content !== 'string' || typeof category !== 'string') continue;
    candidates.push({ content, category });
  }
  return candidates;
}
