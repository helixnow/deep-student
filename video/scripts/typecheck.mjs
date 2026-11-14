// 用法：npm run typecheck（引入主应用源码后一次要几分钟）。
// 片子直接 import 主应用组件，tsc 会把它们连同依赖一起按本工程的配置（strict、无 vite/client 类型）检查，
// 报出的是配置差异而不是缺陷；主应用由仓库根的 tsconfig 自己检查。这里只把本工程文件的诊断算作失败。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = path.join(root, 'node_modules/typescript/bin/tsc');
const run = spawnSync(process.execPath, [tsc, '--noEmit', '--pretty', 'false'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
if (run.error || run.status === null) {
  console.error(run.error ?? `tsc was killed by ${run.signal}`);
  process.exit(1);
}

// 一条诊断 = 一个不以空白开头的行 + 后面缩进的续行
const diagnostics = [];
for (const line of run.stdout.split('\n')) {
  if (!line) continue;
  if (/^\s/.test(line) && diagnostics.length > 0) diagnostics[diagnostics.length - 1] += `\n${line}`;
  else diagnostics.push(line);
}
const own = diagnostics.filter((d) => !d.startsWith('../'));
if (own.length > 0) console.error(own.join('\n'));
if (run.stderr) console.error(run.stderr);
console.log(`typecheck: ${own.length} in video/, ${diagnostics.length - own.length} in the app sources (not counted)`);
process.exit(own.length > 0 || (run.status !== 0 && diagnostics.length === 0) ? 1 : 0);
