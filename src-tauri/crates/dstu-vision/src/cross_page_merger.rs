//! Stage 3: Cross-Page Merger — 跨页题目检测与合并
//!
//! 处理 VLM 逐页分析后的跨页题目续接问题：
//! - 检测 `continues_from_previous` / `continues_to_next` 标记
//! - 合并跨页题目的 raw_text 和 figures
//! - 记录每道题跨越的页面索引

use tracing::{debug, info};

use crate::vlm_grounding_service::{VlmFigure, VlmPageAnalysis, VlmQuestion};

/// 合并后的题目（可能跨越多个页面）
#[derive(Debug, Clone)]
pub struct MergedQuestion {
    /// 合并后的题目数据
    pub question: VlmQuestion,
    /// 此题跨越的页面索引列表（至少包含一个）
    pub page_indices: Vec<usize>,
    /// 所有配图及其来源页面索引
    pub figures_with_page: Vec<(usize, VlmFigure)>,
}

/// 将逐页 VLM 分析结果合并为完整题目列表
///
/// `page_analyses` 中 `None` 的页面会被跳过（VLM 分析失败的页面）。
pub fn merge_pages(page_analyses: &[Option<VlmPageAnalysis>]) -> Vec<MergedQuestion> {
    let mut result: Vec<MergedQuestion> = Vec::new();

    for (page_idx, analysis_opt) in page_analyses.iter().enumerate() {
        let analysis = match analysis_opt {
            Some(a) => a,
            None => continue,
        };

        for question in &analysis.questions {
            // ★ 2026-06-12（代理 3 审阅 F2）：续接必须落在相邻页面上。
            // 旧实现只要 result 非空就并入最后一题——若中间页 VLM 分析失败（None）
            // 或上一页没有解析出任何题目，会把续接文本错误地拼到隔页的无关题目上。
            // 允许 last_page == page_idx（同页被 VLM 拆成多个续接块）或上一页。
            let can_merge = question.continues_from_previous
                && result
                    .last()
                    .and_then(|q| q.page_indices.last().copied())
                    .map(|last_page| page_idx - last_page <= 1)
                    .unwrap_or(false);

            if question.continues_from_previous && !can_merge {
                debug!(
                    "[CrossPageMerger] 页面 {} 题目 '{}' 标记续接但上一题不在相邻页，按独立题目处理",
                    page_idx + 1,
                    question.label
                );
            }

            if can_merge {
                let last = result.last_mut().unwrap();

                debug!(
                    "[CrossPageMerger] 页面 {} 题目 '{}' 续接上一页题目 '{}'",
                    page_idx + 1,
                    question.label,
                    last.question.label
                );

                if !question.raw_text.is_empty() {
                    last.question.raw_text.push('\n');
                    last.question.raw_text.push_str(&question.raw_text);
                }

                // 同页多个续接块时避免重复记录页面索引
                if last.page_indices.last() != Some(&page_idx) {
                    last.page_indices.push(page_idx);
                }

                for fig in &question.figures {
                    last.figures_with_page.push((page_idx, fig.clone()));
                    last.question.figures.push(fig.clone());
                }

                last.question.continues_to_next = question.continues_to_next;
            } else {
                let figures_with_page: Vec<(usize, VlmFigure)> = question
                    .figures
                    .iter()
                    .map(|f| (page_idx, f.clone()))
                    .collect();

                result.push(MergedQuestion {
                    question: question.clone(),
                    page_indices: vec![page_idx],
                    figures_with_page,
                });
            }
        }
    }

    let cross_page_count = result.iter().filter(|q| q.page_indices.len() > 1).count();
    if cross_page_count > 0 {
        info!(
            "[CrossPageMerger] 合并完成: {} 道题目, 其中 {} 道跨页",
            result.len(),
            cross_page_count
        );
    } else {
        info!(
            "[CrossPageMerger] 合并完成: {} 道题目, 无跨页",
            result.len()
        );
    }

    result
}
