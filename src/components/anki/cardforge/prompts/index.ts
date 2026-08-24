/**
 * CardForge 2.0 - PromptKit 提示词模板
 *
 * 仅保留仍接在真实调用路径上的提示词：
 * - `buildCardGenerationSystemPrompt`：制卡 system prompt，经
 *   options.custom_anki_prompt 传给后端，作为 system 消息基础层
 *   （generateCards / startGeneration → start_enhanced_document_processing）
 * - `buildContentAnalysisPrompt`：CardAgent.analyzeContent 的 LLM 内容预分析
 *
 * 已删除的死 prompt（均无任何调用方）：
 * - buildBoundaryPrompt：前端 LLM 定界已删除（定界由后端生成管线执行）
 * - buildCardGenerationUserPrompt：user 消息由后端注入学习材料，前端从不组装
 * - buildErrorRepairPrompt / buildQualityAssessmentPrompt：修复/质量评估
 *   流程从未接线
 */

import type { TemplateInfo } from '../types';

// ============================================================================
// 流式输出标记协议（END-only）
// ============================================================================

/**
 * 卡片 JSON 结束标记（唯一分隔符）
 *
 * 协议为 END-only：每张卡片输出完整 JSON 后紧跟一行结束标记。
 * 后端流式解析器（streaming_anki_service::extract_card_from_buffer）
 * 只识别此结束标记，历史上的 START 标记从未被解析，已删除。
 */
export const CARD_JSON_END = '<<<ANKI_CARD_JSON_END>>>';

// ============================================================================
// 制卡 Prompt 模板
// ============================================================================

/**
 * 生成制卡系统 Prompt
 *
 * 语义约定（与后端 streaming_anki_service::build_prompt 对齐）：
 * 此 prompt 是 LLM 的 system 消息基础层（角色设定 + 输出协议），
 * 在 start_enhanced_document_processing 路径应通过 options.custom_anki_prompt
 * 传给后端（custom_anki_prompt 是后端 system 消息的 base prompt）。
 * 学习材料由后端注入 user 消息，此层绝不包含材料或占位符。
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

【语言规则】
- 卡片内容（front/back/text/tags）的语言必须与学习材料保持一致：英文材料生成英文卡片，中文材料生成中文卡片，其他语言同理
- 专业术语可保留原文，不要把材料语言翻译成本提示词的语言

【输出格式协议】
每张卡片输出一个完整的 JSON，随后紧跟一行结束标记：
{JSON内容}
${CARD_JSON_END}

结束标记独占一行；包括最后一张卡片之后也必须输出结束标记。
这样设计是为了支持流式解析，每生成一张卡片就立即输出。

【JSON 硬性规则（违反将导致卡片解析失败）】
1. 结束标记必须独占一行；相邻两个结束标记之间只放一张卡片的 JSON
2. JSON 必须是合法的严格 JSON：键和字符串一律用双引号；禁止尾逗号、注释、单引号
3. 字符串内的换行必须写成 \\n，双引号必须写成 \\"；不要输出未转义的控制字符
4. 不要用 markdown 代码围栏（\`\`\`）包裹 JSON，除 JSON 和结束标记外不要输出任何解释性文字
5. tags 必须是字符串数组（如 ["数学", "定义"]），不能是逗号分隔的字符串
6. 数值字段（如 confidence）直接写数字，不要加引号
7. 若某张卡片生成到一半发现内容不完整，宁可整张放弃，也不要输出残缺 JSON`;
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
// 导出
// ============================================================================

export const PromptKit = {
  // 标记（END-only 协议，唯一分隔符）
  CARD_JSON_END,

  // 制卡（system 层，经 custom_anki_prompt 送入后端）
  buildCardGenerationSystemPrompt,

  // 分析（analyzeContent）
  buildContentAnalysisPrompt,
};

export default PromptKit;
