//! [R07-tests] 自动同步（auto sync）— 等待 R07-autosync 落地的占位回归测试
//!
//! ## 现状（2026-08，Round 07 盘点）
//!
//! 自动同步**尚未落地**：
//! - `question_sync_service::SyncConfig` 暴露了 `auto_sync` / `sync_interval_secs`
//!   两个配置字段，i18n 文案（sync.json 的 `settings.autoSync` /
//!   `settings.syncInterval`）也已就绪；
//! - 但引擎侧没有任何调度器消费这两个字段——代码库中不存在按间隔触发
//!   `data_governance_sync_*` 或题库同步的后台任务。
//!
//! 本文件：
//! 1. 钉住"已存在的配置面"（serde 契约），防止 R07-autosync 落地时
//!    悄悄改字段名破坏已保存的用户配置；
//! 2. 用 `#[ignore]` 占位测试记录调度器落地后必须补上的行为断言。
//!    **等待 R07-autosync**：调度器合入后，请启用并充实该测试。

use deep_student_lib::question_sync_service::SyncConfig;

/// 钉住 auto_sync 配置面的 serde 契约：字段名与默认值。
/// R07-autosync 落地时若想改字段名/语义，必须先迁移已保存的配置。
#[test]
fn r07_autosync_config_surface_serde_contract() {
    // 默认值：自动同步默认关闭（首次启用必须是用户显式行为）
    let default_config = SyncConfig::default();
    assert!(
        !default_config.auto_sync,
        "auto_sync 默认必须为 false（不得默认开启后台上传）"
    );
    assert_eq!(
        default_config.sync_interval_secs, 0,
        "sync_interval_secs 默认值（Default derive）为 0"
    );

    // serde 字段名契约：前端设置页与持久化配置都以这些名字读写
    let json = serde_json::to_value(&default_config).unwrap();
    let object = json.as_object().expect("SyncConfig 应序列化为对象");
    assert!(
        object.contains_key("auto_sync"),
        "序列化必须包含 auto_sync 字段，实际: {object:?}"
    );
    assert!(
        object.contains_key("sync_interval_secs"),
        "序列化必须包含 sync_interval_secs 字段，实际: {object:?}"
    );

    // 已保存配置的往返（含开启状态）不得丢失字段
    let saved = serde_json::json!({
        "default_strategy": default_config.default_strategy,
        "auto_sync": true,
        "sync_interval_secs": 900,
        "sync_progress": true,
        "sync_notes": false,
    });
    let restored: SyncConfig = serde_json::from_value(saved).unwrap();
    assert!(restored.auto_sync, "auto_sync=true 必须能往返");
    assert_eq!(restored.sync_interval_secs, 900);
}

/// 【等待 R07-autosync】自动同步调度器落地后的行为断言占位。
///
/// 落地后本测试应启用（去掉 `#[ignore]`）并断言：
/// - `auto_sync=false` 时绝不触发任何后台同步；
/// - `auto_sync=true` 时按 `sync_interval_secs` 触发，且与手动同步共用
///   同一把全局操作锁（BACKUP_GLOBAL_LIMITER），不得并发踩踏；
/// - 触发的同步必须先过记录级上传加密一致性策略（R04-sync-e2ee），
///   错密码/明文降级设备的自动同步与手动同步同样 fail-closed；
/// - 应用退出 / 进入维护模式时调度器必须停止。
#[test]
#[ignore = "等待 R07-autosync：自动同步调度器尚未落地（auto_sync 字段无消费方），落地后启用本测试"]
fn r07_autosync_scheduler_behavior_pending() {
    unreachable!(
        "本测试被 #[ignore] 占位：R07-autosync 落地前不应被执行。\
         若你在 CI 看到此失败，说明有人移除了 ignore 却未实现断言。"
    );
}
