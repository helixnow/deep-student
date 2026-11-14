import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import type { Context } from '../../kernel/api.ts';
import type { DiagnosticsExportOptions, DiagnosticsExportResult } from '../../../contracts/ipc/generated/F4-security.ts';
import { chronoRfc3339 } from '../time/index.ts';
import { ioMessage } from '../paths/compat.ts';
import { Worker } from 'node:worker_threads';
import type { DiagnosticsZipInput } from './diagnostics-sanitize.ts';

/** 一次性 worker：脱敏 + 压缩不占 Host 事件循环；worker 异常退出也必须 settle。 */
function buildZipInWorker(input: DiagnosticsZipInput): Promise<Buffer> {
  const worker = new Worker(new URL('./diagnostics-worker.ts', import.meta.url), { workerData: input });
  let result: Uint8Array | undefined, failure: Error | undefined;
  return new Promise((resolve, reject) => {
    worker.once('message', (message: { zip?: Uint8Array; error?: string }) => {
      result = message.zip;
      if (message.error !== undefined) failure = new Error(message.error);
    });
    worker.once('error', error => { failure = error; });
    worker.once('exit', code => {
      if (failure !== undefined) reject(failure);
      else if (code !== 0 || result === undefined) reject(new Error(`完成诊断包失败: diagnostics worker exited with code ${code}`));
      else resolve(Buffer.from(result.buffer, result.byteOffset, result.byteLength));
    });
  });
}

async function attempt<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) { throw new Error(`${operation}: ${ioMessage(error)}`); }
}
async function* walk(root: string): AsyncGenerator<string> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}
export async function exportDiagnosticsBundle(ctx: Context, options: DiagnosticsExportOptions): Promise<DiagnosticsExportResult> {
  const log = ctx.log;
  await log.structured.flush();
  if (!await log.debugLogs.flushPending()) throw new Error('等待详细请求日志写入超时，请稍后重试');
  const destination = options.destination;
  if (!isAbsolute(destination)) throw new Error('诊断包保存路径必须是绝对路径');
  const existing = await stat(destination).catch(() => null);
  if (existing?.isDirectory()) throw new Error('诊断包保存路径不能是目录');
  const parent = dirname(destination);
  await attempt('创建保存目录失败', () => mkdir(parent, { recursive: true }));
  const temporary = join(parent, `.deep-student-diagnostics-${randomUUID()}.tmp`);
  const file = await attempt('创建诊断包失败', () => open(temporary, 'w'));
  let published = false;
  try {
    if (process.platform !== 'win32') await attempt('设置诊断包权限失败', () => chmod(temporary, 0o600));
    const files: { name: string; text: string }[] = [];
    const sources: [string, string][] = [['current', log.logDir]];
    const base = ctx.app.dataDir;
    for (const [label, dir] of [['app-data', base], ['slotA', join(base, 'slots/slotA')], ['slotB', join(base, 'slots/slotB')]]) {
      for (const subdir of ['logs', 'debug-logs']) {
        if (subdir === 'debug-logs' && !options.includeDebugLogs) continue;
        const path = join(dir!, subdir);
        if (await stat(path).catch(() => null)) sources.push([`legacy/${label}-${subdir}`, path]);
      }
    }
    const roots = new Set<string>(), skipped: string[] = [];
    let total = 0, fileCount = 0;
    for (const [label, source] of sources) {
      const root = await realpath(source).catch(() => source);
      if (roots.has(root)) continue;
      roots.add(root);
      for await (const path of walk(root)) {
        if (path === destination || path === temporary) continue;
        if (!options.includeDebugLogs && path.split(sep).includes('debug-logs')) continue;
        const name = `${label}/${relative(root, path).split(sep).filter(part => part !== '.' && part !== '..' && part !== '').join('/')}`;
        const size = (await stat(path).catch(() => null))?.size ?? 0;
        if (size > 20 * 1024 * 1024) { skipped.push(`${name}: file exceeds 20 MB`); continue; }
        if (total + size > 100 * 1024 * 1024) { skipped.push(`${name}: bundle exceeds 100 MB`); continue; }
        let bytes: Buffer;
        try { bytes = await readFile(path); } catch (error) { skipped.push(`${name}: ${ioMessage(error)}`); continue; }
        files.push({ name, text: bytes.toString('utf8') });
        total += size; fileCount++;
      }
    }
    const manifest = { generated_at: chronoRfc3339(), app_version: ctx.app.version, build_number: process.env.BUILD_NUMBER ?? 'unknown', git_hash: process.env.GIT_HASH ?? 'unknown',
      os: ctx.app.platform === 'darwin' ? 'macos' : ctx.app.platform === 'win32' ? 'windows' : 'linux', arch: process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch,
      include_debug_logs: options.includeDebugLogs ?? false, file_count: fileCount, skipped,
      notes: ['Absolute user paths and common credential formats were redacted.', 'Legacy LLM request payloads were removed from runtime logs.', 'Common user-content fields are summarized unless detailed request logs were explicitly included.', 'The bundle intentionally contains no databases or user documents.'] };
    let manifestJson: string;
    try { manifestJson = JSON.stringify(manifest, null, 2); }
    catch (error) { throw new Error(`生成清单失败: ${ioMessage(error)}`); }
    const bytes = await buildZipInWorker({ files, manifestJson, detailed: options.includeDebugLogs ?? false });
    await attempt('写入诊断包失败', () => file.writeFile(bytes));
    await attempt('同步诊断包失败', () => file.sync());
    await file.close();
    const backup = destination.slice(0, destination.length - extname(destination).length) + `.diagnostics-backup-${randomUUID()}`;
    const replacing = await stat(destination).catch(() => null);
    if (replacing) await attempt('无法替换已有诊断包', () => rename(destination, backup));
    try { await rename(temporary, destination); }
    catch (error) {
      if (replacing) {
        try { await rename(backup, destination); }
        catch (restore) { throw new Error(`保存诊断包失败: ${ioMessage(error)}；原文件恢复失败（备份保留在 ${backup}）: ${ioMessage(restore)}`); }
      }
      throw new Error(`保存诊断包失败: ${ioMessage(error)}`);
    }
    published = true;
    if (replacing) await unlink(backup).catch(error => log.logger('diagnostics').debug(ioMessage(error)));
    return { path: destination, fileCount, skippedCount: skipped.length, sizeBytes: (await stat(destination).catch(() => null))?.size ?? 0 };
  } finally {
    await file.close();
    if (!published) await unlink(temporary).catch(error => log.logger('diagnostics').debug(ioMessage(error)));
  }
}
