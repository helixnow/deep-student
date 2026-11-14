/**
 * `llm@1` 服务实现（`host/plugins/llm/api.ts` 的 LLMManager）。
 *
 * 配置读写直接复用 `LlmConfigStore`；模型选择/错误文案逐条对应
 * `dstu-llm/src/llm_manager/mod.rs:6941–7000、7764–7884`。
 */
import { AppError, CommandError } from '../../../platform/errors/api.ts';
import type {
  ApiConfig, ApiConfig__De, FailoverPolicy, LLMManager, ModelAssignments, ModelAssignments__De,
  ModelProfile, ModelProfile__De, ParamOverrides, VendorConfig, VendorConfig__De,
} from '../api.ts';
import { resolveEnabledTextModel, resolvePurposeModelId, isKnownUtilityPurpose } from './routing.ts';
import type { LlmControl } from './control.ts';
import { ConfigError, type LlmConfigStore, modelProfileFromDe, vendorConfigFromDe } from './config_store.ts';
import { logWarn } from './logging.ts';

function configFailure(error: unknown): never {
  if (error instanceof CommandError) throw error;
  if (error instanceof ConfigError) {
    const factory =
      error.kind === 'database' ? AppError.database
        : error.kind === 'configuration' ? AppError.configuration
          : AppError.validation;
    throw new CommandError(factory(error.message));
  }
  throw new CommandError(AppError.unknown(error instanceof Error ? error.message : String(error)));
}

/** Everything except the transport-backed `callUnifiedModel2`, which the plugin entry composes on top. */
export type LlmConfigManager = Omit<LLMManager, 'callUnifiedModel2'>;

export function createLlmService(store: LlmConfigStore, control: LlmControl): LlmConfigManager {
  const getApiConfigs = async (): Promise<ApiConfig[]> => {
    try { return await store.getApiConfigs(); } catch (error) { configFailure(error); }
  };
  const enabledTextModel = async (candidateIds: string[], failure: string): Promise<ApiConfig> => {
    const configs = await getApiConfigs();
    const config = resolveEnabledTextModel(configs, candidateIds);
    if (config === null) throw new CommandError(AppError.configuration(failure));
    return config;
  };
  return {
    getApiConfigs,
    saveApiConfigurations: async (configs: ApiConfig__De[]) => {
      try { await store.saveApiConfigurations(configs); } catch (error) { configFailure(error); }
    },
    getVendorConfigs: async (): Promise<VendorConfig[]> => {
      try { return await store.getVendorConfigs(); } catch (error) { configFailure(error); }
    },
    saveVendorConfigs: async (configs: VendorConfig__De[]) => {
      try { await store.saveVendorConfigs(configs.map(vendorConfigFromDe)); } catch (error) { configFailure(error); }
    },
    getModelProfiles: async (): Promise<ModelProfile[]> => {
      try { return await store.getModelProfiles(); } catch (error) { configFailure(error); }
    },
    saveModelProfiles: async (profiles: ModelProfile__De[]) => {
      try { await store.saveModelProfiles(profiles.map(modelProfileFromDe)); } catch (error) { configFailure(error); }
    },
    getModelAssignments: async (): Promise<ModelAssignments> => {
      try { return await store.getModelAssignments(); } catch (error) { configFailure(error); }
    },
    saveModelAssignments: async (assignments: ModelAssignments__De) => {
      try { await store.saveModelAssignments(assignments); } catch (error) { configFailure(error); }
    },
    getModel2Config: async () => {
      const assignments = await store.getModelAssignments();
      const model2Id = assignments.model2_config_id;
      if (model2Id === null) throw new CommandError(AppError.configuration('对话模型未配置'));
      return enabledTextModel(
        [model2Id],
        '找不到已启用的有效对话模型配置（禁止使用嵌入/重排序模型）',
      );
    },
    getTranslationModelConfig: async () => {
      const assignments = await store.getModelAssignments();
      const modelId = assignments.translation_model_config_id ?? assignments.model2_config_id;
      if (modelId === null) {
        throw new CommandError(AppError.configuration('未配置翻译模型或model2'));
      }
      if (assignments.translation_model_config_id === null) logWarn('未配置翻译专用模型，回退到model2');
      const configs = await getApiConfigs();
      const config = configs.find((candidate) => candidate.id === modelId);
      if (config === undefined) throw new CommandError(AppError.configuration('找不到翻译模型配置'));
      if (!config.enabled || config.isEmbedding || config.isReranker || config.isImageGeneration) {
        throw new CommandError(AppError.configuration('翻译模型已禁用或不支持文本调用'));
      }
      return config;
    },
    getMemoryDecisionModelConfig: async () => {
      const assignments = await store.getModelAssignments();
      const candidates = [assignments.memory_decision_model_config_id, assignments.model2_config_id]
        .filter((id): id is string => id !== null);
      return enabledTextModel(candidates, '没有已启用的有效记忆决策模型（禁止使用嵌入/重排序模型）');
    },
    getChatTitleModelConfig: async () => {
      const assignments = await store.getModelAssignments();
      const candidates = [assignments.chat_title_model_config_id, assignments.model2_config_id]
        .filter((id): id is string => id !== null);
      return enabledTextModel(candidates, '没有已启用的有效标题/标签生成模型（禁止使用嵌入/重排序模型）');
    },
    selectModelFor: async (task: string, overrideId?: string | null, overrides?: ParamOverrides) => {
      const applyOverrides = (config: ApiConfig): void => {
        if (overrides?.temperature != null) config.temperature = overrides.temperature;
        if (overrides?.maxOutputTokens != null) config.maxOutputTokens = overrides.maxOutputTokens;
        config.topPOverride = overrides?.topP ?? null;
        config.frequencyPenaltyOverride = overrides?.frequencyPenalty ?? null;
        config.presencePenaltyOverride = overrides?.presencePenalty ?? null;
      };
      if (overrideId != null) {
        const config = await enabledTextModel(
          [overrideId], `找不到已启用的有效模型配置: ${overrideId}`,
        );
        applyOverrides(config);
        return [config, config.isReasoning];
      }
      const assignments = await store.getModelAssignments();
      const configs = await getApiConfigs();
      let modelIds: string[];
      let enableCot: boolean;
      switch (task) {
        case 'default':
          if (assignments.model2_config_id === null) {
            throw new CommandError(AppError.configuration('对话模型未配置'));
          }
          modelIds = [assignments.model2_config_id];
          enableCot = true;
          break;
        case 'chat_title':
        case 'tag_generation':
          modelIds = [assignments.chat_title_model_config_id, assignments.model2_config_id]
            .filter((id): id is string => id !== null);
          if (modelIds.length === 0) {
            throw new CommandError(AppError.configuration('没有配置可用的标题/标签生成模型'));
          }
          enableCot = false;
          break;
        case 'review':
          if (assignments.review_analysis_model_config_id === null) {
            throw new CommandError(AppError.configuration('未配置回顾分析模型'));
          }
          modelIds = [assignments.review_analysis_model_config_id];
          enableCot = true;
          break;
        default: {
          const policy = await control.getFailoverPolicy();
          const purposeModelId = resolvePurposeModelId(policy, task);
          if (purposeModelId !== null) {
            modelIds = [purposeModelId];
            if (assignments.model2_config_id !== null) modelIds.push(assignments.model2_config_id);
            enableCot = false;
          } else if (isKnownUtilityPurpose(task)) {
            if (assignments.model2_config_id === null) {
              throw new CommandError(AppError.configuration('对话模型未配置'));
            }
            modelIds = [assignments.model2_config_id];
            enableCot = false;
          } else {
            throw new CommandError(AppError.configuration(`不支持的任务类型: ${task}`));
          }
        }
      }
      const config = resolveEnabledTextModel(configs, modelIds);
      if (config === null) {
        throw new CommandError(
          AppError.configuration(`找不到已启用的有效模型配置，候选: ${modelIds.join(', ')}`),
        );
      }
      applyOverrides(config);
      return [config, config.isReasoning && enableCot];
    },
    getFailoverPolicy: () => control.getFailoverPolicy(),
    saveFailoverPolicy: (policy: FailoverPolicy) => control.saveFailoverPolicy(policy),
    decryptApiKey: async (apiKey: string) => {
      try { return await store.decryptApiKeyIfNeeded(apiKey); } catch (error) { configFailure(error); }
    },
    subscribeCancelStream: (streamEvent: string) => control.subscribeCancelStream(streamEvent),
    requestCancelStream: (streamEvent: string) => control.requestCancelStream(streamEvent),
    consumePendingCancel: (streamEvent: string) => control.consumePendingCancel(streamEvent),
    clearCancelStream: (streamEvent: string) => control.clearCancelStream(streamEvent),
    clearCancelArtifacts: (streamEvent: string) => control.clearCancelArtifacts(streamEvent),
    cancelStreamsByPrefix: (prefix: string) => control.cancelStreamsByPrefix(prefix),
  };
}
