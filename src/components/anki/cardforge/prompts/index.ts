/**
 * CardForge 2.0 - PromptKit 提示词模板
 *
 * 仅保留仍接在真实调用路径上的提示词：
 * - `buildCardGenerationSystemPrompt`：制卡 system prompt，经
 *   options.custom_anki_prompt 传给后端，作为 system 消息基础层
 *   （generateCards / startGeneration → start_enhanced_document_processing）
 * - `buildContentAnalysisPrompt`：CardAgent.analyzeContent 的 LLM 内容预分析
 *
 * ## 输出协议单点原则（0824 评审 #2）
 * 流式输出协议（END 分隔符 vs 结构化 `{"cards":[...]}` wrapper）由后端
 * 单点决策并生成指令（anki_protocol::resolve_output_protocol +
 * format_instructions）。本模块的 prompt 必须协议中立：绝不包含 END 标记、
 * wrapper 格式或任何分隔符规则，否则后端自动选择 json_schema 时，
 * system 消息（CardAgent prompt）与 user 消息（后端协议指令）会互相矛盾。
 * 与该原则对应的跨层契约 fixture：
 * `src-tauri/tests/fixtures/cardagent_system_prompt.txt`
 * （Rust 侧 streaming_anki_service 用它组装完整请求消息做协议冲突断言，
 * TS 侧 prompts.test.ts 断言本函数输出与 fixture 逐字一致）。
 *
 * 已删除的死 prompt（均无任何调用方）：
 * - buildBoundaryPrompt：前端 LLM 定界已删除（定界由后端生成管线执行）
 * - buildCardGenerationUserPrompt：user 消息由后端注入学习材料，前端从不组装
 * - buildErrorRepairPrompt / buildQualityAssessmentPrompt：修复/质量评估
 *   流程从未接线
 * - CARD_JSON_END 常量：输出协议归后端单点生成后，前端不再持有协议标记
 *   （后端唯一定义：anki_protocol::CARD_DELIMITER）
 */

import type { TemplateInfo } from '../types';

// ============================================================================
// 制卡 Prompt 模板
// ============================================================================

/**
 * 生成制卡系统 Prompt（协议中立）
 *
 * 语义约定（与后端 streaming_anki_service::build_prompt 对齐）：
 * 此 prompt 是 LLM 的 system 消息基础层（角色设定 + 内容质量要求），
 * 在 start_enhanced_document_processing 路径应通过 options.custom_anki_prompt
 * 传给后端（custom_anki_prompt 是后端 system 消息的 base prompt）。
 * 学习材料由后端注入 user 消息，此层绝不包含材料或占位符；
 * 输出格式协议由后端按供应商能力单点生成，此层绝不包含协议规则。
 *
 * 修改本函数输出时必须同步更新跨层契约 fixture：
 * `src-tauri/tests/fixtures/cardagent_system_prompt.txt`
 */
export function buildCardGenerationSystemPrompt(): string {
  return `你是一位专业的 Anki 记忆卡片制作专家。你的任务是将学习材料转化为高质量的记忆卡片。

【你的能力】
- 识别知识点并选择最合适的卡片模板
- 生成清晰、准确、易于记忆的卡片内容
- 确保卡片遵循最小信息原则
- 支持多种卡片类型：基础问答、填空、代码理解等

【你的限制】
- 只输出 Anki 卡片数据，不做其他事情
- 输出的组织方式（如何分隔或包装每张卡片）以请求中的「重要指令」为准，本段不另行约定任何输出格式
- 不要添加与学习内容无关的信息

【语言规则】
- 卡片内容（front/back/text/tags）的语言必须与学习材料保持一致：英文材料生成英文卡片，中文材料生成中文卡片，其他语言同理
- 专业术语可保留原文，不要把材料语言翻译成本提示词的语言

【卡片 JSON 内容规则（与输出组织方式无关，始终适用）】
1. 每张卡片的 JSON 必须是合法的严格 JSON：键和字符串一律用双引号；禁止尾逗号、注释、单引号
2. 字符串内的换行必须写成 \\n，双引号必须写成 \\"；不要输出未转义的控制字符
3. tags 必须是字符串数组（如 ["数学", "定义"]），不能是逗号分隔的字符串
4. 数值字段（如 confidence）直接写数字，不要加引号
5. 若某张卡片生成到一半发现内容不完整，宁可整张放弃，也不要输出残缺 JSON`;
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
  // 制卡（system 层，经 custom_anki_prompt 送入后端；协议中立）
  buildCardGenerationSystemPrompt,

  // 分析（analyzeContent）
  buildContentAnalysisPrompt,
};

export default PromptKit;
