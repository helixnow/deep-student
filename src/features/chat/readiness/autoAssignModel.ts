/**
 * Chat V2 - 自动分配模型工具
 *
 * 当用户已配置供应商和模型（如 DeepSeek API + deepseek-chat），
 * 但尚未在「设置 → 模型分配」中为各角色分配模型时，
 * 系统自动选取首个匹配的可用模型填入对应空槽位。
 *
 * 过滤逻辑与设置页 ModelsTab 中的 get*Apis 函数保持一致，
 * 不依赖 React hook 上下文。
 */

import { invoke } from '@tauri-apps/api/core';
import type { ApiConfig, ModelAssignments } from '@/types';
import { inferApiCapabilities } from '@/utils/apiCapabilityEngine';
import { sortApiConfigsByVendorOrder } from '@/utils/modelSorting';
import {
  isAudioTranscriptionApi,
  isVoiceInputProviderSupported,
} from '@/voice-input/modelSelection';
import { ensureModelsCacheLoaded, getCachedModels } from '../hooks/useAvailableModels';

// ============================================================================
// 类型
// ============================================================================

export interface AutoAssignResult {
  /** 是否有任何槽位被自动分配 */
  assigned: boolean;
  /** 本次自动分配了多少个槽位 */
  assignedCount: number;
  /** 被分配的模型名称列表（用于通知显示） */
  assignedModelNames: string[];
  /** 自动分配失败的说明（无模型可用时设置） */
  reason?: string;
}

// ============================================================================
// 过滤谓词（与 useSettingsVendorState.tsx 中 get*Apis 保持一致）
// ============================================================================

/** 是否为可用的对话模型（非 embedding、非 reranker、已启用） */
function isChatModel(api: ApiConfig): boolean {
  return api.enabled && !api.isEmbedding && !api.isReranker;
}

/** 是否为可用的嵌入模型 */
function isEmbeddingModel(api: ApiConfig): boolean {
  return api.enabled && api.isEmbedding === true && api.isReranker !== true;
}

/** 是否为可用的重排序模型 */
function isRerankerModel(api: ApiConfig): boolean {
  return api.enabled && api.isReranker === true;
}

/** 是否为可用的图像生成模型（与 useSettingsVendorState.isImageGenerationApi 一致） */
function isImageGenerationModel(api: ApiConfig): boolean {
  if (api.isEmbedding || api.isReranker) return false;
  if (api.isImageGeneration === true) return true;
  const caps = inferApiCapabilities({
    id: api.model,
    name: api.name,
    providerScope: api.providerScope ?? api.providerType,
  });
  return caps.imageModel;
}

/** 是否为可用的多模态模型 */
function isMultimodalModel(api: ApiConfig): boolean {
  return api.enabled && api.isMultimodal === true && !api.isEmbedding && !api.isReranker;
}

/**
 * 是否为可用的语音输入 ASR 模型
 * 与 getVisibleVoiceInputApis 的区别：只取 enabled + 支持的供应商
 */
function isAsrModel(api: ApiConfig): boolean {
  if (!api.enabled) return false;
  if (!isAudioTranscriptionApi(api)) return false;
  const providerScope = (api.providerScope ?? api.providerType ?? '').toLowerCase();
  return isVoiceInputProviderSupported(providerScope);
}

// ============================================================================
// 分配槽位定义
// ============================================================================

interface AssignmentSlot {
  /** ModelAssignments 中的字段名 */
  field: keyof ModelAssignments;
  /** 过滤函数 */
  filter: (api: ApiConfig) => boolean;
  /** 在通知中显示的中文/英文标签 */
  label: string;
}

/**
 * 所有需要自动分配的槽位
 * 注意：不包含 translation_display_mode（非模型字段）
 */
const SLOTS: AssignmentSlot[] = [
  { field: 'model2_config_id', filter: isChatModel, label: '对话模型' },
  { field: 'anki_card_model_config_id', filter: isChatModel, label: 'Anki 卡片生成' },
  { field: 'qbank_ai_grading_model_config_id', filter: isChatModel, label: '题库 AI 评分' },
  { field: 'chat_title_model_config_id', filter: isChatModel, label: '聊天标题生成' },
  { field: 'translation_model_config_id', filter: isChatModel, label: '翻译' },
  { field: 'memory_decision_model_config_id', filter: isChatModel, label: '记忆决策' },
  { field: 'image_generation_model_config_id', filter: isImageGenerationModel, label: '图像生成' },
  { field: 'voice_input_asr_model_config_id', filter: isAsrModel, label: '语音输入 ASR' },
  { field: 'reranker_model_config_id', filter: isRerankerModel, label: '重排序' },
  { field: 'vl_reranker_model_config_id', filter: isRerankerModel, label: '多模态重排序' },
  { field: 'embedding_model_config_id', filter: isEmbeddingModel, label: '嵌入' },
  { field: 'vl_embedding_model_config_id', filter: isEmbeddingModel, label: '多模态嵌入' },
  { field: 'exam_sheet_ocr_model_config_id', filter: isMultimodalModel, label: '试卷 OCR' },
];

// ============================================================================
// 广播事件
// ============================================================================

function broadcastModelAssignmentsChange(): void {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('model_assignments_changed'));
    }
  } catch {
    // 非浏览器环境忽略
  }
}

// ============================================================================
// 主函数
// ============================================================================

/**
 * 自动为所有空分配槽位填入首个匹配的可用模型。
 *
 * 调用后端 get_api_configurations 获取模型列表，用与设置页相同的过滤谓词
 * 筛选各槽位所需的模型类型，取按供应商排序后的第一个，持久化保存。
 *
 * 仅当 model2_config_id 为空时才触发（由 readinessGate 控制调用时机）。
 */
export async function autoAssignAllModels(): Promise<AutoAssignResult> {
  try {
    // 1. 获取当前分配
    const currentAssignments = await invoke<ModelAssignments>('get_model_assignments');

    // 2. 获取所有 API 配置并按供应商排序（与下拉框一致）
    const configs = await invoke<ApiConfig[]>('get_api_configurations');
    const sortedConfigs = sortApiConfigsByVendorOrder(configs, []);

    // 3. 检查每个空槽位是否有可用模型
    const changes: Partial<ModelAssignments> = {};
    const assignedNames: string[] = [];

    for (const slot of SLOTS) {
      // 跳过已分配的槽位
      const currentValue = currentAssignments[slot.field];
      if (currentValue && currentValue !== '' && currentValue !== null) {
        continue;
      }

      // 按过滤条件找第一个
      const matched = sortedConfigs.find(slot.filter);
      if (matched) {
        changes[slot.field] = matched.id as any;
        assignedNames.push(matched.name || matched.model);
      }
    }

    // 4. 若无任何变更，返回
    const changeKeys = Object.keys(changes);
    if (changeKeys.length === 0) {
      return {
        assigned: false,
        assignedCount: 0,
        assignedModelNames: [],
        reason: 'no_available_models',
      };
    }

    // 5. 合并并保存
    const merged: ModelAssignments = { ...currentAssignments, ...changes };
    await invoke('save_model_assignments', { assignments: merged });
    broadcastModelAssignmentsChange();

    return {
      assigned: true,
      assignedCount: changeKeys.length,
      assignedModelNames: assignedNames,
    };
  } catch (error) {
    console.error('[autoAssignModel] Auto-assignment failed:', error);
    return {
      assigned: false,
      assignedCount: 0,
      assignedModelNames: [],
      reason: 'error',
    };
  }
}

/**
 * 轻量辅助函数：获取第一个可用的对话模型 ID。
 *
 * 只读不写，用于 TauriAdapter 的运行时兜底 fallback。
 */
export async function getFirstAvailableChatModelId(): Promise<string | null> {
  try {
    await ensureModelsCacheLoaded();
    const models = getCachedModels();
    if (models && models.length > 0) {
      return models[0].id;
    }
    return null;
  } catch {
    return null;
  }
}
