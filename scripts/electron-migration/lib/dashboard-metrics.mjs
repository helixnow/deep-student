// 监控面板的第二阶段指标（纯解析，不运行任何东西）：账本 B-test / B-doc、功能可达性缺口、G3 正式录制通过率、
// RESUME-PLAN §4.2 的六条空转判定。输入都是已有进程写下的文件或输出；拿不到的一律标"未统计"，不当成 0。
import fs from 'node:fs';

const MIN = 60_000;
const num = (s) => (s == null ? null : Number(s));

/** ledger.mjs 的 stdout 摘要行。W09 之前的格式没有 B-test / B-doc，对应字段为 null。 */
export function parseLedgerLine(line) {
  const m = /commands (\d+) \(A ([\d.]+)% B ([\d.]+)% C ([\d.]+)%(?:; B-test ([\d.]+)% B-doc ([\d.]+)%)?\), tests (\d+) \(A ([\d.]+)% B ([\d.]+)%/.exec(String(line ?? ''));
  if (!m) return null;
  return { commands: +m[1], cmdA: +m[2], cmdB: +m[3], cmdC: +m[4], cmdBTest: num(m[5]), cmdBDoc: num(m[6]), tests: +m[7], testA: +m[8], testB: +m[9] };
}

/** LEDGER.md 的各 lane 表：B-test / B-doc 是追加在行尾的两列，旧表没有。 */
export function parseLedgerMd(md) {
  const lanes = {};
  const p = '([\\d.]+)%';
  const re = new RegExp(`^\\| ([A-Z]\\d+[a-z]?-[\\w-]+) \\| (\\d+) \\| ${p} \\| ${p} \\| ${p} \\| (\\d+) \\| ${p} \\| ${p} \\|(?: ${p} \\| ${p} \\|)?`);
  for (const line of String(md).split('\n')) {
    const m = re.exec(line);
    if (m) lanes[m[1]] = { cmd: +m[2], cmdA: +m[3], cmdB: +m[4], cmdC: +m[5], tests: +m[6], testA: +m[7], testB: +m[8], cmdBTest: num(m[9]), cmdBDoc: num(m[10]) };
  }
  return lanes;
}

/** gate-checks/event-emit.mjs --json 的 summary。 */
export function parseEventEmit(stdout) {
  try {
    const r = JSON.parse(stdout);
    const s = r?.gate === 'event-emit' ? r.summary : null;
    if (!s || !Number.isInteger(s.existing)) return null;
    return { existing: s.existing, unemitted: s.unemitted, dynamic: s.dynamic, fresh: s.fresh, stale: s.stale };
  } catch {
    return null;
  }
}

/** host/e2e/coverage/agent-tool-coverage.test.ts 打印的计数行（只在测试输出里，没有 JSON）。 */
export function parseToolCoverage(stdout) {
  const m = /agent-tool-coverage: (\d+) frontend tools, (\d+) executors \(.*?\); (\d+) uncovered/.exec(String(stdout ?? ''));
  return m ? { tools: +m[1], executors: +m[2], uncovered: +m[3] } : null;
}

/** 基线文件的条目数（门禁只拦新增，所以 main 上的缺口不超过基线）。 */
export function baselineCount(file) {
  try {
    const entries = JSON.parse(fs.readFileSync(file, 'utf8')).entries;
    return Array.isArray(entries) ? entries.length : null;
  } catch {
    return null;
  }
}

/**
 * G3 正式录制报告（record/g3-report.mjs 的 g3-report.json）。只有带录制回执且回执无缺陷的报告才给通过率；
 * 其他情况 measured=false 并说明原因，面板显示"未统计"。
 */
export function readG3(file) {
  const no = (reason) => ({ measured: false, reason });
  let r;
  try {
    r = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return no(e.code === 'ENOENT' ? `未找到 G3 报告（${file}）` : `G3 报告无法解析：${String(e.message).slice(0, 80)}`);
  }
  if (r?.schema !== 'g3-report-v1') return no(`不是 g3-report-v1 报告（schema=${String(r?.schema)}）`);
  if (!r.recording?.file) return no('不是正式录制（报告没有录制回执）');
  const defects = Array.isArray(r.recording.defects) ? r.recording.defects.length : null;
  if (defects !== 0) return no(defects == null ? '录制回执缺少 defects 字段' : `录制回执有缺陷 ${defects} 项，不计通过率`);
  const { pass, of, percent } = r.passRate ?? {};
  if (!Number.isInteger(pass) || !Number.isInteger(of) || of <= 0 || pass > of) return no('报告的 passRate 字段无效');
  return { measured: true, pass, of, percent: Number.isFinite(percent) ? percent : Math.round((pass / of) * 10000) / 100, head: String(r.head ?? '').slice(0, 9), totals: r.totals ?? null };
}

/** .oc-runs/board/WORKPLAN.md 的工作包行（与 coord.mjs 读法相同）。 */
export function parseWorkplan(text) {
  return String(text ?? '').split('\n').filter((l) => /^\| WP-/.test(l)).map((l) => l.split('|').map((x) => x.trim())).filter((p) => p.length > 7)
    .map((p) => ({ id: p[1], lane: p[2], status: p[6] }));
}

/** 按行解析 JSONL；文件不存在返回 null，坏行（如写到一半的末行）跳过。 */
export function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  return text.split('\n').flatMap((l) => {
    try {
      return l ? [JSON.parse(l)] : [];
    } catch {
      return [];
    }
  });
}

const ACCEPTED = new Set(['delivered', 'integrated']);

/**
 * RESUME-PLAN §4.2 的六条空转判定。state：hit（越线）/ clear / manual（由 C2 人工判定）/ unknown（数据源缺失或过期）。
 * @param o { history: progress-history 行 | null, nudges, deliveries, workplan, zeroMerge: {streak}|null, nowMs, minutes }
 */
export function spinCriteria({ history, nudges, deliveries, workplan, zeroMerge, nowMs = Date.now(), minutes = 120, staleMin = 30 }) {
  const out = [];
  const snaps = (history ?? []).filter((h) => h && Number.isFinite(Date.parse(h.at))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const latest = snaps.at(-1);
  const fresh = latest && nowMs - Date.parse(latest.at) <= staleMin * MIN;
  const noProgress = !latest ? '进展快照未生成（ds-coord-reports.timer）' : `最近一次进展快照在 ${Math.round((nowMs - Date.parse(latest.at)) / MIN)} 分钟前，定时器可能没在跑`;
  const lanesWith = (snap, verdict) => Object.entries(snap?.verdicts ?? {}).filter(([, v]) => v === verdict).map(([l]) => l).sort();

  const r1 = { id: 1, label: '耗步骤无提交，连续两个两小时窗口', lanes: [] };
  const prior = fresh ? [...snaps].reverse().find((h) => Date.parse(h.at) <= Date.parse(latest.at) - minutes * MIN) : null;
  if (!fresh) out.push({ ...r1, state: 'unknown', detail: noProgress });
  else if (!prior) out.push({ ...r1, state: 'unknown', detail: `快照不足 ${minutes} 分钟，还不能比较两个窗口` });
  else {
    const before = new Set(lanesWith(prior, 'idle-spin'));
    const lanes = lanesWith(latest, 'idle-spin').filter((l) => before.has(l));
    out.push({ ...r1, state: lanes.length ? 'hit' : 'clear', lanes, detail: lanes.length ? `${lanes.length} 条 lane ≥40 步零提交，已持续两个窗口` : '无' });
  }

  const r2 = { id: 2, label: '非评审 lane 两小时内只改文档', lanes: [] };
  if (!fresh) out.push({ ...r2, state: 'unknown', detail: noProgress });
  else {
    const lanes = lanesWith(latest, 'doc-spin');
    out.push({ ...r2, state: lanes.length ? 'hit' : 'clear', lanes, detail: lanes.length ? `${lanes.length} 条 lane 只有文档提交` : '无' });
  }

  out.push({ id: 3, label: '重做已完成的工作（交付与 main 无差异，或派发前已满足验收）', lanes: [], state: 'manual', detail: 'C2 验收时判定并记录，C1 当轮复盘查重；面板不自动统计' });

  const status = new Map((workplan ?? []).map((w) => [w.id, w.status]));
  const counts = new Map();
  for (const d of deliveries ?? []) {
    if (!d?.wp || !d?.lane) continue;
    const k = `${d.wp}\u0000${d.lane}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const repeats = [...counts].filter(([k, n]) => n >= 2 && !ACCEPTED.has(status.get(k.split('\u0000')[0]))).map(([k, n]) => ({ wp: k.split('\u0000')[0], lane: k.split('\u0000')[1], n }));
  out.push({ id: 4, label: '同一工作包被同一 lane 交付 ≥2 次仍未通过验收', state: repeats.length ? 'hit' : 'clear', lanes: [...new Set(repeats.map((r) => r.lane))].sort(),
    detail: repeats.length ? repeats.map((r) => `${r.wp}@${r.lane} 交付 ${r.n} 次`).join('，') : deliveries ? '无' : '暂无交付记录' });

  const backlog = (workplan ?? []).filter((w) => w.status === 'delivered').length;
  const r5 = { id: 5, label: '自动集成连续 3 轮 0 合入，且 ≥5 个已交付未集成的包', lanes: [] };
  if (!zeroMerge) out.push({ ...r5, state: 'unknown', detail: '没有 watch.log，无法统计集成轮次' });
  else out.push({ ...r5, state: zeroMerge.streak >= 3 && backlog >= 5 ? 'hit' : 'clear', detail: `连续 0 合入 ${zeroMerge.streak} 轮；已交付未集成 ${backlog} 个` });

  const since = nowMs - minutes * MIN;
  const refused = new Map();
  for (const n of nudges ?? []) {
    if (!n?.blocked || !(Date.parse(n.t) >= since)) continue;
    for (const topic of n.topics?.length ? n.topics : ['（无主题）']) {
      const k = `${n.from}\u0000${topic}`;
      refused.set(k, (refused.get(k) ?? 0) + 1);
    }
  }
  const hits = [...refused].filter(([, c]) => c >= 3).map(([k, c]) => ({ from: k.split('\u0000')[0], topic: k.split('\u0000')[1], c }));
  out.push({ id: 6, label: '协调者同一主题两小时内第 3 次被催办闸拒绝', state: hits.length ? 'hit' : 'clear', lanes: [...new Set(hits.map((h) => h.from))].sort(),
    detail: hits.length ? hits.map((h) => `${h.from}「${h.topic}」被拒 ${h.c} 次`).join('，') : '无' });
  return out;
}
