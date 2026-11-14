// 协调者摘要用的报告（进展、修复检测、流水线体检）由 ds-coord-reports.timer 预先生成到 .oc-runs/reports/，
// 调度守护进程的主循环只读文件。原先在主循环里同步 spawn（每份最长 60–90 秒、上百次 git 调用），会拖住 fastTick 心跳。
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';

export const reportsDir = (runs) => path.join(runs, 'reports');
// 每轮（5 分钟）一行；面板的空转判定要往回看两个两小时窗口，留 6 小时。
export const HISTORY_KEEP = 72;

function appendVerdicts(runs, progressJson) {
  const p = JSON.parse(progressJson);
  const line = JSON.stringify({ at: p.at, minutes: p.minutes, verdicts: Object.fromEntries((p.rows ?? []).map((r) => [r.lane, r.verdict])) });
  const file = path.join(reportsDir(runs), 'progress-history.jsonl');
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    lines = [];
  }
  writeFileAtomic(file, `${[...lines, line].slice(-HISTORY_KEEP).join('\n')}\n`);
}

function coordinators(runs) {
  const ss = JSON.parse(fs.readFileSync(path.join(runs, 'sessions.json'), 'utf8'));
  return Object.entries(ss).filter(([k, v]) => !k.startsWith('__') && v && !v.chief && Array.isArray(v.lanes) && v.lanes.length).map(([k]) => k);
}

/** run(script, args) → stdout；抛错表示该份报告本轮生成失败（保留上一份）。 */
export function generate({ runs, run }) {
  const jobs = [
    ['progress.txt', 'coord.mjs', ['progress', '--minutes', '120']],
    ['progress.json', 'coord.mjs', ['progress', '--minutes', '120', '--json']],
    ['repair-check.txt', 'coord.mjs', ['repair', 'check']],
    ['substance.txt', 'coord.mjs', ['substance', '--minutes', '60']],
    ['pipeline-check.json', 'pipeline-check.mjs', ['--json']],
  ];
  const errors = [];
  try {
    for (const c of coordinators(runs)) jobs.push([`progress-${c}.txt`, 'coord.mjs', ['progress', '--minutes', '120', '--mine', c]]);
  } catch (e) {
    errors.push(`sessions.json: ${e.message}`);
  }
  fs.mkdirSync(reportsDir(runs), { recursive: true });
  for (const [file, script, args] of jobs) {
    try {
      const out = String(run(script, args) ?? '').trim();
      if (file.endsWith('.json')) JSON.parse(out);
      writeFileAtomic(path.join(reportsDir(runs), file), out);
      if (file === 'progress.json') appendVerdicts(runs, out);
    } catch (e) {
      errors.push(`${file}: ${String(e.message).split('\n')[0]}`);
    }
  }
  return { errors };
}

/** 只读：缺失或过期时返回说明文字，不在调用方进程里生成。 */
export function read(runs, file, { label, now = Date.now(), maxAgeMs = 20 * 60_000 } = {}) {
  const p = path.join(reportsDir(runs), file);
  let st;
  let text;
  try {
    st = fs.statSync(p);
    text = fs.readFileSync(p, 'utf8').trim();
  } catch {
    return `（${label}暂无：等待 ds-coord-reports.timer 生成）`;
  }
  const ageMin = Math.round((now - st.mtimeMs) / 60_000);
  return now - st.mtimeMs > maxAgeMs ? `${text}\n（⚠ ${label}已 ${ageMin} 分钟未更新：ds-coord-reports.timer 可能没在跑）` : text;
}

export function readJson(runs, file, { now = Date.now(), maxAgeMs = 20 * 60_000 } = {}) {
  try {
    const p = path.join(reportsDir(runs), file);
    const st = fs.statSync(p);
    return { data: JSON.parse(fs.readFileSync(p, 'utf8')), stale: now - st.mtimeMs > maxAgeMs, ageMin: Math.round((now - st.mtimeMs) / 60_000) };
  } catch {
    return null;
  }
}
