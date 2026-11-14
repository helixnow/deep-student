// Per-site decisions: which difference types apply, with confidence and whether the decision
// is automatic (static proof or G3 evidence) or needs a human check.
//
// Report types: f64 (integral float written without `.0`), none (Option null vs omit),
// key-order, precision (f32 / u64 > 2^53), other (chrono, enum tagging, pretty, unresolved).

const AUTO = '自动判定';
const MANUAL = '需人工核对';

const g3Count = (g3, tags, pathRe) => {
  let n = 0;
  for (const tag of tags) for (const f of g3?.tags?.[tag] ?? []) if (!pathRe || pathRe.test(f.path)) n += f.count;
  return n;
};
const g3Paths = (g3, tags) => [...new Set(tags.flatMap((t) => (g3?.tags?.[t] ?? []).map((f) => f.path)))].slice(0, 3).map((p) => `\`${p}\``).join(", ");
const pathsText = (paths) => (paths ?? []).slice(0, 4).join(', ');
const literalNull = (v) => /(?:\?\?|\|\|)\s*null\s*$|^null$/.test(v.trim());

/**
 * @param source host JSON source {writer, keys?}
 * @param rust {how, features: Map|null, structOrder?: string[]} (null features = Rust type unresolved)
 * @param g3 {tags: {tag: [{path,count}]}, occurrences} | undefined
 */
export function decideDbSource(source, rust, g3) {
  if (source.writer.startsWith('safe:') || source.atoms) return [];
  if (source.writer === '?' && rust?.features) {
    return decideDbSource({ writer: 'JSON.stringify' }, rust, g3).map((d) => (d.g3 > 0 ? d : { ...d, confidence: 'low', decision: MANUAL, detail: `宿主来源未解析；${d.detail}` }));
  }
  const out = [];
  const push = (type, detail, confidence, decision, g3n = 0) => out.push({ type, detail, confidence: g3n > 0 ? 'high' : confidence, decision: g3n > 0 ? AUTO : decision, g3: g3n });
  const f = rust?.features;
  const g3f64 = g3Count(g3, ['f64-integer']);
  const g3prec = g3Count(g3, ['f32-precision', 'u64-precision', 'float-spelling']);
  const g3none = g3Count(g3, ['none-null-vs-omit', 'skip-default']);
  const g3order = g3Count(g3, ['key-order']);
  const g3time = g3Count(g3, ['time-format']);

  if (!f) {
    if (g3f64) push('f64', `G3：Rust 写 \`.0\`（${g3Paths(g3, ["f64-integer"])}）`, 'high', AUTO, g3f64);
    if (g3prec) push('precision', `G3：数值精度/拼写差（${g3Paths(g3, ["f32-precision", "u64-precision", "float-spelling"])}）`, 'high', AUTO, g3prec);
    if (g3none) push('none', `G3：null/省略差（${g3Paths(g3, ["none-null-vs-omit", "skip-default"])}）`, 'high', AUTO, g3none);
    if (g3order) push('key-order', `G3：键序差（${g3Paths(g3, ["key-order"])}）；Rust 值类型未静态解析，若该处为 HashMap 则交比较器 N-009`, 'high', AUTO, g3order);
    if (g3time) push('other', `G3：时间格式差（${g3Paths(g3, ["time-format"])}）`, 'high', AUTO, g3time);
    if (out.length === 0) push('other', `Rust 写入值类型未静态解析（${rust?.how ?? '无 Rust 写入'}）`, 'low', MANUAL);
    return out;
  }

  const floats = [...(f.get('f64') ?? []), ...(f.get('f32') ?? [])];
  if (floats.length || g3f64) push('f64', `浮点字段 ${floats.length ? pathsText(floats) : g3Paths(g3, ['f64-integer'])}：JSON.stringify 对整数值不写 \`.0\``, 'medium', MANUAL, g3f64);
  if (f.get('f32') || g3prec) push('precision', `f32 字段 ${f.get('f32') ? pathsText(f.get('f32')) : g3Paths(g3, ['f32-precision', 'u64-precision', 'float-spelling'])}：宿主须按 binary32 最短表示写出`, 'medium', MANUAL, g3prec);
  if (f.get('value') && !floats.length && !g3f64) push('f64', `serde_json::Value 字段 ${pathsText(f.get('value'))}：Rust 构造时的浮点值写 \`.0\``, 'low', MANUAL);

  const keys = source.keys?.filter((k) => k !== '...');
  const literal = keys && keys.length === source.keys.length;
  const nullFields = (f.get('option-null') ?? []).filter((p) => /^\.[^.[\]]+$/.test(p)).map((p) => p.slice(1));
  const omitFields = (f.get('option-omit') ?? []).filter((p) => /^\.[^.[\]]+$/.test(p)).map((p) => p.slice(1));
  if (literal && (f.get('struct') ?? []).includes('$')) {
    const missing = nullFields.filter((k) => !keys.some((x) => x.key === k));
    const nulled = keys.filter((k) => omitFields.includes(k.key) && literalNull(k.value)).map((k) => k.key);
    if (missing.length || nulled.length) {
      const parts = [];
      if (missing.length) parts.push(`Option 无 skip（Rust 写 null）但字面量缺键：${missing.join(', ')}`);
      if (nulled.length) parts.push(`skip_serializing_if = is_none（Rust 省略）但字面量写 null：${nulled.join(', ')}`);
      push('none', parts.join('；'), 'high', AUTO, g3none);
    } else if (g3none) push('none', `G3：null/省略差（${g3Paths(g3, ["none-null-vs-omit", "skip-default"])}）`, 'high', AUTO, g3none);
  } else if (nullFields.length || omitFields.length || g3none) {
    const parts = [];
    if (omitFields.length) parts.push(`Rust 省略 None：${omitFields.slice(0, 4).join(', ')}`);
    if (nullFields.length) parts.push(`Rust 写 null：${nullFields.slice(0, 4).join(', ')}`);
    push('none', parts.join('；') || 'G3：null/省略差', 'medium', MANUAL, g3none);
  }

  const hashPaths = (f.get('hashmap') ?? []).map((p) => (p === '$' ? '$' : `$${p}`));
  const inHash = { test: (p) => hashPaths.some((h) => p === h || (h !== '$' && p.startsWith(`${h}.`))) };
  const g3hash = g3Count(g3, ['key-order'], inHash);
  const g3struct = g3order - g3hash;
  if (hashPaths.length) {
    push('key-order', `HashMap ${pathsText(f.get('hashmap'))}：Rust 键序随 RandomState 不确定，宿主无法逐字节对齐（属比较器归一化 N-009）`, 'medium', AUTO, g3hash);
  }
  if (literal && rust.structOrder && (f.get('struct') ?? []).includes('$')) {
    const order = rust.structOrder.filter((k) => keys.some((x) => x.key === k));
    const given = keys.map((k) => k.key).filter((k) => rust.structOrder.includes(k));
    if (order.some((k, i) => given[i] !== k)) push('key-order', `字面量键序 ${given.join(',')} ≠ Rust 声明序 ${order.join(',')}`, 'high', AUTO, g3struct);
    else if (g3struct) push('key-order', `G3：嵌套结构体键序差（${g3Paths(g3, ["key-order"])}）`, 'high', AUTO, g3struct);
  } else if (g3struct || (!hashPaths.includes('$') && ((f.get('struct') ?? []).length || f.get('btreemap')))) {
    const why = f.get('btreemap') ? `BTreeMap ${pathsText(f.get('btreemap'))} 须按 UTF-8 键序` : g3struct ? `G3：键序差（${g3Paths(g3, ["key-order"])}）；非字面量构造，需确认对象构建顺序或该处是否为 HashMap` : '非字面量构造，键序取决于对象构建顺序';
    push('key-order', why, g3struct ? 'high' : 'low', MANUAL, g3struct);
  }

  if (f.get('bigint')) {
    const big = (f.get('bigint') ?? []).filter((p) => /hash|size|bytes|id$|_id|Id$|seq|offset|ns$|nanos/i.test(p));
    if (big.length) push('precision', `u64/i64 字段 ${pathsText(big)}：超过 2^53 时 number 失精度`, 'low', MANUAL);
  }
  if (f.get('chrono') || g3time) push('other', `chrono 时间 ${pathsText(f.get('chrono'))}：RFC 3339 AutoSi + Z`, 'medium', MANUAL, g3time);
  if (f.get('enum-repr')) push('other', `enum 标记 ${pathsText(f.get('enum-repr'))}（tag/content/untagged）`, 'low', MANUAL);
  if (rust.how === 'to_string_pretty' && source.writer !== 'JSON.stringify(pretty)') push('other', 'Rust to_string_pretty，宿主紧凑输出', 'high', AUTO);
  if (rust.how !== 'to_string_pretty' && source.writer === 'JSON.stringify(pretty)') push('other', 'Rust 紧凑输出，宿主 pretty', 'high', AUTO);
  return out;
}

/** IPC result features (from contracts) → difference types. `option-null` is caught by the debug contract check. */
export function decideIpc(features, g3) {
  const out = [];
  const push = (type, detail, confidence, g3n = 0) => out.push({ type, detail, confidence: g3n > 0 ? 'high' : confidence, decision: g3n > 0 ? AUTO : MANUAL, g3: g3n });
  const g3none = g3Count(g3, ['none-null-vs-omit', 'skip-default']);
  const g3prec = g3Count(g3, ['f32-precision', 'u64-precision']);
  const g3time = g3Count(g3, ['time-format']);
  if (features.get('option-omit') || g3none) push('none', `Rust 省略 None：${pathsText(features.get('option-omit'))}（宿主写 null 不被契约校验拦截）`, 'medium', g3none);
  if (features.get('f32') || g3prec) push('precision', `f32：${pathsText(features.get('f32'))}（宿主须返回 Math.fround 后的最短十进制值）`, 'medium', g3prec);
  if (features.get('chrono') || g3time) push('other', `date-time：${pathsText(features.get('chrono'))}`, 'low', g3time);
  return out;
}
