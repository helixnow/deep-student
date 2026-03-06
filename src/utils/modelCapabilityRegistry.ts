import registryData from '../../scripts/model-capability-registry.json';

export type RegistryModelStatus = 'confirmed' | 'inferred' | 'deprecated' | 'unknown';

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
