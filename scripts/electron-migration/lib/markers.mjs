// 生成区块标记：`<!-- BEGIN GENERATED:<key> -->` … `<!-- END GENERATED:<key> -->`。
// 区块之外的内容是人写的，`--refresh` 只替换区块内部，永不删除人写内容。

export const begin = (key) => `<!-- BEGIN GENERATED:${key} -->`;
export const end = (key) => `<!-- END GENERATED:${key} -->`;

export function block(key, body) {
  return `${begin(key)}\n${body.replace(/\n+$/, '')}\n${end(key)}`;
}

const BLOCK_RE = /<!-- BEGIN GENERATED:([^\s>]+) -->\n?([\s\S]*?)\n?<!-- END GENERATED:\1 -->/g;

/** 解析文档中的全部生成区块：Map key → { start, end, inner }。 */
export function parseBlocks(text) {
  const out = new Map();
  for (const m of text.matchAll(BLOCK_RE)) out.set(m[1], { start: m.index, end: m.index + m[0].length, inner: m[2] });
  return out;
}

/** 区块所在 section 的起点：紧邻区块之前（只隔空白）的标题行；没有标题则为区块本身。floor 之前不回溯。 */
function sectionStart(text, blockStart, floor) {
  const before = text.slice(floor, blockStart);
  const m = /(^|\n)(#{1,6} [^\n]*\n\s*)$/.exec(before);
  return m ? floor + m.index + m[1].length : blockStart;
}

/**
 * 把新渲染的单元合并进旧文档。
 * units: [{ key, text }]，每个 text 恰含一个 key 对应的生成区块（可带前置标题与人写模板）。
 * - 旧文档已有该区块：只替换区块内部；
 * - 旧文档没有：把整个单元插到下一个已存在单元的 section 起点之前，没有则追加到末尾；
 * - 旧文档中有、新单元中没有的区块：保留原样，计入 orphaned。
 * 返回 { text, added, updated, orphaned }。
 */
export function mergeUnits(oldText, units) {
  let text = oldText;
  let added = 0;
  let updated = 0;
  const newKeys = new Set(units.map((u) => u.key));
  // 先替换已有区块（从后往前，避免偏移失效）。
  const blocks = parseBlocks(text);
  const replacements = [];
  for (const u of units) {
    const old = blocks.get(u.key);
    if (!old) continue;
    const fresh = parseBlocks(u.text).get(u.key);
    if (!fresh) throw new Error(`unit ${u.key} has no generated block`);
    if (fresh.inner !== old.inner) {
      replacements.push({ start: old.start, end: old.end, value: block(u.key, fresh.inner) });
      updated++;
    }
  }
  replacements.sort((a, b) => b.start - a.start);
  for (const r of replacements) text = text.slice(0, r.start) + r.value + text.slice(r.end);
  // 再插入新单元。
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const cur = parseBlocks(text);
    if (cur.has(u.key)) continue;
    let at = text.length;
    for (let j = i + 1; j < units.length; j++) {
      const b = cur.get(units[j].key);
      if (b) {
        const prevEnd = Math.max(0, ...[...cur.values()].filter((x) => x.end <= b.start).map((x) => x.end));
        at = sectionStart(text, b.start, prevEnd);
        break;
      }
    }
    const insert = at === text.length ? `${text.endsWith('\n') ? '' : '\n'}\n${u.text.replace(/\n+$/, '')}\n` : `${u.text.replace(/\n+$/, '')}\n\n`;
    text = text.slice(0, at) + insert + text.slice(at);
    added++;
  }
  const orphaned = [...parseBlocks(text).keys()].filter((k) => !newKeys.has(k));
  return { text, added, updated, orphaned };
}
