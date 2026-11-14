/**
 * `dstu-vision/src/cross_page_merger.rs` — Stage 3: 跨页题目检测与合并。
 * `None` 页（VLM 分析失败）被跳过；续接必须落在相邻页（或同页）。
 */
import type { MergedQuestion, VlmFigure, VlmPageAnalysis, VlmQuestion } from '../api.ts';

export type { MergedQuestion };

export interface MergerLog {
  debug(message: string): void;
  info(message: string): void;
}

const cloneFigure = (f: VlmFigure): VlmFigure => ({ bbox: [...f.bbox], fig_label: f.fig_label });
const cloneQuestion = (q: VlmQuestion): VlmQuestion => ({
  ...q, bbox: [...q.bbox], sub_questions: [...q.sub_questions], figures: q.figures.map(cloneFigure),
});

/** `merge_pages`. */
export function mergePages(pageAnalyses: ReadonlyArray<VlmPageAnalysis | null>, log: MergerLog): MergedQuestion[] {
  const result: MergedQuestion[] = [];

  pageAnalyses.forEach((analysis, pageIdx) => {
    if (analysis === null) return;
    for (const question of analysis.questions) {
      const last = result.at(-1);
      const lastPage = last?.page_indices.at(-1);
      // usize 减法：last_page 永远 <= page_idx。
      const canMerge = question.continues_from_previous && lastPage !== undefined && pageIdx - lastPage <= 1;

      if (question.continues_from_previous && !canMerge) {
        log.debug(`[CrossPageMerger] 页面 ${pageIdx + 1} 题目 '${question.label}' 标记续接但上一题不在相邻页，按独立题目处理`);
      }

      if (canMerge) {
        const target = last!;
        log.debug(`[CrossPageMerger] 页面 ${pageIdx + 1} 题目 '${question.label}' 续接上一页题目 '${target.question.label}'`);
        if (question.raw_text !== '') {
          target.question.raw_text += `\n${question.raw_text}`;
        }
        if (target.page_indices.at(-1) !== pageIdx) target.page_indices.push(pageIdx);
        for (const fig of question.figures) {
          target.figures_with_page.push([pageIdx, cloneFigure(fig)]);
          target.question.figures.push(cloneFigure(fig));
        }
        target.question.continues_to_next = question.continues_to_next;
      } else {
        result.push({
          question: cloneQuestion(question),
          page_indices: [pageIdx],
          figures_with_page: question.figures.map(f => [pageIdx, cloneFigure(f)]),
        });
      }
    }
  });

  const crossPageCount = result.filter(q => q.page_indices.length > 1).length;
  if (crossPageCount > 0) {
    log.info(`[CrossPageMerger] 合并完成: ${result.length} 道题目, 其中 ${crossPageCount} 道跨页`);
  } else {
    log.info(`[CrossPageMerger] 合并完成: ${result.length} 道题目, 无跨页`);
  }
  return result;
}
