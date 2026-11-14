/**
 * 校验打包产物中的 `migrations` 与 `resources/app/migrations` 逐字节一致。
 *
 * refinery 的 checksum 直接对 SQL 原文计算，任何换行/编码变化都会让已发布数据库迁移失败。
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

function files(root: string, current = root, out: string[] = []): string[] {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files(root, path, out);
    else if (entry.isFile()) out.push(relative(root, path).split(sep).join('/'));
  }
  return out.sort();
}

const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** 返回问题列表；空数组表示逐字节一致。 */
export function verifyMigrations(source: string, target: string): string[] {
  const problems: string[] = [];
  const expected = files(source);
  const actual = new Set(files(target));
  for (const name of expected) {
    if (!actual.has(name)) {
      problems.push(`missing: ${name}`);
      continue;
    }
    const left = join(source, name);
    const right = join(target, name);
    const leftSize = statSync(left).size;
    const rightSize = statSync(right).size;
    if (leftSize !== rightSize) {
      problems.push(`size mismatch: ${name} (${leftSize} != ${rightSize})`);
      continue;
    }
    if (digest(left) !== digest(right)) problems.push(`content mismatch: ${name}`);
  }
  for (const name of actual) if (!expected.includes(name)) problems.push(`unexpected: ${name}`);
  return problems;
}
