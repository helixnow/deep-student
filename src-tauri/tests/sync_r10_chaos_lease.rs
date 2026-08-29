//! [R10-chaos] 槽位/租约损坏混沌：A/B 数据槽的恢复切槽租约（restore cutover
//! lease）在 state.json 被损坏/篡改时必须 fail-closed，绝不在不确定的数据槽
//! 上启动或提前解除维护租约。
//!
//! 与既有覆盖的差异：`sync_android_device_switch` 锁定的是"租约目标槽被清空
//! → pending 校验失败 → 拒启"；本文件锁定的是 **state.json 本身的损坏/篡改**：
//!
//! 1. **租约与活动槽错位拒启**：state.json 里 pending 切换标志丢失（部分写入/
//!    手工修改），但未提交的租约仍指向另一个槽 → 启动必须拒绝，且租约原样
//!    保留供修复；
//! 2. **租约 backup_id 被篡改**：激活提交与租约解除都必须拒绝（防止错误的
//!    恢复链路把维护租约洗掉），系统停留在可修复的维护态，重启仍可进入
//!    活动槽（不砖机）。

use deep_student_lib::data_space::{DataSpaceManager, Slot};
use tempfile::TempDir;

const BACKUP_ID: &str = "backup-r10-chaos";

fn seed_slot(dir: &std::path::Path, marker: &str) {
    std::fs::create_dir_all(dir).expect("create slot dir");
    std::fs::write(dir.join("chat_v2.db"), marker).expect("seed slot marker");
}

// ============================================================================
// 1. 租约指向未激活槽（pending 标志丢失）→ 拒启且租约保留
// ============================================================================

#[test]
fn r10_chaos_lease_pointing_at_inactive_slot_refuses_boot_and_keeps_lease() {
    let guard = TempDir::new().expect("temp base dir");
    let base = guard.path().join("appdata");
    let slots = base.join("slots");
    std::fs::create_dir_all(&slots).expect("create slots dir");
    seed_slot(&slots.join("slotA"), "slot-a-data");
    seed_slot(&slots.join("slotB"), "slot-b-data");

    // 损坏现场：pending 切换标志丢失（部分写入/回滚），
    // 但未提交的恢复租约仍指向 slotB —— 数据槽状态不确定。
    std::fs::write(
        slots.join("state.json"),
        serde_json::json!({
            "active": "slotA",
            "pending": null,
            "restore_cutover_pending": {
                "target_slot": "slotB",
                "backup_id": BACKUP_ID,
                "created_at": "2026-07-10T12:00:00Z",
                "activation_committed": false
            }
        })
        .to_string(),
    )
    .expect("craft corrupted state.json");

    let dsm = DataSpaceManager::new(base);
    let boot_error = dsm
        .initialize_on_start()
        .expect_err("租约目标未激活时必须拒绝启动")
        .to_string();
    assert!(
        boot_error.contains("租约") || boot_error.contains("拒绝"),
        "拒启错误应说明恢复租约目标未激活: {boot_error}"
    );

    // 租约必须原样保留（供修复/重试），拒启不得顺手清掉证据
    let lease = dsm
        .restore_cutover_pending()
        .expect("read lease")
        .expect("拒启后租约必须保留");
    assert_eq!(lease.target_slot, "slotB");
    assert_eq!(lease.backup_id, BACKUP_ID);
    assert!(!lease.activation_committed);

    // 重复启动依旧拒绝（拒启是稳定态，不是一次性的）
    dsm.initialize_on_start()
        .expect_err("损坏状态未修复前每次启动都必须拒绝");
}

// ============================================================================
// 2. 租约 backup_id 被篡改 → 激活提交与租约解除均拒绝，系统留在维护态
// ============================================================================

#[test]
fn r10_chaos_tampered_lease_backup_id_blocks_commit_and_release() {
    let guard = TempDir::new().expect("temp base dir");
    let base = guard.path().join("appdata");
    std::fs::create_dir_all(&base).expect("create base dir");

    // 正常恢复流程走到"重启进入目标槽"这一步
    let dsm = DataSpaceManager::new(base.clone());
    dsm.ensure_layout().expect("初始化槽布局");
    dsm.initialize_on_start().expect("首次启动");
    seed_slot(&dsm.slot_dir(Slot::A), "old-data");
    seed_slot(&dsm.slot_dir(Slot::B), "restored-data");
    dsm.mark_restore_cutover_pending(Slot::B, BACKUP_ID)
        .expect("登记切槽租约");

    let restarted = DataSpaceManager::new(base.clone());
    restarted
        .initialize_on_start()
        .expect("租约目标有数据时重启应切换到 slotB 并允许启动");
    assert_eq!(restarted.active_slot(), Slot::B, "重启后活动槽应为 slotB");

    // 混沌注入：state.json 里的租约 backup_id 被篡改（位翻转/恶意改写）
    let state_path = base.join("slots").join("state.json");
    let original = std::fs::read_to_string(&state_path).expect("read state.json");
    assert!(original.contains(BACKUP_ID), "前置：租约应含原 backup_id");
    std::fs::write(&state_path, original.replace(BACKUP_ID, "backup-tampered"))
        .expect("tamper backup_id");

    // 激活提交必须拒绝：租约与本次恢复链路对不上
    let commit_error = restarted
        .mark_restore_activation_committed(&restarted.slot_dir(Slot::B), BACKUP_ID)
        .expect_err("篡改后的租约不得被原恢复链路提交")
        .to_string();
    assert!(
        commit_error.contains("不匹配"),
        "提交拒绝应说明租约不匹配: {commit_error}"
    );

    // 未提交激活时解除租约必须拒绝（维护租约不能被洗掉）
    let release_error = restarted
        .complete_restore_cutover(&restarted.slot_dir(Slot::B))
        .expect_err("激活未提交时不得解除维护租约")
        .to_string();
    assert!(
        release_error.contains("拒绝"),
        "解除拒绝应说明原因: {release_error}"
    );

    // 租约仍在（被篡改的现场保留，可诊断）
    let lease = restarted
        .restore_cutover_pending()
        .expect("read lease")
        .expect("租约必须仍然存在");
    assert_eq!(lease.backup_id, "backup-tampered");
    assert!(!lease.activation_committed);

    // 系统停留在可修复的维护态：活动槽与租约目标一致，重启不砖机
    let rebooted = DataSpaceManager::new(base);
    rebooted
        .initialize_on_start()
        .expect("活动槽与租约目标一致时应允许启动（维护态）");
    assert_eq!(rebooted.active_slot(), Slot::B);
}
