// RUST-FIX(RF-W35-config-schema-form): Rust 版插件配置是写死的字段表，没有可序列化 schema → 表单的投影。
/**
 * 可序列化 Schemastery Config → 表单字段 / 默认值 / 校验。
 *
 * Host 把插件 `Config` 投影成 {@link PluginConfigSchemaNode}（W01）。这里只做“消费侧”的规范化：
 * 顶层 object 的 boolean / string / number / 常量联合（enum）渲染成控件；其余节点报为不支持并在表单上明示，
 * 绝不静默丢弃。保存时以 Host 原值为底、只覆盖可编辑字段，未渲染的键原样带回。
 */
import type {
  PluginConfigSchemaMeta,
  PluginConfigSchemaNode,
} from './types';

export interface PluginConfigOption {
  readonly value: string | number | boolean;
  readonly label: string;
}

interface PluginConfigFieldBase {
  readonly key: string;
  readonly description?: string;
  /** 投影显式声明 `required(true)` 时才必填；缺省按可选处理。 */
  readonly required: boolean;
  readonly defaultValue?: string | number | boolean;
}

export type PluginConfigField =
  | (PluginConfigFieldBase & { readonly kind: 'boolean' })
  | (PluginConfigFieldBase & { readonly kind: 'string'; readonly pattern?: string })
  | (PluginConfigFieldBase & { readonly kind: 'number'; readonly min?: number; readonly max?: number; readonly step?: number })
  | (PluginConfigFieldBase & { readonly kind: 'enum'; readonly options: readonly PluginConfigOption[] });

export interface PluginConfigForm {
  readonly fields: readonly PluginConfigField[];
  /** 无法渲染的顶层 key（数组、嵌套对象、非闭合联合等），用于提示与保存时保留原值。 */
  readonly unsupported: readonly string[];
}

export const EMPTY_CONFIG_FORM: PluginConfigForm = Object.freeze({ fields: [], unsupported: [] });

export type PluginConfigIssueRule = 'required' | 'boolean' | 'string' | 'number' | 'range' | 'enum' | 'pattern';

export interface PluginConfigIssue {
  readonly field: string;
  readonly rule: PluginConfigIssueRule;
}

const isOptionValue = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

const defaultFor = (node: { readonly meta?: PluginConfigSchemaMeta }, kind: 'boolean' | 'string' | 'number'): string | number | boolean | undefined => {
  const value = node.meta?.default;
  return typeof value === kind ? (value as string | number | boolean) : undefined;
};

/** 常量联合是否构成闭合 enum（Schemastery 的 enum 投影）。 */
function enumOptions(list: readonly PluginConfigSchemaNode[]): PluginConfigOption[] | null {
  const options: PluginConfigOption[] = [];
  for (const node of list) {
    if (node.type !== 'const' || !isOptionValue(node.value)) return null;
    options.push({ value: node.value, label: node.meta?.description ?? String(node.value) });
  }
  return options;
}

function fieldOf(key: string, node: PluginConfigSchemaNode): PluginConfigField | null {
  const meta = node.meta ?? {};
  const base = { key, description: meta.description, required: meta.required === true };
  switch (node.type) {
    case 'boolean':
      return { ...base, kind: 'boolean', defaultValue: defaultFor(node, 'boolean') };
    case 'string':
      return { ...base, kind: 'string', pattern: typeof meta.pattern === 'string' ? meta.pattern : undefined, defaultValue: defaultFor(node, 'string') };
    case 'number':
      return {
        ...base,
        kind: 'number',
        min: typeof meta.min === 'number' ? meta.min : undefined,
        max: typeof meta.max === 'number' ? meta.max : undefined,
        step: typeof meta.step === 'number' ? meta.step : undefined,
        defaultValue: defaultFor(node, 'number'),
      };
    case 'union': {
      const options = enumOptions(node.list);
      if (!options?.length) return null;
      const fallback = isOptionValue(meta.default) && options.some((option) => option.value === meta.default)
        ? meta.default
        : options[0]!.value;
      return { ...base, kind: 'enum', options, defaultValue: fallback };
    }
    case 'const':
      return isOptionValue(node.value)
        ? { ...base, kind: 'enum', options: [{ value: node.value, label: String(node.value) }], defaultValue: node.value }
        : null;
    default:
      return null;
  }
}

/** 投影 → 表单。schema 为 null（插件没有 Config）时返回空表单。 */
export function pluginConfigForm(schema: PluginConfigSchemaNode | null | undefined): PluginConfigForm {
  if (!schema) return EMPTY_CONFIG_FORM;
  if (schema.type !== 'object') return { fields: [], unsupported: ['$'] };
  const fields: PluginConfigField[] = [];
  const unsupported: string[] = [];
  for (const [key, node] of Object.entries(schema.dict)) {
    const field = fieldOf(key, node);
    if (field) fields.push(field);
    else unsupported.push(key);
  }
  return { fields, unsupported };
}

/**
 * 表单初值：Host 原值 → 补齐默认值。未渲染的键（含 unsupported）原样保留，
 * 保存时不会被表单抹掉。
 */
export function pluginConfigValues(
  form: PluginConfigForm,
  values: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(values ?? {}) };
  for (const field of form.fields) {
    if (next[field.key] === undefined && field.defaultValue !== undefined) next[field.key] = field.defaultValue;
  }
  return next;
}

/** 只校验可渲染字段；返回按字段顺序的 issue 列表。 */
export function validatePluginConfig(
  form: PluginConfigForm,
  values: Readonly<Record<string, unknown>>,
): PluginConfigIssue[] {
  const issues: PluginConfigIssue[] = [];
  for (const field of form.fields) {
    const value = values[field.key];
    if (value === undefined || value === '') {
      if (field.required) issues.push({ field: field.key, rule: 'required' });
      continue;
    }
    switch (field.kind) {
      case 'boolean':
        if (typeof value !== 'boolean') issues.push({ field: field.key, rule: 'boolean' });
        break;
      case 'string':
        if (typeof value !== 'string') issues.push({ field: field.key, rule: 'string' });
        else if (field.pattern && !new RegExp(field.pattern).test(value)) issues.push({ field: field.key, rule: 'pattern' });
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) issues.push({ field: field.key, rule: 'number' });
        else if ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) {
          issues.push({ field: field.key, rule: 'range' });
        }
        break;
      case 'enum':
        if (!field.options.some((option) => option.value === value)) issues.push({ field: field.key, rule: 'enum' });
        break;
    }
  }
  return issues;
}

/** 输入框文本 → 字段值；空字符串表示“未填”，整数/小数按 number 解析。 */
export function parseConfigNumber(text: string): number | undefined | null {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}
