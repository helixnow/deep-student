//! 共享的断点续传下载编排。
//!
//! 生产调用方：
//! - 整包 ZIP 恢复（`CloudSyncManager::download_with_progress`，自带 `.part`）
//! - 仓库巡检（`repo_check`，临时 `.partial`）
//! - 文件级对象（`SyncManager::download_file_object`，旁路 `.ds-dl.part`）
//!
//! 不支持续传的后端（FTP、测试内存盘）走整包 [`CloudStorage::get_file`]。
//! 错位 / 超大断点 fail-closed，禁止往错误前缀上追加。

use std::path::Path;
use std::sync::Arc;

use super::traits::{CloudStorage, DownloadProgressCallback, Result};
use crate::models::AppError;

/// 同一次下载内，瞬时断线最多再试几次（含首次）。
pub(crate) const RESUMABLE_GET_ATTEMPTS: u32 = 3;

/// 断点文件可续传的字节数。符号链接、空文件、或比云端对象还大的残留一律丢弃。
pub(crate) fn dest_resume_len(dest: &Path, remote_size: u64) -> u64 {
    match std::fs::symlink_metadata(dest) {
        Ok(metadata)
            if !metadata.file_type().is_symlink()
                && metadata.is_file()
                && metadata.len() > 0
                && metadata.len() <= remote_size =>
        {
            metadata.len()
        }
        Ok(_) => {
            let _ = std::fs::remove_file(dest);
            0
        }
        Err(_) => 0,
    }
}

/// 支持 Range 的后端从断点续传并在同一次调用内重试；否则整包 `get_file`。
///
/// `dest` 必须是调用方独占的下载文件（巡检临时文件、文件级 `.ds-dl.part`、
/// 密文临时文件）。**禁止**把已有业务文件当作 `dest` 追加。
pub(crate) async fn get_file_with_optional_resume(
    storage: &dyn CloudStorage,
    key: &str,
    dest: &Path,
    expected_checksum: Option<&str>,
    progress: Option<DownloadProgressCallback>,
) -> Result<String> {
    if !storage.supports_resumable_download() {
        return storage
            .get_file(key, dest, expected_checksum, progress)
            .await;
    }

    let remote_size = storage
        .stat(key)
        .await?
        .ok_or_else(|| AppError::not_found("云端文件不存在"))?
        .size;

    let progress: Option<Arc<dyn Fn(u64, u64) + Send + Sync>> =
        progress.map(|callback| Arc::from(callback) as Arc<dyn Fn(u64, u64) + Send + Sync>);

    let mut last_err = None;
    for attempt in 1..=RESUMABLE_GET_ATTEMPTS {
        let resume_from = dest_resume_len(dest, remote_size);
        let callback = progress.as_ref().map(|arc| {
            let arc = Arc::clone(arc);
            Box::new(move |done, total| arc(done, total)) as DownloadProgressCallback
        });
        match storage
            .get_file_resumable(key, dest, resume_from, callback)
            .await
        {
            Ok(_) => {
                let actual = crate::backup_common::calculate_file_hash(dest)?;
                if let Some(expected) = expected_checksum {
                    if actual != expected {
                        let _ = std::fs::remove_file(dest);
                        return Err(AppError::validation(format!(
                            "校验和不匹配: 期望 {}, 实际 {}",
                            &expected[..8.min(expected.len())],
                            &actual[..8.min(actual.len())]
                        )));
                    }
                }
                return Ok(actual);
            }
            Err(error) => {
                tracing::warn!(
                    attempt,
                    resume_from,
                    key,
                    "续传下载失败，将按断点重试: {error}"
                );
                last_err = Some(error);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| AppError::internal("续传下载失败且未留下错误".to_string())))
}

/// 文件级续传旁路：文件名带内容哈希前缀，新版本不会续上旧对象的前缀。
pub(crate) fn content_keyed_part_path(dest: &Path, checksum: &str) -> std::path::PathBuf {
    let name = dest
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "object".to_string());
    dest.with_file_name(format!(".{name}.{}.ds-dl.part", checksum_tag(checksum)))
}

fn checksum_tag(checksum: &str) -> String {
    let tag: String = checksum
        .chars()
        .filter(|ch| ch.is_ascii_hexdigit())
        .take(16)
        .collect();
    if tag.len() >= 8 {
        tag
    } else {
        "unknown".to_string()
    }
}

/// 删除同一业务文件的其它续传旁路，只保留当前内容哈希对应的那份。
pub(crate) fn cleanup_stale_parts(dest: &Path, keep: &Path) {
    let Some(parent) = dest.parent() else {
        return;
    };
    let Some(name) = dest.file_name() else {
        return;
    };
    let prefix = format!(".{}.", name.to_string_lossy());
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        if file_name.starts_with(&prefix) && file_name.ends_with(".ds-dl.part") && path != keep {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// 把已校验的下载旁路文件落到业务 `dest`。先 copy 再删 part，避免 Windows
/// 上 `rename` 不能覆盖已有文件时先删 dest 造成空窗。
pub(crate) fn persist_download(part: &Path, dest: &Path) -> Result<()> {
    if part == dest {
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::file_system(format!("创建下载目录失败: {e}")))?;
    }
    match std::fs::rename(part, dest) {
        Ok(()) => Ok(()),
        Err(_) => {
            std::fs::copy(part, dest)
                .map_err(|e| AppError::file_system(format!("保存下载文件失败: {e}")))?;
            let _ = std::fs::remove_file(part);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dest_resume_len_keeps_valid_prefix_and_drops_oversize() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("none");
        assert_eq!(dest_resume_len(&missing, 100), 0);

        let ok = dir.path().join("ok");
        std::fs::write(&ok, vec![1u8; 40]).unwrap();
        assert_eq!(dest_resume_len(&ok, 100), 40);
        assert!(ok.exists());

        let oversize = dir.path().join("over");
        std::fs::write(&oversize, vec![1u8; 200]).unwrap();
        assert_eq!(dest_resume_len(&oversize, 100), 0);
        assert!(
            !oversize.exists(),
            "比云端对象还大的断点必须丢弃，禁止错位追加"
        );
    }

    #[test]
    fn persist_download_replaces_existing_dest_without_appending() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("live.db");
        let part = dir.path().join(".live.db.ds-dl.part");
        std::fs::write(&dest, b"OLD-CONTENT-SHOULD-GO").unwrap();
        std::fs::write(&part, b"NEW").unwrap();
        persist_download(&part, &dest).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"NEW");
        assert!(!part.exists());
    }

    #[test]
    fn content_keyed_part_path_isolates_versions() {
        let dest = std::path::Path::new("/tmp/workspace.db");
        let a = content_keyed_part_path(dest, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let b = content_keyed_part_path(dest, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        assert_ne!(a, b);
        assert!(a
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains("aaaaaaaaaaaaaaaa"));
        assert!(a
            .file_name()
            .unwrap()
            .to_string_lossy()
            .ends_with(".ds-dl.part"));
        assert_eq!(
            content_keyed_part_path(dest, "not-hex")
                .file_name()
                .unwrap(),
            std::ffi::OsStr::new(".workspace.db.unknown.ds-dl.part")
        );
    }

    #[test]
    fn cleanup_stale_parts_keeps_only_current_hash() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("asset.bin");
        let keep = content_keyed_part_path(&dest, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let stale = content_keyed_part_path(&dest, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        let unrelated = dir.path().join(".other.bin.cccccccc.ds-dl.part");
        std::fs::write(&keep, b"keep").unwrap();
        std::fs::write(&stale, b"stale").unwrap();
        std::fs::write(&unrelated, b"other").unwrap();
        cleanup_stale_parts(&dest, &keep);
        assert!(keep.exists());
        assert!(!stale.exists());
        assert!(unrelated.exists(), "不得误删其它文件的续传旁路");
    }
}
