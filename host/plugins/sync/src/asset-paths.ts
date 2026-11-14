/** Asset scan and materialization paths, mod.rs:12242-12364. */
import { join, relative, sep, parse } from '../../../platform/util/path.ts';
import { decodeUtf8Lossy, encodeUtf8 } from '../../../platform/util/portable.ts';
import { calculateFileHash } from '../../sync-providers/api.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import { ioMessage } from '../../../platform/paths/io-error.ts';
import { decodeUtf8Strict } from '../../../platform/util/index.ts';
import { sanitizeAssetKeySegments, localDuplicateMessage, isSyncedAssetKey, SYNCED_ASSET_DIRS } from './asset-filenames.ts';
import { compareFileText } from './workspace-manifest.ts';
import { SyncError } from './errors.ts';
import { fs, type LocalPath } from './local-runtime.ts';
import { isPortableAssetEnabled, type PortableAssetOptions } from './portable-assets.ts';

/** 按字节拼接路径前缀与目录项名（不经过 UTF-8 解码，保留非 UTF-8 文件名）。 */
function joinRawBytes(dir: Uint8Array, separator: Uint8Array, name: Uint8Array): Uint8Array {
  const out = new Uint8Array(dir.byteLength + separator.byteLength + name.byteLength);
  out.set(dir, 0);
  out.set(separator, dir.byteLength);
  out.set(name, dir.byteLength + separator.byteLength);
  return out;
}

export interface LocalAsset { path: string; sha256: string; size: bigint; updated_at: string }
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const database = (text: string) => new SyncError(`Database error: ${text}`);
async function scanTree(alias: string, top: string, base: string, dir: LocalPath, out: Map<string, LocalAsset>, conflicts: string[]): Promise<void> {
  let names;
  try { names = fs.readdirSyncRaw(dir); }
  catch (error) { throw database(`读取资产目录失败: ${ioMessage(error)}`); }
  for (const bytes of names) {
    const rawPath = joinRawBytes(typeof dir === 'string' ? encodeUtf8(dir) : dir, encodeUtf8(sep), bytes);
    let meta;
    try { meta = fs.statBigSync(rawPath); } catch { continue; }
    if (meta.isDirectory()) { await scanTree(alias, top, base, rawPath, out, conflicts); continue; }
    if (!meta.isFile()) continue;
    let path;
    try { path = decodeUtf8Strict(rawPath); }
    catch { throw database(`资产文件名不是有效 UTF-8，无法无损生成云 key: ${JSON.stringify(decodeUtf8Lossy(rawPath))}`); }
    const rel = relative(base, path);
    if (rel.startsWith(`..${sep}`) || parse(rel).root !== '') throw database(`资产路径越出扫描根目录，已拒绝同步: ${JSON.stringify(path)}`);
    const segments = rel.split(sep);
    if (segments.some(segment => segment === '.' || segment === '..' || segment === '')) throw database(`资产路径包含非普通段，已拒绝同步: ${JSON.stringify(path)}`);
    let key;
    try { key = sanitizeAssetKeySegments(alias, top, segments); }
    catch (error) { throw database(`资产文件名无法安全编码，已拒绝同步: ${message(error)}`); }
    const existing = out.get(key);
    if (existing) {
      if (compareFileText(existing.path, path) <= 0) { conflicts.push(localDuplicateMessage(key, existing.path, path)); continue; }
      conflicts.push(localDuplicateMessage(key, path, existing.path));
    }
    let sha256;
    try { sha256 = await calculateFileHash(path); }
    catch (error) { throw database(`计算资产文件校验和失败 ${JSON.stringify(path)}: ${message(error)}`); }
    let size = 0n, updated_at;
    try { size = fs.statBigSync(path).size; }
    catch { size = 0n; }
    try { updated_at = toRfc3339(fs.statBigSync(path).mtimeNs); } catch { updated_at = toRfc3339(); }
    out.set(key, { path, sha256, size, updated_at });
  }
}
export async function scanAssets(active: string, app: string, options: PortableAssetOptions = {}): Promise<[Map<string, LocalAsset>, string[]]> {
  const files = new Map<string, LocalAsset>(), conflicts: string[] = [];
  for (const [alias, base] of [['active', active], ['app_data', app]] as const) {
    for (const top of SYNCED_ASSET_DIRS.get(alias)!) {
      if (!isPortableAssetEnabled(`${alias}/${top}/_`, options)) continue;
      const path = join(base, top === 'skills' ? '.skills' : top); if (fs.existsSync(path)) await scanTree(alias, top, path, path, files, conflicts);
    }
  }
  const lock = join(app, 'plugins-lock.json');
  if (options.includePlugins !== false && !options.mobile && fs.existsSync(lock)) {
    const stat = fs.statBigSync(lock);
    files.set('app_data/plugins/plugins-lock.json', { path: lock, sha256: await calculateFileHash(lock), size: stat.size, updated_at: toRfc3339(stat.mtimeNs) });
  }
  for (const key of files.keys()) if (!isPortableAssetEnabled(key, options)) files.delete(key);
  return [files, conflicts];
}
function ordinary(value: string): boolean {
  const parts = value.split(sep === '\\' ? /[/\\]/u : '/');
  return parse(value).root === '' && parts[0] !== '.' && parts.some(p => p !== '' && p !== '.') && !parts.includes('..');
}
function symlink(path: string): boolean {
  try { return fs.lstatSync(path).isSymbolicLink(); } catch { return false; }
}
export function assetLocalPath(active: string, app: string, key: string): string | null {
  // RUST-FIX(RF-W32-asset-top-allowlist): Rust asset_local_path_from_key (mod.rs:12315) accepts any top directory, e.g. active/databases/vfs.db.
  if (!isSyncedAssetKey(key)) return null;
  const first = key.indexOf('/'), second = key.indexOf('/', first + 1);
  if (first < 0 || second < 0) return null;
  const root = key.slice(0, first), encodedTop = key.slice(first + 1, second), rel = key.slice(second + 1);
  const top = root === 'app_data' && encodedTop === 'skills' ? '.skills' : encodedTop;
  if (!ordinary(top) || !ordinary(rel)) return null;
  const base = root === 'active' ? active : root === 'app_data' ? app : null;
  if (base === null) return null;
  if (key === 'app_data/plugins/plugins-lock.json') return symlink(base) ? null : join(base, 'plugins-lock.json');
  let parent = join(base, top); if (symlink(parent)) return null;
  const parts = rel.split(sep === '\\' ? /[/\\]/u : '/').filter(p => p !== '' && p !== '.');
  for (const part of parts.slice(0, -1)) { parent = join(parent, part); if (symlink(parent)) return null; }
  return join(base, top, rel);
}
