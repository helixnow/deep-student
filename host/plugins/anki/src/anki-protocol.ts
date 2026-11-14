/**
 * Anki 流式制卡输出协议（`dstu-anki/src/anki_protocol.rs`）：
 *
 * 1. 集中定义分隔符常量（`CARD_DELIMITER` / `BROKEN_DELIMITER_TAIL`），供
 *    `build_prompt` 与 `extract_card_from_buffer` 共用；
 * 2. 定义 `OutputProtocol`（delimiter / json_object / json_schema）与协议对应的
 *    格式指令 `formatInstructions`；
 * 3. 从模板的 `FieldExtractionRule` 生成 JSON Schema（required / type / enum /
 *    minLength / maxLength），多模板场景用 `oneOf` + `template_id` 区分变体；
 * 4. 供应商能力探测 `detectSchemaCapability` 与默认协议决策
 *    `resolveOutputProtocol`：能力允许时优先 json_schema，未知供应商保守回退
 *    delimiter；
 * 5. 轻量 JSON 修复：`repairJson` 只做无损修复，`repairJsonDetailed` 额外支持
 *    字符串中途截断的有损修复并显式返回 `truncated_string` 标记；
 * 6. 结构化 wrapper（`{"cards": [...]}`）的流式前缀剥离 `stripWrapperPrefix`
 *    与整体展开 `unwrapCardsArray`。
 */
import type {
  AnkiGenerationOptions,
  FieldExtractionRule__De,
  FieldType__De,
  TemplateDescription,
} from '../../../../contracts/ipc/generated/L16-anki.ts';
import { rustTrim, rustTrimEnd } from '../../../platform/util/index.ts';
import { decodeFieldExtractionRules, SerdeError } from './templates.ts';

// ==================== 共享常量 ====================

/** 分隔符协议下每张卡片 JSON 之后的分隔标记。 */
export const CARD_DELIMITER = '<<<ANKI_CARD_JSON_END>>>';

/** 损坏分隔符的尾部特征（模型偶发在 `<<<` 后插入空格等杂质时的修复锚点）。 */
export const BROKEN_DELIMITER_TAIL = 'ANKI_CARD_JSON_END>>>';

/** 结构化协议（json_object / json_schema）下响应对象的顶层数组键名。 */
export const CARDS_WRAPPER_KEY = 'cards';

/** 多模板 schema 变体的判别字段名。 */
export const TEMPLATE_ID_KEY = 'template_id';

/** response_format json_schema 的 name 字段。 */
export const JSON_SCHEMA_NAME = 'anki_cards';

// ==================== 字符串工具（对齐 Rust 标准库语义） ====================

/** `str::eq_ignore_ascii_case`：只折叠 ASCII 大小写，其余字符须完全相同。 */
function eqIgnoreAsciiCase(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    let a = left.charCodeAt(index);
    let b = right.charCodeAt(index);
    if (a >= 0x41 && a <= 0x5a) a += 0x20;
    if (b >= 0x41 && b <= 0x5a) b += 0x20;
    if (a !== b) return false;
  }
  return true;
}

/** UTF-8 字节序排序（Rust `Vec<String>::sort`）。 */
function utf8Compare(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const codeA = a[index]!.codePointAt(0)!;
    const codeB = b[index]!.codePointAt(0)!;
    if (codeA !== codeB) return codeA < codeB ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/** `u8::is_ascii_whitespace`（不含垂直制表符 U+000B）。 */
function isAsciiWhitespace(character: string): boolean {
  return (
    character === ' ' ||
    character === '\t' ||
    character === '\n' ||
    character === '\f' ||
    character === '\r'
  );
}

// ==================== 输出协议 ====================

/**
 * Anki 流式制卡的输出协议（`#[serde(rename_all = "snake_case")]`，
 * 取值与 options JSON 中 `output_protocol` 的 wire 值一致）。
 */
export type OutputProtocol = 'delimiter' | 'json_object' | 'json_schema';

/** `OutputProtocol::as_str`：稳定字符串名（与 serde 的 snake_case 相同）。 */
export function outputProtocolAsStr(protocol: OutputProtocol): OutputProtocol {
  return protocol;
}

/** `OutputProtocol::is_structured`：是否为结构化协议（需要 wrapper 剥离与 response_format 注入）。 */
export function isStructuredProtocol(protocol: OutputProtocol): boolean {
  return protocol !== 'delimiter';
}

/** 协议相关扩展选项（`output_protocol` / `enable_qa_pass`）的薄投影。 */
export interface StructuredOutputOptions {
  /** 请求的输出协议：`auto` / `delimiter` / `json_object` / `json_schema`；null 等价于 auto。 */
  output_protocol: string | null;
  /** 是否启用字段 QA 校验（`_qa_flags` 留痕）；null 表示默认开启。 */
  enable_qa_pass: boolean | null;
}

/** `serde_json::from_str::<AnkiGenerationOptions>` 失败（含解码期类型不匹配）。 */
class OptionsDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OptionsDecodeError';
  }
}

function optionsDecodeFail(message: string): never {
  throw new OptionsDecodeError(message);
}

function requireOptionsObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    optionsDecodeFail('invalid type: expected a map');
  }
  return value as Record<string, unknown>;
}

function requiredOptionsField(object: Record<string, unknown>, key: string): unknown {
  if (!Object.hasOwn(object, key)) optionsDecodeFail(`missing field \`${key}\``);
  return object[key];
}

function optionalOptionsField<T>(
  object: Record<string, unknown>,
  key: string,
  decode: (value: unknown) => T,
): T | null {
  if (!Object.hasOwn(object, key) || object[key] === null) return null;
  return decode(object[key]);
}

function decodeWireString(value: unknown): string {
  if (typeof value !== 'string') optionsDecodeFail('invalid type: expected a string');
  return value;
}

function decodeWireBool(value: unknown): boolean {
  if (typeof value !== 'boolean') optionsDecodeFail('invalid type: expected a boolean');
  return value;
}

function decodeWireInteger(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    optionsDecodeFail('invalid type: expected an integer');
  }
  return value;
}

/** `Option<f32>`：serde_json 对舍入到 f32 后溢出的数值报错（`NumberOutOfRange`）。 */
function decodeWireF32(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(Math.fround(value))) {
    optionsDecodeFail('invalid type: expected a finite f32');
  }
  return value;
}

function decodeWireStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) optionsDecodeFail('invalid type: expected a sequence');
  return value.map(decodeWireString);
}

function decodeWireStringArrayMap(value: unknown): Record<string, string[]> {
  const object = requireOptionsObject(value);
  const decoded: Record<string, string[]> = {};
  for (const [key, item] of Object.entries(object)) decoded[key] = decodeWireStringArray(item);
  return decoded;
}

function decodeWireRulesById(value: unknown): Record<string, Record<string, FieldExtractionRule__De>> {
  const object = requireOptionsObject(value);
  const decoded: Record<string, Record<string, FieldExtractionRule__De>> = {};
  for (const [key, item] of Object.entries(object)) decoded[key] = decodeFieldExtractionRules(item);
  return decoded;
}

function decodeTemplateDescription(value: unknown): TemplateDescription {
  const object = requireOptionsObject(value);
  return {
    id: decodeWireString(requiredOptionsField(object, 'id')),
    name: decodeWireString(requiredOptionsField(object, 'name')),
    description: decodeWireString(requiredOptionsField(object, 'description')),
    fields: decodeWireStringArray(requiredOptionsField(object, 'fields')),
    generation_prompt: optionalOptionsField(object, 'generation_prompt', decodeWireString),
  };
}

function decodeTemplateDescriptions(value: unknown): TemplateDescription[] {
  if (!Array.isArray(value)) optionsDecodeFail('invalid type: expected a sequence');
  return value.map(decodeTemplateDescription);
}

const I32_MIN = -2_147_483_648;
const I32_MAX = 2_147_483_647;
const U32_MAX = 4_294_967_295;

/** `serde_json::from_str::<AnkiGenerationOptions>`（`models.rs:1269-1366`）。 */
export function decodeAnkiGenerationOptions(raw: string): AnkiGenerationOptions {
  const object = requireOptionsObject(JSON.parse(raw) as unknown);
  const options: AnkiGenerationOptions = {
    deck_name: decodeWireString(requiredOptionsField(object, 'deck_name')),
    note_type: decodeWireString(requiredOptionsField(object, 'note_type')),
    enable_images: decodeWireBool(requiredOptionsField(object, 'enable_images')),
    max_cards_per_mistake: decodeWireInteger(
      requiredOptionsField(object, 'max_cards_per_mistake'),
      I32_MIN,
      I32_MAX,
    ),
    max_cards_total: optionalOptionsField(object, 'max_cards_total', (value) =>
      decodeWireInteger(value, I32_MIN, I32_MAX),
    ),
    max_tokens: optionalOptionsField(object, 'max_tokens', (value) => decodeWireInteger(value, 0, U32_MAX)),
    temperature: optionalOptionsField(object, 'temperature', decodeWireF32),
    max_output_tokens_override: optionalOptionsField(object, 'max_output_tokens_override', (value) =>
      decodeWireInteger(value, 0, U32_MAX),
    ),
    temperature_override: optionalOptionsField(object, 'temperature_override', decodeWireF32),
    template_id: optionalOptionsField(object, 'template_id', decodeWireString),
    custom_anki_prompt: optionalOptionsField(object, 'custom_anki_prompt', decodeWireString),
    template_fields: optionalOptionsField(object, 'template_fields', decodeWireStringArray),
    field_extraction_rules: optionalOptionsField(object, 'field_extraction_rules', decodeFieldExtractionRules),
    template_fields_by_id: optionalOptionsField(object, 'template_fields_by_id', decodeWireStringArrayMap),
    field_extraction_rules_by_id: optionalOptionsField(object, 'field_extraction_rules_by_id', decodeWireRulesById),
    custom_requirements: optionalOptionsField(object, 'custom_requirements', decodeWireString),
    segment_overlap_size:
      Object.hasOwn(object, 'segment_overlap_size') && object.segment_overlap_size !== null
        ? decodeWireInteger(object.segment_overlap_size, 0, U32_MAX)
        : 200,
    system_prompt: optionalOptionsField(object, 'system_prompt', decodeWireString),
    template_ids: optionalOptionsField(object, 'template_ids', decodeWireStringArray),
    template_descriptions: optionalOptionsField(object, 'template_descriptions', decodeTemplateDescriptions),
    enable_llm_boundary_detection: optionalOptionsField(object, 'enable_llm_boundary_detection', decodeWireBool),
    fsrs_feedback: optionalOptionsField(object, 'fsrs_feedback', decodeWireBool),
    user_review_profile: optionalOptionsField(object, 'user_review_profile', decodeWireString),
    output_protocol: optionalOptionsField(object, 'output_protocol', decodeWireString),
    enable_qa_pass: optionalOptionsField(object, 'enable_qa_pass', decodeWireBool),
    enable_critic_pass: optionalOptionsField(object, 'enable_critic_pass', decodeWireBool),
    enable_llm_critic: optionalOptionsField(object, 'enable_llm_critic', decodeWireBool),
    critic_token_budget: optionalOptionsField(object, 'critic_token_budget', (value) =>
      decodeWireInteger(value, 0, U32_MAX),
    ),
    sidekick_model_routing: optionalOptionsField(object, 'sidekick_model_routing', decodeWireString),
  };
  if (Object.hasOwn(object, 'source_ref') && object.source_ref !== null) {
    options.source_ref = object.source_ref;
  }
  return options;
}

/**
 * `StructuredOutputOptions::from_options_json`：复用 `AnkiGenerationOptions` 的
 * serde 定义并只取两个协议字段；解析失败回退默认值。
 */
export function structuredOutputOptionsFromOptionsJson(raw: string): StructuredOutputOptions {
  let options: AnkiGenerationOptions;
  try {
    options = decodeAnkiGenerationOptions(raw);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof SerdeError || error instanceof OptionsDecodeError) {
      return { output_protocol: null, enable_qa_pass: null };
    }
    throw error;
  }
  return {
    output_protocol: options.output_protocol ?? null,
    enable_qa_pass: options.enable_qa_pass ?? null,
  };
}

/** `StructuredOutputOptions::qa_pass_enabled`。 */
export function qaPassEnabled(options: StructuredOutputOptions): boolean {
  return options.enable_qa_pass ?? true;
}

// ==================== 供应商能力探测与协议决策 ====================

/** 供应商对结构化输出的支持能力（保守判定）。 */
export type SchemaCapability = 'json_schema' | 'json_object_only' | 'unknown';

/** `Option<&str>` 的 trim + lowercase 归一化（缺省为空串）。 */
function normalized(value: string | null | undefined): string {
  return rustTrim(value ?? '').toLowerCase();
}

/**
 * 依据 ApiConfig 的关键字段保守判定结构化输出能力。
 *
 * - `anthropic_messages` / `google_generate_content` / `openai_responses`
 *   协议：适配器已实现 response_format → 原生结构化输出的转换 → json_schema；
 * - model_adapter 为 anthropic/claude/google/gemini → json_schema；
 * - OpenAI 官方端点（api.openai.com）→ json_schema；
 * - DeepSeek 官方端点：文档仅承诺 `json_object` → json_object_only；
 * - 其余 OpenAI 兼容端点（自建网关 / 本地推理 / 各类中转）→ unknown。
 */
export function detectSchemaCapability(
  modelAdapter: string,
  apiProtocol: string | null | undefined,
  providerType: string | null | undefined,
  baseUrl: string,
): SchemaCapability {
  const adapter = rustTrim(modelAdapter).toLowerCase();
  const protocol = normalized(apiProtocol);
  const provider = normalized(providerType);
  const url = rustTrim(baseUrl).toLowerCase();

  // 原生协议路径：providers/mod.rs 的适配器负责 response_format 转换
  if (
    protocol.includes('anthropic') ||
    protocol.includes('google') ||
    protocol.includes('gemini') ||
    protocol.includes('responses')
  ) {
    return 'json_schema';
  }
  if (adapter === 'anthropic' || adapter === 'claude' || adapter === 'google' || adapter === 'gemini') {
    return 'json_schema';
  }
  if (url.includes('api.anthropic.com') || url.includes('generativelanguage.googleapis.com')) {
    return 'json_schema';
  }

  // OpenAI 官方 chat_completions 原生支持 json_schema
  if (provider === 'openai' || url.includes('api.openai.com')) {
    return 'json_schema';
  }

  // DeepSeek 官方仅承诺 json_object
  if (provider === 'deepseek' || url.includes('api.deepseek.com')) {
    return 'json_object_only';
  }

  return 'unknown';
}

/** 协议决策原因（用于日志与调试）。 */
export type OutputProtocolDecisionReason =
  | 'explicit_request'
  | 'auto_capability'
  | 'auto_json_object_only_fallback'
  | 'auto_capability_unknown_fallback'
  | 'unknown_requested_value_fallback';

/**
 * 协议决策：显式请求优先，`auto`（或缺省）按能力选择。
 *
 * 能力确认支持 json_schema 时优先 json_schema；其余情况（含 json_object_only /
 * unknown）回退 delimiter——分隔符协议久经实战且解析侧带 brace-depth 兜底，
 * json_object 仅在显式请求时使用。
 */
export function resolveOutputProtocol(
  requested: string | null | undefined,
  capability: SchemaCapability,
): [OutputProtocol, OutputProtocolDecisionReason] {
  switch (normalized(requested)) {
    case 'delimiter':
      return ['delimiter', 'explicit_request'];
    case 'json_object':
      return ['json_object', 'explicit_request'];
    // 显式请求 json_schema 时尊重用户选择（即使能力未知）；
    // 运行时若被端点拒绝，服务层会回退 delimiter 重试一次。
    case 'json_schema':
      return ['json_schema', 'explicit_request'];
    case '':
    case 'auto':
      if (capability === 'json_schema') return ['json_schema', 'auto_capability'];
      if (capability === 'json_object_only') return ['delimiter', 'auto_json_object_only_fallback'];
      return ['delimiter', 'auto_capability_unknown_fallback'];
    default:
      return ['delimiter', 'unknown_requested_value_fallback'];
  }
}

/** 结构化输出请求疑似被端点拒绝（协议不支持 / schema 不合法）的错误特征。 */
export function isProbablyStructuredOutputRejection(message: string): boolean {
  return (
    message.includes('(HTTP 400)') || message.includes('(HTTP 404)') || message.includes('(HTTP 422)')
  );
}

// ==================== 协议格式指令 ====================

/**
 * 生成协议对应的输出格式指令块（build_prompt 的"重要指令"段）。
 *
 * - `cardCountInstruction`：卡片数量约束段（含结尾空行），由调用方组装；
 * - `fieldsRequirement`：字段要求描述；
 * - `exampleJson`：单张卡片的示例 JSON（语言中性占位，避免 few-shot 语言牵引）。
 */
export function formatInstructions(
  protocol: OutputProtocol,
  cardCountInstruction: string,
  fieldsRequirement: string,
  exampleJson: string,
): string {
  if (protocol === 'delimiter') {
    return (
      `${cardCountInstruction}重要指令：\n` +
      '1. 请逐个生成卡片，每个卡片必须是完整的JSON格式\n' +
      `2. 每生成一个完整的卡片JSON后，立即输出分隔符：${CARD_DELIMITER}（包括最后一张卡片之后也必须输出分隔符）\n` +
      `3. JSON格式必须包含以下字段：${fieldsRequirement}\n` +
      '4. 不要使用Markdown代码块，直接输出JSON\n' +
      '5. 输出完所有卡片和最后一个分隔符后立即停止，不要输出任何总结或结束语\n' +
      '6. 示例输出格式：\n' +
      `${exampleJson}\n` +
      CARD_DELIMITER
    );
  }
  return (
    `${cardCountInstruction}重要指令：\n` +
    '1. 你的完整回复必须是且仅是一个 JSON 对象，不要输出任何其他文字\n' +
    `2. 该对象只有一个键 "${CARDS_WRAPPER_KEY}"，其值为卡片对象数组\n` +
    `3. 每个卡片对象必须包含以下字段：${fieldsRequirement}\n` +
    '4. 不要使用Markdown代码块，不要输出任何分隔符，直接输出 JSON\n' +
    '5. 输出完该 JSON 对象后立即停止，不要输出任何总结或结束语\n' +
    '6. 示例输出格式：\n' +
    `{"${CARDS_WRAPPER_KEY}": [${exampleJson}]}`
  );
}

// ==================== 多模板判定 ====================

/**
 * 是否为多模板生成场景（build_prompt 与 parse_and_save_card 共用的唯一判定）：
 * 四个来源任一按模板分组的集合含 >1 个条目即视为多模板。
 */
export function isMultiTemplate(options: AnkiGenerationOptions): boolean {
  const descriptions = options.template_descriptions;
  if (descriptions !== undefined && descriptions !== null && descriptions.length > 1) return true;
  const templateIds = options.template_ids;
  if (templateIds !== undefined && templateIds !== null && templateIds.length > 1) return true;
  const fieldsById = options.template_fields_by_id;
  if (fieldsById !== undefined && fieldsById !== null && Object.keys(fieldsById).length > 1) return true;
  const rulesById = options.field_extraction_rules_by_id;
  if (rulesById !== undefined && rulesById !== null && Object.keys(rulesById).length > 1) return true;
  return false;
}

// ==================== JSON Schema 生成 ====================

/** JSON 对象形态的 schema（`serde_json::Value::Object`）。 */
export type JsonSchemaObject = Record<string, unknown>;

/** `FieldType__De` 的 wire 形态归一化（字符串或 `{Text: null}` 外部标签）。 */
function fieldTypeName(fieldType: FieldType__De): string {
  if (typeof fieldType === 'string') return fieldType;
  return Object.keys(fieldType)[0] ?? '';
}

/** FieldType → JSON Schema 基础类型名。 */
function jsonTypeForField(fieldType: FieldType__De): 'array' | 'number' | 'boolean' | 'string' {
  switch (fieldTypeName(fieldType)) {
    case 'Array':
      return 'array';
    case 'Number':
      return 'number';
    case 'Boolean':
      return 'boolean';
    // Text / Date / RichText / Formula 在 Anki 侧均为文本
    default:
      return 'string';
  }
}

/** 在规则表中按名称查规则（先精确，再大小写不敏感），与解析侧行为一致。 */
function findRuleForSchema(
  rules: Record<string, FieldExtractionRule__De> | null | undefined,
  field: string,
): FieldExtractionRule__De | undefined {
  if (rules === null || rules === undefined) return undefined;
  if (Object.hasOwn(rules, field)) {
    const rule = rules[field];
    if (rule !== undefined) return rule;
  }
  for (const [key, rule] of Object.entries(rules)) {
    if (eqIgnoreAsciiCase(key, field)) return rule;
  }
  return undefined;
}

/** 非空 trim 文本（`Option<String>` 语义）。 */
function trimmedNonEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = rustTrim(value);
  return trimmed === '' ? null : trimmed;
}

/** 由单个字段规则生成该字段的 JSON Schema 片段（type / enum / 长度约束 / 描述）。 */
function buildFieldSchema(field: string, rule: FieldExtractionRule__De | undefined): JsonSchemaObject {
  const typeName =
    rule !== undefined
      ? jsonTypeForField(rule.field_type)
      : // 无规则时的历史默认：tags 是字符串数组，其余是字符串
        eqIgnoreAsciiCase(field, 'tags')
        ? 'array'
        : 'string';

  const allowedValues = rule?.allowed_values;
  const enumValues = allowedValues !== undefined && allowedValues !== null && allowedValues.length > 0
    ? [...allowedValues]
    : null;

  const schema = { type: typeName } as JsonSchemaObject;
  if (typeName === 'array') {
    const items: JsonSchemaObject = { type: 'string' };
    if (enumValues !== null) items.enum = enumValues;
    schema.items = items;
  } else if (enumValues !== null) {
    schema.enum = enumValues;
  }

  if (typeName === 'string') {
    if (rule?.min_length !== undefined && rule.min_length !== null) schema.minLength = rule.min_length;
    if (rule?.max_length !== undefined && rule.max_length !== null) schema.maxLength = rule.max_length;
  }

  const description = rule === undefined ? null : trimmedNonEmpty(rule.description);
  const hint = rule === undefined ? null : trimmedNonEmpty(rule.ai_hint);
  const finalDescription = description ?? hint;
  if (finalDescription !== null) schema.description = finalDescription;

  return schema;
}

/** 字段是否必填（有规则按规则，无规则回退历史默认：front/back 必填）。 */
function fieldIsRequired(field: string, rule: FieldExtractionRule__De | undefined): boolean {
  if (rule !== undefined) return rule.is_required;
  return eqIgnoreAsciiCase(field, 'front') || eqIgnoreAsciiCase(field, 'back');
}

/**
 * 生成单张卡片对象的 schema。
 *
 * - `fields`：模板字段清单（决定 properties 的键集合与顺序来源）；
 * - `rules`：字段提取规则（决定 required / type / enum / 长度约束）；
 * - `templateId`：非 null 时注入 `template_id` 判别字段（enum 单值，兼容
 *   Gemini 的 OpenAPI 子集——其对 `const` 支持不佳）并加入 required。
 */
export function buildCardSchema(
  fields: string[],
  rules: Record<string, FieldExtractionRule__De> | null | undefined,
  templateId: string | null | undefined,
): JsonSchemaObject {
  const properties: JsonSchemaObject = {};
  const required: string[] = [];

  if (templateId !== null && templateId !== undefined) {
    properties[TEMPLATE_ID_KEY] = { type: 'string', enum: [templateId] };
    required.push(TEMPLATE_ID_KEY);
  }

  for (const field of fields) {
    const rule = findRuleForSchema(rules, field);
    properties[field] = buildFieldSchema(field, rule);
    if (fieldIsRequired(field, rule)) required.push(field);
  }

  // 规则表中存在但字段清单未列出的字段（规则是解析侧的权威来源）也纳入 schema，
  // 避免模型输出被 additionalProperties:false 误伤。
  if (rules !== null && rules !== undefined) {
    const extraKeys = Object.keys(rules)
      .filter((key) => !fields.some((field) => eqIgnoreAsciiCase(field, key)))
      .sort(utf8Compare); // HashMap 迭代序不稳定，排序保证 schema 确定性
    for (const key of extraKeys) {
      const rule = rules[key];
      properties[key] = buildFieldSchema(key, rule);
      if (rule?.is_required === true) required.push(key);
    }
  }

  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

/** 解析单模板场景下的字段清单（与 build_prompt 的历史解析逻辑一致）。 */
function resolveSingleTemplateFields(options: AnkiGenerationOptions): string[] {
  const templateFields = options.template_fields;
  if (templateFields !== undefined && templateFields !== null) return [...templateFields];
  const fieldsById = options.template_fields_by_id;
  if (fieldsById !== undefined && fieldsById !== null) {
    if (options.template_id !== undefined && options.template_id !== null) {
      if (Object.hasOwn(fieldsById, options.template_id)) {
        const fields = fieldsById[options.template_id];
        if (fields !== undefined) return [...fields];
      }
    } else if (Object.keys(fieldsById).length === 1) {
      const fields = Object.values(fieldsById)[0];
      if (fields !== undefined) return [...fields];
    }
  }
  return ['front', 'back', 'tags'];
}

/** 解析单模板场景下的字段规则（与 build_prompt 的历史解析逻辑一致）。 */
function resolveSingleTemplateRules(
  options: AnkiGenerationOptions,
): Record<string, FieldExtractionRule__De> | null {
  const rules = options.field_extraction_rules;
  if (rules !== undefined && rules !== null) return rules;
  const rulesById = options.field_extraction_rules_by_id;
  if (rulesById !== undefined && rulesById !== null) {
    if (options.template_id !== undefined && options.template_id !== null) {
      return (Object.hasOwn(rulesById, options.template_id) ? rulesById[options.template_id] : undefined) ?? null;
    }
    const keys = Object.keys(rulesById);
    if (keys.length === 1) return rulesById[keys[0]!] ?? null;
  }
  return null;
}

/**
 * 生成整个响应的 wrapper schema：`{"cards": [<单卡 schema 或多模板 oneOf>]}`。
 *
 * 多模板：以 `template_fields_by_id`（回退 `template_descriptions.fields`）为
 * 字段来源、`field_extraction_rules_by_id` 为规则来源，逐模板生成变体并以
 * `oneOf` 组合，每个变体携带 `template_id` 判别字段。
 * 无法收集到任何模板字段信息时返回 null（调用方降级 json_object）。
 */
export function buildCardsResponseSchema(options: AnkiGenerationOptions): JsonSchemaObject | null {
  let cardSchema: JsonSchemaObject;

  if (isMultiTemplate(options)) {
    // 收集模板 ID 顺序：优先 descriptions（携带展示顺序），回退 fields_by_id 键
    const templateIds: string[] = [];
    const descriptions = options.template_descriptions;
    if (descriptions !== undefined && descriptions !== null) {
      for (const description of descriptions) templateIds.push(description.id);
    }
    const declaredIds = options.template_ids;
    if (declaredIds !== undefined && declaredIds !== null) {
      for (const id of declaredIds) {
        if (!templateIds.includes(id)) templateIds.push(id);
      }
    }
    const fieldsById = options.template_fields_by_id;
    if (fieldsById !== undefined && fieldsById !== null) {
      for (const key of Object.keys(fieldsById).sort(utf8Compare)) {
        if (!templateIds.includes(key)) templateIds.push(key);
      }
    }

    const variants: JsonSchemaObject[] = [];
    for (const templateId of templateIds) {
      const fromFieldMap =
        fieldsById !== undefined && fieldsById !== null && Object.hasOwn(fieldsById, templateId)
          ? fieldsById[templateId]
          : undefined;
      const fields =
        fromFieldMap !== undefined
          ? fromFieldMap
          : descriptions?.find((description) => description.id === templateId)?.fields;
      if (fields === undefined || fields.length === 0) continue; // 字段未知的模板无法生成变体，跳过
      const rulesById = options.field_extraction_rules_by_id;
      const rules =
        rulesById !== undefined && rulesById !== null && Object.hasOwn(rulesById, templateId)
          ? (rulesById[templateId] ?? null)
          : null;
      variants.push(buildCardSchema([...fields], rules, templateId));
    }

    if (variants.length === 0) return null;
    cardSchema = variants.length === 1 ? variants[0]! : { oneOf: variants };
  } else {
    const fields = resolveSingleTemplateFields(options);
    const rules = resolveSingleTemplateRules(options);
    cardSchema = buildCardSchema(fields, rules, null);
  }

  return {
    type: 'object',
    properties: {
      [CARDS_WRAPPER_KEY]: {
        type: 'array',
        items: cardSchema,
      },
    },
    required: [CARDS_WRAPPER_KEY],
    additionalProperties: false,
  };
}

/**
 * 按协议生成注入 request_body 的 `response_format` 值（OpenAI CC 形态，
 * 各 provider 适配器负责转换为原生形态）。
 *
 * - delimiter → null（保持现状，不注入）；
 * - json_object → `{"type":"json_object"}`；
 * - json_schema → `{"type":"json_schema","json_schema":{name,schema,strict:false}}`；
 *   schema 无法生成（无任何模板字段信息）时降级 json_object。
 *   `strict` 取 false：strict 模式要求所有属性必填（可选字段须以 union null
 *   表达），与模板"可选字段"语义冲突，且部分中转不支持 strict。
 */
export function buildResponseFormat(
  protocol: OutputProtocol,
  options: AnkiGenerationOptions,
): JsonSchemaObject | null {
  switch (protocol) {
    case 'delimiter':
      return null;
    case 'json_object':
      return { type: 'json_object' };
    case 'json_schema': {
      const schema = buildCardsResponseSchema(options);
      if (schema === null) return { type: 'json_object' };
      return {
        type: 'json_schema',
        json_schema: {
          name: JSON_SCHEMA_NAME,
          schema,
          strict: false,
        },
      };
    }
  }
}

// ==================== 结构化 wrapper 的流式处理 ====================

/** 可变文本缓冲（对应 Rust 的 `&mut String`）。 */
export interface WrapperBuffer {
  text: string;
}

/**
 * 剥离结构化响应的 wrapper 前缀 `{"cards": [`（含任意空白变体）。
 *
 * 结构化协议下整个响应是一个 `{"cards": [...]}` 对象；剥掉前缀后，数组内的
 * 每个卡片对象即成为"顶层对象"，既有 brace-depth 切卡状态机可原样逐卡切出，
 * 保住逐卡流式产出的首卡延迟。收尾残留的 `]}` 不含 `{`，由既有收尾逻辑
 * 当作非卡片内容静默丢弃。
 *
 * 仅在完整前缀已到达时才剥离并返回 true；前缀尚不完整（跨 chunk 传输中）或
 * 内容根本不是 wrapper 形态时不动缓冲返回 false，可安全地每 chunk 重复调用。
 */
export function stripWrapperPrefix(buffer: WrapperBuffer): boolean {
  const text = buffer.text;
  let pos = 0;
  const skipWhitespace = (): void => {
    while (pos < text.length && isAsciiWhitespace(text.charAt(pos))) pos += 1;
  };

  skipWhitespace();
  if (pos >= text.length || text.charAt(pos) !== '{') return false;
  pos += 1;
  skipWhitespace();

  const key = `"${CARDS_WRAPPER_KEY}"`;
  if (text.length < pos + key.length) {
    // 前缀可能尚未完整到达：不剥离，等待后续 chunk
    return false;
  }
  if (text.slice(pos, pos + key.length) !== key) return false;
  pos += key.length;
  skipWhitespace();
  if (pos >= text.length || text.charAt(pos) !== ':') return false;
  pos += 1;
  skipWhitespace();
  if (pos >= text.length || text.charAt(pos) !== '[') return false;
  pos += 1;

  buffer.text = text.slice(pos);
  return true;
}

/** 若值为 `{"cards": [...]}` wrapper，返回其中的卡片数组。 */
export function unwrapCardsArray(value: unknown): unknown[] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const cards = (value as Record<string, unknown>)[CARDS_WRAPPER_KEY];
  return Array.isArray(cards) ? cards : null;
}

// ==================== 轻量 JSON 修复 ====================

/**
 * `repairJsonDetailed` 的修复结果。
 *
 * `truncated_string === true` 表示输入在 JSON 字符串中途被截断，修复补写了
 * 收尾引号——此时字段内容**已经丢失**，修复产物只是语法合法，绝不能当作
 * 完整卡片入库（0824 评审 #3：截断残卡必须落错误卡或携带可见 repair 标记）。
 */
export interface RepairedJson {
  /** 修复后的 JSON 文本（保证可被 JSON 解析）。 */
  text: string;
  /** 输入是否在字符串中途截断（有损修复）。 */
  truncated_string: boolean;
}

/** 去掉闭合符前/截断处遗留的尾逗号（含尾随空白）。 */
function stripTrailingCommas(out: string): string {
  let result = out;
  while (rustTrimEnd(result).endsWith(',')) {
    const trimmed = rustTrimEnd(result);
    result = trimmed.slice(0, -1);
  }
  return result;
}

function parsesAsJsonValue(text: string): boolean {
  try {
    JSON.parse(text) as unknown;
    return true;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

/**
 * 轻量 JSON 修复（含有损形态检测）：JSON 解析失败后由调用方尝试一次。
 *
 * 修复策略（保守，只处理流式截断/模型笔误的高频形态）：
 * 1. 截去已配平的顶层对象之后的尾部垃圾（如结构化收尾残留 `]}`）；
 * 2. 删除 `}` / `]` 前的尾逗号；
 * 3. 输入在字符串中途截断时补上收尾引号，并置 `truncated_string = true`
 *    （有损：截断处之后的字段内容已丢失，调用方必须显式处理）；
 * 4. 依据未闭合的括号栈按序补齐 `}` / `]`。
 *
 * 仅当修复结果能被解析时返回非 null；否则返回 null（调用方保留原始错误语义，
 * 不引入静默数据损坏）。
 */
export function repairJsonDetailed(raw: string): RepairedJson | null {
  const trimmed = rustTrim(raw);
  // 定位首个 '{'，丢弃对象前的自然语言前缀
  const start = trimmed.indexOf('{');
  if (start < 0) return null;
  const source = trimmed.slice(start);

  let out = '';
  const stack: string[] = [];
  let inString = false;
  let escape = false;

  for (const character of source) {
    if (inString) {
      out += character;
      if (escape) {
        escape = false;
      } else if (character === '\\') {
        escape = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      out += character;
      continue;
    }
    if (character === '{' || character === '[') {
      stack.push(character);
      out += character;
      continue;
    }
    if (character === '}' || character === ']') {
      // 去尾逗号：闭合符前的最后一个有效字符若是逗号则删除
      out = stripTrailingCommas(out);
      stack.pop();
      out += character;
      if (stack.length === 0) {
        // 顶层对象已配平：截去其后的尾部垃圾
        break;
      }
      continue;
    }
    out += character;
  }

  // 字符串中途截断：补收尾引号（有损，必须向调用方暴露）
  const truncatedString = inString;
  if (inString) {
    if (escape) {
      // 悬空反斜杠会让补的引号变成转义引号，先移除
      out = out.slice(0, -1);
    }
    out += '"';
  }

  // 去掉截断处遗留的尾逗号（例如 `{"a":1,` 截断）
  out = stripTrailingCommas(out);

  // 按未闭合栈逆序补齐闭合符
  while (stack.length > 0) {
    const open = stack.pop();
    out += open === '{' ? '}' : ']';
  }

  if (parsesAsJsonValue(out)) return { text: out, truncated_string: truncatedString };
  return null;
}

/**
 * 无损 JSON 修复：只处理可证明不损失字段内容的形态
 * （尾逗号、对象前后的外围垃圾、已闭合字符串之后的缺失括号）。
 *
 * 字符串中途截断视为**不可无损修复**，返回 null——调用方应将该内容降级为
 * 错误卡而不是静默补成正常卡（需要区分有损形态时用 `repairJsonDetailed`）。
 */
export function repairJson(raw: string): string | null {
  const repair = repairJsonDetailed(raw);
  if (repair === null || repair.truncated_string) return null;
  return repair.text;
}
