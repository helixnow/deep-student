/**
 * 作文批改 API 封装
 * 
 * @deprecated 此模块已废弃，请使用 DSTU 适配器
 * @see src/dstu/adapters/essayDstuAdapter.ts
 * 
 * 迁移指南：
 * - listSessions() → essayDstuAdapter.listEssays()
 * - getSession() → essayDstuAdapter.getEssay()
 * - deleteSession() → essayDstuAdapter.deleteEssay()
 */

import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from '../utils/errorUtils';
import i18n from '../i18n';

// ======================== 类型定义 ========================

export interface GradingSession {
  id: string;
  title: string;
  essay_type: string;
  grade_level: string;
  custom_prompt: string | null;
  created_at: string;
  updated_at: string;
  is_favorite: boolean;
  total_rounds: number;
}

export interface GradingRound {
  id: string;
  session_id: string;
  round_number: number;
  input_text: string;
  grading_result: string;
  overall_score: number | null;
  dimension_scores_json: string | null;
  created_at: string;
}

export interface GradingSessionListItem {
  id: string;
  title: string;
  essay_type: string;
  grade_level: string;
  created_at: string;
  updated_at: string;
  is_favorite: boolean;
  total_rounds: number;
  latest_input_preview: string | null;
  latest_score: number | null;
}

// ======================== API 函数 ========================

/**
 * 创建新会话
 */
export async function createSession(params: {
  title: string;
  essay_type: string;
  grade_level: string;
  custom_prompt?: string;
}): Promise<GradingSession> {
  try {
    return await invoke<GradingSession>('essay_grading_create_session', {
      title: params.title,
      essayType: params.essay_type,
      gradeLevel: params.grade_level,
      customPrompt: params.custom_prompt || null,
    });
  } catch (error: unknown) {
    throw new Error(i18n.t('essay_grading:api_errors.create_session_failed', { error: getErrorMessage(error) }));
  }
}

/**
 * 获取会话详情
 */
export async function getSession(sessionId: string): Promise<GradingSession | null> {
  try {
    return await invoke<GradingSession | null>('essay_grading_get_session', {
      sessionId,
    });
  } catch (error: unknown) {
    throw new Error(i18n.t('essay_grading:api_errors.get_session_failed', { error: getErrorMessage(error) }));
  }
}

/**
 * 更新会话（仅传递可变字段）
 *
 * ★ M-061 修复：后端接收 VfsUpdateEssaySessionParams，
 *   只包含 id + 可修改字段，不再需要 created_at / updated_at / total_rounds 等只读字段。
 */
export async function updateSession(session: Pick<GradingSession, 'id'> & Partial<Omit<GradingSession, 'id' | 'created_at' | 'updated_at' | 'total_rounds'>>): Promise<void> {
  try {
    await invoke('essay_grading_update_session', {
      session: {
        id: session.id,
        title: session.title,
        essay_type: session.essay_type?.trim() || undefined,
        grade_level: session.grade_level?.trim() || undefined,
        custom_prompt: session.custom_prompt ?? undefined,
        is_favorite: session.is_favorite,
      },
    });
  } catch (error: unknown) {
    throw new Error(i18n.t('essay_grading:api_errors.update_session_failed', { error: getErrorMessage(error) }));
  }
}

/**
 * 删除会话
 */
export async function deleteSession(sessionId: string): Promise<number> {
  try {
    return await invoke<number>('essay_grading_delete_session', { sessionId });
  } catch (error: unknown) {
    throw new Error(i18n.t('essay_grading:api_errors.delete_session_failed', { error: getErrorMessage(error) }));
  }
}

/**
 * 获取会话列表
 */
export async function listSessions(options?: {
  offset?: number;
  limit?: number;
  query?: string;
}): Promise<{ items: GradingSessionListItem[]; total: number }> {
  try {
    const [items, total] = await invoke<[GradingSessionListItem[], number]>(
      'essay_grading_list_sessions',
      {
        offset: options?.offset || null,
        limit: options?.limit || null,
        query: options?.query || null,
      }
    );
    return { items, total };
  } catch (error: unknown) {
    throw new Error(i18n.t('essay_grading:api_errors.list_sessions_failed', { error: getErrorMessage(error) }));
  }
}

/**
 * 切换收藏状态
 */
export async function toggleFavorite(sessionId: string): Promise<boolean> {
  try {
    return await invoke<boolean>('essay_grading_toggle_favorite', { sessionId });
  } catch (error: unknown) {
    throw new Error(i18n.t('essay_grading:api_errors.toggle_favorite_failed', { error: getErrorMessage(error) }));
  }
}

/**
 * 获取会话的所有轮次
 */
export async function getRounds(sessionId: string): Promise<GradingRound[]> {
  try {
    return await invoke<GradingRound[]>('essay_grading_get_rounds', { sessionId });
  } catch (error: unknown) {
    throw new Error(i18n.t('essay_grading:api_errors.get_rounds_failed', { error: getErrorMessage(error) }));
  }
}

/**
 * 获取指定轮次
 */
export async function getRound(
  sessionId: string,
  roundNumber: number
): Promise<GradingRound | null> {
  try {
    return await invoke<GradingRound | null>('essay_grading_get_round', {
      sessionId,
      roundNumber,
    });
  } catch (error: unknown) {
    throw new Error(i18n.t('essay_grading:api_errors.get_round_failed', { error: getErrorMessage(error) }));
  }
}

/**
 * 获取最新轮次号
 */
export async function getLatestRoundNumber(sessionId: string): Promise<number> {
  try {
    return await invoke<number>('essay_grading_get_latest_round_number', {
      sessionId,
    });
  } catch (error: unknown) {
    throw new Error(i18n.t('essay_grading:api_errors.get_round_number_failed', { error: getErrorMessage(error) }));
  }
}

// ======================== 批阅模式 API ========================

export interface GradingMode {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  score_dimensions: ScoreDimension[];
  total_max_score: number;
  is_builtin: boolean;
  created_at: string;
  updated_at: string;
}

export interface ScoreDimension {
  name: string;
  max_score: number;
  description: string | null;
}

const BUILTIN_MODE_ORDER = [
  'gaokao',
  'ielts',
  'ielts_task1',
  'kaoyan',
  'toefl',
  'cet',
  'zhongkao',
  'practice',
];

const BUILTIN_MODE_ORDER_INDEX = new Map(BUILTIN_MODE_ORDER.map((id, index) => [id, index]));

export function canonicalizeEssayModeId(modeId: string): string {
  const trimmed = modeId.trim();
  switch (trimmed) {
    case 'ielts_task2':
    case 'ielts_writing':
      return 'ielts';
    case 'ielts_task_1':
      return 'ielts_task1';
    case 'cet4':
    case 'cet6':
    case 'cet46':
    case 'cet_46':
      return 'cet';
    default:
      return trimmed;
  }
}

function sortGradingModes(modes: GradingMode[]): GradingMode[] {
  const sorted = [...modes];
  sorted.sort((a, b) => {
    const aCanonicalId = canonicalizeEssayModeId(a.id);
    const bCanonicalId = canonicalizeEssayModeId(b.id);
    const aOrder = BUILTIN_MODE_ORDER_INDEX.get(aCanonicalId);
    const bOrder = BUILTIN_MODE_ORDER_INDEX.get(bCanonicalId);

    if (aOrder !== undefined && bOrder !== undefined) {
      return aOrder - bOrder;
    }
    if (aOrder !== undefined) {
      return -1;
    }
    if (bOrder !== undefined) {
      return 1;
    }

    return b.updated_at.localeCompare(a.updated_at);
  });

  return sorted;
}

/**
 * 获取所有批阅模式
 */
export async function getGradingModes(): Promise<GradingMode[]> {
  try {
    const modes = await invoke<GradingMode[]>('essay_grading_get_modes');
    return sortGradingModes(modes);
  } catch (error: unknown) {
    throw new Error(i18n.t('essay_grading:api_errors.get_modes_failed', { error: getErrorMessage(error) }));
  }
}

/**
 * 获取指定批阅模式
 */
export async function getGradingMode(modeId: string): Promise<GradingMode | null> {
  try {
    const canonicalModeId = canonicalizeEssayModeId(modeId);
    return await invoke<GradingMode | null>('essay_grading_get_mode', { modeId: canonicalModeId });
  } catch (error: unknown) {
    throw new Error(i18n.t('essay_grading:api_errors.get_mode_failed', { error: getErrorMessage(error) }));
  }
}

// ======================== 自定义批阅模式 CRUD API ========================

export interface CreateModeInput {
  name: string;
  description: string;
  system_prompt: string;
  score_dimensions: ScoreDimension[];
  total_max_score: number;
}

export interface UpdateModeInput {
  id: string;
  name?: string;
  description?: string;
  system_prompt?: string;
  score_dimensions?: ScoreDimension[];
  total_max_score?: number;
}

/**
 * 创建自定义批阅模式
 */
export async function createCustomMode(input: CreateModeInput): Promise<GradingMode> {
  try {
    return await invoke<GradingMode>('essay_grading_create_custom_mode', { input });
  } catch (error: unknown) {
    throw new Error(i18n.t('essay_grading:api_errors.create_mode_failed', { error: getErrorMessage(error) }));
  }
}

/**
 * 更新自定义批阅模式
 */
export async function updateCustomMode(input: UpdateModeInput): Promise<GradingMode> {
  try {
    return await invoke<GradingMode>('essay_grading_update_custom_mode', { input });
  } catch (error: unknown) {
    throw new Error(i18n.t('essay_grading:api_errors.update_mode_failed', { error: getErrorMessage(error) }));
  }
}

/**
 * 删除自定义批阅模式
 */
export async function deleteCustomMode(modeId: string): Promise<void> {
  try {
    await invoke('essay_grading_delete_custom_mode', { modeId });
  } catch (error: unknown) {
    throw new Error(i18n.t('essay_grading:api_errors.delete_mode_failed', { error: getErrorMessage(error) }));
  }
}

/**
 * 获取自定义批阅模式列表
 */
export async function listCustomModes(): Promise<GradingMode[]> {
  try {
    return await invoke<GradingMode[]>('essay_grading_list_custom_modes');
  } catch (error: unknown) {
    throw new Error(i18n.t('essay_grading:api_errors.list_custom_modes_failed', { error: getErrorMessage(error) }));
  }
}

export interface SaveBuiltinOverrideInput {
  builtin_id: string;
  name: string;
  description: string;
  system_prompt: string;
  score_dimensions: ScoreDimension[];
  total_max_score: number;
}

/**
 * 保存预置模式的自定义覆盖
 */
export async function saveBuiltinOverride(input: SaveBuiltinOverrideInput): Promise<GradingMode> {
  try {
    return await invoke<GradingMode>('essay_grading_save_builtin_override', { input });
  } catch (error: unknown) {
    throw new Error(i18n.t('essay_grading:api_errors.save_override_failed', { error: getErrorMessage(error) }));
  }
}

/**
 * 重置预置模式为默认配置
 */
export async function resetBuiltinMode(builtinId: string): Promise<GradingMode> {
  try {
    return await invoke<GradingMode>('essay_grading_reset_builtin_mode', { builtinId });
  } catch (error: unknown) {
    throw new Error(i18n.t('essay_grading:api_errors.reset_mode_failed', { error: getErrorMessage(error) }));
  }
}

/**
 * 检查预置模式是否有自定义覆盖
 */
export async function hasBuiltinOverride(builtinId: string): Promise<boolean> {
  try {
    return await invoke<boolean>('essay_grading_has_builtin_override', { builtinId });
  } catch (error: unknown) {
    throw new Error(i18n.t('essay_grading:api_errors.check_override_failed', { error: getErrorMessage(error) }));
  }
}

// ======================== 模型选择 API ========================

export interface ModelInfo {
  id: string;
  name: string;
  model: string;
  is_default: boolean;
}

/**
 * 获取可用的模型列表
 */
export async function getModels(): Promise<ModelInfo[]> {
  try {
    return await invoke<ModelInfo[]>('essay_grading_get_models');
  } catch (error: unknown) {
    throw new Error(i18n.t('essay_grading:api_errors.get_models_failed', { error: getErrorMessage(error) }));
  }
}

// ======================== 导出 API 对象 ========================

export const EssayGradingAPI = {
  createSession,
  getSession,
  updateSession,
  deleteSession,
  listSessions,
  toggleFavorite,
  getRounds,
  getRound,
  getLatestRoundNumber,
  getGradingModes,
  getGradingMode,
  getModels,
  // 自定义模式 CRUD
  createCustomMode,
  updateCustomMode,
  deleteCustomMode,
  listCustomModes,
  // 预置模式覆盖
  saveBuiltinOverride,
  resetBuiltinMode,
  hasBuiltinOverride,
};
