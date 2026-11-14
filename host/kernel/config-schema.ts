/**
 * 插件配置 schema 的可序列化投影（插件生态 v1 P1-3）：把 `HostPlugin.Config`（Schemastery）转成 UI 管理器
 * 能直接渲染的纯 JSON 描述。同一份投影供 `plugin:manager|config` 返回，W35 据此生成
 * boolean Switch、enum SegmentedControl、string/number Input；未知 / 复杂节点退化为 `json`，由 UI 原样编辑。
 *
 * 只投影、不校验：值校验仍由 {@link resolvePluginConfig}（`~standard`.validate + 凭据检查）负责。
 * 可移植：不依赖 Node 内建模块。
 */
import type Schema from '@deepseek-ai/schemastery';
import { findNonJson, toWireJson } from './json.ts';

/** 投影后的字段类型。`json` 表示无法拆成表单控件，值按 JSON 原样编辑。 */
export type ConfigFieldType = 'boolean' | 'string' | 'number' | 'enum' | 'object' | 'json';

export interface ConfigFieldProjection {
  /** 相对配置根的字段路径，如 `a.b`；`object` 子字段以它继续嵌套。 */
  path: string;
  type: ConfigFieldType;
  /** meta.default（已投影为纯 JSON）。 */
  default?: unknown;
  /** meta.required（缺省值不能当作“已填写”）。 */
  required?: boolean;
  /** meta.description 的文字部分（本地化字典取 en 或 zh，见 {@link describe}）。 */
  description?: string;
  /** meta.role，如 `text` / `slider` / `textarea`；UI 可据此选择控件变体。 */
  role?: string;
  hidden?: boolean;
  disabled?: boolean;
  /** string：正则（source 形式，不带分隔符）。 */
  pattern?: string;
  /** string：长度区间；number：取值区间（schema meta.min/max 同名）。 */
  min?: number;
  max?: number;
  /** number：步长。 */
  step?: number;
  /** enum 的可选值（按 schema 声明顺序）。 */
  options?: readonly (string | number)[];
  /** object 的子字段（隐藏字段也在其中，UI 决定是否渲染）。 */
  fields?: readonly ConfigFieldProjection[];
  /** `json` 的原因（`any`、`dict`、`tuple`、`transform`、联合了非常量等）。 */
  reason?: string;
}

export interface ConfigSchemaProjection {
  /** 根对象字段；空数组表示没有可编辑字段。 */
  fields: readonly ConfigFieldProjection[];
}

interface SchemaNode {
  type?: unknown;
  meta?: {
    default?: unknown;
    required?: unknown;
    description?: unknown;
    comment?: unknown;
    role?: unknown;
    hidden?: unknown;
    disabled?: unknown;
    pattern?: unknown;
    min?: unknown;
    max?: unknown;
    step?: unknown;
  };
  dict?: Record<string, SchemaNode>;
  inner?: SchemaNode;
  list?: SchemaNode[];
  value?: unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function isSchemastery(value: unknown): value is SchemaNode {
  return typeof value === 'function' && typeof (value as SchemaNode).type === 'string' && isObject((value as SchemaNode).meta);
}

/** `meta.description` 支持字符串或本地化字典；取中文优先，其次英文，再取第一个字符串值。 */
function describe(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (!isObject(value)) return undefined;
  for (const key of ['zh', 'zh-CN', 'en', 'en-US']) if (typeof value[key] === 'string' && value[key]) return value[key] as string;
  return Object.values(value).find((item): item is string => typeof item === 'string' && item.length > 0);
}

/** 纯 JSON 化默认值；失败时不带默认值（不把函数 / 类实例塞进命令结果）。 */
function plainDefault(value: unknown): { ok: true; value: unknown } | { ok: false } {
  if (value === undefined) return { ok: false };
  if (findNonJson(value, '$', new Set()) !== null) return { ok: false };
  return { ok: true, value: toWireJson(value) };
}

function numberMeta(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 联合是否是常量枚举（全部成员是 string/number 的 `const`）。 */
function enumOptions(node: SchemaNode): (string | number)[] | null {
  if (node.type !== 'union' || !Array.isArray(node.list) || node.list.length === 0) return null;
  const options: (string | number)[] = [];
  for (const item of node.list) {
    if (item?.type !== 'const') return null;
    const value = item.value;
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    if (!options.includes(value)) options.push(value);
  }
  return options;
}

function projectNode(path: string, node: SchemaNode, seen: Set<unknown>, depth: number): ConfigFieldProjection {
  const meta = node.meta ?? {};
  const field: ConfigFieldProjection = { path, type: 'json' };
  const fallback = (reason: string): ConfigFieldProjection => ({ ...field, reason });
  if (depth > 8) return fallback('nesting is too deep');
  if (seen.has(node)) return fallback('recursive schema');

  const options = enumOptions(node);
  if (options) {
    field.type = 'enum';
    field.options = Object.freeze(options);
  } else if (node.type === 'boolean') {
    field.type = 'boolean';
  } else if (node.type === 'string') {
    field.type = 'string';
    const pattern = meta.pattern as { source?: unknown } | undefined;
    if (typeof pattern?.source === 'string') field.pattern = pattern.source;
    else if (meta.pattern instanceof RegExp) field.pattern = meta.pattern.source;
    const min = numberMeta(meta.min), max = numberMeta(meta.max);
    if (min !== undefined) field.min = min;
    if (max !== undefined) field.max = max;
  } else if (node.type === 'number' || node.type === 'natural' || node.type === 'percent') {
    field.type = 'number';
    const min = numberMeta(meta.min), max = numberMeta(meta.max), step = numberMeta(meta.step);
    if (min !== undefined) field.min = min;
    if (max !== undefined) field.max = max;
    if (step !== undefined) field.step = step;
  } else if (node.type === 'object' && isObject(node.dict)) {
    field.type = 'object';
    seen.add(node);
    const fields: ConfigFieldProjection[] = [];
    for (const [key, child] of Object.entries(node.dict)) {
      if (!isSchemastery(child)) continue;
      fields.push(projectNode(path ? `${path}.${key}` : key, child, seen, depth + 1));
    }
    seen.delete(node);
    field.fields = Object.freeze(fields);
  } else {
    field.type = 'json';
    field.reason = reasonFor(node);
  }

  if (meta.required === true) field.required = true;
  const description = describe(meta.description);
  if (description) field.description = description;
  if (typeof meta.role === 'string' && meta.role) field.role = meta.role;
  if (meta.hidden === true) field.hidden = true;
  if (meta.disabled === true) field.disabled = true;
  const fallbackDefault = plainDefault(meta.default);
  if (fallbackDefault.ok) field.default = fallbackDefault.value;
  return field;
}

function reasonFor(node: SchemaNode): string {
  switch (node.type) {
    case 'object': return 'object schema without a field dictionary';
    case 'array': return 'array values are edited as JSON';
    case 'dict': return 'dictionary values are edited as JSON';
    case 'tuple': return 'tuple values are edited as JSON';
    case 'union': return 'union of non-constant schemas is edited as JSON';
    case 'intersect': return 'intersection values are edited as JSON';
    case 'transform': return 'transformed values are edited as JSON';
    case 'any': return 'unconstrained values are edited as JSON';
    case 'never': return 'no value is accepted';
    default: return `schema type ${JSON.stringify(node.type)} is edited as JSON`;
  }
}

/**
 * 投影插件 `Config`：
 * - 没有 `Config`：`null`（没有可配置项，不是“schema 无效”）；
 * - 不是 Schemastery：抛错（与 {@link resolvePluginConfig} 一致，由调用方转成 CONFIG_INVALID）；
 * - 根不是对象（如 `Schema.boolean()`）：返回一个 `path: ''` 的根字段。
 */
export function projectConfigSchema(schema: unknown): ConfigSchemaProjection | null {
  if (schema === undefined) return null;
  if (!isSchemastery(schema)) throw new TypeError('plugin.Config must be a Schemastery schema');
  if (schema.type === 'object' && isObject(schema.dict)) {
    const seen = new Set<unknown>([schema]);
    const fields: ConfigFieldProjection[] = [];
    for (const [key, child] of Object.entries(schema.dict)) {
      if (!isSchemastery(child)) continue;
      fields.push(projectNode(key, child, seen, 1));
    }
    return { fields };
  }
  return { fields: [projectNode('', schema, new Set(), 0)] };
}
