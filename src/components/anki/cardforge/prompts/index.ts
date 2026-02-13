/**
 * CardForge 2.0 - PromptKit 提示词模板
 *
 * 提示词是系统的核心资产，这里管理所有用于 Anki 制卡的提示词模板。
 *
 * 模板结构：
 * - 系统指令层 (System Layer): 角色设定、能力边界、输出约束
 * - 上下文层 (Context Layer): 可用模板列表、当前分段信息、用户偏好
 * - 内容层 (Content Layer): 原始学习材料
 * - 格式层 (Format Layer): 输出格式要求、JSON Schema、示例
 */

import type { TemplateInfo } from '../types';

// ============================================================================
// 流式输出标记协议
// ============================================================================

/** 卡片 JSON 开始标记 */
export const CARD_JSON_START = '<<<ANKI_CARD_JSON_START>>>';

/** 卡片 JSON 结束标记 */
export const CARD_JSON_END = '<<<ANKI_CARD_JSON_END>>>';

// ============================================================================
// 定界 Prompt 模板
// ============================================================================

/**
 * 生成定界 Prompt
 *
 * 用于在硬分割点附近找到最佳语义边界
 */
export function buildBoundaryPrompt(
  beforeContext: string,
  afterContext: string,
  boundaryContext: number = 1000
): string {
  return `你是文档分段专家。你的任务是在给定的文本分割点附近找到最佳的语义边界。

【当前分割点上下文】

==== 分割点之前的内容 ====
${beforeContext}
==== [分割点] ====
${afterContext}
==== 分割点之后的内容 ====

【任务】
分析上述文本，在分割点附近找到最佳的语义边界。

【优先级】
1. 章节/标题边界（如 "## 章节标题"、"第一章"等）
2. 段落边界（空行分隔）
3. 句子边界（句号、问号、感叹号）
4. 词边界（空格、标点）

【输出格式】
请以 JSON 格式输出，包含以下字段：
{
  "offset": <数字，相对于原始分割点的偏移量，正数表示向后移动，负数表示向前移动，范围 -${boundaryContext} 到 +${boundaryContext}>,
  "reason": "<字符串，说明为什么选择这个位置>",
  "confidence": <数字，0-1 之间，表示你对这个边界选择的信心程度>
}

【示例】
如果在分割点之前 50 个字符处有一个章节标题，应该输出：
{
  "offset": -50,
  "reason": "章节标题边界：'## 第二章'",
  "confidence": 0.95
}

如果分割点正好在段落边界，应该输出：
{
  "offset": 0,
  "reason": "段落边界（空行）",
  "confidence": 0.9
}

请直接输出 JSON，不要包含任何其他文字。`;
}

// ============================================================================
// 制卡 Prompt 模板
// ============================================================================

/**
 * 生成制卡系统 Prompt
 */
export function buildCardGenerationSystemPrompt(): string {
  return `你是一位专业的 Anki 记忆卡片制作专家。你的任务是将学习材料转化为高质量的记忆卡片。

【你的能力】
- 识别知识点并选择最合适的卡片模板
- 生成清晰、准确、易于记忆的卡片内容
- 确保卡片遵循最小信息原则
- 支持多种卡片类型：基础问答、填空、代码理解等

【你的限制】
- 只输出 Anki 卡片，不做其他事情
- 必须使用指定的输出格式
- 不要添加与学习内容无关的信息

【输出格式协议】
每张卡片必须包裹在特殊标记中：
${CARD_JSON_START}
{JSON内容}
${CARD_JSON_END}

这样设计是为了支持流式解析，每生成一张卡片就立即输出。`;
}

/**
 * 生成制卡用户 Prompt
 *
 * @param content 学习材料内容
 * @param templates 可用模板列表
 * @param segmentInfo 分段信息
 * @param options 额外选项
 */
export function buildCardGenerationUserPrompt(
  content: string,
  templates: TemplateInfo[],
  segmentInfo?: {
    index: number;
    total: number;
  },
  options?: {
    maxCards?: number;
    customRequirements?: string;
    preferredTemplates?: string[];
  }
): string {
  // 构建模板描述
  const templateDescriptions = templates
    .map((t) => {
      const fields = t.fields.join(', ');
      return `- ${t.id}: ${t.name}
  描述: ${t.description || '通用模板'}
  字段: [${fields}]
  适用: ${t.useCaseDescription || t.description || '各类知识点'}`;
    })
    .join('\n');

  // 构建分段信息
  const segmentText = segmentInfo
    ? `当前处理第 ${segmentInfo.index + 1}/${segmentInfo.total} 段内容。`
    : '';

  // 构建额外要求
  const extraRequirements = options?.customRequirements
    ? `\n【用户额外要求】\n${options.customRequirements}`
    : '';

  // 构建卡片数量限制
  const cardLimitText = options?.maxCards
    ? `\n注意：本段最多生成 ${options.maxCards} 张卡片，请选择最重要的知识点。`
    : '';

  // 构建首选模板提示
  const preferredTemplateText =
    options?.preferredTemplates && options.preferredTemplates.length > 0
      ? `\n用户偏好的模板: ${options.preferredTemplates.join(', ')}（如果内容适合，优先使用这些模板）`
      : '';

  return `【可用模板】
${templateDescriptions}

【学习材料】
${segmentText}

${content}

【任务】
请分析上述学习材料中的每个知识点，为每个知识点：
1. 选择最合适的模板（根据知识点类型灵活选择，同一段内容可以使用多种模板）
2. 按模板字段生成卡片内容
3. 确保 front（问题）清晰明确
4. 确保 back（答案）准确完整
5. 添加适当的标签（tags）便于分类
${cardLimitText}
${preferredTemplateText}
${extraRequirements}

【输出格式】
对于每张卡片，请输出：

${CARD_JSON_START}
{
  "template_id": "选择的模板ID",
  "front": "问题/概念",
  "back": "答案/解释",
  "text": "填空内容（仅 Cloze 模板需要，使用 {{c1::answer}} 格式）",
  "tags": ["标签1", "标签2"],
  "fields": {
    "字段1": "值1",
    "字段2": "值2"
  },
  "confidence": 0.95
}
${CARD_JSON_END}

【最佳实践】
- 每个知识点一张卡片，避免内容过长
- 问题要具体，避免模糊的提问
- 答案要简洁，但包含关键信息
- 代码类内容注意语法高亮格式
- 公式使用 LaTeX 格式（$...$）

请开始生成卡片：`;
}

// ============================================================================
// 内容分析 Prompt 模板
// ============================================================================

/**
 * 生成内容分析 Prompt
 *
 * 用于预分析学习材料，估算卡片数量和推荐模板
 */
export function buildContentAnalysisPrompt(
  content: string,
  templates: TemplateInfo[]
): string {
  const templateList = templates.map((t) => `- ${t.id}: ${t.name}`).join('\n');

  return `你是一位学习材料分析专家。请分析以下内容并给出制卡建议。

【可用模板】
${templateList}

【待分析内容】
${content.slice(0, 10000)}${content.length > 10000 ? '\n... (内容已截断)' : ''}

【分析任务】
1. 识别内容中的主要知识点类型
2. 估算可以生成的卡片数量
3. 推荐最适合的模板

【输出格式】
请以 JSON 格式输出：
{
  "content_types": ["类型1", "类型2"],
  "estimated_cards": <预估卡片数>,
  "suggested_templates": [
    {
      "template_id": "模板ID",
      "reason": "推荐原因",
      "estimated_usage": <预估使用百分比>
    }
  ],
  "difficulty_level": "easy|medium|hard",
  "summary": "内容摘要（50字以内）"
}

请直接输出 JSON，不要包含其他文字。`;
}

// ============================================================================
// 错误修复 Prompt 模板
// ============================================================================

/**
 * 生成错误修复 Prompt
 *
 * 用于修复截断或格式错误的卡片
 */
export function buildErrorRepairPrompt(
  errorContent: string,
  templateInfo?: TemplateInfo
): string {
  const templateHint = templateInfo
    ? `原始使用的模板: ${templateInfo.name} (${templateInfo.id})
字段: ${templateInfo.fields.join(', ')}`
    : '（原始模板信息未知）';

  return `你是 Anki 卡片修复专家。以下卡片内容在生成过程中被截断或出现格式错误，请帮助修复。

【原始内容（可能不完整）】
${errorContent}

【模板信息】
${templateHint}

【任务】
1. 理解原始内容要表达的知识点
2. 补全缺失的部分（如果有）
3. 修复格式错误
4. 输出完整、正确的卡片

【输出格式】
${CARD_JSON_START}
{
  "template_id": "模板ID",
  "front": "完整的问题",
  "back": "完整的答案",
  "tags": ["repaired", "原有标签"],
  "fields": {
    "字段": "值"
  },
  "repair_note": "修复说明（简短描述做了什么修复）"
}
${CARD_JSON_END}

请修复并输出完整卡片：`;
}

// ============================================================================
// 质量评估 Prompt 模板
// ============================================================================

/**
 * 生成质量评估 Prompt
 *
 * 用于评估生成的卡片质量
 */
export function buildQualityAssessmentPrompt(
  cards: Array<{
    front: string;
    back: string;
    template_id?: string;
  }>
): string {
  const cardsText = cards
    .map(
      (card, idx) => `卡片 ${idx + 1}:
  问题: ${card.front}
  答案: ${card.back}
  模板: ${card.template_id || '未知'}`
    )
    .join('\n\n');

  return `你是 Anki 卡片质量评估专家。请评估以下卡片的质量。

【待评估卡片】
${cardsText}

【评估标准】
1. 清晰度：问题是否明确，答案是否直接
2. 准确性：内容是否正确，无歧义
3. 最小信息原则：是否遵循一个知识点一张卡的原则
4. 可记忆性：是否易于记忆和复习
5. 格式规范：是否符合 Anki 最佳实践

【输出格式】
{
  "overall_score": <1-10分>,
  "cards": [
    {
      "index": 1,
      "score": <1-10分>,
      "issues": ["问题1", "问题2"],
      "suggestions": ["建议1", "建议2"]
    }
  ],
  "summary": "总体评价"
}

请评估并输出 JSON：`;
}

// ============================================================================
// 导出
// ============================================================================

export const PromptKit = {
  // 标记
  CARD_JSON_START,
  CARD_JSON_END,

  // 定界
  buildBoundaryPrompt,

  // 制卡
  buildCardGenerationSystemPrompt,
  buildCardGenerationUserPrompt,

  // 分析
  buildContentAnalysisPrompt,

  // 修复
  buildErrorRepairPrompt,

  // 评估
  buildQualityAssessmentPrompt,
};

export default PromptKit;
