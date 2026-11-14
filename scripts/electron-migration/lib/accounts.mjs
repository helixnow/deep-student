// 多账号额度调度（纯函数，便于测试）。
//
// 配置 .oc-runs/accounts.json：
//   { "integration": "OpenCode Console", "accounts": ["Default", "Personal", ...],
//     "cooldownMinutes": 10, "quotaWindowMinutes": 300 }
// 状态 sessions.__accounts：{ active, exhausted: { <账号>: ISO 时间 }, lastSwitchAt }
//
// 规则：
// - 当前账号报额度错误 → 记为耗尽（时间 = 现在）；
// - 换号只选"从未耗尽"或"耗尽已超过 quotaWindowMinutes"的账号，按配置顺序从当前账号之后找；
// - 全部耗尽 → 不切换，返回最早恢复时间（lane 等待，不消耗重试）；
// - 当前账号处于耗尽期而有账号已恢复 → 主动切过去（不必等下一次失败）；
// - 两次切换至少间隔 cooldownMinutes，避免并发失败触发连环切换。

/** 额度/限流类错误（只用于 OpenCode Go 模型的 lane）。不含泛化的 exceed，避免把"上下文超长"误判为额度耗尽。 */
export const QUOTA_RE = /quota|usage limit|rate.?limit|limit (reached|exceeded)|too many requests|insufficient (balance|credit|quota|funds)|billing|额度|限额|配额|用量/i;

export function isQuotaError(error) {
  const e = error ?? {};
  if (e.status === 429 || e.status === 402) return true;
  return QUOTA_RE.test(`${e.message ?? ''} ${typeof e.response === 'string' ? e.response : JSON.stringify(e.response ?? '')}`);
}

/** 由旧版状态（{ index }）迁移为按账号名记录的状态。 */
export function normalizeState(state, cfg) {
  const s = { exhausted: {}, lastSwitchAt: null, ...(state ?? {}) };
  if (!s.active) s.active = cfg.accounts[Number.isInteger(s.index) ? s.index % cfg.accounts.length : 0];
  delete s.index;
  for (const k of Object.keys(s.exhausted)) if (!cfg.accounts.includes(k)) delete s.exhausted[k];
  return s;
}

const minutes = (m, d) => (m ?? d) * 60_000;

export function availableAt(state, cfg, account) {
  const t = state.exhausted[account];
  return t ? Date.parse(t) + minutes(cfg.quotaWindowMinutes, 300) : 0;
}

/** 从当前账号之后按配置顺序找第一个可用账号；没有则返回 null。 */
export function pickAvailable(state, cfg, nowMs) {
  const n = cfg.accounts.length;
  const start = Math.max(0, cfg.accounts.indexOf(state.active));
  for (let i = 1; i <= n; i++) {
    const a = cfg.accounts[(start + i) % n];
    if (a !== state.active && availableAt(state, cfg, a) <= nowMs) return a;
  }
  return null;
}

/**
 * 决策一次。
 * @param {{ quotaHit: boolean }} event quotaHit = 当前账号刚报额度错误
 * @returns {{ action: 'switch', to: string } | { action: 'stay', reason: string, nextAvailableAt?: number }}
 *   state 会被就地更新（耗尽记录、切换时间、当前账号）；调用方执行实际切换成功后再保存。
 */
export function decide(state, cfg, nowMs, { quotaHit }) {
  if (quotaHit) state.exhausted[state.active] = new Date(nowMs).toISOString();
  const activeExhausted = availableAt(state, cfg, state.active) > nowMs;
  if (!activeExhausted) return { action: 'stay', reason: '当前账号可用' };
  if (state.lastSwitchAt && nowMs - Date.parse(state.lastSwitchAt) < minutes(cfg.cooldownMinutes, 10)) {
    return { action: 'stay', reason: '冷却中' };
  }
  const to = pickAvailable(state, cfg, nowMs);
  if (!to) {
    const next = Math.min(...cfg.accounts.map((a) => availableAt(state, cfg, a)));
    return { action: 'stay', reason: '全部账号额度耗尽', nextAvailableAt: next };
  }
  return { action: 'switch', to };
}

export function commitSwitch(state, to, nowMs) {
  state.active = to;
  state.lastSwitchAt = new Date(nowMs).toISOString();
}
