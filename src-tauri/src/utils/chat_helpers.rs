use crate::models::ChatMessage;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use tauri::{Emitter, Window};

fn provider_icon_for_origin(origin: &str) -> &'static str {
    match origin {
        "memory" => "memory",
        "web_search" => "search",
        "tool" => "tool",
        "graph" => "graph",
        _ => "rag",
    }
}

fn infer_provider_info(
    origin: &str,
    metadata: Option<&HashMap<String, String>>,
    fallback_label: &str,
    document_id: &str,
) -> (String, String, String) {
    let provider_id = metadata
        .and_then(|meta| {
            meta.get("library_name")
                .or_else(|| meta.get("library"))
                .or_else(|| meta.get("subject"))
                .or_else(|| meta.get("source_type"))
                .map(|v| v.to_string())
        })
        .unwrap_or_else(|| format!("{}:{}", origin, document_id));

    let provider_label = metadata
        .and_then(|meta| {
            meta.get("library_name")
                .or_else(|| meta.get("library"))
                .or_else(|| meta.get("subject"))
                .map(|v| v.to_string())
        })
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| fallback_label.to_string());

    let icon = provider_icon_for_origin(origin).to_string();

    (provider_id, provider_label, icon)
}

fn augment_source_metadata(
    origin: &str,
    metadata: Option<&HashMap<String, String>>,
    file_name: &str,
    document_id: &str,
    source: &mut Value,
) {
    if let Value::Object(ref mut obj) = source {
        let (provider_id, provider_label, provider_icon) =
            infer_provider_info(origin, metadata, file_name, document_id);
        obj.insert("origin".into(), Value::String(origin.to_string()));
        obj.insert("provider_id".into(), Value::String(provider_id));
        obj.insert("provider_label".into(), Value::String(provider_label));
        obj.insert("provider_icon".into(), Value::String(provider_icon));
        obj.insert("provider_group".into(), Value::String(origin.to_string()));
    }
}

fn emit_unified_sources(window: &Window, stream_event: &str, stage: &str, sources: &[Value]) {
    if sources.is_empty() {
        return;
    }

    let mut total = 0usize;
    let mut groups: BTreeMap<String, serde_json::Value> = BTreeMap::new();

    for source in sources {
        if let Value::Object(obj) = source {
            let origin = obj
                .get("provider_group")
                .and_then(|v| v.as_str())
                .or_else(|| obj.get("origin").and_then(|v| v.as_str()))
                .unwrap_or("rag");
            let provider_id = obj
                .get("provider_id")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown_provider");
            let provider_label = obj
                .get("provider_label")
                .and_then(|v| v.as_str())
                .unwrap_or(provider_id);
            let provider_icon = obj
                .get("provider_icon")
                .and_then(|v| v.as_str())
                .unwrap_or_else(|| provider_icon_for_origin(origin));

            let key = format!("{}::{}", origin, provider_id);
            let entry = groups.entry(key).or_insert_with(|| {
                json!({
                    "group": origin,
                    "provider_id": provider_id,
                    "provider_label": provider_label,
                    "provider_icon": provider_icon,
                    "items": Vec::<Value>::new(),
                })
            });

            if let Value::Object(entry_obj) = entry {
                if let Some(items) = entry_obj.get_mut("items").and_then(|v| v.as_array_mut()) {
                    items.push(source.clone());
                }
            }

            total += 1;
        }
    }

    if total == 0 {
        return;
    }

    let normalized_groups: Vec<Value> = groups
        .into_iter()
        .map(|(_, value)| {
            if let Value::Object(mut obj) = value {
                let count = if let Some(items_value) = obj.get_mut("items") {
                    if let Some(items) = items_value.as_array_mut() {
                        items.sort_by(|a, b| {
                            let score_a = a
                                .as_object()
                                .and_then(|o| o.get("score"))
                                .and_then(|s| s.as_f64())
                                .unwrap_or(0.0);
                            let score_b = b
                                .as_object()
                                .and_then(|o| o.get("score"))
                                .and_then(|s| s.as_f64())
                                .unwrap_or(0.0);
                            score_b
                                .partial_cmp(&score_a)
                                .unwrap_or(std::cmp::Ordering::Equal)
                        });
                        items.len() as u64
                    } else {
                        0
                    }
                } else {
                    0
                };
                obj.insert("count".into(), Value::Number(count.into()));
                Value::Object(obj)
            } else {
                value
            }
        })
        .collect();

    let payload = json!({
        "stage": stage,
        "total": total,
        "groups": normalized_groups,
    });

    let event_name = format!("{}_unified_sources", stream_event);
    if let Err(e) = window.emit(&event_name, &payload) {
        log::debug!("emit unified_sources failed: {}", e);
    }
}

/// 构建错题场景的上下文
///
/// 参数：
/// - subject: 学科
/// - ocr_text: OCR识别的题目文本
/// - tags: 标签
/// - mistake_type: 错误类型
/// - user_question: 用户问题
/// - additional_docs: 附加文档内容
///
/// 返回：上下文哈希表
pub fn build_mistake_context(
    subject: &str,
    ocr_text: &str,
    tags: &[String],
    mistake_type: &str,
    user_question: &str,
    additional_docs: Option<&str>,
) -> HashMap<String, Value> {
    let mut context = HashMap::new();

    context.insert("subject".to_string(), Value::String(subject.to_string()));
    context.insert("ocr_text".to_string(), Value::String(ocr_text.to_string()));
    context.insert(
        "tags".to_string(),
        Value::Array(tags.iter().map(|tag| Value::String(tag.clone())).collect()),
    );
    context.insert(
        "mistake_type".to_string(),
        Value::String(mistake_type.to_string()),
    );
    context.insert(
        "user_question".to_string(),
        Value::String(user_question.to_string()),
    );

    if let Some(docs) = additional_docs {
        context.insert(
            "additional_documents".to_string(),
            Value::String(docs.to_string()),
        );
    }

    context
}

/// 构建回顾分析的上下文
///
/// 参数：
/// - subject: 学科
/// - consolidated_input: 综合输入内容
/// - overall_prompt: 整体提示（可选）
///
/// 返回：上下文哈希表
pub fn build_review_context(
    subject: &str,
    consolidated_input: &str,
    overall_prompt: Option<&str>,
) -> HashMap<String, Value> {
    let mut context = HashMap::new();

    context.insert("subject".to_string(), Value::String(subject.to_string()));
    context.insert(
        "consolidated_input".to_string(),
        Value::String(consolidated_input.to_string()),
    );

    if let Some(prompt) = overall_prompt {
        context.insert(
            "overall_prompt".to_string(),
            Value::String(prompt.to_string()),
        );
    }

    context
}

/// 将图片合并到聊天历史的最后一条用户消息中
///
/// 参数：
/// - history: 聊天历史（可变引用）
/// - imgs_base64: 本轮新增的图片（base64格式）
/// - pin_imgs: 固定的图片（可选）
///
/// 返回：合并的图片总数
pub fn merge_images_into_user_message(
    history: &mut Vec<ChatMessage>,
    imgs_base64: &[String],
    pin_imgs: Option<&[String]>,
) -> usize {
    // 查找最后一条用户消息
    if let Some(last_user_idx) = history.iter().rposition(|m| m.role == "user") {
        let mut last_user_msg = history[last_user_idx].clone();

        // 获取现有图片
        let mut merged_images = last_user_msg.image_base64.clone().unwrap_or_default();

        // 添加本轮新增图片
        for img in imgs_base64 {
            if !merged_images.contains(img) {
                merged_images.push(img.clone());
            }
        }

        // 添加固定图片
        if let Some(pin_images) = pin_imgs {
            for pin_img in pin_images {
                if !merged_images.contains(pin_img) {
                    merged_images.push(pin_img.clone());
                }
            }
        }

        // 更新消息
        if !merged_images.is_empty() {
            last_user_msg.image_base64 = Some(merged_images.clone());
            history[last_user_idx] = last_user_msg;
            return merged_images.len();
        }
    }

    0
}

fn truncate_snippet(input: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    let trimmed = input.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let mut result = String::with_capacity(max_chars + 1);
    for (idx, ch) in trimmed.chars().enumerate() {
        if idx >= max_chars {
            result.push('…');
            break;
        }
        result.push(ch);
    }
    result
}
