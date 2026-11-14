// 源码快照：读取 HEAD 中已提交的文件，而不是工作区。
// 共享工作区里常有他人未提交的试验改动（foundation.md 共同规则 3）；生成物必须只反映已提交的源码，
// 才能与 CI（干净检出）逐字节一致，`--check` 才有意义。
import { execFileSync } from 'node:child_process';
import { ROOT } from './tree-sitter-rust.mjs';

/** HEAD 中以 prefixes 开头的已跟踪文件（仓库相对路径，排序）。 */
export function trackedFiles(prefixes) {
  const out = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...prefixes], { cwd: ROOT, maxBuffer: 1 << 28 });
  return out.toString('utf8').split('\0').filter(Boolean).sort();
}

/** 批量读取 HEAD 中的文件内容：Map 仓库相对路径 → 文本。 */
export function readHead(paths) {
  const result = new Map();
  if (!paths.length) return result;
  const input = paths.map((p) => `HEAD:${p}`).join('\n') + '\n';
  const buf = execFileSync('git', ['cat-file', '--batch'], { cwd: ROOT, input, maxBuffer: 1 << 30 });
  let pos = 0;
  for (const p of paths) {
    const nl = buf.indexOf(10, pos);
    const header = buf.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
    if (!m) throw new Error(`git cat-file: cannot read HEAD:${p} (${header})`);
    const size = Number(m[2]);
    result.set(p, buf.subarray(pos, pos + size).toString('utf8'));
    pos += size + 1;
  }
  return result;
}
