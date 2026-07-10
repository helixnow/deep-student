import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from './errorUtils';
import { t } from './i18n';
import { isTauriRuntime, invokeWithDebug, withGraphId } from './shared';
import type { Tag } from './shared';
import { debugLog } from '../debug-panel/debugMasterSwitch';
import type {
  ExamSheetSessionSummary,
  ExamSheetSessionDetail,
  ExamSheetSessionListResponse,
  ExamSheetSessionDetailResponse,
  UpdateExamSheetCardsRequestPayload,
  UpdateExamSheetCardsResponsePayload,
  RenameExamSheetSessionResponsePayload,
} from './types';

// ==================== LLM 生成答案（基于上下文） ====================
export async function llmGenerateAnswerWithContext(query: string, contextJson: string): Promise<string> {
  try {
    const response = await invoke<string>('llm_generate_answer_with_context', {
      query,
      context_json: contextJson,
    });
    console.log('LLM answer generation success');
    return response;
  } catch (error) {
    console.error('Failed to generate LLM answer:', error);
    throw new Error(`Failed to generate LLM answer: ${getErrorMessage(error)}`);
  }
}

export async function unifiedFixTagHierarchy(graphId: string = 'default'): Promise<string> {
  try {
    console.log('Starting tag tree fix/init (unified API)...');
    const response = await invoke<string>('unified_fix_tag_hierarchy', { ...withGraphId(graphId) });
    console.log('Tag tree fix complete:', response);
    return response;
  } catch (error) {
    console.error('Failed to fix tag tree:', error);
    throw new Error(`Failed to fix tag tree: ${getErrorMessage(error)}`);
  }
}

/**
 * 初始化默认数学五层标签树（若后端提供该命令）
 */
export async function initializeDefaultTagHierarchy(): Promise<string> {
  try {
    console.log('Initializing default tag hierarchy...');
    const response = await invoke<string>('initialize_default_tag_hierarchy');
    console.log('Default tag hierarchy initialized:', response);
    return response;
  } catch (error) {
    console.error('Failed to initialize default tag hierarchy:', error);
    throw new Error(`Failed to initialize default tag hierarchy: ${getErrorMessage(error)}`);
  }
}

// ★ 2026-02 清理：clearIrecLocalDatabase 已删除（无调用方）

/**
 * 生成缺失的标签向量，可指定并发与批量大小（可选）。
 */
export async function generateMissingTagVectors(graphId: string = 'default'): Promise<string> {
  try {
    console.log('Starting batch generation of missing tag vectors...');
    const response = await invoke<{ success: boolean; message: string }>('unified_generate_missing_tag_vectors', { ...withGraphId(graphId) });
    // 订阅进度事件
    try {
      const { listen } = await import('@tauri-apps/api/event');
      const un = await listen<'any'>('tag_vector_status', (e: any) => {
        const p = e?.payload || {};
        console.log('Tag vector progress:', p);
      });
      // 调用方可存储 un 以便页面卸载时取消监听
    } catch (_) {}
    console.log('Tag vector batch task started:', response);
    return response.message;
  } catch (error) {
    console.error('Failed to trigger tag vector generation:', error);
    throw new Error(`Failed to trigger tag vector generation: ${getErrorMessage(error)}`);
  }
}

// 旧备份命令链路已移除，请使用 DataGovernanceApi（data_governance_*）。

// ===== P0-27 修复：WebView 设置备份/恢复 =====

/**
 * 保存 WebView localStorage 数据到后端文件系统
 * 在备份导出前调用，确保 UI 偏好设置被包含在备份中
 */
export async function saveWebviewSettings(settings: Record<string, string>): Promise<{ success: boolean; path?: string; size?: number }> {
  return invoke<{ success: boolean; path?: string; size?: number }>('save_webview_settings', { settings });
}

export function collectLocalStorageForBackup(): Record<string, string> {
  const keysToBackup = [
    // 主题设置
    'dstu_theme_mode',
    'dstu_theme_palette',
    'deep-student-theme',
    'deep-student-color-palette',
    // 语言设置
    'i18nextLng',
    'dstu_language',
    // 新手引导状态
    'onboarding_completed_flows',
    'onboarding_skipped',
    // 其他 UI 偏好
    'sidebar_collapsed',
    'chat_panel_width',
    'learning_hub_layout',
    // 🔧 P1-50: 云存储配置（非敏感信息，密码在安全存储中）
    'cloud_storage_config_v2',
    'cloud_storage_config',  // 旧版配置（用于迁移兼容）
    // 🔧 P1-50: AnkiConnect 配置
    'anki_connect_settings',
    // 🔧 P1-50: 模板编辑器偏好
    'template_editor_prefs',
    // 🔧 P1-50: 命令面板快捷键
    'command_palette_shortcuts',
  ];

  const result: Record<string, string> = {};
  for (const key of keysToBackup) {
    const value = localStorage.getItem(key);
    if (value !== null) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * @deprecated 已移除。请使用 DataGovernanceApi.runHealthCheck() 代替。
 * 旧 backup::run_data_integrity_check 命令已从后端移除。
 */
export async function runDataIntegrityCheck(): Promise<string> {
  throw new Error(
    '旧备份命令 run_data_integrity_check 已移除，请使用 DataGovernanceApi.runHealthCheck() 代替'
  );
}

/**
 * 优化 Lance 数据库（合并碎片、清理旧版本、提升性能）
 * @param parallelism 并行度（默认4）
 */
export async function optimizeLanceDatabase(parallelism?: number, force = true): Promise<{ success: boolean; optimized_tables?: number; duration_ms?: number; message: string; error?: string }> {
  return invoke<{ success: boolean; optimized_tables?: number; duration_ms?: number; message: string; error?: string }>('optimize_lance_database', { parallelism, force });
}

// Data Space (A/B slots)
export async function getDataSpaceInfo(): Promise<{ active_slot: string; inactive_slot: string; pending_slot?: string; active_dir: string; inactive_dir: string; }> {
  if (!isTauriRuntime) {
    return {
      active_slot: 'A',
      inactive_slot: 'B',
      active_dir: '',
      inactive_dir: '',
    };
  }
  try {
    return await invoke('get_data_space_info');
  } catch (error) {
    console.warn('[tauriApi] getDataSpaceInfo call failed, returning default placeholder data.', error);
    return {
      active_slot: 'A',
      inactive_slot: 'B',
      active_dir: '',
      inactive_dir: '',
    };
  }
}

export async function markDataSpacePendingSwitchToInactive(): Promise<string> {
  if (!isTauriRuntime) {
    return 'noop';
  }
  try {
    return await invoke('mark_data_space_pending_switch_to_inactive');
  } catch (error) {
    console.warn('[tauriApi] markDataSpacePendingSwitchToInactive call failed, returning noop.', error);
    return 'noop';
  }
}

// ===== 测试插槽 C/D API（前端全自动备份测试专用）=====

/**
 * 获取测试插槽信息
 * 返回 C/D 插槽的目录路径、是否存在、文件数量等
 */
export async function getTestSlotInfo(): Promise<{
  slot_c_dir: string;
  slot_d_dir: string;
  slot_c_exists: boolean;
  slot_d_exists: boolean;
  slot_c_file_count: number;
  slot_d_file_count: number;
}> {
  return invoke('get_test_slot_info');
}

/**
 * 清空测试插槽 C 和 D
 * 用于测试前的环境准备
 */
export async function clearTestSlots(): Promise<string> {
  return invoke('clear_test_slots');
}

export async function restartApp(): Promise<void> {
  return invoke<void>('restart_app');
}

/**
 * 修复数据库 schema
 * 确保所有必需的列都存在
 */
export async function fixDatabaseSchema(): Promise<string> {
  try {
    console.log('Starting database schema fix...');
    const result = await invoke<string>('fix_database_schema');
    console.log('Database schema fix complete:', result);
    return result;
  } catch (error) {
    console.error('Failed to fix database schema:', error);
    throw error;
  }
}

/**
 * 物理删除所有数据库文件
 * 通过直接删除文件系统中的数据库文件来彻底清空所有数据
 */
export async function purgeAllDatabaseFiles(): Promise<string> {
  try {
    console.log('Purging all database files...');
    const result = await invoke<string>('purge_all_database_files');
    console.log('Database files purge complete:', result);
    return result;
  } catch (error) {
    console.error('Failed to purge database files:', error);
    throw new Error(`Failed to purge database files: ${getErrorMessage(error)}`);
  }
}

export async function purgeActiveDataDirNow(): Promise<string> {
  try {
    console.log('Purging active data directory (no restart)...');
    return await invoke<string>('purge_active_data_dir_now');
  } catch (error) {
    console.error('Failed to purge data directory:', error);
    throw new Error(`Failed to purge data directory: ${getErrorMessage(error)}`);
  }
}

/**
 * 获取真实的存储占用信息
 * 返回详细的存储占用信息，包括数据库、图片、备份等各部分的大小
 */
export async function getStorageInfo(): Promise<{
  total_size: number;
  database_size: number;
  images_size: number;
  images_count: number;
  backups_size: number;
  cache_size: number;
  other_size: number;
  formatted_total: string;
  formatted_database: string;
  formatted_images: string;
  formatted_backups: string;
  formatted_cache: string;
  formatted_other: string;
}> {
  try {
    const response = await invoke<any>('get_storage_info');
    console.log('Get storage info success:', response);
    return response;
  } catch (error: any) {
    console.error('Failed to get storage info:', error);
    throw new Error(`Failed to get storage info: ${getErrorMessage(error)}`);
  }
}

/**
 * 获取应用数据目录（缓存版本）
 */
let appDataDir: string | null = null;

export async function getAppDataDir(): Promise<string> {
  if (!appDataDir) {
    try {
      appDataDir = await invoke<string>('get_app_data_dir');
    } catch (e) {
      // 后端未提供时使用空字符串占位
      appDataDir = '';
    }
  }
  return appDataDir;
}

export async function getAppVersion(): Promise<string> {
  try {
    return await invoke<string>('get_app_version');
  } catch (error) {
    console.error('Failed to get app version, returning dev', error);
    return 'dev';
  }
}

// ★ 文档31清理：移除 subject 参数
export async function listExamSheetSessions(params: {
  limit?: number;
}): Promise<ExamSheetSessionSummary[]> {
  try {
    const payload = {
      limit: params.limit ?? 50,
    };
    const response = await invokeWithDebug<ExamSheetSessionListResponse>(
      'list_exam_sheet_sessions',
      { request: payload },
      { tag: 'exam_sheet_list' }
    );
    return response.sessions;
  } catch (error) {
    throw new Error(`Failed to load exam sheet history: ${getErrorMessage(error)}`);
  }
}

export async function getExamSheetSessionDetail(sessionId: string): Promise<ExamSheetSessionDetail> {
  try {
    const response = await invokeWithDebug<ExamSheetSessionDetailResponse>(
      'get_exam_sheet_session_detail',
      { request: { session_id: sessionId } },
      { tag: 'exam_sheet_detail' }
    );
    return response.detail;
  } catch (error) {
    throw new Error(`Failed to get exam sheet detail: ${getErrorMessage(error)}`);
  }
}

export async function updateExamSheetCards(request: UpdateExamSheetCardsRequestPayload): Promise<ExamSheetSessionDetail> {
  try {
    const response = await invokeWithDebug<UpdateExamSheetCardsResponsePayload>(
      'update_exam_sheet_cards',
      { request },
      { tag: 'exam_sheet_update' }
    );
    return response.detail;
  } catch (error) {
    throw new Error(`Failed to update exam sheet data: ${getErrorMessage(error)}`);
  }
}

export async function renameExamSheetSession(sessionId: string, examName?: string): Promise<ExamSheetSessionSummary> {
  try {
    const response = await invokeWithDebug<RenameExamSheetSessionResponsePayload>(
      'rename_exam_sheet_session',
      { request: { session_id: sessionId, exam_name: examName ?? null } },
      { tag: 'exam_sheet_rename' }
    );
    return response.summary;
  } catch (error) {
    throw new Error(`Failed to rename exam sheet: ${getErrorMessage(error)}`);
  }
}

// ★ 2026-01 清理：linkExamSheetSessionMistakes 和 unlinkExamSheetSessionMistake 已删除（错题关联功能废弃）

// ★ processExamSheetPreview 已移除（整卷识别废弃，统一走 import_question_bank_stream）

// =================================================
// 断点续导
// =================================================

/** 查询可恢复的中断导入会话 */
export async function listImportingSessions(): Promise<Array<{
  session_id: string;
  exam_name: string | null;
  import_state_json: string | null;
  existing_question_count: number;
}>> {
  try {
    return await invokeWithDebug('list_importing_sessions', {}, { tag: 'list_importing' });
  } catch (error) {
    debugLog.warn('[TauriAPI] listImportingSessions failed:', error);
    return [];
  }
}

/** 恢复中断的题目集导入（流式，发送 question_import_progress 事件） */
export async function resumeQuestionImport(sessionId: string): Promise<ExamSheetSessionDetail> {
  return invokeWithDebug<ExamSheetSessionDetail>(
    'resume_question_import',
    { sessionId },
    { tag: 'resume_import' }
  );
}

// =================================================
// 包管理器检测和安装
// =================================================

export async function checkPackageManager(command: string): Promise<{
  detected: boolean;
  manager_type?: string;
  is_available?: boolean;
  version?: string;
  install_hints?: string[];
  can_auto_install?: boolean;
  message?: string;
}> {
  try {
    return await invoke('check_package_manager', { command });
  } catch (error) {
    console.error('Failed to check package manager:', error);
    throw new Error(`Failed to check package manager: ${getErrorMessage(error)}`);
  }
}

export async function autoInstallPackageManager(managerType: string): Promise<{
  success: boolean;
  message: string;
  installed_version?: string;
}> {
  try {
    return await invoke('auto_install_package_manager', { managerType });
  } catch (error) {
    console.error('Failed to auto-install package manager:', error);
    throw new Error(`Failed to auto-install package manager: ${getErrorMessage(error)}`);
  }
}

export async function checkAllPackageManagers(): Promise<{
  node: { is_available: boolean; version?: string; install_hints: string[] };
  python: { is_available: boolean; version?: string; install_hints: string[] };
  uv: { is_available: boolean; version?: string; install_hints: string[]; can_auto_install: boolean };
  cargo: { is_available: boolean; version?: string; install_hints: string[]; can_auto_install: boolean };
}> {
  try {
    return await invoke('check_all_package_managers');
  } catch (error) {
    console.error('Failed to check all package managers:', error);
    throw new Error(`Package manager check failed: ${getErrorMessage(error)}`);
  }
}

// ★ 2026-01 清理：错题分析相关占位方法已删除（analyzeNewMistake, analyzeFromBridge, analyzeStepByStep, startStreamingAnswer, continueChatStream, runtimeAutosaveCommit 等）

/**
 * 导入对话快照（占位）
 * @deprecated 后端尚未实现，返回失败状态
 */
export async function importConversationSnapshot(_params: unknown): Promise<{
  success: boolean;
  conversationId?: string;
  message?: string;
  warnings?: string[];
}> {
  console.warn('[TauriAPI] importConversationSnapshot not yet implemented');
  return {
    success: false,
    message: t('utils.errors.import_not_implemented'),
    warnings: [t('utils.warnings.feature_unavailable')],
  };
}

/**
 * 保存图片到图片目录（占位）
 * @deprecated 后端尚未实现，返回空路径
 */
export async function saveImageToImagesDir(
  _imageBase64: string,
  _fileName?: string
): Promise<{ path: string }> {
  console.warn('[TauriAPI] saveImageToImagesDir not yet implemented, returning empty path');
  return { path: '' };
}
