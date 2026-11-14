// REPORT.md renderer for serde-audit results.

export const TYPE_LABEL = { f64: 'f64 整数 `.0`', none: 'None（null/省略）', 'key-order': '键序', precision: '精度（f32/u64）', other: '其他' };
const TYPES = Object.keys(TYPE_LABEL);
const CONF_RANK = { high: 3, medium: 2, low: 1 };

export const FIX = {
  f64: {
    db: '`toRustJson(v, rs.struct({ x: rs.f64 }))`；手工拼对象时 `f64Atom(x)`；`json!`/Value 列用 `rs.valueObject({ x: rs.f64 }, { rest })`',
    ipc: 'IPC 不可见（前端 `JSON.parse` 后同值），无需修',
  },
  precision: {
    db: 'f32 字段 `rs.f32` / `f32Atom(x)`（binary32 最短往返）；u64 传 bigint + `rs.u64`',
    ipc: '`toRustValue(v, fromContractSchema(result, …))`（f32 投影为 `Math.fround` 后的最短十进制）或 `formatF32`',
  },
  none: {
    db: '`rs.field(rs.option(T), { skipIf: \'none\' })`（Rust 省略）/ `rs.option(T)`（Rust 写 null）',
    ipc: '`toRustValue(v, fromContractSchema(result, …))`：按 `x-option` 省略或写 null',
  },
  'key-order': {
    db: '`rs.struct` 按 Rust 字段声明序；BTreeMap → `rs.btreeMap`；IndexMap/Value → `rs.indexMap` / `rs.valueObject`；HashMap 无法逐字节对齐 → 比较器 N-009',
    ipc: '`toRustValue`（同 struct 序）；前端一般不依赖键序',
  },
  other: {
    db: 'chrono → `rs.dateTimeUtc`；enum → `rs.enum(…, { tag, content, untagged })`；pretty → `toRustJson(v, s, { pretty: true })`；未解析 → 先人工确认 Rust 类型再用 `rs.*` 描述',
    ipc: 'date-time → `rs.dateTimeUtc`（`toRustValue`）',
  },
};

/** Short per-class fix for the top-10 table. */
export const FIX_SHORT = {
  f64: { db: '`toRustJson` + `rs.f64`（或 `f64Atom`）', ipc: '—' },
  precision: { db: '`rs.f32` / `f32Atom`', ipc: '`toRustValue` + `fromContractSchema`' },
  none: { db: '`rs.option` / `rs.field(…, { skipIf: \'none\' })`', ipc: '`toRustValue` + `fromContractSchema`' },
  'key-order': { db: '`rs.struct` 声明序', ipc: '`toRustValue`' },
  other: { db: '`rs.dateTimeUtc` / `rs.enum` / `{ pretty: true }`', ipc: '`rs.dateTimeUtc`' },
};
const isHashOrder = (d) => d.type === 'key-order' && /^HashMap /.test(d.detail);

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const code = (s) => (s ? `\`${esc(s)}\`` : '—');
const maxConf = (ds) => ds.reduce((m, d) => (CONF_RANK[d.confidence] > CONF_RANK[m] ? d.confidence : m), 'low');
const hashmapOnly = (ds) => ds.length > 0 && ds.every((d) => d.type === 'key-order' && /^HashMap /.test(d.detail));

/** Groups entries per (kind, site) for prioritisation. */
export function prioritize(entries) {
  const groups = new Map();
  for (const e of entries) {
    if (!e.decisions.length) continue;
    const key = `${e.kind}|${e.site}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { kind: e.kind, site: e.site, plugins: new Set(), hosts: [], rust: e.rust, rustType: e.rustType, g3: 0, types: new Map(), fixG3: new Map(), decisions: [] });
    g.plugins.add(e.plugin);
    if (e.host && !g.hosts.includes(e.host)) g.hosts.push(e.host);
    g.g3 = Math.max(g.g3, e.g3);
    for (const d of e.decisions) {
      g.decisions.push(d);
      const t = g.types.get(d.type) ?? { g3: 0, conf: 'low', hashOnly: true };
      t.g3 = Math.max(t.g3, d.g3);
      t.hashOnly &&= isHashOrder(d);
      if (CONF_RANK[d.confidence] > CONF_RANK[t.conf]) t.conf = d.confidence;
      g.types.set(d.type, t);
      if (!isHashOrder(d) && !(e.kind === 'ipc' && d.type === 'f64')) g.fixG3.set(d.type, Math.max(g.fixG3.get(d.type) ?? 0, d.g3));
    }
  }
  const list = [...groups.values()].map((g) => {
    const fixable = !hashmapOnly(g.decisions) && !(g.kind === 'ipc' && [...g.types.keys()].every((t) => t === 'f64'));
    const g3Confirmed = [...g.types.values()].reduce((s, t) => s + t.g3, 0);
    const fixableG3 = [...g.fixG3.values()].reduce((s, n) => s + n, 0);
    const score = (fixable ? 1e7 : 0) + (fixableG3 > 0 ? 1e6 + fixableG3 * 1e3 + Math.min(g.g3, 999) : 0) + CONF_RANK[maxConf(g.decisions)] * 100 + (g.kind === 'db' ? 50 : 0) + Math.min(g.hosts.length, 20);
    return { ...g, plugins: [...g.plugins], fixable, g3Confirmed, fixableG3, score };
  });
  return list.sort((a, b) => b.score - a.score || a.site.localeCompare(b.site));
}

export function stats(entries) {
  const withDiff = entries.filter((e) => e.decisions.length);
  const byType = Object.fromEntries(TYPES.map((t) => [t, { entries: 0, high: 0, medium: 0, low: 0, auto: 0, manual: 0, g3: 0, db: 0, ipc: 0 }]));
  const byPlugin = new Map();
  for (const e of withDiff) {
    const p = byPlugin.get(e.plugin) ?? { db: 0, ipc: 0, types: Object.fromEntries(TYPES.map((t) => [t, 0])), g3: 0, manual: 0 };
    p[e.kind]++;
    p.g3 = Math.max(p.g3, 0) + (e.g3 && !p[`seen:${e.site}`] ? e.g3 : 0);
    p[`seen:${e.site}`] = true;
    for (const d of e.decisions) {
      const s = byType[d.type];
      s.entries++; s[d.confidence]++; s[d.decision === '自动判定' ? 'auto' : 'manual']++; s[e.kind]++;
      if (d.g3) s.g3++;
      p.types[d.type]++;
      if (d.decision !== '自动判定') p.manual++;
    }
    byPlugin.set(e.plugin, p);
  }
  return { withDiff: withDiff.length, byType, byPlugin };
}

export function renderReport(result) {
  const { meta, entries, g3, rustOnly } = result;
  const { withDiff, byType, byPlugin } = stats(entries);
  const ranked = prioritize(entries);
  const L = [];
  L.push('# serde 表示差异审计（宿主 DB 写入 + IPC 返回值 vs Rust）', '');
  L.push(`> 生成：\`node scripts/serde-audit/audit.mjs ${meta.triage ? `<${meta.triage.file}>` : ''}\`（HEAD \`${meta.head}\`）。完整条目见同目录 \`audit.json\`。`, '');
  L.push('## 输入与范围', '');
  L.push(`- Rust：${meta.rustFiles} 个 .rs（\`src-tauri/src\`、\`src-tauri/crates\`，不含测试），${meta.rustTypes} 个 Serialize 类型；serde_json 写库 ${meta.rustJsonWrites} 处，覆盖 ${meta.rustJsonColumns} 个表列。`);
  L.push(`- 宿主：${meta.hostFiles} 个非测试 .ts，SQL 写语句绑定参数 ${meta.hostSqlBindings} 个（INSERT/UPDATE/UPSERT 列级映射）。`);
  L.push(`- IPC：${meta.contracts} 份 \`contracts/ipc/*.json\`，${meta.commands} 个有返回值的命令。`);
  if (meta.triage) L.push(`- G3：\`${meta.triage.file}\`（sha256 \`${meta.triage.sha256.slice(0, 12)}…\`，${meta.triage.groups} 组，${meta.triage.at}）。DB 文本逐字节比较；IPC 比较器按值比较、忽略键序，只暴露 None 与数值精度。`);
  L.push('');
  L.push('## 方法与置信度', '');
  L.push('1. **宿主**：TypeScript AST 找 `db.run/get/all/…`（含 `prepare(sql).run`）的写语句，按 `?N`/`$name` 把参数映射到列；对参数表达式回溯 JSON 来源（局部变量、`??`/三元、辅助函数返回值、唯一命名函数的形参 → 全部调用点）。来源为 `JSON.stringify` 即“裸写”；`toRustJson` 等视为已对齐。');
  L.push('2. **Rust**：tree-sitter 扫 Serialize 类型（字段声明序、`rename_all`/`rename`、`skip_serializing_if`、`flatten`、f64/f32/Option/HashMap/BTreeMap/u64/chrono/enum 标记，递归展开）；扫 SQL 字面量 → `params![…]`/命名参数 → `serde_json::to_string(&x)`/`json!`/`Value::to_string`，再解析 `x` 的静态类型（`let x: T`、形参、构造器、字段访问、函数返回类型）。');
  L.push('3. **G3**：`lib/classify.mjs` 对每个 A(Rust)/B(宿主) 文本差异分类（`f64-integer`、`f32-precision`、`none-null-vs-omit`、`skip-default`、`key-order`、`time-format`…），按表列/命令汇总。');
  L.push('4. **判定**（`lib/decide.mjs`）：`high` = G3 已复现，或静态可证（对象字面量键序 ≠ Rust 声明序、字面量缺 Option(null) 键或给 skip 字段写 null、pretty 不一致）；`medium` = Rust 类型已解析且宿主裸写；`low` = 来源/类型未解析或只在大数值时出现。`自动判定` 之外均标 **需人工核对**。');
  L.push('');

  L.push('## 统计', '');
  L.push(`有差异的条目 ${withDiff} 个（DB ${entries.filter((e) => e.kind === 'db' && e.decisions.length).length}，IPC ${entries.filter((e) => e.kind === 'ipc' && e.decisions.length).length}）；按 (类型, 表列/命令) 合并后 ${ranked.length} 处，其中 G3 已复现 ${ranked.filter((g) => g.g3Confirmed > 0).length} 处。`, '');
  L.push('### 按差异类型', '');
  L.push('| 差异类型 | 判定数 | DB | IPC | high | medium | low | 自动判定 | 需人工核对 | G3 复现 |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const t of TYPES) {
    const s = byType[t];
    L.push(`| ${TYPE_LABEL[t]} | ${s.entries} | ${s.db} | ${s.ipc} | ${s.high} | ${s.medium} | ${s.low} | ${s.auto} | ${s.manual} | ${s.g3} |`);
  }
  L.push('', '### 按插件', '');
  L.push('| 插件 | DB 条目 | IPC 条目 | f64 | None | 键序 | 精度 | 其他 | 需人工核对 | G3 次数 |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const [plugin, p] of [...byPlugin].sort((a, b) => b[1].g3 - a[1].g3 || (b[1].db + b[1].ipc) - (a[1].db + a[1].ipc) || a[0].localeCompare(b[0]))) {
    L.push(`| ${esc(plugin)} | ${p.db} | ${p.ipc} | ${p.types.f64} | ${p.types.none} | ${p.types['key-order']} | ${p.types.precision} | ${p.types.other} | ${p.manual} | ${p.g3} |`);
  }
  L.push('');

  L.push('## G3 已复现的 serde 差异', '');
  L.push('| 位置 | G3 次数 | 差异（路径，A=Rust → B=宿主） |', '|---|---:|---|');
  const g3rows = [...g3.columns.map((c) => ({ ...c, label: `DB ${c.db}:${c.site}` })), ...g3.commands.map((c) => ({ ...c, label: `IPC ${c.site}` }))].sort((a, b) => b.occurrences - a.occurrences);
  for (const c of g3rows) {
    const fs = c.findings.slice(0, 4).map((f) => `${f.tag}${f.direction ? `/${f.direction}` : ''} \`${esc(f.path)}\`×${f.count}${f.a !== undefined ? ` (${esc(JSON.stringify(f.a)).slice(0, 40)} → ${esc(JSON.stringify(f.b)).slice(0, 40)})` : ''}`);
    L.push(`| ${esc(c.label)} | ${c.occurrences} | ${fs.join('；')} |`);
  }
  L.push('');

  L.push('## 第二阶段修复指南', '');
  L.push('排序：可由宿主修复 > G3 已复现（按出现次数）> 置信度 > DB 优先于 IPC（DB 文本持久化并参与同步/备份比对，用户影响更大）。', '');
  L.push('### 前 10 个最值得修的点', '');
  L.push('“G3 可修复差异数”= 宿主可修的差异在 G3 中的出现次数（HashMap 键序不计）；“G3 次数”= 该列/命令所在差异组的总出现次数。', '');
  L.push('| # | 位置 | 插件 | 差异类型（G3 可修复差异数） | G3 次数 | 宿主位置 | Rust 位置 | 修复工具 |', '|---:|---|---|---|---:|---|---|---|');
  ranked.filter((g) => g.fixable).slice(0, 10).forEach((g, i) => {
    const types = [...g.types.entries()].filter(([t]) => !(g.kind === 'ipc' && t === 'f64'));
    const label = types.map(([t, info]) => `${TYPE_LABEL[t]}${info.hashOnly ? '（HashMap，交 N-009）' : g.fixG3.get(t) ? `（${g.fixG3.get(t)}）` : ''}`).join('、');
    const fix = types.filter(([, info]) => !info.hashOnly).map(([t]) => FIX_SHORT[t][g.kind]).filter((x, k, a) => x !== '—' && a.indexOf(x) === k).join('；');
    L.push(`| ${i + 1} | ${g.kind === 'db' ? 'DB' : 'IPC'} ${code(g.site)} | ${esc(g.plugins.join(', '))} | ${label} | ${g.g3} | ${g.hosts.slice(0, 2).map(code).join('<br>')}${g.hosts.length > 2 ? `<br>(+${g.hosts.length - 2})` : ''} | ${code(g.rust)} | ${fix} |`);
  });
  L.push('', '### 工具函数对照', '');
  L.push('| 差异类型 | DB 写入 | IPC 返回值 |', '|---|---|---|');
  for (const t of TYPES) L.push(`| ${TYPE_LABEL[t]} | ${FIX[t].db} | ${FIX[t].ipc} |`);
  L.push('', '通用做法：在插件 repository 层为该列定义一次 schema（`rs.struct` 手写并在注释引用 Rust 结构体 file:line，或 `fromContractSchema` 取序列化形状契约），把 `JSON.stringify(x)` 换成 `toRustJson(x, Schema)`；IPC 在 handler 返回前 `toRustValue(x, Schema)`。反序列化形状契约（`X__De`、只作参数的类型）会被 `fromContractSchema` 拒绝，须手写。', '');
  L.push('### 按插件的修复顺序', '');
  const perPlugin = new Map();
  for (const g of ranked) for (const p of g.plugins) (perPlugin.get(p) ?? perPlugin.set(p, []).get(p)).push(g);
  const pluginOrder = [...perPlugin].sort((a, b) => b[1][0].score - a[1][0].score);
  for (const [plugin, gs] of pluginOrder) {
    const fixable = gs.filter((g) => g.fixable);
    if (!fixable.length) continue;
    L.push(`- **${esc(plugin)}**：${fixable.slice(0, 6).map((g) => `${g.kind === 'db' ? '' : 'IPC '}\`${esc(g.site)}\`（${[...g.types.keys()].filter((t) => !(g.kind === 'ipc' && t === 'f64')).map((t) => TYPE_LABEL[t]).join('、')}${g.g3Confirmed ? `；G3 ${g.g3}` : ''}）`).join('；')}${fixable.length > 6 ? `；另 ${fixable.length - 6} 处见明细` : ''}。`);
  }
  const notFixable = ranked.filter((g) => !g.fixable && g.g3Confirmed);
  if (notFixable.length) {
    L.push('', '宿主无法逐字节对齐（Rust 侧 HashMap 键序随进程随机）、应由比较器归一化（N-009）处理的 G3 差异：');
    for (const g of notFixable) L.push(`- \`${esc(g.site)}\`（G3 ${g.g3}；Rust ${code(g.rust)}，类型 ${code(g.rustType)}）`);
  }
  L.push('');

  L.push('## 逐插件明细', '');
  const byPluginEntries = new Map();
  for (const e of entries.filter((x) => x.decisions.length)) (byPluginEntries.get(e.plugin) ?? byPluginEntries.set(e.plugin, []).get(e.plugin)).push(e);
  for (const [plugin, es] of [...byPluginEntries].sort((a, b) => a[0].localeCompare(b[0]))) {
    L.push(`### ${esc(plugin)}`, '');
    L.push('| 位置 | 宿主 file:line | Rust file:line（类型） | 差异类型 | 置信度 | 判定 | G3 | 说明 |', '|---|---|---|---|---|---|---:|---|');
    es.sort((a, b) => b.g3 - a.g3 || a.site.localeCompare(b.site) || String(a.host).localeCompare(String(b.host)));
    for (const e of es) {
      for (const d of e.decisions) {
        const rust = e.rust ? `${code(e.rust)}${e.rustType ? `<br>${code(e.rustType)}${e.rustTypeRef ? ` @ ${code(e.rustTypeRef)}` : ''}` : ''}` : '—';
        L.push(`| ${e.kind === 'db' ? 'DB' : 'IPC'} ${code(e.site)} | ${code(e.host)} | ${rust} | ${TYPE_LABEL[d.type]} | ${d.confidence} | ${d.decision} | ${d.g3 || ''} | ${esc(d.detail)} |`);
      }
    }
    L.push('');
  }

  if (result.hashInputs?.length) {
    L.push('## 附：进入哈希/指纹的 JSON.stringify（G3 不可见）', '');
    L.push('指纹、幂等键、内容哈希若要与 Rust 一致，哈希输入必须与 Rust `serde_json::to_string/to_vec` 逐字节相同（f64 `.0`、键序、None 省略都会改变哈希；已知例：qbank `batch_import` 幂等键）。全部需人工核对对应 Rust 实现；对齐方式同 DB 写入（`toRustJson(x, Schema)` 后再哈希）。', '');
    L.push('| 插件 | 宿主 file:line | 函数 | 哈希调用 | 输入 |', '|---|---|---|---|---|');
    for (const h of [...result.hashInputs].sort((a, b) => a.plugin.localeCompare(b.plugin) || a.file.localeCompare(b.file) || a.line - b.line)) {
      L.push(`| ${esc(h.plugin)} | ${code(`${h.file}:${h.line}`)} | ${code(h.fn)} | ${code(h.hash)} | ${code(h.arg)} |`);
    }
    L.push('');
  }

  L.push('## 附：只有 Rust 写入、宿主未定位到写入的 JSON 列', '');
  L.push('宿主可能尚未实现、用动态 SQL，或经未能静态回溯的封装写入；均需人工核对。', '');
  L.push('| 表列 | Rust file:line | Rust 类型 | Rust 写入处 | G3 |', '|---|---|---|---:|---:|');
  for (const r of rustOnly.sort((a, b) => b.g3 - a.g3 || a.site.localeCompare(b.site))) L.push(`| ${code(r.site)} | ${code(r.rust)} | ${code(r.rustType)} | ${r.writes} | ${r.g3 || ''} |`);
  L.push('');
  return `${L.join('\n')}\n`;
}
