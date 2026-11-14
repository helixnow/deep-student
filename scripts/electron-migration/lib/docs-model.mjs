// TESTMAP / SPEC 文档的结构约定（scaffold 生成、ledger 读取，两边共用一份解析逻辑）。
import { parseBlocks } from './markers.mjs';

// ------------------------------------------------------------------ TESTMAP

/** 去向：pending | ported:<ts 路径> | merged:<目标> | obsolete:<理由>。 */
export const STATUS_RE = /^(pending|ported:\S.*|merged:\S.*|obsolete:\S.*)$/;

const ROW_RE = /^\| `([^`]+)` \| ([^|]*) \| ([^|]*) \| (.*) \|\s*$/;

export function escapeCell(s) {
  return String(s).replace(/\|/g, '\\|');
}

export function unescapeCell(s) {
  return String(s).replace(/\\\|/g, '|');
}

/** 从 TESTMAP 文本取出每行的去向（含区块外人写的行）。返回 Map id → status。 */
export function parseTestmapStatuses(text) {
  const out = new Map();
  for (const line of text.split('\n')) {
    const m = ROW_RE.exec(line);
    if (!m) continue;
    out.set(m[1], unescapeCell(m[4].trim()));
  }
  return out;
}

export function testmapTable(rows, statuses) {
  const lines = ['| Rust 测试 | 种类 | 位置 | 去向 |', '|---|---|---|---|'];
  for (const r of rows) {
    const status = statuses.get(r.id) ?? 'pending';
    lines.push(`| \`${r.id}\` | ${r.kind} | L${r.line} | ${escapeCell(status)} |`);
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ SPEC

export const SPEC_CHECKLIST = ['输入', '输出', '错误', '事件', 'DB 读写', '取消/并发', '时间/ID'];
export const EVENT_CHECKLIST = ['载荷', '触发时机与顺序', '节流/合并', '是否在事务提交后', '目标窗口（emit / emit_to / emit_filter）'];
export const GLOBAL_CHECKLIST = [
  'Option → null 还是缺省（`skip_serializing_if`）',
  'u64/i64 超过 2^53 的表示',
  '字段顺序（serde_json preserve_order）',
  'f32 精度',
  '错误形状（字符串 / 对象、文案、错误码）与 panic 的前端可见结果',
  '取消：CancellationToken / drop → AbortSignal，取消点一致',
  '并发：锁 / 单写者 / 队列在 Node 中的对应（await 交错）',
  '时间与 ID：生成方式、格式、时区',
  '不对含 HashMap 的结构做序列化后比对',
];

/**
 * 每个 SPEC 单元（生成区块之后、下一个区块或二级标题之前的人写部分）的清单完成度。
 * 返回 Map key → { checked, total }。清单项 = 以 `- [ ]` / `- [x]` 开头的行。
 */
export function parseSpecSections(text) {
  const blocks = [...parseBlocks(text).entries()].sort((a, b) => a[1].start - b[1].start);
  const out = new Map();
  for (let i = 0; i < blocks.length; i++) {
    const [key, b] = blocks[i];
    const nextStart = i + 1 < blocks.length ? blocks[i + 1][1].start : text.length;
    let tail = text.slice(b.end, nextStart);
    const h = tail.search(/\n#{1,2} /);
    if (h >= 0) tail = tail.slice(0, h);
    let checked = 0;
    let total = 0;
    for (const line of tail.split('\n')) {
      const m = /^\s*- \[( |x|X)\]/.exec(line);
      if (!m) continue;
      total++;
      if (m[1] !== ' ') checked++;
    }
    out.set(key, { checked, total });
  }
  return out;
}

export function checklist(items) {
  return items.map((x) => `- [ ] ${x}：`).join('\n');
}
