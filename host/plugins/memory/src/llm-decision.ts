/** Rust `dstu-memory/src/memory/llm_decision.rs`. */
import { enhancedCleanJsonResponse, extractFirstJsonObject } from './json.ts';
import { f32 } from './f32.ts';

export type MemoryEvent = 'ADD' | 'UPDATE' | 'APPEND' | 'DELETE' | 'NONE';

export function memoryEventFromStr(value: string): MemoryEvent {
  switch (value.toUpperCase()) {
    case 'ADD': return 'ADD';
    case 'UPDATE': return 'UPDATE';
    case 'APPEND': return 'APPEND';
    case 'DELETE': return 'DELETE';
    default: return 'NONE';
  }
}

export interface SimilarMemorySummary {
  note_id: string;
  title: string;
  content_preview: string;
}
export interface MemoryDecisionResponse {
  event: MemoryEvent;
  target_note_id: string | null;
  confidence: number;
  reason: string;
}

export function defaultDecisionResponse(): MemoryDecisionResponse {
  return { event: 'NONE', target_note_id: null, confidence: 0.8, reason: '' };
}

/** Rust serde defaults: `target_note_id` None, `confidence` 0.8, `reason` "", event required. */
function decodeDecision(value: unknown): MemoryDecisionResponse | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.event !== 'string') return null;
  const events: readonly string[] = ['ADD', 'UPDATE', 'APPEND', 'DELETE', 'NONE'];
  if (!events.includes(record.event)) return null;
  const target = record.target_note_id;
  if (target !== undefined && target !== null && typeof target !== 'string') return null;
  const confidence = record.confidence;
  if (confidence !== undefined && typeof confidence !== 'number') return null;
  const reason = record.reason;
  if (reason !== undefined && typeof reason !== 'string') return null;
  return {
    event: record.event as MemoryEvent,
    target_note_id: (target as string | null | undefined) ?? null,
    confidence: f32((confidence as number | undefined) ?? 0.8),
    reason: (reason as string | undefined) ?? '',
  };
}

/** Rust `parse_response`: clean → whole value, then balanced object from cleaned, then from raw. */
export function parseDecisionResponse(response: string): MemoryDecisionResponse | null {
  const cleaned = enhancedCleanJsonResponse(response);
  for (const text of [cleaned, extractFirstJsonObject(cleaned), extractFirstJsonObject(response)]) {
    if (text === null) continue;
    try {
      const parsed = decodeDecision(JSON.parse(text));
      if (parsed !== null) return parsed;
    } catch {
      // Rust `serde_json::from_str` errors move on to the next strategy.
      continue;
    }
  }
  return null;
}

export function buildDecisionPrompt(newContent: string, newTitle: string | null,
  similarMemories: readonly SimilarMemorySummary[]): string {
  const similarList = similarMemories.slice(0, 10).map((memory, index) => {
    const preview = Array.from(memory.content_preview).slice(0, 100).join('');
    return `${index + 1}. [ID: ${memory.note_id}] 标题: ${memory.title}\n   内容: ${preview}`;
  }).join('\n');
  const titlePart = newTitle === null ? '' : `标题: ${newTitle}\n`;
  return `你是一个记忆管理助手。记忆只存储关于用户本人的原子事实（≤50字的短句），不存储学科知识、题目分析、解题过程、文档摘要等通用内容。

## 内容合法性检查（优先于决策规则）

先判断新记忆的内容是否合法。以下内容必须返回 NONE：
- 学科知识（定理、公式、概念解释、知识点罗列）
- 题目内容（题干、选项、解题过程、错题分析）
- 文档摘要（PDF/文件的内容总结、章节概要）
- 通用事实（换一个用户也成立的信息）
- 内容超过 50 字的长文本

合法的记忆示例："高三理科生" / "数学是弱项" / "偏好表格形式总结" / "高考在2026年6月7日"

## 新记忆
${titlePart}内容: ${newContent}

## 现有相似记忆
${similarList}

## 决策规则（仅在内容合法时适用）
1. **ADD**: 新记忆包含全新的用户事实，与现有记忆不重复
2. **UPDATE**: 新记忆是对某条现有记忆的修正或替换（指定 target_note_id）
3. **APPEND**: 新记忆是对某条现有记忆的补充（指定 target_note_id）
4. **DELETE**: 新记忆与某条现有记忆**矛盾**（如 "数学进步了" 与 "数学是弱项"），应删除旧记忆并新增新记忆（指定 target_note_id 为要删除的旧记忆）
5. **NONE**: 信息已包含在现有记忆中，或内容不合法，无需操作

## 矛盾检测指引
- 状态变化属于矛盾：如 "数学弱项" → "数学已提升"，应 DELETE 旧 + ADD 新
- 时间更新属于矛盾：如 "下次模考在3月" → "下次模考改到4月"，应 DELETE 旧 + ADD 新
- 偏好变化属于矛盾：如 "偏好列表格式" → "偏好思维导图格式"，应 DELETE 旧 + ADD 新
- 补充信息不属于矛盾：如 "高三理科生" + "就读于XX中学"，应 APPEND

## 输出格式（JSON）
{
  "event": "ADD" | "UPDATE" | "APPEND" | "DELETE" | "NONE",
  "target_note_id": "UPDATE/APPEND/DELETE 时填写目标记忆的 ID",
  "confidence": 0.0-1.0,
  "reason": "简短说明决策原因"
}

请直接输出 JSON，不要添加其他内容。`;
}
