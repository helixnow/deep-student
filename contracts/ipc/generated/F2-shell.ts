// 自动生成，勿手改：npm run contracts:generate
// 生成器：deep-student/node-contracts@1.0.0；来源：contracts/ipc/F2-shell.json
/* eslint-disable */
import type * as Shared from './_shared.ts';

/** deep_student_lib::commands::PdfStreamAccess */
export type PdfStreamAccess = {
  available: boolean;
  size: number | null;
  reason: string | null;
};
/** deep_student_lib::system_permissions::SystemPermissionSettingsTarget */
export type SystemPermissionSettingsTarget = ("notifications" | "microphone") | {
  notifications: null;
} | {
  microphone: null;
};

/* ---------- 历史导出名（兼容既有 import，勿删） ---------- */
/** 兼容导出：_shared.PersistedJob（保留旧名） */
export type { PersistedJob } from './_shared.ts';

export interface Commands {
  /** src/commands.rs:4264 `copy_file` */
  copy_file: {
    args: {
      sourcePath: string;
      destPath: string;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/commands.rs:6552 `export_unified_backup_data` */
  export_unified_backup_data: {
    args: {
      options: unknown;
    };
    result: unknown;
    error: Shared.AppError;
  };
  /** src/commands.rs:562 `get_app_data_dir` */
  get_app_data_dir: {
    args: Record<string, never>;
    result: string;
    error: Shared.AppError;
  };
  /** src/commands.rs:499 `get_app_version` */
  get_app_version: {
    args: Record<string, never>;
    result: string;
    error: never;
  };
  /** src/commands.rs:4193 `get_file_size` */
  get_file_size: {
    args: {
      path: string;
    };
    result: number;
    error: Shared.AppError;
  };
  /** src/cmd/power.rs:77 `get_prevent_sleep` */
  get_prevent_sleep: {
    args: Record<string, never>;
    result: boolean;
    error: string;
  };
  /** src/commands.rs:4259 `hash_file` */
  hash_file: {
    args: {
      path: string;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/commands.rs:532 `install_apk` */
  install_apk: {
    args: {
      path: string;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/commands.rs:7508 `load_webview_settings` */
  load_webview_settings: {
    args: Record<string, never>;
    result: unknown;
    error: Shared.AppError;
  };
  /** src/external_file_opener.rs:176 `open_file_externally` */
  open_file_externally: {
    args: {
      path: string;
      mode?: string | null;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/system_permissions.rs:129 `open_system_permission_settings` */
  open_system_permission_settings: {
    args: {
      permission: SystemPermissionSettingsTarget;
    };
    result: null;
    error: string;
  };
  /** src/commands.rs:4212 `pdfstream_check_access` */
  pdfstream_check_access: {
    args: {
      path: string;
    };
    result: PdfStreamAccess;
    error: Shared.AppError;
  };
  /** src/commands.rs:4171 `read_file_bytes` */
  read_file_bytes: {
    args: {
      path: string;
      maxBytes?: number | null;
    };
    result: unknown;
    error: Shared.AppError;
  };
  /** src/commands.rs:4149 `read_file_text` */
  read_file_text: {
    args: {
      path: string;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/commands.rs:4271 `save_text_to_file` */
  save_text_to_file: {
    args: {
      path: string;
      content: string;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/commands.rs:7475 `save_webview_settings` */
  save_webview_settings: {
    args: {
      settings: unknown;
    };
    result: unknown;
    error: Shared.AppError;
  };
  /** src/system_bars.rs:43 `set_android_immersive_mode` */
  set_android_immersive_mode: {
    args: {
      enabled: boolean;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/lib.rs:330 `set_backend_sentry_enabled` */
  set_backend_sentry_enabled: {
    args: {
      enabled: boolean;
    };
    result: boolean;
    error: string;
  };
  /** src/cmd/power.rs:26 `set_prevent_sleep` */
  set_prevent_sleep: {
    args: {
      enabled: boolean;
    };
    result: boolean;
    error: string;
  };
  /** src/cmd/window_effects.rs:171 `set_sidebar_vibrancy` */
  set_sidebar_vibrancy: {
    args: {
      enabled: boolean;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/cmd/window_effects.rs:214 `set_window_appearance` */
  set_window_appearance: {
    args: {
      dark: boolean;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/cmd/window_effects.rs:270 `sync_titlebar_sidebar_material` */
  sync_titlebar_sidebar_material: {
    args: {
      enabled: boolean;
      width: number;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/commands.rs:515 `updater_install_supported` */
  updater_install_supported: {
    args: Record<string, never>;
    result: boolean;
    error: never;
  };
}

export interface Events {
  "backup-jobs-resumable": Shared.PersistedJob[];
  "data-governance-migration-status": {
    success: boolean;
    error: string;
    degraded_mode: boolean;
    maintenance_mode_forced: boolean;
    restore_activation_failed: boolean;
  } | {
    success: boolean;
    error: string;
    degraded_mode: boolean;
    maintenance_mode_forced: boolean;
  } | {
    success: boolean;
    global_version: number;
    migrations_applied: number;
    duration_ms: number;
    warnings: string[];
    has_warnings: boolean;
  } | {
    success: boolean;
    global_version: number;
    migrations_applied: number;
    duration_ms: number;
    warnings: string[];
  } | {
    success: boolean;
    recovered: boolean;
    error: string;
    maintenance_mode_forced: boolean;
    message: string;
  };
  "mcp_tools_changed": {
    ts: string;
  };
  "menu://close-window": null;
  "menu://command-palette": null;
  "menu://documentation": null;
  "menu://new-session": null;
  "menu://preferences": null;
  "menu://report-issue": null;
  "menu://toggle-sidebar": null;
}

export type CommandName = keyof Commands;
export type CopyFileCommandArgs = Commands['copy_file']['args'];
export type CopyFileCommandResult = Commands['copy_file']['result'];
export type ExportUnifiedBackupDataCommandArgs = Commands['export_unified_backup_data']['args'];
export type ExportUnifiedBackupDataCommandResult = Commands['export_unified_backup_data']['result'];
export type GetAppDataDirCommandArgs = Commands['get_app_data_dir']['args'];
export type GetAppDataDirCommandResult = Commands['get_app_data_dir']['result'];
export type GetAppVersionCommandArgs = Commands['get_app_version']['args'];
export type GetAppVersionCommandResult = Commands['get_app_version']['result'];
export type GetFileSizeCommandArgs = Commands['get_file_size']['args'];
export type GetFileSizeCommandResult = Commands['get_file_size']['result'];
export type GetPreventSleepCommandArgs = Commands['get_prevent_sleep']['args'];
export type GetPreventSleepCommandResult = Commands['get_prevent_sleep']['result'];
export type HashFileCommandArgs = Commands['hash_file']['args'];
export type HashFileCommandResult = Commands['hash_file']['result'];
export type InstallApkCommandArgs = Commands['install_apk']['args'];
export type InstallApkCommandResult = Commands['install_apk']['result'];
export type LoadWebviewSettingsCommandArgs = Commands['load_webview_settings']['args'];
export type LoadWebviewSettingsCommandResult = Commands['load_webview_settings']['result'];
export type OpenFileExternallyCommandArgs = Commands['open_file_externally']['args'];
export type OpenFileExternallyCommandResult = Commands['open_file_externally']['result'];
export type OpenSystemPermissionSettingsCommandArgs = Commands['open_system_permission_settings']['args'];
export type OpenSystemPermissionSettingsCommandResult = Commands['open_system_permission_settings']['result'];
export type PdfstreamCheckAccessCommandArgs = Commands['pdfstream_check_access']['args'];
export type PdfstreamCheckAccessCommandResult = Commands['pdfstream_check_access']['result'];
export type ReadFileBytesCommandArgs = Commands['read_file_bytes']['args'];
export type ReadFileBytesCommandResult = Commands['read_file_bytes']['result'];
export type ReadFileTextCommandArgs = Commands['read_file_text']['args'];
export type ReadFileTextCommandResult = Commands['read_file_text']['result'];
export type SaveTextToFileCommandArgs = Commands['save_text_to_file']['args'];
export type SaveTextToFileCommandResult = Commands['save_text_to_file']['result'];
export type SaveWebviewSettingsCommandArgs = Commands['save_webview_settings']['args'];
export type SaveWebviewSettingsCommandResult = Commands['save_webview_settings']['result'];
export type SetAndroidImmersiveModeCommandArgs = Commands['set_android_immersive_mode']['args'];
export type SetAndroidImmersiveModeCommandResult = Commands['set_android_immersive_mode']['result'];
export type SetBackendSentryEnabledCommandArgs = Commands['set_backend_sentry_enabled']['args'];
export type SetBackendSentryEnabledCommandResult = Commands['set_backend_sentry_enabled']['result'];
export type SetPreventSleepCommandArgs = Commands['set_prevent_sleep']['args'];
export type SetPreventSleepCommandResult = Commands['set_prevent_sleep']['result'];
export type SetSidebarVibrancyCommandArgs = Commands['set_sidebar_vibrancy']['args'];
export type SetSidebarVibrancyCommandResult = Commands['set_sidebar_vibrancy']['result'];
export type SetWindowAppearanceCommandArgs = Commands['set_window_appearance']['args'];
export type SetWindowAppearanceCommandResult = Commands['set_window_appearance']['result'];
export type SyncTitlebarSidebarMaterialCommandArgs = Commands['sync_titlebar_sidebar_material']['args'];
export type SyncTitlebarSidebarMaterialCommandResult = Commands['sync_titlebar_sidebar_material']['result'];
export type UpdaterInstallSupportedCommandArgs = Commands['updater_install_supported']['args'];
export type UpdaterInstallSupportedCommandResult = Commands['updater_install_supported']['result'];
