//! 生成 `host/platform/serde-compat/tests/__fixtures__/serde-json-value-to-string.json`。
//!
//! ```sh
//! cd host/platform/serde-compat/tests/__fixtures__/rust-sampler
//! CARGO_TARGET_DIR=/tmp/serde-compat-sampler-target cargo run --offline --release --bin value_to_string > ../serde-json-value-to-string.json
//! rm -rf /tmp/serde-compat-sampler-target
//! ```
//!
//! `valueToString` 每行记录 `[输入 JSON 文本, serde_json::from_str::<Value>(输入).to_string()]`；
//! `authoringConfigFingerprintText` 每行记录 `[存储里的 ApiConfig JSON, 指纹哈希前的文本]`。特性组合与桌面构建相同
//! （preserve_order + arbitrary_precision），即 qbank_batch_import 幂等键（qbank_executor.rs:5041-5046）、
//! 来源槽（qbank_authoring_service.rs:703-707）与配置指纹（question_import_service.rs:3106）哈希前的那段文本。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// dstu-core/src/llm_config.rs:10-125 `ApiConfig` 的逐字段副本（字段、类型、serde 属性相同）。
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiConfig {
    id: String,
    name: String,
    #[serde(default)]
    vendor_id: Option<String>,
    #[serde(default)]
    vendor_name: Option<String>,
    #[serde(default)]
    provider_type: Option<String>,
    #[serde(default)]
    provider_scope: Option<String>,
    #[serde(default)]
    auth_mode: Option<String>,
    #[serde(default)]
    api_protocol: Option<String>,
    #[serde(default)]
    supports_openai_responses: Option<bool>,
    api_key: String,
    base_url: String,
    model: String,
    is_multimodal: bool,
    is_reasoning: bool,
    is_embedding: bool,
    is_reranker: bool,
    #[serde(default)]
    is_image_generation: bool,
    enabled: bool,
    #[serde(default = "default_model_adapter")]
    model_adapter: String,
    #[serde(default = "default_max_output_tokens")]
    max_output_tokens: u32,
    #[serde(default = "default_temperature")]
    temperature: f32,
    #[serde(default, alias = "supports_tools")]
    supports_tools: bool,
    #[serde(default = "default_gemini_api_version")]
    gemini_api_version: String,
    #[serde(default)]
    is_builtin: bool,
    #[serde(default)]
    is_read_only: bool,
    #[serde(default)]
    reasoning_effort: Option<String>,
    #[serde(default)]
    reasoning_mode: Option<String>,
    #[serde(default)]
    thinking_enabled: bool,
    #[serde(default)]
    thinking_budget: Option<i32>,
    #[serde(default)]
    include_thoughts: bool,
    #[serde(default)]
    min_p: Option<f32>,
    #[serde(default)]
    top_k: Option<u32>,
    #[serde(default)]
    enable_thinking: Option<bool>,
    #[serde(default)]
    supports_reasoning: bool,
    #[serde(default)]
    headers: Option<HashMap<String, String>>,
    #[serde(default)]
    top_p_override: Option<f32>,
    #[serde(default)]
    frequency_penalty_override: Option<f32>,
    #[serde(default)]
    presence_penalty_override: Option<f32>,
    #[serde(default)]
    repetition_penalty: Option<f32>,
    #[serde(default)]
    reasoning_split: Option<bool>,
    #[serde(default)]
    effort: Option<String>,
    #[serde(default)]
    verbosity: Option<String>,
    #[serde(default)]
    is_favorite: bool,
    #[serde(default)]
    max_tokens_limit: Option<u32>,
    #[serde(default, alias = "context_window")]
    context_window: Option<u32>,
    #[serde(default)]
    extra_body: Option<serde_json::Map<String, Value>>,
    #[serde(default, skip_deserializing)]
    resolved_adapter_id: Option<String>,
}

fn default_model_adapter() -> String {
    "general".to_string()
}
fn default_max_output_tokens() -> u32 {
    8192
}
fn default_temperature() -> f32 {
    0.7
}
fn default_gemini_api_version() -> String {
    "v1".to_string()
}

/// question_import_service.rs:3100-3107 `authoring_config_fingerprint` 哈希前的文本。
fn fingerprint_text(config: &ApiConfig) -> String {
    let mut snapshot = serde_json::to_value(config).unwrap_or(Value::Null);
    if let Some(object) = snapshot.as_object_mut() {
        object.remove("api_key");
        object.remove("headers");
    }
    snapshot.to_string()
}

/// 以存储里的 camelCase JSON 反序列化出 `ApiConfig`（与 llm 配置存储读取方式相同）。
const API_CONFIGS: &[&str] = &[
    r#"{"id":"cfg_1","name":"默认","apiKey":"enc:abc","baseUrl":"https://api.example.com/v1","model":"m","isMultimodal":false,"isReasoning":false,"isEmbedding":false,"isReranker":false,"enabled":true}"#,
    r#"{"id":"cfg_2","name":"整数浮点","apiKey":"k","baseUrl":"u","model":"m","isMultimodal":true,"isReasoning":true,"isEmbedding":false,"isReranker":false,"enabled":true,"temperature":1,"minP":0.05,"topPOverride":1.0,"repetitionPenalty":1.05,"thinkingBudget":-1,"topK":40,"headers":{"X-A":"1"},"extraBody":{"b":1,"a":2.5},"contextWindow":128000}"#,
    r#"{"id":"cfg_4","name":"extraBody 词形","apiKey":"k","baseUrl":"u","model":"m","isMultimodal":false,"isReasoning":false,"isEmbedding":false,"isReranker":false,"enabled":true,"extraBody":{"b":1,"a":2.0,"1":true}}"#,
    r#"{"id":"cfg_3","name":"f32 精度","apiKey":"k","baseUrl":"u","model":"m","isMultimodal":false,"isReasoning":false,"isEmbedding":false,"isReranker":false,"enabled":false,"temperature":0.123456789,"frequencyPenaltyOverride":0.1,"presencePenaltyOverride":-0.5,"vendorId":"v","reasoningEffort":"high"}"#,
];

const INPUTS: &[&str] = &[
    r#"1"#,
    r#"1.0"#,
    r#"1.50"#,
    r#"-0"#,
    r#"-0.0"#,
    r#"1e2"#,
    r#"1E2"#,
    r#"1e+2"#,
    r#"1.5e-7"#,
    r#"0.1"#,
    r#"3.14159265358979323846"#,
    r#"9007199254740993"#,
    r#"100000000000000000000"#,
    r#"1e400"#,
    r#"{"b":1,"1":2,"a":3,"0":4}"#,
    r#"{"k":1,"k":2,"j":3}"#,
    r#"{"k":1,"j":2,"k":3}"#,
    r#"["\u0001\u001f\u007f","\b\f\n\r\t","\"\\","\/ /","\u2028\u2029","中文","\ud83d\ude00","😀","\u00e9"]"#,
    r#"{"questions":[{"content":"求 ∫ x/(x²+1) dx","answer":"½ln(x²+1)+C","score":2.5,"page":1.0,"options":[]}],"mode":"generate"}"#,
    r#"[[["src_1",1],["src_2",null]],["第一章","1.1"],"3"]"#,
    r#"{"name":"新题集","schema_version":2,"mode":"generate","questions":[{"content":"求 ∫ x/(x²+1) dx","answer":"½ln(x²+1)+C","question_type":"short_answer","structured_data":{"blanks":2,"weight":0.5},"local_id":"q1","original_label":"1","tags":["微积分"],"section_path":[],"answer_origin":"generated"}],"materials":[],"groups":[],"unmatched_answers":[],"coverage":[],"issues":[]}"#,
];

fn esc(text: &str) -> String {
    serde_json::to_string(text).unwrap()
}

fn main() {
    let rows: Vec<String> = INPUTS
        .iter()
        .map(|input| {
            let value: Value = serde_json::from_str(input).unwrap();
            format!("    [{}, {}]", esc(input), esc(&value.to_string()))
        })
        .collect();
    let configs: Vec<String> = API_CONFIGS
        .iter()
        .map(|input| {
            let config: ApiConfig = serde_json::from_str(input).unwrap();
            format!("    [{}, {}]", esc(input), esc(&fingerprint_text(&config)))
        })
        .collect();
    println!(
        "{{\n  \"generator\": \"host/platform/serde-compat/tests/__fixtures__/rust-sampler --bin value_to_string (serde_json 1.0.149, preserve_order + arbitrary_precision)\",\n  \"valueToString\": [\n{}\n  ],\n  \"authoringConfigFingerprintText\": [\n{}\n  ]\n}}",
        rows.join(",\n"),
        configs.join(",\n")
    );
}
