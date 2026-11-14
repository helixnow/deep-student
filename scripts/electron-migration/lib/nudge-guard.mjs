// 催办闸：协调者对同一接收者、同一主题，2 小时内第 3 次发送且没有新证据 → 拒绝发送，给出升级阶梯的下一步。
// NIGHT-OPERATIONS 写了"同一阻塞连续两轮无新证据不能重发相同指令"，但没有机制执行：
// 实测 C0 的 132 次主题催办里 18 次是同主题第 3 次以上（WP-043 → C1 7 次），C2 有 97 条与 3 小时内旧消息高度相似。
import fs from 'node:fs';
import path from 'node:path';

export const WINDOW_MS = 2 * 3_600_000;
const COORD = /^(C\d|S0)-/;
const ROLE_TOKENS = new Set(['C0-chief', 'C1-app', 'C2-platform', 'S0-architect']);

export function features(text, exclude = []) {
  const t = String(text);
  const skip = new Set([...ROLE_TOKENS, ...exclude]);
  const topics = [...new Set(t.match(/\b(?:WP-\d+|[A-Z]\d{1,2}b?-[a-z][a-z-]*[a-z]|W-L\d+[a-z]?|U-\d{3})\b/g) ?? [])].filter((x) => !skip.has(x));
  // 新证据：提交号、作业 ID、全测 run ID、集成批次 ID——事实变了才值得再说一次
  const evidence = [...new Set([
    ...(t.match(/\b[0-9a-f]{7,40}\b/g) ?? []).filter((h) => /\d/.test(h) && /[a-f]/.test(h)),
    ...(t.match(/\b\d{14}-[0-9a-f]{6}\b|\bIQ-\d{14}-\w{4}\b|\b\d{4}-\d\d-\d\dT\d{6,9}Z-\d+\b/g) ?? []),
  ])];
  return { topics, evidence, norm: t.replace(/\d+/g, '#').replace(/\s+/g, '').slice(0, 1500) };
}

function grams(s, n = 4) {
  const out = new Set();
  for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
  return out;
}
const jaccard = (a, b) => {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

export function ladder(level) {
  if (level <= 1) return '';
  if (level === 2) return '这是同一主题 2 小时内第 2 次催办：写清唯一 owner、期限和可验证产物（提交号 / job id / 决定编号）。下一次无新证据的同主题催办会被拒绝。';
  return [
    `同一主题 2 小时内第 ${level} 次、且没有新证据（提交号 / job id / run id）：不再发送。改为其中一个动作：`,
    '  a) 自己改变系统状态：coord.mjs restart <lane> / assign <lane> WP-x / integrate --lanes … / release-lock / repair apply <动作>；',
    '  b) 换 owner：要求 C1 改派或拆包（附失败证据），不要再催同一个人；',
    '  c) 不可自动处理：写入 DECISIONS「待用户裁定」或 coord.mjs escalate，并在 COMMAND.md 标"待用户"，停止催办；',
    '  d) 确有新事实但不含上述 ID：--force-repeat --reason "<新事实>"（记审计）。',
  ].join('\n');
}

/**
 * @param history [{ t, from, to, topics, evidence, norm }]
 * @returns { allow, level, ladder, fresh, similar }
 */
export function assess(history, { from, to, text, nowMs = Date.now() }) {
  if (!COORD.test(String(from))) return { allow: true, level: 0, ladder: '', fresh: [], similar: [] };
  const f = features(text, [to, from]);
  const g = grams(f.norm);
  const topics = new Set(f.topics);
  const similar = history.filter((h) => h.from === from && h.to === to && !h.blocked && nowMs - Date.parse(h.t) <= WINDOW_MS
    && ((topics.size && jaccard(topics, new Set(h.topics)) >= 0.5) || jaccard(g, grams(h.norm)) >= 0.6));
  const seen = new Set(similar.flatMap((h) => h.evidence));
  const fresh = f.evidence.filter((e) => !seen.has(e));
  const level = similar.length + 1;
  const allow = level < 3 || fresh.length > 0;
  return { allow, level, ladder: fresh.length ? '' : ladder(level), fresh, similar: similar.map((h) => h.t), features: f };
}

export const logFile = (runs) => path.join(runs, 'nudge-log.jsonl');

export function readHistory(runs, nowMs = Date.now()) {
  try {
    return fs.readFileSync(logFile(runs), 'utf8').trim().split('\n').slice(-3000).map((l) => JSON.parse(l)).filter((h) => nowMs - Date.parse(h.t) <= WINDOW_MS);
  } catch {
    return [];
  }
}

export function record(runs, { from, to, features: f, blocked = false, forced = null, level }, nowMs = Date.now()) {
  fs.appendFileSync(logFile(runs), `${JSON.stringify({ t: new Date(nowMs).toISOString(), from, to, topics: f.topics, evidence: f.evidence, norm: f.norm, level, ...(blocked ? { blocked } : {}), ...(forced ? { forced } : {}) })}\n`);
}
