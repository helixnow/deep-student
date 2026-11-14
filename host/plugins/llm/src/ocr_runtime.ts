/**
 * OCR 运行时候选构建（llm_manager/mod.rs build_ocr_runtime_candidates /
 * inspect_free_text_ocr_available_from_settings）。
 *
 * 系统 OCR 只服务纯文本任务；结构化任务永远不把原生 OCR 当作候选。
 */
import { OcrAdapterFactory, isDedicatedOcrEngine, ocrEngineTypeFromStr, tryOcrEngineTypeFromStr } from '../../llm-providers/api.ts';
import { logInfo } from './logging.ts';

export const SYSTEM_OCR_CONFIG_ID = '__system_ocr__';

export type OcrEngineType =
  | 'deepseek_ocr'
  | 'paddle_ocr_vl'
  | 'paddle_ocr_vl_v1'
  | 'glm4v_ocr'
  | 'generic_vlm'
  | 'system_ocr';

export type OcrTaskType = 'FreeText' | 'Structured';

export interface OcrModelConfig {
  config_id: string;
  model: string;
  engine_type: string;
  name: string;
  is_free: boolean;
  enabled: boolean;
  priority: number;
}

export interface ApiConfigLike {
  id: string;
  model: string;
  enabled: boolean;
  isMultimodal: boolean;
  isEmbedding?: boolean;
  isReranker?: boolean;
  isImageGeneration?: boolean;
  baseUrl?: string;
  name?: string;
}

export type OcrRuntimeCandidate<T extends ApiConfigLike = ApiConfigLike> =
  | { kind: 'remote'; config: T; engineType: OcrEngineType }
  | { kind: 'systemOcr' };

// L01 owns provider engine aliases and model validation.
export const tryParseOcrEngine = (value: string): OcrEngineType | null => tryOcrEngineTypeFromStr(value) ?? null;
export const parseOcrEngine = ocrEngineTypeFromStr;
export const isDedicatedOcr = isDedicatedOcrEngine;
export const validateModelForEngine = OcrAdapterFactory.validateModelForEngine;
export const inferEngineFromModel = OcrAdapterFactory.inferEngineFromModel;

/** serde(rename_all="camelCase"); an invalid element invalidates the whole Vec. */
export function decodeOcrModels(raw: string): OcrModelConfig[] | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(value)) return null;
  const result: OcrModelConfig[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
    const entry = item as Record<string, unknown>;
    if (typeof entry.configId !== 'string' || typeof entry.model !== 'string'
      || typeof entry.engineType !== 'string' || typeof entry.name !== 'string') return null;
    const isFree = entry.isFree === undefined ? false : entry.isFree;
    const enabled = entry.enabled === undefined ? true : entry.enabled;
    const priority = entry.priority === undefined ? 0 : entry.priority;
    if (typeof isFree !== 'boolean' || typeof enabled !== 'boolean'
      || typeof priority !== 'number' || !Number.isInteger(priority) || priority < 0 || priority > 0xffff_ffff) return null;
    result.push({ config_id: entry.configId, model: entry.model, engine_type: entry.engineType,
      name: entry.name, is_free: isFree, enabled, priority });
  }
  return result;
}

export function encodeOcrModels(models: readonly OcrModelConfig[]): string {
  return JSON.stringify(models.map(model => ({ configId: model.config_id, model: model.model,
    engineType: model.engine_type, name: model.name, isFree: model.is_free, enabled: model.enabled,
    priority: model.priority })));
}

/** 已知停服的 OCR/VLM 组合：仅硅基流动 + zai-org/GLM-4.6V。 */
export function isDiscontinuedOcrModel(config: Pick<ApiConfigLike, 'baseUrl' | 'model'>): boolean {
  const url = (config.baseUrl ?? '').toLowerCase();
  const model = config.model.toLowerCase();
  return url.includes('siliconflow') && model.includes('glm-4.6v');
}

function engineOf(candidate: OcrRuntimeCandidate): OcrEngineType {
  return candidate.kind === 'systemOcr' ? 'system_ocr' : candidate.engineType;
}

/** 构建 OCR 运行时候选（按任务类型排序，用户优先级在同类内保持稳定）。 */
export function buildOcrRuntimeCandidates<T extends ApiConfigLike>(
  available: OcrModelConfig[],
  configs: T[],
  taskType: OcrTaskType,
  systemOcrSupported: boolean,
): OcrRuntimeCandidate<T>[] {
  const enabledModels = available
    .filter((model) => model.enabled)
    .sort((left, right) => left.priority - right.priority);

  const result: OcrRuntimeCandidate<T>[] = [];
  let includedSystemOcr = false;
  for (const ocrConfig of enabledModels) {
    const declaredEngine = parseOcrEngine(ocrConfig.engine_type);
    if (declaredEngine === 'system_ocr' || ocrConfig.config_id === SYSTEM_OCR_CONFIG_ID) {
      if (taskType === 'FreeText' && systemOcrSupported && !includedSystemOcr) {
        result.push({ kind: 'systemOcr' });
        includedSystemOcr = true;
      }
      continue;
    }

    const config = configs.find((candidate) => candidate.id === ocrConfig.config_id);
    if (config === undefined) continue;
    if (!config.enabled || !config.isMultimodal) continue;
    if (isDiscontinuedOcrModel(config)) {
      logInfo(`[OCR] 跳过已停服模型: ${config.model} (${config.name ?? ''})`);
      continue;
    }
    const effectiveEngine = validateModelForEngine(config.model, declaredEngine)
      ? declaredEngine : inferEngineFromModel(config.model);
    result.push({ kind: 'remote', config: structuredClone(config), engineType: effectiveEngine });
  }

  result.sort((left, right) => {
    const leftRank = isDedicatedOcr(engineOf(left)) ? 0 : 1;
    const rightRank = isDedicatedOcr(engineOf(right)) ? 0 : 1;
    const leftScore = taskType === 'FreeText' ? leftRank : 1 - leftRank;
    const rightScore = taskType === 'FreeText' ? rightRank : 1 - rightRank;
    return leftScore - rightScore;
  });
  return result;
}

/**
 * 只读 OCR 可用性检查：显式引擎列表存在时以其 enabled 标志为准；
 * 列表缺失时原生 OCR 的可用性仅取决于平台支持。
 */
export function inspectFreeTextOcrAvailableFromSettings(
  availableModelsJson: string | null | undefined,
  legacyEngine: string | null | undefined,
  configs: ApiConfigLike[],
  systemOcrSupported: boolean,
): boolean {
  if (availableModelsJson !== null && availableModelsJson !== undefined) {
    const models = decodeOcrModels(availableModelsJson);
    if (models !== null) {
      return buildOcrRuntimeCandidates(models, configs, 'FreeText', systemOcrSupported).length > 0;
    }
  }

  const engine = legacyEngine === null || legacyEngine === undefined
    ? null : tryParseOcrEngine(legacyEngine);
  if (engine === null || engine === 'system_ocr') return systemOcrSupported;

  return configs.some((config) => config.enabled && config.isMultimodal
    && config.isEmbedding !== true && config.isReranker !== true
    && config.isImageGeneration !== true
    && (validateModelForEngine(config.model, engine)
      || inferEngineFromModel(config.model) === engine));
}
