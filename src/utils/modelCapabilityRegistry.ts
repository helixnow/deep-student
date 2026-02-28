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

type AnyRecord = RegistryDocument | Record<string, unknown>;
const raw = registryData as unknown as AnyRecord;
const records = (raw as { records?: RegistrySeriesRecord[] }).records ?? [];
const flattenModelRecords = records.flatMap((record) => {
  if (!record?.models) return [];
  return record.models.map((model) => ({ ...model, vendor: record.vendor, series: record.series }));
});

const normalizeModelId = (value: string): string => value.trim().toLowerCase();

const splitModelName = (value: string): string[] => normalizeModelId(value).split(/[/\\:]/g);

const toBaseModelId = (value: string): string => {
  const parts = splitModelName(value);
  return parts.at(-1) ?? '';
};

export function findModelRecordById(modelId: string): RegistryModelRecord | undefined {
  const normalizedInput = normalizeModelId(modelId);
  const baseModelId = toBaseModelId(modelId);
  const recordsByBase = flattenModelRecords.filter((item) => item.model_id.toLowerCase() === baseModelId);

  if (recordsByBase.length > 0) {
    return recordsByBase[0];
  }

  const recordsByFullMatch = flattenModelRecords.filter((item) => {
    const normalized = item.model_id.toLowerCase();
    return normalizedInput === normalized || normalizedInput.endsWith(`/${normalized}`) || normalizedInput.endsWith(`:${normalized}`);
  });

  if (recordsByFullMatch.length > 0) {
    return recordsByFullMatch[0];
  }

  return flattenModelRecords.find((item) => {
    const normalized = item.model_id.toLowerCase();
    return toBaseModelId(item.model_id) === baseModelId;
  });
}

