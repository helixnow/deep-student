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
  if (!api.enabled) return false;
  if (api.isEmbedding || api.isReranker) return false;
  if (api.isImageGeneration === true) return true;
  const caps = inferApiCapabilities({
    id: api.model,
    name: api.name,
    providerScope: api.providerScope ?? api.providerType,
  });
  return caps.imageModel;
}

/** 是否为可用的多模态模型（含 vision 能力推断） */
function isMultimodalModel(api: ApiConfig): boolean {
  if (!api.enabled || api.isEmbedding || api.isReranker) return false;
  if (isDiscontinuedOcrModel(api)) return false;
  if (api.isMultimodal === true) return true;
  const caps = inferApiCapabilities({
    id: api.model,
    name: api.name,
    providerScope: api.providerScope ?? api.providerType,
  });
  return caps.vision;
}

/**
 * 已知已停止服务的 OCR/VLM 模型组合（提供商 base_url + 模型名）。
 * 与 Rust 侧 llm_manager::is_discontinued_ocr_model 保持一致。
 * 2026-08：硅基流动已下架 zai-org/GLM-4.6V。
 */
export function isDiscontinuedOcrModel(api: ApiConfig): boolean {
  const url = (api.baseUrl ?? '').toLowerCase();
  const model = (api.model ?? '').toLowerCase();
  return url.includes('siliconflow') && model.includes('glm-4.6v');
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
}

/**
 * 所有需要自动分配的槽位
 * 注意：不包含 translation_display_mode（非模型字段）
 */
const SLOTS: AssignmentSlot[] = [
  { field: 'model2_config_id', filter: isChatModel },
  { field: 'anki_card_model_config_id', filter: isChatModel },
  { field: 'qbank_ai_grading_model_config_id', filter: isChatModel },
  { field: 'chat_title_model_config_id', filter: isChatModel },
  { field: 'translation_model_config_id', filter: isChatModel },
  { field: 'memory_decision_model_config_id', filter: isChatModel },
  { field: 'image_generation_model_config_id', filter: isImageGenerationModel },
  { field: 'voice_input_asr_model_config_id', filter: isAsrModel },
  { field: 'reranker_model_config_id', filter: isRerankerModel },
  { field: 'vl_reranker_model_config_id', filter: isRerankerModel },
  { field: 'embedding_model_config_id', filter: isEmbeddingModel },
  { field: 'vl_embedding_model_config_id', filter: isEmbeddingModel },
  { field: 'exam_sheet_ocr_model_config_id', filter: isMultimodalModel },
];

/**
 * OCR 引擎信息（与后端 AvailableOcrModelResponse 对应，camelCase）
 */
interface OcrEngineEntry {
  configId: string;
  model: string;
  name: string;
  isFree: boolean;
  enabled: boolean;
  priority: number;
}

const SYSTEM_OCR_CONFIG_ID = '__system_ocr__';

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

/**
 * 清理不可用的 OCR 引擎，并注册所有视觉模型为 OCR 引擎
 *
 * 1. 检查现有 OCR 引擎对应的 API 配置是否可用（未被禁用/删除）
 * 2. 移除不可用的引擎
 * 3. 如果移除后只剩系统 OCR，继续注册新的视觉模型
 * 4. 如果移除后还有其他自定义模型，跳过注册
 * 5. 调整优先级使系统 OCR 排在最后
 */
async function ensureAllVisionModelsRegisteredAsOcr(): Promise<void> {
  try {
    // 获取所有 API 配置
    const configs = await invoke<ApiConfig[]>('get_api_configurations');
    const configMap = new Map(configs.map(c => [c.id, c]));

    // 读取现有 OCR 引擎列表
    let existingEngines: OcrEngineEntry[] = [];
    try {
      existingEngines = await invoke<OcrEngineEntry[]>('get_available_ocr_models');
    } catch {
      // 无列表，从空开始
    }

    console.log('[autoAssignModel] 清理前 OCR 引擎列表:', existingEngines.map(e => ({
      id: e.configId,
      name: e.name,
      priority: e.priority,
      enabled: e.enabled,
    })));

    // 清理不可用的 OCR 引擎
    const enginesToRemove: string[] = [];
    for (const engine of existingEngines) {
      // 跳过系统 OCR
      if (engine.configId === SYSTEM_OCR_CONFIG_ID) continue;

      const config = configMap.get(engine.configId);
      // API 配置不存在、已禁用、或模型已停服（如硅基流动已下架 GLM-4.6V），需要移除
      if (!config || !config.enabled || isDiscontinuedOcrModel(config)) {
        enginesToRemove.push(engine.configId);
      }
    }

    // 移除不可用的引擎
    for (const configId of enginesToRemove) {
      try {
        await invoke('remove_ocr_engine', { configId });
        console.log('[autoAssignModel] 移除不可用 OCR 引擎:', configId);
      } catch (err: any) {
        console.error('[autoAssignModel] 移除 OCR 引擎失败:', configId, err);
      }
    }

    if (enginesToRemove.length > 0) {
      console.log('[autoAssignModel] 已移除', enginesToRemove.length, '个不可用 OCR 引擎');
    }

    // 重新读取引擎列表
    let currentEngines: OcrEngineEntry[] = [];
    try {
      currentEngines = await invoke<OcrEngineEntry[]>('get_available_ocr_models');
    } catch {
      return;
    }

    const customEngines = currentEngines.filter(e => e.configId !== SYSTEM_OCR_CONFIG_ID);
    console.log('[autoAssignModel] 清理后剩余自定义 OCR 引擎数量:', customEngines.length);

    // 始终注册所有可用的视觉模型，不因已有自定义引擎而跳过
    // 确保当前槽位分配的模型一定被注册到 OCR 引擎列表中
    console.log('[autoAssignModel] 开始注册视觉模型...');

    const existingConfigIds = new Set(currentEngines.map(e => e.configId));
    let registeredCount = 0;

    // 遍历所有配置，注册视觉模型（跳过已停服模型，如硅基流动已下架的 GLM-4.6V）
    for (const config of configs) {
      if (existingConfigIds.has(config.id)) continue; // 已注册，跳过
      if (isDiscontinuedOcrModel(config)) continue; // 停服模型不注册
      if (!isMultimodalModel(config)) continue; // 复用已有的多模态判断逻辑

      // 注册为 OCR 引擎
      try {
        await invoke('add_ocr_engine', {
          configId: config.id,
          model: config.model,
          name: config.name || config.model
        });
        registeredCount++;
        console.log('[autoAssignModel] 注册 OCR 引擎:', config.name || config.model);
      } catch (err: any) {
        // 忽略"已存在"错误
        if (err?.message !== '该模型已在 OCR 引擎列表中') {
          console.error('[autoAssignModel] 注册 OCR 引擎失败:', config.name || config.model, err);
        }
      }
    }

    if (registeredCount > 0) {
      console.log('[autoAssignModel] 本次注册了', registeredCount, '个 OCR 引擎');
    }

    // 确保系统 OCR 优先级最低
    await ensureSystemOcrLastPriority();

    // 读取最终的 OCR 引擎列表
    let finalEngines: OcrEngineEntry[] = [];
    try {
      finalEngines = await invoke<OcrEngineEntry[]>('get_available_ocr_models');
    } catch {
      // 忽略
    }
    console.log('[autoAssignModel] 最终 OCR 引擎列表:', finalEngines.map(e => ({
      id: e.configId,
      name: e.name,
      priority: e.priority,
      enabled: e.enabled,
    })));
  } catch (err) {
    console.error('[autoAssignModel] Failed to register vision models as OCR:', err);
  }
}

/**
 * 确保系统 OCR 在优先级列表中排在最后
 */
async function ensureSystemOcrLastPriority(): Promise<void> {
  try {
    let engines: OcrEngineEntry[] = [];
    try {
      engines = await invoke<OcrEngineEntry[]>('get_available_ocr_models');
    } catch {
      return;
    }

    const systemOcr = engines.find(e => e.configId === SYSTEM_OCR_CONFIG_ID);
    if (!systemOcr) return;

    // 检查系统 OCR 是否已在最后
    const maxPriority = Math.max(...engines.map(e => e.priority));
    if (systemOcr.priority === maxPriority) return;

    // 重新排列：非系统 OCR 在前，系统 OCR 在最后
    const reordered = engines
      .filter(e => e.configId !== SYSTEM_OCR_CONFIG_ID)
      .map(e => ({ configId: e.configId, enabled: e.enabled }));
    reordered.push({ configId: SYSTEM_OCR_CONFIG_ID, enabled: systemOcr.enabled });

    await invoke('update_ocr_engine_priority', { engineList: reordered });
    console.log('[autoAssignModel] 已将系统 OCR 移至优先级最后');
  } catch (err) {
    console.error('[autoAssignModel] Failed to adjust system OCR priority:', err);
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
 * 调用方：
 * - readinessGate.resolveChatReadiness：发送消息前发现 model2 缺失时兜底触发；
 * - 设置页（Settings / useSettingsVendorState / vendorModelService）：
 *   保存 API Key、增删模型后主动触发，保持各槽位与可用模型同步。
 *
 * 函数本身幂等：已分配且仍可用的槽位会被跳过，可安全重复调用。
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
      const currentValue = currentAssignments[slot.field];
      // OCR 槽位：系统 OCR（__system_ocr__）视为未分配，触发自动分配用用户模型替代
      const isSystemOcr = slot.field === 'exam_sheet_ocr_model_config_id' && currentValue === SYSTEM_OCR_CONFIG_ID;
      const isAssigned = currentValue && currentValue !== '' && currentValue !== null && !isSystemOcr;

      if (isAssigned) {
        // 已分配的槽位：检查模型是否被禁用、不存在或不再满足该槽位类型要求
        const assignedApi = sortedConfigs.find(c => c.id === currentValue);
        if (!assignedApi || !assignedApi.enabled || !slot.filter(assignedApi)) {
          // 模型被禁用、已删除或类型不匹配，需要重新分配
          const matched = sortedConfigs.find(slot.filter);
          if (matched) {
            changes[slot.field] = matched.id as any;
            assignedNames.push(matched.name || matched.model);
            if (slot.field === 'exam_sheet_ocr_model_config_id') {
              console.log('[autoAssignModel] OCR 槽位重新分配:', matched.name || matched.model);
            }
          } else {
            // 一个能用的都没有，清空为 null
            changes[slot.field] = null as any;
            assignedNames.push('(无)');
          }
        }
        // 模型存在且启用，跳过
        continue;
      }

      // 未分配的槽位：找第一个可用模型
      const matched = sortedConfigs.find(slot.filter);
      if (matched) {
        changes[slot.field] = matched.id as any;
        assignedNames.push(matched.name || matched.model);
        if (slot.field === 'exam_sheet_ocr_model_config_id') {
          console.log('[autoAssignModel] OCR 槽位首次分配:', matched.name || matched.model);
        }
      }
    }

    // 4. 合并并保存（如有变更）
    const changeKeys = Object.keys(changes);
    if (changeKeys.length > 0) {
      const merged: ModelAssignments = { ...currentAssignments, ...changes };
      await invoke('save_model_assignments', { assignments: merged });
      broadcastModelAssignmentsChange();
    }

    // 5. 清理不可用的 OCR 引擎，并根据情况注册新引擎
    // 无论 OCR 槽位状态如何都执行清理，确保列表干净
    await ensureAllVisionModelsRegisteredAsOcr();

    return {
      assigned: changeKeys.length > 0,
      assignedCount: changeKeys.length,
      assignedModelNames: assignedNames,
      reason: changeKeys.length === 0 ? 'already_assigned' : undefined,
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
