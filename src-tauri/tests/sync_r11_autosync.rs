//! [R11-autosync2] 自动同步定时档位 + fail-close + 与手动同步互斥
//!
//! 自动同步的调度器在前端（`src/stores/syncStatusStore.ts`），本文件覆盖
//! 它依赖的后端行为与跨层契约：
//!
//! 1. **与手动同步互斥（后端半边，行为测试）**：自动/手动同步最终都走
//!    `data_governance_run_sync*`，靠 `BACKUP_GLOBAL_LIMITER` 全局信号量 +
//!    `DataGovernanceOperationGuard::try_acquire` 立即失败互斥。本文件从
//!    公开 API 钉死：锁被占时 try_acquire 立即返回含稳定 busy 文案的错误、
//!    释放后可再次获取——前端把该文案分类为 `skipped_busy`（静默跳过，
//!    不计失败退避），一旦文案改动而前端分类器没跟上，跨层契约测试失败。
//! 2. **fail-close 分类的跨层契约（源码锁）**：前端静默跳过依赖三组引擎
//!    稳定文案/错误码——busy（两处）、未配置加密密码、租约被占
//!    （`E_SYNC_LEASE_HELD`，与 R11-lease 在 FIX-QUEUE 约定的稳定码）。
//!    后端改文案或前端删标记都会在此失败，逼出两侧同步更新。
//! 3. **档位与默认关不变（源码锁）**：15min/1h/6h 三档常量、默认档位
//!    15m、`enabled` 默认 false 均钉死在前端 store 源码上。
//! 4. **locale 契约**：zh/en `sync.json` 的 `autoSync` 子树键形完全一致，
//!    且 outcome 键覆盖全部五种结果值。
//!
//! 除第 1 组外全部用例只读源码/locale，不触网、不建库。

use deep_student_lib::backup_common::{
    current_data_governance_operation, DataGovernanceOperationGuard, DataGovernanceOperationKind,
    BACKUP_GLOBAL_LIMITER,
};
use std::path::PathBuf;

/// 以 `src-tauri/`（CARGO_MANIFEST_DIR）为基准读仓库内文件。
fn read_repo_file(rel: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("读取 {} 失败（文件被移动/删除？）: {}", path.display(), e))
}

fn frontend_store_source() -> String {
    read_repo_file("../src/stores/syncStatusStore.ts")
}

// ============================================================================
// 1. 与手动同步互斥（后端半边，行为测试）
// ============================================================================

/// 全局互斥锁的完整生命周期放在**单个**测试里，避免同文件用例并行争抢
/// 进程级信号量导致相互干扰。
#[test]
fn r11_autosync_manual_mutex_try_acquire_fails_closed_and_recovers() {
    // 场景 A：模拟手动同步在跑（直接持有全局信号量 permit，与
    // data_governance_run_sync* 的 try_acquire_owned 同一把锁）。
    let manual_permit = BACKUP_GLOBAL_LIMITER
        .clone()
        .try_acquire_owned()
        .expect("测试开始时全局锁应空闲");

    // 自动同步这时后到：guard try_acquire 必须立即失败，不排队等待
    let busy = DataGovernanceOperationGuard::try_acquire(DataGovernanceOperationKind::Sync, None);
    let busy_message = match busy {
        Ok(_) => panic!("手动同步持锁期间自动同步不得取得全局操作租约"),
        Err(e) => e.to_string(),
    };
    assert!(
        busy_message.contains("已有数据治理操作正在运行"),
        "busy 拒绝必须含前端 skipped_busy 分类依赖的稳定文案，实际: {busy_message}"
    );

    drop(manual_permit);

    // 场景 B：手动同步结束后自动同步可正常获取；持有期间账本可见 holder
    let auto_guard = DataGovernanceOperationGuard::try_acquire(
        DataGovernanceOperationKind::Sync,
        Some("r11-autosync-test".to_string()),
    )
    .expect("锁释放后自动同步应能立即取得租约");
    let snapshot = current_data_governance_operation().expect("持锁期间账本应有 holder 快照");
    assert_eq!(snapshot.operation_id, "r11-autosync-test");
    assert_eq!(snapshot.kind, DataGovernanceOperationKind::Sync);

    // 场景 C：自动同步持锁期间，手动同步同样立即失败并能看到 holder 信息
    let second = DataGovernanceOperationGuard::try_acquire(DataGovernanceOperationKind::Sync, None);
    let second_message = match second {
        Ok(_) => panic!("自动同步持锁期间手动同步不得取得全局操作租约"),
        Err(e) => e.to_string(),
    };
    assert!(
        second_message.contains("已有数据治理操作正在运行"),
        "反向互斥同样必须给出稳定 busy 文案，实际: {second_message}"
    );
    assert!(
        second_message.contains("r11-autosync-test"),
        "busy 错误应带 holder 的 operation_id 便于排查，实际: {second_message}"
    );

    // 场景 D：RAII 释放后锁与账本都干净
    drop(auto_guard);
    assert!(
        current_data_governance_operation().is_none(),
        "guard drop 后账本必须清空"
    );
    let recovered = BACKUP_GLOBAL_LIMITER.clone().try_acquire_owned();
    assert!(recovered.is_ok(), "guard drop 后全局信号量必须可再次获取");
}

/// 源码锁：同步命令必须用 try_acquire（立即失败）而非 acquire（排队），
/// 且 busy 拒绝文案与前端 `AUTO_SYNC_BUSY_MARKERS` 的第一个标记一致。
#[test]
fn r11_autosync_run_sync_commands_use_immediate_try_acquire() {
    let commands_sync = read_repo_file("src/data_governance/commands_sync.rs");
    assert!(
        commands_sync.contains("try_acquire_owned"),
        "同步命令应保持 try_acquire 立即失败语义（重复触发不排队）"
    );
    assert!(
        commands_sync.contains("另一个数据治理任务（同步/备份/恢复）正在进行中"),
        "commands_sync.rs 的 busy 文案被改动——前端 AUTO_SYNC_BUSY_MARKERS 分类依赖它，\
         请同步更新 src/stores/syncStatusStore.ts 与本测试"
    );

    let store = frontend_store_source();
    assert!(
        store.contains("'另一个数据治理任务'"),
        "前端 AUTO_SYNC_BUSY_MARKERS 必须包含 commands_sync busy 文案片段"
    );
    assert!(
        store.contains("'已有数据治理操作正在运行'"),
        "前端 AUTO_SYNC_BUSY_MARKERS 必须包含 OperationGuard busy 文案片段"
    );
}

// ============================================================================
// 2. fail-close 分类的跨层契约（源码锁）
// ============================================================================

/// 未配置云端/无密码/租约被占 → 静默跳过并记状态：三组标记两侧对齐。
#[test]
fn r11_autosync_failclose_markers_stay_in_sync_across_layers() {
    let store = frontend_store_source();

    // 租约被占：与 R11-lease 在 FIX-QUEUE 约定的稳定错误码。
    // R11-lease 落地时其「租约被占」错误文案必须包含该 token，
    // 否则自动同步会把租约冲突误计为失败进入退避。
    assert!(
        store.contains("'E_SYNC_LEASE_HELD'"),
        "前端必须保留稳定租约错误码 E_SYNC_LEASE_HELD（FIX-QUEUE 契约）"
    );
    assert!(
        store.contains("skipped_lease_held"),
        "租约被占必须是独立的 skipped_lease_held 结果（不与 busy/unconfigured 混淆）"
    );

    // 无密码（云端要求 E2EE 但本机未配置加密密码）：引擎稳定文案
    let sync_mod = read_repo_file("src/data_governance/sync/mod.rs");
    assert!(
        sync_mod.contains("未配置加密密码"),
        "引擎「未配置加密密码」文案被改动——前端 AUTO_SYNC_UNCONFIGURED_MARKERS \
         分类依赖它，请同步更新 src/stores/syncStatusStore.ts 与本测试"
    );
    assert!(
        store.contains("'E_SYNC_E2EE_PASSWORD_REQUIRED'"),
        "前端 AUTO_SYNC_UNCONFIGURED_MARKERS 必须包含稳定 code E_SYNC_E2EE_PASSWORD_REQUIRED"
    );
    assert!(
        store.contains("'未配置加密密码'"),
        "前端 AUTO_SYNC_UNCONFIGURED_MARKERS 必须包含引擎无密码文案片段"
    );

    // fail-close 底线：未配置/半配置在任何网络调用前直接跳过
    assert!(
        store.contains("skipped_unconfigured"),
        "未配置云端必须归为 skipped_unconfigured 静默跳过"
    );
    // 静默：自动同步单轮实现不得弹通知打扰（无论成功失败都只记状态）
    assert!(
        !store.contains("showGlobalNotification"),
        "syncStatusStore 的自动同步路径不得调用全局通知——失败/跳过只记状态"
    );
}

// ============================================================================
// 3. 档位与默认关不变（源码锁）
// ============================================================================

#[test]
fn r11_autosync_interval_tiers_and_default_off_are_pinned() {
    let store = frontend_store_source();

    // 三档常量（15min / 1h / 6h）
    assert!(store.contains("'15m': 15 * 60_000"), "15 分钟档常量被改动");
    assert!(store.contains("'1h': 60 * 60_000"), "1 小时档常量被改动");
    assert!(
        store.contains("'6h': 6 * 60 * 60_000"),
        "6 小时档常量被改动"
    );
    // 默认档位 15m（与 R07 固定间隔行为一致），默认开关关闭不变
    assert!(
        store.contains("AUTO_SYNC_DEFAULT_INTERVAL_PRESET: AutoSyncIntervalPreset = '15m'"),
        "默认档位必须保持 15m"
    );
    assert!(
        store.contains("enabled: false"),
        "自动同步默认必须关闭（默认关不变是本轮硬约束）"
    );

    // 持久化面：enabled + 档位 + 上次结果/时间（重启后 UI 仍可见状态）
    for field in [
        "enabled: state.enabled",
        "intervalPreset: state.intervalPreset",
        "lastOutcome: state.lastOutcome",
        "lastRunAtMs: state.lastRunAtMs",
    ] {
        assert!(store.contains(field), "持久化 partialize 缺少字段: {field}");
    }

    // 长档位下失败退避封顶必须取 max(maxBackoffMs, intervalMs)，
    // 否则 6h 档失败后反而比常规轮询更频繁地重试
    assert!(
        store.contains("Math.max(maxBackoffMs, intervalMs)"),
        "退避封顶必须不低于档位间隔"
    );
}

/// UI 接线源码锁：SyncSettingsSection 必须暴露档位选择与上次结果展示。
#[test]
fn r11_autosync_settings_ui_exposes_tiers_and_last_run_status() {
    let ui = read_repo_file("../src/features/settings/components/SyncSettingsSection.tsx");
    assert!(
        ui.contains("setIntervalPreset"),
        "SyncSettingsSection 必须接线档位切换"
    );
    for tier in ["15m", "1h", "6h"] {
        assert!(
            ui.contains(&format!("t('sync:autoSync.interval.{tier}')")),
            "档位选项缺少 {tier}"
        );
    }
    assert!(
        ui.contains("t('sync:autoSync.lastRun')"),
        "必须展示上次自动同步时间"
    );
    assert!(
        ui.contains("autoSyncOutcomeLabels[autoSyncLastOutcome]"),
        "必须展示上次自动同步结果的人话文案"
    );
}

// ============================================================================
// 4. locale 契约（zh/en）
// ============================================================================

fn collect_keys(value: &serde_json::Value, prefix: &str, out: &mut Vec<String>) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                let path = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                collect_keys(child, &path, out);
            }
        }
        _ => out.push(prefix.to_string()),
    }
}

#[test]
fn r11_autosync_locale_zh_en_autosync_subtrees_are_aligned() {
    let zh: serde_json::Value =
        serde_json::from_str(&read_repo_file("../src/locales/zh-CN/sync.json"))
            .expect("zh-CN sync.json 必须是合法 JSON");
    let en: serde_json::Value =
        serde_json::from_str(&read_repo_file("../src/locales/en-US/sync.json"))
            .expect("en-US sync.json 必须是合法 JSON");

    let zh_auto = zh
        .get("autoSync")
        .expect("zh-CN sync.json 缺少 autoSync 子树");
    let en_auto = en
        .get("autoSync")
        .expect("en-US sync.json 缺少 autoSync 子树");

    let mut zh_keys = Vec::new();
    let mut en_keys = Vec::new();
    collect_keys(zh_auto, "", &mut zh_keys);
    collect_keys(en_auto, "", &mut en_keys);
    zh_keys.sort();
    en_keys.sort();
    assert_eq!(zh_keys, en_keys, "zh/en autoSync 键形必须完全一致");

    // outcome 键覆盖全部五种结果 + 档位/状态键存在
    for key in [
        "intervalLabel",
        "interval.15m",
        "interval.1h",
        "interval.6h",
        "lastRun",
        "neverRan",
        "outcome.success",
        "outcome.failure",
        "outcome.skippedUnconfigured",
        "outcome.skippedBusy",
        "outcome.skippedLeaseHeld",
        "consecutiveFailures",
    ] {
        assert!(
            zh_keys.iter().any(|k| k == key),
            "autoSync locale 缺少必备键: {key}"
        );
    }
}
