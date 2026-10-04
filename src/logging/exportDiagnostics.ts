import { invoke } from '@tauri-apps/api/core';
import { isAndroid, isMobilePlatform } from '@/utils/platform';

export interface DiagnosticsExportResult {
  path: string;
  fileCount: number;
  skippedCount: number;
  sizeBytes: number;
}

/**
 * 诊断包导出是否可用：桌面（保存对话框 + 在文件夹中显示）与 Android
 * （导出到应用缓存 + 系统分享面板）。iOS 暂无分享桥，不提供入口。
 */
export function canExportDiagnostics(): boolean {
  return !isMobilePlatform() || isAndroid();
}

/**
 * Android 没有可直接写入的任意路径（保存对话框返回 content://，而导出命令需要
 * 本地绝对路径），因此导出到 `$APPCACHE/shared/diagnostics-<ts>/`：
 * 该目录正是 `open_file_externally` 的 FileProvider 暴露目录，分享时不再二次复制，
 * 且由后端按 24h 过期统一清理（见 src-tauri/src/external_file_opener.rs）。
 */
async function androidDiagnosticsDestination(fileName: string, timestamp: string): Promise<string> {
  const { appCacheDir, join } = await import('@tauri-apps/api/path');
  return join(await appCacheDir(), 'shared', `diagnostics-${timestamp}`, fileName);
}

export async function chooseAndExportDiagnostics(
  includeDebugLogs = false,
): Promise<DiagnosticsExportResult | null> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `Deep-Student-Diagnostics-${timestamp}.zip`;
  let destination: string | null;
  if (isAndroid()) {
    destination = await androidDiagnosticsDestination(fileName, timestamp);
  } else {
    const { save } = await import('@tauri-apps/plugin-dialog');
    destination = await save({
      defaultPath: fileName,
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    });
  }
  if (!destination) return null;

  return invoke<DiagnosticsExportResult>('export_diagnostics_bundle', {
    options: {
      destination,
      includeDebugLogs,
    },
  });
}

/** 桌面：在文件夹中显示导出的 ZIP；Android：弹系统分享面板发送 ZIP */
export async function revealDiagnostics(result: DiagnosticsExportResult): Promise<void> {
  if (isAndroid()) {
    const { shareFileExternally } = await import('@/utils/systemFileOpener');
    await shareFileExternally(result.path);
    return;
  }
  const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
  await revealItemInDir(result.path);
}
