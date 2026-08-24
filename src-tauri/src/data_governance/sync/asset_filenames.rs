//! [R09-names] 资产文件名跨平台净化。
//!
//! 资产同步的云端 key 形如 `active/images/<相对路径>`，相对路径直接来自本地
//! 文件名（见 `SyncManager::scan_asset_tree`）。Linux 上合法的文件名在
//! Windows/macOS 上可能无法物化或互相覆盖，本模块把 key 中的用户命名段净化为
//! 三平台都能安全落盘的形式：
//!
//! - **Windows 非法字符** `\ / : * ? " < > |` 及控制字符 → `_`；
//! - **Windows 保留设备名**（CON/PRN/AUX/NUL/COM0-9/LPT0-9，含 `CON.txt` 这类
//!   带扩展名形式，大小写不敏感）→ 词干追加 `_`（`CON` → `CON_`、
//!   `con.txt` → `con_.txt`）；
//! - **尾部点/空格**（Windows 资源管理器/Win32 API 不允许）→ 去除；
//! - **Unicode 统一 NFC**（macOS 文件系统惯用 NFD，Linux/Windows 惯用 NFC，
//!   不归一会导致同一视觉文件名分裂为两个 key）；
//! - **空名回退**：净化后为空的段（如 `...`、`???` 之外的全点名）→
//!   `unnamed-<原名 sha256 前 8 位十六进制>`，确定性且可去重。
//!
//! 关键不变量：**幂等**——`sanitize_segment(sanitize_segment(x)) == sanitize_segment(x)`。
//! 下载端把净化后的 key 物化为本地文件后，再次扫描生成的 key 必须与云端 key
//! 一致，否则会乒乓上传/重复下载。本文件的单元测试锁定该不变量。
//!
//! 大小写冲突（`Logo.png` vs `logo.png`）无法通过改名静默消解——两个 key 都是
//! 合法文件名，只是在大小写不敏感文件系统上会互相覆盖。本模块提供
//! [`casefold_key`] 折叠视图与统一的人话冲突文案（带 [`FILENAME_CONFLICT_MARKER`]
//! 稳定标记，前端据此映射为 i18n 消息），由 `sync_asset_directories*` 在
//! 上传/下载两侧确定性地保留一方、跳过另一方并在 outcome 中报告。

use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

/// 稳定的机器可读标记：所有文件名冲突类失败消息都以它开头，前端
/// （`DataGovernanceDashboard` / `SyncSettingsSection`）检测到后把原始消息映射
/// 为 locale 里的人话错误（`sync:filenameConflict.notice`）。
pub const FILENAME_CONFLICT_MARKER: &str = "[filename-conflict]";

/// Windows 非法文件名字符（`/` 在 key 里是段分隔符，本模块按段处理时同样替换，
/// 防御性地覆盖跨段注入）。
const WINDOWS_ILLEGAL_CHARS: [char; 9] = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];

/// Windows 保留设备名（词干匹配，大小写不敏感；`CON.txt` 同样被 Windows 拒绝）。
const WINDOWS_RESERVED_STEMS: [&str; 24] = [
    "CON", "PRN", "AUX", "NUL", "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
    "COM8", "COM9", "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8",
    "LPT9",
];

/// 净化单个路径段（文件名或中间目录名）。幂等。
pub fn sanitize_segment(raw: &str) -> String {
    // 1. NFC 归一（macOS NFD → NFC）
    let normalized: String = raw.nfc().collect();

    // 2. 非法字符与控制字符 → `_`
    let mut cleaned: String = normalized
        .chars()
        .map(|c| {
            if WINDOWS_ILLEGAL_CHARS.contains(&c) || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();

    // 3. 去掉尾部点/空格（Windows 不允许；`..`/`.` 会被清空进入回退，顺带
    //    消灭路径遍历段）
    while cleaned.ends_with('.') || cleaned.ends_with(' ') {
        cleaned.pop();
    }

    // 4. 空名回退（原名全由点/空格/不可见字符构成）
    if cleaned.is_empty() {
        return empty_name_fallback(raw);
    }

    // 5. Windows 保留设备名：词干（首个 `.` 之前，忽略词干尾部空格）命中则
    //    追加 `_`。追加后词干以 `_` 结尾，不再命中 → 幂等。
    let stem_end = cleaned.find('.').unwrap_or(cleaned.len());
    let stem = cleaned[..stem_end].trim_end_matches(' ');
    if WINDOWS_RESERVED_STEMS
        .iter()
        .any(|reserved| reserved.eq_ignore_ascii_case(stem))
    {
        cleaned.insert(stem_end, '_');
    }

    cleaned
}

/// 净化 key 的相对路径部分（`/` 分隔的多段）。幂等。
pub fn sanitize_rel_path(raw_rel: &str) -> String {
    raw_rel
        .split('/')
        .map(sanitize_segment)
        .collect::<Vec<_>>()
        .join("/")
}

/// 净化完整资产 key（`<root>/<top>/<rel...>`）。
///
/// `root`（active/app_data）与 `top`（同步目录白名单）不属于用户命名，保持
/// 原样——非法的 root/top 仍由 `asset_local_path_from_key` fail-close 拒绝。
/// 结构不完整（不足三段或段为空）返回 `None`。
pub fn sanitize_asset_key(key: &str) -> Option<String> {
    let mut parts = key.splitn(3, '/');
    let root = parts.next()?;
    let top = parts.next()?;
    let rel = parts.next()?;
    if root.is_empty() || top.is_empty() || rel.is_empty() {
        return None;
    }
    Some(format!("{}/{}/{}", root, top, sanitize_rel_path(rel)))
}

/// 大小写折叠视图：NFC + Unicode 小写。折叠值相同的两个 key 在大小写不敏感
/// 文件系统（Windows/macOS 默认）上映射到同一本地路径。
pub fn casefold_key(key: &str) -> String {
    key.nfc().flat_map(char::to_lowercase).collect()
}

fn empty_name_fallback(raw: &str) -> String {
    let digest = Sha256::digest(raw.as_bytes());
    format!("unnamed-{}", hex::encode(&digest[..4]))
}

// ============================================================================
// 冲突文案（单一来源，均带 FILENAME_CONFLICT_MARKER 前缀）
// ============================================================================

/// 本地两个文件净化后重名（如 `file.` 与 `file`、NFC 与 NFD 同名）。
pub fn local_duplicate_message(key: &str, kept: &str, skipped: &str) -> String {
    format!(
        "{FILENAME_CONFLICT_MARKER} {key}: 本地文件 {skipped} 与 {kept} 在净化后重名，\
         本次仅同步 {kept}；请重命名其中一个文件后重新同步"
    )
}

/// 本地两个 key 仅大小写不同。
pub fn local_case_conflict_message(skipped_key: &str, kept_key: &str) -> String {
    format!(
        "{FILENAME_CONFLICT_MARKER} {skipped_key}: 与本地 {kept_key} 仅文件名大小写不同，\
         在不区分大小写的系统（Windows/macOS 默认）上会互相覆盖，已跳过上传；\
         请重命名其中一个文件后重新同步"
    )
}

/// 本地新文件与云端既有 key 仅大小写不同。
pub fn upload_case_conflict_message(local_key: &str, cloud_key: &str) -> String {
    format!(
        "{FILENAME_CONFLICT_MARKER} {local_key}: 与云端 {cloud_key} 仅文件名大小写不同，\
         在不区分大小写的系统（Windows/macOS 默认）上会互相覆盖，已跳过上传；\
         请重命名本地文件后重新同步"
    )
}

/// 云端 key 与本地/本轮已物化文件仅大小写不同，跳过下载。
pub fn download_case_conflict_message(cloud_key: &str, occupied_by: &str) -> String {
    format!(
        "{FILENAME_CONFLICT_MARKER} {cloud_key}: 与 {occupied_by} 仅文件名大小写不同，\
         为避免在不区分大小写的系统上互相覆盖已跳过下载；\
         请在源设备重命名该文件后重新同步"
    )
}

/// 云端两个遗留 key 净化后重名且内容不同（无法同时物化）。
pub fn shadowed_divergent_message(skipped_key: &str, kept_key: &str) -> String {
    format!(
        "{FILENAME_CONFLICT_MARKER} {skipped_key}: 与 {kept_key} 在净化后重名但内容不同，\
         本地按 {kept_key} 物化；请在源设备重命名后重新同步"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_idempotent(raw: &str) {
        let once = sanitize_segment(raw);
        assert_eq!(
            sanitize_segment(&once),
            once,
            "sanitize_segment 必须幂等: raw={raw:?} once={once:?}"
        );
    }

    #[test]
    fn windows_illegal_chars_are_replaced() {
        assert_eq!(
            sanitize_segment("screenshot 12:30:45.png"),
            "screenshot 12_30_45.png"
        );
        assert_eq!(sanitize_segment("page?query=1.pdf"), "page_query=1.pdf");
        assert_eq!(sanitize_segment(r#"a\b*c"d<e>f|g.txt"#), "a_b_c_d_e_f_g.txt");
        assert_eq!(sanitize_segment("tab\tname.txt"), "tab_name.txt");
        for raw in [
            "screenshot 12:30:45.png",
            "page?query=1.pdf",
            r#"a\b*c"d<e>f|g.txt"#,
        ] {
            assert_idempotent(raw);
        }
    }

    #[test]
    fn windows_reserved_names_get_stem_suffix() {
        assert_eq!(sanitize_segment("CON"), "CON_");
        assert_eq!(sanitize_segment("con.txt"), "con_.txt");
        assert_eq!(sanitize_segment("Com1.pdf"), "Com1_.pdf");
        assert_eq!(sanitize_segment("LPT1"), "LPT1_");
        assert_eq!(sanitize_segment("NUL.tar.gz"), "NUL_.tar.gz");
        assert_eq!(sanitize_segment("PRN"), "PRN_");
        assert_eq!(sanitize_segment("AUX.json"), "AUX_.json");
        // 非保留名不受影响
        assert_eq!(sanitize_segment("CONTRACT.pdf"), "CONTRACT.pdf");
        assert_eq!(sanitize_segment("console.log"), "console.log");
        for raw in ["CON", "con.txt", "Com1.pdf", "NUL.tar.gz"] {
            assert_idempotent(raw);
        }
    }

    #[test]
    fn trailing_dots_and_spaces_are_stripped() {
        assert_eq!(sanitize_segment("report."), "report");
        assert_eq!(sanitize_segment("draft "), "draft");
        assert_eq!(sanitize_segment("mixed. . "), "mixed");
        // 保留名 + 尾部点组合：先去尾再判保留
        assert_eq!(sanitize_segment("CON."), "CON_");
        // 隐藏文件（前导点）不受影响
        assert_eq!(sanitize_segment(".gitignore"), ".gitignore");
        for raw in ["report.", "draft ", "mixed. . ", "CON."] {
            assert_idempotent(raw);
        }
    }

    #[test]
    fn empty_names_fall_back_deterministically() {
        let fallback = sanitize_segment("...");
        assert!(
            fallback.starts_with("unnamed-"),
            "全点名应回退: {fallback:?}"
        );
        assert_eq!(
            fallback,
            sanitize_segment("..."),
            "回退名必须确定性（同名同回退）"
        );
        assert_ne!(
            sanitize_segment("..."),
            sanitize_segment(". ."),
            "不同原名回退到不同名字"
        );
        // `.`/`..` 被净化为回退名，路径遍历段不可能存活
        assert!(sanitize_segment(".").starts_with("unnamed-"));
        assert!(sanitize_segment("..").starts_with("unnamed-"));
        assert_idempotent("...");
        assert_idempotent("..");
    }

    #[test]
    fn unicode_is_normalized_to_nfc() {
        let nfc = "caf\u{e9}.png"; // é = U+00E9
        let nfd = "cafe\u{301}.png"; // e + U+0301
        assert_ne!(nfc, nfd);
        assert_eq!(sanitize_segment(nfd), nfc);
        assert_eq!(sanitize_segment(nfc), nfc);
        assert_idempotent(nfd);
    }

    #[test]
    fn normal_names_are_untouched() {
        for name in [
            "photo.png",
            "我的 笔记 (1).md",
            "notes_2024-01-01.txt",
            "深度 学习.pdf",
            "a-b_c.d",
        ] {
            assert_eq!(sanitize_segment(name), name, "常规名必须原样保留");
        }
    }

    #[test]
    fn rel_path_sanitizes_each_segment() {
        assert_eq!(
            sanitize_rel_path("sub:dir/CON.txt"),
            "sub_dir/CON_.txt"
        );
        assert_eq!(sanitize_rel_path("a/b.png"), "a/b.png");
        let twice = sanitize_rel_path(&sanitize_rel_path("x./y :z/.."));
        assert_eq!(twice, sanitize_rel_path("x./y :z/.."), "rel 净化幂等");
    }

    #[test]
    fn asset_key_keeps_root_and_top() {
        assert_eq!(
            sanitize_asset_key("active/images/pic:1.png").as_deref(),
            Some("active/images/pic_1.png")
        );
        assert_eq!(
            sanitize_asset_key("app_data/pdf_ocr_sessions/s1/page?.json").as_deref(),
            Some("app_data/pdf_ocr_sessions/s1/page_.json")
        );
        // 结构不完整 → None（交由 asset_local_path_from_key fail-close）
        assert_eq!(sanitize_asset_key("active/images"), None);
        assert_eq!(sanitize_asset_key("active//x"), None);
        assert_eq!(sanitize_asset_key(""), None);
    }

    #[test]
    fn casefold_detects_case_and_normalization_collisions() {
        assert_eq!(
            casefold_key("active/images/Logo.png"),
            casefold_key("active/images/logo.png")
        );
        assert_eq!(
            casefold_key("active/images/caf\u{e9}.PNG"),
            casefold_key("active/images/cafe\u{301}.png")
        );
        assert_ne!(
            casefold_key("active/images/a.png"),
            casefold_key("active/images/b.png")
        );
    }

    #[test]
    fn conflict_messages_carry_stable_marker() {
        for msg in [
            local_duplicate_message("k", "a", "b"),
            local_case_conflict_message("a", "b"),
            upload_case_conflict_message("a", "b"),
            download_case_conflict_message("a", "b"),
            shadowed_divergent_message("a", "b"),
        ] {
            assert!(
                msg.starts_with(FILENAME_CONFLICT_MARKER),
                "冲突文案必须以稳定标记开头: {msg}"
            );
        }
    }
}
