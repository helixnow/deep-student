//! 查询重写模块
//!
//! 将用户的原始查询优化为更适合向量检索的形式。
//! 从 user_memory 模块迁移并适配 VFS Memory

use std::sync::Arc;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::llm_manager::LLMManager;

/// 查询重写结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryRewriteResult {
    /// 优化后的主查询
    pub optimized_query: String,
    /// 子查询列表（用于多角度检索）
    pub sub_queries: Vec<String>,
    /// 提取的关键概念
    pub key_concepts: Vec<String>,
    /// 是否进行了重写
    pub was_rewritten: bool,
}

impl Default for QueryRewriteResult {
    fn default() -> Self {
        Self {
            optimized_query: String::new(),
            sub_queries: vec![],
            key_concepts: vec![],
            was_rewritten: false,
        }
    }
}

impl QueryRewriteResult {
    /// 创建不需要重写的结果（直接使用原查询）
    pub fn no_rewrite(original_query: &str) -> Self {
        Self {
            optimized_query: original_query.to_string(),
            sub_queries: vec![],
            key_concepts: vec![],
            was_rewritten: false,
        }
    }
}

/// 查询重写器
pub struct MemoryQueryRewriter {
    llm_manager: Arc<LLMManager>,
}

impl MemoryQueryRewriter {
    /// 创建查询重写器
    pub fn new(llm_manager: Arc<LLMManager>) -> Self {
        Self { llm_manager }
    }

    /// 重写查询
    ///
    /// 将原始查询优化为更适合向量检索的形式。
    /// 对于简短明确的查询，直接返回原查询。
    pub async fn rewrite(&self, original_query: &str) -> Result<QueryRewriteResult> {
        // 简短查询不需要重写
        if original_query.len() < 10 {
            return Ok(QueryRewriteResult::no_rewrite(original_query));
        }

        let prompt = self.build_rewrite_prompt(original_query);

        // 使用轻量模型进行查询重写
        let output = self
            .llm_manager
            .call_model2_raw_prompt(&prompt, None)
            .await?;

        let response = output.raw_response.unwrap_or(output.assistant_message);

        // 解析响应
        match self.parse_rewrite_response(&response, original_query) {
            Ok(result) => {
                if result.was_rewritten {
                    tracing::debug!(
                        "[QueryRewriter] '{}' -> '{}'",
                        original_query,
                        result.optimized_query
                    );
                }
                Ok(result)
            }
            Err(e) => {
                tracing::warn!("[QueryRewriter] 解析失败，使用原查询: {}", e);
                Ok(QueryRewriteResult::no_rewrite(original_query))
            }
        }
    }

    /// 快速重写（仅返回优化后的查询字符串）
    pub async fn rewrite_simple(&self, original_query: &str) -> Result<String> {
        let result = self.rewrite(original_query).await?;
        Ok(result.optimized_query)
    }

    /// 构建重写提示词
    fn build_rewrite_prompt(&self, original_query: &str) -> String {
        format!(
            r#"你是一个查询优化专家。请将用户的原始查询优化为更适合向量检索的形式。

## 原始查询
{original_query}

## 任务
1. 分析查询意图
2. 提取关键概念
3. 生成优化后的查询（更具体、更适合语义搜索）
4. 如果查询复杂，可以拆分为多个子查询

## 输出格式（JSON）
```json
{{
  "optimized_query": "优化后的主查询",
  "sub_queries": ["子查询1", "子查询2"],
  "key_concepts": ["概念1", "概念2"],
  "was_rewritten": true
}}
```

## 注意事项
- 如果原查询已经很好，was_rewritten 设为 false，optimized_query 返回原查询
- 保持查询的核心意图不变
- 子查询用于多角度检索，通常 1-3 个即可

请直接输出 JSON，不要添加额外说明。"#
        )
    }

    /// 解析重写响应
    fn parse_rewrite_response(
        &self,
        response: &str,
        original_query: &str,
    ) -> Result<QueryRewriteResult> {
        // 清理 JSON
        let cleaned = response
            .trim()
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();

        // 尝试解析 JSON
        let parsed: serde_json::Value = serde_json::from_str(cleaned)?;

        let optimized_query = parsed
            .get("optimized_query")
            .and_then(|v| v.as_str())
            .unwrap_or(original_query)
            .to_string();

        let sub_queries: Vec<String> = parsed
            .get("sub_queries")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        let key_concepts: Vec<String> = parsed
            .get("key_concepts")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        let was_rewritten = parsed
            .get("was_rewritten")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        Ok(QueryRewriteResult {
            optimized_query,
            sub_queries,
            key_concepts,
            was_rewritten,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_no_rewrite_short_query() {
        let result = QueryRewriteResult::no_rewrite("test");
        assert_eq!(result.optimized_query, "test");
        assert!(!result.was_rewritten);
    }

    #[test]
    fn test_parse_json() {
        let json = r#"{
            "optimized_query": "优化后的查询",
            "sub_queries": ["子查询1", "子查询2"],
            "key_concepts": ["概念1"],
            "was_rewritten": true
        }"#;

        let parsed: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(
            parsed.get("optimized_query").unwrap().as_str().unwrap(),
            "优化后的查询"
        );
    }
}
