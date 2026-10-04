import registryData from '../../scripts/model-capability-registry.json';
import { detectModelKindSignal } from './modelIdPrefix';

export type RegistryModelStatus = 'confirmed' | 'inferred' | 'deprecated' | 'unknown';

/**
 * 记录的模型种类。缺省视为 'chat'（历史记录未标注）。
 * 匹配时先判定输入的类型信号，再只对同 kind 记录计分——
 * 嵌入/重排模型不允许命中聊天记录（反之亦然），
 * 否则包含兜底会把 embed-gateway_qwen3* 之类误配到 qwen3 聊天记录上。
 */
export type RegistryModelKind = 'chat' | 'embedding' | 'rerank';

export interface RegistryCapabilityFlags {
  text: boolean;
  vision: boolean;
  audio: boolean;
  video: boolean;
  function_calling: boolean;
  reasoning: boolean;
  coding_agent: boolean;
  max_context_tokens: number | null;
  max_output_tokens: number | null;
}

export interface RegistryParamFieldMap {
  family: string;
  required_fields: string[];
  optional_fields: string[];
  notes?: string;
}

export interface RegistryModelRecord {
  model_id: string;
  release_date: string;
  status: RegistryModelStatus;
  model_kind?: RegistryModelKind;
  capabilities: RegistryCapabilityFlags;
  param_format: RegistryParamFieldMap;
  quirks: string[];
  provider_scope?: string;
  provider_model_id?: string;
  source_url?: string;
  verified_at?: string;
  alias_of?: string;
}

interface RegistrySeriesRecord {
  vendor: string;
  series: string;
  models: RegistryModelRecord[];
}

interface RegistryDocument {
  schema_version: string;
  updated_at: string;
  purpose?: string;
  records: RegistrySeriesRecord[];
}

export interface RegistryLookupOptions {
  providerScope?: string;
}

type AnyRecord = RegistryDocument | Record<string, unknown>;
const raw = registryData as unknown as AnyRecord;
const records = (raw as { records?: RegistrySeriesRecord[] }).records ?? [];
const flattenModelRecords = records.flatMap((record) => {
  if (!record?.models) return [];
  return record.models.map((model) => ({ ...model, vendor: record.vendor, series: record.series }));
});

const normalizeModelId = (value: string): string => value.trim().toLowerCase();

const splitModelName = (value: string): string[] => normalizeModelId(value).split(/[/\\:]/g);

const normalizeProviderScope = (value?: string | null): string | undefined => {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
};

const toBaseModelId = (value: string): string => {
  const parts = splitModelName(value);
  return parts.at(-1) ?? '';
};

function matchesFullModelId(input: string, candidate?: string): boolean {
  if (!candidate) return false;
  const normalized = normalizeModelId(candidate);
  return input === normalized || input.endsWith(`/${normalized}`) || input.endsWith(`:${normalized}`);
}

/** 包含命中只认版本边界：命中段后紧跟数字是另一个版本（gpt-60 ≠ gpt-6、gpt-5.60 ≠ gpt-5.6） */
function includesAtVersionBoundary(input: string, base: string): boolean {
  for (let i = input.indexOf(base); i >= 0; i = input.indexOf(base, i + 1)) {
    if (!/\d/.test(input.charAt(i + base.length))) return true;
  }
  return false;
}

function scoreRegistryRecord(
  modelId: string,
  record: RegistryModelRecord,
  options: RegistryLookupOptions,
): number {
  const normalizedInput = normalizeModelId(modelId);
  const baseModelId = toBaseModelId(modelId);
  const requestedScope = normalizeProviderScope(options.providerScope);
  const recordScope = normalizeProviderScope(record.provider_scope);
  const providerModelId = record.provider_model_id;

  // 类型优先（先判嵌入/重排，再匹配厂商）：跨 kind 的记录一律不参与计分。
  // 输入无类型信号时只匹配 chat 记录，避免聊天模型误吃嵌入/重排记录的能力。
  const inputKind = detectModelKindSignal(modelId);
  const recordKind: RegistryModelKind = record.model_kind ?? 'chat';
  if ((inputKind ?? 'chat') !== recordKind) return -1;

  let score = -1;

  if (matchesFullModelId(normalizedInput, providerModelId)) {
    score = 500;
  } else if (matchesFullModelId(normalizedInput, record.model_id)) {
    score = 450;
  } else if (record.alias_of && matchesFullModelId(normalizedInput, record.alias_of)) {
    score = 430;
  } else if (providerModelId && toBaseModelId(providerModelId) === baseModelId) {
    score = 320;
  } else if (toBaseModelId(record.model_id) === baseModelId) {
    score = 300;
  } else if (record.alias_of && toBaseModelId(record.alias_of) === baseModelId) {
    score = 280;
  } else {
    // 方案 E 包含匹配兜底：输入 ID 包含注册表 model_id（中转站任意前缀/后缀）。
    // 以命中长度计分——最长包含命中优先（如 "gemini-3.5-flash-lite" 胜过
    // "gemini-3.5-flash"）；过短的 model_id（<5 字符）不参与，避免误命中。
    const recordBase = toBaseModelId(record.model_id);
    // chat 变体（如 gpt-5.1-chat-latest）不是所属系列的推理档位形态，不参与包含命中
    const isChatVariant = normalizedInput.includes('chat');
    if (!isChatVariant && recordBase.length >= 5 && includesAtVersionBoundary(normalizedInput, recordBase)) {
      score = 100 + recordBase.length;
    }
  }

  if (score < 0) return score;

  if (requestedScope) {
    if (recordScope === requestedScope) {
      score += 40;
    } else if (!recordScope) {
      score += 10;
    }
  } else if (!recordScope) {
    score += 20;
  }

  return score;
}

export function findModelRecordById(
  modelId: string,
  options: RegistryLookupOptions = {},
): RegistryModelRecord | undefined {
  const normalizedInput = normalizeModelId(modelId);
  if (!normalizedInput) return undefined;

  let bestRecord: RegistryModelRecord | undefined;
  let bestScore = -1;

  for (const item of flattenModelRecords) {
    const score = scoreRegistryRecord(modelId, item, options);
    if (score > bestScore) {
      bestScore = score;
      bestRecord = item;
    }
  }

  return bestScore >= 0 ? bestRecord : undefined;
}
