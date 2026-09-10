//! 月之暗面 Kimi 专用适配器
//!
//! Kimi K2.5–K2.7 与 K3 使用不同的推理参数契约：
//!
//! ## K2.5+ 新代际模型（含 K2.6 旗舰、K2.7-code）
//! - **thinking 参数**：`{"type": "enabled" | "disabled"}`；K2.6 默认开启思考，
//!   K2.7-code 强制思考（`type` 只接受 `enabled`）
//! - **Preserved Thinking**：`thinking.keep: "all"`（K2.6 可选、K2.7-code 强制）
//! - **锁死采样参数**：temperature=1.0（非思考 0.6）、top_p=0.95、n=1、penalties=0.0，
//!   传入非固定值会**直接报错**（不是静默忽略），必须整体移除
//! - **max_tokens 已废弃**：改用 `max_completion_tokens`；不传时默认值很小，需显式设置（默认 32768）
//! - **tool_choice 限制**：thinking 模式下只能是 "auto" 或 "none"
//! - 思维链经 `reasoning_content` 返回，工具调用链内必须回传（DeepSeekStyle）
//!
//! ## K3+
//! - 不接受 K2.x 的 `thinking` 对象
//! - 推理固定为 `reasoning_effort: "max"`，不可关闭
//!
//! ## 版本识别
//! 不再枚举子串，而是解析模型名中的 `k<major>[./-]<minor>` 版本号：
//! K2.5–K2.7 走 K2 新代际路径；K3+ 必须先进入独立路径；
//! 快照日期后缀（如 kimi-k2-0905-preview）不会被误判为小版本号。
//!
//! ## 已停服模型（2026-07 现状）
//! - kimi-k2 全系（k2-0711/0905-preview、k2-turbo-preview、k2-thinking*，2026-05-25 停）
//! - kimi-latest（2026-01-28 停）、kimi-thinking-preview（2025-11-11 停）
//! - 旧路径仅为向后兼容保留（用户自定义端点可能仍托管同名模型）
//!
//! ## 输出格式
//! ```json
//! {
//!   "reasoning_content": "思考过程...",
//!   "content": "最终答案..."
//! }
//! ```
//!
//! 参考文档：https://platform.kimi.ai/docs/api/chat 、
//! https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart

use super::{PassbackPolicy, RequestAdapter};
use crate::llm_manager::ApiConfig;
use serde_json::{json, Map, Value};

/// 月之暗面 Kimi 专用适配器
///
/// - K2.5+（含 K2.6/K2.7-code 及未来版本）: thinking 参数、锁死采样参数、
///   max_completion_tokens 迁移、Preserved Thinking
/// - 遗留 K2 Thinking: 强制 temperature = 1.0, max_tokens >= 16000
pub struct MoonshotAdapter;

// ============================================================================
// MFJS 工具 schema 规范化
// ============================================================================
//
// Moonshot 服务端按 MFJS（Moonshot Flavored JSON Schema）Ultra 级校验
// `tools[].function.parameters`（walle 默认 ValidateLevelDefault == ultra）。
// 规范：<https://github.com/MoonshotAI/walle/blob/main/docs/mfjs-spec.zh.md>
// 校验器源码约束（walle validator.go / keyword_validators.go / model.go）：
//
// 1. `anyOf` 节点的同级只允许 description/title（根级另允 $defs/$id），
//    type/properties/required 等约束必须下沉到每个分支内部
//    （否则 400: "when using anyOf, type should be defined in anyOf items
//    instead of the parent schema"）；分支内 required 还要求同级
//    type:object 且 properties 覆盖全部 required 字段 → 必须完整内联。
// 2. `oneOf`/`allOf` 不在支持列表 → oneOf 改写为 anyOf；allOf（含 if/then
//    条件，MFJS 无法表达）丢弃，由执行器兜底校验跨字段约束。
// 3. `enum` 不支持 null 字面量 → 全 null 的 enum 改写为 {"type":"null"}；
//    且 enum 同层必须有 type → 裸 enum 从字面量推断 type。
// 4. `const` 不支持 → 改写为单值 enum（语义精确等价）。
// 5. 不在 SupportedKeywords 的关键字（minProperties/uniqueItems 等）→ 丢弃
//    （walle 自己的简化器 SimplifyRemoveSchemaKeys 也是丢弃）。
// 6. anyOf 分支与父级同时定义 description/title → 删除父级副本
//    （walle simplifyFuncForAnyOfParentConflicts 的同款处理）。
//
// 该变换在标准 JSON Schema 语义下等价或仅放宽提示性约束（执行器仍做参数
// 校验兜底），且对同一输入确定性输出（不破坏 prompt 缓存前缀稳定性）。
// 仅在发往 Moonshot 时应用（见 model2_pipeline 的 tools 注入点），
// 其它厂商请求字节保持不变。

/// MFJS 支持的关键字（walle model.go SupportedKeywords ∪ FutureKeywords）。
const MFJS_SUPPORTED_KEYWORDS: &[&str] = &[
    "type",
    "properties",
    "additionalProperties",
    "items",
    "enum",
    "required",
    "anyOf",
    "description",
    "$defs",
    "$ref",
    "title",
    "$id",
    "default",
    "maxLength",
    "minLength",
    "maximum",
    "minimum",
    "maxItems",
    "minItems",
    "pattern",
];

/// 规范化 OpenAI function 线格式工具数组（{"type":"function","function":{...}}），
/// 返回改写的节点数（供日志与测试断言）。
pub(crate) fn normalize_tool_schemas_for_mfjs(tools: &mut [Value]) -> usize {
    let mut rewrites = 0;
    for tool in tools.iter_mut() {
        if let Some(params) = tool
            .get_mut("function")
            .and_then(|f| f.get_mut("parameters"))
        {
            normalize_mfjs_schema_node(params, true, &mut rewrites);
        }
    }
    rewrites
}

/// 是否应按 MFJS 方言规范化工具 schema。命中条件（任一）：
/// - 适配器/供应商为 moonshot（含 kimi 别名）；
/// - base_url 直连 Moonshot 官方或 Kimi coding plan（api.moonshot.cn /
///   api.kimi.com——后者未被前端 `inferProviderTypeFromBaseUrl` 识别为
///   moonshot，自定义 vendor 会落通用适配器，必须按域名兜底）；
/// - 模型名含 kimi/moonshot（覆盖经自定义中转反代到 Kimi 的场景；
///   变换语义等价，误伤其它网关托管的同名模型也无副作用）。
pub(crate) fn should_apply_mfjs_tool_schema_dialect(config: &ApiConfig) -> bool {
    if matches!(config.model_adapter.as_str(), "moonshot" | "kimi")
        || config
            .provider_type
            .as_deref()
            .is_some_and(|p| matches!(p, "moonshot" | "kimi"))
    {
        return true;
    }
    let base_url = config.base_url.to_lowercase();
    if base_url.contains("moonshot.cn") || base_url.contains("api.kimi.com") {
        return true;
    }
    let model = config.model.to_lowercase();
    model.contains("kimi") || model.contains("moonshot")
}

/// 递归规范化单个 schema 节点，改写次数累计进 `rewrites`。
fn normalize_mfjs_schema_node(node: &mut Value, is_root: bool, rewrites: &mut usize) {
    let Value::Object(map) = node else {
        return;
    };

    // 1) oneOf → anyOf（MFJS 无 oneOf）
    if let Some(one_of) = map.remove("oneOf") {
        if let Value::Array(one_branches) = one_of {
            match map.get_mut("anyOf").and_then(Value::as_array_mut) {
                Some(existing) => existing.extend(one_branches),
                None => {
                    map.insert("anyOf".to_string(), Value::Array(one_branches));
                }
            }
        }
        *rewrites += 1;
    }

    // 2) const → 单值 enum（语义精确等价）
    if let Some(const_val) = map.remove("const") {
        if !map.contains_key("enum") {
            map.insert("enum".to_string(), json!([const_val]));
        }
        *rewrites += 1;
    }

    // 3) enum 相关规范化：
    //    全 null 的 enum → {"type":"null"}（MFJS enum 不支持 null 字面量）；
    //    裸 enum（无同级 type）→ 从字面量推断 type（MFJS 要求 enum 同层有 type）
    let enum_all_null = map
        .get("enum")
        .and_then(Value::as_array)
        .is_some_and(|vals| !vals.is_empty() && vals.iter().all(Value::is_null));
    if enum_all_null {
        map.remove("enum");
        map.insert("type".to_string(), Value::String("null".to_string()));
        *rewrites += 1;
    } else if !map.contains_key("type") {
        if let Some(inferred) = map
            .get("enum")
            .and_then(Value::as_array)
            .and_then(|vals| infer_mfjs_enum_type(vals))
        {
            map.insert("type".to_string(), Value::String(inferred.to_string()));
            *rewrites += 1;
        }
    }

    // 4) 丢弃 MFJS 不支持的关键字（walle Ultra 级报 "unsupported keywords"）
    let unsupported: Vec<String> = map
        .keys()
        .filter(|k| !MFJS_SUPPORTED_KEYWORDS.contains(&k.as_str()))
        .cloned()
        .collect();
    if !unsupported.is_empty() {
        for k in &unsupported {
            map.remove(k);
        }
        *rewrites += unsupported.len();
    }

    // 5) anyOf 同级约束下沉到分支（walle distributeAnyOf 语义）：
    //    同级仅保留 anyOf + description/title（根级另保留 $defs/$id）
    let has_usable_anyof = map
        .get("anyOf")
        .and_then(Value::as_array)
        .is_some_and(|branches| !branches.is_empty() && branches.iter().all(Value::is_object));
    if has_usable_anyof {
        // 6a) 分支与父级同时定义 description/title → 删父级副本
        //     （walle Ultra 冲突规则，保留更具体的分支注解）
        let mut annotation_conflicts: Vec<&str> = Vec::new();
        if let Some(branches) = map.get("anyOf").and_then(Value::as_array) {
            for k in ["description", "title"] {
                if map.contains_key(k) && branches.iter().any(|b| b.get(k).is_some()) {
                    annotation_conflicts.push(k);
                }
            }
        }
        for k in annotation_conflicts {
            map.remove(k);
            *rewrites += 1;
        }

        let sibling_keys: Vec<String> = map
            .keys()
            .filter(|k| {
                let k = k.as_str();
                k != "anyOf"
                    && k != "description"
                    && k != "title"
                    && !(is_root && (k == "$defs" || k == "$id"))
            })
            .cloned()
            .collect();
        if !sibling_keys.is_empty() {
            let outer: Vec<(String, Value)> = sibling_keys
                .iter()
                .filter_map(|k| map.get(k).map(|v| (k.clone(), v.clone())))
                .collect();
            if let Some(any_of) = map.get_mut("anyOf").and_then(Value::as_array_mut) {
                for branch in any_of.iter_mut().filter_map(Value::as_object_mut) {
                    for (key, value) in &outer {
                        merge_mfjs_branch(branch, key, value);
                    }
                }
            }
            for key in &sibling_keys {
                map.remove(key);
            }
            *rewrites += 1;
        }
    }

    // 6) 递归子 schema（anyOf 分支已并入父级约束，同样需要规范化）
    if let Some(any_of) = map.get_mut("anyOf").and_then(Value::as_array_mut) {
        for branch in any_of.iter_mut() {
            normalize_mfjs_schema_node(branch, false, rewrites);
        }
    }
    if let Some(props) = map.get_mut("properties").and_then(Value::as_object_mut) {
        for sub in props.values_mut() {
            normalize_mfjs_schema_node(sub, false, rewrites);
        }
    }
    if let Some(defs) = map.get_mut("$defs").and_then(Value::as_object_mut) {
        for sub in defs.values_mut() {
            normalize_mfjs_schema_node(sub, false, rewrites);
        }
    }
    if let Some(items) = map.get_mut("items") {
        match items {
            Value::Object(_) => normalize_mfjs_schema_node(items, false, rewrites),
            Value::Array(arr) => {
                for sub in arr.iter_mut() {
                    normalize_mfjs_schema_node(sub, false, rewrites);
                }
            }
            _ => {}
        }
    }
    if let Some(ap) = map.get_mut("additionalProperties") {
        if ap.is_object() {
            normalize_mfjs_schema_node(ap, false, rewrites);
        }
    }
}

/// 把父级约束并入 anyOf 分支：required 取并集（语义 = 两者交集），
/// properties 按键合并且分支已有同名属性时保留分支（鉴别器收窄语义），
/// 其余关键字仅在分支缺失时补入（分支自身的更严约束优先）。
fn merge_mfjs_branch(branch: &mut Map<String, Value>, key: &str, value: &Value) {
    if key == "required" {
        let mut handled = false;
        if let Some(Value::Array(existing)) = branch.get_mut(key) {
            if let Value::Array(extra) = value {
                for item in extra {
                    if !existing.contains(item) {
                        existing.push(item.clone());
                    }
                }
            }
            handled = true;
        }
        if handled {
            return;
        }
    } else if key == "properties" {
        let mut handled = false;
        if let Some(Value::Object(existing)) = branch.get_mut(key) {
            if let Value::Object(extra) = value {
                for (k, v) in extra {
                    if !existing.contains_key(k) {
                        existing.insert(k.clone(), v.clone());
                    }
                }
            }
            handled = true;
        }
        if handled {
            return;
        }
    }
    if !branch.contains_key(key) {
        branch.insert(key.to_string(), value.clone());
    }
}

/// 从 enum 字面量推断 type（MFJS enum 仅支持 float/int/str，字面量类型一致）。
/// 混合类型或含 null 时返回 None（保持原样，交给校验器报错）。
fn infer_mfjs_enum_type(vals: &[Value]) -> Option<&'static str> {
    if vals.is_empty() {
        return None;
    }
    if vals.iter().all(Value::is_string) {
        return Some("string");
    }
    if vals.iter().all(Value::is_boolean) {
        return Some("boolean");
    }
    if vals.iter().all(Value::is_number) {
        let all_integral = vals
            .iter()
            .filter_map(Value::as_f64)
            .all(|f| f.fract() == 0.0);
        return Some(if all_integral { "integer" } else { "number" });
    }
    None
}

impl MoonshotAdapter {
    /// 解析模型名中的 Kimi K 系版本号，返回 (major, minor)。
    ///
    /// 示例：
    /// - `kimi-k2.6` → (2, 6)；`kimi-k2-5` → (2, 5)；`kimi-k2.7-code` → (2, 7)
    /// - `kimi-k2` / `kimi-k2-thinking` → (2, 0)
    /// - `kimi-k2-0905-preview` → (2, 0)（3 位以上数字视为快照日期而非小版本号）
    /// - `moonshot-v1-128k` → None（`k` 前是字母数字，不是版本边界）
    fn parse_k_version(model: &str) -> Option<(u32, u32)> {
        let lower = model.to_lowercase();
        let bytes = lower.as_bytes();
        for (i, _) in lower.match_indices('k') {
            // 边界检查：k 前必须是开头或非字母数字字符（如 '-'、'/'）
            if i > 0 && (bytes[i - 1] as char).is_ascii_alphanumeric() {
                continue;
            }
            let rest = &lower[i + 1..];
            let major_len = rest.chars().take_while(|c| c.is_ascii_digit()).count();
            if major_len == 0 {
                continue;
            }
            let major: u32 = match rest[..major_len].parse() {
                Ok(v) => v,
                Err(_) => continue,
            };
            let after_major = &rest[major_len..];
            let mut minor = 0u32;
            let mut chars = after_major.chars();
            if matches!(chars.next(), Some('.') | Some('-')) {
                let minor_str: String = chars.take_while(|c| c.is_ascii_digit()).collect();
                // 1-2 位数字视为小版本号；3 位以上（如 -0905）视为快照日期
                if (1..=2).contains(&minor_str.len()) {
                    minor = minor_str.parse().unwrap_or(0);
                }
            }
            return Some((major, minor));
        }
        None
    }

    /// K2.5 及以上的 K2.x 代际：
    /// 锁死采样参数、thinking 参数、max_completion_tokens
    fn is_k25_or_later(model: &str) -> bool {
        match Self::parse_k_version(model) {
            Some((2, minor)) => minor >= 5,
            None => false,
            _ => false,
        }
    }

    fn is_k3_or_later(model: &str) -> bool {
        matches!(Self::parse_k_version(model), Some((major, _)) if major >= 3)
    }

    /// K2.6 及以上支持 `thinking.keep: "all"`（Preserved Thinking）
    fn supports_thinking_keep(model: &str) -> bool {
        match Self::parse_k_version(model) {
            Some((2, minor)) => minor >= 6,
            None => false,
            _ => false,
        }
    }

    /// K2.7-code 系：强制思考（thinking.type 只接受 enabled）+ 强制 keep: "all"
    fn is_forced_thinking_code_model(model: &str) -> bool {
        let is_k27_or_later = match Self::parse_k_version(model) {
            Some((2, minor)) => minor >= 7,
            None => false,
            _ => false,
        };
        is_k27_or_later && model.to_lowercase().contains("code")
    }

    /// 检查是否是 Thinking 模型（遗留 K2 Thinking 或 K2.5+ 新代际）
    fn is_thinking_model(model: &str) -> bool {
        model.to_lowercase().contains("thinking")
            || Self::is_k25_or_later(model)
            || Self::is_k3_or_later(model)
    }

    /// 遗留 Thinking 模型的最小 max_tokens
    const MIN_MAX_TOKENS_FOR_THINKING: u32 = 16000;

    /// 遗留 Thinking 模型的推荐 max_tokens
    const RECOMMENDED_MAX_TOKENS: u32 = 32000;

    /// K2.5+ 的默认 max_completion_tokens（官方默认值很小，必须显式设置）
    const K25_DEFAULT_MAX_TOKENS: u32 = 32768;
}

impl RequestAdapter for MoonshotAdapter {
    fn id(&self) -> &'static str {
        "moonshot"
    }

    fn label(&self) -> &'static str {
        "Kimi/Moonshot"
    }

    fn description(&self) -> &'static str {
        "Kimi K2.5–K2.7 thinking 与 K3 reasoning_effort 参数适配"
    }

    fn apply_reasoning_config(
        &self,
        body: &mut Map<String, Value>,
        config: &ApiConfig,
        enable_thinking: Option<bool>,
    ) -> bool {
        if Self::is_k3_or_later(&config.model) {
            // K3 的推理不可关闭，且服务端拒绝 K2.x `thinking` 对象。
            body.remove("thinking");
            body.remove("enable_thinking");
            body.remove("thinking_budget");
            body.remove("include_thoughts");
            body.insert("reasoning_effort".to_string(), json!("max"));
            return true;
        }

        let is_new_gen = Self::is_k25_or_later(&config.model);
        let is_thinking = Self::is_thinking_model(&config.model);

        if is_new_gen {
            // ========== K2.5+ 新代际处理（K2.5 / K2.6 / K2.7-code / 未来 k2.x）==========
            let forced_thinking = Self::is_forced_thinking_code_model(&config.model);

            // K2.7-code 强制思考（thinking.type 只接受 enabled）；
            // 其余模型：外部覆盖 > 配置 enable_thinking > 默认启用（K2.5/K2.6 默认思考）
            let thinking_enabled = if forced_thinking {
                true
            } else {
                enable_thinking.or(config.enable_thinking).unwrap_or(true)
            };

            let mut thinking_map = Map::new();
            thinking_map.insert(
                "type".to_string(),
                json!(if thinking_enabled {
                    "enabled"
                } else {
                    "disabled"
                }),
            );
            // Preserved Thinking（跨轮保留历史 reasoning_content）：
            // K2.7-code 强制 keep:"all"；K2.6+ 在 include_thoughts 开启时携带
            if Self::supports_thinking_keep(&config.model)
                && thinking_enabled
                && (forced_thinking || config.include_thoughts)
            {
                thinking_map.insert("keep".to_string(), json!("all"));
            }
            body.insert("thinking".to_string(), Value::Object(thinking_map));

            // K2.5+ 锁死采样参数（temperature=1.0/0.6, top_p=0.95, n=1, penalties=0.0），
            // 传非固定值直接报错——移除让 API 使用内部默认值
            body.remove("temperature");
            body.remove("top_p");
            body.remove("n");
            body.remove("presence_penalty");
            body.remove("frequency_penalty");

            // max_tokens 已废弃 → max_completion_tokens；
            // 不传时官方默认值很小，必须显式设置（默认 32768）
            let legacy_max_tokens = body
                .remove("max_tokens")
                .and_then(|v| v.as_u64())
                .filter(|v| *v > 0);
            let existing_completion = body
                .get("max_completion_tokens")
                .and_then(|v| v.as_u64())
                .filter(|v| *v > 0);
            let resolved_max = existing_completion
                .or(legacy_max_tokens)
                .unwrap_or(Self::K25_DEFAULT_MAX_TOKENS as u64);
            body.insert("max_completion_tokens".to_string(), json!(resolved_max));

            // thinking 模式下 tool_choice 只能是 "auto" 或 "none"，其他值直接报错
            if thinking_enabled {
                if let Some(tool_choice) = body.get("tool_choice") {
                    let choice_str = tool_choice.as_str().unwrap_or("");
                    if choice_str != "auto" && choice_str != "none" {
                        body.insert("tool_choice".to_string(), json!("auto"));
                    }
                }
            }

            return true; // 新代际已完成所有处理，跳过通用逻辑
        }

        if is_thinking {
            // ========== 遗留 K2 Thinking 处理（向后兼容，官方已停服）==========
            // Thinking 模型强制 temperature = 1.0
            body.insert("temperature".to_string(), json!(1.0));

            // 确保 max_tokens 足够大
            let current_max_tokens =
                body.get("max_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32;

            if current_max_tokens < Self::MIN_MAX_TOKENS_FOR_THINKING {
                body.insert(
                    "max_tokens".to_string(),
                    json!(Self::RECOMMENDED_MAX_TOKENS),
                );
            }
        }

        // 遗留 K2 Thinking 不使用 enable_thinking 参数
        // 思维链通过 reasoning_content 字段自动返回

        false // 继续处理通用参数
    }

    fn should_remove_sampling_params(&self, config: &ApiConfig) -> bool {
        // K2.5+ 已在 apply_reasoning_config 中移除锁死参数
        // 遗留 K2 Thinking 需要特殊处理 temperature，不移除
        if Self::is_k25_or_later(&config.model) || Self::is_k3_or_later(&config.model) {
            return true;
        }
        false
    }

    fn get_passback_policy(&self, config: &ApiConfig) -> PassbackPolicy {
        // Kimi 使用 reasoning_content 字段（DeepSeek 风格）；
        // K2.5+/K2.6/K2.7 工具调用链内必须回传 reasoning_content
        if Self::is_thinking_model(&config.model) || config.is_reasoning {
            PassbackPolicy::DeepSeekStyle
        } else {
            PassbackPolicy::NoPassback
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_thinking_model_temperature() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2-thinking".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(0.7));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 遗留 Thinking 模型强制 temperature = 1.0
        assert_eq!(body.get("temperature"), Some(&json!(1.0)));
    }

    #[test]
    fn test_thinking_model_min_max_tokens() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2-thinking".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("max_tokens".to_string(), json!(4096)); // 太小

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 应该被提升到推荐值
        assert_eq!(body.get("max_tokens"), Some(&json!(32000)));
    }

    #[test]
    fn test_non_thinking_model_keeps_temperature() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2-turbo-preview".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(0.7));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 非 Thinking 遗留模型保持原有 temperature
        assert_eq!(body.get("temperature"), Some(&json!(0.7)));
    }

    // ========== 版本解析测试 ==========

    #[test]
    fn test_parse_k_version() {
        assert_eq!(MoonshotAdapter::parse_k_version("kimi-k2.5"), Some((2, 5)));
        assert_eq!(MoonshotAdapter::parse_k_version("kimi-k2-5"), Some((2, 5)));
        assert_eq!(MoonshotAdapter::parse_k_version("kimi-k2.6"), Some((2, 6)));
        assert_eq!(
            MoonshotAdapter::parse_k_version("kimi-k2.7-code"),
            Some((2, 7))
        );
        assert_eq!(
            MoonshotAdapter::parse_k_version("kimi-k2.7-code-highspeed"),
            Some((2, 7))
        );
        assert_eq!(MoonshotAdapter::parse_k_version("kimi-k2"), Some((2, 0)));
        assert_eq!(
            MoonshotAdapter::parse_k_version("kimi-k2-thinking"),
            Some((2, 0))
        );
        // 快照日期后缀不是小版本号
        assert_eq!(
            MoonshotAdapter::parse_k_version("kimi-k2-0905-preview"),
            Some((2, 0))
        );
        // 未来版本
        assert_eq!(
            MoonshotAdapter::parse_k_version("kimi-k2.10"),
            Some((2, 10))
        );
        assert_eq!(MoonshotAdapter::parse_k_version("kimi-k3"), Some((3, 0)));
        // 非 K 系模型
        assert_eq!(MoonshotAdapter::parse_k_version("moonshot-v1-128k"), None);
        assert_eq!(MoonshotAdapter::parse_k_version("kimi-latest"), None);
    }

    #[test]
    fn test_k25_model_detection() {
        // K2.5 及以上（含未来版本）
        assert!(MoonshotAdapter::is_k25_or_later("kimi-k2.5"));
        assert!(MoonshotAdapter::is_k25_or_later("kimi-k2-5"));
        assert!(MoonshotAdapter::is_k25_or_later("Pro/moonshot/kimi-k2.5"));
        assert!(MoonshotAdapter::is_k25_or_later("moonshot/K2.5-preview"));
        assert!(MoonshotAdapter::is_k25_or_later("kimi-k2.6"));
        assert!(MoonshotAdapter::is_k25_or_later("kimi-k2.7-code"));
        assert!(MoonshotAdapter::is_k25_or_later("kimi-k2.10"));

        // K3+ 走独立路径（is_k3_or_later），不属于 K2.x 新代际
        assert!(!MoonshotAdapter::is_k25_or_later("kimi-k3"));
        assert!(MoonshotAdapter::is_k3_or_later("kimi-k3"));
        assert!(MoonshotAdapter::is_k3_or_later("kimi-k3-0905-preview"));
        assert!(!MoonshotAdapter::is_k3_or_later("kimi-k2.7-code"));

        // 旧代际不命中
        assert!(!MoonshotAdapter::is_k25_or_later("kimi-k2"));
        assert!(!MoonshotAdapter::is_k25_or_later("kimi-k2-thinking"));
        assert!(!MoonshotAdapter::is_k25_or_later("kimi-k2-0905-preview"));
        assert!(!MoonshotAdapter::is_k25_or_later("moonshot-v1-128k"));
    }

    // ========== K2.5+ 新代际测试用例 ==========

    #[test]
    fn test_k25_thinking_param_format() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2.5".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, Some(true));

        // K2.5 应使用 thinking 参数格式
        assert_eq!(body.get("thinking"), Some(&json!({"type": "enabled"})));
    }

    #[test]
    fn test_k25_thinking_disabled() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2.5".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, Some(false));

        // K2.5 禁用 thinking
        assert_eq!(body.get("thinking"), Some(&json!({"type": "disabled"})));
    }

    #[test]
    fn test_k26_fixed_params_stripped() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2.6".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(0.7));
        body.insert("top_p".to_string(), json!(0.8));
        body.insert("n".to_string(), json!(2));
        body.insert("presence_penalty".to_string(), json!(0.5));
        body.insert("frequency_penalty".to_string(), json!(0.5));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // K2.6 锁死采样参数，传非固定值直接报错，应全部移除
        assert!(body.get("temperature").is_none());
        assert!(body.get("top_p").is_none());
        assert!(body.get("n").is_none());
        assert!(body.get("presence_penalty").is_none());
        assert!(body.get("frequency_penalty").is_none());
        // 默认开启思考
        assert_eq!(
            body.get("thinking").and_then(|v| v.get("type")),
            Some(&json!("enabled"))
        );
    }

    #[test]
    fn test_k26_max_tokens_migrated_to_max_completion_tokens() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2.6".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("max_tokens".to_string(), json!(50000));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // max_tokens 已废弃：迁移为 max_completion_tokens，不能两字段并存
        assert!(!body.contains_key("max_tokens"));
        assert_eq!(body.get("max_completion_tokens"), Some(&json!(50000)));
    }

    #[test]
    fn test_k25_default_max_completion_tokens() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2.5".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 未指定时默认 max_completion_tokens = 32768（官方默认值过小）
        assert!(!body.contains_key("max_tokens"));
        assert_eq!(body.get("max_completion_tokens"), Some(&json!(32768)));
    }

    #[test]
    fn test_k26_existing_max_completion_tokens_kept() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2.6".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("max_completion_tokens".to_string(), json!(65536));
        body.insert("max_tokens".to_string(), json!(4096));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 已有 max_completion_tokens 优先，废弃的 max_tokens 被移除
        assert!(!body.contains_key("max_tokens"));
        assert_eq!(body.get("max_completion_tokens"), Some(&json!(65536)));
    }

    #[test]
    fn test_k26_keep_all_with_include_thoughts() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2.6".to_string(),
            include_thoughts: true,
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, Some(true));

        // K2.6 可选 Preserved Thinking：include_thoughts 时携带 keep: "all"
        assert_eq!(
            body.get("thinking"),
            Some(&json!({"type": "enabled", "keep": "all"}))
        );
    }

    #[test]
    fn test_k25_no_keep_support() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2.5".to_string(),
            include_thoughts: true,
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, Some(true));

        // K2.5 不支持 keep 参数
        assert_eq!(body.get("thinking"), Some(&json!({"type": "enabled"})));
    }

    #[test]
    fn test_k27_code_forces_thinking_and_keep_all() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2.7-code".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        // 即使外部尝试禁用，K2.7-code 也强制思考 + keep: "all"
        adapter.apply_reasoning_config(&mut body, &config, Some(false));

        assert_eq!(
            body.get("thinking"),
            Some(&json!({"type": "enabled", "keep": "all"}))
        );
    }

    #[test]
    fn test_k26_tool_choice_constraint() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2.6".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("tool_choice".to_string(), json!("required")); // 不支持

        adapter.apply_reasoning_config(&mut body, &config, Some(true));

        // thinking 模式下 tool_choice 应被强制为 auto
        assert_eq!(body.get("tool_choice"), Some(&json!("auto")));
    }

    #[test]
    fn test_new_gen_passback_policy() {
        let adapter = MoonshotAdapter;
        for model in ["kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code"] {
            let config = ApiConfig {
                model: model.to_string(),
                ..Default::default()
            };
            // 新代际统一使用 DeepSeekStyle 回传策略
            assert_eq!(
                adapter.get_passback_policy(&config),
                PassbackPolicy::DeepSeekStyle,
                "model: {}",
                model
            );
        }
    }

    // ========== K3+ 测试用例 ==========

    #[test]
    fn test_k3_forces_reasoning_effort_max() {
        let adapter = MoonshotAdapter;
        for model in [
            "kimi-k3",
            "kimi-k3-0905-preview",
            "moonshotai/Kimi-K3-Instruct",
        ] {
            let config = ApiConfig {
                model: model.to_string(),
                ..Default::default()
            };
            let mut body = Map::new();
            body.insert("thinking".to_string(), json!({"type": "enabled"}));
            body.insert("enable_thinking".to_string(), json!(false));
            body.insert("thinking_budget".to_string(), json!(8192));

            // 即使外部尝试禁用，K3 推理也不可关闭（与前端 canDisable=false 对齐）
            let handled = adapter.apply_reasoning_config(&mut body, &config, Some(false));

            assert!(handled, "model: {}", model);
            // 服务端拒绝 K2.x thinking 对象，必须整体移除
            assert!(!body.contains_key("thinking"), "model: {}", model);
            assert!(!body.contains_key("enable_thinking"), "model: {}", model);
            assert!(!body.contains_key("thinking_budget"), "model: {}", model);
            assert_eq!(
                body.get("reasoning_effort"),
                Some(&json!("max")),
                "model: {}",
                model
            );
        }
    }

    #[test]
    fn test_legacy_k2_not_treated_as_new_gen() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2-0905-preview".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(0.7));

        let early_return = adapter.apply_reasoning_config(&mut body, &config, None);

        // 遗留快照模型不走新代际路径，采样参数保留
        assert!(!early_return);
        assert_eq!(body.get("temperature"), Some(&json!(0.7)));
        assert!(!body.contains_key("thinking"));
    }

    // ========================================================================
    // MFJS 工具 schema 规范化
    // ========================================================================

    /// 构造 OpenAI function 线格式工具
    fn mfjs_tool(parameters: Value) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": "demo_tool",
                "description": "demo",
                "parameters": parameters,
            }
        })
    }

    #[test]
    fn mfjs_distributes_root_constraints_into_anyof_branches() {
        // builtin-chatanki_wait / user_todo_update_list 的真实形状：
        // 根级 type:object + properties + anyOf 分支仅含 required
        let mut tools = vec![mfjs_tool(json!({
            "type": "object",
            "properties": {
                "documentId": { "type": "string" },
                "ankiBlockId": { "type": "string" }
            },
            "anyOf": [
                { "required": ["documentId"] },
                { "required": ["ankiBlockId"] }
            ],
            "additionalProperties": false
        }))];

        let rewrites = normalize_tool_schemas_for_mfjs(&mut tools);

        assert_eq!(rewrites, 1);
        let params = &tools[0]["function"]["parameters"];
        // Ultra 级 anyOf 同级只允许 description/title → 约束全部内联进分支
        assert_eq!(
            params,
            &json!({
                "anyOf": [
                    {
                        "type": "object",
                        "properties": {
                            "documentId": { "type": "string" },
                            "ankiBlockId": { "type": "string" }
                        },
                        "required": ["documentId"],
                        "additionalProperties": false
                    },
                    {
                        "type": "object",
                        "properties": {
                            "documentId": { "type": "string" },
                            "ankiBlockId": { "type": "string" }
                        },
                        "required": ["ankiBlockId"],
                        "additionalProperties": false
                    }
                ]
            })
        );
    }

    #[test]
    fn mfjs_distributes_nested_and_rewrites_null_enum_and_drops_unsupported() {
        // builtin-chatanki_update_card 的真实形状：嵌套 patch 对象
        // type+anyOf 同层、{enum:[null]} 可空写法、minProperties 不支持
        let mut tools = vec![mfjs_tool(json!({
            "type": "object",
            "properties": {
                "cardId": { "type": "string" },
                "expectedReviewVersion": {
                    "anyOf": [
                        { "type": "integer", "minimum": 0 },
                        { "enum": [null] }
                    ],
                    "description": "reviewState=null 时显式传 null"
                },
                "patch": {
                    "type": "object",
                    "minProperties": 1,
                    "properties": {
                        "front": { "type": "string" },
                        "text": { "type": "string" }
                    },
                    "anyOf": [
                        { "required": ["front"] },
                        { "required": ["text"] }
                    ],
                    "additionalProperties": false
                }
            },
            "required": ["cardId"]
        }))];

        let rewrites = normalize_tool_schemas_for_mfjs(&mut tools);

        // minProperties 丢弃 + enum-null 改写 + patch 分发 = 3
        assert_eq!(rewrites, 3);
        let params = &tools[0]["function"]["parameters"];
        // 根级无 anyOf，type/required 保留
        assert_eq!(params.get("type"), Some(&json!("object")));
        assert_eq!(params.get("required"), Some(&json!(["cardId"])));
        // {enum:[null]} → {type:"null"}；description 可留在 anyOf 同级
        assert_eq!(
            params["properties"]["expectedReviewVersion"],
            json!({
                "anyOf": [
                    { "type": "integer", "minimum": 0 },
                    { "type": "null" }
                ],
                "description": "reviewState=null 时显式传 null"
            })
        );
        // 嵌套 patch：约束全内联进分支
        assert_eq!(
            params["properties"]["patch"],
            json!({
                "anyOf": [
                    {
                        "type": "object",
                        "properties": {
                            "front": { "type": "string" },
                            "text": { "type": "string" }
                        },
                        "required": ["front"],
                        "additionalProperties": false
                    },
                    {
                        "type": "object",
                        "properties": {
                            "front": { "type": "string" },
                            "text": { "type": "string" }
                        },
                        "required": ["text"],
                        "additionalProperties": false
                    }
                ]
            })
        );
    }

    #[test]
    fn mfjs_rewrites_oneof_with_discriminator_branches() {
        // builtin-settings_set 的真实形状：根级 oneOf，分支是带收窄 enum 的
        // 完整 object（鉴别器模式），分支自身的 key/value 必须赢过父级
        let mut tools = vec![mfjs_tool(json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "key": { "type": "string", "enum": ["theme", "theme_palette"] },
                "value": {}
            },
            "oneOf": [
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["key", "value"],
                    "properties": {
                        "key": { "type": "string", "enum": ["theme"] },
                        "value": { "type": "string", "enum": ["light", "dark", "auto"] }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["key", "value"],
                    "properties": {
                        "key": { "type": "string", "enum": ["theme_palette"] },
                        "value": { "type": "string", "enum": ["default", "custom"] }
                    }
                }
            ]
        }))];

        let rewrites = normalize_tool_schemas_for_mfjs(&mut tools);

        // oneOf→anyOf + 根级分发 = 2
        assert_eq!(rewrites, 2);
        let params = &tools[0]["function"]["parameters"];
        assert!(params.get("oneOf").is_none());
        // 根级只剩 anyOf
        assert_eq!(params.as_object().unwrap().keys().count(), 1);
        // 分支保留自己的收窄 enum（鉴别器语义不被父级宽约束覆盖）
        assert_eq!(
            params["anyOf"][0]["properties"]["key"],
            json!({ "type": "string", "enum": ["theme"] })
        );
        assert_eq!(
            params["anyOf"][1]["properties"]["value"],
            json!({ "type": "string", "enum": ["default", "custom"] })
        );
        assert_eq!(params["anyOf"][0]["required"], json!(["key", "value"]));
    }

    #[test]
    fn mfjs_rewrites_const_and_drops_unique_items() {
        // workbench setZoom 形状（const）+ user_todo RRULE 形状（uniqueItems）
        let mut tools = vec![mfjs_tool(json!({
            "type": "object",
            "properties": {
                "zoom": {
                    "anyOf": [
                        { "type": "number", "minimum": 10, "maximum": 800 },
                        { "type": "string", "const": "fit" }
                    ]
                },
                "byWeekday": {
                    "type": "array",
                    "items": { "type": "integer", "minimum": 0, "maximum": 6 },
                    "uniqueItems": true
                }
            },
            "required": ["zoom"]
        }))];

        let rewrites = normalize_tool_schemas_for_mfjs(&mut tools);

        // const→enum + uniqueItems 丢弃 = 2
        assert_eq!(rewrites, 2);
        let params = &tools[0]["function"]["parameters"];
        assert_eq!(
            params["properties"]["zoom"]["anyOf"],
            json!([
                { "type": "number", "minimum": 10, "maximum": 800 },
                { "type": "string", "enum": ["fit"] }
            ])
        );
        assert_eq!(
            params["properties"]["byWeekday"],
            json!({
                "type": "array",
                "items": { "type": "integer", "minimum": 0, "maximum": 6 }
            })
        );
    }

    #[test]
    fn mfjs_leaves_compliant_schemas_untouched() {
        // 已合规：anyOf 分支自带 type、同级仅 description（MFJS 官方示例形状）
        let compliant = mfjs_tool(json!({
            "type": "object",
            "properties": {
                "qs": {
                    "anyOf": [
                        { "type": "string" },
                        { "type": "array", "items": { "type": "string" } }
                    ],
                    "description": "place your query or queries here"
                }
            },
            "required": ["qs"]
        }));
        // 无 anyOf 的普通 schema
        let plain = mfjs_tool(json!({
            "type": "object",
            "properties": { "q": { "type": "string" } }
        }));
        let mut tools = vec![compliant.clone(), plain.clone()];

        let rewrites = normalize_tool_schemas_for_mfjs(&mut tools);

        assert_eq!(rewrites, 0);
        assert_eq!(tools, vec![compliant, plain]);
    }

    #[test]
    fn mfjs_unions_required_when_distributing() {
        // user_todo_update_list 形状：根级 required 与分支 required 取并集
        let mut tools = vec![mfjs_tool(json!({
            "type": "object",
            "properties": {
                "list_id": { "type": "string", "minLength": 1 },
                "title": { "type": "string" },
                "expected_updated_at": { "type": "string" }
            },
            "required": ["list_id", "expected_updated_at"],
            "anyOf": [{ "required": ["title"] }]
        }))];

        normalize_tool_schemas_for_mfjs(&mut tools);

        assert_eq!(
            tools[0]["function"]["parameters"]["anyOf"][0]["required"],
            json!(["title", "list_id", "expected_updated_at"])
        );
        assert_eq!(
            tools[0]["function"]["parameters"]["anyOf"][0]["type"],
            json!("object")
        );
    }

    #[test]
    fn mfjs_infers_type_for_bare_enum() {
        // builtin-chatanki_export / transform 的真实形状：
        // {const:"json", enum:["json"]} 去 const 后成为裸 enum
        let mut tools = vec![mfjs_tool(json!({
            "type": "object",
            "properties": {
                "format": { "const": "json", "enum": ["json"] },
                "count": { "enum": [1, 2, 3] },
                "ratio": { "enum": [0.5, 1.5] },
                "flag": { "enum": [true, false] }
            }
        }))];

        let rewrites = normalize_tool_schemas_for_mfjs(&mut tools);

        // format: 去 const + 推断 type = 2；count/ratio/flag 各 1 = 5
        assert_eq!(rewrites, 5);
        let props = &tools[0]["function"]["parameters"]["properties"];
        assert_eq!(
            props["format"],
            json!({ "type": "string", "enum": ["json"] })
        );
        assert_eq!(
            props["count"],
            json!({ "type": "integer", "enum": [1, 2, 3] })
        );
        assert_eq!(
            props["ratio"],
            json!({ "type": "number", "enum": [0.5, 1.5] })
        );
        assert_eq!(
            props["flag"],
            json!({ "type": "boolean", "enum": [true, false] })
        );
    }

    #[test]
    fn mfjs_drops_parent_annotation_when_branch_defines_it() {
        // builtin-mindmap_update 的真实形状：anyOf 父级与分支同时有 description
        // （walle Ultra 冲突规则 → 删父级副本，保留分支的更具体注解）
        let mut tools = vec![mfjs_tool(json!({
            "type": "object",
            "properties": {
                "content": {
                    "oneOf": [
                        { "type": "string", "description": "JSON 字符串" },
                        { "type": "object", "description": "对象格式" }
                    ],
                    "description": "完整 MindMapDocument（字符串或对象）"
                }
            }
        }))];

        let rewrites = normalize_tool_schemas_for_mfjs(&mut tools);

        assert_eq!(rewrites, 2);
        let content = &tools[0]["function"]["parameters"]["properties"]["content"];
        assert!(content.get("description").is_none());
        assert_eq!(content["anyOf"][0]["description"], json!("JSON 字符串"));
        assert_eq!(content["anyOf"][1]["description"], json!("对象格式"));
    }

    /// 递归断言：MFJS 不支持的关键字、anyOf 非法同级键、裸 enum 均不存在
    fn assert_mfjs_clean(node: &Value, path: &str) {
        match node {
            Value::Object(map) => {
                for banned in [
                    "uniqueItems",
                    "minProperties",
                    "maxProperties",
                    "exclusiveMinimum",
                    "exclusiveMaximum",
                    "oneOf",
                    "allOf",
                    "const",
                ] {
                    assert!(!map.contains_key(banned), "{banned} remains at {path}");
                }
                if map.contains_key("anyOf") {
                    for k in map.keys() {
                        assert!(
                            matches!(
                                k.as_str(),
                                "anyOf" | "description" | "title" | "$defs" | "$id"
                            ),
                            "anyOf sibling '{k}' at {path}"
                        );
                    }
                }
                if map.contains_key("enum") {
                    assert!(map.contains_key("type"), "bare enum at {path}");
                }
                for (k, v) in map {
                    assert_mfjs_clean(v, &format!("{path}.{k}"));
                }
            }
            Value::Array(arr) => {
                for (i, v) in arr.iter().enumerate() {
                    assert_mfjs_clean(v, &format!("{path}[{i}]"));
                }
            }
            _ => {}
        }
    }

    #[test]
    fn mfjs_normalizes_real_rust_builtin_tool_schemas() {
        // Rust 侧真实内置工具（user_todo 系）必须全部通过规范化
        let mut tools = crate::chat_v2::tools::user_todo_executor::get_user_todo_schemas();
        let rewrites = normalize_tool_schemas_for_mfjs(&mut tools);
        assert!(rewrites > 0, "user_todo schemas should need rewrites");

        for tool in &tools {
            let name = tool["function"]["name"].as_str().unwrap_or("<unnamed>");
            assert_mfjs_clean(&tool["function"]["parameters"], name);
        }

        let update = tools
            .iter()
            .find(|t| t["function"]["name"] == json!("user_todo_update_list"))
            .expect("user_todo_update_list schema");
        let params = update["function"]["parameters"]
            .as_object()
            .expect("parameters object");
        assert_eq!(params.keys().collect::<Vec<_>>(), vec!["anyOf"]);
    }

    #[test]
    fn mfjs_gate_matches_moonshot_configs() {
        // 内置 vendor：adapter 命中
        assert!(should_apply_mfjs_tool_schema_dialect(&ApiConfig {
            model_adapter: "moonshot".to_string(),
            model: "kimi-k3".to_string(),
            base_url: "https://api.moonshot.cn/v1".to_string(),
            ..Default::default()
        }));
        // Kimi coding plan 自定义 vendor：通用适配器 + api.kimi.com 域名命中
        assert!(should_apply_mfjs_tool_schema_dialect(&ApiConfig {
            model_adapter: "openai".to_string(),
            model: "kimi-for-coding".to_string(),
            base_url: "https://api.kimi.com/coding/v1".to_string(),
            ..Default::default()
        }));
        // 中转反代：仅模型名命中
        assert!(should_apply_mfjs_tool_schema_dialect(&ApiConfig {
            model_adapter: "openai".to_string(),
            model: "kimi-k3-max".to_string(),
            base_url: "http://47.88.78.106/v1".to_string(),
            ..Default::default()
        }));
        // 普通 OpenAI 配置：不命中
        assert!(!should_apply_mfjs_tool_schema_dialect(&ApiConfig {
            model_adapter: "openai".to_string(),
            model: "gpt-5.6".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            ..Default::default()
        }));
    }
}
