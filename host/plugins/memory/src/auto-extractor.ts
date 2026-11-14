/** Rust `dstu-memory/src/memory/auto_extractor.rs` pure extraction layer. */
import {
  containsSensitivePattern, enhancedCleanJsonResponse, extractJsonArray, extractJsonObject,
  truncateHeadTailAutoExtractor,
} from './json.ts';

/** 单条活动流水的最大字符数（auto_extractor.rs:33） */
const ACTIVITY_MAX_CHARS = 200;
/** 单次提取的活动流水条数上限（auto_extractor.rs:35） */
const MAX_ACTIVITIES = 5;
/** facts 条数上限（auto_extractor.rs:249,395） */
const MAX_FACTS = 5;
/** content 字符上限（auto_extractor.rs:372） */
const MAX_FACT_CONTENT_CHARS = 80;
const MAX_USER_CHARS = 1500;

export interface CandidateMemory {
  title: string;
  content: string;
  folder: string | null;
}
export interface ExtractionResult {
  candidates: CandidateMemory[];
  activities: string[];
}

export function valuesToActivities(items: readonly unknown[]): string[] {
  const result: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const value = item.trim();
    if (value.length === 0 || Array.from(value).length > ACTIVITY_MAX_CHARS) continue;
    if (containsSensitivePattern(value)) continue;
    result.push(value);
    if (result.length === MAX_ACTIVITIES) break;
  }
  return result;
}

export function valuesToCandidates(items: readonly unknown[]): CandidateMemory[] {
  const result: CandidateMemory[] = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const title = typeof record.title === 'string' ? record.title : null;
    const content = typeof record.content === 'string' ? record.content : null;
    if (title === null || content === null) continue;
    if (title.length === 0 || content.length === 0 || Array.from(content).length > MAX_FACT_CONTENT_CHARS) continue;
    if (containsSensitivePattern(content) || containsSensitivePattern(title)) continue;
    const folderValue = typeof record.folder === 'string' ? record.folder : null;
    result.push({ title, content, folder: folderValue !== null && folderValue.length > 0 ? folderValue : null });
    if (result.length === MAX_FACTS) break;
  }
  return result;
}

export function extractionFromObject(value: Record<string, unknown>): ExtractionResult {
  const facts = Array.isArray(value.facts) ? valuesToCandidates(value.facts) : [];
  const activities = Array.isArray(value.activities) ? valuesToActivities(value.activities) : [];
  return { candidates: facts, activities };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Rust `parse_extraction_response_full`: full object, then noise-wrapped object, then legacy array. */
export function parseExtractionResponseFull(response: string): ExtractionResult {
  const cleaned = enhancedCleanJsonResponse(response);
  const value = parseJson(cleaned);
  if (Array.isArray(value)) return { candidates: valuesToCandidates(value), activities: [] };
  if (value !== null && typeof value === 'object') return extractionFromObject(value as Record<string, unknown>);
  const objectText = extractJsonObject(cleaned) ?? extractJsonObject(response);
  if (objectText !== null) {
    const parsed = parseJson(objectText);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return extractionFromObject(parsed as Record<string, unknown>);
    }
  }
  for (const source of [cleaned, response]) {
    const arrayText = extractJsonArray(source);
    if (arrayText === null) continue;
    const parsed = parseJson(arrayText);
    if (Array.isArray(parsed)) return { candidates: valuesToCandidates(parsed), activities: [] };
  }
  return { candidates: [], activities: [] };
}

/** Rust `truncate_head_tail(user_content, 1500)` used before the prompt. */
export function truncateExtractionInput(text: string): string {
  return truncateHeadTailAutoExtractor(text, MAX_USER_CHARS);
}

/** Rust `build_extraction_prompt` (byte-identical template; only the profile excerpt is substituted). */
export function buildExtractionPrompt(userContent: string, assistantContent: string, existingProfile: string | null): string {
  const existingSection = existingProfile === null ? '' : `\n## 已有记忆（不要重复提取这些事实）
${Array.from(existingProfile).slice(0, 800).join('')}

`;
  return `你是一个用户记忆提取器。从以下对话中提取两类信息：关于**用户本人**的原子事实（facts）与本轮对话中的**活动流水**（activities）。

## facts 提取规则
1. 每条记忆是关于用户的一个简短陈述句（≤50字）
2. 只提取关于**用户本人**的事实，不提取通用知识
3. 提取的类型：身份背景、学习状态、个人偏好、时间约束、目标计划、项目/环境事实、工具与工作习惯
4. **绝对禁止**提取：学科知识、题目内容、解题过程、文档摘要、通用技术知识（如"Python 支持 f-string"这类与用户无关的事实）
5. 判断标准：这条信息换一个用户还成立吗？如果是，就不要提取
6. 最多提取 5 条，宁缺毋滥
7. **跳过已有记忆中已记录的事实**——只提取新增或更新的信息
8. 如果对话中没有关于用户的新事实，facts 返回空数组

## activities 提取规则
1. 每条概括本轮对话中一件"今天做了什么"的学习/工作任务活动（≤80字），
   如"做了 5 道二次函数题，错 2 道，均为符号错误"、"修复了鉴权模块的 token 刷新 bug"
2. 只记录有实质产出的活动（做题、复习、批改、背诵、制卡、编码、调试、评审、部署等）；
   闲聊/问答咨询不算活动
3. 最多提取 5 条；没有实质活动时 activities 返回空数组
${existingSection}
## 对话内容

用户: ${userContent}

助手: ${assistantContent}

## facts 分类指引
- "偏好"：格式偏好、风格偏好、学习方式偏好
- "偏好/个人背景"：年级、学校、专业、身份信息
- "偏好/工作环境"：机器与系统环境、工具链、项目技术栈与工程约定
- "经历/学科状态"：强项弱项、成绩、学习进度
- "经历/时间节点"：考试日期、截止日期、计划时间
- "经历"：重要经历、计划、目标
- "经历/项目"：项目进展、里程碑、发布记录
- 如果以上分类不合适，可以使用新的分类路径

## 输出格式（严格 JSON 对象）
{
  "facts": [
    {"title": "关键词概括", "content": "一个简短陈述句", "folder": "分类路径"}
  ],
  "activities": [
    "学习/工作活动概括一句话"
  ]
}

没有可提取的内容时对应数组输出 []。请直接输出 JSON，不要添加其他内容。`;
}

/** Rust `extract_candidates_and_activities` short-circuit: both sides under 4 chars. */
export function shouldSkipExtraction(userContent: string, assistantContent: string): boolean {
  return Array.from(userContent).length < 4 && Array.from(assistantContent).length < 4;
}
