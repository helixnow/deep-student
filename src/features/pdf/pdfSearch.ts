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
 *
 * 另含 `createSearchProgressThrottle`（r4）：进度数字的发布节流，
 * 见其注释；viewer 侧接线为后续项。
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

// ─── 搜索进度节流（2026-08 r4，viewer 待接线）────────────────────────

export interface SearchProgress {
  /** 已扫描页数 */
  scanned: number;
  /** 总页数 */
  total: number;
}

export interface SearchProgressThrottle {
  /**
   * 每扫完一个分块调用一次。首个分块与末个分块（scanned >= total）
   * 立即发布，其余每 everyNChunks 个分块发布一次。
   */
  report: (progress: SearchProgress) => void;
  /** 强制发布最近一次被抑制的进度（一次性；无待发进度则 no-op）。 */
  flush: () => void;
}

/**
 * 进度发布节流：EnhancedPdfViewer 的搜索按 2 页一个分块扫描，
 * `publishPartial` 目前每个分块都 `setSearchProgress`（约 1087-1088 行），
 * 大文档一次搜索触发数百次仅为进度数字的重渲染。本 helper 把发布频率
 * 降为每 N 个分块一次（默认 5，即约每 10 页刷新一次进度），同时保证：
 *
 * - 首个分块立即发布——进度条不空窗；
 * - 末个分块（scanned >= total）立即发布——终值不丢；
 * - 提前退出路径（出错/取消后仍想展示已扫进度）可调 flush() 补发。
 *
 * 注意本 helper 只管进度数字：命中结果的增量发布（setSearchResults 等）
 * 不受影响，首个命中仍应即时跳转。本卡不改 viewer；接线时在
 * handleSearch 建立 task 处创建实例，将 publishPartial 内的
 * setSearchProgress 换成 throttle.report，错误分支前调 flush。
 */
export function createSearchProgressThrottle(
  publish: (progress: SearchProgress) => void,
  everyNChunks = 5,
): SearchProgressThrottle {
  const interval = Math.max(1, Math.floor(everyNChunks));
  let chunkCount = 0;
  let pending: SearchProgress | null = null;

  return {
    report(progress: SearchProgress) {
      chunkCount++;
      const isFinal = progress.total > 0 && progress.scanned >= progress.total;
      if (chunkCount === 1 || isFinal || chunkCount % interval === 0) {
        pending = null;
        publish(progress);
        return;
      }
      pending = progress;
    },
    flush() {
      if (!pending) return;
      const progress = pending;
      pending = null;
      publish(progress);
    },
  };
}
