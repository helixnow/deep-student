//! Stage 5: LLM Structurer — 将 VLM raw_text 结构化为标准题目 JSON
//!
//! VLM 提供的 raw_text 是题目的原始文本（含题号、选项等），
//! 本阶段使用普通 LLM（非 VLM）将其结构化为标准字段。
//! 图片已在 Stage 4 精确关联，此阶段仅处理文本。
//!
//! 对齐策略：通过 `_source_label` 字段要求 LLM 在输出中回传题号，
//! 然后按 label 匹配（而非位置索引）将结构化结果关联回源题目，
//! 防止 LLM 乱序或拆分/合并题目导致的错位。

use serde_json::Value;
use std::sync::Arc;
use tracing::{info, warn};

use crate::figure_extractor::QuestionWithFigures;
use crate::llm_manager::LLMManager;
use crate::models::AppError;

/// 结构化后的题目
#[derive(Debug, Clone)]
pub struct StructuredQuestion {
    pub json: Value,
    pub source: QuestionWithFigures,
}

const BATCH_SIZE: usize = 8;

/// ★ P1-2 修复：批次失败哨兵值。
///
/// 此前 LLM 调用失败的批次被持久化为 `"[]"` 且推进 `completed`，
/// 与"成功但空结果"无法区分，断点恢复永远不再重试，
/// 全批题目静默降级为 minimal JSON。现在失败批次记录此哨兵，
/// 且 `completed`（成功前缀长度）不越过失败批次，恢复时会重试。
const BATCH_FAILED_SENTINEL: &str = "__LLM_BATCH_FAILED__";

/// 判断持久化的批次结果是否为"可复用的成功结果"
/// （非空、非失败哨兵、可解析为非空 JSON 数组）
fn parse_reusable_batch_result(s: &str) -> Option<Vec<Value>> {
    if s.is_empty() || s == BATCH_FAILED_SENTINEL {
        return None;
    }
    match serde_json::from_str::<Vec<Value>>(s) {
        Ok(arr) if !arr.is_empty() => Some(arr),
        _ => None,
    }
}

pub struct LlmStructurer {
    llm_manager: Arc<LLMManager>,
}

impl LlmStructurer {
    pub fn new(llm_manager: Arc<LLMManager>) -> Self {
        Self { llm_manager }
    }

    /// 批量结构化题目列表，每批最多 BATCH_SIZE 道。
    ///
    /// `prior_batch_results` 为 checkpoint 中已持久化的前 N 批 LLM 结果（JSON 数组字符串）。
    /// 恢复时用真实结果而非 fallback。
    ///
    /// 返回 `(已完成的批次数, 各批结果JSON, 结构化题目列表)`。
    pub async fn structure_questions(
        &self,
        questions: &[QuestionWithFigures],
        model_config_id: Option<&str>,
        batches_completed: usize,
        prior_batch_results: &[String],
    ) -> Result<(usize, Vec<String>, Vec<StructuredQuestion>), AppError> {
        if questions.is_empty() {
            return Ok((0, Vec::new(), Vec::new()));
        }

        let total = questions.len();
        let mut results: Vec<StructuredQuestion> = Vec::with_capacity(total);
        let mut batch_result_jsons: Vec<String> = prior_batch_results.to_vec();

        let all_batches: Vec<&[QuestionWithFigures]> = questions.chunks(BATCH_SIZE).collect();
        let total_batches = all_batches.len();

        info!(
            "[LlmStructurer] 开始结构化 {} 道题目 ({} 批, 跳过前 {} 批)",
            total, total_batches, batches_completed
        );

        // 恢复已完成批次：使用持久化的真实 LLM 结果
        for batch_idx in 0..batches_completed.min(total_batches) {
            let batch = all_batches[batch_idx];

            let restored_parsed: Vec<Value> = prior_batch_results
                .get(batch_idx)
                .and_then(|s| parse_reusable_batch_result(s))
                .unwrap_or_default();

            if restored_parsed.is_empty() {
                for qwf in batch {
                    results.push(StructuredQuestion {
                        json: raw_text_to_minimal_json(
                            &qwf.merged.question.raw_text,
                            &qwf.merged.question.label,
                        ),
                        source: qwf.clone(),
                    });
                }
            } else {
                let matched = Self::align_by_label(batch, &restored_parsed);
                for (i, qwf) in batch.iter().enumerate() {
                    let json = match matched.get(i).and_then(|m| m.clone()) {
                        Some(j) => j,
                        None => raw_text_to_minimal_json(
                            &qwf.merged.question.raw_text,
                            &qwf.merged.question.label,
                        ),
                    };
                    results.push(StructuredQuestion {
                        json,
                        source: qwf.clone(),
                    });
                }
            }
        }

        let mut completed = batches_completed;
        // ★ P1-2 修复：completed 语义 = 「成功批次的连续前缀长度」。
        // 失败批次不推进 completed（后续成功批次的结果仍持久化，恢复时可直接复用），
        // 保证断点恢复会重试失败批次而非永久降级。
        let mut prefix_all_ok = true;

        for batch_idx in batches_completed..total_batches {
            let batch = all_batches[batch_idx];

            // 恢复场景：该批次此前已成功（在失败批次之后被持久化过），直接复用，不再调 LLM
            if let Some(prior_parsed) = prior_batch_results
                .get(batch_idx)
                .and_then(|s| parse_reusable_batch_result(s))
            {
                info!(
                    "[LlmStructurer] 批次 {}/{}: 复用已持久化的成功结果（{} 项）",
                    batch_idx + 1,
                    total_batches,
                    prior_parsed.len()
                );
                let matched = Self::align_by_label(batch, &prior_parsed);
                for (i, qwf) in batch.iter().enumerate() {
                    let json = match matched.get(i).and_then(|m| m.clone()) {
                        Some(j) => j,
                        None => raw_text_to_minimal_json(
                            &qwf.merged.question.raw_text,
                            &qwf.merged.question.label,
                        ),
                    };
                    results.push(StructuredQuestion {
                        json,
                        source: qwf.clone(),
                    });
                }
                if prefix_all_ok {
                    completed = batch_idx + 1;
                }
                continue;
            }

            let prompt = Self::build_batch_prompt(batch);

            // 带一次即时重试的 LLM 调用（覆盖瞬时网络抖动/429）
            let mut call_result = self
                .llm_manager
                .call_llm_for_question_parsing_with_model(&prompt, model_config_id)
                .await;
            if call_result.is_err() {
                warn!(
                    "[LlmStructurer] 批次 {}/{} LLM 调用失败，2s 后重试一次: {:?}",
                    batch_idx + 1,
                    total_batches,
                    call_result.as_ref().err()
                );
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                call_result = self
                    .llm_manager
                    .call_llm_for_question_parsing_with_model(&prompt, model_config_id)
                    .await;
            }

            // 批次成功 = 调用成功且解析出非空数组（batch 非空时空结果同样视为失败，可重试）
            let (batch_json_str, parsed, batch_ok) = match call_result {
                Ok(response) => {
                    let parsed = Self::parse_llm_response(&response);
                    if parsed.is_empty() {
                        warn!(
                            "[LlmStructurer] 批次 {}/{} LLM 返回无法解析出题目，记为失败（可重试）",
                            batch_idx + 1,
                            total_batches
                        );
                        (BATCH_FAILED_SENTINEL.to_string(), Vec::new(), false)
                    } else {
                        let json_str = serde_json::to_string(&parsed).unwrap_or_default();
                        (json_str, parsed, true)
                    }
                }
                Err(e) => {
                    warn!(
                        "[LlmStructurer] 批次 {}/{} LLM 调用失败: {}, 本轮回退为 minimal JSON（checkpoint 不标记完成，恢复时重试）",
                        batch_idx + 1,
                        total_batches,
                        e
                    );
                    (BATCH_FAILED_SENTINEL.to_string(), Vec::new(), false)
                }
            };

            let matched = Self::align_by_label(batch, &parsed);

            info!(
                "[LlmStructurer] 批次 {}/{}: LLM 返回 {} 项, 匹配 {} 项",
                batch_idx + 1,
                total_batches,
                parsed.len(),
                matched.iter().filter(|m| m.is_some()).count()
            );

            for (i, qwf) in batch.iter().enumerate() {
                let json = match matched.get(i).and_then(|m| m.clone()) {
                    Some(j) => j,
                    None => raw_text_to_minimal_json(
                        &qwf.merged.question.raw_text,
                        &qwf.merged.question.label,
                    ),
                };
                results.push(StructuredQuestion {
                    json,
                    source: qwf.clone(),
                });
            }

            // 持久化此批次的 LLM 原始结果（失败批次持久化哨兵，供恢复时识别并重试）
            while batch_result_jsons.len() <= batch_idx {
                batch_result_jsons.push(String::new());
            }
            batch_result_jsons[batch_idx] = batch_json_str;

            if batch_ok && prefix_all_ok {
                completed = batch_idx + 1;
            } else if !batch_ok {
                prefix_all_ok = false;
            }
        }

        info!(
            "[LlmStructurer] 结构化完成: {}/{} 道题目",
            results.len(),
            total
        );

        Ok((completed, batch_result_jsons, results))
    }

    /// 按 label 匹配 LLM 输出与源题目（而非位置索引）
    ///
    /// 返回与 `batch` 等长的 `Vec<Option<Value>>`。
    fn align_by_label(batch: &[QuestionWithFigures], parsed: &[Value]) -> Vec<Option<Value>> {
        let mut result: Vec<Option<Value>> = vec![None; batch.len()];
        // 标记已被消费的 parsed 项：位置回退只取尚未消费的项，避免把已按 label
        // 匹配走的 parsed 重复分配给另一题（label 错位 + 数量恰好相等的场景）。
        let mut used: Vec<bool> = vec![false; parsed.len()];

        // 如果数量完全一致且无 _source_label，按位置回退
        let has_labels = parsed
            .iter()
            .any(|p| p.get("_source_label").and_then(|v| v.as_str()).is_some());

        if !has_labels && parsed.len() == batch.len() {
            for (i, p) in parsed.iter().enumerate() {
                result[i] = Some(p.clone());
            }
            return result;
        }

        // 按 _source_label 匹配
        for (p_idx, p) in parsed.iter().enumerate() {
            let p_label = p
                .get("_source_label")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();

            if p_label.is_empty() {
                continue;
            }

            // 在 batch 中找到匹配的源题目
            for (i, qwf) in batch.iter().enumerate() {
                if result[i].is_some() {
                    continue;
                }
                if qwf.merged.question.label.trim() == p_label {
                    result[i] = Some(p.clone());
                    used[p_idx] = true;
                    break;
                }
            }
        }

        // 未匹配的题槽用「尚未被 label 消费的 parsed 项」依序回退（仅当数量一致时）
        if parsed.len() == batch.len() {
            let mut next_unused = 0usize;
            for slot in result.iter_mut() {
                if slot.is_some() {
                    continue;
                }
                while next_unused < parsed.len() && used[next_unused] {
                    next_unused += 1;
                }
                if next_unused >= parsed.len() {
                    break;
                }
                *slot = Some(parsed[next_unused].clone());
                used[next_unused] = true;
                next_unused += 1;
            }
        }

        result
    }

    fn build_batch_prompt(batch: &[QuestionWithFigures]) -> String {
        let mut questions_text = String::new();

        for (i, qwf) in batch.iter().enumerate() {
            questions_text.push_str(&format!(
                "--- 题目 {} (label=\"{}\") ---\n{}\n\n",
                i + 1,
                qwf.merged.question.label,
                qwf.merged.question.raw_text
            ));
        }

        format!(
            r#"请将以下 {} 道题目的原始文本结构化为标准 JSON 格式。不需要处理图片。

{}
**输出要求**：
输出一个 JSON 数组，每个元素对应一道题目（只输出 JSON，不要其他内容）：

```json
[
  {{
    "_source_label": "1",
    "content": "题干内容（不含选项文本）",
    "question_type": "single_choice|multiple_choice|indefinite_choice|fill_blank|short_answer|essay|calculation|proof|other",
    "options": [
      {{"key": "A", "content": "选项A内容"}},
      {{"key": "B", "content": "选项B内容"}}
    ],
    "answer": "A",
    "explanation": "解析（如有）",
    "difficulty": "easy|medium|hard|very_hard",
    "tags": ["知识点标签"]
  }}
]
```

**规则**：
1. `_source_label` 必须填写原始题号标签（括号中 label= 的值），用于对齐
2. 选择题必须将选项拆分到 options 数组，content 只保留题干
3. 题型: single_choice=单选, multiple_choice=多选, fill_blank=填空, short_answer=简答
4. 所有数学公式用 LaTeX: 行内 $...$, 独立 $$...$$
5. 没有答案/解析的字段输出 null
6. difficulty 默认 "medium"
7. 输出数组长度必须等于输入题目数量 ({})"#,
            batch.len(),
            questions_text,
            batch.len()
        )
    }

    fn parse_llm_response(response: &str) -> Vec<Value> {
        let json_str = if let Some(start) = response.find('[') {
            if let Some(end) = response.rfind(']') {
                &response[start..=end]
            } else {
                response
            }
        } else {
            response
        };

        match serde_json::from_str::<Vec<Value>>(json_str) {
            Ok(arr) => arr,
            Err(e) => {
                warn!("[LlmStructurer] 解析 LLM 响应失败: {}", e);
                Vec::new()
            }
        }
    }
}

fn raw_text_to_minimal_json(raw_text: &str, label: &str) -> Value {
    serde_json::json!({
        "content": raw_text,
        "question_type": "other",
        "options": null,
        "answer": null,
        "explanation": null,
        "difficulty": "medium",
        "tags": [],
        "_source_label": label
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ★ P1-2 回归：区分"成功结果 / 失败哨兵 / 空结果 / 损坏 JSON"
    #[test]
    fn reusable_batch_result_distinguishes_failure_from_success() {
        // 成功的非空数组可复用
        let ok = r#"[{"_source_label":"1","content":"题目"}]"#;
        assert!(parse_reusable_batch_result(ok).is_some());

        // 失败哨兵不可复用（恢复时触发重试）
        assert!(parse_reusable_batch_result(BATCH_FAILED_SENTINEL).is_none());

        // 旧版失败写入的 "[]" 不可复用
        assert!(parse_reusable_batch_result("[]").is_none());

        // 空字符串（占位）不可复用
        assert!(parse_reusable_batch_result("").is_none());

        // 损坏 JSON 不可复用
        assert!(parse_reusable_batch_result("{not json").is_none());
    }
}
