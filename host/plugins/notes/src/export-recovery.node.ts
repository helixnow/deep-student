import { lstat, mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactRoot } from '../../agent-workspace/api.ts';
import type { ExecutionContext } from '../../../kernel/agent-api.ts';
import type { LogService } from '../../../platform/log/api.ts';
import { exportAll, NOTES_EXPORT_STAGING_FALLBACK, type TransferContext } from './transfer-commands.ts';

export async function recoverNotesExport(ctx: TransferContext, log: LogService, args: Record<string, unknown>, agent: ExecutionContext) {
  const id = args.diagnosticId;
  if (typeof id !== 'string' || !/^invoke-\d+-[0-9a-f-]{36}$/.test(id)) throw new Error('需要有效的笔记导出诊断编号');
  const { records } = await log.queryErrors({ id, operation: 'notes_export' });
  if (!records.some(r => r.source === 'host' && r.pluginId === 'dstu.notes' && r.code === 'NOTES_EXPORT_STAGE_UNAVAILABLE')) {
    throw new Error('这次导出未确认是临时目录故障，未执行恢复');
  }
  // Existing files, directories and links belong to the user/application. Leave them intact.
  const root = artifactRoot(ctx.appDataDir, agent.ids.sessionId, true);
  const folder = await mkdtemp(join(root.path, 'notes-export-'));
  const name = 'notes.zip';
  const output = await exportAll({ ...ctx, stagingDir: folder }, { output_path: join(folder, name) });
  const file = await lstat(output.output_path);
  if (!file.isFile() || file.size === 0) throw new Error('导出未生成可用文件');
  // Future regular exports use an application-managed staging directory as well.
  // Never rename or overwrite the obstruction and never reuse the prior user destination automatically.
  const fallback = join(ctx.appDataDir, 'notes-export-staging');
  await mkdir(fallback, { recursive: true, mode: 0o700 });
  if (!(await lstat(fallback)).isDirectory()) throw new Error('新的笔记导出暂存位置不可用');
  ctx.settings.save(NOTES_EXPORT_STAGING_FALLBACK, 'true');
  return { diagnosticId: id, recovered: true, verified: true, restartRequired: false,
    recovery: 'bypassed_unavailable_staging',
    artifact: { root_id: 'artifacts', path: folder.slice(root.path.length + 1) + '/' + name, bytes: file.size },
    noteCount: output.note_count, attachmentCount: output.attachment_count, scope: 'saved_notes' };
}
