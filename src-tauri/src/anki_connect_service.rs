use crate::models::AnkiCard;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::net::TcpStream;
use std::path::Path;
use std::time::Duration;
use tracing::{debug, warn};

const ANKI_CONNECT_URL: &str = "http://127.0.0.1:8765";

/// 本应用依赖的最低 AnkiConnect API 版本（canAddNotes / addNotes / createModel 均在 v6 定义）。
const ANKI_CONNECT_MIN_VERSION: u64 = 6;

/// addNotes 批量推送分片大小默认值：过大易触发 AnkiConnect 超时，过小徒增 HTTP 往返。
/// 与前端设置项 `anki_connect_batch_size` 的默认值保持一致。
const ANKI_CONNECT_DEFAULT_BATCH_SIZE: usize = 50;

/// batch_size 设置的硬上限，防止误配置导致单请求过大。
const ANKI_CONNECT_MAX_BATCH_SIZE: usize = 500;

/// 额外重试次数默认值（不含首次尝试）。与前端设置项 `anki_connect_retry_times` 默认一致。
const ANKI_CONNECT_DEFAULT_RETRY_TIMES: u32 = 1;

/// 媒体同步模式（设置项 `anki_connect_media_mode`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnkiConnectMediaMode {
    /// 跳过媒体处理：字段原样发送，不上传任何媒体
    Skip,
    /// 字段内联 data URL，不写入 Anki 媒体库
    InlineBase64,
    /// 上传到 Anki 媒体库并改写引用（默认，历史行为）
    UploadMedia,
}

impl AnkiConnectMediaMode {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "skip" => Self::Skip,
            "inline_base64" | "inline-base64" | "inline" => Self::InlineBase64,
            _ => Self::UploadMedia,
        }
    }
}

/// 同步可调参数（激活设置项 batch_size / retry_times / media_mode）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnkiConnectSyncOptions {
    pub batch_size: usize,
    /// 额外重试次数（不含首次尝试）。0 = 只试一次。
    pub retry_times: u32,
    pub media_mode: AnkiConnectMediaMode,
}

impl Default for AnkiConnectSyncOptions {
    fn default() -> Self {
        Self {
            batch_size: ANKI_CONNECT_DEFAULT_BATCH_SIZE,
            retry_times: ANKI_CONNECT_DEFAULT_RETRY_TIMES,
            media_mode: AnkiConnectMediaMode::UploadMedia,
        }
    }
}

impl AnkiConnectSyncOptions {
    pub fn sanitize(mut self) -> Self {
        if self.batch_size == 0 {
            self.batch_size = ANKI_CONNECT_DEFAULT_BATCH_SIZE;
        }
        self.batch_size = self.batch_size.min(ANKI_CONNECT_MAX_BATCH_SIZE);
        self
    }

    /// 从 settings DB 的原始字符串构造（无效/缺失回落默认值）。
    pub fn from_setting_strings(
        batch_size: Option<&str>,
        retry_times: Option<&str>,
        media_mode: Option<&str>,
    ) -> Self {
        let batch_size = batch_size
            .and_then(|s| s.trim().parse::<usize>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(ANKI_CONNECT_DEFAULT_BATCH_SIZE);
        let retry_times = retry_times
            .and_then(|s| s.trim().parse::<u32>().ok())
            .unwrap_or(ANKI_CONNECT_DEFAULT_RETRY_TIMES);
        let media_mode = media_mode
            .map(AnkiConnectMediaMode::parse)
            .unwrap_or(AnkiConnectMediaMode::UploadMedia);
        Self {
            batch_size,
            retry_times,
            media_mode,
        }
        .sanitize()
    }
}

/// storeMediaFile 单文件上限：base64 后随请求体走本机 HTTP，过大易拖垮 AnkiConnect。
const ANKI_CONNECT_MAX_MEDIA_BYTES: u64 = 32 * 1024 * 1024;

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

/// AnkiConnect 笔记媒体附件（picture/audio 协议对象）。
/// `fields` 指定 Anki 侧要把媒体引用追加到哪些字段。
#[derive(Serialize, Clone)]
struct NoteMediaAttachment {
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    filename: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    fields: Vec<String>,
}

#[derive(Serialize)]
struct Note {
    #[serde(rename = "deckName")]
    deck_name: String,
    #[serde(rename = "modelName")]
    model_name: String,
    fields: HashMap<String, String>,
    tags: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    picture: Vec<NoteMediaAttachment>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    audio: Vec<NoteMediaAttachment>,
}

fn normalize_key(key: &str) -> String {
    key.chars()
        .filter(|c| c.is_alphanumeric())
        .collect::<String>()
}

/// 导入时由 apkg_importer_service 注入的元数据保留字段（与
/// `apkg_exporter_service::RESERVED_IMPORT_METADATA_FIELDS` 名单一致）。
/// 这些键只在本应用内部有意义，不得作为字段值来源发给 Anki。
const RESERVED_IMPORT_METADATA_FIELDS: [&str; 13] = [
    "AnkiNoteId",
    "AnkiCardId",
    "AnkiCardOrd",
    "AnkiDeckId",
    "AnkiModelId",
    "AnkiModelName",
    "AnkiSchedType",
    "AnkiQueue",
    "AnkiDue",
    "AnkiIvl",
    "AnkiFactor",
    "AnkiReps",
    "AnkiLapses",
];

fn is_reserved_import_metadata_field(name: &str) -> bool {
    RESERVED_IMPORT_METADATA_FIELDS
        .iter()
        .any(|reserved| reserved.eq_ignore_ascii_case(name))
}

/// 机器协议字段判定：`_` 前缀键（`_occlusion`/`_qa_flags`/`_original_generation` 等）
/// 与 13 个 `Anki*` 导入元数据保留键一律不进入发往 Anki 的 fields。
///
/// 关键动机：`normalize_key("_occlusion")` 会剥掉下划线得到 `"occlusion"`，
/// 若目标模型带有官方 Image Occlusion 的 `Occlusion` 字段，内部 spec JSON
/// 会被灌进该字段（语法完全不兼容）。在取值源头剔除即可杜绝碰撞。
fn is_internal_protocol_field(name: &str) -> bool {
    name.starts_with('_') || is_reserved_import_metadata_field(name)
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

    // 剔除机器协议字段：`_` 前缀键与 Anki* 保留键不作为任何模型字段的取值来源，
    // 否则 normalize 匹配会把 `_occlusion` 灌进官方 IO 模型的 `Occlusion` 字段。
    let mut lower_extra: HashMap<String, String> = card
        .extra_fields
        .iter()
        .filter(|(k, _)| !is_internal_protocol_field(k))
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
    debug!("🔍 正在检查AnkiConnect连接到: {}", ANKI_CONNECT_URL);

    // 首先检查端口8765是否开放
    debug!("🔍 第0步：检查端口8765是否开放...");
    let local_anki_addr = std::net::SocketAddr::from(([127, 0, 0, 1], 8765));
    match TcpStream::connect_timeout(&local_anki_addr, Duration::from_secs(5)) {
        Ok(_) => {
            debug!("✅ 端口8765可访问");
        }
        Err(e) => {
            warn!("❌ 端口8765无法访问: {}", e);
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

    debug!("🔍 第一步：尝试探测AnkiConnect（GET 非阻塞）...");
    match client.get(ANKI_CONNECT_URL).send().await {
        Ok(response) => {
            debug!("✅ AnkiConnect GET 响应状态: {}", response.status());
        }
        Err(e) => {
            // 有些版本/配置可能不响应GET，这里仅记录告警并继续进行POST版本探测
            debug!("⚠️ AnkiConnect GET 探测失败（忽略，继续版本检测）: {}", e);
        }
    }

    // 如果基础连接成功，再尝试API请求
    debug!("🔍 第二步：测试AnkiConnect API...");
    let request = AnkiConnectRequest {
        action: "version".to_string(),
        version: 6,
        params: None,
    };

    debug!(
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
            debug!("📥 收到响应状态: {}", status_code);
            if status_code.is_success() {
                let response_text = response
                    .text()
                    .await
                    .map_err(|e| format!("读取响应内容失败: {}", e))?;
                debug!("📥 响应内容: {}", response_text);

                match serde_json::from_str::<AnkiConnectResponse>(&response_text) {
                    Ok(anki_response) => {
                        if let Some(error) = anki_response.error {
                            return Err(format!("AnkiConnect错误: {}", error));
                        }
                        // 版本协商：低于最低支持版本时给出明确升级提示，
                        // 避免后续 canAddNotes/createModel 等 action 静默失败。
                        match anki_response.result.as_ref().and_then(|v| v.as_u64()) {
                            Some(version) if version < ANKI_CONNECT_MIN_VERSION => {
                                Err(format!(
                                    "AnkiConnect 插件版本过旧（API v{}，需要 ≥ v{}）。请在 Anki 中更新 AnkiConnect 插件（代码：2055492159）后重试",
                                    version, ANKI_CONNECT_MIN_VERSION
                                ))
                            }
                            Some(version) => {
                                debug!("✅ AnkiConnect版本检查成功: API v{}", version);
                                Ok(true)
                            }
                            None => {
                                // 兼容返回非数字（极旧/魔改版本）：放行但记录告警
                                warn!(
                                    "⚠️ AnkiConnect version 返回非数字结果，跳过版本协商: {:?}",
                                    anki_response.result
                                );
                                Ok(true)
                            }
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
            warn!("❌ AnkiConnect连接错误详情: {:?}", e);
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
    add_notes_to_anki_detailed(
        cards,
        deck_name,
        note_type,
        card_models,
        HashMap::new(),
        AnkiConnectSyncOptions::default(),
    )
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
    /// 新增可选字段（向后兼容）：模型预检/createModel 的结构化失败明细。
    /// 为空时不序列化，旧前端无感知。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub model_errors: Vec<AnkiSyncModelError>,
    /// 新增可选字段（向后兼容）：非致命告警（canAddNotes 降级、分批推送部分失败等）。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// 模型相关失败的结构化明细（AnkiSyncReport 新增可选字段的元素类型）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnkiSyncModelError {
    /// 出问题的 Anki 模型名（note type）
    pub model: String,
    pub error: String,
}

/// 重试退避间隔（毫秒）：第 n 次重试前等待。
fn retry_backoff_ms(retry_index: u32) -> u64 {
    match retry_index {
        0 => 500,
        1 => 1000,
        _ => 2000,
    }
}

/// 通用 AnkiConnect 调用辅助（新增 action 使用）。
///
/// `retry_times` 为额外重试次数（不含首次尝试）；只有网络类失败
/// （超时/连接失败/HTTP 错误/响应解析失败）才重试，AnkiConnect 业务错误
/// （如字段校验、重复判定）不可靠重试，直接返回。
async fn invoke_anki_connect_action(
    action: &str,
    params: Option<serde_json::Value>,
    timeout_secs: u64,
    retry_times: u32,
) -> Result<serde_json::Value, String> {
    let request = AnkiConnectRequest {
        action: action.to_string(),
        version: 6,
        params,
    };
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("创建HTTP客户端失败({}): {}", action, e))?;

    let attempts = retry_times.saturating_add(1);
    let mut last_err = format!("AnkiConnect 请求失败({})", action);

    for attempt in 0..attempts {
        if attempt > 0 {
            let delay = retry_backoff_ms(attempt - 1);
            debug!(
                "⏳ AnkiConnect {} 重试 {}/{}，等待 {}ms",
                action, attempt, retry_times, delay
            );
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }

        let response = match client
            .post(ANKI_CONNECT_URL)
            .json(&request)
            .timeout(std::time::Duration::from_secs(timeout_secs))
            .send()
            .await
        {
            Ok(response) => response,
            Err(e) => {
                last_err = if e.is_timeout() {
                    format!(
                        "AnkiConnect 请求超时({}): 请确认 Anki 正在运行且未被弹窗阻塞",
                        action
                    )
                } else if e.is_connect() {
                    format!(
                        "无法连接 AnkiConnect({}): 请确认 Anki 已启动并安装了 AnkiConnect 插件",
                        action
                    )
                } else {
                    format!("AnkiConnect 请求失败({}): {}", action, e)
                };
                if !(e.is_timeout() || e.is_connect() || e.is_request()) {
                    return Err(last_err);
                }
                continue;
            }
        };

        if !response.status().is_success() {
            last_err = format!("AnkiConnect HTTP错误({}): {}", action, response.status());
            continue;
        }
        match response.json::<AnkiConnectResponse>().await {
            Ok(resp) => {
                if let Some(error) = resp.error {
                    // 业务错误不可靠重试（如字段校验、重复），直接返回
                    return Err(format!("AnkiConnect错误({}): {}", action, error));
                }
                return Ok(resp.result.unwrap_or(serde_json::Value::Null));
            }
            Err(e) => {
                last_err = format!("解析AnkiConnect响应失败({}): {}", action, e);
                continue;
            }
        }
    }

    if retry_times > 0 {
        Err(format!("{}（已重试 {} 次）", last_err, retry_times))
    } else {
        Err(last_err)
    }
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

    // createModel 非幂等（重复创建会报错），不做网络重试
    invoke_anki_connect_action("createModel", Some(params), 15, 0).await?;
    debug!("✅ 已在 Anki 中创建模型: {}", model_name);
    Ok(())
}

// ============================================================================
// 媒体同步（storeMediaFile + picture/audio 附件）
// ============================================================================

/// 按扩展名区分 audio / picture（未知类型按 picture 处理，Anki 端仍会保存文件）。
fn is_audio_media_filename(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "mp3" | "wav" | "ogg" | "oga" | "m4a" | "flac" | "opus" | "aac" | "3gp" | "spx"
            )
        })
}

/// 从字段 HTML/文本中提取媒体引用：`src="..."`、`src='...'` 与 `[sound:...]`。
/// （与 apkg_importer_service::extract_media_filenames 保持同一识别口径。）
fn extract_field_media_refs(text: &str) -> Vec<String> {
    let mut names = Vec::new();
    let bytes = text.as_bytes();

    let mut search_from = 0usize;
    while let Some(relative) = text[search_from..].find("src=") {
        let quote_index = search_from + relative + 4;
        let Some(&quote) = bytes.get(quote_index) else {
            break;
        };
        if quote == b'"' || quote == b'\'' {
            let value_start = quote_index + 1;
            if let Some(relative_end) = text[value_start..].find(quote as char) {
                let value = &text[value_start..value_start + relative_end];
                if !value.is_empty() {
                    names.push(value.to_string());
                }
                search_from = value_start + relative_end + 1;
                continue;
            }
        }
        search_from = quote_index;
    }

    let mut search_from = 0usize;
    while let Some(relative) = text[search_from..].find("[sound:") {
        let value_start = search_from + relative + "[sound:".len();
        let Some(relative_end) = text[value_start..].find(']') else {
            break;
        };
        let value = &text[value_start..value_start + relative_end];
        if !value.is_empty() {
            names.push(value.to_string());
        }
        search_from = value_start + relative_end + 1;
    }

    names
}

/// 读取本地媒体文件并 base64 编码（带大小上限）。
fn read_media_file_base64(path: &Path) -> Result<String, String> {
    let metadata =
        std::fs::metadata(path).map_err(|error| format!("读取媒体文件信息失败: {error}"))?;
    if !metadata.is_file() {
        return Err("媒体路径不是常规文件".to_string());
    }
    if metadata.len() > ANKI_CONNECT_MAX_MEDIA_BYTES {
        return Err(format!(
            "媒体文件超过 {ANKI_CONNECT_MAX_MEDIA_BYTES} 字节上限"
        ));
    }
    let bytes = std::fs::read(path).map_err(|error| format!("读取媒体文件失败: {error}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// storeMediaFile：把 base64 数据按文件名存入 Anki 媒体库（同名覆盖，与 Anki 语义一致）。
async fn store_media_file_base64(
    filename: &str,
    data: &str,
    retry_times: u32,
) -> Result<(), String> {
    let params = serde_json::json!({ "filename": filename, "data": data });
    invoke_anki_connect_action("storeMediaFile", Some(params), 60, retry_times)
        .await
        .map(|_| ())
}

/// 按扩展名猜测图片 MIME（inline_base64 模式的 data URL 用）。
fn guess_image_mime(filename: &str) -> &'static str {
    match Path::new(filename)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        _ => "image/jpeg",
    }
}

/// 上传单个本地媒体文件（按文件名幂等去重）；失败进入 failed 集与 warnings。
async fn upload_local_media(
    path: &Path,
    filename: &str,
    uploaded: &mut HashSet<String>,
    failed: &mut HashSet<String>,
    warnings: &mut Vec<String>,
    retry_times: u32,
) -> bool {
    if uploaded.contains(filename) {
        return true;
    }
    if failed.contains(filename) {
        return false;
    }
    let encoded = match read_media_file_base64(path) {
        Ok(encoded) => encoded,
        Err(error) => {
            warnings.push(format!(
                "媒体文件 {} 读取失败，已跳过上传: {}",
                filename, error
            ));
            failed.insert(filename.to_string());
            return false;
        }
    };
    match store_media_file_base64(filename, &encoded, retry_times).await {
        Ok(()) => {
            uploaded.insert(filename.to_string());
            true
        }
        Err(error) => {
            warnings.push(format!("媒体文件 {} 上传失败，已跳过: {}", filename, error));
            failed.insert(filename.to_string());
            false
        }
    }
}

fn media_basename(path: &str) -> Option<String> {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string)
        .filter(|name| !name.is_empty())
}

// ============================================================================
// 图像遮挡卡（`_occlusion` / tag `image-occlusion`）发送前调整
// ============================================================================

/// 遮挡卡识别：带 `_occlusion` 协议字段或 `image-occlusion` tag。
fn is_occlusion_card(card: &AnkiCard) -> bool {
    card.extra_fields
        .contains_key(crate::anki_image_occlusion::OCCLUSION_FIELD)
        || card
            .tags
            .iter()
            .any(|tag| tag == crate::anki_image_occlusion::OCCLUSION_TAG)
}

/// VlmFull 流水线中图片尚未落地时的占位 scheme；无实体文件可挂，跳过媒体处理。
const OCCLUSION_PENDING_IMAGE_SCHEME: &str = "vlm://";

/// 从 `_occlusion` spec 重建标准 Cloze Text（`<img src="文件名"><br>{{cN::label}}`）。
///
/// 仅作为兜底：`card.text` 缺失或不含 cloze 标记时才会被调用。
/// spec 缺失/校验失败返回 `None`（调用方降级为原字段并写 warning）。
fn rebuild_occlusion_cloze_text(
    spec: Option<&crate::anki_image_occlusion::OcclusionSpec>,
    image_file_name: Option<&str>,
) -> Option<String> {
    let spec = spec?;
    let validated = crate::anki_image_occlusion::validate_spec(
        spec,
        &crate::anki_image_occlusion::OcclusionConfig::default(),
    )
    .ok()?;
    let built = crate::anki_image_occlusion::build_card_fields(&validated, image_file_name, None);
    Some(built.text)
}

/// 遮挡卡发送 Anki 前的闭环调整（非遮挡卡零改动，行为与旧版完全一致）：
///
/// 1. **Cloze Text**：优先沿用 `card.text`（`build_fields_with_model_names` 已把它
///    写进模型的 `Text` 字段）；若发出的 Text 不含 `{{c` 标记，则从 `_occlusion`
///    spec 重建标准 Cloze 文本兜底，保证可复习主路径是标准 Cloze。
/// 2. **媒体**：`_occlusion.imageRef` 追加进本卡（导出用克隆）的 `images`，
///    交给后续 `prepare_note_media` 复用现有 storeMediaFile 上传 / `picture`
///    附件挂载逻辑；`vlm://` 占位引用视为无图降级。
/// 3. `_occlusion` JSON 本体绝不作为字段发出（取值源头已由
///    `is_internal_protocol_field` 过滤）。
///
/// 不硬依赖 Anki 端的 Image Occlusion 模型：modelName 沿用调用方给定的
/// Cloze/当前模型，本函数只调整字段值与媒体输入。
/// 调整仅作用于本次同步的内存克隆，不写回卡片库。
fn prepare_occlusion_note(
    card: &mut AnkiCard,
    fields: &mut HashMap<String, String>,
    warnings: &mut Vec<String>,
) {
    if !is_occlusion_card(card) {
        return;
    }

    let spec = crate::anki_image_occlusion::parse_occlusion_field(&card.extra_fields);
    if spec.is_none()
        && card
            .extra_fields
            .contains_key(crate::anki_image_occlusion::OCCLUSION_FIELD)
    {
        warnings.push(
            "遮挡卡的 _occlusion 数据不合法，已按普通卡片同步（图片与遮挡信息可能缺失）"
                .to_string(),
        );
    }

    // imageRef → 媒体候选：并入 images 后由 prepare_note_media 统一上传/附件。
    let image_ref = spec
        .as_ref()
        .map(|s| s.image_ref.trim().to_string())
        .filter(|r| !r.is_empty() && !r.starts_with(OCCLUSION_PENDING_IMAGE_SCHEME));
    if let Some(image_ref) = image_ref.as_ref() {
        if !card.images.iter().any(|existing| existing == image_ref) {
            card.images.push(image_ref.clone());
        }
    }

    // Cloze Text 兜底：仅当模型有 Text 字段且当前值不含 cloze 标记时重建。
    let text_key = fields
        .keys()
        .find(|key| key.eq_ignore_ascii_case("text"))
        .cloned();
    if let Some(text_key) = text_key {
        let has_cloze = fields
            .get(&text_key)
            .map(|value| value.contains("{{c"))
            .unwrap_or(false);
        if !has_cloze {
            let image_file_name = image_ref.as_deref().and_then(media_basename);
            match rebuild_occlusion_cloze_text(spec.as_ref(), image_file_name.as_deref()) {
                Some(rebuilt) => {
                    fields.insert(text_key, rebuilt);
                }
                None => {
                    warnings.push(
                        "遮挡卡缺少 Cloze 文本且无法从 _occlusion 重建，可能在 Anki 中不可复习"
                            .to_string(),
                    );
                }
            }
        }
    }
}

/// 同步前处理单张卡片的媒体（行为受设置项 `anki_connect_media_mode` 控制）：
///
/// `upload_media`（默认，历史行为）：
/// 1. 字段值中引用的本地绝对路径媒体 → 上传到 Anki 媒体库并把引用改写为纯文件名，
///    保证字段引用与 Anki 媒体库文件名一致；
/// 2. `card.images` 中被字段引用（按文件名）的媒体 → storeMediaFile 上传；
/// 3. `card.images` 中未被任何字段引用的媒体 → 作为 picture/audio 附件挂到 note，
///    由 AnkiConnect 把引用追加到目标字段（优先 Back/Extra）。
///
/// `inline_base64`：图片改写/追加为 data URL，不写 Anki 媒体库；音频无法内联，跳过并告警。
/// `skip`：完全不处理媒体，字段原样发送。
///
/// 所有失败均降级为 warnings，不阻断笔记同步。
async fn prepare_note_media(
    card: &AnkiCard,
    fields: &mut HashMap<String, String>,
    uploaded: &mut HashSet<String>,
    failed: &mut HashSet<String>,
    warnings: &mut Vec<String>,
    options: AnkiConnectSyncOptions,
) -> (Vec<NoteMediaAttachment>, Vec<NoteMediaAttachment>) {
    // skip 模式：媒体完全不处理（设置项 anki_connect_media_mode 激活）
    if matches!(options.media_mode, AnkiConnectMediaMode::Skip) {
        return (Vec::new(), Vec::new());
    }
    let inline_mode = matches!(options.media_mode, AnkiConnectMediaMode::InlineBase64);
    let retry_times = options.retry_times;
    // inline 模式下已内联的文件名（防止 card.images 步骤重复追加）
    let mut inlined: HashSet<String> = HashSet::new();

    // 第一步：把字段里的本地绝对路径引用改写成文件名（upload 模式）或 data URL（inline 模式）
    let field_keys: Vec<String> = fields.keys().cloned().collect();
    for key in &field_keys {
        let Some(value) = fields.get(key).cloned() else {
            continue;
        };
        let mut rewritten = value.clone();
        for reference in extract_field_media_refs(&value) {
            let path = Path::new(&reference);
            if !path.is_absolute() || !path.is_file() {
                continue;
            }
            let Some(filename) = media_basename(&reference) else {
                continue;
            };
            if inline_mode {
                if is_audio_media_filename(&filename) {
                    warnings.push(format!(
                        "inline_base64 模式无法内联音频 {}，已保留原引用",
                        filename
                    ));
                    continue;
                }
                match read_media_file_base64(path) {
                    Ok(encoded) => {
                        let data_url =
                            format!("data:{};base64,{}", guess_image_mime(&filename), encoded);
                        rewritten = rewritten.replace(&reference, &data_url);
                        inlined.insert(filename);
                    }
                    Err(error) => {
                        warnings.push(format!(
                            "媒体文件 {} 读取失败，已跳过内联: {}",
                            filename, error
                        ));
                    }
                }
            } else if upload_local_media(path, &filename, uploaded, failed, warnings, retry_times)
                .await
            {
                rewritten = rewritten.replace(&reference, &filename);
            }
        }
        if rewritten != value {
            fields.insert(key.clone(), rewritten);
        }
    }

    // 改写后字段实际引用到的文件名集合
    let mut referenced: HashSet<String> = HashSet::new();
    for value in fields.values() {
        for reference in extract_field_media_refs(value) {
            if let Some(filename) = media_basename(&reference) {
                referenced.insert(filename);
            }
        }
    }

    // 第二步：card.images 中的本地媒体
    let mut picture: Vec<NoteMediaAttachment> = Vec::new();
    let mut audio: Vec<NoteMediaAttachment> = Vec::new();
    for image_path in &card.images {
        let Some(filename) = media_basename(image_path) else {
            warnings.push(format!("媒体路径无有效文件名，已跳过: {}", image_path));
            continue;
        };
        let path = Path::new(image_path);

        if inline_mode {
            if inlined.contains(&filename) {
                // 第一步已把该文件内联进字段，无需再处理
                continue;
            }
            if is_audio_media_filename(&filename) {
                warnings.push(format!(
                    "inline_base64 模式无法内联音频 {}，已跳过",
                    filename
                ));
                continue;
            }
            let encoded = match read_media_file_base64(path) {
                Ok(encoded) => encoded,
                Err(error) => {
                    warnings.push(format!(
                        "媒体文件 {} 读取失败，已跳过内联: {}",
                        filename, error
                    ));
                    continue;
                }
            };
            let data_url = format!("data:{};base64,{}", guess_image_mime(&filename), encoded);
            if referenced.contains(&filename) {
                // 字段按文件名引用：把 src="文件名" 改写为 data URL（不落媒体库）
                let field_keys: Vec<String> = fields.keys().cloned().collect();
                for key in &field_keys {
                    if let Some(value) = fields.get(key).cloned() {
                        let rewritten = value
                            .replace(
                                &format!("src=\"{}\"", filename),
                                &format!("src=\"{}\"", data_url),
                            )
                            .replace(
                                &format!("src='{}'", filename),
                                &format!("src='{}'", data_url),
                            );
                        if rewritten != value {
                            fields.insert(key.clone(), rewritten);
                        }
                    }
                }
            } else {
                // 字段未引用：把 data URL 图片追加到目标字段（优先 Back/Extra）
                let target_field = ["Back", "Extra", "Front"]
                    .iter()
                    .find(|name| fields.contains_key(**name))
                    .map(|name| (*name).to_string())
                    .or_else(|| {
                        let mut keys: Vec<&String> = fields.keys().collect();
                        keys.sort();
                        keys.first().map(|key| (*key).to_string())
                    });
                if let Some(target) = target_field {
                    let value = fields.entry(target).or_default();
                    if !value.is_empty() {
                        value.push_str("<br>");
                    }
                    value.push_str(&format!("<img src=\"{}\">", data_url));
                }
            }
            continue;
        }

        if referenced.contains(&filename) {
            // 字段已引用同名文件：仅需保证媒体库里有这个文件
            upload_local_media(path, &filename, uploaded, failed, warnings, retry_times).await;
            continue;
        }
        // 字段未引用：作为附件挂到 note，由 AnkiConnect 追加引用到目标字段
        let encoded = match read_media_file_base64(path) {
            Ok(encoded) => encoded,
            Err(error) => {
                warnings.push(format!(
                    "媒体文件 {} 读取失败，已跳过附加: {}",
                    filename, error
                ));
                continue;
            }
        };
        let target_field = ["Back", "Extra", "Front"]
            .iter()
            .find(|name| fields.contains_key(**name))
            .map(|name| (*name).to_string())
            .or_else(|| {
                let mut keys: Vec<&String> = fields.keys().collect();
                keys.sort();
                keys.first().map(|key| (*key).to_string())
            });
        let attachment = NoteMediaAttachment {
            data: Some(encoded),
            url: None,
            filename: filename.clone(),
            fields: target_field.into_iter().collect(),
        };
        if is_audio_media_filename(&filename) {
            audio.push(attachment);
        } else {
            picture.push(attachment);
        }
    }

    (picture, audio)
}

/// canAddNotes 预检：返回每张卡是否可添加（false 通常表示重复）。
async fn can_add_notes(notes: &[Note], retry_times: u32) -> Result<Vec<bool>, String> {
    let params = serde_json::json!({ "notes": notes });
    let result = invoke_anki_connect_action("canAddNotes", Some(params), 15, retry_times).await?;
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
    options: AnkiConnectSyncOptions,
) -> Result<AnkiSyncReport, String> {
    let options = options.sanitize();
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

    // 模型预检（D1）：缺失的模型若有对应自定义模板，自动创建。
    // 失败不再只 warn：结构化写入报告（model_errors/warnings），让前端可见。
    let mut created_models: Vec<String> = Vec::new();
    let mut model_errors: Vec<AnkiSyncModelError> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
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
                                warn!("⚠️ 自动创建模型 {} 失败: {}", model_name, e);
                                model_errors.push(AnkiSyncModelError {
                                    model: model_name.clone(),
                                    error: format!("自动创建模型失败: {}", e),
                                });
                            }
                        }
                    } else {
                        warn!(
                            "⚠️ Anki 中缺少模型 {} 且无对应模板，可能导致同步失败",
                            model_name
                        );
                        model_errors.push(AnkiSyncModelError {
                            model: model_name.clone(),
                            error: "Anki 中缺少该模型且本地无对应模板，相关卡片可能同步失败"
                                .to_string(),
                        });
                    }
                }
            }
            Err(e) => {
                warn!("⚠️ 获取 Anki 模型列表失败，跳过模型预检: {}", e);
                warnings.push(format!("获取 Anki 模型列表失败，已跳过模型预检: {}", e));
            }
        }
    }

    for model_name in model_names {
        let loaded = match get_model_field_names(&model_name).await {
            Ok(names) if !names.is_empty() => Some(names),
            Ok(_) => None,
            Err(e) => {
                warn!("⚠️ 获取模型字段失败: {} — 将使用基本字段映射", e);
                None
            }
        };
        model_field_names_cache.insert(model_name, loaded);
    }

    // 构建notes数组（媒体处理：本地媒体上传 + 字段引用改写 + 未引用媒体作为附件）
    let mut notes: Vec<Note> = Vec::with_capacity(cards.len());
    let mut uploaded_media: HashSet<String> = HashSet::new();
    let mut failed_media: HashSet<String> = HashSet::new();
    for mut card in cards {
        let model_name = card_models
            .get(&card.id)
            .cloned()
            .unwrap_or_else(|| note_type.clone());

        let model_field_names = model_field_names_cache
            .get(&model_name)
            .cloned()
            .unwrap_or(None);

        let mut fields = if let Some(names) = model_field_names.as_ref() {
            build_fields_with_model_names(&card, names, &model_name)
        } else {
            build_basic_fields(&card, &model_name)
        };

        // 遮挡卡闭环：Cloze Text 兜底 + imageRef 并入媒体输入（非遮挡卡为 no-op）
        prepare_occlusion_note(&mut card, &mut fields, &mut warnings);

        let (picture, audio) = prepare_note_media(
            &card,
            &mut fields,
            &mut uploaded_media,
            &mut failed_media,
            &mut warnings,
            options,
        )
        .await;

        notes.push(Note {
            deck_name: deck_name.clone(),
            model_name,
            fields,
            tags: card.tags,
            picture,
            audio,
        });
    }
    let notes = notes;

    let total = notes.len();
    let mut note_ids: Vec<Option<u64>> = vec![None; total];
    let mut duplicates = 0usize;

    // canAddNotes 预检（D1）：false 只有在本地结构校验通过时才视为重复；
    // 模型字段未知、首字段为空、字段缺失等情况记为真实失败，避免把结构错误误报为幂等成功。
    //
    // 预检失败/返回数量不一致时【不再乐观假设全部可添加】：
    // 降级为逐条 addNote 并收集逐条结果（重复由 AnkiConnect 的 duplicate 错误判定），
    // 同时把降级原因写入 warnings 供前端展示。
    match can_add_notes(&notes, options.retry_times).await {
        Ok(flags) if flags.len() == total => {
            duplicates = notes
                .iter()
                .zip(flags.iter())
                .filter(|(note, ok)| {
                    !**ok
                        && classify_can_add_false(note, &model_field_names_cache)
                            == CanAddFalseReason::Duplicate
                })
                .count();

            let addable_indices: Vec<usize> = flags
                .iter()
                .enumerate()
                .filter(|(_, ok)| **ok)
                .map(|(index, _)| index)
                .collect();

            // 分批推送（大批量分块 + 失败续传）：
            // 单批失败只影响本批，之前批次已写入 Anki 的结果全部保留；
            // 失败批次的卡片在 note_ids 中保持 None，由调用方按 receipt 续传。
            // 分片大小由设置项 anki_connect_batch_size 控制（已 sanitize）
            for chunk in addable_indices.chunks(options.batch_size) {
                let chunk_notes: Vec<&Note> = chunk.iter().map(|&index| &notes[index]).collect();
                let params = serde_json::json!({ "notes": chunk_notes });
                match invoke_anki_connect_action("addNotes", Some(params), 60, options.retry_times)
                    .await
                {
                    Ok(result) => match serde_json::from_value::<Vec<Option<u64>>>(result) {
                        Ok(added_ids) => {
                            for (slot, note_index) in chunk.iter().enumerate() {
                                note_ids[*note_index] = added_ids.get(slot).cloned().flatten();
                            }
                        }
                        Err(e) => {
                            warnings.push(format!(
                                "解析 addNotes 批次结果失败（{} 张卡片未确认写入）: {}",
                                chunk.len(),
                                e
                            ));
                        }
                    },
                    Err(e) => {
                        warn!("⚠️ addNotes 批次推送失败（{} 张）: {}", chunk.len(), e);
                        warnings.push(format!(
                            "addNotes 批次推送失败（{} 张卡片未写入，可重试续传）: {}",
                            chunk.len(),
                            e
                        ));
                    }
                }
            }
        }
        other => {
            let reason = match other {
                Ok(flags) => format!(
                    "canAddNotes 返回数量不匹配（期望 {}，实际 {}）",
                    total,
                    flags.len()
                ),
                Err(e) => e,
            };
            warn!("⚠️ canAddNotes 预检不可用，降级为逐条 addNote: {}", reason);
            warnings.push(format!(
                "canAddNotes 预检不可用，已降级为逐条 addNote: {}",
                reason
            ));

            for (index, note) in notes.iter().enumerate() {
                let params = serde_json::json!({ "note": note });
                match invoke_anki_connect_action("addNote", Some(params), 30, options.retry_times)
                    .await
                {
                    Ok(result) => match result.as_u64() {
                        Some(id) => note_ids[index] = Some(id),
                        // addNote 结果为 null：Anki 判定为重复但未报错（旧版本行为）
                        None => duplicates += 1,
                    },
                    Err(e) if is_duplicate_note_error(&e) => duplicates += 1,
                    Err(e) => {
                        warnings.push(format!("第 {} 张卡片 addNote 失败: {}", index + 1, e));
                    }
                }
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
        model_errors,
        warnings,
    })
}

/// AnkiConnect addNote 的重复判定：错误信息包含 "duplicate"
/// （官方实现返回 "cannot create note because it is a duplicate"）。
fn is_duplicate_note_error(error: &str) -> bool {
    error.to_lowercase().contains("duplicate")
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
            picture: vec![],
            audio: vec![],
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

    #[test]
    fn note_serialization_omits_empty_media_attachments() {
        let note = basic_note("question", "answer");
        let value = serde_json::to_value(&note).expect("serialize note");
        assert!(value.get("picture").is_none());
        assert!(value.get("audio").is_none());

        let mut with_media = basic_note("question", "answer");
        with_media.picture.push(NoteMediaAttachment {
            data: Some("aGk=".to_string()),
            url: None,
            filename: "img.png".to_string(),
            fields: vec!["Back".to_string()],
        });
        let value = serde_json::to_value(&with_media).expect("serialize note with media");
        assert_eq!(value["picture"][0]["filename"], "img.png");
        assert_eq!(value["picture"][0]["data"], "aGk=");
        assert!(value["picture"][0].get("url").is_none());
        assert_eq!(value["picture"][0]["fields"][0], "Back");
    }

    #[test]
    fn media_filename_classification_and_ref_extraction() {
        assert!(is_audio_media_filename("clip.mp3"));
        assert!(is_audio_media_filename("CLIP.WAV"));
        assert!(!is_audio_media_filename("img.png"));
        assert!(!is_audio_media_filename("noext"));

        let html =
            r#"<img src="one.png"> text <img src='/abs/two.jpg'/> [sound:clip.mp3] src= broken"#;
        assert_eq!(
            extract_field_media_refs(html),
            vec!["one.png", "/abs/two.jpg", "clip.mp3"]
        );

        assert_eq!(
            media_basename("/abs/path/pic.png").as_deref(),
            Some("pic.png")
        );
        assert_eq!(media_basename("pic.png").as_deref(), Some("pic.png"));
        assert_eq!(media_basename(""), None);
    }

    #[test]
    fn read_media_file_base64_reads_and_limits() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("img.png");
        std::fs::write(&path, b"hi").expect("write media");
        assert_eq!(read_media_file_base64(&path).expect("encode"), "aGk=");

        let missing = dir.path().join("missing.png");
        assert!(read_media_file_base64(&missing).is_err());
    }

    #[test]
    fn duplicate_note_error_detection_is_case_insensitive() {
        assert!(is_duplicate_note_error(
            "cannot create note because it is a duplicate"
        ));
        assert!(is_duplicate_note_error(
            "AnkiConnect错误(addNote): Duplicate"
        ));
        assert!(!is_duplicate_note_error("model was not found: Basic"));
    }

    #[test]
    fn sync_report_omits_empty_optional_fields_for_backward_compat() {
        let report = AnkiSyncReport {
            note_ids: vec![Some(1), None],
            added: 1,
            duplicates: 1,
            failed: 0,
            created_models: vec![],
            model_errors: vec![],
            warnings: vec![],
        };
        let value = serde_json::to_value(&report).expect("serialize report");
        // 旧契约字段保持存在
        assert_eq!(value["noteIds"][0], 1);
        assert_eq!(value["added"], 1);
        assert_eq!(value["duplicates"], 1);
        assert_eq!(value["failed"], 0);
        assert!(value["createdModels"].as_array().is_some());
        // 新字段为空时不序列化，旧前端零感知
        assert!(value.get("modelErrors").is_none());
        assert!(value.get("warnings").is_none());
    }

    #[test]
    fn sync_report_serializes_structured_model_errors_when_present() {
        let report = AnkiSyncReport {
            note_ids: vec![None],
            added: 0,
            duplicates: 0,
            failed: 1,
            created_models: vec![],
            model_errors: vec![AnkiSyncModelError {
                model: "Custom".to_string(),
                error: "自动创建模型失败: boom".to_string(),
            }],
            warnings: vec!["canAddNotes 预检不可用，已降级为逐条 addNote: timeout".to_string()],
        };
        let value = serde_json::to_value(&report).expect("serialize report");
        assert_eq!(value["modelErrors"][0]["model"], "Custom");
        assert!(value["modelErrors"][0]["error"]
            .as_str()
            .is_some_and(|e| e.contains("boom")));
        assert!(value["warnings"][0]
            .as_str()
            .is_some_and(|w| w.contains("addNote")));
    }

    // ========================================================================
    // 图像遮挡闭环 + 内部协议字段过滤（Wave2-E r2-04）
    // ========================================================================

    /// 构造带 `_occlusion` spec 的遮挡测试卡（imageRef 可定制，走 serde 默认值）。
    fn occlusion_test_card(text: Option<&str>, image_ref: &str) -> AnkiCard {
        let occlusion_json = serde_json::json!({
            "imageRef": image_ref,
            "boxes": [
                {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2, "label": "左心房", "clozeIndex": 1},
                {"x": 0.6, "y": 0.6, "w": 0.2, "h": 0.2, "label": "右心室", "clozeIndex": 2}
            ]
        })
        .to_string();
        serde_json::from_value(serde_json::json!({
            "front": "正面",
            "back": "背面",
            "text": text,
            "tags": ["image-occlusion"],
            "extra_fields": { "_occlusion": occlusion_json }
        }))
        .expect("build occlusion test card")
    }

    fn plain_test_card() -> AnkiCard {
        serde_json::from_value(serde_json::json!({
            "front": "问题",
            "back": "答案",
            "extra_fields": { "Extra": "补充" }
        }))
        .expect("build plain test card")
    }

    #[test]
    fn internal_protocol_field_predicate_covers_underscore_and_reserved_keys() {
        assert!(is_internal_protocol_field("_occlusion"));
        assert!(is_internal_protocol_field("_qa_flags"));
        assert!(is_internal_protocol_field("_original_generation"));
        assert!(is_internal_protocol_field("AnkiNoteId"));
        assert!(is_internal_protocol_field("ankilapses")); // 大小写不敏感
        assert!(!is_internal_protocol_field("Occlusion")); // 用户/模型正常字段不受影响
        assert!(!is_internal_protocol_field("Front"));
    }

    #[test]
    fn occlusion_json_never_leaks_into_emitted_fields() {
        // 目标模型带官方 IO 的 `Occlusion` 字段 + 一个撞保留键的字段：
        // normalize_key("_occlusion") == "occlusion"，过滤前会碰撞泄漏。
        let mut card = occlusion_test_card(Some("{{c1::左心房}}"), "/abs/diagram.png");
        card.extra_fields
            .insert("_qa_flags".to_string(), "{\"flags\":[]}".to_string());
        card.extra_fields
            .insert("AnkiNoteId".to_string(), "12345".to_string());

        let model_fields = vec![
            "Text".to_string(),
            "Extra".to_string(),
            "Occlusion".to_string(),
            "AnkiNoteId".to_string(),
        ];
        let fields = build_fields_with_model_names(&card, &model_fields, "Cloze");

        // `_occlusion` JSON 与保留键值绝不发出
        assert_eq!(fields.get("Occlusion").map(String::as_str), Some(""));
        assert_eq!(fields.get("AnkiNoteId").map(String::as_str), Some(""));
        assert!(!fields.contains_key("_occlusion"));
        for value in fields.values() {
            assert!(!value.contains("imageRef"), "spec JSON 泄漏: {}", value);
            assert!(!value.contains("_occlusion"));
        }
        // 可复习主路径：Text 是标准 Cloze
        assert!(fields.get("Text").is_some_and(|t| t.contains("{{c")));
    }

    #[test]
    fn occlusion_card_prefers_card_text_and_mounts_image_ref() {
        let authored_text = "<img src=\"diagram.png\"><br>{{c1::左心房}} {{c2::右心室}}";
        let mut card = occlusion_test_card(Some(authored_text), "/abs/diagram.png");
        let model_fields = vec!["Text".to_string(), "Extra".to_string()];
        let mut fields = build_fields_with_model_names(&card, &model_fields, "Cloze");
        let mut warnings = Vec::new();

        prepare_occlusion_note(&mut card, &mut fields, &mut warnings);

        // 优先沿用 card.text（已含 cloze 标记，不重建）
        assert_eq!(fields.get("Text").map(String::as_str), Some(authored_text));
        // imageRef 并入 images，由 prepare_note_media 复用现有上传/picture 附件逻辑
        assert!(card.images.iter().any(|p| p == "/abs/diagram.png"));
        assert!(warnings.is_empty(), "不应产生告警: {:?}", warnings);
    }

    #[test]
    fn occlusion_card_without_cloze_text_rebuilds_from_spec() {
        // 旧数据形态：merge 未写 card.text，Text 落到 front/back 拼接（无 cloze 标记）
        let mut card = occlusion_test_card(None, "/abs/diagram.png");
        let model_fields = vec!["Text".to_string(), "Extra".to_string()];
        let mut fields = build_fields_with_model_names(&card, &model_fields, "Cloze");
        assert!(!fields.get("Text").unwrap().contains("{{c"));
        let mut warnings = Vec::new();

        prepare_occlusion_note(&mut card, &mut fields, &mut warnings);

        let text = fields.get("Text").expect("Text 字段存在");
        assert!(
            text.contains("{{c1::左心房}}"),
            "Text 应重建为标准 Cloze: {}",
            text
        );
        assert!(text.contains("{{c2::右心室}}"));
        // img 引用按包内文件名对齐（imageRef 的 basename），媒体由 images 路径上传
        assert!(
            text.contains("<img src=\"diagram.png\">"),
            "Text 应含图: {}",
            text
        );
        assert!(card.images.iter().any(|p| p == "/abs/diagram.png"));
    }

    #[test]
    fn occlusion_pending_image_ref_is_not_mounted() {
        let mut card = occlusion_test_card(None, "vlm://pending-image");
        let model_fields = vec!["Text".to_string()];
        let mut fields = build_fields_with_model_names(&card, &model_fields, "Cloze");
        let mut warnings = Vec::new();

        prepare_occlusion_note(&mut card, &mut fields, &mut warnings);

        // 占位引用不挂媒体；Cloze 文本仍重建（无 <img>，降级为看标签回忆）
        assert!(card.images.is_empty());
        let text = fields.get("Text").expect("Text 字段存在");
        assert!(text.contains("{{c1::左心房}}"));
        assert!(!text.contains("<img"));
    }

    #[test]
    fn occlusion_invalid_spec_degrades_with_warning() {
        let mut card = plain_test_card();
        card.extra_fields
            .insert("_occlusion".to_string(), "not-json".to_string());
        let model_fields = vec!["Front".to_string(), "Back".to_string()];
        let mut fields = build_fields_with_model_names(&card, &model_fields, "Basic");
        let before = fields.clone();
        let mut warnings = Vec::new();

        prepare_occlusion_note(&mut card, &mut fields, &mut warnings);

        assert_eq!(fields, before, "坏 spec 不得改动字段");
        assert!(card.images.is_empty());
        assert!(warnings.iter().any(|w| w.contains("_occlusion")));
    }

    #[test]
    fn plain_card_regression_prepare_occlusion_note_is_noop() {
        let mut card = plain_test_card();
        let model_fields = vec!["Front".to_string(), "Back".to_string(), "Extra".to_string()];
        let mut fields = build_fields_with_model_names(&card, &model_fields, "Basic");
        let before = fields.clone();
        let mut warnings = Vec::new();

        prepare_occlusion_note(&mut card, &mut fields, &mut warnings);

        assert_eq!(fields, before, "普通卡字段不得改动");
        assert!(card.images.is_empty(), "普通卡不得凭空挂媒体");
        assert!(warnings.is_empty());
        // 普通 extra 字段（非 `_` 前缀、非保留键）照常发出
        assert_eq!(fields.get("Extra").map(String::as_str), Some("补充"));
        assert_eq!(fields.get("Front").map(String::as_str), Some("问题"));
        assert_eq!(fields.get("Back").map(String::as_str), Some("答案"));
    }
}
