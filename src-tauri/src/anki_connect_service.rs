use crate::models::AnkiCard;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::TcpStream;
use std::time::Duration;

const ANKI_CONNECT_URL: &str = "http://127.0.0.1:8765";

#[derive(Serialize)]
struct AnkiConnectRequest {
    action: String,
    version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct AnkiConnectResponse {
    result: Option<serde_json::Value>,
    error: Option<String>,
}

#[derive(Serialize)]
struct Note {
    #[serde(rename = "deckName")]
    deck_name: String,
    #[serde(rename = "modelName")]
    model_name: String,
    fields: HashMap<String, String>,
    tags: Vec<String>,
}

fn normalize_key(key: &str) -> String {
    key.chars()
        .filter(|c| c.is_alphanumeric())
        .collect::<String>()
}

fn build_basic_fields(card: &AnkiCard, note_type: &str) -> HashMap<String, String> {
    let mut fields = HashMap::new();

    match note_type {
        "Basic" | "Basic (and reversed card)" | "Basic (optional reversed card)" => {
            fields.insert("Front".to_string(), card.front.clone());
            fields.insert("Back".to_string(), card.back.clone());
        }
        "Cloze" => {
            let cloze_text = if let Some(text) = &card.text {
                if !text.trim().is_empty() {
                    text.clone()
                } else if card.back.is_empty() {
                    card.front.clone()
                } else {
                    format!("{}\n\n{}", card.front, card.back)
                }
            } else if card.back.is_empty() {
                card.front.clone()
            } else {
                format!("{}\n\n{}", card.front, card.back)
            };
            fields.insert("Text".to_string(), cloze_text);
            // Keep back-side explanation in Extra for Cloze (best-effort).
            if !card.back.trim().is_empty() {
                fields.insert("Extra".to_string(), card.back.clone());
            }
        }
        _ => {
            fields.insert("Front".to_string(), card.front.clone());
            fields.insert("Back".to_string(), card.back.clone());
        }
    }

    fields
}

fn build_fields_with_model_names(
    card: &AnkiCard,
    model_field_names: &[String],
    note_type: &str,
) -> HashMap<String, String> {
    if model_field_names.is_empty() {
        return build_basic_fields(card, note_type);
    }

    let mut lower_extra: HashMap<String, String> = card
        .extra_fields
        .iter()
        .map(|(k, v)| (k.to_lowercase(), v.clone()))
        .collect();

    lower_extra
        .entry("front".to_string())
        .or_insert_with(|| card.front.clone());
    lower_extra
        .entry("back".to_string())
        .or_insert_with(|| card.back.clone());
    if let Some(text) = &card.text {
        lower_extra.insert("text".to_string(), text.clone());
    }

    if !card.tags.is_empty() {
        lower_extra.insert("tags".to_string(), card.tags.join(" "));
    }

    let mut normalized_extra: HashMap<String, String> = HashMap::new();
    for (key, value) in lower_extra.iter() {
        normalized_extra.insert(normalize_key(key), value.clone());
    }

    model_field_names
        .iter()
        .map(|field_name| {
            let lower = field_name.to_lowercase();
            let normalized = normalize_key(&lower);
            let value = if lower == "front" {
                card.front.clone()
            } else if lower == "back" {
                card.back.clone()
            } else if lower == "extra" {
                lower_extra
                    .get("extra")
                    .cloned()
                    .unwrap_or_else(|| card.back.clone())
            } else if lower == "text" {
                if note_type.eq_ignore_ascii_case("Cloze") {
                    if let Some(text) = lower_extra.get("text") {
                        text.clone()
                    } else if !card.back.is_empty() {
                        format!("{}\n\n{}", card.front, card.back)
                    } else {
                        card.front.clone()
                    }
                } else {
                    lower_extra.get("text").cloned().unwrap_or_default()
                }
            } else if normalized == "backextra" {
                normalized_extra
                    .get(&normalized)
                    .cloned()
                    .unwrap_or_else(|| card.back.clone())
            } else if lower == "tags" {
                lower_extra.get("tags").cloned().unwrap_or_default()
            } else {
                normalized_extra
                    .get(&normalized)
                    .or_else(|| lower_extra.get(&lower))
                    .cloned()
                    .unwrap_or_default()
            };

            (field_name.clone(), value)
        })
        .collect()
}

/// 检查AnkiConnect是否可用
#[tauri::command]
pub async fn check_anki_connect_availability() -> Result<bool, String> {
    println!("🔍 正在检查AnkiConnect连接到: {}", ANKI_CONNECT_URL);

    // 首先检查端口8765是否开放
    println!("🔍 第0步：检查端口8765是否开放...");
    let local_anki_addr = std::net::SocketAddr::from(([127, 0, 0, 1], 8765));
    match TcpStream::connect_timeout(&local_anki_addr, Duration::from_secs(5)) {
        Ok(_) => {
            println!("✅ 端口8765可访问");
        }
        Err(e) => {
            println!("❌ 端口8765无法访问: {}", e);
            return Err(format!("端口8765无法访问: {} \n\n这通常意味着：\n1. Anki桌面程序未运行\n2. AnkiConnect插件未安装或未启用\n3. 端口被其他程序占用\n\n解决方法：\n1. 启动Anki桌面程序\n2. 安装AnkiConnect插件（代码：2055492159）\n3. 重启Anki以激活插件", e));
        }
    }

    // 首先尝试简单的GET请求检查服务是否运行
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .tcp_keepalive(Some(std::time::Duration::from_secs(30)))
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("创建HTTP客户端失败: {}", e))?;

    println!("🔍 第一步：尝试探测AnkiConnect（GET 非阻塞）...");
    match client.get(ANKI_CONNECT_URL).send().await {
        Ok(response) => {
            println!("✅ AnkiConnect GET 响应状态: {}", response.status());
        }
        Err(e) => {
            // 有些版本/配置可能不响应GET，这里仅记录告警并继续进行POST版本探测
            println!("⚠️ AnkiConnect GET 探测失败（忽略，继续版本检测）: {}", e);
        }
    }

    // 如果基础连接成功，再尝试API请求
    println!("🔍 第二步：测试AnkiConnect API...");
    let request = AnkiConnectRequest {
        action: "version".to_string(),
        version: 6,
        params: None,
    };

    println!(
        "📤 发送API请求: {}",
        serde_json::to_string(&request).unwrap_or_else(|_| "序列化失败".to_string())
    );

    match client
        .post(ANKI_CONNECT_URL)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("User-Agent", "DeepStudent/1.0")
        .json(&request)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
    {
        Ok(response) => {
            let status_code = response.status();
            println!("📥 收到响应状态: {}", status_code);
            if status_code.is_success() {
                let response_text = response
                    .text()
                    .await
                    .map_err(|e| format!("读取响应内容失败: {}", e))?;
                println!("📥 响应内容: {}", response_text);

                match serde_json::from_str::<AnkiConnectResponse>(&response_text) {
                    Ok(anki_response) => {
                        if anki_response.error.is_none() {
                            println!("✅ AnkiConnect版本检查成功");
                            Ok(true)
                        } else {
                            Err(format!(
                                "AnkiConnect错误: {}",
                                anki_response.error.unwrap_or_default()
                            ))
                        }
                    }
                    Err(e) => Err(format!(
                        "解析AnkiConnect响应失败: {} - 响应内容: {}",
                        e, response_text
                    )),
                }
            } else {
                let error_text = response
                    .text()
                    .await
                    .unwrap_or_else(|_| "无法读取错误内容".to_string());
                Err(format!(
                    "AnkiConnect HTTP错误: {} - 内容: {}",
                    status_code, error_text
                ))
            }
        }
        Err(e) => {
            println!("❌ AnkiConnect连接错误详情: {:?}", e);
            if e.is_timeout() {
                Err(
                    "AnkiConnect连接超时，请确保Anki桌面程序正在运行并启用了AnkiConnect插件"
                        .to_string(),
                )
            } else if e.is_connect() {
                Err("无法连接到AnkiConnect服务器，请确保：1)Anki正在运行 2)AnkiConnect插件已安装并启用 3)端口8765未被占用".to_string())
            } else if e.to_string().contains("connection closed") {
                Err("连接被AnkiConnect服务器关闭，可能原因：1)AnkiConnect版本过旧 2)请求格式不兼容 3)需要重启Anki".to_string())
            } else {
                Err(format!("AnkiConnect连接失败: {}", e))
            }
        }
    }
}

/// 获取所有牌组名称
pub async fn get_deck_names() -> Result<Vec<String>, String> {
    let request = AnkiConnectRequest {
        action: "deckNames".to_string(),
        version: 6,
        params: None,
    };

    let client = reqwest::Client::new();

    match client
        .post(ANKI_CONNECT_URL)
        .json(&request)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
    {
        Ok(response) => {
            if response.status().is_success() {
                match response.json::<AnkiConnectResponse>().await {
                    Ok(anki_response) => {
                        if let Some(error) = anki_response.error {
                            Err(format!("AnkiConnect错误: {}", error))
                        } else if let Some(result) = anki_response.result {
                            match serde_json::from_value::<Vec<String>>(result) {
                                Ok(deck_names) => Ok(deck_names),
                                Err(e) => Err(format!("解析牌组列表失败: {}", e)),
                            }
                        } else {
                            Err("AnkiConnect返回空结果".to_string())
                        }
                    }
                    Err(e) => Err(format!("解析AnkiConnect响应失败: {}", e)),
                }
            } else {
                Err(format!("AnkiConnect HTTP错误: {}", response.status()))
            }
        }
        Err(e) => Err(format!("请求牌组列表失败: {}", e)),
    }
}

/// 获取所有笔记类型名称
pub async fn get_model_names() -> Result<Vec<String>, String> {
    let request = AnkiConnectRequest {
        action: "modelNames".to_string(),
        version: 6,
        params: None,
    };

    let client = reqwest::Client::new();

    match client
        .post(ANKI_CONNECT_URL)
        .json(&request)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
    {
        Ok(response) => {
            if response.status().is_success() {
                match response.json::<AnkiConnectResponse>().await {
                    Ok(anki_response) => {
                        if let Some(error) = anki_response.error {
                            Err(format!("AnkiConnect错误: {}", error))
                        } else if let Some(result) = anki_response.result {
                            match serde_json::from_value::<Vec<String>>(result) {
                                Ok(model_names) => Ok(model_names),
                                Err(e) => Err(format!("解析笔记类型列表失败: {}", e)),
                            }
                        } else {
                            Err("AnkiConnect返回空结果".to_string())
                        }
                    }
                    Err(e) => Err(format!("解析AnkiConnect响应失败: {}", e)),
                }
            } else {
                Err(format!("AnkiConnect HTTP错误: {}", response.status()))
            }
        }
        Err(e) => Err(format!("请求笔记类型列表失败: {}", e)),
    }
}

/// 获取指定模型的字段名列表。
/// 注意：本函数不再内置 AnkiConnect 可用性检查；调用方应自行确保连接可用
/// （当前唯一调用方 `add_notes_to_anki_detailed` 在入口处已检查）。
pub async fn get_model_field_names(model_name: &str) -> Result<Vec<String>, String> {
    let params = serde_json::json!({
        "modelName": model_name
    });

    let request = AnkiConnectRequest {
        action: "modelFieldNames".to_string(),
        version: 6,
        params: Some(params),
    };

    let client = reqwest::Client::new();

    match client
        .post(ANKI_CONNECT_URL)
        .json(&request)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
    {
        Ok(response) => {
            if response.status().is_success() {
                match response.json::<AnkiConnectResponse>().await {
                    Ok(resp) => {
                        if let Some(error) = resp.error {
                            Err(format!("获取模型字段失败: {}", error))
                        } else if let Some(result) = resp.result {
                            serde_json::from_value::<Vec<String>>(result)
                                .map_err(|e| format!("解析模型字段失败: {}", e))
                        } else {
                            Err("AnkiConnect返回空结果".to_string())
                        }
                    }
                    Err(e) => Err(format!("解析AnkiConnect响应失败: {}", e)),
                }
            } else {
                Err(format!("AnkiConnect HTTP错误: {}", response.status()))
            }
        }
        Err(e) => Err(format!("获取模型字段失败: {}", e)),
    }
}

/// 将AnkiCard列表添加到Anki
pub async fn add_notes_to_anki(
    cards: Vec<AnkiCard>,
    deck_name: String,
    note_type: String,
) -> Result<Vec<Option<u64>>, String> {
    add_notes_to_anki_with_card_models(cards, deck_name, note_type, HashMap::new()).await
}

pub async fn add_notes_to_anki_with_card_models(
    cards: Vec<AnkiCard>,
    deck_name: String,
    note_type: String,
    card_models: HashMap<String, String>,
) -> Result<Vec<Option<u64>>, String> {
    add_notes_to_anki_detailed(cards, deck_name, note_type, card_models, HashMap::new())
        .await
        .map(|report| report.note_ids)
}

/// AnkiConnect 同步明细结果（D1 修复）：
/// 把"重复（已存在）"与"真实失败"分开统计，并报告自动创建的模型。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnkiSyncReport {
    /// 与输入卡片一一对应的 note id（None = 未添加：重复或失败）
    pub note_ids: Vec<Option<u64>>,
    pub added: usize,
    /// canAddNotes 预检判定为重复（笔记已存在于 Anki）
    pub duplicates: usize,
    /// 非重复原因的失败（模型缺失/字段为空等）
    pub failed: usize,
    /// 本次同步自动创建的 Anki 模型名
    pub created_models: Vec<String>,
}

/// 通用 AnkiConnect 调用辅助（新增 action 使用）。
async fn invoke_anki_connect_action(
    action: &str,
    params: Option<serde_json::Value>,
    timeout_secs: u64,
) -> Result<serde_json::Value, String> {
    let request = AnkiConnectRequest {
        action: action.to_string(),
        version: 6,
        params,
    };
    let client = reqwest::Client::new();
    let response = client
        .post(ANKI_CONNECT_URL)
        .json(&request)
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .send()
        .await
        .map_err(|e| format!("AnkiConnect 请求失败({}): {}", action, e))?;
    if !response.status().is_success() {
        return Err(format!(
            "AnkiConnect HTTP错误({}): {}",
            action,
            response.status()
        ));
    }
    let resp: AnkiConnectResponse = response
        .json()
        .await
        .map_err(|e| format!("解析AnkiConnect响应失败({}): {}", action, e))?;
    if let Some(error) = resp.error {
        return Err(format!("AnkiConnect错误({}): {}", action, error));
    }
    Ok(resp.result.unwrap_or(serde_json::Value::Null))
}

/// 用自定义模板在 Anki 中创建模型（createModel）。
/// 字段、正反面 HTML 模板与 CSS 都来自 custom_template。
pub async fn create_model_from_template(
    template: &crate::models::CustomAnkiTemplate,
) -> Result<(), String> {
    let model_name = template.note_type.trim();
    if model_name.is_empty() {
        return Err("模板未配置笔记类型（note_type 为空）".to_string());
    }
    if template.fields.is_empty() {
        return Err("模板未配置字段，无法创建 Anki 模型".to_string());
    }
    if template.front_template.trim().is_empty() || template.back_template.trim().is_empty() {
        return Err("模板缺少正面/背面 HTML，无法创建 Anki 模型".to_string());
    }

    let is_cloze =
        template.front_template.contains("{{cloze:") || template.back_template.contains("{{cloze:");

    let params = serde_json::json!({
        "modelName": model_name,
        "inOrderFields": template.fields,
        "css": template.css_style,
        "isCloze": is_cloze,
        "cardTemplates": [{
            "Name": "Card 1",
            "Front": template.front_template,
            "Back": template.back_template,
        }],
    });

    invoke_anki_connect_action("createModel", Some(params), 15).await?;
    println!("✅ 已在 Anki 中创建模型: {}", model_name);
    Ok(())
}

/// canAddNotes 预检：返回每张卡是否可添加（false 通常表示重复）。
async fn can_add_notes(notes: &[Note]) -> Result<Vec<bool>, String> {
    let params = serde_json::json!({ "notes": notes });
    let result = invoke_anki_connect_action("canAddNotes", Some(params), 15).await?;
    serde_json::from_value::<Vec<bool>>(result)
        .map_err(|e| format!("解析 canAddNotes 结果失败: {}", e))
}

#[derive(Debug, PartialEq, Eq)]
enum CanAddFalseReason {
    Duplicate,
    InvalidNote,
}

fn classify_can_add_false(
    note: &Note,
    model_field_names_cache: &HashMap<String, Option<Vec<String>>>,
) -> CanAddFalseReason {
    if note.deck_name.trim().is_empty() || note.model_name.trim().is_empty() {
        return CanAddFalseReason::InvalidNote;
    }

    let Some(Some(model_fields)) = model_field_names_cache.get(&note.model_name) else {
        return CanAddFalseReason::InvalidNote;
    };
    if model_fields.is_empty() {
        return CanAddFalseReason::InvalidNote;
    }

    if model_fields
        .iter()
        .any(|field| !note.fields.contains_key(field))
    {
        return CanAddFalseReason::InvalidNote;
    }

    let Some(first_field) = model_fields.first() else {
        return CanAddFalseReason::InvalidNote;
    };
    if note
        .fields
        .get(first_field)
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
    {
        return CanAddFalseReason::InvalidNote;
    }

    if note.fields.values().all(|value| value.trim().is_empty()) {
        return CanAddFalseReason::InvalidNote;
    }

    CanAddFalseReason::Duplicate
}

/// D1 修复版同步：
/// 1. 缺失模型先用 custom_template 自动 createModel；
/// 2. canAddNotes 预检结合本地字段校验，把"重复"与"失败"分开；
/// 3. 返回明细报告（added/duplicates/failed/created_models）。
pub async fn add_notes_to_anki_detailed(
    cards: Vec<AnkiCard>,
    deck_name: String,
    note_type: String,
    card_models: HashMap<String, String>,
    templates_by_model: HashMap<String, crate::models::CustomAnkiTemplate>,
) -> Result<AnkiSyncReport, String> {
    // 首先检查AnkiConnect可用性
    check_anki_connect_availability().await?;

    let mut model_field_names_cache: HashMap<String, Option<Vec<String>>> = HashMap::new();
    let mut model_names: Vec<String> = cards
        .iter()
        .map(|card| {
            card_models
                .get(&card.id)
                .cloned()
                .unwrap_or_else(|| note_type.clone())
        })
        .collect();
    model_names.sort();
    model_names.dedup();

    // 模型预检（D1）：缺失的模型若有对应自定义模板，自动创建
    let mut created_models: Vec<String> = Vec::new();
    if !templates_by_model.is_empty() {
        match get_model_names().await {
            Ok(existing) => {
                for model_name in &model_names {
                    if existing.iter().any(|m| m == model_name) {
                        continue;
                    }
                    if let Some(template) = templates_by_model.get(model_name) {
                        match create_model_from_template(template).await {
                            Ok(()) => created_models.push(model_name.clone()),
                            Err(e) => {
                                println!("⚠️ 自动创建模型 {} 失败: {}", model_name, e);
                            }
                        }
                    } else {
                        println!(
                            "⚠️ Anki 中缺少模型 {} 且无对应模板，可能导致同步失败",
                            model_name
                        );
                    }
                }
            }
            Err(e) => println!("⚠️ 获取 Anki 模型列表失败，跳过模型预检: {}", e),
        }
    }

    for model_name in model_names {
        let loaded = match get_model_field_names(&model_name).await {
            Ok(names) if !names.is_empty() => Some(names),
            Ok(_) => None,
            Err(e) => {
                println!("⚠️ 获取模型字段失败: {} — 将使用基本字段映射", e);
                None
            }
        };
        model_field_names_cache.insert(model_name, loaded);
    }

    // 构建notes数组
    let notes: Vec<Note> = cards
        .into_iter()
        .map(|card| {
            let model_name = card_models
                .get(&card.id)
                .cloned()
                .unwrap_or_else(|| note_type.clone());

            let model_field_names = model_field_names_cache
                .get(&model_name)
                .cloned()
                .unwrap_or(None);

            let fields = if let Some(names) = model_field_names.as_ref() {
                build_fields_with_model_names(&card, names, &model_name)
            } else {
                build_basic_fields(&card, &model_name)
            };

            Note {
                deck_name: deck_name.clone(),
                model_name,
                fields,
                tags: card.tags,
            }
        })
        .collect();

    let total = notes.len();

    // canAddNotes 预检（D1）：false 只有在本地结构校验通过时才视为重复；
    // 模型字段未知、首字段为空、字段缺失等情况记为真实失败，避免把结构错误误报为幂等成功。
    let can_add: Vec<bool> = match can_add_notes(&notes).await {
        Ok(flags) if flags.len() == total => flags,
        Ok(_) | Err(_) => vec![true; total],
    };
    let duplicates = notes
        .iter()
        .zip(can_add.iter())
        .filter(|(note, ok)| {
            !**ok
                && classify_can_add_false(note, &model_field_names_cache)
                    == CanAddFalseReason::Duplicate
        })
        .count();

    let addable_notes: Vec<&Note> = notes
        .iter()
        .zip(can_add.iter())
        .filter(|(_, ok)| **ok)
        .map(|(note, _)| note)
        .collect();

    let mut note_ids: Vec<Option<u64>> = vec![None; total];
    if !addable_notes.is_empty() {
        let params = serde_json::json!({ "notes": addable_notes });
        let result = invoke_anki_connect_action("addNotes", Some(params), 30).await?;
        let added_ids = serde_json::from_value::<Vec<Option<u64>>>(result)
            .map_err(|e| format!("解析笔记ID列表失败: {}", e))?;

        // 回填到原位置
        let mut cursor = 0usize;
        for (i, ok) in can_add.iter().enumerate() {
            if *ok {
                note_ids[i] = added_ids.get(cursor).cloned().flatten();
                cursor += 1;
            }
        }
    }

    let added = note_ids.iter().filter(|id| id.is_some()).count();
    let failed = total.saturating_sub(added + duplicates);

    Ok(AnkiSyncReport {
        note_ids,
        added,
        duplicates,
        failed,
        created_models,
    })
}

/// 创建牌组（如果不存在）
pub async fn create_deck_if_not_exists(deck_name: &str) -> Result<(), String> {
    let params = serde_json::json!({
        "deck": deck_name
    });

    let request = AnkiConnectRequest {
        action: "createDeck".to_string(),
        version: 6,
        params: Some(params),
    };

    let client = reqwest::Client::new();

    match client
        .post(ANKI_CONNECT_URL)
        .json(&request)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
    {
        Ok(response) => {
            if response.status().is_success() {
                match response.json::<AnkiConnectResponse>().await {
                    Ok(anki_response) => {
                        if let Some(error) = anki_response.error {
                            // 如果牌组已存在，这不算错误
                            if error.contains("already exists") {
                                Ok(())
                            } else {
                                Err(format!("创建牌组时出错: {}", error))
                            }
                        } else {
                            Ok(())
                        }
                    }
                    Err(e) => Err(format!("解析AnkiConnect响应失败: {}", e)),
                }
            } else {
                Err(format!("AnkiConnect HTTP错误: {}", response.status()))
            }
        }
        Err(e) => Err(format!("创建牌组失败: {}", e)),
    }
}

/// 通过 AnkiConnect 导入 APKG 包
/// 要求传入绝对路径
pub async fn import_apkg(path: &str) -> Result<bool, String> {
    if path.trim().is_empty() {
        return Err("APKG 路径不能为空".to_string());
    }

    // 确保 AnkiConnect 可用
    check_anki_connect_availability().await?;

    // 处理各平台路径：AnkiConnect 需要绝对路径字符串
    // 这里假设前端传入的已是绝对路径
    let params = serde_json::json!({
        "path": path
    });

    let request = AnkiConnectRequest {
        action: "importPackage".to_string(),
        version: 6,
        params: Some(params),
    };

    let client = reqwest::Client::new();
    match client
        .post(ANKI_CONNECT_URL)
        .json(&request)
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
    {
        Ok(response) => {
            if response.status().is_success() {
                match response.json::<AnkiConnectResponse>().await {
                    Ok(resp) => {
                        if let Some(err) = resp.error {
                            Err(format!("导入APKG失败: {}", err))
                        } else {
                            Ok(true)
                        }
                    }
                    Err(e) => Err(format!("解析AnkiConnect响应失败: {}", e)),
                }
            } else {
                Err(format!("AnkiConnect HTTP错误: {}", response.status()))
            }
        }
        Err(e) => Err(format!("请求AnkiConnect导入失败: {}", e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn basic_note(front: &str, back: &str) -> Note {
        let mut fields = HashMap::new();
        fields.insert("Front".to_string(), front.to_string());
        fields.insert("Back".to_string(), back.to_string());
        Note {
            deck_name: "Default".to_string(),
            model_name: "Basic".to_string(),
            fields,
            tags: vec![],
        }
    }

    fn basic_model_cache() -> HashMap<String, Option<Vec<String>>> {
        HashMap::from([(
            "Basic".to_string(),
            Some(vec!["Front".to_string(), "Back".to_string()]),
        )])
    }

    #[test]
    fn can_add_false_with_valid_note_is_duplicate() {
        let note = basic_note("question", "answer");
        let cache = basic_model_cache();

        assert_eq!(
            classify_can_add_false(&note, &cache),
            CanAddFalseReason::Duplicate
        );
    }

    #[test]
    fn can_add_false_with_empty_first_field_is_failure() {
        let note = basic_note("   ", "answer");
        let cache = basic_model_cache();

        assert_eq!(
            classify_can_add_false(&note, &cache),
            CanAddFalseReason::InvalidNote
        );
    }

    #[test]
    fn can_add_false_with_unknown_model_fields_is_failure() {
        let note = basic_note("question", "answer");
        let cache = HashMap::from([("Basic".to_string(), None)]);

        assert_eq!(
            classify_can_add_false(&note, &cache),
            CanAddFalseReason::InvalidNote
        );
    }

    #[test]
    fn can_add_false_with_missing_model_field_is_failure() {
        let mut note = basic_note("question", "answer");
        note.fields.remove("Back");
        let cache = basic_model_cache();

        assert_eq!(
            classify_can_add_false(&note, &cache),
            CanAddFalseReason::InvalidNote
        );
    }
}
