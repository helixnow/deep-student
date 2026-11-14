import fs from 'node:fs';
// 从检查输出中摘录真正的失败行（门禁反馈与 lane 自检共用）。
// 测试名里常含 fail/error 字样，不能大小写不敏感地匹配；通过的用例行（✓）一律排除。
export function excerptFailures(out, max = 8) {
  const all = String(out).split('\n').filter((l) => !/^\s*✓/.test(l));
  const strong = all.filter((l) => /×|\bFAIL\b|AssertionError|Error:|error TS\d+|violation\(s\)|[Tt]imed out|heap out of memory|ERR_/.test(l));
  const lines = (strong.length ? strong : all.filter((l) => /error|violation|Timeout/.test(l))).slice(0, max);
  return (lines.length ? lines : String(out).trim().split('\n').slice(-3)).join(' | ').slice(0, 1500);
}

const ANSI = /\x1b\[[0-9;]*m/g;
/** vitest 默认报告中的失败标识：用例为 `文件 > 描述链 > 标题`，整个文件加载失败为 `文件`。 */
export function failedTestKeys(out) {
  const keys = new Set();
  for (const raw of String(out).replace(ANSI, '').split('\n')) {
    const m = /^\s*FAIL\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s*(.*)$/.exec(raw);
    if (!m) continue;
    const rest = m[2].trim();
    if (!rest || rest.startsWith('[')) keys.add(m[1]);
    else if (rest.startsWith('>')) keys.add(`${m[1]} > ${rest.slice(1).trim()}`);
  }
  return keys;
}

/** 最近一次全量测试（fulltest.mjs）中 main 上已失败的用例/文件，作为门禁基线。 */
export function loadBaselineFailures(file) {
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    const set = new Set();
    for (const t of r.testResults ?? []) {
      const ar = t.assertionResults ?? [];
      if (t.status === 'failed' && !ar.length) set.add(t.name);
      for (const a of ar) if (a.status === 'failed') set.add(`${t.name} > ${[...(a.ancestorTitles ?? []), a.title].join(' > ')}`);
    }
    return { head: String(r.head ?? '').slice(0, 9), at: r.at, set };
  } catch {
    return null;
  }
}

/**
 * 测试检查的基线判定：失败全部是 main 上既有的失败 → 不阻塞（注明）；有新增失败 → 阻塞，并把新增项列在前面。
 * 解析不出失败标识（崩溃、超时等）时维持原判定。
 */
export function judgeAgainstBaseline(result, out, baseline) {
  if (result.ok || !baseline) return result;
  const keys = [...failedTestKeys(out)];
  if (!keys.length) return result;
  const fresh = keys.filter((k) => !baseline.set.has(k));
  if (!fresh.length) {
    return { ...result, ok: true, excerpt: `仅 main 既有失败 ${keys.length} 项（基线全量测试 ${baseline.head}），不阻塞：${keys.slice(0, 5).join(' | ')}`.slice(0, 1500) };
  }
  return { ...result, excerpt: `新增失败 ${fresh.length} 项（另有 main 既有失败 ${keys.length - fresh.length} 项不计）：${fresh.slice(0, 8).join(' | ')}`.slice(0, 1500) };
}

/**
 * vitest JSON 报告（--reporter=json --outputFile.json=…）中的失败标识，键格式与 loadBaselineFailures 相同
 * （文件路径相对工作树根）。读不到或解析失败返回 null（调用方退回文本判定）。
 * 测试输出里的预期错误日志（例如 "Database error: … 已拒绝"）不会进入这里：只看用例与文件的 status。
 */
export function failedKeysFromJson(file, root) {
  let r;
  try {
    r = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const rel = (n) => {
    const s = String(n ?? '');
    return root && s.startsWith(`${root}/`) ? s.slice(root.length + 1) : s;
  };
  const keys = new Set();
  for (const t of r.testResults ?? []) {
    const ar = t.assertionResults ?? [];
    const failed = ar.filter((a) => a.status === 'failed');
    if (t.status === 'failed' && !failed.length) keys.add(rel(t.name));
    for (const a of failed) keys.add(`${rel(t.name)} > ${[...(a.ancestorTitles ?? []), a.title].join(' > ')}`);
  }
  const settled = new Set(['passed', 'skipped', 'pending', 'todo']);
  const total = r.numTotalTests ?? 0;
  // 报告完整：有用例、每个文件和用例都有终态、计数对得上。worker RPC 超时可能丢进度上报，所以不能只看 numFailedTests
  const complete = total > 0
    && (r.testResults ?? []).every((t) => settled.has(t.status) && (t.assertionResults ?? []).every((a) => settled.has(a.status)))
    && (r.numPassedTests ?? 0) + (r.numPendingTests ?? 0) + (r.numTodoTests ?? 0) === total;
  return { keys, numFailedTests: r.numFailedTests ?? 0, numFailedTestSuites: r.numFailedTestSuites ?? 0, numTotalTests: total, numPassedTests: r.numPassedTests ?? 0, complete };
}

/** vitest worker 与主进程的 RPC 超时：CPU 争抢造成，不是代码问题。 */
export const INFRA_TIMEOUT = /Timeout calling "on\w+"|\[vitest-worker\]: Timeout/;

/**
 * 进程级未处理错误是否全部是 worker RPC 超时：数 `Unhandled Error` 块的首个 Error 行，并与汇总行 `Errors  N error(s)` 核对。
 * 有任何别的未处理错误、或数不上 → false。
 */
export function onlyInfraErrors(out) {
  const text = String(out).replace(ANSI, '');
  const declared = Number(/^\s*Errors\s+(\d+)\s+errors?\b/m.exec(text)?.[1] ?? NaN);
  const blocks = text.split(/⎯+ Unhandled (?:Error|Rejection) ⎯+/).slice(1);
  const heads = blocks.map((b) => b.split('\n').find((l) => /\S/.test(l)) ?? '');
  return Number.isFinite(declared) && declared > 0 && heads.length === declared && heads.every((h) => INFRA_TIMEOUT.test(h));
}

/**
 * 按 JSON 报告判定测试检查：失败集合与 main 基线做差集。
 * - 报告缺失 → 维持文本判定（judgeAgainstBaseline）。
 * - 报告里没有失败用例/文件、但退出码非 0（进程级未处理错误等）→ 不放行，注明"报告无失败项"。
 */
export function judgeTestsJson(result, out, baseline, json) {
  if (!json) return judgeAgainstBaseline(result, out, baseline);
  const keys = [...json.keys];
  if (result.ok) return result;
  if (!keys.length && json.complete && !json.numFailedTests && !json.numFailedTestSuites && onlyInfraErrors(out)) {
    // C2 06:01Z 定性：报告完整、0 失败、未处理错误只有 worker RPC 超时 → 基础设施误报，直接放行，不重跑整套
    return { ...result, ok: true, infra: true, excerpt: `JSON 报告完整（${json.numPassedTests}/${json.numTotalTests} 通过，其余跳过），0 失败；退出码 ${result.code} 只来自 worker RPC 超时（基础设施误报，不阻塞）：${result.excerpt}`.slice(0, 1500) };
  }
  if (!keys.length) return { ...result, excerpt: `退出码 ${result.code}，JSON 报告无失败用例（${json.numTotalTests} 项全部未失败）：进程级错误。${result.excerpt}`.slice(0, 1500) };
  if (!baseline) return { ...result, excerpt: `失败 ${keys.length} 项（无 main 基线可比）：${keys.slice(0, 8).join(' | ')}`.slice(0, 1500) };
  const fresh = keys.filter((k) => !baseline.set.has(k));
  if (!fresh.length) {
    return { ...result, ok: true, excerpt: `仅 main 既有失败 ${keys.length} 项（基线全量测试 ${baseline.head}，按 JSON 报告），不阻塞：${keys.slice(0, 5).join(' | ')}`.slice(0, 1500) };
  }
  return { ...result, excerpt: `新增失败 ${fresh.length} 项（另有 main 既有失败 ${keys.length - fresh.length} 项不计，按 JSON 报告）：${fresh.slice(0, 8).join(' | ')}`.slice(0, 1500) };
}

/** 给宿主测试检查追加 JSON 报告参数（保留默认报告，供人读原件）。 */
export function withJsonReport(c, file) {
  if (c.name !== 'tests') return c;
  return { ...c, args: [...c.args, '--reporter=default', '--reporter=json', `--outputFile.json=${file}`] };
}

// 宿主测试的超时按测试目录数缩放：整体复核一次跑 6 个插件目录、2500 个用例，单跑约 15 分钟，15 分钟上限正好卡死。
// 每多一个目录加 7.5 分钟，最多 60 分钟；降并发重跑时（并发减半）再翻倍，最多 90 分钟。
export const timeoutFor = (c, attempt = 0, TIMEOUT_MS = 15 * 60_000) => {
  if (!/^tests/.test(String(c.name))) return TIMEOUT_MS;
  const dirs = (c.args ?? []).filter((a) => /^(host|src)\//.test(a)).length;
  const base = Math.min(60 * 60_000, TIMEOUT_MS + Math.max(0, dirs - 1) * 7.5 * 60_000);
  return attempt ? Math.min(90 * 60_000, base * 2) : base;
};
