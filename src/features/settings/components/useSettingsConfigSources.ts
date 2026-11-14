import { useCallback, useEffect } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { Dispatch, SetStateAction } from 'react';
import type { ThemeMode, ThemePalette } from '@/hooks/useTheme';
import type { ApiConfig, ModelAssignments } from '@/types';
import { normalizeMcpToolList } from './mcpUtils';
import type { SystemConfig } from './types';

const isTauri = typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__;
const invoke = isTauri ? tauriInvoke : null;

/**
 * Settings 外壳的配置来源同步：后端 ApiConfig 列表、模型分配、主题与 MCP 工具列表。
 *
 * 这些 effect 只维护「配置从哪来 / 何时覆盖」这一件事，不包含任何分区 UI 状态，
 * 因此从 Settings.tsx 下沉为独立 hook；执行顺序与改造前一致（同一个外壳位置注册）。
 * auto-save 依赖 handleSave，仍留在外壳，避免本 hook 反向依赖配置加载器。
 */
export function useSettingsConfigSources({
  config,
  setConfig,
  modelAssignments,
  themeMode,
  themePalette,
}: {
  config: SystemConfig;
  setConfig: Dispatch<SetStateAction<SystemConfig>>;
  modelAssignments: ModelAssignments;
  themeMode: ThemeMode;
  themePalette: ThemePalette;
}) {
  // 注意：模型分配页面使用 config.apiConfigs（从后端 get_api_configurations 获取，enabled 状态正确）
  // resolvedApiConfigs 仅用于 API 配置页面的编辑功能
  // 当供应商/模型配置变更时，从后端刷新 ApiConfig 列表（作为“单一事实来源”）
  const refreshApiConfigsFromBackend = useCallback(async () => {
    try {
      if (!invoke) return;
      const apiConfigs = (await invoke('get_api_configurations').catch(() => [])) as ApiConfig[];
      const mappedApiConfigs = (apiConfigs || []).map((c: ApiConfig) => ({
        ...c,
        maxOutputTokens: c.maxOutputTokens,
        temperature: c.temperature,
      }));
      setConfig((prev) => {
        if (prev.apiConfigs.length === mappedApiConfigs.length &&
            prev.apiConfigs.every((c, i) => c.id === mappedApiConfigs[i]?.id && c.enabled === mappedApiConfigs[i]?.enabled)) {
          return prev;
        }
        return { ...prev, apiConfigs: mappedApiConfigs };
      });
    } catch (e) {
      // 静默失败：不阻塞设置页、避免控制台警告噪音
    }
  }, [invoke, setConfig]);

  useEffect(() => {
    const onChanged = () => {
      void refreshApiConfigsFromBackend();
    };
    try {
      window.addEventListener('api_configurations_changed', onChanged);
    } catch {
      // Best-effort listener registration only.
    }
    return () => {
      try {
        window.removeEventListener('api_configurations_changed', onChanged);
      } catch {
        // Best-effort listener cleanup only.
      }
    };
  }, [refreshApiConfigsFromBackend]);

  useEffect(() => {
    setConfig(prev => ({
      ...prev,
      model2ConfigId: modelAssignments.model2_config_id || '',
      ankiCardModelConfigId: modelAssignments.anki_card_model_config_id || '',
      qbank_ai_grading_model_config_id: modelAssignments.qbank_ai_grading_model_config_id || '',
      qbank_ai_generation_model_config_id:
        modelAssignments.qbank_ai_generation_model_config_id || '',
      rerankerModelConfigId: modelAssignments.reranker_model_config_id || '',
      exam_sheet_ocr_model_config_id: modelAssignments.exam_sheet_ocr_model_config_id || '',
      translation_model_config_id: modelAssignments.translation_model_config_id || '',
      chat_title_model_config_id: modelAssignments.chat_title_model_config_id || '',
      // 多模态知识库模型（嵌入模型通过维度管理设置）
      vl_reranker_model_config_id: modelAssignments.vl_reranker_model_config_id || '',
      memory_decision_model_config_id: modelAssignments.memory_decision_model_config_id || '',
      voice_input_asr_model_config_id: modelAssignments.voice_input_asr_model_config_id || '',
      image_generation_model_config_id: modelAssignments.image_generation_model_config_id || '',
      compaction_model_config_id: modelAssignments.compaction_model_config_id || '',
      translation_display_mode: (modelAssignments.translation_display_mode === 'streaming' ? 'streaming' : 'aligned'),
    }));
  }, [modelAssignments]);

  useEffect(() => {
    setConfig(prev => {
      if (prev.theme === themeMode && prev.themePalette === themePalette) {
        return prev;
      }
      return {
        ...prev,
        theme: themeMode,
        themePalette,
      };
    });
  }, [themeMode, themePalette]);

  useEffect(() => {
    if (!Array.isArray(config.mcpTools)) {
      const normalized = normalizeMcpToolList(config.mcpTools);
      setConfig(prev => ({ ...prev, mcpTools: normalized }));
    }
  }, [config.mcpTools]);

  // 监听模型分配变更事件（Chat V2 修改默认模型后广播）
  useEffect(() => {
    const reloadAssignments = async () => {
      try {
        const assignments = await invoke<{
          model2_config_id: string | null;
          anki_card_model_config_id: string | null;
          qbank_ai_grading_model_config_id: string | null;
          qbank_ai_generation_model_config_id: string | null;
          reranker_model_config_id: string | null;
          exam_sheet_ocr_model_config_id: string | null;
          translation_model_config_id: string | null;
          chat_title_model_config_id: string | null;
          vl_reranker_model_config_id: string | null;
          memory_decision_model_config_id: string | null;
          voice_input_asr_model_config_id: string | null;
          image_generation_model_config_id: string | null;
          compaction_model_config_id: string | null;
          translation_display_mode: string | null;
        }>('get_model_assignments');
        setConfig(prev => ({
          ...prev,
          model2ConfigId: assignments?.model2_config_id || '',
          ankiCardModelConfigId: assignments?.anki_card_model_config_id || '',
          qbank_ai_grading_model_config_id: assignments?.qbank_ai_grading_model_config_id || '',
          qbank_ai_generation_model_config_id:
            assignments?.qbank_ai_generation_model_config_id || '',
          rerankerModelConfigId: assignments?.reranker_model_config_id || '',
          chat_title_model_config_id: assignments?.chat_title_model_config_id || '',
          exam_sheet_ocr_model_config_id: assignments?.exam_sheet_ocr_model_config_id || '',
          translation_model_config_id: assignments?.translation_model_config_id || '',
          vl_reranker_model_config_id: assignments?.vl_reranker_model_config_id || '',
          memory_decision_model_config_id: assignments?.memory_decision_model_config_id || '',
          voice_input_asr_model_config_id: assignments?.voice_input_asr_model_config_id || '',
          image_generation_model_config_id: assignments?.image_generation_model_config_id || '',
          compaction_model_config_id: assignments?.compaction_model_config_id || '',
          translation_display_mode: (assignments?.translation_display_mode === 'streaming' ? 'streaming' : 'aligned'),
        }));
      } catch {
        // Ignore malformed cached assignments and keep current settings state.
      }
    };
    window.addEventListener('model_assignments_changed', reloadAssignments);
    return () => window.removeEventListener('model_assignments_changed', reloadAssignments);
  }, []);

  return refreshApiConfigsFromBackend;
}
