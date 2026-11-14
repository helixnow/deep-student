#!/usr/bin/env node
// 预生成协调者摘要用的报告（由 ds-coord-reports.timer 以 dsdev 每 5 分钟运行一次）。见 lib/coord-reports.mjs。
//   node scripts/electron-migration/coord-reports.mjs
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generate } from './lib/coord-reports.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const RUNS = path.join(ROOT, '.oc-runs');

const run = (script, args) => {
  try {
    return execFileSync(process.execPath, [path.join(HERE, script), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    // repair check / pipeline-check 有发现时退出码为 1，输出仍然有效
    if (e.status === 1 && e.stdout) return e.stdout;
    throw e;
  }
};

const { errors } = generate({ runs: RUNS, run });
for (const e of errors) console.error(`coord-reports: ${e}`);
process.exitCode = errors.length ? 1 : 0;
