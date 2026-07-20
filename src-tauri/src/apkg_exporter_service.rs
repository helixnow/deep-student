use crate::models::{AnkiCard, CustomAnkiTemplate};
use chrono::Utc;
use rusqlite::{params, Connection, Result as SqliteResult};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::{self};
use std::io::{Seek, Write};
use std::path::PathBuf;
use std::sync::LazyLock;
use tempfile::NamedTempFile;
use tracing::{debug, warn}; // 结构化日志
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

const DEEP_STUDENT_TEMPLATE_ID_KEY: &str = "deepStudentTemplateId";
const DEEP_STUDENT_COLLAPSE_CLOZE_ORDS_KEY: &str = "deepStudentCollapseClozeOrds";

/// 清理卡片内容中的无效模板占位符
fn clean_template_placeholders(content: &str) -> String {
    content.trim().to_string()
}

// F9（round2）：全局单调 note_id 生成器，确保跨导出 / 同毫秒多次导出都不碰撞。
// 旧实现用「秒*1000+序号」，同秒多次导出可产生相同 id（虽有 guid 去重，仍属脆弱）。
static APKG_NOTE_ID_GEN: LazyLock<std::sync::atomic::AtomicI64> =
    LazyLock::new(|| std::sync::atomic::AtomicI64::new(Utc::now().timestamp_millis()));
static APKG_CARD_ID_GEN: LazyLock<std::sync::atomic::AtomicI64> =
    LazyLock::new(|| std::sync::atomic::AtomicI64::new(Utc::now().timestamp_millis()));

/// 返回严格单调递增的 note_id；尽量贴近毫秒时间戳习惯，但绝不回退或重复。
fn next_apkg_note_id() -> i64 {
    use std::sync::atomic::Ordering;
    let now_ms = Utc::now().timestamp_millis();
    loop {
        let prev = APKG_NOTE_ID_GEN.load(Ordering::Relaxed);
        let next = std::cmp::max(prev + 1, now_ms);
        if APKG_NOTE_ID_GEN
            .compare_exchange_weak(prev, next, Ordering::SeqCst, Ordering::Relaxed)
            .is_ok()
        {
            return next;
        }
    }
}

fn next_apkg_card_id() -> i64 {
    use std::sync::atomic::Ordering;
    let now_ms = Utc::now().timestamp_millis();
    loop {
        let prev = APKG_CARD_ID_GEN.load(Ordering::Relaxed);
        let next = std::cmp::max(prev + 1, now_ms);
        if APKG_CARD_ID_GEN
            .compare_exchange_weak(prev, next, Ordering::SeqCst, Ordering::Relaxed)
            .is_ok()
        {
            return next;
        }
    }
}

/// Extract the Anki card ordinals represented by valid Cloze markers.
/// `{{cN::answer}}` and `{{cN::answer::hint}}` map to `ord = N - 1`.
fn cloze_card_ords(text: &str) -> Vec<i64> {
    let mut ords = BTreeSet::new();
    let mut search_from = 0usize;

    while let Some(relative_start) = text[search_from..].find("{{c") {
        let marker_start = search_from + relative_start;
        let number_start = marker_start + 3;
        let digit_count = text[number_start..]
            .bytes()
            .take_while(u8::is_ascii_digit)
            .count();
        if digit_count == 0 {
            search_from = number_start;
            continue;
        }

        let number_end = number_start + digit_count;
        if !text[number_end..].starts_with("::") {
            search_from = number_end;
            continue;
        }

        let answer_start = number_end + 2;
        let remainder = &text[answer_start..];
        let Some(relative_close) = remainder.find("}}") else {
            break;
        };
        if let Some(relative_nested) = remainder.find("{{c") {
            if relative_nested < relative_close {
                search_from = answer_start + relative_nested;
                continue;
            }
        }

        let marker_end = answer_start + relative_close;
        let body = &text[answer_start..marker_end];
        let answer = body.split_once("::").map_or(body, |(answer, _)| answer);
        if !answer.trim().is_empty() {
            if let Ok(number) = text[number_start..number_end].parse::<u64>() {
                if let Some(ord) = number
                    .checked_sub(1)
                    .and_then(|value| i64::try_from(value).ok())
                {
                    ords.insert(ord);
                }
            }
        }
        search_from = marker_end + 2;
    }

    if ords.is_empty() {
        vec![0]
    } else {
        ords.into_iter().collect()
    }
}

fn insert_anki_card_rows(
    conn: &Connection,
    note_id: i64,
    deck_id: i64,
    now: i64,
    card_ords: &[i64],
    next_due: &mut i64,
) -> Result<(), String> {
    for ord in card_ords {
        let card_id = next_apkg_card_id();
        let due = *next_due;
        *next_due = next_due
            .checked_add(1)
            .ok_or_else(|| "Anki card due position overflow".to_string())?;
        conn.execute(
            "INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data) VALUES (?, ?, ?, ?, ?, -1, 0, 0, ?, 0, 2500, 0, 0, 0, 0, 0, 0, '')",
            params![card_id, note_id, deck_id, ord, now, due],
        )
        .map_err(|error| format!("插入卡片失败: {}", error))?;
    }
    Ok(())
}

/// 粗略剥离 HTML 标签（仅用于校验和计算）。
/// F13（round2）：对齐 Anki —— note 的 csum 基于「strip-HTML 后的首字段」；
/// 本函数不影响存储的 flds/sfld，只影响 Anki 端重复检测的精度。
fn strip_html_for_checksum(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_tag = false;
    for ch in text.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

/// 统一的字段值解析（F11 round2）：单模板与多模板导出共用，确保：
/// - `text` 字段在 `card.text` 为空时回退 `extra_fields`；
/// - 通用字段支持大小写无关 + `ALIAS_MAP` 别名；
/// - 选择题模板的 `Front` 优先从 `extra_fields` 取。
///
/// 消除多模板 `insert_note` 与单模板路径的字段映射差异。
fn resolve_card_field_value(card: &AnkiCard, field_name: &str) -> String {
    match field_name.to_lowercase().as_str() {
        "front" => {
            // 特殊处理选择题模板：Front 字段应从 extra_fields 中获取
            if card
                .template_id
                .as_ref()
                .is_some_and(|id| id == "choice-card")
            {
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
            // Cloze note type 默认使用 "Extra" 字段；优先 extra_fields，否则回退 card.back
            let field_key = field_name.to_lowercase();
            card.extra_fields
                .get(&field_key)
                .or_else(|| card.extra_fields.get(field_name))
                .cloned()
                .unwrap_or_else(|| clean_template_placeholders(&card.back))
        }
        "tags" => {
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
                    warn!("字段 '{}' 未找到，使用空值", field_name);
                    String::new()
                });
            // 保留原始值，对 JSON 数组/对象跳过 sanitize，否则做占位符清理
            if raw_value.trim_start().starts_with('{') || raw_value.trim_start().starts_with('[') {
                raw_value
            } else {
                clean_template_placeholders(&raw_value)
            }
        }
    }
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
    initialize_anki_database_with_template(conn, deck_name, model_name, None, None)
}

fn initialize_anki_database_with_template(
    conn: &Connection,
    deck_name: &str,
    model_name: &str,
    template_config: Option<(String, Vec<String>, String, String, String)>,
    template_id: Option<&str>,
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
    let mut model_value = serde_json::to_value(model)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    model_value[DEEP_STUDENT_COLLAPSE_CLOZE_ORDS_KEY] = serde_json::Value::Bool(true);
    if let Some(template_id) = template_id.map(str::trim).filter(|id| !id.is_empty()) {
        model_value[DEEP_STUDENT_TEMPLATE_ID_KEY] =
            serde_json::Value::String(template_id.to_string());
    }
    let models = serde_json::json!({
        model_id_clone: model_value
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
    // F13（round2）：对齐 Anki，先 strip HTML 再算校验和（仅影响重复检测，不影响导入）
    let stripped = strip_html_for_checksum(text);
    if stripped.is_empty() {
        return 0;
    }
    let mut hasher = Sha1::new();
    hasher.update(stripped.as_bytes());
    let digest = hasher.finalize();
    let checksum = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    checksum as i64
}

/// 将AnkiCard转换为Anki数据库记录
type AnkiNoteRecord = (String, String, String, String, i64, String, Vec<i64>);

fn convert_cards_to_anki_records(
    cards: Vec<AnkiCard>,
    _deck_id: i64,
    _model_id: i64,
    model_name: &str,
) -> Result<Vec<AnkiNoteRecord>, String> {
    // 🎯 SOTA 修复：废弃旧的Cloze特殊处理，统一使用字段驱动
    convert_cards_to_anki_records_with_fields(cards, _deck_id, _model_id, model_name, None, None)
}

fn convert_cards_to_anki_records_with_fields(
    cards: Vec<AnkiCard>,
    _deck_id: i64,
    _model_id: i64,
    model_name: &str,
    template_fields: Option<&[String]>,
    _template: Option<&CustomAnkiTemplate>, // 新增参数：完整的模板对象
) -> Result<Vec<AnkiNoteRecord>, String> {
    let mut records = Vec::new();
    let is_cloze_model = model_name.eq_ignore_ascii_case("Cloze");

    for card in &cards {
        // F9（round2）：全局单调 note_id，避免同秒多次导出碰撞
        let note_id = next_apkg_note_id();
        let guid = uuid::Uuid::new_v4()
            .to_string()
            .replace("-", "")
            .to_string();

        // 根据模板字段或模型类型处理字段
        let (fields, sort_field) = if let Some(field_names) = template_fields {
            // 调试日志：打印字段处理信息（debug 级别，避免卡片内容刷爆 warn 日志）
            if field_names.len() > 4 {
                // 学术模板有6个字段
                debug!("处理多字段模板，字段数量: {}", field_names.len());
                debug!("模板字段: {:?}", field_names);
                debug!(
                    "卡片extra_fields: {:?}",
                    card.extra_fields.keys().collect::<Vec<_>>()
                );
                debug!("卡片tags字段: {:?}", card.tags);
            }

            let mut field_values = Vec::new();

            for field_name in field_names {
                // F11（round2）：统一字段解析（与多模板路径共用 resolve_card_field_value）
                let value = resolve_card_field_value(card, field_name);

                // 调试：打印每个字段的值 (UTF-8安全截断)
                if field_names.len() > 4 {
                    debug!(
                        "字段 '{}' -> '{}'",
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
        let card_ords = if is_cloze_model {
            cloze_card_ords(&resolve_card_field_value(card, "Text"))
        } else {
            vec![0]
        };

        records.push((
            note_id.to_string(),
            guid,
            fields,
            sort_field,
            csum,
            tags,
            card_ords,
        ));
    }

    Ok(records)
}

/// APKG 导出报告（新增，向后兼容）：
/// 旧调用方继续使用 `Result<(), String>` 签名的入口；
/// 需要媒体完整性信息的调用方改用 `*_report` 变体。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApkgExportReport {
    /// 实际打包进 APKG 的媒体文件数
    pub exported_media: usize,
    /// 引用了但磁盘上缺失/不可读的媒体文件（路径），导出继续但需告警
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub missing_media: Vec<String>,
}

/// 从卡片列表收集可读媒体文件：
/// - 以文件名去重（Anki 包内媒体按文件名寻址）；
/// - 打开失败的文件进入 missing 清单，不再让整次导出失败；
/// - 返回的句柄在打包时流式拷贝，避免整文件读入内存。
fn collect_media_entries(cards: &[AnkiCard]) -> (Vec<(String, fs::File)>, Vec<String>) {
    let mut entries: Vec<(String, fs::File)> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    let mut seen_media_names: HashSet<String> = HashSet::new();
    for card in cards {
        for image_path in &card.images {
            let Some(fname) = std::path::Path::new(image_path)
                .file_name()
                .and_then(|n| n.to_str())
            else {
                warn!("媒体路径无有效文件名，跳过: {}", image_path);
                missing.push(image_path.clone());
                continue;
            };
            if !seen_media_names.insert(fname.to_string()) {
                continue;
            }
            match fs::File::open(image_path) {
                Ok(file) => entries.push((fname.to_string(), file)),
                Err(e) => {
                    warn!("读取媒体文件失败，跳过并继续导出 {}: {}", image_path, e);
                    missing.push(image_path.clone());
                }
            }
        }
    }
    (entries, missing)
}

/// 把媒体清单 + 媒体条目写入 zip（Anki 规范：清单键为 "0","1",... 指向同名条目）。
fn write_media_to_zip<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    media_entries: &mut [(String, fs::File)],
) -> Result<(), String> {
    let mut media_map = serde_json::Map::new();
    for (idx, (fname, _)) in media_entries.iter().enumerate() {
        media_map.insert(idx.to_string(), serde_json::Value::String(fname.clone()));
    }
    let media_json = serde_json::to_string(&media_map)
        .map_err(|e| format!("序列化媒体列表失败: {}", e))?;

    zip.start_file("media", FileOptions::default())
        .map_err(|e| format!("创建媒体列表条目失败: {}", e))?;
    zip.write_all(media_json.as_bytes())
        .map_err(|e| format!("写入媒体列表失败: {}", e))?;

    for (idx, (fname, file)) in media_entries.iter_mut().enumerate() {
        zip.start_file(idx.to_string(), FileOptions::default())
            .map_err(|e| format!("创建媒体文件条目失败: {}", e))?;
        std::io::copy(file, zip)
            .map_err(|e| format!("写入媒体文件失败 {}: {}", fname, e))?;
    }
    Ok(())
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

/// 导出卡片为.apkg文件（支持完整模板对象）——兼容签名，丢弃导出报告。
pub async fn export_cards_to_apkg_with_full_template(
    cards: Vec<AnkiCard>,
    deck_name: String,
    note_type: String,
    output_path: PathBuf,
    template_config: Option<(String, Vec<String>, String, String, String)>,
    full_template: Option<CustomAnkiTemplate>,
) -> Result<(), String> {
    export_cards_to_apkg_with_full_template_report(
        cards,
        deck_name,
        note_type,
        output_path,
        template_config,
        full_template,
    )
    .await
    .map(|report| {
        if !report.missing_media.is_empty() {
            warn!(
                "APKG 导出完成，但 {} 个媒体文件缺失: {:?}",
                report.missing_media.len(),
                report.missing_media
            );
        }
    })
}

/// 导出卡片为.apkg文件（支持完整模板对象），返回媒体完整性报告。
pub async fn export_cards_to_apkg_with_full_template_report(
    cards: Vec<AnkiCard>,
    deck_name: String,
    note_type: String,
    output_path: PathBuf,
    template_config: Option<(String, Vec<String>, String, String, String)>, // (name, fields, front, back, css)
    full_template: Option<CustomAnkiTemplate>,                              // 完整的模板对象
) -> Result<ApkgExportReport, String> {
    if cards.is_empty() {
        return Err("没有卡片可以导出".to_string());
    }

    // 创建临时目录
    // 注意必须带随机后缀：仅用秒级时间戳时，同一秒内的并发导出会
    // 共享同一 collection.anki2，第二次初始化报 "table col already exists"
    let temp_dir = std::env::temp_dir().join(format!(
        "anki_export_{}_{}",
        Utc::now().timestamp(),
        uuid::Uuid::new_v4().simple()
    ));
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
        extra_keys.sort_by_key(|a| a.to_lowercase());
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
            full_template.as_ref().map(|template| template.id.as_str()),
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
        let mut next_due = 1i64;
        for (note_id, guid, fields, sort_field, csum, tags, card_ords) in &records {
            let note_id = note_id
                .parse::<i64>()
                .map_err(|error| format!("无效的 note id: {}", error))?;
            // 插入笔记
            conn.execute(
                "INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data) VALUES (?, ?, ?, ?, -1, ?, ?, ?, ?, 0, '')",
                params![
                    note_id,
                    guid,
                    model_id,
                    now,
                    tags,
                    fields,
                    clean_template_placeholders(sort_field),
                    csum
                ]
            ).map_err(|e| format!("插入笔记失败: {}", e))?;

            insert_anki_card_rows(&conn, note_id, deck_id, now, card_ords, &mut next_due)?;
        }

        conn.close().map_err(|e| format!("关闭数据库失败: {:?}", e))?;

        // 创建.apkg文件（实际上是一个zip文件）
        let parent_dir = output_path.parent().unwrap_or_else(|| std::path::Path::new("."));
        let mut temp_file = NamedTempFile::new_in(parent_dir)
            .map_err(|e| format!("创建临时输出文件失败: {}", e))?;

        // 媒体收集：去重 + 缺失容忍（缺失文件进入报告而不是让整次导出失败），
        // 清单只登记真正可读的条目，保证 media 清单与 zip 条目一一对应。
        let (mut media_entries, missing_media) = collect_media_entries(&cards_clone_for_media);

        {
            let file_handle = temp_file.as_file_mut();
            let mut zip = ZipWriter::new(file_handle);

            zip.start_file("collection.anki2", FileOptions::default())
                .map_err(|e| format!("创建zip文件条目失败: {}", e))?;
            // F14（round2）：流式写入数据库，避免整库读入内存
            let mut db_file = fs::File::open(&db_path)
                .map_err(|e| format!("打开数据库文件失败: {}", e))?;
            std::io::copy(&mut db_file, &mut zip)
                .map_err(|e| format!("写入数据库到zip失败: {}", e))?;

            // In Anki packages, media files are stored as numbered entries ("0", "1", ...).
            write_media_to_zip(&mut zip, &mut media_entries)?;

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

        // 检查导出文件状态（iPad 等移动端诊断）
        let temp_size = fs::metadata(&output_path)
            .map(|m| m.len())
            .unwrap_or(0);
        debug!("APKG文件创建完成: {} 字节", temp_size);

        if temp_size == 0 {
            return Err(format!("APKG文件为空 (0字节)，路径: {:?}", output_path));
        }

        debug!("APKG文件验证通过: {:?} ({} 字节)", output_path, temp_size);
        Ok(ApkgExportReport {
            exported_media: media_entries.len(),
            missing_media,
        })
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

/// 多模板导出（兼容签名，丢弃导出报告）。
pub async fn export_multi_template_apkg(
    cards: Vec<AnkiCard>,
    deck_name: String,
    output_path: PathBuf,
    template_map: HashMap<String, CustomAnkiTemplate>,
) -> Result<(), String> {
    export_multi_template_apkg_report(cards, deck_name, output_path, template_map)
        .await
        .map(|report| {
            if !report.missing_media.is_empty() {
                warn!(
                    "多模板 APKG 导出完成，但 {} 个媒体文件缺失: {:?}",
                    report.missing_media.len(),
                    report.missing_media
                );
            }
        })
}

/// 多模板导出：每种 template_id 创建独立的 Anki model，
/// 每张卡片的 notes.mid 指向自己模板对应的 model。返回媒体完整性报告。
///
/// 参数：
/// - cards: 所有待导出卡片
/// - deck_name: 牌组名称
/// - output_path: 输出文件路径
/// - template_map: template_id → CustomAnkiTemplate 的映射
pub async fn export_multi_template_apkg_report(
    cards: Vec<AnkiCard>,
    deck_name: String,
    output_path: PathBuf,
    template_map: HashMap<String, CustomAnkiTemplate>,
) -> Result<ApkgExportReport, String> {
    if cards.is_empty() {
        return Err("没有卡片可以导出".to_string());
    }

    // 同上：带随机后缀防止同一秒并发导出共用临时库
    let temp_dir = std::env::temp_dir().join(format!(
        "anki_export_{}_{}",
        Utc::now().timestamp(),
        uuid::Uuid::new_v4().simple()
    ));
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
            CREATE INDEX ix_cards_usn on cards (usn);
            CREATE INDEX ix_notes_usn on notes (usn);
            CREATE INDEX ix_notes_csum on notes (csum);
            CREATE INDEX ix_revlog_usn on revlog (usn);
            CREATE INDEX ix_revlog_cid on revlog (cid);
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
                extra_keys.sort_by_key(|a| a.to_lowercase());
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
                let mut model_value =
                    serde_json::to_value(&model).map_err(|e| e.to_string())?;
                model_value[DEEP_STUDENT_TEMPLATE_ID_KEY] =
                    serde_json::Value::String(tid.clone());
                model_value[DEEP_STUDENT_COLLAPSE_CLOZE_ORDS_KEY] =
                    serde_json::Value::Bool(true);
                models_json.insert(model_id.to_string(), model_value);
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
        let mut next_due = 1i64;
        let insert_note = |conn: &Connection,
                           card: &AnkiCard,
                           mid: i64,
                           field_names: &[String],
                           is_cloze: bool,
                           next_due: &mut i64|
         -> Result<(), String> {
            let note_id = next_apkg_note_id(); // F9（round2）：全局单调 id
            let guid = uuid::Uuid::new_v4().to_string().replace("-", "");

            let mut field_values: Vec<String> = Vec::new();
            for field_name in field_names {
                // F11（round2）：与单模板路径统一字段解析（含 text 回退 extra_fields + ALIAS_MAP）
                let value = resolve_card_field_value(card, field_name);
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

            let card_ords = if is_cloze {
                cloze_card_ords(&resolve_card_field_value(card, "Text"))
            } else {
                vec![0]
            };
            insert_anki_card_rows(conn, note_id, deck_id, now, &card_ords, next_due)?;

            Ok(())
        };

        // 插入有 template_id 的卡片
        for (tid, group_cards) in &groups {
            let mid = model_id_map.get(tid).copied().unwrap_or(fallback_model_id);
            let field_names = model_fields_map.get(tid).cloned().unwrap_or_else(|| vec!["Front".to_string(), "Back".to_string()]);
            let is_cloze = template_map
                .get(tid)
                .is_some_and(|template| template.note_type.eq_ignore_ascii_case("Cloze"));
            for card in group_cards {
                insert_note(
                    &conn,
                    card,
                    mid,
                    &field_names,
                    is_cloze,
                    &mut next_due,
                )?;
            }
        }

        // 插入无 template_id 的卡片
        for card in &no_template_cards {
            let field_names = vec!["Front".to_string(), "Back".to_string()];
            insert_note(
                &conn,
                card,
                fallback_model_id,
                &field_names,
                false,
                &mut next_due,
            )?;
        }

        conn.close().map_err(|e| format!("关闭数据库失败: {:?}", e))?;

        // 打包 APKG
        let parent_dir = output_path.parent().unwrap_or_else(|| std::path::Path::new("."));
        let mut temp_file = NamedTempFile::new_in(parent_dir)
            .map_err(|e| format!("创建临时输出文件失败: {}", e))?;

        // 媒体收集：与单模板路径统一——去重 + 缺失容忍 + 流式拷贝，
        // media 清单只登记真正可读的条目，缺失文件进入报告。
        let (mut media_entries, missing_media) = collect_media_entries(&cards_for_media);

        {
            let file_handle = temp_file.as_file_mut();
            let mut zip = ZipWriter::new(file_handle);
            zip.start_file("collection.anki2", FileOptions::default()).map_err(|e| format!("zip失败: {}", e))?;
            // F14（round2）：流式写入数据库，避免整库读入内存
            let mut db_file = fs::File::open(&db_path).map_err(|e| format!("打开数据库失败: {}", e))?;
            std::io::copy(&mut db_file, &mut zip).map_err(|e| format!("写入db失败: {}", e))?;
            write_media_to_zip(&mut zip, &mut media_entries)?;
            zip.finish().map_err(|e| format!("zip finish失败: {}", e))?;
        }

        if output_path.exists() {
            fs::remove_file(&output_path).map_err(|e| format!("删除旧文件失败: {}", e))?;
        }
        temp_file.persist(&output_path).map_err(|e| format!("持久化失败: {}", e.error))?;
        Ok(ApkgExportReport {
            exported_media: media_entries.len(),
            missing_media,
        })
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

    fn test_card(id: &str, front: &str, back: &str) -> AnkiCard {
        let now = chrono::Utc::now().to_rfc3339();
        AnkiCard {
            id: id.to_string(),
            task_id: String::new(),
            front: front.to_string(),
            back: back.to_string(),
            text: None,
            tags: Vec::new(),
            images: Vec::new(),
            is_error_card: false,
            error_content: None,
            created_at: now.clone(),
            updated_at: now,
            extra_fields: HashMap::new(),
            template_id: None,
        }
    }

    fn test_template(id: &str, note_type: &str, fields: &[&str]) -> CustomAnkiTemplate {
        let now = chrono::Utc::now();
        let is_cloze = note_type.eq_ignore_ascii_case("Cloze");
        CustomAnkiTemplate {
            id: id.to_string(),
            name: format!("Test {id}"),
            description: String::new(),
            author: None,
            version: "1.0.0".to_string(),
            preview_front: String::new(),
            preview_back: String::new(),
            note_type: note_type.to_string(),
            fields: fields.iter().map(|field| (*field).to_string()).collect(),
            generation_prompt: String::new(),
            front_template: if is_cloze {
                "{{cloze:Text}}".to_string()
            } else {
                "{{Front}}".to_string()
            },
            back_template: if is_cloze {
                "{{cloze:Text}}<br>{{Extra}}".to_string()
            } else {
                "{{FrontSide}}<hr>{{Back}}".to_string()
            },
            css_style: ".card { font-family: sans-serif; }".to_string(),
            field_extraction_rules: HashMap::new(),
            created_at: now,
            updated_at: now,
            is_active: true,
            is_built_in: false,
            preview_data_json: None,
        }
    }

    fn extract_collection(apkg_path: &std::path::Path, db_path: &std::path::Path) {
        let file = std::fs::File::open(apkg_path).expect("open apkg");
        let mut zip = zip::ZipArchive::new(file).expect("open apkg zip");
        let mut collection = zip.by_name("collection.anki2").expect("collection.anki2");
        let mut bytes = Vec::new();
        collection.read_to_end(&mut bytes).expect("read collection");
        std::fs::write(db_path, bytes).expect("write collection");
    }

    #[test]
    fn cloze_card_ords_extracts_sorted_unique_positive_numbers() {
        assert_eq!(
            cloze_card_ords("{{c3::three}} {{c1::one::hint}} {{c2::two}} {{c2::duplicate}}"),
            vec![0, 1, 2]
        );
    }

    #[test]
    fn cloze_card_ords_ignores_invalid_markers_and_falls_back_to_zero() {
        assert_eq!(
            cloze_card_ords("{{c0::zero}} {{c1::   }} {{c2::::hint}} plain text"),
            vec![0]
        );
    }

    #[test]
    fn single_template_record_conversion_carries_all_cloze_ords() {
        let mut card = test_card("cloze", "front", "back");
        card.text = Some("{{c1::one}} {{c2::two}} {{c3::three}}".to_string());
        let fields = vec!["Text".to_string(), "Extra".to_string()];
        let records = convert_cards_to_anki_records_with_fields(
            vec![card],
            1,
            1,
            "Cloze",
            Some(&fields),
            None,
        )
        .expect("convert Cloze record");
        assert_eq!(records[0].6, vec![0, 1, 2]);
    }

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
        let card_ords = conn
            .prepare("SELECT ord FROM cards ORDER BY ord")
            .expect("prepare card ords")
            .query_map([], |row| row.get::<_, i64>(0))
            .expect("query card ords")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect card ords");
        assert_eq!(card_ords, vec![0], "Basic notes must create one card");
    }

    #[tokio::test]
    async fn multi_template_export_writes_each_cloze_ord_once_and_basic_once() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let out = tmp.path().join("multi-cloze.apkg");

        let mut cloze = test_card("cloze", "cloze front", "cloze back");
        cloze.template_id = Some("cloze-template".to_string());
        cloze.text = Some(
            "{{c3::three}} {{c1::one}} {{c2::two}} {{c2::duplicate}} \
             {{c0::zero}} {{c4::   }} {{c5::::hint}}"
                .to_string(),
        );
        let mut basic = test_card("basic", "Basic {{c9::literal}}", "answer");
        basic.template_id = Some("basic-template".to_string());

        export_multi_template_apkg(
            vec![cloze, basic],
            "Cloze ords".to_string(),
            out.clone(),
            HashMap::from([
                (
                    "cloze-template".to_string(),
                    test_template("cloze-template", "Cloze", &["Text", "Extra"]),
                ),
                (
                    "basic-template".to_string(),
                    test_template("basic-template", "Basic", &["Front", "Back"]),
                ),
            ]),
        )
        .await
        .expect("export multi-template APKG");

        let db_path = tmp.path().join("multi-cloze.anki2");
        extract_collection(&out, &db_path);
        let conn = Connection::open(db_path).expect("open collection");
        let note_rows = conn
            .prepare(
                "SELECT n.flds, c.ord
                 FROM notes n
                 INNER JOIN cards c ON c.nid = n.id
                 ORDER BY n.flds, c.ord",
            )
            .expect("prepare note card rows")
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .expect("query note card rows")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect note card rows");

        let cloze_ords = note_rows
            .iter()
            .filter(|(fields, _)| fields.contains("{{c3::three}}"))
            .map(|(_, ord)| *ord)
            .collect::<Vec<_>>();
        let basic_ords = note_rows
            .iter()
            .filter(|(fields, _)| fields.contains("Basic {{c9::literal}}"))
            .map(|(_, ord)| *ord)
            .collect::<Vec<_>>();
        assert_eq!(cloze_ords, vec![0, 1, 2]);
        assert_eq!(basic_ords, vec![0]);
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

    #[tokio::test]
    async fn test_export_apkg_missing_media_is_tolerated_and_reported() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let out = tmp.path().join("missing-media.apkg");

        let img_path = tmp.path().join("exists.png");
        std::fs::write(&img_path, b"\x89PNG\r\n\x1a\n").expect("write img");
        let missing_path = tmp.path().join("does-not-exist.png");

        let mut card = test_card("m", "Q", "A");
        card.images = vec![
            img_path.to_string_lossy().to_string(),
            missing_path.to_string_lossy().to_string(),
        ];

        let report = export_cards_to_apkg_with_full_template_report(
            vec![card],
            "TestDeck".to_string(),
            "Basic".to_string(),
            out.clone(),
            None,
            None,
        )
        .await
        .expect("missing media must not fail the export");

        assert_eq!(report.exported_media, 1);
        assert_eq!(
            report.missing_media,
            vec![missing_path.to_string_lossy().to_string()]
        );

        let f = std::fs::File::open(&out).expect("open apkg");
        let mut zip = zip::ZipArchive::new(f).expect("zip open");
        {
            let mut media_file = zip.by_name("media").expect("media manifest");
            let mut media_json = String::new();
            media_file
                .read_to_string(&mut media_json)
                .expect("read media manifest");
            let media_map: serde_json::Value =
                serde_json::from_str(&media_json).expect("parse media manifest");
            // 清单只登记可读文件，无悬空引用
            assert_eq!(
                media_map.get("0").and_then(|v| v.as_str()),
                Some("exists.png")
            );
            assert!(media_map.get("1").is_none());
        }
        assert!(zip.by_name("0").is_ok());
        assert!(zip.by_name("1").is_err());
    }

    #[tokio::test]
    async fn multi_template_export_report_collects_missing_media() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let out = tmp.path().join("multi-missing-media.apkg");

        let mut card = test_card("m", "Q", "A");
        card.images = vec![tmp
            .path()
            .join("ghost.png")
            .to_string_lossy()
            .to_string()];

        let report = export_multi_template_apkg_report(
            vec![card],
            "Deck".to_string(),
            out.clone(),
            HashMap::new(),
        )
        .await
        .expect("missing media must not fail the multi-template export");
        assert_eq!(report.exported_media, 0);
        assert_eq!(report.missing_media.len(), 1);
        assert!(out.exists());
    }

    #[test]
    fn export_report_serialization_omits_empty_missing_media() {
        let clean = ApkgExportReport {
            exported_media: 2,
            missing_media: vec![],
        };
        let value = serde_json::to_value(&clean).expect("serialize clean report");
        assert_eq!(value["exportedMedia"], 2);
        assert!(value.get("missingMedia").is_none());

        let dirty = ApkgExportReport {
            exported_media: 0,
            missing_media: vec!["/tmp/a.png".to_string()],
        };
        let value = serde_json::to_value(&dirty).expect("serialize dirty report");
        assert_eq!(value["missingMedia"][0], "/tmp/a.png");
    }
}
