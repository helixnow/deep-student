/**
 * `AnkiGenerationOptions` 的 serde 反序列化 + 再序列化
 * （`dstu-core/src/models.rs:1268-1368`）：`save_anki_cards` 把 options 存进
 * `document_tasks.anki_generation_options_json` 时与 Rust 的 JSON 形状一致。
 */
import {
  decodeFieldExtractionRules,
  serializeFieldExtractionRule,
} from './templates.ts';

/** `serde_json` 对 f32 用最短可回读十进制；这里取能回读的最短精度。 */
function serializeF32(value: number): number {
  const target = Math.fround(value);
  for (let precision = 1; precision <= 9; precision += 1) {
    const candidate = Number(target.toPrecision(precision));
    if (Math.fround(candidate) === target) return candidate;
  }
  return target;
}

function serializeRules(value: unknown): Record<string, unknown> {
  const rules = decodeFieldExtractionRules(value);
  const out: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(rules)) out[key] = serializeFieldExtractionRule(rule);
  return out;
}

function serializeRulesById(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [templateId, rules] of Object.entries(value)) out[templateId] = serializeRules(rules);
  return out;
}

function optional(value: unknown): unknown {
  return value === undefined || value === null ? null : value;
}

/** `serde_json::to_string(&AnkiGenerationOptions)`（字段顺序同 Rust 结构体声明）。 */
export function serializeAnkiGenerationOptions(raw: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  if (raw.source_ref !== undefined && raw.source_ref !== null) out.source_ref = raw.source_ref;
  out.deck_name = raw.deck_name;
  out.note_type = raw.note_type;
  out.enable_images = raw.enable_images;
  out.max_cards_per_mistake = raw.max_cards_per_mistake;
  out.max_cards_total = optional(raw.max_cards_total);
  out.max_tokens = optional(raw.max_tokens);
  out.temperature = raw.temperature === undefined || raw.temperature === null
    ? null
    : serializeF32(raw.temperature as number);
  out.max_output_tokens_override = optional(raw.max_output_tokens_override);
  out.temperature_override = raw.temperature_override === undefined || raw.temperature_override === null
    ? null
    : serializeF32(raw.temperature_override as number);
  out.template_id = optional(raw.template_id);
  out.custom_anki_prompt = optional(raw.custom_anki_prompt);
  out.template_fields = optional(raw.template_fields);
  out.field_extraction_rules = raw.field_extraction_rules === undefined || raw.field_extraction_rules === null
    ? null
    : serializeRules(raw.field_extraction_rules);
  out.template_fields_by_id = optional(raw.template_fields_by_id);
  out.field_extraction_rules_by_id =
    raw.field_extraction_rules_by_id === undefined || raw.field_extraction_rules_by_id === null
      ? null
      : serializeRulesById(raw.field_extraction_rules_by_id);
  out.custom_requirements = optional(raw.custom_requirements);
  out.segment_overlap_size = typeof raw.segment_overlap_size === 'number' ? raw.segment_overlap_size : 200;
  out.system_prompt = optional(raw.system_prompt);
  out.template_ids = optional(raw.template_ids);
  out.template_descriptions = optional(raw.template_descriptions);
  out.enable_llm_boundary_detection = optional(raw.enable_llm_boundary_detection);
  out.fsrs_feedback = optional(raw.fsrs_feedback);
  out.user_review_profile = optional(raw.user_review_profile);
  for (const key of [
    'output_protocol',
    'enable_qa_pass',
    'enable_critic_pass',
    'enable_llm_critic',
    'critic_token_budget',
    'sidekick_model_routing',
  ] as const) {
    const value = raw[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return JSON.stringify(out);
}
