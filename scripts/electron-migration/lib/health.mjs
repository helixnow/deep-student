// lane 健康度（监控面板、coord.mjs health、dsctl 共用）。
// 输入是 lane 日志末尾的事件（opencode run --format json 的 JSONL）与少量状态；输出档位与具体原因。
import fs from 'node:fs';
import path from 'node:path';

const MIN = 60_000;
export const THRESHOLDS = {
  ctxWarn: 0.7, ctxBad: 0.9,              // 上下文占用（相对模型上限）
  idleWarnMin: 15, idleBadMin: 30,        // 在跑但无输出
  errWarn: 0.2, errBad: 0.5,              // 最近 30 步出错率
  noCommitWarnMin: 90, noCommitBadMin: 180, // 在跑但无新提交
  queueWarnMin: 5,                        // 队列最老消息等待
  retriesWarn: 2,
  stepsWarn: 1000,                        // 会话步数（上下文污染风险）
};

/** 模型上下文上限：从 opencode 配置读取（provider/model → limit.context），带默认值。 */
export function loadModelLimits(home = process.env.HOME ?? '') {
  const limits = {};
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.config/opencode/opencode.json'), 'utf8'));
    for (const [prov, p] of Object.entries(cfg.provider ?? {})) {
      for (const [m, def] of Object.entries(p.models ?? {})) if (def?.limit?.context) limits[`${prov}/${m}`] = def.limit.context;
    }
  } catch {
    // 读不到配置时用默认值
  }
  return limits;
}

function contextLimit(model, limits) {
  const base = String(model ?? '').replace(/#.*$/, '');
  return limits[base] ?? (base.includes('deepseek') ? 400_000 : 1_050_000);
}

/**
 * @param o { model, alive, events, lastActivityMs, lastCommitMs, queue, retries, sessionSteps, now }
 */
export function computeHealth(o, limits = {}) {
  const now = o.now ?? Date.now();
  const flags = [];
  let level = 0; // 0 健康 1 注意 2 异常
  const bump = (l, msg) => {
    flags.push({ level: l, msg });
    level = Math.max(level, l);
  };
  const ev = o.events ?? [];

  // 上下文：最近一个 step_finish 的 input + cache.read + cache.write
  let ctxTokens = null;
  for (let i = ev.length - 1; i >= 0; i--) {
    const t = ev[i].type === 'step_finish' ? ev[i].part?.tokens : null;
    if (t) {
      ctxTokens = (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
      break;
    }
  }
  const limit = contextLimit(o.model, limits);
  const ctxPct = ctxTokens == null ? null : ctxTokens / limit;
  if (ctxPct != null) {
    if (ctxPct >= THRESHOLDS.ctxBad) bump(2, `上下文 ${(ctxPct * 100).toFixed(0)}%（${Math.round(ctxTokens / 1000)}k/${Math.round(limit / 1000)}k），opencode 将自动压缩`);
    else if (ctxPct >= THRESHOLDS.ctxWarn) bump(1, `上下文 ${(ctxPct * 100).toFixed(0)}%`);
  }

  // 在跑但无输出
  const idleMin = o.lastActivityMs ? (now - o.lastActivityMs) / MIN : null;
  if (o.alive && idleMin != null) {
    if (idleMin >= THRESHOLDS.idleBadMin) bump(2, `${idleMin.toFixed(0)} 分钟无输出（疑似卡住）`);
    else if (idleMin >= THRESHOLDS.idleWarnMin) bump(1, `${idleMin.toFixed(0)} 分钟无输出`);
  }

  // 最近 30 步的出错率
  const steps = [];
  let cur = null;
  for (const e of ev) {
    if (e.type === 'step_start') {
      cur = { err: false };
      steps.push(cur);
    } else if (e.type === 'error' && cur) cur.err = true;
    else if (e.type === 'tool_use' && cur && e.part?.state?.status === 'error') cur.err = true;
  }
  const recent = steps.slice(-30);
  const errRate = recent.length >= 5 ? recent.filter((s) => s.err).length / recent.length : null;
  if (errRate != null) {
    if (errRate >= THRESHOLDS.errBad) bump(2, `最近 ${recent.length} 步出错率 ${(errRate * 100).toFixed(0)}%`);
    else if (errRate >= THRESHOLDS.errWarn) bump(1, `最近 ${recent.length} 步出错率 ${(errRate * 100).toFixed(0)}%`);
  }

  // 在跑但长时间无提交（可能在空转）
  const noCommitMin = o.lastCommitMs ? (now - o.lastCommitMs) / MIN : null;
  if (o.alive && noCommitMin != null) {
    if (noCommitMin >= THRESHOLDS.noCommitBadMin) bump(2, `${(noCommitMin / 60).toFixed(1)} 小时无新提交（可能空转）`);
    else if (noCommitMin >= THRESHOLDS.noCommitWarnMin) bump(1, `${noCommitMin.toFixed(0)} 分钟无新提交`);
  }

  // 卡住：stall-watch 判定的"在跑但 90 秒无任何事件且无工具进程"（只记录，仍等待恢复）
  if (o.stallSec != null) {
    if (o.stallSec >= 600) bump(2, `已卡住 ${Math.round(o.stallSec / 60)} 分钟（模型无返回）`);
    else if (o.stallSec >= 90) bump(1, `已卡住 ${o.stallSec} 秒（模型无返回）`);
  }

  // 排队、重试、会话步数
  const oldestQ = (o.queue ?? []).map((q) => Date.parse(q.queuedAt)).filter(Boolean).sort()[0];
  if (oldestQ && now - oldestQ >= THRESHOLDS.queueWarnMin * MIN) bump(1, `队列消息已等 ${((now - oldestQ) / MIN).toFixed(0)} 分钟`);
  if ((o.retries ?? 0) >= THRESHOLDS.retriesWarn) bump(1, `已自动恢复 ${o.retries} 次`);
  if ((o.sessionSteps ?? 0) >= THRESHOLDS.stepsWarn) bump(1, `会话已 ${o.sessionSteps} 步（上下文污染风险）`);

  return {
    level: ['ok', 'warn', 'bad'][level],
    flags,
    ctxTokens,
    ctxPct,
    idleMin,
    errRate,
    noCommitMin,
    sessionSteps: o.sessionSteps ?? null,
    stallSec: o.stallSec ?? null,
  };
}

/** 当前卡住的 lane（stall-watch 写的 .oc-runs/stalls.current.json）：lane → 已卡住秒数（按读取时刻重算）。 */
export function loadStalls(runsDir) {
  try {
    const cur = JSON.parse(fs.readFileSync(path.join(runsDir, 'stalls.current.json'), 'utf8'));
    const out = {};
    for (const [lane, v] of Object.entries(cur.lanes ?? {})) out[lane] = Math.round((Date.now() - Date.parse(v.since)) / 1000);
    return out;
  } catch {
    return {};
  }
}

/** 会话步数（整份日志里的 step_start 数）：按文件大小增量计数并缓存，避免反复全量读取大日志。 */
const stepCache = new Map();
export function sessionSteps(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return 0;
  }
  const c = stepCache.get(file);
  if (c && c.size === st.size) return c.count;
  let from = c && c.size < st.size ? c.size : 0;
  let count = c && from ? c.count : 0;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let carry = '';
    while (from < st.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, st.size - from), from);
      if (n <= 0) break;
      const text = carry + buf.subarray(0, n).toString('utf8');
      const cut = text.lastIndexOf('\n');
      const body = cut >= 0 ? text.slice(0, cut) : '';
      carry = cut >= 0 ? text.slice(cut + 1) : text;
      count += (body.match(/"type":"step_start"/g) ?? []).length;
      from += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  stepCache.set(file, { size: st.size, count });
  return count;
}
