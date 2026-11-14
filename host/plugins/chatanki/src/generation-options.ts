// Rust: chatanki_executor.rs:10870–11355 generation requirements, glossary heuristics,
// generation options and media-source pinning.
import type {
  AnkiGenerationOptions, CustomAnkiTemplate, FieldExtractionRule,
} from '../api.ts';
import { MEDIA_CARD_REQUIREMENTS, mediaCitationSecondsFor } from '../../review/api.ts';
import { ensureFieldExtractionRules, normalizeTemplateFields } from './template-fields.ts';
import { rustTrim } from '../../../platform/util/text.ts';
import { utf8ByteLength } from '../../../platform/util/utf8.ts';

// ============================================================================
// Requirements / generation options (chatanki_executor.rs:10960–11355)
// ============================================================================

const CHATANKI_REQUIREMENTS_BASE = '学习目标：{goal}\n规则：\n'
  + '- 每张卡只测试一个知识点（最小信息原则），避免“一卡多问”。\n'
  + '- 若内容是“术语/名词解释/概念清单”形式：默认 **每条条目生成 1 张卡**（front=术语/问题，back=解释），不要遗漏，也不要把一条条目拆成多张（除非该条非常长且确有必要）。\n'
  + '- 优先覆盖内容中的所有条目/小点（尤其是名词解释/术语列表），不要遗漏。\n'
  + '- 正面问题要清晰可回忆；背面答案要简洁但不丢关键限定条件。\n'
  + '- tags 给 0~3 个关键词（可为空数组）。';

/** 偏好记忆位于补充要求之前：hint 自带「冲突以本次要求为准」，显式要求在其后覆盖。 */
export function buildChatankiRequirements(
  goal: string, extraRequirements: string | null, preferenceHint: string | null,
): string {
  let requirements = CHATANKI_REQUIREMENTS_BASE.replace('{goal}', goal);
  const hint = (preferenceHint == null ? undefined : rustTrim(preferenceHint));
  if (hint) requirements += `\n${hint}`;
  const extra = (extraRequirements == null ? undefined : rustTrim(extraRequirements));
  if (extra) requirements += `\n补充要求（调用方指定，优先遵守）：\n${extra}`;
  return requirements;
}

export interface GlossaryGenerationKnobs {
  temperature: number;
  maxOutputTokensOverride: number | null;
  segmentOverlapSize: number;
}

export function glossaryGenerationKnobs(glossaryMode: boolean): GlossaryGenerationKnobs {
  return glossaryMode
    ? { temperature: 0.2, maxOutputTokensOverride: 2400, segmentOverlapSize: 0 }
    : { temperature: 0.3, maxOutputTokensOverride: null, segmentOverlapSize: 200 };
}

export function defaultMaxCardsForContent(glossaryMode: boolean, charCount: number): number {
  if (glossaryMode) return 0;
  if (charCount < 500) return 10;
  if (charCount < 2000) return 30;
  return 80;
}

export function suggestMaxCardsArg(
  glossaryMode: boolean, entryLikeLines: number, charCount: number,
): number {
  if (glossaryMode) {
    const margin = Math.max(Math.floor(entryLikeLines / 10), 2);
    return Math.max(Math.min(entryLikeLines + margin, 100), 1);
  }
  return Math.min(Math.max(defaultMaxCardsForContent(false, charCount), 1), 100);
}

export interface ChatAnkiGenerationTuning {
  outputProtocol: string | null;
  visualHint: string | null;
  contentFormat: 'auto' | 'glossary' | 'prose';
  enableQaPass: boolean | null;
  enableCriticPass: boolean | null;
  enableFsrsFeedback: boolean | null;
  maxImages: number | null;
  enablePreferenceMemory: boolean | null;
}

export function defaultGenerationTuning(): ChatAnkiGenerationTuning {
  return {
    outputProtocol: null, visualHint: null, contentFormat: 'auto', enableQaPass: null,
    enableCriticPass: null, enableFsrsFeedback: null, maxImages: null,
    enablePreferenceMemory: null,
  };
}

/**
 * `build_generation_options`：词表启发式 + 单模板字段契约 + 偏好/附加要求。
 * 多模板与媒体来源另行注入（需要 DB/LLM 的路径不在本模块）。
 */
export function buildGenerationOptions(
  goal: string,
  deckName: string,
  noteType: string,
  contentText: string,
  template: CustomAnkiTemplate | null,
  maxCardsOverride: number | null,
  extraRequirements: string | null,
  tuning: ChatAnkiGenerationTuning,
  preferenceHint: string | null,
): AnkiGenerationOptions {
  const glossaryMode = tuning.contentFormat === 'glossary' ? true
    : tuning.contentFormat === 'prose' ? false
      : looksLikeGlossaryContent(contentText);
  const knobs = glossaryGenerationKnobs(glossaryMode);
  let templateId: string | null = null;
  let customPrompt: string | null = null;
  let templateFields: string[];
  let rules: Record<string, FieldExtractionRule>;
  if (template !== null) {
    templateFields = normalizeTemplateFields(template.fields);
    rules = ensureFieldExtractionRules(templateFields, template.field_extraction_rules);
    customPrompt = rustTrim(template.generation_prompt).length === 0 ? null : template.generation_prompt;
    templateId = template.id;
  } else {
    templateFields = ['front', 'back', 'tags'];
    rules = ensureFieldExtractionRules(templateFields, {});
  }
  return {
    source_ref: null,
    deck_name: deckName,
    note_type: noteType,
    enable_images: false,
    max_cards_per_mistake: maxCardsOverride ?? defaultMaxCardsForContent(glossaryMode, [...contentText].length),
    max_cards_total: maxCardsOverride,
    max_tokens: null,
    temperature: knobs.temperature,
    max_output_tokens_override: knobs.maxOutputTokensOverride,
    temperature_override: null,
    template_id: templateId,
    custom_anki_prompt: customPrompt,
    template_fields: templateFields,
    field_extraction_rules: rules,
    template_fields_by_id: null,
    field_extraction_rules_by_id: null,
    custom_requirements: buildChatankiRequirements(goal, extraRequirements, preferenceHint),
    segment_overlap_size: knobs.segmentOverlapSize,
    system_prompt: null,
    template_ids: null,
    template_descriptions: null,
    enable_llm_boundary_detection: true,
    fsrs_feedback: tuning.enableFsrsFeedback,
    user_review_profile: null,
    output_protocol: tuning.outputProtocol,
    enable_qa_pass: tuning.enableQaPass,
    enable_critic_pass: tuning.enableCriticPass,
    enable_llm_critic: null,
    critic_token_budget: null,
    sidekick_model_routing: null,
  };
}

/** dstu_anki::anki_protocol::is_multi_template 的最小判定（本模块只产出单模板）。 */
export function isMultiTemplate(options: AnkiGenerationOptions): boolean {
  return (options.template_ids?.length ?? 0) > 1
    || options.template_fields_by_id !== null && options.template_fields_by_id !== undefined;
}

const MEDIA_ANCHOR_ID_RE = /\[媒体@([^\s\]:]+):/gu;

/** L15 `first_media_citation` 的 id 侧；时间合法性仍由 L15 的解析器判定。 */
export function firstMediaCitationId(text: string): string | null {
  for (const match of text.matchAll(MEDIA_ANCHOR_ID_RE)) {
    const id = match[1];
    if (id !== undefined && mediaCitationSecondsFor(text, id) !== null) return id;
  }
  return null;
}

/**
 * chatanki_executor.rs:11302–11329: media transcript content appends the
 * course-source requirements and pins the generation source to the media file.
 */
export function applyMediaSourceRequirements(
  options: AnkiGenerationOptions,
  contentText: string,
  mediaFileName: ((mediaId: string) => string | null) | null,
): void {
  const mediaId = firstMediaCitationId(contentText);
  if (mediaId === null) return;
  const requirements = options.custom_requirements ?? '';
  options.custom_requirements = rustTrim(requirements).length === 0
    ? MEDIA_CARD_REQUIREMENTS
    : `${requirements}\n${MEDIA_CARD_REQUIREMENTS}`;
  if (options.source_ref === null || options.source_ref === undefined) {
    const title = mediaFileName === null ? null : mediaFileName(mediaId);
    options.source_ref = { kind: 'resource', id: mediaId, title };
  }
}

// ============================================================================
// Glossary heuristics (chatanki_executor.rs:10870–10990)
// ============================================================================

export function isGlossaryEntryStart(line: string): boolean {
  const trimmed = rustTrim(line);
  if (trimmed.length === 0) return false;
  if (trimmed.includes('：') || trimmed.includes(':')) return true;
  if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) return true;
  return utf8ByteLength(trimmed) >= 3 && /^[0-9]/.test(trimmed);
}

export function countEntryLikeLines(text: string): number {
  return text.split('\n').filter((line) => isGlossaryEntryStart(line)).length;
}

export function looksLikeGlossaryContent(text: string): boolean {
  const nonEmpty = text.split('\n').filter((line) => rustTrim(line).length > 0).length;
  if (nonEmpty < 40) return false;
  return countEntryLikeLines(text) / nonEmpty >= 0.45;
}
