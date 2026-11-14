/** LLMManager OCR settings migrations and model selection, mod.rs:7006–7709. */
import type { ApiConfig, LLMManager, LlmOcrModels } from '../api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { isSystemOcrPlatformSupported, ocrEngineDisplayName, ocrEngineRecommendedModel } from '../../llm-providers/api.ts';
import { buildOcrRuntimeCandidates, decodeOcrModels, encodeOcrModels, inferEngineFromModel,
  inspectFreeTextOcrAvailableFromSettings, isDedicatedOcr, isDiscontinuedOcrModel, parseOcrEngine,
  validateModelForEngine, type OcrModelConfig, type OcrRuntimeCandidate, type OcrTaskType } from './ocr_runtime.ts';
import { logDebug, logInfo, logWarn } from './logging.ts';

/** ocr_models.rs:11–73; println in Rust is routed to the plugin logger. */
export function migratePaddleOcrModels(models: OcrModelConfig[]): boolean {
  let changed = false;
  for (const model of models) {
    if (model.model === 'PaddlePaddle/PaddleOCR-VL' && model.engine_type !== 'paddle_ocr_vl_v1') {
      model.model = 'PaddlePaddle/PaddleOCR-VL-1.5';
      if (model.name.includes('PaddleOCR-VL') && !model.name.includes('1.5')) {
        model.name = model.name.replaceAll('PaddleOCR-VL', 'PaddleOCR-VL-1.5');
      }
      changed = true;
    }
  }
  return changed;
}

export function migrateGlmOcrModels(models: OcrModelConfig[], isSiliconflow: (id: string) => boolean,
  isZhipuOfficial: (id: string) => boolean): boolean {
  let changed = false;
  for (const model of models) {
    if (model.engine_type !== 'glm4v_ocr' || !model.model.toLowerCase().includes('glm-4.1v')) continue;
    if (isSiliconflow(model.config_id)) {
      model.model = 'Qwen/Qwen3-VL-8B-Instruct'; model.engine_type = 'generic_vlm';
      model.name = model.name.replaceAll('4.1V', 'Qwen3-VL-8B').replaceAll('4.1v', 'Qwen3-VL-8B');
      changed = true;
      logInfo('[OCR] 已自动迁移 GLM-4.1V → Qwen/Qwen3-VL-8B-Instruct (硅基流动, engine: generic_vlm)');
    } else if (isZhipuOfficial(model.config_id)) {
      model.model = 'glm-4.6v'; model.engine_type = 'glm4v_ocr';
      model.name = model.name.replaceAll('4.1V', 'GLM-4.6V').replaceAll('4.1v', 'GLM-4.6V');
      changed = true;
      logInfo('[OCR] 已自动迁移 GLM-4.1V → glm-4.6v (智谱官方, engine: glm4v_ocr)');
    } else logInfo('[OCR] 跳过 GLM-4.1V 迁移（无法确定提供商，保持原模型）');
  }
  return changed;
}

export function createOcrModelsService(settings: SettingsStore, llm: LLMManager,
  systemSupported: () => boolean = isSystemOcrPlatformSupported): LlmOcrModels {
  function setting(key: string): string | null {
    try { return settings.get(key); } catch { return null; } // mod.rs .ok().flatten()
  }
  function enabledByClass(models: OcrModelConfig[]): OcrModelConfig[] {
    return models.filter(model => model.enabled).sort((a, b) =>
      Number(!isDedicatedOcr(parseOcrEngine(a.engine_type))) - Number(!isDedicatedOcr(parseOcrEngine(b.engine_type)))
      || a.priority - b.priority);
  }
  async function getAvailableOcrModels(): Promise<OcrModelConfig[]> {
    const raw = setting('ocr.available_models');
    const models = raw === null ? null : decodeOcrModels(raw);
    if (models === null) return [];
    let changed = migratePaddleOcrModels(models);
    const configs = await llm.getApiConfigs().catch(() => null);
    const glmIds = models.filter(model => model.engine_type === 'glm4v_ocr'
      && model.model.toLowerCase().includes('glm-4.1v')).map(model => model.config_id);
    if (migrateGlmOcrModels(models,
      id => configs?.find(config => config.id === id)?.baseUrl.toLowerCase().includes('siliconflow') ?? false,
      id => configs?.find(config => config.id === id)?.baseUrl.toLowerCase().includes('bigmodel') ?? false)) {
      changed = true;
      if (glmIds.length > 0 && configs !== null) {
        let apiChanged = false;
        for (const config of configs) {
          if (!glmIds.includes(config.id) || !config.model.toLowerCase().includes('glm-4.1v')) continue;
          let model: string, name: string;
          if (config.baseUrl.toLowerCase().includes('siliconflow')) {
            model = 'Qwen/Qwen3-VL-8B-Instruct';
            name = config.name.replaceAll('GLM-4.1V', 'Qwen3-VL-8B').replaceAll('4.1V', 'Qwen3-VL-8B');
          } else if (config.baseUrl.toLowerCase().includes('bigmodel')) {
            model = 'glm-4.6v';
            name = config.name.replaceAll('GLM-4.1V', 'GLM-4.6V').replaceAll('4.1V', '4.6V');
          } else continue;
          logInfo(`[OCR] 同步更新 ApiConfig model: ${config.model} → ${model} (id=${config.id})`);
          config.model = model; config.name = name; apiChanged = true;
        }
        if (apiChanged) {
          try { await llm.saveApiConfigurations(configs); }
          catch { // boundary-allow empty-catch: mod.rs:7349 uses let _ = save_api_configurations without logging
          }
        }
      }
    }
    if (models.length > 1 && models.every(model => model.priority === 0)) {
      const oldEngine = setting('ocr.engine_type');
      if (oldEngine !== null) {
        models.forEach((model, index) => { model.priority = model.engine_type === oldEngine ? 0 : index + 1; });
        models.sort((a, b) => a.priority - b.priority);
        models.forEach((model, index) => { model.priority = index; });
        changed = true;
        logInfo(`[OCR] 已从旧 ocr.engine_type='${oldEngine}' 迁移到优先级列表`);
      }
    }
    if (changed) {
      try { settings.save('ocr.available_models', encodeOcrModels(models)); }
      catch { // boundary-allow empty-catch: mod.rs:7382 uses let _ = save_setting without logging
      }
    }
    return models;
  }
  async function getOcrModelConfig(): Promise<ApiConfig> {
    const configs = await llm.getApiConfigs();
    const models = enabledByClass(await getAvailableOcrModels());
    const skipped: string[] = [];
    for (const model of models) {
      const config = configs.find(config => config.id === model.config_id);
      let reason: string;
      if (config === undefined) reason = `引擎 ${model.engine_type} 的配置 ID ${model.config_id} 不存在（模型配置可能已被删除）`;
      else if (isDiscontinuedOcrModel(config)) reason = `引擎 ${model.engine_type}（${model.config_id}）对应模型 ${config.model} 已停服`;
      else if (!config.isMultimodal) reason = `引擎 ${model.engine_type}（${model.config_id}）对应模型 ${config.model} 不支持多模态`;
      else {
        logDebug(`[OCR] 使用引擎 ${model.engine_type} 对应的模型配置: id=${config.id}, model=${config.model} (priority=${model.priority})`);
        return structuredClone(config);
      }
      logWarn(`[OCR] ${reason}，跳过`); skipped.push(reason);
    }
    const id = (await llm.getModelAssignments()).exam_sheet_ocr_model_config_id;
    if (id === null) throw AppError.configuration('OCR 模型未配置，请在模型分配中添加 OCR 引擎');
    const config = configs.find(config => config.id === id);
    if (config === undefined) throw AppError.configuration(`找不到 ID 为 ${id} 的模型配置`);
    if (skipped.length) logWarn(`[OCR] 启用引擎全部失效，降级到模型分配兜底 ${config.model}（${config.id}）:${skipped.join('; ')}`);
    else logInfo(`[OCR] 启用引擎列表为空，使用模型分配兜底: ${config.model} (${config.id})`);
    if (isDiscontinuedOcrModel(config)) throw AppError.configuration(`当前配置的 OCR 模型 ${config.model} 已被服务商停服（如硅基流动已下架 zai-org/GLM-4.6V），请在设置中更换 OCR 引擎`);
    if (!config.isMultimodal) throw AppError.configuration(`OCR 兜底分配的模型 ${config.model} 未启用多模态能力，已拒绝作为 OCR 引擎使用（请在模型分配中选择支持图像输入的模型，或在 OCR 设置中启用可用引擎）`);
    logDebug(`[OCR] 使用配置的模型（回退）: id=${config.id}, model=${config.model}`);
    return config;
  }
  async function candidates(task: OcrTaskType, native: boolean): Promise<OcrRuntimeCandidate<ApiConfig>[]> {
    const configs = await llm.getApiConfigs();
    let result = buildOcrRuntimeCandidates(await getAvailableOcrModels(), configs, task, systemSupported());
    if (!native) result = result.filter(item => item.kind === 'remote');
    if (!result.length) {
      try {
        const config = await getOcrModelConfig();
        result.push({ kind: 'remote', config, engineType: inferEngineFromModel(config.model) });
      } catch { // boundary-allow empty-catch: mod.rs:7150 and :7204 intentionally ignore fallback errors before the shared error
      }
    }
    if (!result.length) throw AppError.configuration('没有可用的 OCR 引擎配置，请在设置中添加 OCR 引擎');
    return result;
  }
  return {
    getAvailableOcrModels, getOcrModelConfig,
    async getOcrConfigsByPriority(task) {
      const result = (await candidates(task, false)).flatMap(candidate => candidate.kind === 'remote'
        ? [[candidate.config, candidate.engineType] as const] : []);
      result.sort((a, b) => (Number(isDedicatedOcr(a[1])) - Number(isDedicatedOcr(b[1]))) * (task === 'FreeText' ? -1 : 1));
      logDebug(`[OCR] 引擎优先级（${task}）: ${result.map(([config, engine], i) => `#${i} ${ocrEngineDisplayName(engine)}(${config.model})`).join(' → ')}`);
      return result;
    },
    async getFreeTextOcrCandidatesByPriority() {
      const result = await candidates('FreeText', true);
      logDebug(`[OCR] FreeText 运行时候选: ${result.map((candidate, i) => candidate.kind === 'remote'
        ? `#${i} ${ocrEngineDisplayName(candidate.engineType)}(${candidate.config.model})`
        : `#${i} ${ocrEngineDisplayName('system_ocr')}(native)`).join(' → ')}`);
      return result;
    },
    async inspectFreeTextOcrAvailable() {
      const raw = setting('ocr.available_models'), legacy = setting('ocr.engine_type');
      const configs = await llm.getApiConfigs().catch(() => []);
      return inspectFreeTextOcrAvailableFromSettings(raw, legacy, configs, systemSupported());
    },
    async getOcrModelConfigForEngine(engine) {
      const configs = await llm.getApiConfigs();
      const raw = setting('ocr.available_models');
      const model = (raw === null ? null : decodeOcrModels(raw))?.find(model => model.engine_type === engine);
      const config = model === undefined ? undefined : configs.find(config => config.id === model.config_id);
      if (config) return config;
      const recommended = ocrEngineRecommendedModel(engine);
      return configs.find(config => config.model.includes(recommended) || recommended.includes(config.model)) ?? getOcrModelConfig();
    },
    isOcrThinkingEnabled: () => setting('ocr.enable_thinking')?.toLowerCase() === 'true',
    async getOcrEngineType() {
      const first = enabledByClass(await getAvailableOcrModels())[0];
      return parseOcrEngine(first?.engine_type ?? setting('ocr.engine_type') ?? 'paddle_ocr_vl');
    },
    async getOcrConfigWithEffectiveEngine() {
      const config = await getOcrModelConfig();
      const model = (await getAvailableOcrModels()).find(model => model.config_id === config.id);
      const declared = model === undefined ? null : parseOcrEngine(model.engine_type);
      const engine = declared !== null && validateModelForEngine(config.model, declared) ? declared : inferEngineFromModel(config.model);
      logDebug(`[OCR] effective engine=${engine}, model=${config.model}`);
      return [config, engine];
    },
  };
}
