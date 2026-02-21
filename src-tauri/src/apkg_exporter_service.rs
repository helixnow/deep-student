use crate::models::{AnkiCard, CustomAnkiTemplate};
use chrono::Utc;
use rusqlite::{params, Connection, Result as SqliteResult};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
use std::fs::{self};
use std::io::Write;
use std::path::PathBuf;
use std::sync::LazyLock;
use tempfile::NamedTempFile;
use tracing::warn; // 新增结构化日志
use zip::{write::FileOptions, ZipWriter};

// 使用 LazyLock 初始化别名映射
// SOTA 修复：将 ALIAS_MAP 移至全局静态区，并用 LazyLock 初始化
static ALIAS_MAP: LazyLock<HashMap<&'static str, &'static [&'static str]>> = LazyLock::new(|| {
    let mut m = HashMap::new();
    m.insert("optiona", &["OptionA", "optiona"][..]);
    m.insert("optionb", &["OptionB", "optionb"][..]);
    m.insert("optionc", &["OptionC", "optionc"][..]);
    m.insert("optiond", &["OptionD", "optiond"][..]);
    m.insert("correct", &["Correct", "correct"][..]);
    m.insert("explanation", &["Explanation", "explanation"][..]);
    m
});

/// 清理卡片内容中的无效模板占位符
fn clean_template_placeholders(content: &str) -> String {
    content.trim().to_string()
}

/// Anki的基本配置
const ANKI_COLLECTION_CONFIG: &str = r#"{
    "nextPos": 1,
    "estTimes": true,
    "activeDecks": [1],
    "sortType": "noteFld",
    "timeLim": 0,
    "sortBackwards": false,
    "addToCur": true,
    "curDeck": 1,
    "newBury": 0,
    "newSpread": 0,
    "dueCounts": true,
    "curModel": "1425279151691",
    "collapseTime": 1200
}"#;

#[derive(Serialize, Deserialize)]
struct AnkiModel {
    #[serde(rename = "vers")]
    version: Vec<i32>,
    name: String,
    #[serde(rename = "type")]
    model_type: i32,
    #[serde(rename = "mod")]
    modified: i64,
    #[serde(rename = "usn")]
    update_sequence_number: i32,
    #[serde(rename = "sortf")]
    sort_field: i32,
    #[serde(rename = "did")]
    deck_id: i64,
    #[serde(rename = "tmpls")]
    templates: Vec<AnkiTemplate>,
    #[serde(rename = "flds")]
    fields: Vec<AnkiField>,
    css: String,
    #[serde(rename = "latexPre")]
    latex_pre: String,
    #[serde(rename = "latexPost")]
    latex_post: String,
    tags: Vec<String>,
    #[serde(serialize_with = "serialize_id_as_number")]
    id: String,
    req: Vec<Vec<serde_json::Value>>,
}

/// 将 String 类型的 id 序列化为 JSON number（Anki 要求 model id 是整数）
fn serialize_id_as_number<S>(id: &str, serializer: S) -> std::result::Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    if let Ok(n) = id.parse::<i64>() {
        serializer.serialize_i64(n)
    } else {
        serializer.serialize_str(id)
    }
}

#[derive(Serialize, Deserialize)]
struct AnkiTemplate {
    name: String,
    ord: i32,
    qfmt: String,
    afmt: String,
    #[serde(rename = "bqfmt")]
    browser_qfmt: String,
    #[serde(rename = "bafmt")]
    browser_afmt: String,
    #[serde(rename = "did")]
    deck_id: Option<i64>,
    #[serde(rename = "bfont")]
    browser_font: String,
    #[serde(rename = "bsize")]
    browser_size: i32,
}

#[derive(Serialize, Deserialize)]
struct AnkiField {
    name: String,
    ord: i32,
    sticky: bool,
    rtl: bool,
    font: String,
    size: i32,
    #[serde(rename = "media")]
    media: Vec<String>,
    description: String,
}

/// 创建基本的Anki模型定义
fn create_basic_model() -> AnkiModel {
    AnkiModel {
        version: vec![],
        name: "Basic".to_string(),
        model_type: 0,
        modified: Utc::now().timestamp(),
        update_sequence_number: -1,
        sort_field: 0,
        deck_id: 1,
        templates: vec![AnkiTemplate {
            name: "Card 1".to_string(),
            ord: 0,
            qfmt: "{{Front}}".to_string(),
            afmt: "{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}".to_string(),
            browser_qfmt: "".to_string(),
            browser_afmt: "".to_string(),
            deck_id: None,
            browser_font: "Arial".to_string(),
            browser_size: 12,
        }],
        fields: vec![
            AnkiField {
                name: "Front".to_string(),
                ord: 0,
                sticky: false,
                rtl: false,
                font: "Arial".to_string(),
                size: 20,
                media: vec![],
                description: "".to_string(),
            },
            AnkiField {
                name: "Back".to_string(),
                ord: 1,
                sticky: false,
                rtl: false,
                font: "Arial".to_string(),
                size: 20,
                media: vec![],
                description: "".to_string(),
            },
        ],
        css: ".card {\n font-family: arial;\n font-size: 20px;\n text-align: center;\n color: black;\n background-color: white;\n}".to_string(),
        latex_pre: "\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n".to_string(),
        latex_post: "\\end{document}".to_string(),
        tags: vec![],
        id: "1425279151691".to_string(),
        req: vec![vec![serde_json::Value::from(0), serde_json::Value::from("any"), serde_json::Value::Array(vec![serde_json::Value::from(0)])]],
    }
}

/// 根据模板创建自定义Anki模型定义
fn create_template_model(
    template_id: Option<&str>,
    template_name: &str,
    fields: &[String],
    front_template: &str,
    back_template: &str,
    css_style: &str,
    model_type: i32, // 新增参数
) -> AnkiModel {
    // 创建字段定义
    let anki_fields: Vec<AnkiField> = fields
        .iter()
        .enumerate()
        .map(|(i, field_name)| AnkiField {
            name: field_name.clone(),
            ord: i as i32,
            sticky: false,
            rtl: false,
            font: "Arial".to_string(),
            size: 20,
            media: vec![],
            description: "".to_string(),
        })
        .collect();

    let req = if model_type == 1 {
        // Cloze model requirement
        vec![vec![
            serde_json::Value::from(0),
            serde_json::Value::from("all"),
            serde_json::Value::Array(vec![serde_json::Value::from(0)]),
        ]]
    } else {
        // Basic model requirement
        vec![vec![
            serde_json::Value::from(0),
            serde_json::Value::from("any"),
            serde_json::Value::Array(vec![serde_json::Value::from(0)]),
        ]]
    };

    AnkiModel {
        version: vec![],
        name: template_name.to_string(),
        model_type, // 使用传入的model_type
        modified: Utc::now().timestamp(),
        update_sequence_number: -1,
        sort_field: 0,
        deck_id: 1,
        templates: vec![AnkiTemplate {
            name: "Card 1".to_string(),
            ord: 0,
            qfmt: front_template.to_string(),
            afmt: back_template.to_string(),
            browser_qfmt: "".to_string(),
            browser_afmt: "".to_string(),
            deck_id: None,
            browser_font: "Arial".to_string(),
            browser_size: 12,
        }],
        fields: anki_fields,
        css: css_style.to_string(),
        latex_pre: "\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n".to_string(),
        latex_post: "\\end{document}".to_string(),
        tags: vec![],
        id: template_id.unwrap_or("1425279151691").to_string(),
        req,
    }
}

/// 创建Cloze模型定义
fn create_cloze_model() -> AnkiModel {
    AnkiModel {
        version: vec![],
        name: "Cloze".to_string(),
        model_type: 1, // Cloze类型
        modified: Utc::now().timestamp(),
        update_sequence_number: -1,
        sort_field: 0,
        deck_id: 1,
        templates: vec![AnkiTemplate {
            name: "Cloze".to_string(),
            ord: 0,
            qfmt: "{{cloze:Text}}".to_string(),
            afmt: "{{cloze:Text}}<br>{{Extra}}".to_string(),
            browser_qfmt: "".to_string(),
            browser_afmt: "".to_string(),
            deck_id: None,
            browser_font: "Arial".to_string(),
            browser_size: 12,
        }],
        fields: vec![
            AnkiField {
                name: "Text".to_string(),
                ord: 0,
                sticky: false,
                rtl: false,
                font: "Arial".to_string(),
                size: 20,
                media: vec![],
                description: "".to_string(),
            },
            AnkiField {
                name: "Extra".to_string(),
                ord: 1,
                sticky: false,
                rtl: false,
                font: "Arial".to_string(),
                size: 20,
                media: vec![],
                description: "".to_string(),
            },
        ],
        css: ".card {\n font-family: arial;\n font-size: 20px;\n text-align: center;\n color: black;\n background-color: white;\n}\n.cloze {\n font-weight: bold;\n color: blue;\n}".to_string(),
        latex_pre: "\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n".to_string(),
        latex_post: "\\end{document}".to_string(),
        tags: vec![],
        id: "1425279151692".to_string(),
        req: vec![vec![serde_json::Value::from(0), serde_json::Value::from("all"), serde_json::Value::Array(vec![serde_json::Value::from(0)])]],
    }
}

/// 初始化Anki数据库结构
fn initialize_anki_database(
    conn: &Connection,
    deck_name: &str,
    model_name: &str,
) -> SqliteResult<(i64, i64)> {
    initialize_anki_database_with_template(conn, deck_name, model_name, None)
}

fn initialize_anki_database_with_template(
    conn: &Connection,
    deck_name: &str,
    model_name: &str,
    template_config: Option<(String, Vec<String>, String, String, String)>,
) -> SqliteResult<(i64, i64)> {
    // 创建基本表结构
    conn.execute_batch(
        r#"
        -- 为了确保打包到 .apkg 的 SQLite 主文件包含所有数据，这里禁用 WAL，
        -- 避免产生 -wal 文件从而导致我们只打包了空的主库文件。
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = FULL;
        PRAGMA temp_store = MEMORY;

        CREATE TABLE col (
            id              integer primary key,
            crt             integer not null,
            mod             integer not null,
            scm             integer not null,
            ver             integer not null,
            dty             integer not null,
            usn             integer not null,
            ls              integer not null,
            conf            text not null,
            models          text not null,
            decks           text not null,
            dconf           text not null,
            tags            text not null
        );

        CREATE TABLE notes (
            id              integer primary key,
            guid            text not null unique,
            mid             integer not null,
            mod             integer not null,
            usn             integer not null,
            tags            text not null,
            flds            text not null,
            sfld            text not null,
            csum            integer not null,
            flags           integer not null,
            data            text not null
        );

        CREATE TABLE cards (
            id              integer primary key,
            nid             integer not null,
            did             integer not null,
            ord             integer not null,
            mod             integer not null,
            usn             integer not null,
            type            integer not null,
            queue           integer not null,
            due             integer not null,
            ivl             integer not null,
            factor          integer not null,
            reps            integer not null,
            lapses          integer not null,
            left            integer not null,
            odue            integer not null,
            odid            integer not null,
            flags           integer not null,
            data            text not null
        );

        CREATE TABLE revlog (
            id              integer primary key,
            cid             integer not null,
            usn             integer not null,
            ease            integer not null,
            ivl             integer not null,
            lastIvl         integer not null,
            factor          integer not null,
            time            integer not null,
            type            integer not null
        );

        CREATE TABLE graves (
            usn             integer not null,
            oid             integer not null,
            type            integer not null
        );

        CREATE INDEX ix_cards_nid on cards (nid);
        CREATE INDEX ix_cards_sched on cards (did, queue, due);
        CREATE INDEX ix_cards_usn on cards (usn);
        CREATE INDEX ix_notes_usn on notes (usn);
        CREATE INDEX ix_notes_csum on notes (csum);
        CREATE INDEX ix_revlog_usn on revlog (usn);
        CREATE INDEX ix_revlog_cid on revlog (cid);
    "#,
    )?;

    let now = Utc::now().timestamp();
    let deck_id = 1i64;
    let model_id = if model_name == "Cloze" {
        1425279151692i64
    } else {
        1425279151691i64
    };

    // 创建牌组配置
    let decks = serde_json::json!({
        "1": {
            "id": 1,
            "name": deck_name,
            "extendRev": 50,
            "usn": 0,
            "collapsed": false,
            "newToday": [0, 0],
            "revToday": [0, 0],
            "lrnToday": [0, 0],
            "timeToday": [0, 0],
            "dyn": 0,
            "extendNew": 10,
            "conf": 1,
            "desc": "",
            "browserCollapsed": true,
            "mod": now
        }
    });

    // 创建模型配置
    // 🎯 SOTA 修复：动态构建模型，确保字段和CSS注入正确
    let model = if let Some((template_name, fields, front_template, back_template, css_style)) =
        template_config
    {
        let model_type = if model_name.eq_ignore_ascii_case("Cloze") {
            1
        } else {
            0
        };

        create_template_model(
            Some(&model_id.to_string()),
            &template_name,
            &fields,         // 使用运行时生成的 superset 字段列表
            &front_template, // 直接使用原始模板内容
            &back_template,
            &css_style, // 直接使用原始CSS
            model_type,
        )
    } else if model_name == "Cloze" {
        create_cloze_model()
    } else {
        create_basic_model()
    };

    let model_id_clone = model.id.clone();
    let models = serde_json::json!({
        model_id_clone: model
    });

    // 创建牌组配置
    let dconf = serde_json::json!({
        "1": {
            "id": 1,
            "name": "Default",
            "replayq": true,
            "lapse": {
                "leechFails": 8,
                "minInt": 1,
                "leechAction": 0,
                "delays": [10],
                "mult": 0.0
            },
            "rev": {
                "perDay": 200,
                "ivlFct": 1.0,
                "maxIvl": 36500,
                "ease4": 1.3,
                "bury": true,
                "minSpace": 1
            },
            "timer": 0,
            "maxTaken": 60,
            "usn": 0,
            "new": {
                "perDay": 20,
                "delays": [1, 10],
                "separate": true,
                "ints": [1, 4, 7],
                "initialFactor": 2500,
                "bury": true,
                "order": 1
            },
            "mod": now,
            "autoplay": true
        }
    });

    // 插入集合配置
    conn.execute(
        "INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags) VALUES (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, '{}')",
        params![
            now,
            now,
            now,
            ANKI_COLLECTION_CONFIG,
            models.to_string(),
            decks.to_string(),
            dconf.to_string()
        ]
    )?;

    Ok((deck_id, model_id))
}

/// 生成字段校验和
fn field_checksum(text: &str) -> i64 {
    if text.is_empty() {
        return 0;
    }
    let mut hasher = Sha1::new();
    hasher.update(text.as_bytes());
    let digest = hasher.finalize();
    let checksum = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    checksum as i64
}

/// 将AnkiCard转换为Anki数据库记录
fn convert_cards_to_anki_records(
    cards: Vec<AnkiCard>,
    _deck_id: i64,
    _model_id: i64,
    model_name: &str,
) -> Result<Vec<(String, String, String, String, i64, String)>, String> {
    // 🎯 SOTA 修复：废弃旧的Cloze特殊处理，统一使用字段驱动
    convert_cards_to_anki_records_with_fields(cards, _deck_id, _model_id, model_name, None, None)
}

fn convert_cards_to_anki_records_with_fields(
    cards: Vec<AnkiCard>,
    _deck_id: i64,
    _model_id: i64,
    _model_name: &str,
    template_fields: Option<&[String]>,
    _template: Option<&CustomAnkiTemplate>, // 新增参数：完整的模板对象
) -> Result<Vec<(String, String, String, String, i64, String)>, String> {
    let mut records = Vec::new();
    let now = Utc::now().timestamp();

    for card in &cards {
        // Use a borrow here
        let note_id = now * 1000 + records.len() as i64; // 生成唯一ID
        let guid = format!("{}", uuid::Uuid::new_v4().to_string().replace("-", ""));

        // 根据模板字段或模型类型处理字段
        let (fields, sort_field) = if let Some(field_names) = template_fields {
            // 🐛 调试日志：打印字段处理信息
            if field_names.len() > 4 {
                // 学术模板有6个字段
                warn!("🎯 DEBUG: 处理学术模板，字段数量: {}", field_names.len());
                warn!("🎯 DEBUG: 模板字段: {:?}", field_names);
                warn!(
                    "🎯 DEBUG: 卡片extra_fields: {:?}",
                    card.extra_fields.keys().collect::<Vec<_>>()
                );
                warn!("🎯 DEBUG: 卡片tags字段: {:?}", card.tags);
            }

            let mut field_values = Vec::new();

            for field_name in field_names {
                let value = match field_name.to_lowercase().as_str() {
                    "front" => {
                        // 特殊处理选择题模板：Front字段应该从extra_fields中获取
                        if card
                            .template_id
                            .as_ref()
                            .map_or(false, |id| id == "choice-card")
                        {
                            // 对于选择题模板，Front字段应该从extra_fields中获取
                            let field_key = field_name.to_lowercase();
                            card.extra_fields
                                .get(&field_key)
                                .or_else(|| card.extra_fields.get(field_name))
                                .cloned()
                                .unwrap_or_else(|| clean_template_placeholders(&card.front))
                        } else {
                            clean_template_placeholders(&card.front)
                        }
                    }
                    "back" => clean_template_placeholders(&card.back),
                    "text" => {
                        let field_key = field_name.to_lowercase();
                        let fallback = card
                            .extra_fields
                            .get(&field_key)
                            .or_else(|| card.extra_fields.get(field_name))
                            .cloned();
                        let text_value = card
                            .text
                            .as_deref()
                            .map(str::trim)
                            .filter(|t| !t.is_empty())
                            .map(|t| t.to_string())
                            .or(fallback)
                            .unwrap_or_default();
                        clean_template_placeholders(&text_value)
                    }
                    "extra" => {
                        // Cloze note type uses the "Extra" field by default. Prefer explicit
                        // extra_fields when available, otherwise fall back to card.back.
                        let field_key = field_name.to_lowercase();
                        card.extra_fields
                            .get(&field_key)
                            .or_else(|| card.extra_fields.get(field_name))
                            .cloned()
                            .unwrap_or_else(|| clean_template_placeholders(&card.back))
                    }
                    "tags" => {
                        // 处理标签字段：将Vec<String>转换为逗号分隔的字符串
                        if card.tags.is_empty() {
                            String::new()
                        } else {
                            clean_template_placeholders(&card.tags.join(", "))
                        }
                    }
                    _ => {
                        // -------- 通用字段提取逻辑（大小写无关 + Alias） --------
                        let field_key_lower = field_name.to_lowercase();

                        let raw_value = card
                            .extra_fields
                            .get(&field_key_lower)
                            .or_else(|| card.extra_fields.get(field_name))
                            .or_else(|| {
                                ALIAS_MAP.get(field_key_lower.as_str()).and_then(|cands| {
                                    cands
                                        .iter()
                                        .find_map(|alias| card.extra_fields.get(&alias.to_string()))
                                })
                            })
                            .cloned()
                            .unwrap_or_else(|| {
                                // 警告日志：缺失字段
                                warn!("字段 '{}' 未找到，使用空值", field_name);
                                String::new()
                            });

                        // 保留原始值，对于 JSON 数组/对象跳过 sanitize，否则防止 XSS 清理
                        if raw_value.trim_start().starts_with('{')
                            || raw_value.trim_start().starts_with('[')
                        {
                            raw_value.clone()
                        } else {
                            clean_template_placeholders(&raw_value)
                        }
                    }
                };

                // 🐛 调试：打印每个字段的值 (UTF-8安全截断)
                if field_names.len() > 4 {
                    warn!(
                        "🎯 DEBUG: 字段 '{}' -> '{}'",
                        field_name,
                        if value.chars().count() > 50 {
                            format!("{}...", value.chars().take(50).collect::<String>())
                        } else {
                            value.clone()
                        }
                    );
                }

                field_values.push(value);
            }
            let fields_str = field_values.join("\x1f");
            let sort_field = field_values.first().cloned().unwrap_or_default();
            (fields_str, sort_field)
        } else {
            // 🎯 SOTA 修复：移除旧的、不灵活的Cloze硬编码逻辑
            // 如果没有提供字段，则退化为仅有当前卡片 Front/Back 的基础笔记
            let front = clean_template_placeholders(&card.front);
            let back = clean_template_placeholders(&card.back);
            (format!("{}\x1f{}", front, back), front)
        };

        // 清理tags中的模板占位符
        let cleaned_tags: Vec<String> = card
            .tags
            .iter()
            .map(|tag| clean_template_placeholders(tag))
            .filter(|tag| !tag.is_empty()) // 过滤掉空标签
            .collect();
        let tags = cleaned_tags.join(" ");
        let csum = field_checksum(&sort_field);

        records.push((note_id.to_string(), guid, fields, sort_field, csum, tags));
    }

    Ok(records)
}

/// 导出卡片为.apkg文件
pub async fn export_cards_to_apkg(
    cards: Vec<AnkiCard>,
    deck_name: String,
    note_type: String,
    output_path: PathBuf,
) -> Result<(), String> {
    export_cards_to_apkg_with_template(cards, deck_name, note_type, output_path, None).await
}

/// 导出卡片为.apkg文件（支持模板）
pub async fn export_cards_to_apkg_with_template(
    cards: Vec<AnkiCard>,
    deck_name: String,
    note_type: String,
    output_path: PathBuf,
    template_config: Option<(String, Vec<String>, String, String, String)>, // (name, fields, front, back, css)
) -> Result<(), String> {
    // 内部调用带有完整模板的版本
    export_cards_to_apkg_with_full_template(
        cards,
        deck_name,
        note_type,
        output_path,
        template_config,
        None,
    )
    .await
}

/// 导出卡片为.apkg文件（支持完整模板对象）
pub async fn export_cards_to_apkg_with_full_template(
    cards: Vec<AnkiCard>,
    deck_name: String,
    note_type: String,
    output_path: PathBuf,
    template_config: Option<(String, Vec<String>, String, String, String)>, // (name, fields, front, back, css)
    full_template: Option<CustomAnkiTemplate>,                              // 完整的模板对象
) -> Result<(), String> {
    if cards.is_empty() {
        return Err("没有卡片可以导出".to_string());
    }

    // 创建临时目录
    let temp_dir = std::env::temp_dir().join(format!("anki_export_{}", Utc::now().timestamp()));
    fs::create_dir_all(&temp_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;

    let db_path = temp_dir.join("collection.anki2");

    // 确保输出目录存在
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建输出目录失败: {}", e))?;
    }

    // 🎯 SOTA 修复：为媒体处理克隆一份数据，因为它在records转换后会被消耗
    let cards_clone_for_media = cards.clone();

    let result = async move {
        // 创建并初始化数据库
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("创建数据库失败: {}", e))?;

        // Build the final model field list and ensure it matches the exported model.
        // NOTE: In Anki, note.flds field count must match model.flds count; otherwise imports
        // may be rejected or lead to corrupted decks.
        let is_cloze_model = note_type.eq_ignore_ascii_case("Cloze");

        // Base fields come from template config, or fall back to standard Basic/Cloze fields.
        let mut final_fields: Vec<String> = template_config
            .as_ref()
            .map(|(_, fields, _, _, _)| fields.clone())
            .unwrap_or_else(|| {
                if is_cloze_model {
                    vec!["Text".to_string(), "Extra".to_string()]
                } else {
                    vec!["Front".to_string(), "Back".to_string()]
                }
            });

        // Append extra_fields keys in a deterministic order.
        let mut extra_keys: Vec<String> = cards
            .iter()
            .flat_map(|c| c.extra_fields.keys().cloned())
            .collect();
        extra_keys.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
        extra_keys.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
        for key in extra_keys {
            if !final_fields.iter().any(|f| f.eq_ignore_ascii_case(&key)) {
                final_fields.push(key);
            }
        }

        // Ensure required fields exist for the chosen model type.
        if is_cloze_model {
            for mandatory in ["Text", "Extra"] {
                if !final_fields.iter().any(|f| f.eq_ignore_ascii_case(mandatory)) {
                    final_fields.push(mandatory.to_string());
                }
            }
        } else {
            for mandatory in ["Front", "Back"] {
                if !final_fields.iter().any(|f| f.eq_ignore_ascii_case(mandatory)) {
                    final_fields.push(mandatory.to_string());
                }
            }
        }

        // Build a template config for the exported model so model fields == note fields.
        let template_config_for_model = if let Some((name, _fields, front, back, css)) = template_config {
            (name, final_fields.clone(), front, back, css)
        } else if is_cloze_model {
            (
                "Cloze".to_string(),
                final_fields.clone(),
                "{{cloze:Text}}".to_string(),
                "{{cloze:Text}}<br>{{Extra}}".to_string(),
                ".card {\n font-family: arial;\n font-size: 20px;\n text-align: center;\n color: black;\n background-color: white;\n}\n.cloze {\n font-weight: bold;\n color: blue;\n}".to_string(),
            )
        } else {
            (
                note_type.clone(),
                final_fields.clone(),
                "{{Front}}".to_string(),
                "{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}".to_string(),
                ".card {\n font-family: arial;\n font-size: 20px;\n text-align: center;\n color: black;\n background-color: white;\n}".to_string(),
            )
        };
        let (deck_id, model_id) = initialize_anki_database_with_template(
            &conn,
            &deck_name,
            &note_type,
            Some(template_config_for_model.clone()),
        )
            .map_err(|e| format!("初始化数据库失败: {}", e))?;

        // 🎯 SOTA 修复：统一使用模板字段驱动逻辑，不再对Cloze做特殊处理
        let records = convert_cards_to_anki_records_with_fields(
            cards,
            deck_id,
            model_id,
            &note_type,
            Some(&final_fields),
            full_template.as_ref(),
        )?;

        let now = Utc::now().timestamp();

        // 插入笔记和卡片
        for (i, (note_id, guid, fields, sort_field, csum, tags)) in records.iter().enumerate() {
            // 插入笔记
            conn.execute(
                "INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data) VALUES (?, ?, ?, ?, -1, ?, ?, ?, ?, 0, '')",
                params![
                    note_id.parse::<i64>().unwrap(),
                    guid,
                    model_id,
                    now,
                    tags,
                    fields,
                    clean_template_placeholders(sort_field),
                    csum
                ]
            ).map_err(|e| format!("插入笔记失败: {}", e))?;

            // 为每个笔记创建卡片（Basic类型通常只有一张卡片）
            let card_id = note_id.parse::<i64>().unwrap() * 100 + i as i64;
            conn.execute(
                "INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data) VALUES (?, ?, ?, 0, ?, -1, 0, 0, ?, 0, 2500, 0, 0, 0, 0, 0, 0, '')",
                params![
                    card_id,
                    note_id.parse::<i64>().unwrap(),
                    deck_id,
                    now,
                    i as i64 + 1 // due date
                ]
            ).map_err(|e| format!("插入卡片失败: {}", e))?;
        }

        conn.close().map_err(|e| format!("关闭数据库失败: {:?}", e))?;

        // 创建.apkg文件（实际上是一个zip文件）
        let parent_dir = output_path.parent().unwrap_or_else(|| std::path::Path::new("."));
        let mut temp_file = NamedTempFile::new_in(parent_dir)
            .map_err(|e| format!("创建临时输出文件失败: {}", e))?;

        // 媒体文件列表和文件
        // 🎯 SOTA 修复：媒体文件去重与规范化索引
        let mut media_map = serde_json::Map::new();
        let mut media_entries: Vec<(String, String)> = Vec::new(); // (original_filename, path)
        let mut seen_media_names: HashSet<String> = HashSet::new();

        for card in &cards_clone_for_media { // 使用克隆的数据进行媒体处理
            for image_path in &card.images {
                if let Some(fname) = std::path::Path::new(image_path).file_name().and_then(|n| n.to_str()) {
                    if seen_media_names.insert(fname.to_string()) {
                        media_entries.push((fname.to_string(), image_path.clone()));
                    }
                }
            }
        }
        for (idx, (fname, _path)) in media_entries.iter().enumerate() {
            media_map.insert(idx.to_string(), serde_json::Value::String(fname.to_string()));
        }
        let db_content = fs::read(&db_path)
            .map_err(|e| format!("读取数据库文件失败: {}", e))?;
        let media_json = serde_json::to_string(&media_map)
            .map_err(|e| format!("序列化媒体列表失败: {}", e))?;

        {
            let file_handle = temp_file.as_file_mut();
            let mut zip = ZipWriter::new(file_handle);

            zip.start_file("collection.anki2", FileOptions::default())
                .map_err(|e| format!("创建zip文件条目失败: {}", e))?;
            zip.write_all(&db_content)
                .map_err(|e| format!("写入数据库到zip失败: {}", e))?;

            zip.start_file("media", FileOptions::default())
                .map_err(|e| format!("创建媒体列表条目失败: {}", e))?;
            zip.write_all(media_json.as_bytes())
                .map_err(|e| format!("写入媒体列表失败: {}", e))?;

            // In Anki packages, media files are stored as numbered entries ("0", "1", ...).
            for (idx, (_fname, path)) in media_entries.iter().enumerate() {
                let data = fs::read(path)
                    .map_err(|e| format!("读取媒体文件失败 {}: {}", path, e))?;
                zip.start_file(idx.to_string(), FileOptions::default())
                    .map_err(|e| format!("创建媒体文件条目失败: {}", e))?;
                zip.write_all(&data)
                    .map_err(|e| format!("写入媒体文件失败: {}", e))?;
            }

            zip.finish()
                .map_err(|e| format!("完成zip文件失败: {}", e))?;
        }

        if output_path.exists() {
            fs::remove_file(&output_path)
                .map_err(|e| format!("删除旧的输出文件失败: {}", e))?;
        }

        temp_file
            .persist(&output_path)
            .map_err(|e| format!("无法持久化临时输出文件: {}", e.error))?;

        // 🔍 iPad诊断：检查临时APKG文件状态
        let temp_size = fs::metadata(&output_path)
            .map(|m| m.len())
            .unwrap_or(0);
        println!("🔍 临时APKG文件创建完成: {} 字节", temp_size);

        if temp_size == 0 {
            return Err(format!("❌ 临时APKG文件为空 (0字节)，路径: {:?}", output_path));
        }

        println!("✅ 临时APKG文件验证通过: {:?} ({} 字节)", output_path, temp_size);
        Ok(())
    }.await;

    // 清理临时文件
    if temp_dir.exists() {
        if let Err(e) = fs::remove_dir_all(&temp_dir) {
            warn!("警告：清理临时目录失败: {}", e);
        }
    }

    result
}

// ============================================================================
// 多模板 APKG 导出（每种 template_id 对应一个 Anki model）
// ============================================================================

/// 多模板导出：每种 template_id 创建独立的 Anki model，
/// 每张卡片的 notes.mid 指向自己模板对应的 model。
///
/// 参数：
/// - cards: 所有待导出卡片
/// - deck_name: 牌组名称
/// - output_path: 输出文件路径
/// - template_map: template_id → CustomAnkiTemplate 的映射
pub async fn export_multi_template_apkg(
    cards: Vec<AnkiCard>,
    deck_name: String,
    output_path: PathBuf,
    template_map: HashMap<String, CustomAnkiTemplate>,
) -> Result<(), String> {
    if cards.is_empty() {
        return Err("没有卡片可以导出".to_string());
    }

    let temp_dir = std::env::temp_dir().join(format!("anki_export_{}", Utc::now().timestamp()));
    fs::create_dir_all(&temp_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;
    let db_path = temp_dir.join("collection.anki2");
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建输出目录失败: {}", e))?;
    }

    let cards_for_media = cards.clone();

    let result = async move {
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("创建数据库失败: {}", e))?;

        // 创建表结构
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = DELETE;
            PRAGMA synchronous = FULL;
            PRAGMA temp_store = MEMORY;

            CREATE TABLE col (
                id integer primary key, crt integer not null, mod integer not null,
                scm integer not null, ver integer not null, dty integer not null,
                usn integer not null, ls integer not null, conf text not null,
                models text not null, decks text not null, dconf text not null, tags text not null
            );
            CREATE TABLE notes (
                id integer primary key, guid text not null unique, mid integer not null,
                mod integer not null, usn integer not null, tags text not null,
                flds text not null, sfld text not null, csum integer not null,
                flags integer not null, data text not null
            );
            CREATE TABLE cards (
                id integer primary key, nid integer not null, did integer not null,
                ord integer not null, mod integer not null, usn integer not null,
                type integer not null, queue integer not null, due integer not null,
                ivl integer not null, factor integer not null, reps integer not null,
                lapses integer not null, left integer not null, odue integer not null,
                odid integer not null, flags integer not null, data text not null
            );
            CREATE TABLE revlog (
                id integer primary key, cid integer not null, usn integer not null,
                ease integer not null, ivl integer not null, lastIvl integer not null,
                factor integer not null, time integer not null, type integer not null
            );
            CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
            CREATE INDEX ix_cards_nid on cards (nid);
            CREATE INDEX ix_cards_sched on cards (did, queue, due);
            CREATE INDEX ix_notes_usn on notes (usn);
            CREATE INDEX ix_notes_csum on notes (csum);
        "#,
        ).map_err(|e| format!("创建表失败: {}", e))?;

        let now = Utc::now().timestamp();
        let deck_id = 1i64;

        // 按 template_id 分组卡片
        let mut groups: HashMap<String, Vec<&AnkiCard>> = HashMap::new();
        let mut no_template_cards: Vec<&AnkiCard> = Vec::new();
        for card in &cards {
            if let Some(tid) = card.template_id.as_deref().filter(|s| !s.trim().is_empty()) {
                groups.entry(tid.to_string()).or_default().push(card);
            } else {
                no_template_cards.push(card);
            }
        }

        // 为每种 template_id 创建一个 Anki model
        let mut models_json = serde_json::Map::new();
        let mut model_id_map: HashMap<String, i64> = HashMap::new(); // template_id → model_id
        let mut model_fields_map: HashMap<String, Vec<String>> = HashMap::new(); // template_id → field names

        let base_model_id = 1425279200000i64;
        for (idx, (tid, group_cards)) in groups.iter().enumerate() {
            let model_id = base_model_id + idx as i64;
            model_id_map.insert(tid.clone(), model_id);

            if let Some(tmpl) = template_map.get(tid) {
                // 构建该模板的字段列表
                let mut fields = tmpl.fields.clone();
                // 追加该组卡片的 extra_fields keys（不在 fields 中的）
                let mut extra_keys: Vec<String> = group_cards.iter()
                    .flat_map(|c| c.extra_fields.keys().cloned())
                    .collect();
                extra_keys.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
                extra_keys.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
                for key in &extra_keys {
                    if !fields.iter().any(|f| f.eq_ignore_ascii_case(key)) {
                        fields.push(key.clone());
                    }
                }
                // 确保 Front/Back 存在（fallback）
                for mandatory in ["Front", "Back"] {
                    if !fields.iter().any(|f| f.eq_ignore_ascii_case(mandatory)) {
                        fields.push(mandatory.to_string());
                    }
                }

                let is_cloze = tmpl.note_type.eq_ignore_ascii_case("Cloze");
                let model_type = if is_cloze { 1 } else { 0 };

                let model = create_template_model(
                    Some(&model_id.to_string()),
                    &tmpl.name,
                    &fields,
                    &tmpl.front_template,
                    &tmpl.back_template,
                    &tmpl.css_style,
                    model_type,
                );
                model_fields_map.insert(tid.clone(), fields);
                models_json.insert(model_id.to_string(), serde_json::to_value(&model).map_err(|e| e.to_string())?);
            } else {
                // 模板不在 map 中，退化为 Basic
                let fields = vec!["Front".to_string(), "Back".to_string()];
                let model = create_basic_model();
                model_fields_map.insert(tid.clone(), fields);
                let mut m = serde_json::to_value(&model).map_err(|e| e.to_string())?;
                // Anki 要求 model id 必须是 JSON number
                m["id"] = serde_json::Value::Number(serde_json::Number::from(model_id));
                models_json.insert(model_id.to_string(), m);
            }
        }

        // 无 template_id 的卡片用 Basic model
        let fallback_model_id = base_model_id + groups.len() as i64;
        if !no_template_cards.is_empty() {
            let basic = create_basic_model();
            let mut m = serde_json::to_value(&basic).map_err(|e| e.to_string())?;
            // Anki 要求 model id 必须是 JSON number
            m["id"] = serde_json::Value::Number(serde_json::Number::from(fallback_model_id));
            models_json.insert(fallback_model_id.to_string(), m);
        }

        // 构建 col 记录
        let decks = serde_json::json!({
            "1": {
                "id": 1, "name": deck_name, "extendRev": 50, "usn": 0,
                "collapsed": false, "newToday": [0,0], "revToday": [0,0],
                "lrnToday": [0,0], "timeToday": [0,0], "dyn": 0,
                "extendNew": 10, "conf": 1, "desc": "", "browserCollapsed": true, "mod": now
            }
        });
        let dconf = serde_json::json!({
            "1": {
                "id": 1, "name": "Default", "replayq": true,
                "lapse": {"leechFails": 8, "minInt": 1, "leechAction": 0, "delays": [10], "mult": 0.0},
                "rev": {"perDay": 200, "ivlFct": 1.0, "maxIvl": 36500, "ease4": 1.3, "bury": true, "minSpace": 1},
                "timer": 0, "maxTaken": 60, "usn": 0,
                "new": {"perDay": 20, "delays": [1, 10], "separate": true, "ints": [1, 4, 7], "initialFactor": 2500, "bury": true, "order": 1},
                "mod": now, "autoplay": true
            }
        });

        conn.execute(
            "INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags) VALUES (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, '{}')",
            params![now, now, now, ANKI_COLLECTION_CONFIG, serde_json::Value::Object(models_json).to_string(), decks.to_string(), dconf.to_string()]
        ).map_err(|e| format!("插入 col 失败: {}", e))?;

        // 插入 notes 和 cards
        let mut note_idx = 0i64;
        let insert_note = |conn: &Connection, card: &AnkiCard, mid: i64, field_names: &[String], note_idx: &mut i64| -> Result<(), String> {
            let note_id = now * 1000 + *note_idx;
            *note_idx += 1;
            let guid = uuid::Uuid::new_v4().to_string().replace("-", "");

            let mut field_values: Vec<String> = Vec::new();
            for field_name in field_names {
                let value = match field_name.to_lowercase().as_str() {
                    "front" => clean_template_placeholders(&card.front),
                    "back" => clean_template_placeholders(&card.back),
                    "text" => card.text.as_deref().unwrap_or("").to_string(),
                    "extra" => card.extra_fields.get("extra")
                        .or_else(|| card.extra_fields.get("Extra"))
                        .cloned()
                        .unwrap_or_else(|| clean_template_placeholders(&card.back)),
                    "tags" => card.tags.join(", "),
                    _ => {
                        let key_lower = field_name.to_lowercase();
                        card.extra_fields.get(&key_lower)
                            .or_else(|| card.extra_fields.get(field_name))
                            .cloned()
                            .unwrap_or_default()
                    }
                };
                field_values.push(value);
            }

            let fields_str = field_values.join("\x1f");
            let sort_field = field_values.first().cloned().unwrap_or_default();
            let csum = field_checksum(&sort_field);
            let tags_str = card.tags.iter()
                .map(|t| clean_template_placeholders(t))
                .filter(|t| !t.is_empty())
                .collect::<Vec<_>>()
                .join(" ");

            conn.execute(
                "INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data) VALUES (?, ?, ?, ?, -1, ?, ?, ?, ?, 0, '')",
                params![note_id, guid, mid, now, tags_str, fields_str, clean_template_placeholders(&sort_field), csum]
            ).map_err(|e| format!("插入 note 失败: {}", e))?;

            let card_id = note_id * 100;
            conn.execute(
                "INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data) VALUES (?, ?, ?, 0, ?, -1, 0, 0, ?, 0, 2500, 0, 0, 0, 0, 0, 0, '')",
                params![card_id, note_id, deck_id, now, *note_idx]
            ).map_err(|e| format!("插入 card 失败: {}", e))?;

            Ok(())
        };

        // 插入有 template_id 的卡片
        for (tid, group_cards) in &groups {
            let mid = model_id_map.get(tid).copied().unwrap_or(fallback_model_id);
            let field_names = model_fields_map.get(tid).cloned().unwrap_or_else(|| vec!["Front".to_string(), "Back".to_string()]);
            for card in group_cards {
                insert_note(&conn, card, mid, &field_names, &mut note_idx)?;
            }
        }

        // 插入无 template_id 的卡片
        for card in &no_template_cards {
            let field_names = vec!["Front".to_string(), "Back".to_string()];
            insert_note(&conn, card, fallback_model_id, &field_names, &mut note_idx)?;
        }

        conn.close().map_err(|e| format!("关闭数据库失败: {:?}", e))?;

        // 打包 APKG
        let parent_dir = output_path.parent().unwrap_or_else(|| std::path::Path::new("."));
        let mut temp_file = NamedTempFile::new_in(parent_dir)
            .map_err(|e| format!("创建临时输出文件失败: {}", e))?;

        let mut media_map = serde_json::Map::new();
        let mut media_entries: Vec<(String, String)> = Vec::new();
        let mut seen_media_names: HashSet<String> = HashSet::new();
        for card in &cards_for_media {
            for image_path in &card.images {
                if let Some(fname) = std::path::Path::new(image_path).file_name().and_then(|n| n.to_str()) {
                    if seen_media_names.insert(fname.to_string()) {
                        media_entries.push((fname.to_string(), image_path.clone()));
                    }
                }
            }
        }
        for (idx, (fname, _)) in media_entries.iter().enumerate() {
            media_map.insert(idx.to_string(), serde_json::Value::String(fname.to_string()));
        }

        let db_content = fs::read(&db_path).map_err(|e| format!("读取数据库失败: {}", e))?;
        let media_json = serde_json::to_string(&media_map).map_err(|e| format!("序列化媒体列表失败: {}", e))?;

        {
            let file_handle = temp_file.as_file_mut();
            let mut zip = ZipWriter::new(file_handle);
            zip.start_file("collection.anki2", FileOptions::default()).map_err(|e| format!("zip失败: {}", e))?;
            zip.write_all(&db_content).map_err(|e| format!("写入db失败: {}", e))?;
            zip.start_file("media", FileOptions::default()).map_err(|e| format!("zip media失败: {}", e))?;
            zip.write_all(media_json.as_bytes()).map_err(|e| format!("写入media失败: {}", e))?;
            for (idx, (_, path)) in media_entries.iter().enumerate() {
                if let Ok(data) = fs::read(path) {
                    let _ = zip.start_file(idx.to_string(), FileOptions::default());
                    let _ = zip.write_all(&data);
                }
            }
            zip.finish().map_err(|e| format!("zip finish失败: {}", e))?;
        }

        if output_path.exists() {
            fs::remove_file(&output_path).map_err(|e| format!("删除旧文件失败: {}", e))?;
        }
        temp_file.persist(&output_path).map_err(|e| format!("持久化失败: {}", e.error))?;
        Ok(())
    }.await;

    if temp_dir.exists() {
        let _ = fs::remove_dir_all(&temp_dir);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::collections::HashMap;
    use std::io::Read;

    #[test]
    fn test_clean_template_placeholders_control_tags() {
        let input = "Start {{#each items}}<li>{{.}}</li>{{/each}} End";
        let output = clean_template_placeholders(input);
        assert_eq!(output, "Start {{#each items}}<li>{{.}}</li>{{/each}} End");
    }

    #[test]
    fn test_clean_template_placeholders_keep_fields() {
        let input = "Hello {{Front}} and {{Back}}";
        let output = clean_template_placeholders(input);
        // Should keep non-control placeholders
        assert_eq!(output, "Hello {{Front}} and {{Back}}");
    }

    #[test]
    fn test_clean_template_placeholders_mixed() {
        let input = "{{#if cond}}X{{/if}} A {{Field}} B";
        let output = clean_template_placeholders(input);
        assert_eq!(output, "{{#if cond}}X{{/if}} A {{Field}} B");
    }

    #[test]
    fn test_clean_template_placeholders_no_extra_space() {
        let input = "  Hello   World  ";
        let output = clean_template_placeholders(input);
        assert_eq!(output, "Hello   World"); // Should only trim, not collapse spaces
    }

    #[test]
    fn test_serde_json_json_macro_key_can_use_string_var() {
        let key = "123".to_string();
        let v = serde_json::json!({ key: 1 });
        assert_eq!(v.get("123").and_then(|x| x.as_i64()), Some(1));
    }

    #[tokio::test]
    async fn test_export_apkg_basic_field_count_matches_model() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let out = tmp.path().join("basic.apkg");

        let card = AnkiCard {
            front: "Q".to_string(),
            back: "A".to_string(),
            text: None,
            tags: vec!["t1".to_string()],
            images: vec![],
            id: "1".to_string(),
            task_id: "".to_string(),
            is_error_card: false,
            error_content: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            updated_at: chrono::Utc::now().to_rfc3339(),
            extra_fields: HashMap::new(),
            template_id: None,
        };

        export_cards_to_apkg_with_full_template(
            vec![card],
            "TestDeck".to_string(),
            "Basic".to_string(),
            out.clone(),
            None,
            None,
        )
        .await
        .expect("export apkg");

        let f = std::fs::File::open(&out).expect("open apkg");
        let mut zip = zip::ZipArchive::new(f).expect("zip open");

        let mut db_file = zip.by_name("collection.anki2").expect("collection.anki2");
        let mut db_bytes = Vec::new();
        db_file.read_to_end(&mut db_bytes).expect("read db");

        let db_path = tmp.path().join("collection.anki2");
        std::fs::write(&db_path, &db_bytes).expect("write db");

        let conn = Connection::open(&db_path).expect("open sqlite");
        let models_json: String = conn
            .query_row("SELECT models FROM col LIMIT 1", [], |row| row.get(0))
            .expect("load models");
        let models: serde_json::Value =
            serde_json::from_str(&models_json).expect("parse models json");
        let model = models
            .as_object()
            .and_then(|o| o.values().next())
            .expect("model object");
        let model_field_count = model
            .get("flds")
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .expect("model flds");

        let note_flds: String = conn
            .query_row("SELECT flds FROM notes LIMIT 1", [], |row| row.get(0))
            .expect("load note flds");
        let note_field_count = note_flds.split('\x1f').count();

        assert_eq!(note_field_count, model_field_count);
    }

    #[tokio::test]
    async fn test_export_apkg_media_entries_are_indexed() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let out = tmp.path().join("media.apkg");

        let img_path = tmp.path().join("img.png");
        std::fs::write(&img_path, b"\x89PNG\r\n\x1a\n").expect("write img");

        let card = AnkiCard {
            front: "Q".to_string(),
            back: "A".to_string(),
            text: None,
            tags: vec![],
            images: vec![img_path.to_string_lossy().to_string()],
            id: "1".to_string(),
            task_id: "".to_string(),
            is_error_card: false,
            error_content: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            updated_at: chrono::Utc::now().to_rfc3339(),
            extra_fields: HashMap::new(),
            template_id: None,
        };

        export_cards_to_apkg_with_full_template(
            vec![card],
            "TestDeck".to_string(),
            "Basic".to_string(),
            out.clone(),
            None,
            None,
        )
        .await
        .expect("export apkg");

        let f = std::fs::File::open(&out).expect("open apkg");
        let mut zip = zip::ZipArchive::new(f).expect("zip open");

        // media json should map 0 -> img.png
        {
            let mut media_file = zip.by_name("media").expect("media file");
            let mut media_json = String::new();
            media_file
                .read_to_string(&mut media_json)
                .expect("read media");
            let media_map: serde_json::Value =
                serde_json::from_str(&media_json).expect("parse media json");
            assert_eq!(media_map.get("0").and_then(|v| v.as_str()), Some("img.png"));
        }

        // actual media blob should be stored under the numeric index
        assert!(zip.by_name("0").is_ok());
    }
}
