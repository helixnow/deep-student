/**
 * 模板纯逻辑：`CreateTemplateRequest` / `UpdateTemplateRequest` 校验与合并
 * （`src/commands.rs:6045-6227`、`dstu-storage/src/database/mod.rs:2552-2836`），
 * 以及 `serde_json` 对 `CustomAnkiTemplate` / `FieldExtractionRule` 的解码与
 * 导出序列化（`src/commands.rs:4504-4895`）。
 */
import type {
  CustomAnkiTemplate,
  CreateTemplateRequest,
  UpdateTemplateRequest,
  FieldExtractionRule__De,
} from '../../../../contracts/ipc/generated/L16-anki.ts';
import { parseRfc3339, toRfc3339Opts } from '../../../platform/time/index.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import type { AnkiLogger } from './logger.ts';

/** `custom_anki_templates` 的一行（19 列，顺序同两条 SELECT）。 */
export interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  author: string | null;
  version: string;
  preview_front: string;
  preview_back: string;
  note_type: string;
  fields_json: string;
  generation_prompt: string;
  front_template: string;
  back_template: string;
  css_style: string;
  field_extraction_rules_json: string;
  created_at: string;
  updated_at: string;
  is_active: number;
  is_built_in: number;
  preview_data_json: string | null;
}

export const TEMPLATE_COLUMNS = `id, name, description, author, version, preview_front, preview_back, note_type,
    fields_json, generation_prompt, front_template, back_template, css_style,
    field_extraction_rules_json, created_at, updated_at, is_active, is_built_in,
    preview_data_json`;

/** `serde_json::from_str` 失败时的错误文案（不含行号列号时由调用方补前缀）。 */
export class SerdeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SerdeError';
  }
}

const FIELD_TYPES = new Set(['Text', 'Array', 'Number', 'Boolean', 'Date', 'RichText', 'Formula']);
const OPTIONAL_RULE_KEYS = [
  'validation',
  'transform',
  'schema',
  'item_schema',
  'display_format',
  'ai_hint',
  'max_length',
  'min_length',
  'allowed_values',
  'depends_on',
  'compute_function',
] as const;

/** serde 的 `invalid type` 值描述。 */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'sequence';
  switch (typeof value) {
    case 'boolean':
      return `boolean \`${value}\``;
    case 'number':
      return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
    case 'string':
      return `string ${JSON.stringify(value)}`;
    case 'object':
      return 'map';
    default:
      return 'unit';
  }
}

function invalidType(value: unknown, expected: string): never {
  throw new SerdeError(`invalid type: ${describeValue(value)}, expected ${expected}`);
}

function missingField(name: string): never {
  throw new SerdeError(`missing field \`${name}\``);
}

function asRecord(value: unknown, expected: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalidType(value, expected);
  return value as Record<string, unknown>;
}

function requiredString(object: Record<string, unknown>, key: string): string {
  if (!Object.hasOwn(object, key)) missingField(key);
  const value = object[key];
  if (typeof value !== 'string') invalidType(value, 'a string');
  return value;
}

function optionalString(object: Record<string, unknown>, key: string): string | null {
  if (!Object.hasOwn(object, key) || object[key] === null) return null;
  const value = object[key];
  if (typeof value !== 'string') invalidType(value, 'a string');
  return value;
}

function requiredBool(object: Record<string, unknown>, key: string): boolean {
  if (!Object.hasOwn(object, key)) missingField(key);
  const value = object[key];
  if (typeof value !== 'boolean') invalidType(value, 'a boolean');
  return value;
}

function optionalBool(object: Record<string, unknown>, key: string): boolean | null {
  if (!Object.hasOwn(object, key) || object[key] === null) return null;
  const value = object[key];
  if (typeof value !== 'boolean') invalidType(value, 'a boolean');
  return value;
}

function requiredStringArray(object: Record<string, unknown>, key: string): string[] {
  if (!Object.hasOwn(object, key)) missingField(key);
  const value = object[key];
  if (!Array.isArray(value)) invalidType(value, 'a sequence');
  return value.map((item) => {
    if (typeof item !== 'string') invalidType(item, 'a string');
    return item;
  });
}

function optionalNumber(object: Record<string, unknown>, key: string): number | null {
  if (!Object.hasOwn(object, key) || object[key] === null) return null;
  const value = object[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) invalidType(value, 'a number');
  return value;
}

/** `CustomAnkiTemplate` 的 serde 解码（未知字段忽略）。 */
function decodeValidationRule(value: unknown): Record<string, unknown> {
  const object = asRecord(value, 'struct ValidationRule');
  return {
    pattern: optionalString(object, 'pattern'),
    min: optionalNumber(object, 'min'),
    max: optionalNumber(object, 'max'),
    enum_values: Object.hasOwn(object, 'enum_values') && object.enum_values !== null
      ? (Array.isArray(object.enum_values) ? object.enum_values : invalidType(object.enum_values, 'a sequence'))
      : null,
    custom: optionalString(object, 'custom'),
    error_message: optionalString(object, 'error_message'),
  };
}

function decodeTransformRule(value: unknown): Record<string, unknown> {
  const object = asRecord(value, 'struct TransformRule');
  return {
    transform_type: requiredString(object, 'transform_type'),
    format: optionalString(object, 'format'),
    custom_function: optionalString(object, 'custom_function'),
  };
}

function decodeObjectSchema(value: unknown): Record<string, unknown> {
  const object = asRecord(value, 'struct ObjectSchema');
  if (!Object.hasOwn(object, 'properties')) missingField('properties');
  const properties = asRecord(object.properties, 'a map');
  const decodedProperties: Record<string, DecodedFieldExtractionRule> = {};
  for (const [key, rule] of Object.entries(properties)) decodedProperties[key] = decodeFieldExtractionRule(rule);
  const required = Object.hasOwn(object, 'required') && object.required !== null
    ? requiredStringArray(object, 'required')
    : null;
  return { properties: decodedProperties, required };
}

/** 解码后的规则：`default_value` / `validation_pattern` 在 serde 中是必填 Option 字段。 */
export type DecodedFieldExtractionRule = FieldExtractionRule__De & {
  default_value: string | null;
  validation_pattern: string | null;
};

/** `models::FieldExtractionRule` 的 serde 解码（Option 字段缺省为 null，未知字段忽略）。 */
export function decodeFieldExtractionRule(value: unknown): DecodedFieldExtractionRule {
  const object = asRecord(value, 'struct FieldExtractionRule');
  const fieldType = requiredString(object, 'field_type');
  if (!FIELD_TYPES.has(fieldType)) {
    throw new SerdeError(
      `unknown variant \`${fieldType}\`, expected one of \`Text\`, \`Array\`, \`Number\`, \`Boolean\`, \`Date\`, \`RichText\`, \`Formula\``,
    );
  }
  const rule = {
    field_type: fieldType as FieldExtractionRule__De['field_type'],
    is_required: requiredBool(object, 'is_required'),
    default_value: optionalString(object, 'default_value'),
    validation_pattern: optionalString(object, 'validation_pattern'),
    description: requiredString(object, 'description'),
  };
  const optional: Record<string, unknown> = {};
  const validation = object.validation;
  if (validation !== undefined && validation !== null) optional.validation = decodeValidationRule(validation);
  const transform = object.transform;
  if (transform !== undefined && transform !== null) optional.transform = decodeTransformRule(transform);
  const schema = object.schema;
  if (schema !== undefined && schema !== null) optional.schema = decodeObjectSchema(schema);
  const itemSchema = object.item_schema;
  if (itemSchema !== undefined && itemSchema !== null) optional.item_schema = decodeObjectSchema(itemSchema);
  for (const key of OPTIONAL_RULE_KEYS) {
    if (!Object.hasOwn(optional, key) && Object.hasOwn(object, key) && object[key] !== null) {
      optional[key] = object[key];
    }
  }
  return { ...rule, ...optional } as DecodedFieldExtractionRule;
}

/** `HashMap<String, FieldExtractionRule>` 的 serde 解码；任一规则失败则整体失败。 */
export function decodeFieldExtractionRules(value: unknown): Record<string, DecodedFieldExtractionRule> {
  const object = asRecord(value, 'a map');
  const rules: Record<string, DecodedFieldExtractionRule> = {};
  for (const [key, rule] of Object.entries(object)) rules[key] = decodeFieldExtractionRule(rule);
  return rules;
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * chrono `DateTime<Utc>` 的 serde 形式：`to_rfc3339_opts(AutoSi, use_z = true)`。
 * 解析失败时 Rust 用 `Utc::now()`（并写 warn 日志）。
 */
export function chronoUtcWire(raw: string, now: () => Date): string {
  const parsed = parseRfc3339(raw);
  if (parsed !== null) {
    // chrono represents leap seconds as second=59 plus nanos >= 1e9.
    const leap = parsed.nanos >= 1_000_000_000;
    const utc = toRfc3339Opts(parsed.epochNanos - (leap ? 1_000_000_000n : 0n), 'AutoSi', true);
    return leap ? `${utc.slice(0, 17)}60${utc.slice(19)}` : utc;
  }
  return toRfc3339Opts(BigInt(now().getTime()) * 1_000_000n, 'AutoSi', true);
}

/** `Vec<String>` 列的宽松解码（Rust `serde_json::from_str(..).unwrap_or_default()`）。 */
function decodeStringArrayLenient(text: string): string[] {
  try {
    const value = JSON.parse(text) as unknown;
    if (!Array.isArray(value)) return [];
    return value.every((item) => typeof item === 'string') ? (value as string[]) : [];
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}

/** `HashMap<String, FieldExtractionRule>` 列的宽松解码（任一规则失败 -> 空表）。 */
function decodeRulesLenient(text: string): Record<string, DecodedFieldExtractionRule> {
  try {
    return decodeFieldExtractionRules(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof SerdeError) return {};
    throw error;
  }
}

/** `get_all_custom_templates` / `get_custom_template_by_id` 的行解码。 */
export function decodeTemplateRow(row: TemplateRow, now: () => Date, logger?: AnkiLogger): CustomAnkiTemplate {
  const timestamp = (key: 'created_at' | 'updated_at'): string => {
    if (parseRfc3339(row[key]) === null) {
      logger?.warn(`无法解析 ${key} 日期: '${row[key]}', 使用当前时间`);
    }
    return chronoUtcWire(row[key], now);
  };
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    author: row.author,
    version: row.version,
    preview_front: row.preview_front,
    preview_back: row.preview_back,
    note_type: row.note_type,
    fields: decodeStringArrayLenient(row.fields_json),
    generation_prompt: row.generation_prompt,
    front_template: row.front_template,
    back_template: row.back_template,
    css_style: row.css_style,
    field_extraction_rules: decodeRulesLenient(row.field_extraction_rules_json) as unknown as CustomAnkiTemplate['field_extraction_rules'],
    created_at: timestamp('created_at'),
    updated_at: timestamp('updated_at'),
    is_active: row.is_active !== 0,
    is_built_in: row.is_built_in !== 0,
    preview_data_json: row.preview_data_json,
  };
}

/** JSON 语法错误的 serde 风格文案（`expected value at line 1 column 1`）。 */
function syntaxMessage(error: SyntaxError): string {
  const match = /position (\d+)/.exec(error.message);
  if (!match) return 'expected value at line 1 column 1';
  const position = Number(match[1]);
  // 调用方已确认原文可解析到该位置，按 UTF-16 偏移近似 serde 的 1-based 行列。
  return `expected value at line 1 column ${position + 1}`;
}

function decodeTimestamp(object: Record<string, unknown>, key: string): string {
  const raw = requiredString(object, key);
  if (!RFC3339.test(raw)) {
    throw new SerdeError(`invalid value: string ${JSON.stringify(raw)}, expected an RFC 3339 formatted date-time`);
  }
  return chronoUtcWire(raw, () => new Date());
}

/** `serde_json::from_str::<CustomAnkiTemplate>`（`import_template` 的解析步骤）。 */
export function decodeCustomTemplateJson(text: string): CustomAnkiTemplate {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new SerdeError(syntaxMessage(error));
    throw error;
  }
  const object = asRecord(raw, 'struct CustomAnkiTemplate');
  return {
    id: requiredString(object, 'id'),
    name: requiredString(object, 'name'),
    description: requiredString(object, 'description'),
    author: optionalString(object, 'author'),
    version: requiredString(object, 'version'),
    preview_front: requiredString(object, 'preview_front'),
    preview_back: requiredString(object, 'preview_back'),
    note_type: requiredString(object, 'note_type'),
    fields: requiredStringArray(object, 'fields'),
    generation_prompt: requiredString(object, 'generation_prompt'),
    front_template: requiredString(object, 'front_template'),
    back_template: requiredString(object, 'back_template'),
    css_style: requiredString(object, 'css_style'),
    field_extraction_rules: (() => {
      if (!Object.hasOwn(object, 'field_extraction_rules')) missingField('field_extraction_rules');
      return decodeFieldExtractionRules(object.field_extraction_rules) as unknown as CustomAnkiTemplate['field_extraction_rules'];
    })(),
    created_at: decodeTimestamp(object, 'created_at'),
    updated_at: decodeTimestamp(object, 'updated_at'),
    is_active: requiredBool(object, 'is_active'),
    is_built_in: requiredBool(object, 'is_built_in'),
    preview_data_json: optionalString(object, 'preview_data_json'),
  };
}

export function serializeFieldExtractionRule(rule: FieldExtractionRule__De): Record<string, unknown> {
  const out: Record<string, unknown> = {
    field_type: rule.field_type,
    is_required: rule.is_required,
    default_value: rule.default_value ?? null,
    validation_pattern: rule.validation_pattern ?? null,
    description: rule.description,
  };
  for (const key of OPTIONAL_RULE_KEYS) {
    const value = rule[key];
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return out;
}

/** `serde_json::to_string_pretty(&CustomAnkiTemplate)`（`export_template`）。 */
export function prettyTemplateJson(template: CustomAnkiTemplate): string {
  const rules: Record<string, unknown> = {};
  for (const key of Object.keys(template.field_extraction_rules).sort()) {
    rules[key] = serializeFieldExtractionRule(template.field_extraction_rules[key]!);
  }
  return JSON.stringify(
    {
      id: template.id,
      name: template.name,
      description: template.description,
      author: template.author,
      version: template.version,
      preview_front: template.preview_front,
      preview_back: template.preview_back,
      note_type: template.note_type,
      fields: template.fields,
      generation_prompt: template.generation_prompt,
      front_template: template.front_template,
      back_template: template.back_template,
      css_style: template.css_style,
      field_extraction_rules: rules,
      created_at: template.created_at,
      updated_at: template.updated_at,
      is_active: template.is_active,
      is_built_in: template.is_built_in,
      preview_data_json: template.preview_data_json,
    },
    null,
    2,
  );
}

/** `database/mod.rs:2697-2710`。 */
export function incrementVersion(version: string): string {
  const parts = version.split('.');
  if (parts.length === 3) {
    const [major, minor, patch] = parts;
    const parse = (part: string | undefined): number | null => {
      if (part === undefined || !/^\d+$/.test(part)) return null;
      const value = Number(part);
      return value <= 0xffff_ffff ? value : null;
    };
    const [maj, min, pat] = [parse(major), parse(minor), parse(patch)];
    if (maj !== null && min !== null && pat !== null) return `${maj}.${min}.${pat + 1}`;
  }
  return '1.0.1';
}

/** `commands.rs:6045-6106`。 */
export function buildTemplateRequestForUpdate(existing: CustomAnkiTemplate, request: UpdateTemplateRequest): CreateTemplateRequest {
  return {
    name: request.name ?? existing.name,
    description: request.description ?? existing.description,
    author: request.author ?? existing.author,
    version: request.version ?? existing.version,
    preview_front: request.preview_front ?? existing.preview_front,
    preview_back: request.preview_back ?? existing.preview_back,
    note_type: request.note_type ?? existing.note_type,
    fields: request.fields ?? existing.fields,
    generation_prompt: request.generation_prompt ?? existing.generation_prompt,
    front_template: request.front_template ?? existing.front_template,
    back_template: request.back_template ?? existing.back_template,
    css_style: request.css_style ?? existing.css_style,
    field_extraction_rules: request.field_extraction_rules ?? existing.field_extraction_rules,
    preview_data_json: request.preview_data_json ?? existing.preview_data_json,
    is_active: request.is_active ?? existing.is_active,
    is_built_in: request.is_built_in ?? existing.is_built_in,
  };
}

/** `commands.rs:6198-6227`。 */
const ANKI_SPECIAL_PLACEHOLDERS = new Set(['FrontSide', 'Tags', 'Type', 'Deck', 'Subdeck', 'Card', 'Flags', 'CardFlag']);

export function extractTemplateFieldRefs(template: string): Set<string> {
  const refs = new Set<string>();
  let rest = template;
  while (true) {
    const start = rest.indexOf('{{');
    if (start < 0) break;
    rest = rest.slice(start + 2);
    const end = rest.indexOf('}}');
    if (end < 0) break;
    const raw = rustTrim(rest.slice(0, end));
    rest = rest.slice(end + 2);
    const stripped = rustTrim(raw.replace(/^[#/^]+/, ''));
    const segments = stripped.split(':');
    const field = rustTrim(segments[segments.length - 1] ?? stripped);
    if (field === '' || ANKI_SPECIAL_PLACEHOLDERS.has(field)) continue;
    refs.add(field);
  }
  return refs;
}

/** `commands.rs:6109-6191`：返回校验失败文案（`AppError::validation`），通过返回 null。 */
export function validateTemplateRequest(request: CreateTemplateRequest, logger?: AnkiLogger): string | null {
  if (!rustTrim(request.name)) return '模板名称不能为空';
  if (request.fields.length === 0) return '模板必须至少包含一个字段';
  if (!rustTrim(request.front_template)) return '正面模板不能为空';
  if (!rustTrim(request.back_template)) return '背面模板不能为空';
  if (!rustTrim(request.generation_prompt)) return '生成提示词不能为空';
  for (const field of request.fields) {
    if (!Object.hasOwn(request.field_extraction_rules, field)) return `缺少字段 '${field}' 的提取规则`;
  }
  const fieldSet = new Set(request.fields);
  const extraRules = Object.keys(request.field_extraction_rules).filter((key) => !fieldSet.has(key));
  if (extraRules.length) return `字段提取规则包含未定义字段: ${extraRules.join(', ')}`;
  if (request.note_type.toLowerCase().includes('cloze') && !request.front_template.includes('{{cloze:')) {
    return `Cloze 模板「${request.name}」的正面模板缺少 {{cloze:字段}} 占位符，Anki 无法生成填空卡片`;
  }
  const references = new Set([
    ...extractTemplateFieldRefs(request.front_template),
    ...extractTemplateFieldRefs(request.back_template),
  ]);
  const unknownRefs = [...references].filter((field) => !fieldSet.has(field)).sort();
  if (unknownRefs.length > 0) {
    logger?.warn(`模板「${request.name}」的 front/back 模板引用了 fields 之外的字段: ${unknownRefs.join(', ')}（渲染时将为空白，请核对字段定义）`);
  }
  return null;
}

const U64_MAX = 18_446_744_073_709_551_615n;

/** `commands.rs:5304-5328`：每段取前导 ASCII 数字（允许 `1.0.0-beta`），空段或全非数字 -> null。 */
export function parseTemplateVersionParts(version: string): bigint[] | null {
  const trimmed = version.trim();
  if (trimmed === '') return null;
  const parts: bigint[] = [];
  for (const segment of trimmed.split('.')) {
    if (segment === '') return null;
    const digits = /^\d+/.exec(segment)?.[0];
    if (digits === undefined) return null;
    const value = BigInt(digits);
    if (value > U64_MAX) return null;
    parts.push(value);
  }
  return parts.length === 0 ? null : parts;
}

/** `commands.rs:5272-5302` 的版本比较（`Ordering` 的 -1/0/1）。 */
export function compareTemplateVersion(existing: string, builtin: string): -1 | 0 | 1 {
  const a = parseTemplateVersionParts(existing);
  const b = parseTemplateVersionParts(builtin);
  if (a !== null && b !== null) {
    const length = Math.max(a.length, b.length);
    for (let i = 0; i < length; i++) {
      const left = a[i] ?? 0n;
      const right = b[i] ?? 0n;
      if (left < right) return -1;
      if (left > right) return 1;
    }
    return 0;
  }
  if (a === null && b !== null) return existing === builtin ? 0 : -1;
  if (a !== null && b === null) return 0;
  return existing < builtin ? -1 : existing > builtin ? 1 : 0;
}

export function shouldUpdateBuiltinTemplate(existingVersion: string, builtinVersion: string): boolean {
  return compareTemplateVersion(existingVersion, builtinVersion) < 0;
}

export type BuiltinImportAction = { kind: 'preserve'; reason: string } | { kind: 'skip' } | { kind: 'update' };

/** `commands.rs:5249-5270`。 */
export function decideBuiltinImportAction(
  userModified: boolean,
  userDeleted: boolean,
  existingVersion: string,
  builtinVersion: string,
): BuiltinImportAction {
  if (userDeleted) return { kind: 'preserve', reason: '用户已删除，保持停用不复活' };
  if (userModified) return { kind: 'preserve', reason: '用户已修改，保留用户版本' };
  return shouldUpdateBuiltinTemplate(existingVersion, builtinVersion) ? { kind: 'update' } : { kind: 'skip' };
}
