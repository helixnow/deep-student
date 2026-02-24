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
            if question.continues_from_previous && !result.is_empty() {
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

                last.page_indices.push(page_idx);

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
