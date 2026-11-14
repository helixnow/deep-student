/**
 * refinery 迁移 runner 的桌面适配层：从磁盘目录发现并读取迁移 SQL（`embed_migrations!` 的
 * 文件发现部分），其余全部来自可移植核心 `refinery-core.ts`（本文件原样 re-export，既有导入路径不变）。
 * 需要在移动端 / Worker 中求值的模块应直接导入 `refinery-core.ts`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { migrationsFromSqlFiles, type Migration } from './refinery-core.ts';

export * from './refinery-core.ts';

const SQL_CACHE_MAX_FILES = 1024;
/**
 * 时间戳实际按粒度跳变，比字段精度粗：FAT 的 mtime 2 s，HFS+ 和 128 字节 inode 的 ext 1 s，
 * Linux 6.13 之前取粗粒度时钟、按 tick 走（HZ=100 时 10 ms），Windows 按系统计时器（约 15.6 ms）。
 * 粒度内同大小原地改写，stat 签名一字不差。窗口取最粗的 2 s，再留 1 s 给 `Date.now()` 与文件系统时钟
 * （粗粒度时钟滞后、网络盘服务端时钟）之间的偏差。
 */
const SQL_CACHE_RACY_WINDOW_NS = 3_000_000_000n;
const sqlCache = new Map<string, { readonly signature: string; readonly sql: string }>();

/**
 * 读迁移文件原文，按绝对路径缓存。每次都 `stat`，设备、inode、大小、mtime、ctime 任一变化即重读。
 * 签名只有在 mtime 和 ctime 都早于 `stat` 前的时刻一个窗口以上时才可信（git 的 racy-git 判定）：
 * 之后的任何改写都会落到更晚的时间戳上，签名必变；`stat` 与读取之间的改写同理。窗口内读到的文本不缓存，
 * 下次照常重读，直到文件静置超过窗口。打包资源和久未改动的文件不受影响。
 */
export function readMigrationSql(file: string): string {
  const full = path.resolve(file);
  const statedAtNs = BigInt(Date.now()) * 1_000_000n;
  const st = fs.statSync(full, { bigint: true });
  const signature = `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
  const cached = sqlCache.get(full);
  if (cached !== undefined && cached.signature === signature) return cached.sql;
  const sql = fs.readFileSync(full, 'utf8');
  sqlCache.delete(full);
  const changedNs = st.mtimeNs > st.ctimeNs ? st.mtimeNs : st.ctimeNs;
  if (statedAtNs - changedNs <= SQL_CACHE_RACY_WINDOW_NS) return sql;
  if (sqlCache.size >= SQL_CACHE_MAX_FILES) sqlCache.delete(sqlCache.keys().next().value!);
  sqlCache.set(full, { signature, sql });
  return sql;
}

/** `embed_migrations!` 的文件发现：递归目录，文件名匹配 `STEM_RE + \.sql$`，按版本排序。 */
export function loadSqlMigrations(dir: string): Migration[] {
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(dir);
  return migrationsFromSqlFiles(files.map((file) => ({ name: path.basename(file), get sql() { return readMigrationSql(file); } })));
}
