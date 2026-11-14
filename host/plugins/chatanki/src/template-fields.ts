import type { CreateTemplateRequest, FieldExtractionRule, UpdateTemplateRequest } from '../api.ts';
import { cloneAgentJson } from '../../../kernel/agent-api.ts';
import { formatValueNumber, isNumberAtom } from '../../../platform/serde-compat/index.ts';
import { rustTrim } from '../../../platform/util/text.ts';
import {
  deserializeSerdeStruct, serdeBool, serdeF64, serdeMap, serdeOption, serdeString, serdeU32, serdeUnitEnum, serdeVec,
  type SerdeStructField,
} from './serde-struct.ts';

export function valueTypeLabel(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value === 'object' ? 'object' : typeof value;
}

function member(value: unknown, camel: string, snake: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  return Object.hasOwn(obj, camel) ? obj[camel] : obj[snake];
}

function optionalString(value: unknown, camel: string, snake: string): string | null {
  const v = member(value, camel, snake);
  if (v == null) return null;
  if (typeof v !== 'string') throw new Error(`字段 '${camel}' 必须是字符串，实际收到 ${valueTypeLabel(v)}。请传入字符串值`);
  return v;
}

function optionalBool(value: unknown, camel: string, snake: string): boolean | null {
  const v = member(value, camel, snake);
  if (v == null) return null;
  if (typeof v !== 'boolean') throw new Error(`字段 '${camel}' 必须是布尔值，实际收到 ${valueTypeLabel(v)}。请传入 true 或 false`);
  return v;
}

export function extractFields(value: unknown): string[] | null {
  const v = member(value, 'fields', 'fields');
  if (v == null) return null;
  if (!Array.isArray(v)) throw new Error(`fields 必须是字符串数组，实际收到 ${valueTypeLabel(v)}。请传入如 ["Front", "Back"]`);
  return v.map((item, index) => {
    if (typeof item !== 'string') throw new Error(`fields[${index}] 必须是字符串，实际收到 ${valueTypeLabel(item)}。所有字段名必须是字符串`);
    return item;
  });
}

// The serde shapes of dstu-core/src/models.rs:1515–1571 (no rename_all). Output mirrors their
// Serialize: struct field order, `None` as null unless `skip_serializing_if = "Option::is_none"`.
interface ModelField extends SerdeStructField { readonly skipNone?: boolean }

function modelStruct(name: string, fields: readonly ModelField[]): (value: unknown) => Record<string, unknown> {
  return (value) => {
    const values = deserializeSerdeStruct(value, name, fields, false);
    const output: Record<string, unknown> = {};
    fields.forEach((field, index) => {
      const decoded = values[index] ?? null;
      if (field.skipNone !== true || decoded !== null) output[field.name] = decoded;
    });
    return output;
  };
}

const optionString = serdeOption(serdeString);
const optionValues = serdeOption(serdeVec((value: unknown) => cloneAgentJson(value)));
const VALIDATION_RULE = modelStruct('ValidationRule', [
  { name: 'pattern', option: true, read: optionString },
  { name: 'min', option: true, read: serdeOption(serdeF64) },
  { name: 'max', option: true, read: serdeOption(serdeF64) },
  { name: 'enum_values', option: true, read: optionValues },
  { name: 'custom', option: true, read: optionString },
  { name: 'error_message', option: true, read: optionString },
]);
const TRANSFORM_RULE = modelStruct('TransformRule', [
  { name: 'transform_type', read: serdeString },
  { name: 'format', option: true, read: optionString },
  { name: 'custom_function', option: true, read: optionString },
]);
const OBJECT_SCHEMA = modelStruct('ObjectSchema', [
  { name: 'properties', read: (value) => FIELD_EXTRACTION_RULES(value) },
  { name: 'required', option: true, read: serdeOption(serdeVec(serdeString)) },
]);
const SKIPPED_OPTION = { option: true, default: true, skipNone: true } as const;
const FIELD_EXTRACTION_RULE = modelStruct('FieldExtractionRule', [
  { name: 'field_type', read: serdeUnitEnum(['Text', 'Array', 'Number', 'Boolean', 'Date', 'RichText', 'Formula']) },
  { name: 'is_required', read: serdeBool },
  { name: 'default_value', option: true, read: optionString },
  { name: 'validation_pattern', option: true, read: optionString },
  { name: 'description', read: serdeString },
  { name: 'validation', ...SKIPPED_OPTION, read: serdeOption(VALIDATION_RULE) },
  { name: 'transform', ...SKIPPED_OPTION, read: serdeOption(TRANSFORM_RULE) },
  { name: 'schema', ...SKIPPED_OPTION, read: serdeOption(OBJECT_SCHEMA) },
  { name: 'item_schema', ...SKIPPED_OPTION, read: serdeOption(OBJECT_SCHEMA) },
  { name: 'display_format', ...SKIPPED_OPTION, read: optionString },
  { name: 'ai_hint', ...SKIPPED_OPTION, read: optionString },
  { name: 'max_length', ...SKIPPED_OPTION, read: serdeOption(serdeU32) },
  { name: 'min_length', ...SKIPPED_OPTION, read: serdeOption(serdeU32) },
  { name: 'allowed_values', ...SKIPPED_OPTION, read: optionValues },
  { name: 'depends_on', ...SKIPPED_OPTION, read: optionString },
  { name: 'compute_function', ...SKIPPED_OPTION, read: optionString },
]);
const FIELD_EXTRACTION_RULES = serdeMap(FIELD_EXTRACTION_RULE);

export function extractRules(value: unknown): Record<string, FieldExtractionRule> | null {
  const v = member(value, 'fieldExtractionRules', 'field_extraction_rules');
  if (v == null) return null;
  try { return FIELD_EXTRACTION_RULES(v) as unknown as Record<string, FieldExtractionRule>; }
  catch (error) {
    throw new Error(`fieldExtractionRules 格式错误: ${(error as Error).message}。请确保每个规则包含 field_type, is_required, description 字段`);
  }
}

export type ParsedCreateTemplateRequest = CreateTemplateRequest & {
  author: string | null; version: string | null; preview_data_json: string | null;
  is_active: boolean | null; is_built_in: boolean | null;
  field_extraction_rules: Record<string, FieldExtractionRule>;
};

export function parseCreateRequest(value: unknown): ParsedCreateTemplateRequest {
  return {
    name: optionalString(value, 'name', 'name') ?? '',
    description: optionalString(value, 'description', 'description') ?? '',
    author: optionalString(value, 'author', 'author'), version: optionalString(value, 'version', 'version'),
    note_type: optionalString(value, 'noteType', 'note_type') ?? 'Basic',
    preview_front: optionalString(value, 'previewFront', 'preview_front') ?? '',
    preview_back: optionalString(value, 'previewBack', 'preview_back') ?? '',
    front_template: optionalString(value, 'frontTemplate', 'front_template') ?? '',
    back_template: optionalString(value, 'backTemplate', 'back_template') ?? '',
    css_style: optionalString(value, 'cssStyle', 'css_style') ?? '',
    generation_prompt: optionalString(value, 'generationPrompt', 'generation_prompt') ?? '',
    preview_data_json: optionalString(value, 'previewDataJson', 'preview_data_json'),
    is_active: optionalBool(value, 'isActive', 'is_active'), is_built_in: optionalBool(value, 'isBuiltIn', 'is_built_in'),
    fields: extractFields(value) ?? [], field_extraction_rules: extractRules(value) ?? {},
  };
}

function versionToken(value: unknown): string | null {
  const v = member(value, 'expectedVersion', 'expected_version');
  if (v == null) return null;
  if (isNumberAtom(v)) return formatValueNumber(v, 'int');
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  throw new Error(`字段 'expectedVersion' 必须是字符串或数字，实际收到 ${valueTypeLabel(v)}。请传入版本号字符串（如 "1.0.0"）`);
}

export function parseUpdateRequest(value: unknown): UpdateTemplateRequest {
  return {
    name: optionalString(value, 'name', 'name'), description: optionalString(value, 'description', 'description'),
    author: optionalString(value, 'author', 'author'), version: optionalString(value, 'version', 'version'),
    expected_version: versionToken(value),
    preview_front: optionalString(value, 'previewFront', 'preview_front'),
    preview_back: optionalString(value, 'previewBack', 'preview_back'), note_type: optionalString(value, 'noteType', 'note_type'),
    generation_prompt: optionalString(value, 'generationPrompt', 'generation_prompt'),
    front_template: optionalString(value, 'frontTemplate', 'front_template'), back_template: optionalString(value, 'backTemplate', 'back_template'),
    css_style: optionalString(value, 'cssStyle', 'css_style'), preview_data_json: optionalString(value, 'previewDataJson', 'preview_data_json'),
    is_active: optionalBool(value, 'isActive', 'is_active'), is_built_in: optionalBool(value, 'isBuiltIn', 'is_built_in'),
    fields: extractFields(value), field_extraction_rules: extractRules(value),
  };
}

export function hasUpdateChanges(req: UpdateTemplateRequest): boolean {
  return Object.entries(req).some(([key, value]) => key !== 'expected_version' && key !== 'is_built_in' && value != null);
}

export function validateTemplateInternal(req: CreateTemplateRequest): [string[], string[]] {
  const errors: string[] = [], warnings: string[] = [];
  if (!rustTrim(req.name)) errors.push('name 不能为空。请提供模板名称');
  if (!req.fields.length) errors.push('fields 不能为空。请至少定义一个字段（如 ["Front", "Back"]）');
  if (!rustTrim(req.front_template)) errors.push('frontTemplate 不能为空。请提供 Anki 正面模板 HTML');
  if (!rustTrim(req.back_template)) errors.push('backTemplate 不能为空。请提供 Anki 背面模板 HTML');
  if (!rustTrim(req.generation_prompt)) errors.push('generationPrompt 不能为空。请提供 AI 生成卡片的指导提示词');
  for (const field of req.fields) {
    if (!Object.hasOwn(req.field_extraction_rules, field)) errors.push(`字段 '${field}' 缺少对应的 fieldExtractionRules 条目。请为该字段添加提取规则`);
  }
  const extra = Object.keys(req.field_extraction_rules).filter((key) => !req.fields.includes(key));
  if (extra.length) errors.push(`fieldExtractionRules 包含未在 fields 中定义的字段: ${extra.join(', ')}。请将这些字段加入 fields 或移除多余规则`);
  if (req.note_type.replace(/[A-Z]/g, (s) => s.toLowerCase()).includes('cloze') && !req.front_template.includes('{{cloze:')) {
    errors.push(`Cloze 模板「${req.name}」的正面模板缺少 {{cloze:字段}} 占位符，Anki 无法生成填空卡片。请在 frontTemplate 中加入 {{cloze:Text}} 之类的占位符`);
  }
  if (!rustTrim(req.description)) warnings.push('description 为空，建议补充模板描述以便检索');
  if (req.front_template.includes('{{FrontSide}}')) warnings.push('frontTemplate 中使用了 {{FrontSide}}：该占位符仅在背面模板生效，正面会渲染为空');
  if (!rustTrim(req.css_style)) warnings.push('cssStyle 为空，将使用默认样式');
  if (!rustTrim(req.preview_front) || !rustTrim(req.preview_back)) warnings.push('previewFront/previewBack 为空，模板列表中将无法展示预览');
  return [errors, warnings];
}

export function normalizeTemplateFields(fields: string[]): string[] { return fields.length ? [...fields] : ['front', 'back', 'tags']; }
export function ensureFieldExtractionRules(fields: string[], rules: Record<string, FieldExtractionRule>): Record<string, FieldExtractionRule> {
  const result = cloneAgentJson(rules);
  for (const field of normalizeTemplateFields(fields)) {
    if (!Object.hasOwn(result, field)) {
      const lower = field.toLowerCase();
      Object.defineProperty(result, field, { enumerable: true, writable: true, configurable: true, value: {
        field_type: lower === 'tags' ? 'Array' : 'Text', is_required: lower === 'front' || lower === 'back',
        default_value: lower === 'tags' ? '[]' : null, validation_pattern: null, description: field,
      } });
    }
  }
  return result;
}
export function calculateComplexityLevel(count: number, noteType: string): string {
  if (count <= 2 && noteType.replace(/[A-Z]/g, (s) => s.toLowerCase()) !== 'cloze') return 'simple';
  if (count <= 4) return 'moderate';
  if (count <= 6) return 'complex';
  return 'very_complex';
}
