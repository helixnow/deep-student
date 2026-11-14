/**
 * `src/commands.rs::qbank_resolve_authoring_route`：解析出题模型与视觉兜底。
 *
 * Rust 组合了 L02 `LLMManager::resolve_question_authoring_config` 与
 * `question_authoring_runner::resolve_visual_fallback`。Host 的 L02 已发布
 * `getApiConfigs/getModel2Config` 与 `llmOcrModels`，这里按相同顺序执行校验与
 * 兜底选择，不引入新的模型配置逻辑。
 */
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { ApiConfig, LLMManager, LlmOcrModels } from '../../llm/api.ts';
import { QbankServiceError } from './question-service.ts';

export interface AuthoringRouteHost {
  readonly llm: LLMManager;
  readonly ocr: LlmOcrModels | undefined;
}

export interface AuthoringRouteResult {
  model: { id: string; name: string; model: string; is_multimodal: boolean };
  visual_fallback: { id: string; name: string; model: string } | null;
}

/** L02 `OcrModelConfig` 的只读子集（`ocr_runtime.ts` 未在 llm/api.ts 重导出）。 */
export interface OcrEngineCandidate {
  config_id: string;
  enabled: boolean;
  priority: number;
}

function configuration(message: string): never {
  throw new QbankServiceError(AppError.configuration(message));
}

/** L02 service methods reject with CommandError(AppError); preserve the wire error. */
async function callLlm<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof QbankServiceError) throw error;
    if (error instanceof CommandError) throw new QbankServiceError(error.value);
    throw error;
  }
}

function usableFallback(config: ApiConfig): boolean {
  return config.enabled && config.isMultimodal && !config.isEmbedding && !config.isReranker;
}

/** Rust `resolve_question_authoring_config` 的校验部分。 */
export function validateAuthoringConfig(config: ApiConfig | undefined,
  modelConfigId: string | null): ApiConfig {
  if (config === undefined) {
    configuration(`找不到指定的解析模型: ${modelConfigId ?? ''}`);
  }
  if (!config.enabled || config.isEmbedding || config.isReranker || config.isImageGeneration) {
    configuration('解析模型必须是已启用的对话模型');
  }
  if (config.maxOutputTokens === 0 || config.maxTokensLimit === 0 || config.contextWindow === 0) {
    configuration('模型 token 配置必须为正数');
  }
  return config;
}

/** Rust `resolve_visual_fallback`：OCR 配置优先，然后按 enabled 引擎优先级查候选。 */
export function pickVisualFallback(configs: readonly ApiConfig[],
  ocrConfig: ApiConfig | null, engines: readonly OcrEngineCandidate[]): ApiConfig | null {
  if (ocrConfig !== null && usableFallback(ocrConfig)) return ocrConfig;
  const ordered = [...engines].sort((left, right) => left.priority - right.priority);
  for (const engine of ordered.filter(item => item.enabled)) {
    const candidate = configs.find(item => item.id === engine.config_id && usableFallback(item));
    if (candidate !== undefined) return candidate;
  }
  return null;
}

/**
 * Rust `question_authoring_runner.rs:770 resolve_visual_fallback`：OCR 配置读取成功且可用即返回；
 * 否则（读取失败或不可用）读取全部 API 配置（失败传播），再按启用引擎优先级挑选；都不可用 → Configuration。
 */
export async function resolveVisualFallback(host: AuthoringRouteHost): Promise<ApiConfig> {
  let ocrConfig: ApiConfig | null = null;
  if (host.ocr !== undefined) {
    try {
      ocrConfig = await host.ocr.getOcrModelConfig();
    } catch { // boundary-allow empty-catch: question_authoring_runner.rs:771 `if let Ok(config)`，读取失败继续查候选，Rust 无日志
      ocrConfig = null;
    }
  }
  const direct = pickVisualFallback([], ocrConfig, []);
  if (direct !== null) return direct;
  const configs = await callLlm(() => host.llm.getApiConfigs());
  const engines: OcrEngineCandidate[] = host.ocr === undefined ? [] : await callLlm(() => host.ocr!.getAvailableOcrModels());
  const picked = pickVisualFallback(configs, null, engines);
  if (picked === null) configuration('当前主模型无视觉能力，且未配置可用的多模态视觉兜底模型');
  return picked;
}

/** Rust `resolve_question_authoring_config` + `resolve_visual_fallback`。 */
export async function resolveAuthoringRoute(host: AuthoringRouteHost,
  modelConfigId: string | null, requiresVision: boolean): Promise<AuthoringRouteResult> {
  const config = validateAuthoringConfig(modelConfigId === null
    ? await callLlm(() => host.llm.getModel2Config())
    : (await callLlm(() => host.llm.getApiConfigs())).find(item => item.id === modelConfigId),
  modelConfigId);

  const visual = requiresVision && !config.isMultimodal ? await resolveVisualFallback(host) : null;

  return {
    model: {
      id: config.id,
      name: config.name,
      model: config.model,
      is_multimodal: config.isMultimodal,
    },
    visual_fallback: visual === null ? null
      : { id: visual.id, name: visual.name, model: visual.model },
  };
}
