/**
 * `export_unified_backup_data`（src-tauri/src/commands.rs:6553-6640）。
 *
 * 只导出传统数据：`reviews` 固定为空（Rust 中回顾分析功能已移除），设置来自主库
 * `settings` 表，API 配置与模型分配来自 L02 LLM manager。
 */
import { CommandError } from '../host/kernel/api.ts';

export interface BackupSettingsStore {
  listByPrefix(prefix: string): readonly { key: string; value: string }[];
}

export interface BackupLlmManager {
  getApiConfigs(): Promise<unknown[]>;
  getModelAssignments(): Promise<unknown>;
}

export interface BackupExportDeps {
  settings: BackupSettingsStore;
  /** `include_settings=false` 时 Rust 不会读取 LLM manager，因此允许省略。 */
  llm: BackupLlmManager | null;
  now(): string;
}

export interface UnifiedBackupData {
  version: '3.0';
  timestamp: string;
  backup_type: 'unified';
  traditional_data: {
    reviews: unknown[];
    settings: {
      system_settings: Record<string, string>;
      api_configurations: unknown[];
      model_assignments: unknown | null;
    };
  };
  metadata: { export_options: unknown };
}

const database = (message: string) => new CommandError({ error_type: 'Database', message, details: null });

function option(options: unknown, key: string): boolean {
  if (options === null || typeof options !== 'object') return false;
  return (options as Record<string, unknown>)[key] === true;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function exportUnifiedBackupData(options: unknown, deps: BackupExportDeps): Promise<UnifiedBackupData> {
  const includeSettings = option(options, 'include_settings');

  const systemSettings: Record<string, string> = {};
  let apiConfigurations: unknown[] = [];
  let modelAssignments: unknown | null = null;

  if (includeSettings) {
    let rows: readonly { key: string; value: string }[];
    try {
      rows = deps.settings.listByPrefix('');
    } catch (error) {
      throw database(`读取设置失败: ${message(error)}`);
    }
    for (const row of rows) systemSettings[row.key] = row.value;

    if (deps.llm === null) {
      throw database('导出API配置失败: LLM manager service is not available');
    }
    try {
      apiConfigurations = await deps.llm.getApiConfigs();
    } catch (error) {
      throw database(`导出API配置失败: ${message(error)}`);
    }
    try {
      modelAssignments = await deps.llm.getModelAssignments();
    } catch (error) {
      throw database(`导出模型分配失败: ${message(error)}`);
    }
  }

  return {
    version: '3.0',
    timestamp: deps.now(),
    backup_type: 'unified',
    traditional_data: {
      reviews: [],
      settings: {
        system_settings: systemSettings,
        api_configurations: apiConfigurations,
        model_assignments: modelAssignments,
      },
    },
    metadata: { export_options: options },
  };
}
