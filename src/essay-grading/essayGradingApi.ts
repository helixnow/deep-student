/**
 * 作文批改 API 封装
 * 
 * @deprecated 此模块已废弃，请使用 DSTU 适配器
 * @see src/dstu/adapters/essayDstuAdapter.ts
 * 
 * 迁移指南：
 * - getSession() → essayDstuAdapter.getEssay()
 * - deleteSession() → essayDstuAdapter.deleteEssay()
 */

import { invoke } from '@tauri-apps/api/core';
import { getErrorDetails, getErrorMessage } from '../utils/errorUtils';
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

/**
 * 会话列表项（对齐后端 VfsEssaySession 的序列化输出）
 *
 * 注意与 GradingSessionListItem 的差异：
 * - latest_score 在后端为 None 时整个字段被跳过（skip_serializing_if），故为可选
 * - 无 latest_input_preview 字段（后端列表命令不提供预览）
 */
export interface GradingSessionSummary {
  id: string;
  title: string;
  /** 作文类型（后端始终序列化为字符串，缺省为空串） */
  essay_type: string;
  /** 学段（后端始终序列化为字符串，缺省为空串） */
  grade_level: string;
  custom_prompt: string | null;
  total_rounds: number;
  /** 最新分数（后端无分数时字段缺失） */
  latest_score?: number | null;
  is_favorite: boolean;
  created_at: string;
  updated_at: string;
  /** 软删除时间（回收站；正常列表中字段缺失） */
  deleted_at?: string;
}

export interface ListSessionsParams {
  offset?: number;
  limit?: number;
  /** 搜索关键词（后端按标题/文体/年级做大小写不敏感的包含匹配） */
  query?: string;
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
 * 获取会话列表（分页）
 *
 * 后端命令：essay_grading_list_sessions（offset/limit/query）
 * query 非空时后端按标题/文体/年级做大小写不敏感的包含匹配，过滤后再分页。
 */
export async function listSessions(params: ListSessionsParams = {}): Promise<GradingSessionSummary[]> {
  try {
    return await invoke<GradingSessionSummary[]>('essay_grading_list_sessions', {
      offset: params.offset ?? null,
      limit: params.limit ?? null,
      query: params.query ?? null,
    });
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
  'gaokao_en_short',
  'gaokao_en_long',
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
    case 'gaokao_english_short':
    case 'gaokao_eng_short':
      return 'gaokao_en_short';
    case 'gaokao_english_long':
    case 'gaokao_eng_long':
    case 'gaokao_en_continuation':
      return 'gaokao_en_long';
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

// ======================== 错误分类 ========================

/** 批改错误类别 */
export type GradingErrorKind =
  | 'api_key_missing'
  | 'network'
  | 'model_not_found'
  | 'unknown';

export interface GradingErrorClassification {
  kind: GradingErrorKind;
  /** 是否建议向用户展示"重试"入口（配置类错误需先修改设置，重试无意义） */
  retryable: boolean;
  /** UI 友好的 i18n 消息 key（essay_grading namespace） */
  messageKey: string;
  /** 原始（脱敏后）错误消息，供诊断展示 */
  rawMessage: string;
}

const API_KEY_PATTERNS = /api[\s_-]?key|api\s*密钥|密钥未|密钥不能为空|no api key|missing key|unauthorized|invalid[\s_-]?key|401/i;
const NETWORK_PATTERNS = /network|timed?\s?out|timeout|connection|connect|dns|socket|unreachable|fetch failed|网络|连接|超时|离线|offline/i;
const MODEL_NOT_FOUND_PATTERNS = /model.*(not.?found|does not exist|not exist|unavailable|invalid)|(not.?found|invalid).*model|模型不存在|模型未找到|找不到模型|模型配置(不存在|无效)|未找到模型配置|404/i;

/**
 * 将 essay_grading_stream 等命令 reject 的 AppError（或任意错误）
 * 分类为 UI 友好的可重试标记与 i18n 消息 key。
 *
 * 后端 AppError 序列化形如 { error_type: "LLM"|"Network"|..., message, details }，
 * 优先使用 error_type，再按消息文本模式匹配兜底。
 */
export function classifyGradingError(error: unknown): GradingErrorClassification {
  const rawMessage = getErrorMessage(error);
  const details = getErrorDetails(error);
  const haystack = [rawMessage, details.detail ?? '', details.code ?? ''].join(' ');

  const errorType = error && typeof error === 'object' && typeof (error as Record<string, unknown>).error_type === 'string'
    ? ((error as Record<string, unknown>).error_type as string)
    : null;

  if (API_KEY_PATTERNS.test(haystack)) {
    return {
      kind: 'api_key_missing',
      retryable: false,
      messageKey: 'essay_grading:errors.api_key_missing',
      rawMessage,
    };
  }

  if (errorType === 'Network' || NETWORK_PATTERNS.test(haystack)) {
    return {
      kind: 'network',
      retryable: true,
      messageKey: 'essay_grading:errors.network_error',
      rawMessage,
    };
  }

  if (MODEL_NOT_FOUND_PATTERNS.test(haystack)) {
    return {
      kind: 'model_not_found',
      retryable: false,
      messageKey: 'essay_grading:errors.model_not_found',
      rawMessage,
    };
  }

  return {
    kind: 'unknown',
    retryable: true,
    messageKey: 'essay_grading:errors.grading_failed',
    rawMessage,
  };
}

/**
 * 便捷函数：直接返回本地化后的 UI 错误消息。
 */
export function getGradingErrorDisplayMessage(error: unknown): string {
  const { messageKey, rawMessage } = classifyGradingError(error);
  return i18n.t(messageKey, { defaultValue: rawMessage });
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
