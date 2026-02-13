// 新增：按阶段动态 JSON 校验模块
use jsonschema::JSONSchema;
use serde_json::Value;
use std::ops::Deref;
use std::sync::LazyLock;

/// 不同阶段的 JSON 校验枚举
pub enum Stage {
    Recommendation,   // model2 初次输出阶段（tags & mistake_type）
    TagBranch,        // 批量分支选择阶段
    TagPrecise,       // 批量精确选择阶段
    AiRecommendation, // AI 推荐阶段
    ContentAnalysis,  // 内容分析阶段（问题/洞察/tags）
}

// 定义 Recommendation 阶段的 JSON Schema
static RECOMMEND_SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    serde_json::json!({
        "type": "object",
        "properties": {
            "tags": { "type": "array", "items": { "type": "string" } },
            "mistake_type": { "type": "string" }
        },
        "required": ["tags", "mistake_type"],
        "additionalProperties": true
    })
});

// TagBranch: 只要求 results 数组存在
static TAG_BRANCH_SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    serde_json::json!({
        "type": "object",
        "properties": {
            "results": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "tag_index": { "type": "integer" },
                        "tag_name": { "type": "string" },
                        "selected_branch_ids": {
                            "type": "array",
                            "items": { "type": "string" }
                        },
                        "selected_branches": {
                            "type": "array",
                            "items": { "type": "integer" }
                        }
                    },
                    "anyOf": [
                        { "required": ["tag_index", "tag_name", "selected_branch_ids"] },
                        { "required": ["tag_index", "tag_name", "selected_branches"] }
                    ],
                    "additionalProperties": true
                }
            }
        },
        "required": ["results"],
        "additionalProperties": true
    })
});

// TagPrecise: 只要求 results 数组存在
static TAG_PRECISE_SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    serde_json::json!({
        "type": "object",
        "properties": {
            "results": { "type": "array" }
        },
        "required": ["results"],
        "additionalProperties": true
    })
});

// AiRecommendation: 要求 recommendations 数组
static AI_RECOMMEND_SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    serde_json::json!({
        "type": "object",
        "properties": {
            "recommendations": { "type": "array" }
        },
        "required": ["recommendations"],
        "additionalProperties": true
    })
});

// ContentAnalysis: 建议包含 problem/insight 字段与 tags[string]
static CONTENT_ANALYSIS_SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    serde_json::json!({
        "type": "object",
        "properties": {
            "problem": { "type": ["string", "null"] },
            "insight": { "type": ["string", "null"] },
            "tags": {
                "type": ["array", "null"],
                "items": { "type": "string" }
            }
        },
        "required": [],
        "additionalProperties": true
    })
});

/// 按阶段校验 JSON 数据
pub fn validate(stage: Stage, data: &Value) -> Result<(), Vec<String>> {
    let schema = match stage {
        Stage::Recommendation => RECOMMEND_SCHEMA.deref(),
        Stage::TagBranch => TAG_BRANCH_SCHEMA.deref(),
        Stage::TagPrecise => TAG_PRECISE_SCHEMA.deref(),
        Stage::AiRecommendation => AI_RECOMMEND_SCHEMA.deref(),
        Stage::ContentAnalysis => CONTENT_ANALYSIS_SCHEMA.deref(),
    };
    let compiled = JSONSchema::compile(schema).map_err(|e| vec![e.to_string()])?;
    let result = compiled.validate(data);
    if let Err(errors) = result {
        let msgs: Vec<String> = errors.map(|e| e.to_string()).collect();
        Err(msgs)
    } else {
        Ok(())
    }
}
