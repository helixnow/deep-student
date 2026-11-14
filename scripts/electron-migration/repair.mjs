#!/usr/bin/env node
// 管线修复动作（协调者 / S0 / 守护进程用）：处理管线与结构自身的故障，而不是给 lane 发消息。
// 动作定义与安全约定见 lib/repair-actions.mjs。每次 plan/apply 记 .oc-runs/repairs.jsonl。
//
//   node scripts/electron-migration/repair.mjs list
//   node scripts/electron-migration/repair.mjs check [--json]                     全部动作只读检测；有发现时退出码 1
//   node scripts/electron-migration/repair.mjs plan <动作> --from <你>
//   node scripts/electron-migration/repair.mjs apply <动作> --from <你> [--approve] [--reason ...]
//
// 动作：git-ownership（只报告，附人工一次性命令）、state-json、sessions-compact（守护进程停止时）、
//       stale-locks、fulltest-resume（hold/维护标记时不恢复）。confirm 级的步骤需要 --approve。
// 只以 dsdev 身份运行；以 root 调用会直接报错。
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as repair from './lib/repair-actions.mjs';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const commonDir = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
})();
// 主仓库（.oc-runs 所在处）：从任意 lane 工作树调用也落到主仓库。
const ROOT = opt('root') ?? (commonDir ? path.resolve(commonDir, '..') : process.cwd());
const ctx = repair.makeContext({ root: ROOT, runs: opt('runs') ?? path.join(ROOT, '.oc-runs'), by: opt('from', '?') });
const cmd = argv[0];

if (cmd === 'list') {
  for (const n of repair.ACTION_NAMES) console.log(n);
} else if (cmd === 'check') {
  const r = repair.check(ctx).map((x) => ({ ...x, findings: x.findings.map(({ files, ...f }) => f) }));
  if (argv.includes('--json')) process.stdout.write(JSON.stringify({ at: new Date().toISOString(), root: ROOT, actions: r }));
  else {
    for (const x of r) {
      const tag = x.findings.length ? '🔧' : '✅';
      console.log(`${tag} ${x.action}（${x.policy}）：${x.findings.length ? x.findings.map((f) => `${f.kind}${f.file ? ` ${f.file}` : ''}${f.count ? ` ×${f.count}` : ''}${f.runId ? ` ${f.runId}` : ''}`).join('；') : '无'}`);
    }
  }
  process.exitCode = r.some((x) => x.findings.length) ? 1 : 0;
} else if (cmd === 'plan' || cmd === 'apply') {
  const name = argv[1];
  if (!opt('from')) throw new Error('必须用 --from <你的 lane 名> 标明来源（写入审计）');
  if (!fs.existsSync(ctx.runs)) throw new Error(`找不到调度目录：${ctx.runs}`);
  const r = repair.run(ctx, name, { apply: cmd === 'apply', approve: argv.includes('--approve'), reason: opt('reason', '') });
  console.log(JSON.stringify(r, null, 2));
  if (cmd === 'apply' && r.result && r.result.ok === false) process.exitCode = 2;
} else {
  console.log('用法见文件头注释：list | check | plan <动作> | apply <动作>');
  process.exitCode = 1;
}
