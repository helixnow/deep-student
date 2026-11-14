// Rust: chatanki_executor.rs:8895–9065, 10733–10745, 11431–11672 template selection,
// list projection and field-limit soft checks.
import type {
  AnkiCard, CustomAnkiTemplate, FieldExtractionRule, TemplateDatabase,
} from '../api.ts';
import { errorText } from './execution.ts';
import {
  calculateComplexityLevel, ensureFieldExtractionRules, normalizeTemplateFields,
} from './template-fields.ts';
import { rustTrim } from '../../../platform/util/text.ts';
import { compareUtf8 } from '../../../platform/util/utf8.ts';

// ============================================================================
// Template selection (chatanki_executor.rs:8895–9065, 10733–10745)
// ============================================================================

export type ChatAnkiTemplateMode = 'single' | 'multiple' | 'all';

export interface TemplateSelection {
  templateId: string | null;
  templateIds: string[] | null;
}

export const BUILTIN_FALLBACK_TEMPLATE_IDS: readonly string[] = ['design-footnote', 'design-monograph'];

export function resolveSingleTemplateId(templateId: string | null | undefined): string | null {
  if (templateId === null || templateId === undefined) return null;
  const trimmed = rustTrim(templateId);
  return trimmed.length === 0 ? null : trimmed;
}

export function effectiveSingleTemplateId(
  templateId: string | null | undefined, templateIds: readonly string[] | null | undefined,
): string | null {
  const single = resolveSingleTemplateId(templateId);
  if (single !== null) return single;
  const unique = [...new Set((templateIds ?? []).map((id) => rustTrim(id)).filter((id) => id.length > 0))].sort(compareUtf8);
  return unique.length === 1 ? unique[0] ?? null : null;
}

/** 有效模板集合只有一个时归一为 single 形态（templateId 有值、templateIds 为 null）。 */
export function normalizeTemplateSelection(selection: TemplateSelection): TemplateSelection {
  if (resolveSingleTemplateId(selection.templateId) !== null) return selection;
  const single = effectiveSingleTemplateId(null, selection.templateIds);
  return single === null ? selection : { templateId: single, templateIds: null };
}

export function collectRequestedTemplateIds(
  templateId: string | null, templateIds: readonly string[] | null,
): string[] {
  const ids: string[] = [];
  const single = (templateId == null ? undefined : rustTrim(templateId));
  if (single) ids.push(single);
  for (const raw of templateIds ?? []) {
    for (const item of raw.split(',')) {
      const trimmed = rustTrim(item);
      if (trimmed.length > 0) ids.push(trimmed);
    }
  }
  return [...new Set(ids)].sort(compareUtf8);
}

export function deriveEffectiveTemplateMode(selection: TemplateSelection): ChatAnkiTemplateMode {
  if (resolveSingleTemplateId(selection.templateId) !== null) return 'single';
  const count = (selection.templateIds ?? []).filter((id) => rustTrim(id).length > 0).length;
  return count > 1 ? 'multiple' : 'single';
}

export function goalPrefersChoiceTemplate(goal: string): boolean {
  const lower = goal.toLowerCase();
  return ['选择题', '单选', '多选', 'choice', 'multiple choice'].some((keyword) => lower.includes(keyword));
}

/** 校验 agent 传入卡片的 templateId 均存在；错误文本给模型指明修正路径。 */
export function validateAgentCardTemplateIds(
  db: Pick<TemplateDatabase, 'getCustomTemplateById'>, cards: readonly AnkiCard[],
): void {
  const ids = [...new Set(cards
    .map((card) => (card.template_id == null ? undefined : rustTrim(card.template_id)))
    .filter((id): id is string => typeof id === 'string' && id.length > 0))].sort(compareUtf8);
  const missing: string[] = [];
  for (const id of ids) {
    let template: CustomAnkiTemplate | null;
    try {
      template = db.getCustomTemplateById(id);
    } catch (error) {
      throw new Error(
        `failed to load template ${id} while validating chatanki_add_cards: `
        + `${errorText(error)}; retry later`,
      );
    }
    if (template === null) missing.push(id);
  }
  if (missing.length > 0) {
    throw new Error(
      `unknown templateId: ${missing.join(', ')}; no cards were added. Use a templateId returned by `
      + "chatanki_list_templates, or omit templateId to keep the document's default fields",
    );
  }
}

// ============================================================================
// list_templates projection (chatanki_executor.rs:11431–11672)
// ============================================================================

export const FIELD_LIMIT_WARNINGS_CAP = 30;

export const CHATANKI_TEMPLATE_SELECTION_RULE = '按内容选模板，而不是按风格：'
  + '多句答案、定理陈述+证明要点、推导、原理解释等通用问答默认用 design-footnote（或 design-monograph）；'
  + '定义/术语/关键结论的填空用 design-glass（或 design-exam）；'
  + '其他 design-* 仅在内容完全符合其 generation_prompt「适用」与 fieldGuide 语义时使用，或用户点名该风格。'
  + '字段值必须遵守 fieldGuide.maxChars；内容放不进某字段（如把整句证明塞进 Formula）说明模板选错了，应换模板而不是硬塞。';

export const FIELD_LIMIT_HINT = '这些字段超出模板的建议长度，渲染后可能难以阅读。'
  + '请精简为该字段要求的形态（见 chatanki_list_templates 的 fieldGuide）；'
  + '如果内容本身就是多句解释/证明/推导，说明模板不合适：改用 design-footnote / design-monograph（问答）'
  + '或 design-glass / design-exam（填空），经 chatanki_retemplate 换模板后再补字段。';

function findRule(
  rules: Record<string, FieldExtractionRule>, field: string,
): FieldExtractionRule | undefined {
  if (Object.hasOwn(rules, field)) return rules[field];
  const lower = field.toLowerCase();
  for (const [key, rule] of Object.entries(rules)) {
    if (key.toLowerCase() === lower) return rule;
  }
  return undefined;
}

/** 模板字段的紧凑说明：用途、是否必填、建议上限（按声明顺序）。 */
export function chatankiTemplateFieldGuide(
  fields: readonly string[], rules: Record<string, FieldExtractionRule>,
): Array<Record<string, unknown>> {
  return fields.map((field) => {
    const rule = findRule(rules, field);
    const item: Record<string, unknown> = {
      name: field,
      required: rule !== undefined ? rule.is_required : false,
    };
    const purpose = rule === undefined ? undefined : rustTrim(rule.description);
    if (purpose !== undefined && purpose.length > 0 && purpose !== field) item.purpose = purpose;
    if (rule?.max_length !== null && rule?.max_length !== undefined) item.maxChars = rule.max_length;
    if (rule !== undefined && rule.field_type !== 'Text') item.type = rule.field_type;
    return item;
  });
}

export function chatankiTemplateListItem(template: CustomAnkiTemplate): Record<string, unknown> {
  const fields = normalizeTemplateFields(template.fields);
  const rules = ensureFieldExtractionRules(fields, template.field_extraction_rules);
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    category: 'general',
    noteType: template.note_type,
    isCloze: rustTrim(template.note_type).toLowerCase() === 'cloze',
    fields,
    isActive: template.is_active,
    complexityLevel: calculateComplexityLevel(fields.length, template.note_type),
    fieldGuide: chatankiTemplateFieldGuide(fields, rules),
    generation_prompt: template.generation_prompt,
    isBuiltIn: template.is_built_in,
  };
}

/** 过滤后再分页（page 从 1 开始；越界返回空页）。 */
export function selectChatankiTemplatePage(
  templates: readonly CustomAnkiTemplate[],
  query: string, activeOnly: boolean, page: number, pageSize: number,
): { total: number; items: Array<Record<string, unknown>> } {
  const needle = query.toLowerCase();
  const filtered = templates.filter((template) => {
    if (activeOnly && !template.is_active) return false;
    if (needle.length === 0) return true;
    return `${template.id} ${template.name}\n${template.description} ${template.note_type}`
      .toLowerCase().includes(needle);
  });
  const offset = Math.max(page - 1, 0) * pageSize;
  return {
    total: filtered.length,
    items: filtered.slice(offset, offset + pageSize).map(chatankiTemplateListItem),
  };
}

/** 粗略去掉 HTML 标签后按 Unicode 标量计长。 */
export function visibleCharCount(value: string): number {
  let inTag = false;
  let count = 0;
  for (const char of value) {
    if (char === '<') inTag = true;
    else if (char === '>' && inTag) inTag = false;
    else if (!inTag) count += 1;
  }
  return count;
}

const FRONT_ALIASES = ['front', 'question', 'word', 'name', 'title', 'term', 'prompt'];
const BACK_ALIASES = [
  'back', 'answer', 'definition', 'explanation', 'desc', 'expl', 'backdetail', 'meaning',
  'translation',
];

function normalizeTemplateCardFieldKey(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function toolCardFieldValue(card: Record<string, unknown>, field: string): string | null {
  const extra = card.extraFields;
  if (extra !== null && typeof extra === 'object' && !Array.isArray(extra)) {
    const lower = field.toLowerCase();
    for (const [key, value] of Object.entries(extra)) {
      if (key.toLowerCase() === lower && typeof value === 'string') return value;
    }
  }
  const normalized = normalizeTemplateCardFieldKey(field);
  const core = FRONT_ALIASES.includes(normalized) ? 'front'
    : BACK_ALIASES.includes(normalized) ? 'back'
      : normalized === 'text' ? 'text'
        : null;
  if (core === null) return null;
  const value = card[core];
  return typeof value === 'string' ? value : null;
}

/**
 * 对照模板 `max_length` 做字段长度软校验（不拒写、不改卡）。
 * 返回 `(告警列表（已按上限截断）, 告警总数)`；规则按模板 ID 缓存。
 */
export function computeFieldLimitWarnings(
  cards: readonly Record<string, unknown>[],
  lookupRules: (templateId: string) => Record<string, FieldExtractionRule> | null,
): { warnings: Array<Record<string, unknown>>; total: number } {
  const cache = new Map<string, Record<string, FieldExtractionRule> | null>();
  const warnings: Array<Record<string, unknown>> = [];
  let total = 0;
  for (const card of cards) {
    if (card.isErrorCard === true) continue;
    const rawTemplateId = card.templateId;
    const templateId = typeof rawTemplateId === 'string' ? rustTrim(rawTemplateId) : '';
    if (templateId.length === 0) continue;
    let rules = cache.get(templateId);
    if (rules === undefined) {
      rules = lookupRules(templateId);
      cache.set(templateId, rules);
    }
    if (rules === null) continue;
    const limited = Object.entries(rules)
      .filter(([, rule]) => rule.max_length !== null && rule.max_length !== undefined)
      .sort(([left], [right]) => compareUtf8(left, right));
    for (const [field, rule] of limited) {
      const value = toolCardFieldValue(card, field);
      if (value === null) continue;
      const length = visibleCharCount(value);
      const max = rule.max_length as number;
      if (length <= max) continue;
      total += 1;
      if (warnings.length < FIELD_LIMIT_WARNINGS_CAP) {
        warnings.push({
          cardId: card.id ?? null, templateId, field, length, maxChars: max,
          purpose: rule.description,
        });
      }
    }
  }
  return { warnings, total };
}
