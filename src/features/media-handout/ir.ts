/**
 * 讲义中间表示（IR）：模型按节输出块级 JSON，渲染层（Markdown 笔记）只消费 Block[]。
 * 解析层做防御性清洗（编号剥离、Markdown 残留、时间戳换算），
 * 让模型只关心内容、渲染层只做排版，互不猜测。
 *
 * Ported from wangke-agent `src/handout/ir.ts`
 * (https://github.com/BA7MLV/wangke-agent).
 *
 * MIT License — Copyright (c) 2026 BA7MLV
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export type Block =
  | { type: 'lead'; text: string } // 节首主旨段
  | { type: 'para'; text: string } // 正文段
  | { type: 'h2'; text: string } // 小节标题（编号由渲染层决定）
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; caption?: string; header: string[]; rows: string[][] }
  | { type: 'figure'; ts: number; caption?: string } // 配图（ts 单位：秒）
  | { type: 'note'; text: string }; // 提示/注意

export interface SectionRange {
  startSec: number;
  endSec: number;
}

export interface HandoutSection {
  heading: string;
  /** 本节在媒体中的起点（秒），用于 `[媒体@id:mm:ss]` 锚点 */
  startSec: number;
  blocks: Block[];
}

/** 解析 mm:ss / h:mm:ss（容忍 `[mm:ss]` 包裹与小数秒）；非法返回 null */
export function parseClock(t: unknown): number | null {
  if (typeof t !== 'string') return null;
  const s = t.trim().replace(/^\[|\]$/g, '');
  const parts = s.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map((p) => (p.trim() === '' ? NaN : Number(p)));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const sec = nums.length === 3 ? nums[0] * 3600 + nums[1] * 60 + nums[2] : nums[0] * 60 + nums[1];
  return Math.floor(sec);
}

/** 秒 → mm:ss（≥ 1 小时为 h:mm:ss），与 `[媒体@…]` 引用格式一致 */
export function formatClock(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 清除文本值中的 Markdown 残留（模型偶发违规输出） */
function cleanInline(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

/** 剥离模型顺手写上的前置编号/符号，编号统一由渲染层生成 */
function stripLeadingMarker(text: string): string {
  return text
    .replace(/^[（(][一二三四五六七八九十]+[)）]\s*/, '')
    .replace(/^\d+[.、)]\s*/, '')
    .replace(/^[-*•●]\s*/, '')
    .trim();
}

function requireStringArray(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== 'string')) {
    throw new Error(`IR validation failed: ${what} must be a non-empty string array`);
  }
  return (v as string[]).map(cleanInline);
}

/** 从模型输出中稳健提取第一个 JSON 对象（容忍 ```json 围栏与前后废话） */
export function extractJsonObject<T = unknown>(raw: string): T {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('model did not return a JSON object');
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}

/**
 * 把模型原始输出解析为 Block[]。
 * 结构性错误（非 JSON / 未知块 / table 行列不齐 / 无有效块）抛错，供流水线重试一次；
 * 局部问题（figure 越界、空文本块）宽容丢弃，不值得为单点重试整节。
 */
export function parseSectionBlocks(raw: string, range: SectionRange): Block[] {
  const obj = extractJsonObject<{ blocks?: unknown }>(raw);
  if (!obj || !Array.isArray(obj.blocks)) throw new Error('IR validation failed: missing blocks array');

  const blocks: Block[] = [];
  for (const b of obj.blocks as Array<Record<string, unknown> | null>) {
    const text = cleanInline(b?.text);
    switch (b?.type) {
      case 'lead':
      case 'para':
      case 'note':
        if (text) blocks.push({ type: b.type, text });
        break;
      case 'h2': {
        const h = stripLeadingMarker(text);
        if (h) blocks.push({ type: 'h2', text: h });
        break;
      }
      case 'list': {
        const items = requireStringArray(b.items, 'list.items').map(stripLeadingMarker).filter(Boolean);
        if (items.length > 0) blocks.push({ type: 'list', ordered: b.ordered === true, items });
        break;
      }
      case 'table': {
        const header = requireStringArray(b.header, 'table.header');
        const rawRows = b.rows;
        if (!Array.isArray(rawRows) || rawRows.length === 0) {
          throw new Error('IR validation failed: table.rows is empty');
        }
        const rows = rawRows.map((r) => {
          const cells = requireStringArray(r, 'table.rows[]');
          if (cells.length !== header.length) {
            throw new Error(
              `IR validation failed: table row has ${cells.length} cells, header has ${header.length}`,
            );
          }
          return cells;
        });
        const caption = cleanInline(b.caption);
        blocks.push({ type: 'table', ...(caption ? { caption } : {}), header, rows });
        break;
      }
      case 'figure': {
        const ts = parseClock(b.time);
        if (ts === null) break; // 非法时间戳：丢弃
        if (ts < range.startSec || ts > range.endSec) break; // 越界：丢弃
        const caption = cleanInline(b.caption);
        blocks.push({ type: 'figure', ts, ...(caption ? { caption } : {}) });
        break;
      }
      default:
        throw new Error(`IR validation failed: unknown block type ${String(b?.type)}`);
    }
  }

  if (blocks.length === 0) throw new Error('IR validation failed: no valid blocks');
  return blocks;
}

/**
 * 两次解析失败后的兜底：模型若无视契约直接输出了纯文本，按行转 para 块保住内容；
 * 若输出是残缺 JSON 或空内容，退化为单段失败提示。任何情况下讲义生成不阻塞。
 */
export function salvageBlocks(raw: string, fallbackText: string): Block[] {
  const text = raw.trim();
  if (!text || text.includes('{')) {
    return [{ type: 'note', text: fallbackText }];
  }
  const paras = text
    .split('\n')
    .map((line) => cleanInline(line.replace(/^#{1,6}\s+/, '').replace(/^>\s?/, '')))
    .filter(Boolean);
  if (paras.length === 0) return [{ type: 'note', text: fallbackText }];
  return paras.map((t) => ({ type: 'para' as const, text: t }));
}

/** 收集所有节实际引用的配图时间戳（秒，去重，保持首次出现顺序），供高清重抽 */
export function collectFigureTimestamps(sections: Array<{ blocks: Block[] }>): number[] {
  const out: number[] = [];
  for (const s of sections) {
    for (const b of s.blocks) {
      if (b.type === 'figure' && !out.includes(b.ts)) out.push(b.ts);
    }
  }
  return out;
}
