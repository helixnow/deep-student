/**
 * 提示词构建（`build_prompt`）。
 */
import type { AnkiGenerationOptions } from '../../../../contracts/ipc/generated/L16-anki.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { formatInstructions, isMultiTemplate, type OutputProtocol } from './anki-protocol.ts';
import { stripOcclusionDraftMarkers } from './image-occlusion.ts';
import { describePromptField, findRule } from './streaming-anki-fields.ts';
import { LATEX_RULES } from './streaming-anki-protocol.ts';

// ============================================================================
// 提示词构建（`build_prompt`）
// ============================================================================

export interface PromptPayload {
  system: string | null;
  user: string;
  debug_preview: string;
}

const DEFAULT_ANKI_PROMPT =
  '你是一个专业的 Anki 学习卡片制作助手。请根据提供的学习内容，生成高质量的 Anki 学习卡片。\n\n要求：\n1. 卡片应该有助于记忆和理解\n2. 问题要简洁明确\n3. 答案要准确完整\n4. 适当添加相关标签\n5. 确保卡片的逻辑性和实用性\n6. 卡片内容语言必须与学习材料一致：英文材料生成英文卡片，中文材料生成中文卡片，不要翻译';

function resolveByIdOrSingle<T>(
  byId: Readonly<Record<string, T>> | null | undefined,
  templateId: string | null | undefined,
): T | undefined {
  if (byId === null || byId === undefined) return undefined;
  if (templateId !== null && templateId !== undefined) return byId[templateId];
  const values = Object.values(byId);
  return values.length === 1 ? values[0] : undefined;
}

export function buildPrompt(
  content: string,
  options: AnkiGenerationOptions,
  protocol: OutputProtocol,
): PromptPayload {
  const customPrompt = options.custom_anki_prompt !== null && options.custom_anki_prompt !== undefined
    ? rustTrim(options.custom_anki_prompt)
    : '';
  const basePrompt = customPrompt !== ''
    ? `${DEFAULT_ANKI_PROMPT}\n\n模板生成说明（模板作者提供，在遵守上述通用要求的前提下执行）：\n${customPrompt}`
    : DEFAULT_ANKI_PROMPT;

  const systemSections: string[] = [];

  if (options.custom_requirements !== null && options.custom_requirements !== undefined) {
    const trimmed = rustTrim(options.custom_requirements);
    if (trimmed !== '') {
      systemSections.push(
        `🚨🚨 强制遵守的制卡要求（优先级最高） 🚨🚨\n<<CUSTOM_REQUIREMENTS>>\n${trimmed}\n<<END_CUSTOM_REQUIREMENTS>>`,
      );
    }
  }

  systemSections.push(LATEX_RULES);
  systemSections.push(basePrompt);

  const descriptions = options.template_descriptions;
  if (descriptions !== null && descriptions !== undefined && descriptions.length > 0) {
    let templateInfo = '\n可用模板列表（请根据内容特征自动选择最合适的模板）：\n\n';
    descriptions.forEach((tmpl, idx) => {
      templateInfo += `${idx + 1}. 模板ID: ${tmpl.id}\n   名称: ${tmpl.name}\n   描述: ${tmpl.description}\n   必需字段: ${tmpl.fields.join(', ')}\n`;
      if (tmpl.generation_prompt !== null && tmpl.generation_prompt !== undefined) {
        templateInfo += `   字段格式说明: ${tmpl.generation_prompt}\n`;
      }
      templateInfo += '\n';
    });
    templateInfo +=
      '🚨 重要规则：\n' +
      '- 选择模板后，必须严格按照该模板的「必需字段」生成 JSON\n' +
      '- 字段名称必须与模板定义完全一致（区分大小写）\n' +
      '- 每个卡片JSON中必须包含 "template_id" 字段标识使用的模板\n' +
      '- template_id 只能填写模板ID，绝不能填写模板名称\n' +
      '- 不要使用 front/back 等通用字段，除非模板明确要求\n' +
      '- 字段内容不要包含 [PDF@…]、[知识库-N] 等对话引用标记；需要出处时写资料名与页码文字\n\n';
    const whitelist: string[] = [];
    const idNamePairs: string[] = [];
    for (const tmpl of descriptions) {
      whitelist.push(`"${tmpl.id}"`);
      idNamePairs.push(`${tmpl.name} => ${tmpl.id}`);
    }
    templateInfo += 'template_id 白名单（只能从下列值中选择）：\n';
    templateInfo += `[${whitelist.join(', ')}]\n`;
    templateInfo += '名称到ID映射（若你想用某模板“名称”，必须写成对应ID）：\n';
    templateInfo += `${idNamePairs.join('\n')}\n`;
    systemSections.push(templateInfo);
  } else if (options.template_ids !== null && options.template_ids !== undefined && options.template_ids.length > 0) {
    systemSections.push(
      `\n可用模板ID列表: ${options.template_ids.join(', ')}\n` +
        '请在生成卡片时选择合适的模板ID（在JSON中添加 "template_id" 字段）\n',
    );
  }

  if (options.system_prompt !== null && options.system_prompt !== undefined) {
    const trimmed = rustTrim(options.system_prompt);
    if (trimmed !== '') systemSections.push(`用户补充要求：\n${trimmed}`);
  }

  const systemMessage = systemSections.join('\n\n');
  const multiTemplate = isMultiTemplate(options);

  let templateFields: string[] | null;
  if (multiTemplate) {
    templateFields = null;
  } else {
    const resolved =
      options.template_fields ??
      resolveByIdOrSingle(options.template_fields_by_id, options.template_id);
    templateFields = resolved ?? ['front', 'back', 'tags'];
  }

  let fieldsRequirement: string;
  let exampleJson: string;
  if (multiTemplate) {
    fieldsRequirement = 'template_id（字符串）+ 所选模板的必需字段（见上方模板列表）';
    exampleJson = `{"${'template-id'}": "<template-id>", "<field-name>": "<value>"}`;
  } else if (templateFields !== null) {
    const resolvedPromptRules =
      options.field_extraction_rules ??
      resolveByIdOrSingle(options.field_extraction_rules_by_id, options.template_id);
    fieldsRequirement = templateFields
      .map((field) => describePromptField(field, findRule(resolvedPromptRules, field)))
      .join('、');

    const exampleFields: string[] = [];
    for (const field of templateFields) {
      switch (field) {
        case 'front':
          exampleFields.push('"front": "<question>"');
          break;
        case 'back':
          exampleFields.push('"back": "<answer>"');
          break;
        case 'tags':
          exampleFields.push('"tags": ["<tag-1>", "<tag-2>"]');
          break;
        case 'example':
          exampleFields.push('"example": "<example>"');
          break;
        case 'source':
          exampleFields.push('"source": "<source>"');
          break;
        case 'code':
          exampleFields.push('"code": "<code>"');
          break;
        case 'notes':
          exampleFields.push('"notes": "<notes>"');
          break;
        default:
          exampleFields.push(`"${field}": "<${field}>"`);
      }
    }
    exampleJson = `{${exampleFields.join(', ')}}`;
  } else {
    fieldsRequirement = 'front/back/tags（默认字段）';
    exampleJson = '{"front": "<question>", "back": "<answer>", "tags": ["<tag>"]}';
  }

  const cardCountInstruction =
    options.max_cards_per_mistake > 0
      ? `🚨 卡片数量上限 🚨\n本次最多生成 ${options.max_cards_per_mistake} 张卡片，超过上限的输出会被丢弃。\n- 数量由内容的知识点密度决定：知识点少就少生成，不要为凑数而拆分或编造\n- 优先覆盖内容中最重要的知识点，确保每张卡片高质量\n- 生成到第 ${options.max_cards_per_mistake} 张后必须立即停止，不要再输出任何卡片\n\n`
      : '根据内容的信息密度生成适量的高质量卡片，充分覆盖所有知识点。\n\n';

  const generationInstructions = formatInstructions(protocol, cardCountInstruction, fieldsRequirement, exampleJson);
  const modelVisibleContent = stripOcclusionDraftMarkers(content);
  const userMessage = `${generationInstructions}\n\n请根据以下内容生成Anki卡片：\n\n${modelVisibleContent}`;

  return {
    system: rustTrim(systemMessage) === '' ? null : systemMessage,
    user: userMessage,
    debug_preview: `[SYSTEM]\n${systemMessage}\n\n[USER]\n${userMessage}`,
  };
}
