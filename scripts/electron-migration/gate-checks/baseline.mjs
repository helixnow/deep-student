// 计数型基线：现存问题按键计数登记，超出计数的出现为新增（error），基线里多出的计数为过期（info）。
// keyOf(finding|entry) 决定哪些字段构成键；entryOf(finding) 给出写入基线的字段（不含 count/reason）。

export function applyCountBaseline(findings, baseline, keyOf) {
  const budget = new Map();
  for (const e of baseline.entries ?? []) budget.set(keyOf(e), (budget.get(keyOf(e)) ?? 0) + (e.count ?? 1));
  const fresh = [];
  const used = new Map();
  for (const f of findings) {
    const k = keyOf(f);
    const n = (used.get(k) ?? 0) + 1;
    used.set(k, n);
    if (n > (budget.get(k) ?? 0)) fresh.push({ ...f, severity: 'error' });
  }
  const stale = [];
  for (const e of baseline.entries ?? []) {
    const n = used.get(keyOf(e)) ?? 0;
    if (n < (e.count ?? 1)) stale.push({ ...e, present: n, severity: 'info' });
  }
  return { fresh, stale };
}

/** 按现状生成基线条目（保留已有 reason），按 sortKeys 依次排序。 */
export function countBaselineEntries(findings, previous, keyOf, entryOf, sortKeys) {
  const reasons = new Map((previous?.entries ?? []).map((e) => [keyOf(e), e.reason]));
  const grouped = new Map();
  for (const f of findings) {
    const k = keyOf(f);
    const e = grouped.get(k) ?? { ...entryOf(f), count: 0 };
    e.count += 1;
    if (reasons.get(k)) e.reason = reasons.get(k);
    grouped.set(k, e);
  }
  return [...grouped.values()].sort((a, b) => {
    for (const s of sortKeys) {
      const d = String(s(a) ?? '').localeCompare(String(s(b) ?? ''));
      if (d) return d;
    }
    return 0;
  });
}
