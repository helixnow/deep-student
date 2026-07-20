import { invoke } from '@tauri-apps/api/core';

export interface DiagnosticsExportResult {
  path: string;
  fileCount: number;
  skippedCount: number;
  sizeBytes: number;
}

export async function chooseAndExportDiagnostics(
  includeDebugLogs = false,
): Promise<DiagnosticsExportResult | null> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = await save({
    defaultPath: `Deep-Student-Diagnostics-${timestamp}.zip`,
    filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
  });
  if (!destination) return null;

  return invoke<DiagnosticsExportResult>('export_diagnostics_bundle', {
    options: {
      destination,
      includeDebugLogs,
    },
  });
}

export async function revealDiagnostics(result: DiagnosticsExportResult): Promise<void> {
  const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
  await revealItemInDir(result.path);
}
