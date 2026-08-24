/**
 * PDF 全文搜索 — 单页匹配纯函数。
 *
 * 文本拼接保留 item 边界：items 直接连接（hasEOL 处补换行折算为空格），
 * pdf.js 常把一个词拆进多个 item，join(' ') 会让 "im"+"portant" 永远搜不到
 * "important"。同时记录每个 item 的偏移，把命中区间映射回 item 内子区间，
 * 供 customTextRenderer 做页内 <mark> 高亮。
 *
 * 从 EnhancedPdfViewer 内联逻辑抽出（2026-08 搜索增量展示改造）：
 * 每扫完一个分块即可发布部分结果，无需等全书扫完。
 */

/** pdf.js getTextContent() 的最小 item 形状 */
export interface PdfTextItemLike {
  str?: string;
  hasEOL?: boolean;
}

/** 搜索命中落在某个文本 item 内的子区间 */
export interface SearchItemRange {
  /** item.str 内的起始偏移 */
  start: number;
  /** item.str 内的结束偏移（不含） */
  end: number;
  /** 该命中在本页内的序号 */
  matchOrdinal: number;
}

export interface PageSearchMatches {
  /** 本页命中次数 */
  matchCount: number;
  /** itemIndex -> 高亮区间列表（无命中时为空 Map） */
  itemRanges: Map<number, SearchItemRange[]>;
}

/**
 * 在一页的文本 items 中查找 query（调用方需先 toLowerCase + trim）。
 */
export function collectPageSearchMatches(
  items: PdfTextItemLike[],
  query: string,
): PageSearchMatches {
  const itemRanges = new Map<number, SearchItemRange[]>();
  if (!query) return { matchCount: 0, itemRanges };

  // 拼接页面文本并记录每个 item 的偏移
  const itemOffsets: { itemIndex: number; start: number; length: number }[] = [];
  let pageText = '';
  items.forEach((item, itemIdx) => {
    const str = typeof item.str === 'string' ? item.str : '';
    itemOffsets.push({ itemIndex: itemIdx, start: pageText.length, length: str.length });
    pageText += str;
    if (item.hasEOL) pageText += '\n';
  });
  // 换行折算为空格（等长替换，偏移不变）：让含空格的短语
  // 也能命中跨行文本（"foo bar" vs "foo\nbar"）
  const lowerText = pageText.toLowerCase().replace(/\n/g, ' ');

  let matchOrdinal = 0;
  let pos = lowerText.indexOf(query);
  while (pos !== -1) {
    // 命中区间 [pos, pos+len) 映射到覆盖的各 item
    const matchEnd = pos + query.length;
    for (const info of itemOffsets) {
      if (info.start >= matchEnd) break;
      const overlapStart = Math.max(pos, info.start);
      const overlapEnd = Math.min(matchEnd, info.start + info.length);
      if (overlapEnd <= overlapStart) continue;
      let ranges = itemRanges.get(info.itemIndex);
      if (!ranges) {
        ranges = [];
        itemRanges.set(info.itemIndex, ranges);
      }
      ranges.push({
        start: overlapStart - info.start,
        end: overlapEnd - info.start,
        matchOrdinal,
      });
    }

    matchOrdinal++;
    pos = lowerText.indexOf(query, pos + 1);
  }

  return { matchCount: matchOrdinal, itemRanges };
}
