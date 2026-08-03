//! C1：跨语言一致性行为测试（真实对象）
//!
//! - Browser settings 双闸：父闸缺失默认开；显式 false 关；子闸 opt-in
//! - BackupJobManager：incremental set_params 拒绝且英文文案对齐 data_governance

use deep_student_lib::backup_job_manager::{
    BackupJobKind, BackupJobManager, BackupJobParams, BackupJobPhase, BackupJobStatus,
    INCREMENTAL_BACKUP_DISABLED_MESSAGE,
};
use deep_student_lib::browser::assert_settings_gates_open;

#[test]
fn workbench_mode_missing_defaults_open_with_browser_child_on() {
    // assert_gates_open 的 settings 半边：键缺失 → 父闸开（配合子闸显式 true）
    assert!(assert_settings_gates_open(None, Some("true")).is_ok());
    assert!(assert_settings_gates_open(Some(""), Some("true")).is_ok());
    assert!(assert_settings_gates_open(Some("true"), Some("true")).is_ok());
}

#[test]
fn workbench_mode_explicit_false_closes_even_when_browser_child_on() {
    let err = assert_settings_gates_open(Some("false"), Some("true")).unwrap_err();
    assert_eq!(err, "browser disabled: desktop.workbenchMode is off");
    assert!(assert_settings_gates_open(Some("  false  "), Some("true")).is_err());
}

#[test]
fn browser_child_gate_remains_opt_in_when_parent_defaults_open() {
    let err = assert_settings_gates_open(None, None).unwrap_err();
    assert_eq!(
        err,
        "browser disabled: desktop.workbenchBrowserEnabled is off"
    );
    assert!(assert_settings_gates_open(None, Some("false")).is_err());
}

#[test]
fn incremental_backup_disabled_message_matches_data_governance_english() {
    assert_eq!(
        INCREMENTAL_BACKUP_DISABLED_MESSAGE,
        "Incremental backup has been removed; use full backup or cloud sync"
    );
    assert!(INCREMENTAL_BACKUP_DISABLED_MESSAGE.is_ascii());
    assert_eq!(
        INCREMENTAL_BACKUP_DISABLED_MESSAGE,
        deep_student_lib::data_governance::backup::INCREMENTAL_BACKUP_REMOVED_MESSAGE
    );
}

#[test]
fn set_params_rejects_incremental_job_with_english_removed_message() {
    // new_for_tests：真实 JobState/set_params/fail 路径，无 macOS EventLoop 主线程约束
    let manager = BackupJobManager::new_for_tests();
    let ctx = manager.create_job(BackupJobKind::Export);

    ctx.set_params(BackupJobParams {
        backup_type: Some("incremental".into()),
        ..Default::default()
    });

    let summary = manager
        .get_job(&ctx.job_id)
        .expect("job remains queryable after rejection");
    assert_eq!(summary.status, BackupJobStatus::Failed);
    assert_eq!(summary.phase, BackupJobPhase::Failed);

    let message = summary.message.as_deref().expect("failed job message");
    assert_eq!(message, INCREMENTAL_BACKUP_DISABLED_MESSAGE);
    assert!(
        message.contains("Incremental backup has been removed"),
        "got: {message}"
    );
    assert!(
        message.contains("full backup") || message.contains("cloud sync"),
        "got: {message}"
    );

    let result_error = summary
        .result
        .as_ref()
        .and_then(|r| r.error.as_deref())
        .expect("result.error");
    assert_eq!(result_error, INCREMENTAL_BACKUP_DISABLED_MESSAGE);
    assert!(ctx.is_cancelled(), "cancel flag must be set on rejection");
}
