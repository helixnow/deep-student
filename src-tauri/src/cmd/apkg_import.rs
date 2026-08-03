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
        ApkgImporterService::new(database)
            .with_media_dir(media_dir)
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
            warnings: vec![],
            card_ids: vec!["card-1".to_string(), "card-2".to_string()],
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
        let result = ApkgImportResult {
            document_id: "document-2".to_string(),
            imported_cards: 1,
            imported_templates: 1,
            media_skipped: 1,
            media_imported: 0,
            warnings: vec!["媒体清单声明的条目在包内缺失，已跳过: 0 (a.png)".to_string()],
            card_ids: vec!["card-1".to_string()],
        };
        let value = serde_json::to_value(&result).expect("serialize command response");
        assert_eq!(value["importedTemplates"], 1);
        assert!(value["warnings"][0]
            .as_str()
            .is_some_and(|warning| warning.contains("a.png")));
    }
}
