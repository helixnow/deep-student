import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, realpathSync, statSync, readdirSync, rmSync } from 'node:fs';
import { basename, join, relative, isAbsolute } from 'node:path';
import { CommandError } from '../host/kernel/api.ts';
import { rustTrim } from '../host/platform/util/index.ts';
import { formatIoError } from './shell/errors.ts';

const error = (error_type: string, message: string) => new CommandError({ error_type, message, details: null });
const io = (e: unknown) => formatIoError(e, process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux');
const within = (path: string, root: string) => { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..' + '/') && !rel.startsWith('..' + '\\') && rel !== '..' && !isAbsolute(rel)); };

export function parseExternalOpenMode(raw: string | null): 'view' | 'share' {
  const mode = raw === null ? 'view' : rustTrim(raw);
  if (mode === '' || mode === 'view') return 'view';
  if (mode === 'share') return 'share';
  throw error('Validation', `不支持的打开方式: ${mode}`);
}
export const isContentUri = (path: string): boolean => path.trimStart().slice(0, 10).toLowerCase() === 'content://';

export function resolveShareableSource(source: string, roots: string[]): string {
  let canonical: string;
  try { canonical = realpathSync(source); } catch (e) { throw error('NotFound', `文件不存在或无法访问: ${io(e)}`); }
  if (!statSync(canonical).isFile()) throw error('Validation', '只能打开文件，不能打开目录');
  if (!roots.some((root) => { try { return within(canonical, realpathSync(root)); } catch { return false; } })) {
    throw error('Validation', '只能打开应用数据目录内的文件');
  }
  return canonical;
}

export function purgeExpiredSharedCopies(root: string, ttl: number, warn: (message: string) => void): void {
  let entries: string[];
  try { entries = readdirSync(root); } catch (error) {
    // Rust `let Ok(entries) = read_dir(...) else { return; }`：读取失败即放弃本次清理。
    warn(`[external-file] read shared cache: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const now = performance.timeOrigin + performance.now();
  for (const entry of entries) {
    const path = join(root, entry);
    try { if (now - statSync(path).mtimeMs >= ttl) rmSync(path, { recursive: true }); }
    catch (error) {
      // Rust 忽略 metadata/removal 失败；仅记录，不影响其余条目。
      warn(`[external-file] purge ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function stageForSharing(cache: string, source: string, warn: (message: string) => void): string {
  let root = join(cache, 'shared');
  try { mkdirSync(root, { recursive: true }); } catch (e) { throw error('FileSystem', `创建分享缓存目录失败: ${io(e)}`); }
  try { root = realpathSync(root); } catch (e) { throw error('FileSystem', `分享缓存目录不可用: ${io(e)}`); }
  if (within(source, root)) return source;
  purgeExpiredSharedCopies(root, 86_400_000, warn);
  let name = basename(source).replace(/[:?*"<>|\x00-\x1f\x7f-\x9f/\\]/g, '_');
  if (!name.trim() || name === '.' || name === '..') name = 'file';
  const dir = join(root, randomUUID().replaceAll('-', ''));
  try { mkdirSync(dir, { recursive: true }); } catch (e) { throw error('FileSystem', `创建分享副本目录失败: ${io(e)}`); }
  const target = join(dir, name);
  try { copyFileSync(source, target); } catch (e) {
    try { rmSync(dir, { recursive: true }); } catch (cleanup) { warn(`[external-file] cleanup: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`); }
    throw error('FileSystem', `复制分享副本失败: ${io(e)}`);
  }
  return target;
}
