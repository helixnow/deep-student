// ledger.mjs 的测试报告输入：vitest JSON reporter 原件（可多个分片）或 fulltest.mjs 合并的 latest.json（带 head/at）。
// 原件里的 testResults[].name 是跑测试那台机器上的绝对路径（如 /home/dsdev/wt/X/host/...），
// 这里统一成仓库相对路径；同一文件出现在多份报告里时以后给出的报告为准（重跑覆盖），不重复计数。
import fs from 'node:fs';
import path from 'node:path';

export const LATEST_FULLTEST = '.oc-runs/fulltest/latest.json';
const ANCHOR = /(?:^|\/)((?:host|electron|scripts|src|tests|playwright)\/.+)$/;

/** 报告中的测试文件名 → 仓库相对 posix 路径。 */
export function repoRelativeTestPath(name, root, exists = (rel) => fs.existsSync(path.join(root, rel))) {
  const posix = name.replaceAll('\\', '/');
  if (!path.isAbsolute(name) && !/^[A-Za-z]:\//.test(posix)) return posix.replace(/^\.\//, '');
  const inRoot = path.relative(root, name);
  if (!inRoot.startsWith('..') && !path.isAbsolute(inRoot)) return inRoot.split(path.sep).join('/');
  const segs = posix.split('/').filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    const candidate = segs.slice(i).join('/');
    if (exists(candidate)) return candidate;
  }
  return ANCHOR.exec(posix)?.[1] ?? posix;
}

/** `--vitest` 参数展开：`latest` → .oc-runs/fulltest/latest.json；目录 → 其中全部 *.json（排序）。 */
export function expandReportArgs(args, root) {
  const out = [];
  for (const arg of args) {
    const p = arg === 'latest' ? path.join(root, LATEST_FULLTEST) : path.resolve(arg);
    if (!fs.existsSync(p)) throw new Error(arg === 'latest' ? `no ${LATEST_FULLTEST} (run fulltest.mjs first)` : `vitest report not found: ${arg}`);
    if (fs.statSync(p).isDirectory()) out.push(...fs.readdirSync(p).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(p, f)));
    else out.push(p);
  }
  if (!out.length) throw new Error(`no vitest JSON reports in ${args.join(', ')}`);
  return out;
}

/**
 * @param {{ path: string, report: any }[]} reports
 * @returns {{ results: Map<string, { title: string, fullName: string, status: string }[]>, provenance: { path: string, head: string | null, at: string | null, files: number, tests: number }[], overridden: string[] }}
 */
export function mergeVitestReports(reports, root, exists) {
  const results = new Map();
  const provenance = [];
  const overridden = [];
  for (const { path: file, report } of reports) {
    if (!report || !Array.isArray(report.testResults)) throw new Error(`${file}: not a vitest JSON report (missing testResults[])`);
    let tests = 0;
    for (const r of report.testResults) {
      const rel = repoRelativeTestPath(String(r.name), root, exists);
      if (results.has(rel)) overridden.push(rel);
      const assertions = (r.assertionResults ?? []).map((a) => ({ title: a.title ?? '', fullName: a.fullName ?? '', status: a.status }));
      tests += assertions.length;
      results.set(rel, assertions);
    }
    provenance.push({ path: file, head: typeof report.head === 'string' ? report.head : null, at: typeof report.at === 'string' ? report.at : null, files: report.testResults.length, tests });
  }
  return { results, provenance, overridden };
}

export function loadVitestReports(args, root) {
  const files = expandReportArgs(args, root);
  return mergeVitestReports(files.map((f) => ({ path: f, report: JSON.parse(fs.readFileSync(f, 'utf8')) })), root);
}
