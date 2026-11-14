/** Wire the existing default-model resolver to live settings and runtime configurations. */
import type { LlmEmbeddingModels, LLMManager, ApiConfig } from '../api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { AppError, CommandError } from '../../../platform/errors/api.ts';
import { EmbeddingDefaults, EmbeddingDefaultsError } from './embedding_defaults.ts';
import { logDebug, logInfo, logWarn } from './logging.ts';

export function createEmbeddingModels(settings: SettingsStore, llm: LLMManager): LlmEmbeddingModels {
  async function resolve<T>(operation: (defaults: EmbeddingDefaults, configs: ApiConfig[]) => T): Promise<T> {
    const configs = await llm.getApiConfigs();
    const defaults = new EmbeddingDefaults({
      getSetting: key => settings.get(key), saveSetting: (key, value) => settings.save(key, value),
      listEnabledProfiles: () => configs.map(config => ({ ...config, label: config.name })), warn: logWarn,
    });
    try { return operation(defaults, configs); }
    catch (error) {
      if (error instanceof EmbeddingDefaultsError) throw new CommandError(
        error.kind === 'database' ? AppError.database(error.message) : AppError.configuration(error.message));
      throw error;
    }
  }
  return {
    getEmbeddingModelConfig: async () => {
      let configs: ApiConfig[] = [];
      const defaults = new EmbeddingDefaults({
        getSetting: key => settings.get(key), saveSetting: (key, value) => settings.save(key, value),
        listEnabledProfiles: () => configs.map(config => ({ ...config, label: config.name })),
        loadTextProfiles: async () => {
          const current = await llm.getApiConfigs();
          if (configs.length === 0) configs = current;
          return current.map(config => ({ ...config, label: config.name }));
        },
        loadTextAssignments: () => llm.getModelAssignments(), warn: logWarn, info: logInfo, debug: logDebug,
      });
      try {
        const entry = await defaults.getEmbeddingModelConfig();
        return configs.find(config => config.id === entry.id)!;
      } catch (error) {
        if (error instanceof EmbeddingDefaultsError) throw new CommandError(AppError.configuration(error.message));
        throw error;
      }
    },
    getVlEmbeddingModelConfig: () => resolve((defaults, configs) => {
      const id = defaults.getVlEmbeddingModelConfig().id;
      return configs.find(config => config.id === id)!;
    }),
    adoptDefaultMultimodalEmbedding: (dimension, id) => resolve(defaults => defaults.adoptDefaultMultimodalEmbedding(dimension, id)),
    healDefaultMultimodalEmbedding: async candidates => {
      try { return await resolve(defaults => defaults.healDefaultMultimodalEmbedding(candidates)); }
      catch (error) { logWarn(`[RAG] 读取模型条目失败，跳过多模态默认维度补救: ${error instanceof Error ? error.message : String(error)}`); return false; }
    },
  };
}
