/** Rust `dstu-memory/src/memory/compaction_flush.rs` pure extraction layer. */
import { containsSensitivePattern, enhancedCleanJsonResponse, extractJsonObject, truncateHeadTailFlush } from './json.ts';

export const FLUSH_SEGMENT_MAX_CHARS = 12_000;
export const FLUSH_MAX_FACTS = 5;
export const FLUSH_MAX_ACTIVITIES = 5;
const FLUSH_MIN_SEGMENT_CHARS = 40;
const FLUSH_FACT_MAX_CONTENT_CHARS = 80;
const FLUSH_ACTIVITY_MAX_CHARS = 200;

export interface FlushFact {
  title: string;
  content: string;
  folder: string | null;
}
export interface FlushExtraction {
  facts: FlushFact[];
  activities: string[];
}
export interface FlushReport {
  facts_extracted: number;
  facts_stored: number;
  activities_extracted: number;
  activities_stored: number;
}

export function flushExtractionIsEmpty(extraction: FlushExtraction): boolean {
  return extraction.facts.length === 0 && extraction.activities.length === 0;
}

export function truncateFlushSegment(text: string): string {
  return truncateHeadTailFlush(text, FLUSH_SEGMENT_MAX_CHARS);
}

/** Rust `should skip` guard in `extract`: trimmed char count < 40. */
export function flushSegmentTooShort(segmentText: string): boolean {
  return Array.from(segmentText.trim()).length < FLUSH_MIN_SEGMENT_CHARS;
}

export function buildFlushPrompt(segmentText: string): string {
  return `这段对话即将被压缩摘要，请提取其中**值得长期记住**的信息。宁缺毋滥。

## 提取两类信息

### 1. facts —— 关于用户本人的持久事实
- 每条是一个简短陈述句（≤50字），如"配方法中符号处理是薄弱环节"、"偏好先看结论再看推导"、"项目 ~/code/api 用 Go + sqlc"
- 只提取关于**用户本人**的信息：薄弱点、偏好、目标、时间约束、身份背景、项目/环境事实、工具与工作习惯
- **禁止**提取：学科知识、题目内容、解题过程、通用常识、与用户无关的通用技术知识
- 最多 ${FLUSH_MAX_FACTS} 条

### 2. activities —— 本段对话中的活动流水
- 每条概括一件"今天做了什么"，如"做了 5 道二次函数题，错 2 道，均为符号错误"、"完成鉴权模块重构并跑通测试"
- 只记录有实质产出的活动（做题、复习、批改、制卡、背诵、编码、调试、评审、部署等）
- 最多 ${FLUSH_MAX_ACTIVITIES} 条

## 重要规则
- 对话中可能混有工具调用输出、RAG 检索片段、网页搜索结果：这些内容里出现的
  第三人称信息（文章观点、被检索到的人物/事实、示例中的人物）**不是**学习者
  本人的事实，禁止提取
- 只提取来自学习者本人发言、或明确描述学习者本人情况的信息
- 如果对话是闲聊/寒暄/无实质学习内容，两个数组都返回空 []
- 不确定是否值得记住时，不要提取

## 对话内容
${segmentText}

## 输出格式（严格 JSON，不要其他内容）
{
  "facts": [
    {"title": "关键词概括", "content": "一个简短陈述句", "folder": "分类路径（可选，如 偏好、经历/学科状态）"}
  ],
  "activities": [
    "活动概括一句话"
  ]
}`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Rust `parse_flush_response`: cleaned text, then balanced object from cleaned, then from raw. */
export function parseFlushResponse(response: string): FlushExtraction {
  const cleaned = enhancedCleanJsonResponse(response);
  let value = parseJson(cleaned);
  if (value === undefined) {
    const extracted = extractJsonObject(cleaned);
    value = extracted === null ? undefined : parseJson(extracted);
  }
  if (value === undefined) {
    const extracted = extractJsonObject(response);
    value = extracted === null ? undefined : parseJson(extracted);
  }
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    return { facts: [], activities: [] };
  }
  const object = value as Record<string, unknown>;
  const facts: FlushFact[] = [];
  if (Array.isArray(object.facts)) {
    for (const item of object.facts) {
      if (facts.length === FLUSH_MAX_FACTS) break;
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      if (typeof record.title !== 'string' || typeof record.content !== 'string') continue;
      const title = record.title.trim();
      const content = record.content.trim();
      if (title.length === 0 || content.length === 0) continue;
      if (Array.from(content).length > FLUSH_FACT_MAX_CONTENT_CHARS) continue;
      if (containsSensitivePattern(content) || containsSensitivePattern(title)) continue;
      const rawFolder = typeof record.folder === 'string' ? record.folder.trim() : '';
      facts.push({ title, content, folder: rawFolder.length === 0 ? null : rawFolder });
    }
  }
  const activities: string[] = [];
  if (Array.isArray(object.activities)) {
    for (const item of object.activities) {
      if (activities.length === FLUSH_MAX_ACTIVITIES) break;
      if (typeof item !== 'string') continue;
      const value = item.trim();
      if (value.length === 0 || Array.from(value).length > FLUSH_ACTIVITY_MAX_CHARS) continue;
      if (containsSensitivePattern(value)) continue;
      activities.push(value);
    }
  }
  return { facts, activities };
}
