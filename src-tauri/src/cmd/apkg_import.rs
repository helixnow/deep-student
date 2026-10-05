//! APKG 本地导入命令。

use crate::apkg_importer_service::{
    ApkgImportResult, ApkgImporterService, APKG_ERROR_INVALID_INPUT, APKG_ERROR_IO,
    APKG_ERROR_NOT_FILE, APKG_ERROR_NOT_FOUND,
};
use crate::commands::AppState;
use crate::models::{AppError, AppErrorType};
use serde_json::json;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

type Result<T> = std::result::Result<T, AppError>;
const APKG_IMPORT_JOIN_ERROR_CODE: &str = "apkg_import_join_failed";

fn command_error(
    error_type: AppErrorType,
    message: impl Into<String>,
    error_code: &str,
) -> AppError {
    AppError::with_details(error_type, message, json!({ "errorCode": error_code }))
}

fn validate_apkg_path(path: &str) -> Result<PathBuf> {
    if path.trim().is_empty() {
        return Err(command_error(
            AppErrorType::Validation,
            "APKG 文件路径不能为空",
            APKG_ERROR_INVALID_INPUT,
        ));
    }

    let path = Path::new(path);
    let metadata = std::fs::metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            command_error(
                AppErrorType::NotFound,
                format!("APKG 文件不存在: {}", path.display()),
                APKG_ERROR_NOT_FOUND,
            )
        } else {
            command_error(
                AppErrorType::FileSystem,
                format!("无法读取 APKG 文件信息 ({}): {}", path.display(), error),
                APKG_ERROR_IO,
            )
        }
    })?;

    if !metadata.is_file() {
        return Err(command_error(
            AppErrorType::Validation,
            format!("APKG 路径必须指向文件: {}", path.display()),
            APKG_ERROR_NOT_FILE,
        ));
    }

    Ok(path.to_path_buf())
}

fn build_import_changed_payload(result: &ApkgImportResult) -> serde_json::Value {
    json!({
        "source": "user",
        "action": "import",
        "documentId": result.document_id,
        "entityIds": result.card_ids,
    })
}

fn emit_import_changed(app: &AppHandle, result: &ApkgImportResult) {
    if let Err(error) = app.emit("fsrs://changed", build_import_changed_payload(result)) {
        log::debug!(
            "[apkg_import] Failed to emit fsrs://changed after import: {}",
            error
        );
    }
}

/// 将本地 APKG 包解析并写入 Anki 卡片库。
/// 媒体文件解出到应用数据目录下的 `anki_media/`，卡片 images 指向落盘路径。
#[tauri::command]
pub async fn import_apkg_to_library(
    app: AppHandle,
    path: String,
    state: State<'_, AppState>,
) -> Result<ApkgImportResult> {
    let database = state.anki_database.clone();
    let media_dir = state
        .file_manager
        .get_writable_app_data_dir()
        .join("anki_media");

    let result = tokio::task::spawn_blocking(move || {
        let path = validate_apkg_path(&path)?;
        // 卡片库导入即入队：导入的卡直接进入应用内复习（Anki 进度沿用，见 anki_sched_to_fsrs）
        ApkgImporterService::new(database)
            .with_media_dir(media_dir)
            .with_review_enqueue()
            .import_path(&path, None)
    })
    .await
    .map_err(|error| {
        command_error(
            AppErrorType::Unknown,
            format!("APKG 导入任务执行失败: {error}"),
            APKG_IMPORT_JOIN_ERROR_CODE,
        )
    })??;

    emit_import_changed(&app, &result);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_error_code(error: &AppError, expected: &str) {
        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|details| details["errorCode"].as_str()),
            Some(expected)
        );
    }

    #[test]
    fn rejects_blank_path_as_structured_validation_error() {
        let error = validate_apkg_path("  \t\n").expect_err("blank path must fail");

        assert!(matches!(&error.error_type, AppErrorType::Validation));
        assert!(error.message.contains("不能为空"));
        assert_error_code(&error, APKG_ERROR_INVALID_INPUT);
    }

    #[test]
    fn rejects_missing_path_as_structured_not_found_error() {
        let temp = tempfile::tempdir().expect("temp dir");
        let missing = temp.path().join("missing.apkg");
        let error = validate_apkg_path(missing.to_str().expect("utf-8 temp path"))
            .expect_err("missing path must fail");

        assert!(matches!(&error.error_type, AppErrorType::NotFound));
        assert!(error.message.contains("missing.apkg"));
        assert_error_code(&error, APKG_ERROR_NOT_FOUND);
    }

    #[test]
    fn rejects_directory_as_structured_validation_error() {
        let temp = tempfile::tempdir().expect("temp dir");
        let error = validate_apkg_path(temp.path().to_str().expect("utf-8 temp path"))
            .expect_err("directory must fail");

        assert!(matches!(&error.error_type, AppErrorType::Validation));
        assert!(error.message.contains("必须指向文件"));
        assert_error_code(&error, APKG_ERROR_NOT_FILE);
    }

    #[test]
    fn accepts_existing_regular_file_without_rewriting_its_path() {
        let file = tempfile::NamedTempFile::new().expect("temp file");
        let original = file.path().to_str().expect("utf-8 temp path");

        assert_eq!(
            validate_apkg_path(original).expect("valid file"),
            file.path()
        );
    }

    #[test]
    fn import_changed_payload_uses_imported_anki_card_ids() {
        let result = ApkgImportResult {
            document_id: "document-1".to_string(),
            imported_cards: 2,
            imported_templates: 0,
            media_skipped: 3,
            media_imported: 1,
            media_report: Default::default(),
            warnings: vec![],
            card_ids: vec!["card-1".to_string(), "card-2".to_string()],
            review_enqueue: None,
        };

        assert_eq!(
            build_import_changed_payload(&result),
            json!({
                "source": "user",
                "action": "import",
                "documentId": "document-1",
                "entityIds": ["card-1", "card-2"],
            })
        );
        assert_eq!(
            serde_json::to_value(&result).expect("serialize command response"),
            json!({
                "documentId": "document-1",
                "importedCards": 2,
                "importedTemplates": 0,
                "mediaSkipped": 3,
                "mediaImported": 1,
            })
        );
    }

    #[test]
    fn import_result_with_warnings_serializes_them_for_frontend() {
        use crate::apkg_importer_service::{ApkgMediaReport, ApkgMediaSkip};

        let result = ApkgImportResult {
            document_id: "document-2".to_string(),
            imported_cards: 1,
            imported_templates: 1,
            media_skipped: 1,
            media_imported: 0,
            media_report: ApkgMediaReport {
                declared: 1,
                imported: 0,
                skipped: 1,
                skips: vec![ApkgMediaSkip {
                    reason: "entry_missing".to_string(),
                    count: 1,
                    filenames: vec!["a.png".to_string()],
                }],
                media_dir: Some("/tmp/anki_media".to_string()),
            },
            warnings: vec!["媒体清单声明的条目在包内缺失，已跳过: 0 (a.png)".to_string()],
            card_ids: vec!["card-1".to_string()],
            review_enqueue: None,
        };
        let value = serde_json::to_value(&result).expect("serialize command response");
        assert_eq!(value["importedTemplates"], 1);
        assert!(value["warnings"][0]
            .as_str()
            .is_some_and(|warning| warning.contains("a.png")));
        // 结构化媒体报告透出给前端：reason/count/filenames + 可解析的 mediaDir
        assert_eq!(value["mediaReport"]["skipped"], 1);
        assert_eq!(value["mediaReport"]["skips"][0]["reason"], "entry_missing");
        assert_eq!(value["mediaReport"]["skips"][0]["count"], 1);
        assert_eq!(value["mediaReport"]["skips"][0]["filenames"][0], "a.png");
        assert_eq!(value["mediaReport"]["mediaDir"], "/tmp/anki_media");
    }
}

/// 单个卡片媒体文件的读取上限（字节）。
const ANKI_MEDIA_MAX_BYTES: u64 = 25 * 1024 * 1024;

fn anki_media_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "mp3" => "audio/mpeg",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "wav" => "audio/wav",
        "m4a" | "aac" => "audio/mp4",
        "flac" => "audio/flac",
        "webm" => "audio/webm",
        "mp4" => "video/mp4",
        _ => return None,
    })
}

/// `read_anki_media` 的同步实现：路径必须解析（含软链接）到 `media_root` 之内。
fn read_anki_media_in(media_root: &Path, path: &str) -> Result<String> {
    let not_allowed = || {
        command_error(
            AppErrorType::Validation,
            "只能读取已导入的卡片媒体",
            APKG_ERROR_INVALID_INPUT,
        )
    };
    let root = std::fs::canonicalize(media_root).map_err(|_| not_allowed())?;
    let target = std::fs::canonicalize(Path::new(path.trim())).map_err(|_| not_allowed())?;
    if !target.starts_with(&root) {
        return Err(not_allowed());
    }
    let mime = anki_media_mime(&target).ok_or_else(not_allowed)?;
    let metadata = std::fs::metadata(&target).map_err(|_| not_allowed())?;
    if !metadata.is_file() || metadata.len() > ANKI_MEDIA_MAX_BYTES {
        return Err(not_allowed());
    }
    let bytes = std::fs::read(&target).map_err(|error| {
        command_error(
            AppErrorType::FileSystem,
            format!("读取卡片媒体失败: {error}"),
            APKG_ERROR_IO,
        )
    })?;
    use base64::Engine as _;
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// 读取 APKG 导入落盘的卡片媒体为 data URL，供沙箱卡面（CSP 只放行 data:）显示图片与播放音频。
///
/// 只允许读取应用数据目录下的 `anki_media`，且限制类型与大小；不在范围内一律拒绝。
#[tauri::command]
pub async fn read_anki_media(path: String, state: State<'_, AppState>) -> Result<String> {
    let media_root = state
        .file_manager
        .get_writable_app_data_dir()
        .join("anki_media");
    tokio::task::spawn_blocking(move || read_anki_media_in(&media_root, &path))
        .await
        .map_err(|error| {
            command_error(
                AppErrorType::Unknown,
                format!("读取卡片媒体任务失败: {error}"),
                APKG_IMPORT_JOIN_ERROR_CODE,
            )
        })?
}

#[cfg(test)]
mod anki_media_tests {
    use super::*;

    fn media_root() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("anki_media");
        std::fs::create_dir_all(&root).unwrap();
        (dir, root)
    }

    #[test]
    fn reads_media_inside_root_as_data_url() {
        let (_dir, root) = media_root();
        let file = root.join("deck").join("cat.PNG");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, b"png").unwrap();

        let url = read_anki_media_in(&root, &format!(" {} ", file.display())).unwrap();
        assert_eq!(url, "data:image/png;base64,cG5n");
    }

    #[test]
    fn rejects_paths_that_resolve_outside_root() {
        let (dir, root) = media_root();
        let outside = dir.path().join("secret.png");
        std::fs::write(&outside, b"x").unwrap();

        let traversal = root.join("..").join("secret.png");
        assert!(read_anki_media_in(&root, &traversal.to_string_lossy()).is_err());
        assert!(read_anki_media_in(&root, &outside.to_string_lossy()).is_err());

        #[cfg(unix)]
        {
            let link = root.join("link.png");
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            assert!(read_anki_media_in(&root, &link.to_string_lossy()).is_err());
        }
    }

    #[test]
    fn rejects_unknown_types_directories_missing_and_oversized_files() {
        let (_dir, root) = media_root();
        let text = root.join("notes.txt");
        std::fs::write(&text, b"x").unwrap();
        assert!(read_anki_media_in(&root, &text.to_string_lossy()).is_err());

        let dir_with_ext = root.join("folder.png");
        std::fs::create_dir_all(&dir_with_ext).unwrap();
        assert!(read_anki_media_in(&root, &dir_with_ext.to_string_lossy()).is_err());

        let missing = root.join("missing.png");
        assert!(read_anki_media_in(&root, &missing.to_string_lossy()).is_err());

        let big = root.join("big.mp3");
        let file = std::fs::File::create(&big).unwrap();
        file.set_len(ANKI_MEDIA_MAX_BYTES + 1).unwrap();
        let error = read_anki_media_in(&root, &big.to_string_lossy()).unwrap_err();
        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|details| details["errorCode"].as_str()),
            Some(APKG_ERROR_INVALID_INPUT)
        );
    }
}
