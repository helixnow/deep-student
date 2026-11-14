/**
 * Startup-recovery export staging (data_space.rs:2320-2467).
 *
 * Staging lives beside `incidents/`, never inside an incident, so an exported
 * ZIP cannot include its own temporary copy.  Crashed leftovers older than six
 * hours are purged before the next export.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ZipFileWriter } from '../zip/index.ts';
import type { StartupRecoveryIncident, StartupRecoveryStatus } from '../../../contracts/ipc/generated/F3-storage.ts';
import { errorText, renameSyncWithRetry, utcNow } from './data-space-files.ts';
import { storageLog } from './logging.ts';

const LOG_TARGET = 'dstu_storage::data_space';

export const RECOVERY_DIR = 'recovery';
export const STARTUP_RECOVERY_EXPORT_STAGING_DIR = 'export-staging';
export const STARTUP_RECOVERY_EXPORT_STAGING_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function withExtension(file: string, extension: string): string {
  const parsed = path.parse(file);
  return path.join(parsed.dir, `${parsed.name}.${extension}`);
}

/** data_space.rs:2338. */
export function purgeStaleRecoveryExportStaging(directory: string, maxAgeMs: number): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch { return; }
  const now = Date.now();
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    let metadata: fs.Stats;
    try { metadata = fs.statSync(file); }
    catch { continue; }
    if (!metadata.isFile()) continue;
    if (now - metadata.mtimeMs >= maxAgeMs) {
      try { fs.unlinkSync(file); }
      catch (error) { storageLog(LOG_TARGET, 'warn', `[DataSpace] 清理遗留恢复导出临时文件失败 ${file}: ${errorText(error)}`); }
    }
  }
}

/** data_space.rs:2326. */
export function startupRecoveryExportStagingPath(baseDir: string, extension: string): string {
  const directory = path.join(baseDir, RECOVERY_DIR, STARTUP_RECOVERY_EXPORT_STAGING_DIR);
  fs.mkdirSync(directory, { recursive: true });
  purgeStaleRecoveryExportStaging(directory, STARTUP_RECOVERY_EXPORT_STAGING_MAX_AGE_MS);
  return path.join(directory, `${randomUUID()}.${extension}`);
}

/** data_space.rs:2378. */
export function removeStagedRecoveryExport(staged: string): void {
  const extension = path.extname(staged).replace(/^\./, '');
  for (const file of [staged, withExtension(staged, `${extension}.partial`)]) {
    if (!fs.existsSync(file)) continue;
    try { fs.unlinkSync(file); }
    catch (error) { storageLog(LOG_TARGET, 'warn', `[DataSpace] 清理恢复导出临时文件失败 ${file}: ${errorText(error)}`); }
  }
}

/** `WalkDir::new(source).follow_links(false)`：先序遍历，目录条目先于其内容。 */
async function addDirectoryToZip(writer: ZipFileWriter, source: string, relative: string): Promise<void> {
  const entries = await fs.promises.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const file = path.join(source, entry.name);
    const name = (relative ? `${relative}/${entry.name}` : entry.name).replaceAll('\\', '/');
    const stats = await fs.promises.lstat(file);
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      await writer.addDirectory(`${name}/`);
      await addDirectoryToZip(writer, file, name);
    } else if (stats.isFile()) {
      await writer.addFile(name, file);
    }
  }
}

/** data_space.rs:2269 `export_startup_recovery_report`：诊断报告载荷（字段顺序即 Rust json! 顺序）。 */
export interface StartupRecoveryComponentIssue {
  component: string;
  status: string;
  reason: string | null;
  dependency: string | null;
}

export interface StartupRecoveryComponentHealthLike {
  components: readonly {
    component: string;
    status: string;
    reason?: string | null;
    dependency?: string | null;
  }[];
}

export interface StartupRecoveryReport {
  format_version: number;
  generated_at: string;
  startup_recovery: StartupRecoveryStatus;
  incidents: StartupRecoveryIncident[];
  component_health: { components: StartupRecoveryComponentIssue[] } | null;
}

export function buildStartupRecoveryReport(
  status: StartupRecoveryStatus,
  incidents: readonly StartupRecoveryIncident[],
  componentHealth: StartupRecoveryComponentHealthLike | null,
): StartupRecoveryReport {
  return {
    format_version: 1,
    generated_at: utcNow(),
    startup_recovery: status,
    incidents: [...incidents],
    component_health: componentHealth === null
      ? null
      : {
        components: componentHealth.components.map((entry) => ({
          component: entry.component,
          status: entry.status,
          reason: entry.reason ?? null,
          dependency: entry.dependency ?? null,
        })),
      },
  };
}

/** data_space.rs:2401 `export_incident_zip`。 */
export async function exportIncidentZip(source: string, destination: string): Promise<void> {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const partial = withExtension(destination, 'zip.partial');
  const backup = withExtension(destination, 'zip.previous');
  if (fs.existsSync(partial)) fs.unlinkSync(partial);

  // `File::create(&partial)` + `ZipWriter`（Deflated）+ `finish()` + `sync_all()`。
  const writer = await ZipFileWriter.create(partial, { flags: 'w' });
  try {
    await addDirectoryToZip(writer, source, '');
    await writer.finish({ sync: true });
  } catch (error) {
    await writer.abort();
    try { if (fs.existsSync(partial)) fs.unlinkSync(partial); }
    catch (cleanupError) { storageLog(LOG_TARGET, 'warn', `[DataSpace] 清理失败的恢复导出临时文件 ${partial}: ${errorText(cleanupError)}`); }
    throw error;
  }

  if (fs.existsSync(backup)) fs.unlinkSync(backup);
  if (fs.existsSync(destination)) renameSyncWithRetry(destination, backup);
  try { renameSyncWithRetry(partial, destination); }
  catch (error) {
    if (fs.existsSync(backup)) renameSyncWithRetry(backup, destination);
    throw error;
  }
  if (fs.existsSync(backup)) fs.unlinkSync(backup);
}
