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

/// 导出用固定 deck id：避开 Anki 保留的默认牌组 id 1（导入端对 id=1 有特殊合并语义）。
/// 单文件内 decks / cards.did / model.did 均引用该 id；dconf 仍为 id 1，deck.conf 指向它。
const APKG_EXPORT_DECK_ID: i64 = 1746000000000;

/// 导出侧单媒体文件上限：与导入侧 `MAX_ENTRY_BYTES` 对齐（256 MiB）。
/// 超限文件不阻断导出，进入 missing_media 清单并写入告警。
pub const MAX_EXPORT_MEDIA_FILE_BYTES: u64 = 256 * 1024 * 1024;

/// 导入时由 apkg_importer_service 注入的元数据保留字段。
/// 再导出时必须过滤，避免这些键污染 Anki model 字段表。
/// 后 7 个为调度信息键，与 apkg_importer_service::ANKI_SCHED_METADATA_KEYS 一致。
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

/// 统一的内部协议字段谓词（wave2-E r2）：
/// - 所有 `_` 前缀键默认是机器协议字段（`_occlusion`/`_qa_flags`/
///   `_original_generation`/`_content_provenance` 等），一律不得进入
///   导出 note/model 字段表；确需导出的信息由专用转换器消费后移除原键；
/// - 叠加既有 13 个 `Anki*` 导入元数据保留键。
///
/// 消费点：导出入口规范化（normalize_cards_for_export）、两条路径的
/// extra_keys 字段表追加、resolve_card_field_value 兜底取值。
fn is_internal_protocol_field(name: &str) -> bool {
    name.starts_with('_') || is_reserved_import_metadata_field(name)
}

// ============================================================================
// 遮挡卡导出转换器（wave2-E r2：`_occlusion` → 可复习标准 Cloze）
// ============================================================================

/// 从 `_occlusion.imageRef` 解析 APKG 包内媒体文件名（basename）。
///
/// 返回 `None` 的情况：引用为空/纯空白、`vlm://pending-image` 之类的
/// 内部占位引用（VLM 块不选图，转换时视为无图降级）、或路径无有效文件名。
/// `vfs://images/diagram.png` 这类引用取末段 `diagram.png`，与
/// `collect_media_entries` 的文件名口径一致。
fn occlusion_media_file_name(image_ref: &str) -> Option<String> {
    let trimmed = image_ref.trim();
    if trimmed.is_empty() || trimmed.starts_with("vlm://") {
        return None;
    }
    std::path::Path::new(trimmed)
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

/// cloze 标签内 `}}` 会破坏 cloze 语法，`::` 会被 Anki 解析为 hint 分隔符。
/// 与 anki_image_occlusion::escape_cloze_label 同口径（该函数未 pub，本地复刻）。
fn escape_occlusion_cloze_label(label: &str) -> String {
    label.replace("}}", "} }").replace("::", "：：")
}

fn escape_occlusion_html_attr(s: &str) -> String {
    s.replace('&', "&amp;").replace('"', "&quot;")
}

/// 用遮挡盒 labels 现拼标准 Cloze 正文（与
/// anki_image_occlusion::build_card_fields 的 `{{cN::label}}` 协议一致，
/// 不发明新协议）。缺失 cloze 序号的盒按出现顺序补 1-based 序号。
fn build_occlusion_cloze_text(spec: &crate::anki_image_occlusion::OcclusionSpec) -> String {
    spec.boxes
        .iter()
        .enumerate()
        .map(|(idx, b)| {
            let ord = b.cloze_index.filter(|n| *n > 0).unwrap_or(idx as u32 + 1);
            let label = b.label.trim();
            let label = if label.is_empty() {
                format!("区域 {}", ord)
            } else {
                label.to_string()
            };
            format!("{{{{c{}::{}}}}}", ord, escape_occlusion_cloze_label(&label))
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// 把遮挡盒渲染为 IO 矩形 cloze 语法（0–1 归一化小数，对齐官方 to-cloze.ts）。
///
/// 直接复用 `anki_image_occlusion::format_anki_io_cloze`（已落地的官方
/// IO 语法构造器，形如
/// `{{c1::image-occlusion:rect:left=.1:top=.2:width=.3:height=.15}}`；
/// 禁止 ×100 百分数——百分数会让 Anki 遮罩放大 100 倍）。
/// 该函数只接受 `ValidatedOcclusionSpec`，因此先过 `validate_spec`；
/// spec 非法（外部伪造/退化数据）时返回空串——不产 IO 语法，
/// 可复习主路径（标准 Cloze Text）不受影响。
///
/// wave2-E r3 起默认 Cloze 导出路径**不再**把该结果写入 Extra（机器语法
/// 不得在揭底时暴露给用户）；本函数保留给后续官方 Image Occlusion
/// notetype 导出路径（IO 语法届时写入 IO notetype 的专用 Occlusion 字段，
/// 而非用户可见的 Extra）。
#[allow(dead_code)]
fn format_io_rects(spec: &crate::anki_image_occlusion::OcclusionSpec) -> String {
    crate::anki_image_occlusion::validate_spec(
        spec,
        &crate::anki_image_occlusion::OcclusionConfig::default(),
    )
    .map(|validated| crate::anki_image_occlusion::format_anki_io_cloze(&validated))
    .unwrap_or_default()
}

/// 遮挡卡导出转换器：把 `_occlusion` spec 转成可复习的标准 Cloze note。
///
/// - Text：`card.text` 已有内容则沿用，否则用盒 labels 现拼 `{{cN::label}}`；
///   两种来源都确保带 `<img src="包内文件名">`（imageRef 可解析出文件名时）；
/// - 媒体：`card.images` 为空时把 imageRef 原样补进去，由
///   `collect_media_entries` 统一解析为包内文件名；文件缺失/不可读时该函数
///   已有跳过 + missing 报告语义，note 本身（Text 仍在）照常导出，不 panic；
/// - Extra：**不写入任何 IO 矩形语法**（wave2-E r3 字段泄漏修正）。
///   `{{cN::image-occlusion:rect:...}}` 是机器语法，默认 Cloze notetype 揭底时
///   Extra 会原样展示，用户会看到一串坐标乱码；因此 Extra 只保留人类补充
///   内容，无 Extra 键时由 `resolve_card_field_value` 的 "extra" 分支
///   回退 `card.back`，本函数不再插入 Extra 键。
///
/// 本函数只读 `_occlusion`，删除动作统一在 `normalize_cards_for_export` 的
/// `_` 前缀 retain 中完成。
fn convert_occlusion_card_for_export(card: &mut AnkiCard) {
    let Some(spec) = crate::anki_image_occlusion::parse_occlusion_field(&card.extra_fields) else {
        return;
    };

    let image_file_name = occlusion_media_file_name(&spec.image_ref);

    // 媒体补收集（必须发生在 `_occlusion` 被删除前）：
    // 只在 images 为空时补，避免与调用方已解析好的媒体路径重复。
    if card.images.is_empty() && image_file_name.is_some() {
        card.images.push(spec.image_ref.trim().to_string());
    }

    // 可复习 Cloze Text：card.text 优先，否则用 labels 现拼。
    let existing_text = card
        .text
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string);
    let cloze_body = existing_text.unwrap_or_else(|| build_occlusion_cloze_text(&spec));
    if !cloze_body.is_empty() {
        let text = match &image_file_name {
            Some(name) if !cloze_body.contains("<img") => format!(
                "<img src=\"{}\"><br>{}",
                escape_occlusion_html_attr(name),
                cloze_body
            ),
            _ => cloze_body,
        };
        card.text = Some(text);
    }
    // 注意：IO 矩形语法（format_io_rects）刻意不写入 Extra——
    // 默认 Cloze notetype 揭底会把 Extra 原样渲染给用户，机器语法必须不可见。
}

/// 导出入口统一规范化（唯一权威层）：只作用于导出流水线内的数据副本，
/// 不写回卡片库——`_original_generation` 是 critic 修正对挖掘的数据源，
/// 库内必须保留。
///
/// 1. 遮挡转换器：消费 `_occlusion` 生成可复习 Cloze Text + 媒体
///    （IO 矩形语法不再写入 Extra，见 convert_occlusion_card_for_export）；
/// 2. 删除所有 `_` 前缀机器协议字段。注意此处不删 `Anki*` 保留键：
///    card_sched_restore 仍需读取它们回写复习进度，字段表层
///    （is_internal_protocol_field 过滤）已单独保证它们不进 model。
fn normalize_cards_for_export(cards: &mut [AnkiCard]) {
    for card in cards.iter_mut() {
        convert_occlusion_card_for_export(card);
        card.extra_fields.retain(|key, _| !key.starts_with('_'));
    }
}

/// 清理卡片内容中的无效模板占位符
fn clean_template_placeholders(content: &str) -> String {
    content.trim().to_string()
}

/// 导出写入 notes.flds 前清洗字段值中的 U+001F（Anki 字段分隔符），防止字段错位。
fn sanitize_apkg_field_value(value: String) -> String {
    if value.contains('\u{1f}') {
        value.replace('\u{1f}', " ")
    } else {
        value
    }
}

/// 判断文本是否含有效的 `{{cN::...}}` Cloze 标记（与 cloze_card_ords 的识别口径一致）。
fn contains_cloze_marker(text: &str) -> bool {
    let mut search_from = 0usize;
    while let Some(relative_start) = text[search_from..].find("{{c") {
        let number_start = search_from + relative_start + 3;
        let digit_count = text[number_start..]
            .bytes()
            .take_while(u8::is_ascii_digit)
            .count();
        if digit_count > 0 && text[number_start + digit_count..].starts_with("::") {
            return true;
        }
        search_from = number_start;
    }
    false
}

/// 基于卡片稳定标识生成确定性 note guid
/// （思路对齐 cmd::anki_connect::compute_anki_card_content_hash）：
/// - 优先使用卡片库内 id：同一张卡任何时候导出 guid 相同，
///   重复导出再导入 Anki 时按 guid 去重/更新而不是重复建卡；
/// - id 缺失时退化为内容哈希（front/back/text/排序后的 extra_fields/tags/template_id）。
///
/// Anki 只要求 guid 是唯一且稳定的字符串，这里取 sha1 前 10 字节的 hex（20 字符）。
fn stable_note_guid(card: &AnkiCard) -> String {
    const FIELD_SEP: [u8; 1] = [0x1f];
    const PAIR_SEP: [u8; 1] = [0x1e];

    let mut hasher = Sha1::new();
    hasher.update(b"deep-student-apkg-guid-v1");
    hasher.update(FIELD_SEP);
    let card_id = card.id.trim();
    if !card_id.is_empty() {
        hasher.update(b"id");
        hasher.update(FIELD_SEP);
        hasher.update(card_id.as_bytes());
    } else {
        hasher.update(b"content");
        hasher.update(FIELD_SEP);
        hasher.update(card.front.as_bytes());
        hasher.update(FIELD_SEP);
        hasher.update(card.back.as_bytes());
        hasher.update(FIELD_SEP);
        if let Some(text) = card.text.as_deref() {
            hasher.update(text.as_bytes());
        }
        hasher.update(FIELD_SEP);
        let mut keys: Vec<&String> = card.extra_fields.keys().collect();
        keys.sort();
        for key in keys {
            hasher.update(key.as_bytes());
            hasher.update(PAIR_SEP);
            if let Some(value) = card.extra_fields.get(key) {
                hasher.update(value.as_bytes());
            }
            hasher.update(PAIR_SEP);
        }
        hasher.update(FIELD_SEP);
        for tag in &card.tags {
            hasher.update(tag.as_bytes());
            hasher.update(PAIR_SEP);
        }
        hasher.update(FIELD_SEP);
        if let Some(template_id) = card.template_id.as_deref() {
            hasher.update(template_id.as_bytes());
        }
    }
    let digest = hasher.finalize();
    digest[..10]
        .iter()
        .map(|byte| format!("{:02x}", byte))
        .collect()
}

/// 批内去重：notes.guid 有 UNIQUE 约束，同批出现相同 guid
/// （如同一张卡被重复选择）时给后续副本追加序号后缀，避免整次导出失败。
fn unique_note_guid(card: &AnkiCard, used: &mut HashSet<String>) -> String {
    let base = stable_note_guid(card);
    if used.insert(base.clone()) {
        return base;
    }
    let mut suffix = 2usize;
    loop {
        let candidate = format!("{}-{}", base, suffix);
        if used.insert(candidate.clone()) {
            return candidate;
        }
        suffix += 1;
    }
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

/// 导出时回写的调度状态（由导入注入的 AnkiSched* 元数据换算而来）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CardSchedRestore {
    due: i64,
    ivl: i64,
    factor: i64,
    reps: i64,
    lapses: i64,
}

/// 从卡片元数据（AnkiIvl/AnkiReps/AnkiFactor/AnkiDue/AnkiLapses）保守重建调度状态：
/// - 仅当卡片明确处于复习状态（ivl > 0 且 reps > 0）时回写，其余一律按新卡导出；
/// - 原集合的 crt 不可知，AnkiDue 的绝对天数失真，超出 [1, ivl] 时回退为 ivl
///   （即“导入后 ivl 天内到期”），避免卡片被排到遥远未来；
/// - factor 越界时回退 Anki 默认 2500。
fn card_sched_restore(card: &AnkiCard) -> Option<CardSchedRestore> {
    let get = |key: &str| {
        card.extra_fields
            .get(key)
            .and_then(|value| value.trim().parse::<i64>().ok())
    };
    let ivl = get("AnkiIvl").unwrap_or(0);
    let reps = get("AnkiReps").unwrap_or(0);
    if ivl <= 0 || reps <= 0 {
        return None;
    }
    let ivl = ivl.min(36_500);
    let factor = get("AnkiFactor")
        .filter(|factor| (1000..=9999).contains(factor))
        .unwrap_or(2500);
    let lapses = get("AnkiLapses").unwrap_or(0).clamp(0, 9_999);
    let due = get("AnkiDue")
        .filter(|due| (1..=ivl).contains(due))
        .unwrap_or(ivl);
    Some(CardSchedRestore {
        due,
        ivl,
        factor,
        reps: reps.min(1_000_000),
        lapses,
    })
}

fn insert_anki_card_rows(
    conn: &Connection,
    note_id: i64,
    deck_id: i64,
    now: i64,
    card_ords: &[i64],
    next_due: &mut i64,
    sched: Option<&CardSchedRestore>,
) -> Result<(), String> {
    for ord in card_ords {
        let card_id = next_apkg_card_id();
        if let Some(sched) = sched {
            // 携带导入调度元数据的卡片：按复习卡（type=2/queue=2）回写 SM-2 状态
            conn.execute(
                "INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data) VALUES (?, ?, ?, ?, ?, -1, 2, 2, ?, ?, ?, ?, ?, 0, 0, 0, 0, '')",
                params![
                    card_id,
                    note_id,
                    deck_id,
                    ord,
                    now,
                    sched.due,
                    sched.ivl,
                    sched.factor,
                    sched.reps,
                    sched.lapses
                ],
            )
            .map_err(|error| format!("插入卡片失败: {}", error))?;
            continue;
        }
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
            // 全 Cloze 强制转换回填：note_type 被判定为 Cloze 但挖空内容留在 front
            //（text/extra_fields 均为空）时，若 front 含 {{cN::}} 标记则回填 front，
            // 避免导出空 Text 字段导致 {{cloze:Text}} 渲染为空卡。
            if text_value.trim().is_empty() && contains_cloze_marker(&card.front) {
                return clean_template_placeholders(&card.front);
            }
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
            // 兜底闸门：内部协议字段绝不作为 note 字段值输出。
            // 正常流程中这些键已在导出入口规范化与字段表构建两层被过滤，
            // 此处防未来新入口/自定义模板字段名绕过前两层。
            if is_internal_protocol_field(field_name) {
                return String::new();
            }
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
        deck_id: APKG_EXPORT_DECK_ID,
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
        deck_id: APKG_EXPORT_DECK_ID,
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
        deck_id: APKG_EXPORT_DECK_ID,
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
    // 避开 Anki 保留的默认牌组 id 1；dconf 仍为 id 1，deck.conf 指向它
    let deck_id = APKG_EXPORT_DECK_ID;
    let model_id = if model_name == "Cloze" {
        1425279151692i64
    } else {
        1425279151691i64
    };

    // 创建牌组配置
    let deck_key = deck_id.to_string();
    let decks = serde_json::json!({
        deck_key: {
            "id": deck_id,
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
/// (note_id, guid, flds, sort_field, csum, tags, card_ords, 调度回写状态)
type AnkiNoteRecord = (
    String,
    String,
    String,
    String,
    i64,
    String,
    Vec<i64>,
    Option<CardSchedRestore>,
);

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
    let mut used_guids: HashSet<String> = HashSet::new();

    for card in &cards {
        // F9（round2）：全局单调 note_id，避免同秒多次导出碰撞
        let note_id = next_apkg_note_id();
        // 确定性 guid：同一张卡重复导出再导入 Anki 时按 guid 去重，不再重复建卡
        let guid = unique_note_guid(card, &mut used_guids);

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
                // 写入前清洗 U+001F，防止字段对齐被破坏
                let value = sanitize_apkg_field_value(resolve_card_field_value(card, field_name));

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
            let front = sanitize_apkg_field_value(clean_template_placeholders(&card.front));
            let back = sanitize_apkg_field_value(clean_template_placeholders(&card.back));
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
            card_sched_restore(card),
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
    /// 导出过程中的非致命告警（如媒体同名冲突被静默去重）
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// 从卡片列表收集可读媒体文件：
/// - 以文件名去重（Anki 包内媒体按文件名寻址）；
/// - 「同名但来源路径不同」的文件被去重丢弃时记入 warnings，不再静默；
/// - 打开失败的文件进入 missing 清单，不再让整次导出失败；
/// - 返回的句柄在打包时流式拷贝，避免整文件读入内存。
///
/// 返回 (可读媒体条目, 缺失媒体路径, 告警)。
fn collect_media_entries(
    cards: &[AnkiCard],
) -> (Vec<(String, fs::File)>, Vec<String>, Vec<String>) {
    let mut entries: Vec<(String, fs::File)> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    // 文件名 → 首次出现的来源路径（用于识别同名不同源的冲突）
    let mut seen_media_sources: HashMap<String, String> = HashMap::new();
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
            if let Some(first_source) = seen_media_sources.get(fname) {
                if first_source != image_path {
                    let message = format!(
                        "媒体同名冲突：{} 与 {} 文件名相同（{}），仅导出首个来源，后者被跳过",
                        first_source, image_path, fname
                    );
                    warn!("{}", message);
                    warnings.push(message);
                }
                continue;
            }
            seen_media_sources.insert(fname.to_string(), image_path.clone());
            match fs::File::open(image_path) {
                Ok(file) => {
                    // 超大文件保护：与导入侧单条目上限对齐，超限跳过并告警。
                    match file.metadata() {
                        Ok(metadata) if metadata.len() > MAX_EXPORT_MEDIA_FILE_BYTES => {
                            let message = format!(
                                "媒体文件超过 {} 字节导出上限，已跳过: {} ({} 字节)",
                                MAX_EXPORT_MEDIA_FILE_BYTES,
                                image_path,
                                metadata.len()
                            );
                            warn!("{}", message);
                            warnings.push(message);
                            missing.push(image_path.clone());
                        }
                        _ => entries.push((fname.to_string(), file)),
                    }
                }
                Err(e) => {
                    warn!("读取媒体文件失败，跳过并继续导出 {}: {}", image_path, e);
                    missing.push(image_path.clone());
                }
            }
        }
    }
    (entries, missing, warnings)
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
    let media_json =
        serde_json::to_string(&media_map).map_err(|e| format!("序列化媒体列表失败: {}", e))?;

    zip.start_file("media", FileOptions::default())
        .map_err(|e| format!("创建媒体列表条目失败: {}", e))?;
    zip.write_all(media_json.as_bytes())
        .map_err(|e| format!("写入媒体列表失败: {}", e))?;

    for (idx, (fname, file)) in media_entries.iter_mut().enumerate() {
        zip.start_file(idx.to_string(), FileOptions::default())
            .map_err(|e| format!("创建媒体文件条目失败: {}", e))?;
        std::io::copy(file, zip).map_err(|e| format!("写入媒体文件失败 {}: {}", fname, e))?;
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

    // 导出入口规范化（必须先于媒体克隆）：遮挡转换 + 剥离 `_` 协议字段。
    let mut cards = cards;
    normalize_cards_for_export(&mut cards);

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
        // 过滤内部协议字段（`_` 前缀机器字段 + 导入注入的 Anki* 保留字段），
        // 避免再导出时污染 model 字段表。
        let mut extra_keys: Vec<String> = cards
            .iter()
            .flat_map(|c| c.extra_fields.keys().cloned())
            .filter(|key| !is_internal_protocol_field(key))
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

        // 插入笔记和卡片：包进单个事务，避免逐条 INSERT 在 synchronous=FULL 下逐条刷盘
        conn.execute_batch("BEGIN IMMEDIATE;")
            .map_err(|e| format!("开始导出事务失败: {}", e))?;
        let mut next_due = 1i64;
        for (note_id, guid, fields, sort_field, csum, tags, card_ords, sched) in &records {
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

            insert_anki_card_rows(
                &conn,
                note_id,
                deck_id,
                now,
                card_ords,
                &mut next_due,
                sched.as_ref(),
            )?;
        }
        conn.execute_batch("COMMIT;")
            .map_err(|e| format!("提交导出事务失败: {}", e))?;

        conn.close().map_err(|e| format!("关闭数据库失败: {:?}", e))?;

        // 创建.apkg文件（实际上是一个zip文件）
        let parent_dir = output_path.parent().unwrap_or_else(|| std::path::Path::new("."));
        let mut temp_file = NamedTempFile::new_in(parent_dir)
            .map_err(|e| format!("创建临时输出文件失败: {}", e))?;

        // 媒体收集：去重 + 缺失容忍（缺失文件进入报告而不是让整次导出失败），
        // 清单只登记真正可读的条目，保证 media 清单与 zip 条目一一对应。
        let (mut media_entries, missing_media, media_warnings) =
            collect_media_entries(&cards_clone_for_media);

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

        // 直接依赖 NamedTempFile::persist 的原子覆盖语义；
        // 提前 remove_file 会留下"旧文件已删、新文件未落盘"的丢文件窗口。
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
            warnings: media_warnings,
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

    // 导出入口规范化（必须先于媒体克隆）：遮挡转换 + 剥离 `_` 协议字段。
    let mut cards = cards;
    normalize_cards_for_export(&mut cards);

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
        // 避开 Anki 保留的默认牌组 id 1；dconf 仍为 id 1，deck.conf 指向它
        let deck_id = APKG_EXPORT_DECK_ID;

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
                // 追加该组卡片的 extra_fields keys（不在 fields 中的），
                // 并过滤内部协议字段（`_` 前缀机器字段 + Anki* 保留字段）
                let mut extra_keys: Vec<String> = group_cards.iter()
                    .flat_map(|c| c.extra_fields.keys().cloned())
                    .filter(|key| !is_internal_protocol_field(key))
                    .collect();
                extra_keys.sort_by_key(|a| a.to_lowercase());
                extra_keys.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
                for key in &extra_keys {
                    if !fields.iter().any(|f| f.eq_ignore_ascii_case(key)) {
                        fields.push(key.clone());
                    }
                }

                let is_cloze = tmpl.note_type.eq_ignore_ascii_case("Cloze");
                // 确保模型类型必需字段存在：
                // Cloze 的 qfmt 是 {{cloze:Text}}，必须补 Text（+Extra）确保有字段可用；
                // 同时保留 Front/Back 回填，维持 Deep Student 卡片 front/back 的往返保真。
                let mandatory_fields: &[&str] = if is_cloze {
                    &["Text", "Extra", "Front", "Back"]
                } else {
                    &["Front", "Back"]
                };
                for mandatory in mandatory_fields {
                    if !fields.iter().any(|f| f.eq_ignore_ascii_case(mandatory)) {
                        fields.push(mandatory.to_string());
                    }
                }

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
        let deck_key = deck_id.to_string();
        let decks = serde_json::json!({
            deck_key: {
                "id": deck_id, "name": deck_name, "extendRev": 50, "usn": 0,
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
        let mut used_guids: HashSet<String> = HashSet::new();
        let insert_note = |conn: &Connection,
                           card: &AnkiCard,
                           mid: i64,
                           field_names: &[String],
                           is_cloze: bool,
                           next_due: &mut i64,
                           used_guids: &mut HashSet<String>|
         -> Result<(), String> {
            let note_id = next_apkg_note_id(); // F9（round2）：全局单调 id
            // 确定性 guid：同一张卡重复导出再导入 Anki 时按 guid 去重，不再重复建卡
            let guid = unique_note_guid(card, used_guids);

            let mut field_values: Vec<String> = Vec::new();
            for field_name in field_names {
                // F11（round2）：与单模板路径统一字段解析（含 text 回退 extra_fields + ALIAS_MAP）
                // 写入前清洗 U+001F，防止字段对齐被破坏
                let value = sanitize_apkg_field_value(resolve_card_field_value(card, field_name));
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
            let sched = card_sched_restore(card);
            insert_anki_card_rows(
                conn,
                note_id,
                deck_id,
                now,
                &card_ords,
                next_due,
                sched.as_ref(),
            )?;

            Ok(())
        };

        // 包进单个事务，避免逐条 INSERT 在 synchronous=FULL 下逐条刷盘
        conn.execute_batch("BEGIN IMMEDIATE;")
            .map_err(|e| format!("开始导出事务失败: {}", e))?;

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
                    &mut used_guids,
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
                &mut used_guids,
            )?;
        }

        conn.execute_batch("COMMIT;")
            .map_err(|e| format!("提交导出事务失败: {}", e))?;

        conn.close().map_err(|e| format!("关闭数据库失败: {:?}", e))?;

        // 打包 APKG
        let parent_dir = output_path.parent().unwrap_or_else(|| std::path::Path::new("."));
        let mut temp_file = NamedTempFile::new_in(parent_dir)
            .map_err(|e| format!("创建临时输出文件失败: {}", e))?;

        // 媒体收集：与单模板路径统一——去重 + 缺失容忍 + 流式拷贝，
        // media 清单只登记真正可读的条目，缺失文件进入报告。
        let (mut media_entries, missing_media, media_warnings) =
            collect_media_entries(&cards_for_media);

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

        // 直接依赖 NamedTempFile::persist 的原子覆盖语义（见单模板路径说明）
        temp_file.persist(&output_path).map_err(|e| format!("持久化失败: {}", e.error))?;
        Ok(ApkgExportReport {
            exported_media: media_entries.len(),
            missing_media,
            warnings: media_warnings,
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
        card.images = vec![tmp.path().join("ghost.png").to_string_lossy().to_string()];

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
            warnings: vec![],
        };
        let value = serde_json::to_value(&clean).expect("serialize clean report");
        assert_eq!(value["exportedMedia"], 2);
        assert!(value.get("missingMedia").is_none());
        assert!(value.get("warnings").is_none());

        let dirty = ApkgExportReport {
            exported_media: 0,
            missing_media: vec!["/tmp/a.png".to_string()],
            warnings: vec!["媒体同名冲突".to_string()],
        };
        let value = serde_json::to_value(&dirty).expect("serialize dirty report");
        assert_eq!(value["missingMedia"][0], "/tmp/a.png");
        assert_eq!(value["warnings"][0], "媒体同名冲突");
    }

    #[test]
    fn stable_note_guid_is_deterministic_per_card_and_unique_per_id() {
        let card_a = test_card("card-a", "front", "back");
        assert_eq!(stable_note_guid(&card_a), stable_note_guid(&card_a));

        // 相同内容不同 id → 不同 guid
        let card_b = test_card("card-b", "front", "back");
        assert_ne!(stable_note_guid(&card_a), stable_note_guid(&card_b));

        // id 缺失时退化为内容哈希，仍然确定
        let anon = test_card("", "anon front", "anon back");
        assert_eq!(stable_note_guid(&anon), stable_note_guid(&anon));

        // 批内重复卡片：guid 追加序号后缀而不是撞 UNIQUE 约束
        let mut used = HashSet::new();
        let first = unique_note_guid(&card_a, &mut used);
        let second = unique_note_guid(&card_a, &mut used);
        assert_ne!(first, second);
        assert!(second.starts_with(&first));
    }

    #[test]
    fn record_conversion_reuses_stable_guid_across_exports() {
        let card = test_card("stable-guid", "Q", "A");
        let fields = vec!["Front".to_string(), "Back".to_string()];
        let convert = || {
            convert_cards_to_anki_records_with_fields(
                vec![card.clone()],
                1,
                1,
                "Basic",
                Some(&fields),
                None,
            )
            .expect("convert record")
        };
        let first = convert();
        let second = convert();
        assert_eq!(first[0].1, second[0].1, "同一张卡两次导出 guid 必须一致");
        assert_eq!(first[0].1, stable_note_guid(&card));
    }

    #[test]
    fn field_values_with_unit_separator_are_sanitized() {
        let card = test_card("sep", "front\u{1f}with separator", "back\u{1f}too");
        let fields = vec!["Front".to_string(), "Back".to_string()];
        let records = convert_cards_to_anki_records_with_fields(
            vec![card],
            1,
            1,
            "Basic",
            Some(&fields),
            None,
        )
        .expect("convert record");
        assert_eq!(
            records[0].2.split('\u{1f}').count(),
            2,
            "字段值内的 U+001F 必须被清洗，flds 只能有 2 个字段"
        );
        assert_eq!(records[0].2, "front with separator\u{1f}back too");
    }

    #[test]
    fn cloze_text_field_falls_back_to_front_with_cloze_markup() {
        // 全 Cloze 强制转换场景：挖空内容留在 front，text/extra_fields 均为空
        let cloze = test_card("cloze-fallback", "Capital is {{c1::Paris}}", "extra");
        assert_eq!(
            resolve_card_field_value(&cloze, "Text"),
            "Capital is {{c1::Paris}}"
        );

        // front 无 Cloze 标记时不回填，维持原空值行为
        let plain = test_card("plain", "no cloze here", "back");
        assert_eq!(resolve_card_field_value(&plain, "Text"), "");

        // card.text 已有值时优先使用，不受 front 影响
        let mut explicit = test_card("explicit", "{{c1::ignored}}", "back");
        explicit.text = Some("{{c1::kept}}".to_string());
        assert_eq!(resolve_card_field_value(&explicit, "Text"), "{{c1::kept}}");
    }

    #[test]
    fn contains_cloze_marker_matches_valid_markers_only() {
        assert!(contains_cloze_marker("{{c1::answer}}"));
        assert!(contains_cloze_marker("prefix {{c12::answer::hint}} suffix"));
        assert!(!contains_cloze_marker("{{Front}} plain"));
        assert!(!contains_cloze_marker("{{c::missing number}}"));
        assert!(!contains_cloze_marker("no markers"));
    }

    #[test]
    fn reserved_import_metadata_fields_are_filtered_case_insensitively() {
        assert!(is_reserved_import_metadata_field("AnkiNoteId"));
        assert!(is_reserved_import_metadata_field("ankimodelname"));
        assert!(is_reserved_import_metadata_field("AnkiIvl"));
        assert!(is_reserved_import_metadata_field("ankischedtype"));
        assert!(!is_reserved_import_metadata_field("Subject"));
    }

    #[test]
    fn card_sched_restore_requires_review_progress_and_clamps_values() {
        // 无调度元数据 → 新卡
        assert_eq!(card_sched_restore(&test_card("plain", "Q", "A")), None);

        // reps=0 → 视为新卡，不回写
        let mut fresh = test_card("fresh", "Q", "A");
        fresh.extra_fields = HashMap::from([
            ("AnkiIvl".to_string(), "10".to_string()),
            ("AnkiReps".to_string(), "0".to_string()),
        ]);
        assert_eq!(card_sched_restore(&fresh), None);

        // 正常复习卡：due 超出 [1, ivl] 时回退为 ivl，factor 越界回退 2500
        let mut reviewed = test_card("reviewed", "Q", "A");
        reviewed.extra_fields = HashMap::from([
            ("AnkiSchedType".to_string(), "2".to_string()),
            ("AnkiQueue".to_string(), "2".to_string()),
            ("AnkiDue".to_string(), "99999".to_string()),
            ("AnkiIvl".to_string(), "21".to_string()),
            ("AnkiFactor".to_string(), "50".to_string()),
            ("AnkiReps".to_string(), "9".to_string()),
            ("AnkiLapses".to_string(), "2".to_string()),
        ]);
        assert_eq!(
            card_sched_restore(&reviewed),
            Some(CardSchedRestore {
                due: 21,
                ivl: 21,
                factor: 2500,
                reps: 9,
                lapses: 2,
            })
        );

        // due 在合法范围内时按原值保留
        let mut due_kept = test_card("due-kept", "Q", "A");
        due_kept.extra_fields = HashMap::from([
            ("AnkiDue".to_string(), "3".to_string()),
            ("AnkiIvl".to_string(), "21".to_string()),
            ("AnkiFactor".to_string(), "2300".to_string()),
            ("AnkiReps".to_string(), "4".to_string()),
        ]);
        assert_eq!(
            card_sched_restore(&due_kept),
            Some(CardSchedRestore {
                due: 3,
                ivl: 21,
                factor: 2300,
                reps: 4,
                lapses: 0,
            })
        );
    }

    #[tokio::test]
    async fn export_restores_schedule_columns_for_cards_with_imported_metadata() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let out = tmp.path().join("sched-restore.apkg");

        let mut reviewed = test_card("reviewed", "reviewed front", "reviewed back");
        reviewed.extra_fields = HashMap::from([
            ("AnkiSchedType".to_string(), "2".to_string()),
            ("AnkiDue".to_string(), "5".to_string()),
            ("AnkiIvl".to_string(), "12".to_string()),
            ("AnkiFactor".to_string(), "2600".to_string()),
            ("AnkiReps".to_string(), "7".to_string()),
            ("AnkiLapses".to_string(), "1".to_string()),
        ]);
        let fresh = test_card("fresh", "fresh front", "fresh back");

        export_cards_to_apkg_with_full_template(
            vec![reviewed, fresh],
            "SchedDeck".to_string(),
            "Basic".to_string(),
            out.clone(),
            None,
            None,
        )
        .await
        .expect("export apkg with schedule metadata");

        let db_path = tmp.path().join("sched-restore.anki2");
        extract_collection(&out, &db_path);
        let conn = Connection::open(&db_path).expect("open collection");
        let (card_type, queue, due, ivl, factor, reps, lapses): (
            i64,
            i64,
            i64,
            i64,
            i64,
            i64,
            i64,
        ) = conn
            .query_row(
                "SELECT c.type, c.queue, c.due, c.ivl, c.factor, c.reps, c.lapses
                 FROM cards c
                 INNER JOIN notes n ON n.id = c.nid
                 WHERE n.flds LIKE 'reviewed front%'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .expect("load reviewed card schedule");
        assert_eq!(
            (card_type, queue, due, ivl, factor, reps, lapses),
            (2, 2, 5, 12, 2600, 7, 1)
        );

        let (fresh_type, fresh_queue, fresh_ivl): (i64, i64, i64) = conn
            .query_row(
                "SELECT c.type, c.queue, c.ivl
                 FROM cards c
                 INNER JOIN notes n ON n.id = c.nid
                 WHERE n.flds LIKE 'fresh front%'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("load fresh card schedule");
        assert_eq!((fresh_type, fresh_queue, fresh_ivl), (0, 0, 0));
    }

    #[tokio::test]
    async fn reexport_filters_injected_anki_metadata_fields_from_model() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let out = tmp.path().join("reexport-filter.apkg");

        let mut card = test_card("reexport", "Q", "A");
        // 模拟从 APKG 导入回来的卡片：extra_fields 携带注入的 Anki* 元数据
        card.extra_fields = HashMap::from([
            ("AnkiNoteId".to_string(), "1".to_string()),
            ("AnkiCardId".to_string(), "2".to_string()),
            ("AnkiCardOrd".to_string(), "0".to_string()),
            ("AnkiDeckId".to_string(), "1".to_string()),
            ("AnkiModelId".to_string(), "100".to_string()),
            ("AnkiModelName".to_string(), "Basic".to_string()),
            ("Subject".to_string(), "Physics".to_string()),
        ]);

        export_cards_to_apkg_with_full_template(
            vec![card],
            "ReexportDeck".to_string(),
            "Basic".to_string(),
            out.clone(),
            None,
            None,
        )
        .await
        .expect("export apkg");

        let db_path = tmp.path().join("reexport-filter.anki2");
        extract_collection(&out, &db_path);
        let conn = Connection::open(&db_path).expect("open collection");
        let models_json: String = conn
            .query_row("SELECT models FROM col LIMIT 1", [], |row| row.get(0))
            .expect("load models");
        let models: serde_json::Value =
            serde_json::from_str(&models_json).expect("parse models json");
        let model = models
            .as_object()
            .and_then(|o| o.values().next())
            .expect("model object");
        let field_names: Vec<String> = model["flds"]
            .as_array()
            .expect("model flds")
            .iter()
            .filter_map(|f| f["name"].as_str().map(str::to_string))
            .collect();
        assert!(
            field_names.iter().any(|name| name == "Subject"),
            "业务字段必须保留"
        );
        for reserved in RESERVED_IMPORT_METADATA_FIELDS {
            assert!(
                !field_names.iter().any(|name| name == reserved),
                "保留元数据字段 {} 不得进入 model 字段表",
                reserved
            );
        }
        // note.flds 数量必须与 model 字段数一致
        let note_flds: String = conn
            .query_row("SELECT flds FROM notes LIMIT 1", [], |row| row.get(0))
            .expect("load note flds");
        assert_eq!(note_flds.split('\u{1f}').count(), field_names.len());
    }

    #[tokio::test]
    async fn export_uses_non_reserved_deck_id_with_consistent_references() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let out = tmp.path().join("deck-id.apkg");
        export_cards_to_apkg_with_full_template(
            vec![test_card("d1", "Q", "A")],
            "DeckIdCheck".to_string(),
            "Basic".to_string(),
            out.clone(),
            None,
            None,
        )
        .await
        .expect("export apkg");

        let db_path = tmp.path().join("deck-id.anki2");
        extract_collection(&out, &db_path);
        let conn = Connection::open(&db_path).expect("open collection");
        let decks_json: String = conn
            .query_row("SELECT decks FROM col LIMIT 1", [], |row| row.get(0))
            .expect("load decks");
        let decks: serde_json::Value = serde_json::from_str(&decks_json).expect("parse decks");
        let deck_key = APKG_EXPORT_DECK_ID.to_string();
        assert!(
            decks.get(&deck_key).is_some(),
            "decks 必须以新 deck id 为键"
        );
        assert!(decks.get("1").is_none(), "不得再使用保留 deck id 1");
        let card_did: i64 = conn
            .query_row("SELECT did FROM cards LIMIT 1", [], |row| row.get(0))
            .expect("load card did");
        assert_eq!(card_did, APKG_EXPORT_DECK_ID);
    }

    #[tokio::test]
    async fn duplicate_media_basenames_from_different_paths_are_reported() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let out = tmp.path().join("dup-media.apkg");

        let dir_a = tmp.path().join("a");
        let dir_b = tmp.path().join("b");
        std::fs::create_dir_all(&dir_a).expect("dir a");
        std::fs::create_dir_all(&dir_b).expect("dir b");
        let img_a = dir_a.join("same.png");
        let img_b = dir_b.join("same.png");
        std::fs::write(&img_a, b"content-a").expect("write a");
        std::fs::write(&img_b, b"content-b").expect("write b");

        let mut card = test_card("dup", "Q", "A");
        card.images = vec![
            img_a.to_string_lossy().to_string(),
            img_b.to_string_lossy().to_string(),
        ];

        let report = export_cards_to_apkg_with_full_template_report(
            vec![card],
            "DupMedia".to_string(),
            "Basic".to_string(),
            out.clone(),
            None,
            None,
        )
        .await
        .expect("export apkg with duplicate media names");

        assert_eq!(report.exported_media, 1, "同名文件只导出首个来源");
        assert_eq!(report.warnings.len(), 1);
        assert!(report.warnings[0].contains("same.png"));
        assert!(report.warnings[0].contains("媒体同名冲突"));
    }

    // ------------------------------------------------------------------
    // wave2-E r2：内部协议字段过滤 + `_occlusion` 遮挡卡导出闭环
    // ------------------------------------------------------------------

    /// 构造一个 2 盒遮挡 spec 的 `_occlusion` JSON（camelCase 序列化契约）。
    fn occlusion_spec_json(image_ref: &str) -> String {
        serde_json::json!({
            "imageRef": image_ref,
            "boxes": [
                { "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.1, "label": "左心房", "clozeIndex": 1 },
                { "x": 0.5, "y": 0.6, "w": 0.2, "h": 0.1, "label": "右心室", "clozeIndex": 2 }
            ]
        })
        .to_string()
    }

    #[test]
    fn internal_protocol_field_predicate_covers_underscore_and_reserved_keys() {
        // `_` 前缀机器协议字段一律命中
        assert!(is_internal_protocol_field("_occlusion"));
        assert!(is_internal_protocol_field("_qa_flags"));
        assert!(is_internal_protocol_field("_original_generation"));
        assert!(is_internal_protocol_field("_content_provenance"));
        // 既有 13 个 Anki* 保留键（大小写不敏感）同样命中
        assert!(is_internal_protocol_field("AnkiNoteId"));
        assert!(is_internal_protocol_field("ankiivl"));
        // 用户可见的非 `_` 字段绝不过滤
        assert!(!is_internal_protocol_field("Subject"));
        assert!(!is_internal_protocol_field("Extra"));
        assert!(!is_internal_protocol_field("Occlusion"));
    }

    #[test]
    fn resolve_card_field_value_refuses_internal_protocol_fields() {
        let mut card = test_card("guard", "Q", "A");
        card.extra_fields = HashMap::from([
            ("_occlusion".to_string(), "{\"imageRef\":\"x\"}".to_string()),
            ("_qa_flags".to_string(), "[]".to_string()),
            ("Subject".to_string(), "Physics".to_string()),
        ]);
        // 兜底闸门：即使字段表构建层被绕过，内部键也解析为空值
        assert_eq!(resolve_card_field_value(&card, "_occlusion"), "");
        assert_eq!(resolve_card_field_value(&card, "_qa_flags"), "");
        // 用户可见字段不受影响
        assert_eq!(resolve_card_field_value(&card, "Subject"), "Physics");
    }

    #[test]
    fn format_io_rects_delegates_to_validated_anki_io_syntax() {
        // 合法 spec → 经 validate_spec 后调用 format_anki_io_cloze，
        // 输出官方 IO rect 0–1 归一化小数（前导点风格、去尾零、盒间无分隔符）。
        let spec = crate::anki_image_occlusion::OcclusionSpec {
            image_ref: "diagram.png".to_string(),
            boxes: vec![
                crate::anki_image_occlusion::OcclusionBox {
                    x: 0.1,
                    y: 0.2,
                    w: 0.3,
                    h: 0.1,
                    label: "左心房".to_string(),
                    cloze_index: Some(1),
                },
                crate::anki_image_occlusion::OcclusionBox {
                    x: 0.5,
                    y: 0.625,
                    w: 0.125,
                    h: 0.25,
                    label: "右心室".to_string(),
                    cloze_index: Some(2),
                },
            ],
        };
        assert_eq!(
            format_io_rects(&spec),
            "{{c1::image-occlusion:rect:left=.1:top=.2:width=.3:height=.1}}\
             {{c2::image-occlusion:rect:left=.5:top=.625:width=.125:height=.25}}"
        );

        // 非法 spec（空盒列表）→ 空串，不产 IO 语法、不阻断导出
        let invalid = crate::anki_image_occlusion::OcclusionSpec {
            image_ref: "diagram.png".to_string(),
            boxes: vec![],
        };
        assert_eq!(format_io_rects(&invalid), "");
    }

    #[test]
    fn occlusion_media_file_name_resolves_basename_and_rejects_placeholders() {
        assert_eq!(
            occlusion_media_file_name("/tmp/media/diagram.png").as_deref(),
            Some("diagram.png")
        );
        assert_eq!(
            occlusion_media_file_name("vfs://images/diagram.png").as_deref(),
            Some("diagram.png")
        );
        assert_eq!(occlusion_media_file_name("vlm://pending-image"), None);
        assert_eq!(occlusion_media_file_name("   "), None);
    }

    #[test]
    fn normalize_keeps_cards_without_occlusion_unchanged() {
        // 旧卡（无 `_occlusion`、无 `_` 键）：规范化必须是恒等变换，
        // 含 Anki* 调度键（card_sched_restore 仍要读）与业务字段。
        let mut plain = test_card("plain", "Q", "A");
        plain.text = Some("{{c1::kept}}".to_string());
        plain.images = vec!["/tmp/img.png".to_string()];
        plain.extra_fields = HashMap::from([
            ("Subject".to_string(), "Physics".to_string()),
            ("AnkiIvl".to_string(), "21".to_string()),
        ]);
        let before = plain.clone();
        let mut cards = vec![plain];
        normalize_cards_for_export(&mut cards);
        assert_eq!(cards[0].text, before.text);
        assert_eq!(cards[0].images, before.images);
        assert_eq!(cards[0].extra_fields, before.extra_fields);
        assert_eq!(cards[0].front, before.front);
        assert_eq!(cards[0].back, before.back);
    }

    #[test]
    fn normalize_strips_underscore_fields_but_keeps_anki_sched_keys() {
        let mut card = test_card("strip", "Q", "A");
        card.extra_fields = HashMap::from([
            ("_qa_flags".to_string(), "[]".to_string()),
            ("_original_generation".to_string(), "{}".to_string()),
            ("_content_provenance".to_string(), "{}".to_string()),
            ("AnkiIvl".to_string(), "21".to_string()),
            ("Subject".to_string(), "Physics".to_string()),
        ]);
        let mut cards = vec![card];
        normalize_cards_for_export(&mut cards);
        let extras = &cards[0].extra_fields;
        assert!(!extras.keys().any(|k| k.starts_with('_')));
        // Anki* 调度键保留给 card_sched_restore；字段表层单独过滤它们
        assert_eq!(extras.get("AnkiIvl").map(String::as_str), Some("21"));
        assert_eq!(extras.get("Subject").map(String::as_str), Some("Physics"));
    }

    #[test]
    fn occlusion_conversion_builds_cloze_text_media_without_io_extra() {
        let mut card = test_card("occ", "front", "揭底说明");
        card.extra_fields = HashMap::from([(
            "_occlusion".to_string(),
            occlusion_spec_json("/tmp/media/diagram.png"),
        )]);
        let mut cards = vec![card];
        normalize_cards_for_export(&mut cards);
        let converted = &cards[0];

        // Text = img + 标准 Cloze（labels 现拼路径）
        let text = converted.text.as_deref().expect("occlusion text");
        assert!(text.starts_with("<img src=\"diagram.png\"><br>"));
        assert!(text.contains("{{c1::左心房}}"));
        assert!(text.contains("{{c2::右心室}}"));
        // images 为空时从 imageRef 补收集
        assert_eq!(converted.images, vec!["/tmp/media/diagram.png".to_string()]);
        // wave2-E r3：转换器不再插入 Extra 键（机器 IO 语法不得进入用户可见
        // 的揭底区）；Extra 取值由 resolve_card_field_value 回退 card.back。
        assert!(!converted
            .extra_fields
            .keys()
            .any(|k| k.eq_ignore_ascii_case("Extra")));
        let resolved_extra = resolve_card_field_value(converted, "Extra");
        assert_eq!(resolved_extra, "揭底说明", "Extra 必须回退人类可读的 back");
        assert!(
            !resolved_extra.contains("image-occlusion:rect"),
            "导出 Extra 不得含 IO 机器语法"
        );
        // 转换后 `_occlusion` 必须被删除
        assert!(!converted.extra_fields.contains_key("_occlusion"));
    }

    #[test]
    fn occlusion_conversion_leaves_human_extra_untouched() {
        // 用户已有 Extra（人类补充）：转换器不得改写、不得追加 IO 语法。
        let mut card = test_card("occ-extra", "front", "back");
        card.extra_fields = HashMap::from([
            (
                "_occlusion".to_string(),
                occlusion_spec_json("/tmp/media/diagram.png"),
            ),
            ("Extra".to_string(), "人工笔记：注意瓣膜方向".to_string()),
        ]);
        let mut cards = vec![card];
        normalize_cards_for_export(&mut cards);
        let converted = &cards[0];
        assert_eq!(
            converted.extra_fields.get("Extra").map(String::as_str),
            Some("人工笔记：注意瓣膜方向")
        );
        let resolved_extra = resolve_card_field_value(converted, "Extra");
        assert!(!resolved_extra.contains("image-occlusion:rect"));
    }

    #[test]
    fn occlusion_conversion_prefers_existing_card_text() {
        let mut card = test_card("occ-text", "front", "");
        card.text = Some("{{c1::既有挖空}}".to_string());
        card.extra_fields = HashMap::from([(
            "_occlusion".to_string(),
            occlusion_spec_json("vfs://images/diagram.png"),
        )]);
        let mut cards = vec![card];
        normalize_cards_for_export(&mut cards);
        let text = cards[0].text.as_deref().expect("text");
        // card.text 优先，但仍补 <img>（包内文件名口径）
        assert_eq!(text, "<img src=\"diagram.png\"><br>{{c1::既有挖空}}");
    }

    #[tokio::test]
    async fn internal_protocol_fields_do_not_enter_model_field_table() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let out = tmp.path().join("internal-filter.apkg");

        let mut card = test_card("internal", "Q", "A");
        card.extra_fields = HashMap::from([
            ("_qa_flags".to_string(), "[{\"code\":\"x\"}]".to_string()),
            (
                "_original_generation".to_string(),
                "{\"front\":\"Q\"}".to_string(),
            ),
            (
                "_content_provenance".to_string(),
                "{\"actor\":\"llm\"}".to_string(),
            ),
            ("Subject".to_string(), "Physics".to_string()),
        ]);

        export_cards_to_apkg_with_full_template(
            vec![card],
            "InternalFilter".to_string(),
            "Basic".to_string(),
            out.clone(),
            None,
            None,
        )
        .await
        .expect("export apkg");

        let db_path = tmp.path().join("internal-filter.anki2");
        extract_collection(&out, &db_path);
        let conn = Connection::open(&db_path).expect("open collection");
        let models_json: String = conn
            .query_row("SELECT models FROM col LIMIT 1", [], |row| row.get(0))
            .expect("load models");
        let models: serde_json::Value =
            serde_json::from_str(&models_json).expect("parse models json");
        let model = models
            .as_object()
            .and_then(|o| o.values().next())
            .expect("model object");
        let field_names: Vec<String> = model["flds"]
            .as_array()
            .expect("model flds")
            .iter()
            .filter_map(|f| f["name"].as_str().map(str::to_string))
            .collect();
        assert!(
            field_names.iter().any(|name| name == "Subject"),
            "用户可见业务字段必须保留"
        );
        assert!(
            !field_names.iter().any(|name| name.starts_with('_')),
            "`_` 前缀内部协议字段不得进入 model 字段表: {:?}",
            field_names
        );
        // note 内容也不得残留协议 JSON
        let note_flds: String = conn
            .query_row("SELECT flds FROM notes LIMIT 1", [], |row| row.get(0))
            .expect("load note flds");
        assert!(!note_flds.contains("_original_generation"));
        assert!(!note_flds.contains("llm"));
        assert_eq!(note_flds.split('\u{1f}').count(), field_names.len());
    }

    #[tokio::test]
    async fn occlusion_card_exports_reviewable_cloze_note_with_media() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let out = tmp.path().join("occlusion.apkg");

        let img_path = tmp.path().join("diagram.png");
        std::fs::write(&img_path, b"\x89PNG\r\n\x1a\n").expect("write img");

        let mut card = test_card("occ-export", "front", "back");
        card.extra_fields = HashMap::from([
            (
                "_occlusion".to_string(),
                occlusion_spec_json(&img_path.to_string_lossy()),
            ),
            ("_qa_flags".to_string(), "[]".to_string()),
        ]);

        let report = export_cards_to_apkg_with_full_template_report(
            vec![card],
            "OcclusionDeck".to_string(),
            "Cloze".to_string(),
            out.clone(),
            None,
            None,
        )
        .await
        .expect("export occlusion apkg");
        assert_eq!(report.exported_media, 1, "imageRef 媒体必须打包");
        assert!(report.missing_media.is_empty());

        let db_path = tmp.path().join("occlusion.anki2");
        extract_collection(&out, &db_path);
        let conn = Connection::open(&db_path).expect("open collection");

        // Text 字段含 img + 标准 Cloze，可复习
        let note_flds: String = conn
            .query_row("SELECT flds FROM notes LIMIT 1", [], |row| row.get(0))
            .expect("load note flds");
        assert!(note_flds.contains("<img src=\"diagram.png\">"));
        assert!(note_flds.contains("{{c1::左心房}}"));
        assert!(note_flds.contains("{{c2::右心室}}"));
        assert!(
            !note_flds.contains("_occlusion"),
            "`_occlusion` spec JSON 不得进入 note 字段值"
        );
        // wave2-E r3 泄漏回归闸：包括 Extra 在内的任何 note 字段
        // 都不得含 IO 机器语法（揭底时用户不应看见坐标乱码）
        assert!(
            !note_flds.contains("image-occlusion:rect"),
            "导出 note 字段（含 Extra）不得含 IO 语法: {}",
            note_flds
        );

        // 两个 cloze 序号 → 两张卡
        let card_ords = conn
            .prepare("SELECT ord FROM cards ORDER BY ord")
            .expect("prepare card ords")
            .query_map([], |row| row.get::<_, i64>(0))
            .expect("query card ords")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect card ords");
        assert_eq!(card_ords, vec![0, 1]);

        // model 字段表无 `_` 键
        let models_json: String = conn
            .query_row("SELECT models FROM col LIMIT 1", [], |row| row.get(0))
            .expect("load models");
        let models: serde_json::Value =
            serde_json::from_str(&models_json).expect("parse models json");
        let model = models
            .as_object()
            .and_then(|o| o.values().next())
            .expect("model object");
        assert!(model["flds"]
            .as_array()
            .expect("model flds")
            .iter()
            .filter_map(|f| f["name"].as_str())
            .all(|name| !name.starts_with('_')));

        // 媒体清单登记包内文件名
        let f = std::fs::File::open(&out).expect("open apkg");
        let mut zip = zip::ZipArchive::new(f).expect("zip open");
        let mut media_file = zip.by_name("media").expect("media manifest");
        let mut media_json = String::new();
        media_file
            .read_to_string(&mut media_json)
            .expect("read media manifest");
        let media_map: serde_json::Value =
            serde_json::from_str(&media_json).expect("parse media manifest");
        assert_eq!(
            media_map.get("0").and_then(|v| v.as_str()),
            Some("diagram.png")
        );
    }

    #[tokio::test]
    async fn occlusion_card_with_missing_image_still_exports_text() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let out = tmp.path().join("occlusion-missing.apkg");
        let ghost = tmp.path().join("ghost.png");

        let mut card = test_card("occ-missing", "front", "back");
        card.extra_fields = HashMap::from([(
            "_occlusion".to_string(),
            occlusion_spec_json(&ghost.to_string_lossy()),
        )]);

        let report = export_cards_to_apkg_with_full_template_report(
            vec![card],
            "OcclusionMissing".to_string(),
            "Cloze".to_string(),
            out.clone(),
            None,
            None,
        )
        .await
        .expect("缺失图片不得让导出失败");
        assert_eq!(report.exported_media, 0);
        assert_eq!(report.missing_media.len(), 1);

        // note 仍可导出：Text（img 引用 + cloze）完整保留
        let db_path = tmp.path().join("occlusion-missing.anki2");
        extract_collection(&out, &db_path);
        let conn = Connection::open(&db_path).expect("open collection");
        let note_flds: String = conn
            .query_row("SELECT flds FROM notes LIMIT 1", [], |row| row.get(0))
            .expect("load note flds");
        assert!(note_flds.contains("<img src=\"ghost.png\">"));
        assert!(note_flds.contains("{{c1::左心房}}"));
    }
}
