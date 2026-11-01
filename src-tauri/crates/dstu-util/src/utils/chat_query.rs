use serde_json::Value;
use std::collections::HashMap;

/// 从聊天历史和附加文本构造统一的查询字符串
///
/// 参数：
/// - chat_history: 聊天历史记录
/// - fallback_texts: 后备文本数组，用于在聊天历史为空时使用
///
/// 返回：合并后的查询字符串
pub fn derive_latest_user_query(
    chat_history: &[crate::models::ChatMessage],
    fallback_texts: &[String],
) -> String {
    let mut query_parts = Vec::new();

    // 1. 优先从聊天历史中提取最新的用户消息
    if let Some(latest_user_msg) = chat_history.iter().rev().find(|msg| msg.role == "user") {
        if !latest_user_msg.content.trim().is_empty() {
            query_parts.push(latest_user_msg.content.clone());
        }

        // 2. 提取用户消息中的文档附件文本
        if let Some(ref doc_attachments) = latest_user_msg.doc_attachments {
            for doc in doc_attachments {
                if let Some(ref text_content) = doc.text_content {
                    if !text_content.trim().is_empty() {
                        query_parts.push(format!("文档内容: {}", text_content));
                    }
                }
            }
        }
    }

    // 3. 如果聊天历史没有有效内容，使用后备文本
    if query_parts.is_empty() {
        for fallback in fallback_texts {
            if !fallback.trim().is_empty() {
                query_parts.push(fallback.clone());
            }
        }
    }

    // 4. 合并所有查询部分
    if query_parts.is_empty() {
        "".to_string()
    } else {
        query_parts.join(" ")
    }
}

/// 从错题场景构造查询字符串（特化版本）
///
/// 参数：
/// - chat_history: 聊天历史记录
/// - ocr_text: OCR识别的题目文本
/// - user_question: 用户问题
/// - doc_attachments: 文档附件（可选）
///
/// 返回：合并后的查询字符串
pub fn derive_mistake_query(
    chat_history: &[crate::models::ChatMessage],
    ocr_text: &str,
    user_question: &str,
    doc_attachments: Option<&[crate::models::DocumentAttachment]>,
) -> String {
    let mut query_parts = Vec::new();

    // 1. 优先从聊天历史中提取最新的用户消息
    if let Some(latest_user_msg) = chat_history.iter().rev().find(|msg| msg.role == "user") {
        if !latest_user_msg.content.trim().is_empty() {
            query_parts.push(latest_user_msg.content.clone());
        }

        // 提取用户消息中的文档附件文本
        if let Some(ref msg_doc_attachments) = latest_user_msg.doc_attachments {
            for doc in msg_doc_attachments {
                if let Some(ref text_content) = doc.text_content {
                    if !text_content.trim().is_empty() {
                        query_parts.push(format!("文档内容: {}", text_content));
                    }
                }
            }
        }
    }

    // 2. 如果聊天历史没有有效内容，使用错题特有的组合
    if query_parts.is_empty() {
        // 用户问题
        if !user_question.trim().is_empty() {
            query_parts.push(user_question.to_string());
        }

        // OCR文本
        if !ocr_text.trim().is_empty() {
            query_parts.push(ocr_text.to_string());
        }

        // 文档附件
        if let Some(docs) = doc_attachments {
            for doc in docs {
                if let Some(ref text_content) = doc.text_content {
                    if !text_content.trim().is_empty() {
                        query_parts.push(format!("文档内容: {}", text_content));
                    }
                }
            }
        }
    }

    // 3. 合并所有查询部分
    if query_parts.is_empty() {
        "".to_string()
    } else {
        query_parts.join(" ")
    }
}

/// 从上下文哈希表和聊天历史构造查询字符串
///
/// 参数：
/// - context: 上下文哈希表（包含 ocr_text, user_question 等）
/// - chat_history: 聊天历史记录
///
/// 返回：合并后的查询字符串
pub fn derive_query_from_context(
    context: &HashMap<String, Value>,
    chat_history: &[crate::models::ChatMessage],
) -> String {
    // 先尝试从聊天历史提取
    let query_from_history = derive_latest_user_query(chat_history, &[]);

    if !query_from_history.trim().is_empty() {
        return query_from_history;
    }

    // 如果聊天历史为空，从上下文提取
    let mut query_parts = Vec::new();

    // 提取用户问题
    if let Some(user_question) = context.get("user_question") {
        if let Some(question_str) = user_question.as_str() {
            if !question_str.trim().is_empty() {
                query_parts.push(question_str.to_string());
            }
        }
    }

    // 提取OCR文本
    if let Some(ocr_text) = context.get("ocr_text") {
        if let Some(ocr_str) = ocr_text.as_str() {
            if !ocr_str.trim().is_empty() {
                query_parts.push(ocr_str.to_string());
            }
        }
    }

    // 提取附加文档
    if let Some(additional_docs) = context.get("additional_documents") {
        if let Some(docs_str) = additional_docs.as_str() {
            if !docs_str.trim().is_empty() {
                query_parts.push(docs_str.to_string());
            }
        }
    }

    query_parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ChatMessage;
    use chrono::Utc;

    #[test]
    fn test_derive_latest_user_query_from_history() {
        let chat_history = vec![
            ChatMessage {
                role: "user".to_string(),
                content: "这道题怎么解?".to_string(),
                timestamp: Utc::now(),
                thinking_content: None,
                thought_signature: None,
                rag_sources: None,
                memory_sources: None,
                graph_sources: None,
                web_search_sources: None,
                image_paths: None,
                image_base64: None,
                doc_attachments: None,
                multimodal_content: None,
                tool_call: None,
                tool_result: None,
                overrides: None,
                relations: None,
                persistent_stable_id: None,
                metadata: None,
            },
            ChatMessage {
                role: "assistant".to_string(),
                content: "助手回答".to_string(),
                timestamp: Utc::now(),
                thinking_content: None,
                thought_signature: None,
                rag_sources: None,
                memory_sources: None,
                graph_sources: None,
                web_search_sources: None,
                image_paths: None,
                image_base64: None,
                doc_attachments: None,
                multimodal_content: None,
                tool_call: None,
                tool_result: None,
                overrides: None,
                relations: None,
                persistent_stable_id: None,
                metadata: None,
            },
        ];

        let query = derive_latest_user_query(&chat_history, &["fallback".to_string()]);
        assert_eq!(query, "这道题怎么解?");
    }

    #[test]
    fn test_derive_latest_user_query_fallback() {
        let chat_history = vec![];
        let fallback_texts = vec!["用户问题".to_string(), "OCR文本".to_string()];

        let query = derive_latest_user_query(&chat_history, &fallback_texts);
        assert_eq!(query, "用户问题 OCR文本");
    }

    #[test]
    fn test_derive_mistake_query() {
        let chat_history = vec![];
        let ocr_text = "2x + 3 = 7";
        let user_question = "这道方程怎么解?";

        let query = derive_mistake_query(&chat_history, ocr_text, user_question, None);
        assert_eq!(query, "这道方程怎么解? 2x + 3 = 7");
    }
}
