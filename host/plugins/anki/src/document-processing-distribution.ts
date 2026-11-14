/**
 * 全局 max_cards 在各分段间的加权分配与表格行覆盖保护。
 */
import { countOccurrences, rustLines } from './document-processing-text.ts';
import { detectTableHeader } from './document-processing-segment.ts';

export function distributeGlobalMaxCardsWeighted(total: number, weights: readonly number[]): number[] {
  const segments = weights.length;
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0 || segments === 0 || total <= segments || weightSum === 0) {
    return distributeGlobalMaxCards(total, segments);
  }
  const limits: number[] = new Array<number>(segments).fill(0);
  const remainders: Array<[number, number]> = [];
  let assigned = 0;
  for (let index = 0; index < segments; index += 1) {
    const weight = weights[index]!;
    const exact = total * weight;
    const quotient = Math.trunc(exact / weightSum);
    limits[index] = quotient;
    assigned += quotient;
    remainders.push([exact % weightSum, index]);
  }
  // 余数大的先补；同余数按段序（稳定）
  remainders.sort((left, right) => right[0] - left[0] || left[1] - right[1]);
  for (const [, index] of remainders.slice(0, total - assigned)) {
    limits[index] = limits[index]! + 1;
  }
  return limits;
}

/** 段内表格数据行数：≥2 个制表符的行，排除像表头的行。 */
export function countTableDataRows(segment: string): number {
  const lines = rustLines(segment).filter((line) => countOccurrences(line, '\t') >= 2);
  const header = detectTableHeader(lines);
  return lines.filter((line) => header === null || line !== header).length;
}

/**
 * 总配额足以「每个表格数据行至少一张」时，保证每段配额不低于其数据行数，
 * 多出的从富余最多的段扣回，总量不变。词表要求每词一张、总数恰等于词数时，
 * 加权取整误差会让某段少一张而漏词（60 词漏 precede）。
 */
export function ensureRowCoverage(limits: readonly number[], rows: readonly number[]): number[] {
  const result = [...limits];
  const total = result.reduce((sum, value) => sum + value, 0);
  const rowSum = rows.reduce((sum, value) => sum + value, 0);
  if (rowSum === 0 || total < rowSum || rows.length !== result.length) {
    return result;
  }
  let deficit = 0;
  for (let index = 0; index < result.length; index += 1) {
    const row = rows[index]!;
    if (result[index]! < row) {
      deficit += row - result[index]!;
      result[index] = row;
    }
  }
  while (deficit > 0) {
    // `max_by_key` 在同值时返回最后一个，因此这里用 >= 取靠后的段。
    let donor = -1;
    let best = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < result.length; index += 1) {
      const slack = result[index]! - rows[index]!;
      if (result[index]! > rows[index]! && slack >= best) {
        best = slack;
        donor = index;
      }
    }
    if (donor < 0) break;
    result[donor] = result[donor]! - 1;
    deficit -= 1;
  }
  return result;
}

export function distributeGlobalMaxCards(total: number, segments: number): number[] {
  if (segments === 0) {
    return [];
  }
  if (total <= 0) {
    return new Array<number>(segments).fill(0);
  }
  const limits: number[] = new Array<number>(segments).fill(0);

  if (total <= segments) {
    // 等距抽样；只有 1 张时取中段作为折中，避免永远只取开头
    for (let slot = 0; slot < total; slot += 1) {
      const index =
        total === 1 ? Math.trunc(segments / 2) : Math.trunc((slot * (segments - 1)) / (total - 1));
      limits[index] = limits[index]! + 1;
    }
    return limits;
  }

  const base = Math.trunc(total / segments);
  const remainder = total % segments;
  for (let index = 0; index < segments; index += 1) {
    limits[index] = base;
  }
  // 余数按等距位置分配（r == 0 落在首段，r == remainder-1 落在末段附近）
  for (let r = 0; r < remainder; r += 1) {
    const index = Math.trunc((r * segments) / remainder);
    limits[index] = limits[index]! + 1;
  }
  return limits;
}

