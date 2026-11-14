/** startup_cleanup.rs: marker, active-slot purge, other-slot/trash cleanup. */
import fs from 'node:fs';
import path from 'node:path';
import { AppError, CommandError } from '../errors/api.ts';
import { errorText, isDirectory, removePath } from './data-space-files.ts';
export interface PurgeReport { details: string; had_errors: boolean }
export const PURGE_MARKER_FILE = '.purge_on_next_start';
export function shouldPurgeOnStart(base: string): boolean { return fs.existsSync(path.join(base, PURGE_MARKER_FILE)); }
export function writePurgeMarker(base: string): void {
  try { fs.mkdirSync(base, { recursive: true }); } catch (error) { throw new CommandError(AppError.file_system(`创建标记父目录失败: ${errorText(error)}`)); }
  try { fs.writeFileSync(path.join(base, PURGE_MARKER_FILE), '1'); } catch (error) { throw new CommandError(AppError.file_system(`写入清理标记失败: ${errorText(error)}`)); }
}
export function clearPurgeMarker(base: string): void {
  const file = path.join(base, PURGE_MARKER_FILE);
  if (fs.existsSync(file)) { try { fs.unlinkSync(file); } catch (error) { throw new CommandError(AppError.file_system(`删除清理标记失败: ${errorText(error)}`)); } }
}
export function purgeActiveDataDir(active: string): PurgeReport {
  const deleted: string[] = [], errors: string[] = []; let names: string[];
  try { names = fs.readdirSync(active); } catch (error) { throw new CommandError(AppError.file_system(`读取活动数据目录失败: ${active} - ${errorText(error)}`)); }
  for (const name of names) {
    if (['backups', 'temp_restore', 'migration_core_backups'].includes(name)) continue;
    const file = path.join(active, name), kind = isDirectory(file) ? '目录' : '文件';
    try { removePath(file); deleted.push(`${kind}: ${file}`); } catch (error) { errors.push(`删除${kind}失败: ${file} - ${errorText(error)}`); }
  }
  let details = '';
  if (!deleted.length && !errors.length) details = '没有找到需要删除的文件\n';
  if (deleted.length) details += `✅ 删除 ${deleted.length} 项:\n${deleted.map(x => `  - ${x}\n`).join('')}`;
  if (errors.length) details += `❌ ${errors.length} 项删除失败:\n${errors.map(x => `  - ${x}\n`).join('')}`;
  return { details, had_errors: errors.length > 0 };
}
function canonicalOrOriginal(file: string): string { try { return fs.realpathSync(file); } catch { return file; } }
export async function purgeAllLocalData(base: string, active: string, resetSyncBaseline?: () => void | Promise<void>): Promise<PurgeReport> {
  const report = purgeActiveDataDir(active), slots = path.join(base, 'slots'), canonical = canonicalOrOriginal(active);
  const deleted: string[] = [], errors: string[] = [];
  for (const name of ['slotA', 'slotB', 'slotC', 'slotD']) {
    const slot = path.join(slots, name); if (canonicalOrOriginal(slot) === canonical) continue;
    if (fs.existsSync(slot)) {
      try { fs.rmSync(slot, { recursive: true }); } catch (error) { errors.push(`删除非活跃/测试槽失败: ${slot} - ${errorText(error)}`); continue; }
      deleted.push(`数据槽: ${slot}`);
    }
    try { fs.mkdirSync(slot, { recursive: true }); } catch (error) { errors.push(`重建数据槽失败: ${slot} - ${errorText(error)}`); }
  }
  if (fs.existsSync(slots)) {
    let names: string[] = [];
    try { names = fs.readdirSync(slots); } catch (error) { errors.push(`读取数据槽目录失败: ${slots} - ${errorText(error)}`); }
    for (const name of names) {
      if (!name.startsWith('slotA.trash-') && !name.startsWith('slotB.trash-')) continue;
      const file = path.join(slots, name);
      try { removePath(file); deleted.push(`恢复残留: ${file}`); } catch (error) { errors.push(`删除恢复残留失败: ${file} - ${errorText(error)}`); }
    }
  }
  if (resetSyncBaseline) { try { await resetSyncBaseline(); } catch (error) { errors.push(`重置同步消费基线失败: ${errorText(error)}`); } }
  if (deleted.length) report.details += `✅ 额外清理 ${deleted.length} 项:\n${deleted.map(x => `  - ${x}\n`).join('')}`;
  if (errors.length) { report.details += `❌ 额外清理 ${errors.length} 项失败:\n${errors.map(x => `  - ${x}\n`).join('')}`; report.had_errors = true; }
  return report;
}
