import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from './errorUtils';
import { t } from './i18n';
import { isTauriRuntime, invokeWithDebug } from './shared';
import { getSetting, saveSetting } from './settingsApi';
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

// 旧备份命令链路已移除，请使用 DataGovernanceApi（data_governance_*）。

// ===== P0-27 修复：WebView 设置备份/恢复 =====

/** SQLite `settings` 中保存 WebView localStorage 快照的键（跨 Tauri/Electron origin 变更的兜底） */
export const WEBVIEW_LOCALSTORAGE_BACKUP_SETTING_KEY = 'webview.localstorage.backup';

/**
 * 需要随备份导出的 localStorage 键。
 *
 * ★ 键名必须与真实读写处完全一致：旧清单里的 `dstu_theme_mode` /
 * `dstu_theme_palette` 是下划线拼写，实际写入的是 `dstu-theme-mode` /
 * `dstu-theme-palette`，导致主题等偏好长期没有进入备份。
 */
export const BACKUP_LOCALSTORAGE_KEYS = [
  // 主题（useTheme.ts）
  'dstu-theme-mode',
  'dstu-theme-palette',
  'dstu-theme-custom-color',
  // 兼容遗留拼写 / 旧版本键
  'dstu_theme_mode',
  'dstu_theme_palette',
  'deep-student-theme',
  'deep-student-color-palette',
  // 语言（i18nextLanguageDetector + SQLite `language` 副本）
  'i18nextLng',
  'dstu_language',
  // 自定义快捷键（shortcutManager）
  'dstu-custom-shortcuts',
  // 新会话默认权限档（permissionPresetDefaults）
  'chat-v2:default-permission-preset',
  'dstu-default-permission-preset',
  // 命令面板收藏
  'dstu-command-favorites',
  // PDF 阅读器设置（pdfSettingsStore）
  'pdf-settings',
  // 番茄钟
  'pomodoro-storage',
  // 学习台桌面布局
  'learning-hub-desktop',
  // 翻译工作台（PromptPanel / workbench prefs）
  'translation.promptTemplates.v1',
  'translation.workbench.prefs',
  // 技能开关 / 信任 / 收藏 / 组合 / 默认值
  'dstu-skill-enable-overrides',
  'dstu-skill-trust-overrides',
  'deep-student.skill-enable-overrides',
  'deep-student.skill-trust-overrides',
  'dstu-skill-favorites',
  'dstu-skill-bundles',
  'skills.bundles.v1',
  'dstu-skill-defaults',
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
] as const;

/** 动态生成的 localStorage 键前缀（按会话/资源 ID 拼接，必须前缀匹配） */
export const BACKUP_LOCALSTORAGE_PREFIXES = [
  // 作文批改草稿（EssayGradingWorkbench）
  'essay_draft_',
  // 每日练习目标
  'daily_practice_target_',
  // 题库上次做题位置
  'qbank_last_question_',
  // 内置技能定制（skill.builtin.<id>.customization）
  'skill.builtin.',
] as const;

function isBackupEligibleKey(key: string): boolean {
  return (
    (BACKUP_LOCALSTORAGE_KEYS as readonly string[]).includes(key) ||
    BACKUP_LOCALSTORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

/**
 * 保存 WebView localStorage 数据到后端文件系统
 * 在备份导出前调用，确保 UI 偏好设置被包含在备份中
 *
 * ★ 同时镜像到 SQLite `settings`（`webview.localstorage.backup`）：
 * Tauri → Electron 的 origin 变化、Android WebView 缓存清理后，
 * localStorage 会整块丢失，文件快照不一定存在，SQLite 副本是最后的兜底。
 */
export async function saveWebviewSettings(settings: Record<string, string>): Promise<{ success: boolean; path?: string; size?: number }> {
  // 先镜像 SQLite：即使文件写入/命令不可用，副本仍然留存
  try {
    await saveSetting(WEBVIEW_LOCALSTORAGE_BACKUP_SETTING_KEY, JSON.stringify(settings));
  } catch (error: unknown) {
    debugLog.warn('[P0-27] 镜像 WebView 设置到 SQLite 失败:', error);
  }
  return invoke<{ success: boolean; path?: string; size?: number }>('save_webview_settings', { settings });
}

export function collectLocalStorageForBackup(): Record<string, string> {
  const result: Record<string, string> = {};
  if (typeof localStorage === 'undefined') return result;

  for (const key of BACKUP_LOCALSTORAGE_KEYS) {
    try {
      const value = localStorage.getItem(key);
      if (value !== null) {
        result[key] = value;
      }
    } catch {
      // 单个键读取失败不影响其余键
    }
  }

  // 动态前缀键：遍历存储一次收集，避免漏掉任意新的会话/资源键
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || Object.prototype.hasOwnProperty.call(result, key)) continue;
      if (!isBackupEligibleKey(key)) continue;
      const value = localStorage.getItem(key);
      if (value !== null) {
        result[key] = value;
      }
    }
  } catch {
    // localStorage 不可枚举时忽略，静态键仍然有效
  }

  return result;
}

/** 恢复主题类偏好后广播给运行中的 useTheme 实例 */
function broadcastRestoredThemePreferences(snapshot: Record<string, unknown>, restoredKeys: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    const mode = snapshot['dstu-theme-mode'];
    if (restoredKeys.has('dstu-theme-mode') && (mode === 'light' || mode === 'dark' || mode === 'auto')) {
      window.dispatchEvent(new CustomEvent('dstu-theme-mode-changed', { detail: { mode } }));
    }
    const palette = snapshot['dstu-theme-palette'];
    const customColor = snapshot['dstu-theme-custom-color'];
    if (restoredKeys.has('dstu-theme-palette') && typeof palette === 'string') {
      window.dispatchEvent(
        new CustomEvent('dstu-theme-palette-changed', {
          detail: {
            palette,
            customColor: typeof customColor === 'string' ? customColor : undefined,
          },
        }),
      );
    }
  } catch {
    // 广播失败不影响持久化结果
  }
}

/** 读取备份快照：优先后端文件，其次 SQLite `settings` 副本 */
async function loadWebviewSettingsSnapshot(): Promise<Record<string, unknown> | null> {
  if (isTauriRuntime) {
    try {
      const response = await invoke<{ exists?: boolean; settings?: unknown }>('load_webview_settings');
      const settings = response?.settings;
      if (settings && typeof settings === 'object' && !Array.isArray(settings)
        && Object.keys(settings as Record<string, unknown>).length > 0) {
        return settings as Record<string, unknown>;
      }
    } catch (error: unknown) {
      debugLog.warn('[P0-27] 读取 WebView 设置文件失败，回退 SQLite 副本:', error);
    }
  }

  try {
    const raw = await getSetting(WEBVIEW_LOCALSTORAGE_BACKUP_SETTING_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (error: unknown) {
    debugLog.warn('[P0-27] 读取 WebView 设置 SQLite 副本失败:', error);
  }
  return null;
}

/**
 * 启动/恢复后回填缺失的 localStorage 键。
 *
 * 只回填“本地不存在”的键（localStorage 是运行时权威源，绝不覆盖用户
 * 当次会话内做出的新选择），确保任一 localStorage 偏好能自动挺过
 * Tauri→Electron origin 变化、Android WebView 缓存清理与备份恢复。
 *
 * @returns 实际回填的键数量
 */
export async function hydrateWebviewSettingsFromBackup(): Promise<number> {
  if (typeof localStorage === 'undefined') return 0;
  if (!isTauriRuntime) return 0;

  const snapshot = await loadWebviewSettingsSnapshot();
  if (!snapshot) return 0;

  const restoredKeys = new Set<string>();
  for (const [key, value] of Object.entries(snapshot)) {
    if (typeof value !== 'string') continue;
    if (!isBackupEligibleKey(key)) continue;
    try {
      if (localStorage.getItem(key) !== null) continue;
      localStorage.setItem(key, value);
      restoredKeys.add(key);
    } catch (error: unknown) {
      debugLog.warn(`[P0-27] 回填 localStorage 键失败: ${key}`, error);
    }
  }

  if (restoredKeys.size === 0) return 0;
  broadcastRestoredThemePreferences(snapshot, restoredKeys);
  debugLog.log('[P0-27] 已从备份回填 WebView 设置:', [...restoredKeys]);
  return restoredKeys.size;
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
