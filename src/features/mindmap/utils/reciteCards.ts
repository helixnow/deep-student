/**
 * 背诵 → 闪卡：本次背诵里单独翻开过（= 没背出来）的空，做成可进 FSRS 复习的问答卡。
 *
 * 导图背诵本身只按错误率排难点，没有间隔调度；背不出的要点转成卡片，才能进「今日待复习」。
 * 卡面：上级主题路径作提示 + 本节点原文（没背出的区间换成空位）；卡背：节点原文。
 */
import type { MindMapNode } from '../types';
import { mergeRanges, validateRanges } from './node/blankRanges';
import type { ReciteSessionLog } from './reciteStats';

export interface ReciteMissCard {
  nodeId: string;
  front: string;
  back: string;
}

const BLANK_MARK = '［　？　］';
const PATH_SEPARATOR = ' › ';

/** 遍历导图，按文档顺序收集本次没背出来的节点（同一节点多个空合成一张卡）。 */
export function buildReciteMissCards(root: MindMapNode, session: ReciteSessionLog): ReciteMissCard[] {
  const cards: ReciteMissCard[] = [];
  const walk = (node: MindMapNode, path: string[]) => {
    const events = session[node.id];
    const text = node.text ?? '';
    if (events && node.blankedRanges?.length && text) {
      const ranges = mergeRanges(validateRanges(node.blankedRanges, text.length));
      const missed = ranges.filter((_range, index) => events[index]?.missed === true);
      if (missed.length > 0) {
        let masked = '';
        let cursor = 0;
        for (const range of missed) {
          masked += text.slice(cursor, range.start) + BLANK_MARK;
          cursor = range.end;
        }
        masked += text.slice(cursor);
        const context = path.filter(Boolean).join(PATH_SEPARATOR);
        cards.push({
          nodeId: node.id,
          front: context ? `【${context}】${masked}` : masked,
          back: text,
        });
      }
    }
    const nextPath = [...path, text.trim()];
    for (const child of node.children ?? []) walk(child, nextPath);
  };
  walk(root, []);
  return cards;
}
