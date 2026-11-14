/** 月之暗面 Kimi 适配器（adapters/moonshot.rs），含 MFJS 工具 schema 规范化。 */
import type { ApiConfig } from '../../api.ts';
import {
  BaseAdapter, getTrimmedEffort, type JsonObject, type PassbackPolicy,
} from './base.ts';
import { removeKey } from '../json_map.ts';

type JsonValue = unknown;

/** MFJS 支持的关键字（walle model.go SupportedKeywords ∪ FutureKeywords）。 */
const MFJS_SUPPORTED_KEYWORDS = new Set([
  'type', 'properties', 'additionalProperties', 'items', 'enum', 'required', 'anyOf',
  'description', '$defs', '$ref', 'title', '$id', 'default', 'maxLength', 'minLength',
  'maximum', 'minimum', 'maxItems', 'minItems', 'pattern',
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

/** 规范化 OpenAI function 线格式工具数组，返回改写的节点数。 */
export function normalizeToolSchemasForMfjs(tools: JsonValue[]): number {
  let rewrites = 0;
  for (const tool of tools) {
    if (!isObject(tool)) continue;
    const fn = tool.function;
    if (!isObject(fn)) continue;
    const parameters = fn.parameters;
    if (parameters === undefined) continue;
    normalizeMfjsSchemaNode(parameters, true, (count) => { rewrites += count; });
  }
  return rewrites;
}

/** 是否应按 MFJS 方言规范化工具 schema。 */
export function shouldApplyMfjsToolSchemaDialect(config: ApiConfig): boolean {
  const adapter = config.modelAdapter.toLowerCase();
  if (adapter === 'moonshot' || adapter === 'kimi') return true;
  const provider = config.providerType?.toLowerCase();
  if (provider === 'moonshot' || provider === 'kimi') return true;
  const baseUrl = config.baseUrl.toLowerCase();
  if (baseUrl.includes('moonshot.cn') || baseUrl.includes('api.kimi.com')) return true;
  const model = config.model.toLowerCase();
  return model.includes('kimi') || model.includes('moonshot');
}

interface RewriteCounter {
  (count: number): void;
}

function bump(count: RewriteCounter, by = 1): void {
  count(by);
}

/** 递归规范化单个 schema 节点。 */
export function normalizeMfjsSchemaNode(
  node: JsonValue, isRoot: boolean, count: RewriteCounter,
): void {
  if (!isObject(node)) return;

  // 1) oneOf → anyOf
  if (Object.prototype.hasOwnProperty.call(node, 'oneOf')) {
    const oneOf = node.oneOf;
    removeKey(node, 'oneOf');
    if (Array.isArray(oneOf)) {
      const existing = node.anyOf;
      if (Array.isArray(existing)) existing.push(...oneOf);
      else node.anyOf = oneOf;
    }
    bump(count);
  }

  // 2) const → 单值 enum
  if (Object.prototype.hasOwnProperty.call(node, 'const')) {
    const constValue = node.const;
    removeKey(node, 'const');
    if (!Object.prototype.hasOwnProperty.call(node, 'enum')) node.enum = [constValue];
    bump(count);
  }

  // 3) enum 相关规范化
  const enumValues = node.enum;
  const enumAllNull = Array.isArray(enumValues) && enumValues.length > 0
    && enumValues.every((value) => value === null);
  if (enumAllNull) {
    removeKey(node, 'enum');
    node.type = 'null';
    bump(count);
  } else if (!Object.prototype.hasOwnProperty.call(node, 'type') && Array.isArray(enumValues)) {
    const inferred = inferMfjsEnumType(enumValues);
    if (inferred !== null) {
      node.type = inferred;
      bump(count);
    }
  }

  // 4) 丢弃 MFJS 不支持的关键字
  const unsupported = Object.keys(node).filter((key) => !MFJS_SUPPORTED_KEYWORDS.has(key));
  if (unsupported.length > 0) {
    for (const key of unsupported) removeKey(node, key);
    bump(count, unsupported.length);
  }

  // 5) anyOf 同级约束下沉到分支
  const anyOf = node.anyOf;
  const hasUsableAnyOf = Array.isArray(anyOf) && anyOf.length > 0
    && anyOf.every((branch) => isObject(branch));
  if (hasUsableAnyOf && Array.isArray(anyOf)) {
    const branches = anyOf.filter(isObject);
    const annotationConflicts: string[] = [];
    for (const key of ['description', 'title']) {
      if (Object.prototype.hasOwnProperty.call(node, key)
        && branches.some((branch) => Object.prototype.hasOwnProperty.call(branch, key))) {
        annotationConflicts.push(key);
      }
    }
    for (const key of annotationConflicts) {
      removeKey(node, key);
      bump(count);
    }

    const siblingKeys = Object.keys(node).filter((key) => {
      if (key === 'anyOf' || key === 'description' || key === 'title') return false;
      if (isRoot && (key === '$defs' || key === '$id')) return false;
      return true;
    });
    if (siblingKeys.length > 0) {
      const outer: Array<[string, JsonValue]> = siblingKeys.map((key) => [key, node[key]]);
      for (const branch of branches) {
        for (const [key, value] of outer) mergeMfjsBranch(branch, key, value);
      }
      for (const key of siblingKeys) removeKey(node, key);
      bump(count);
    }
  }

  // 6) 递归子 schema
  if (Array.isArray(node.anyOf)) {
    for (const branch of node.anyOf) normalizeMfjsSchemaNode(branch, false, count);
  }
  if (isObject(node.properties)) {
    for (const sub of Object.values(node.properties)) normalizeMfjsSchemaNode(sub, false, count);
  }
  if (isObject(node.$defs)) {
    for (const sub of Object.values(node.$defs)) normalizeMfjsSchemaNode(sub, false, count);
  }
  const items = node.items;
  if (Array.isArray(items)) {
    for (const sub of items) normalizeMfjsSchemaNode(sub, false, count);
  } else if (items !== undefined) {
    normalizeMfjsSchemaNode(items, false, count);
  }
  if (isObject(node.additionalProperties)) {
    normalizeMfjsSchemaNode(node.additionalProperties, false, count);
  }
}

/** 把父级约束并入 anyOf 分支。 */
function mergeMfjsBranch(branch: JsonObject, key: string, value: JsonValue): void {
  if (key === 'required') {
    const existing = branch.required;
    if (Array.isArray(existing)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (!existing.includes(item)) existing.push(deepClone(item));
        }
      }
      return;
    }
  } else if (key === 'properties') {
    const existing = branch.properties;
    if (isObject(existing)) {
      if (isObject(value)) {
        for (const [name, sub] of Object.entries(value)) {
          if (!Object.prototype.hasOwnProperty.call(existing, name)) {
            existing[name] = deepClone(sub);
          }
        }
      }
      return;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(branch, key)) branch[key] = deepClone(value);
}

/** 从 enum 字面量推断 type。 */
function inferMfjsEnumType(values: unknown[]): string | null {
  if (values.length === 0) return null;
  if (values.every((value) => typeof value === 'string')) return 'string';
  if (values.every((value) => typeof value === 'boolean')) return 'boolean';
  if (values.every((value) => typeof value === 'number')) {
    const allIntegral = values.every((value) => Number.isInteger(value as number));
    return allIntegral ? 'integer' : 'number';
  }
  return null;
}

export function parseKVersion(model: string): [number, number] | null {
  const lower = model.toLowerCase();
  let index = lower.indexOf('k');
  while (index !== -1) {
    const previous = index > 0 ? lower[index - 1]! : '';
    if (index === 0 || !/^[a-z0-9]$/i.test(previous)) {
      const rest = lower.slice(index + 1);
      const majorMatch = /^\d+/.exec(rest);
      if (majorMatch !== null) {
        const major = Number.parseInt(majorMatch[0], 10);
        const afterMajor = rest.slice(majorMatch[0].length);
        let minor = 0;
        if (afterMajor.startsWith('.') || afterMajor.startsWith('-')) {
          const digits = /^\d+/.exec(afterMajor.slice(1));
          if (digits !== null && digits[0].length >= 1 && digits[0].length <= 2) {
            minor = Number.parseInt(digits[0], 10);
          }
        }
        return [major, minor];
      }
    }
    index = lower.indexOf('k', index + 1);
  }
  return null;
}

function isK25OrLater(model: string): boolean {
  const version = parseKVersion(model);
  return version !== null && version[0] === 2 && version[1] >= 5;
}

function isK3OrLater(model: string): boolean {
  const version = parseKVersion(model);
  return version !== null && version[0] >= 3;
}

function normalizeK3Effort(effort: string | null): string {
  switch (effort?.trim().toLowerCase()) {
    case 'minimal': case 'low': return 'low';
    case 'medium': case 'high': return 'high';
    case 'xhigh': case 'max': case 'ultra': return 'max';
    case 'none': case 'unset': case 'off': case 'disabled': return 'low';
    default: return 'max';
  }
}

function supportsThinkingKeep(model: string): boolean {
  const version = parseKVersion(model);
  return version !== null && version[0] === 2 && version[1] >= 6;
}

function isForcedThinkingCodeModel(model: string): boolean {
  const version = parseKVersion(model);
  const isK27OrLater = version !== null && version[0] === 2 && version[1] >= 7;
  return isK27OrLater && model.toLowerCase().includes('code');
}

function isThinkingModel(model: string): boolean {
  return model.toLowerCase().includes('thinking')
    || isK25OrLater(model)
    || isK3OrLater(model);
}

const MIN_MAX_TOKENS_FOR_THINKING = 16_000;
const RECOMMENDED_MAX_TOKENS = 32_000;
const K25_DEFAULT_MAX_TOKENS = 32_768;

export class MoonshotAdapter extends BaseAdapter {
  override readonly id: string = 'moonshot';
  override get label(): string { return 'Kimi/Moonshot'; }
  override get description(): string {
    return 'Kimi K2.5–K2.7 thinking 与 K3 reasoning_effort 参数适配';
  }

  static parseKVersion(model: string): [number, number] | null {
    return parseKVersion(model);
  }

  static isK25OrLater(model: string): boolean {
    return isK25OrLater(model);
  }

  static isK3OrLater(model: string): boolean {
    return isK3OrLater(model);
  }

  override applyReasoningConfig(
    body: JsonObject, config: ApiConfig, enableThinking: boolean | null,
  ): boolean {
    if (isK3OrLater(config.model)) {
      removeKey(body, 'thinking');
      removeKey(body, 'enable_thinking');
      removeKey(body, 'thinking_budget');
      removeKey(body, 'include_thoughts');
      const requested = getTrimmedEffort(config);
      body.reasoning_effort = normalizeK3Effort(requested);
      return true;
    }

    const isNewGen = isK25OrLater(config.model);
    const isThinking = isThinkingModel(config.model);

    if (isNewGen) {
      const forcedThinking = isForcedThinkingCodeModel(config.model);
      const thinkingEnabled = forcedThinking
        ? true
        : enableThinking ?? config.enableThinking ?? true;

      const thinkingMap: JsonObject = { type: thinkingEnabled ? 'enabled' : 'disabled' };
      if (supportsThinkingKeep(config.model)
        && thinkingEnabled
        && (forcedThinking || config.includeThoughts)) {
        thinkingMap.keep = 'all';
      }
      body.thinking = thinkingMap;

      removeKey(body, 'temperature');
      removeKey(body, 'top_p');
      removeKey(body, 'n');
      removeKey(body, 'presence_penalty');
      removeKey(body, 'frequency_penalty');

      const legacyMaxTokens = typeof body.max_tokens === 'number'
        && Number.isInteger(body.max_tokens) && body.max_tokens > 0
        ? body.max_tokens as number : null;
      removeKey(body, 'max_tokens');
      const existingCompletion = typeof body.max_completion_tokens === 'number'
        && Number.isInteger(body.max_completion_tokens) && body.max_completion_tokens > 0
        ? body.max_completion_tokens as number : null;
      const resolvedMax = existingCompletion ?? legacyMaxTokens ?? K25_DEFAULT_MAX_TOKENS;
      body.max_completion_tokens = resolvedMax;

      if (thinkingEnabled && Object.prototype.hasOwnProperty.call(body, 'tool_choice')) {
        const choice = typeof body.tool_choice === 'string' ? body.tool_choice : '';
        if (choice !== 'auto' && choice !== 'none') body.tool_choice = 'auto';
      }

      return true;
    }

    if (isThinking) {
      body.temperature = 1.0;
      const currentMaxTokens = typeof body.max_tokens === 'number'
        && Number.isInteger(body.max_tokens) && body.max_tokens >= 0
        ? body.max_tokens as number : 0;
      if (currentMaxTokens < MIN_MAX_TOKENS_FOR_THINKING) {
        body.max_tokens = RECOMMENDED_MAX_TOKENS;
      }
    }

    return false;
  }

  override shouldRemoveSamplingParams(config: ApiConfig): boolean {
    return isK25OrLater(config.model) || isK3OrLater(config.model);
  }

  override getPassbackPolicy(config: ApiConfig): PassbackPolicy {
    return isThinkingModel(config.model) || config.isReasoning
      ? 'deep_seek_style' : 'no_passback';
  }
}
