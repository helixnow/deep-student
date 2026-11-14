import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * TS 对应 Rust 源码锁里的 `collect_files_mentioning` / `collect_outside_sync_crate`：
 * 扫描 Host 后端生产源码（`host/`、`electron/`，排除测试与文档），按仓库相对路径返回
 * 含指定字面量的文件。Rust 用 `mod.rs` 的 `pub mod` 声明作为唯一允许的引用点；
 * TS 的对应位置是 `sync-providers/api.ts` 的 re-export 语句。
 */
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SCAN_ROOTS = ['host', 'electron'];

function productionFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'tests' || name.startsWith('.')) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|mts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(path);
    }
  };
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root));
  return out;
}

let cache: Array<{ rel: string; text: string }> | undefined;
function sources(): Array<{ rel: string; text: string }> {
  cache ??= productionFiles().map(path => ({
    rel: relative(REPO_ROOT, path).split(sep).join('/'),
    text: readFileSync(path, 'utf8'),
  }));
  return cache;
}

export function productionFileCount(): number {
  return sources().length;
}

export function filesMentioning(...needles: string[]): string[] {
  return sources().filter(({ text }) => needles.some(needle => text.includes(needle))).map(({ rel }) => rel).sort();
}

export function readSource(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

/** `api.ts` with every `export … from '…';` statement removed: what is left would be real wiring. */
export function apiWithoutReexports(): string {
  return readSource('host/plugins/sync-providers/api.ts')
    .replace(/export\s+(type\s+)?\{[^}]*\}\s*from\s*'[^']*';/g, '')
    .replace(/export\s+\*\s+(as\s+\w+\s+)?from\s*'[^']*';/g, '');
}

export const SP = 'host/plugins/sync-providers';
export const SYNC_MANAGER = `${SP}/src/sync_manager.ts`;
/** Rust `format!("{}/{}.zip", BACKUPS_DIR, version_id)` + `.put_file(&remote_key, zip_path, progress)`. */
export const WHOLE_ZIP_KEY = '`${BACKUPS_DIR}/${versionId}.zip`';
export const WHOLE_ZIP_PUT = 'this.storage.putFile(remoteKey, zipPath, progress)';
