/** Rust `dstu-memory/src/memory/llm_decision.rs`. */
import { enhancedCleanJsonResponse, extractFirstJsonObject } from './json.ts';
import { f32 } from './f32.ts';
import { isChineseDominantText } from './hard-rules.ts';

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
  const sample = [newTitle ?? '', newContent].join(' ');
  const chinese = isChineseDominantText(sample);

  if (!chinese) {
    const similarList = similarMemories.slice(0, 10).map((memory, index) => {
      const preview = Array.from(memory.content_preview).slice(0, 100).join('');
      return `${index + 1}. [ID: ${memory.note_id}] Title: ${memory.title}\n   Content: ${preview}`;
    }).join('\n');
    const titlePart = newTitle === null ? '' : `Title: ${newTitle}\n`;
    return `You are a memory management assistant. Fact memories store only concise atomic facts about the user (a short single sentence; <=200 chars for alphabetic languages or <=50 CJK chars) — never generic subject knowledge, problem solutions, or document summaries.

## Content Validity Check (checked before decision rules)

First verify whether the new memory is valid. Return NONE for:
- Generic subject knowledge (theorems, formulas, concept definitions)
- Problem statements, options, worked solutions, or error analyses
- Document/PDF summaries or chapter outlines
- Generic facts that hold true for any user
- Overly long paragraphs rather than a single atomic user fact

Valid examples (preserve the user's original language): "Sophomore engineering student" / "Prefers bullet lists over tables" / "Exam on 2026-06-07"

## New Memory
${titlePart}Content: ${newContent}

## Existing Similar Memories
${similarList}

## Decision Rules (only when valid)
1. **ADD**: Brand-new user fact not duplicated by existing memories
2. **UPDATE**: Corrects or replaces an existing memory (set target_note_id)
3. **APPEND**: Adds complementary detail to an existing memory (set target_note_id)
4. **DELETE**: Contradicts an existing memory (e.g. "no tables, use bullets" vs "prefers tables", or status/date/preference change); delete the old memory and add the new one (set target_note_id to the contradicted memory)
5. **NONE**: Already covered by existing memories, or invalid content

## Contradiction & Language Guidelines
- Format/style/verbosity/language overrides (e.g. tables -> no tables/bullets/prose, verbose -> concise, language switch) are contradictions -> DELETE old + ADD new (or UPDATE target).
- Status or date changes are contradictions -> DELETE old + ADD new.
- Preserve language: write "reason" in the same language as the new memory; never translate the user's memory into another language.

## Output Format (strict JSON only)
{
  "event": "ADD" | "UPDATE" | "APPEND" | "DELETE" | "NONE",
  "target_note_id": "target memory ID for UPDATE/APPEND/DELETE, else null",
  "confidence": 0.0-1.0,
  "reason": "brief reason in the same language as the new memory"
}

Output JSON only, with no surrounding text.`;
  }

  const similarList = similarMemories.slice(0, 10).map((memory, index) => {
    const preview = Array.from(memory.content_preview).slice(0, 100).join('');
    return `${index + 1}. [ID: ${memory.note_id}] 标题: ${memory.title}\n   内容: ${preview}`;
  }).join('\n');
  const titlePart = newTitle === null ? '' : `标题: ${newTitle}\n`;
  return `你是一个记忆管理助手。记忆只存储关于用户本人的原子事实（简短陈述句：中文 ≤50 字，英文等字母语言 ≤200 字符），不存储学科知识、题目分析、解题过程、文档摘要等通用内容。

## 内容合法性检查（优先于决策规则）

先判断新记忆的内容是否合法。以下内容必须返回 NONE：
- 学科知识（定理、公式、概念解释、知识点罗列）
- 题目内容（题干、选项、解题过程、错题分析）
- 文档摘要（PDF/文件的内容总结、章节概要）
- 通用事实（换一个用户也成立的信息）
- 过长的段落文本（非单条原子事实）

合法的记忆示例："高三理科生" / "数学是弱项" / "偏好表格形式总结" / "高考在2026年6月7日"

## 新记忆
${titlePart}内容: ${newContent}

## 现有相似记忆
${similarList}

## 决策规则（仅在内容合法时适用）
1. **ADD**: 新记忆包含全新的用户事实，与现有记忆不重复
2. **UPDATE**: 新记忆是对某条现有记忆的修正或替换（指定 target_note_id）
3. **APPEND**: 新记忆是对某条现有记忆的补充（指定 target_note_id）
4. **DELETE**: 新记忆与某条现有记忆**矛盾**（如 "数学进步了" 与 "数学是弱项"，或格式/风格/篇幅/语言偏好反转），应删除旧记忆并新增新记忆（指定 target_note_id 为要删除的旧记忆）
5. **NONE**: 信息已包含在现有记忆中，或内容不合法，无需操作

## 矛盾检测与语言一致指引
- 状态变化属于矛盾：如 "数学弱项" → "数学已提升"，应 DELETE 旧 + ADD 新
- 时间更新属于矛盾：如 "下次模考在3月" → "下次模考改到4月"，应 DELETE 旧 + ADD 新
- 偏好反转属于矛盾：如 "偏好表格格式" → "不要用表格，改用要点列表"，或篇幅/语气/语言切换，应 DELETE 旧 + ADD 新
- 补充信息不属于矛盾：如 "高三理科生" + "就读于XX中学"，应 APPEND
- 语言一致：\`reason\` 沿用新记忆所在语言，切勿擅自翻译或因非中文而误判为非法内容

## 输出格式（JSON）
{
  "event": "ADD" | "UPDATE" | "APPEND" | "DELETE" | "NONE",
  "target_note_id": "UPDATE/APPEND/DELETE 时填写目标记忆的 ID",
  "confidence": 0.0-1.0,
  "reason": "简短说明决策原因"
}

请直接输出 JSON，不要添加其他内容。`;
}
