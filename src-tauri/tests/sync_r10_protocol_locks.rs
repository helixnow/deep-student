//! [R10-protocol] FINDINGS-R01/03/05/07 核销后**仍开项**的锁定测试。
//!
//! 与既有回归测试不同，本文件的职责是把「诚实承认仍开」的缺口钉在测试里，
//! 防止两类漂移：
//!
//! 1. 缺口在无人知晓的情况下被顺手改掉（好事，但必须同步更新
//!    `docs/dev/cloud-sync-sota-b343/PROTOCOL-R10.md` 与 FIX-QUEUE 登记，
//!    否则台账失真）——源码锁定测会在改动时失败，逼出台账回写；
//! 2. 缺口周边**已有**的防线（argon2 结构校验、事务内 generation 重验、
//!    运维解锁指南）被后续重构悄悄削弱。
//!
//! 对应仍开项（详见 PROTOCOL-R10.md「仍开清单」）：
//!
//! - **P2-2（FINDINGS-R07）/ R01-P2**：校验子与 DSBK 头的 Argon2 参数来自
//!   不受信任云端——**已由 R10-verifier 关闭**（`derive_key` 应用级上限，
//!   超限在派生前 fail-closed）；本文件 3 号用例已按台账要求改写为断言
//!   钳制边界（详见 `sync_r10_verifier.rs` 的完整验收测试）；
//! - **P2-3（FINDINGS-R07）**：resolve 快速路径的业务行快照读在事务外，
//!   窗口内纯本地编辑可被按旧快照误标 resolved；
//! - **P2-1（FINDINGS-R07，部分）**：v1 旧标记升级无条件信任第一台带密码
//!   上传的设备——代码信任边界未变，缓解手段是 R09-restore-ops 的运维解锁
//!   指南，本文件锁定该指南不被删除；
//! - **R01-P2（部分）**：资产文件名净化（R09-names）未处理路径/段长度，
//!   Windows MAX_PATH 超长路径仍可能无法物化。
//!
//! 全部用例只读源码/文档或调用纯函数，不触网、不建库，可与其他测试并行。

use std::path::PathBuf;

use deep_student_lib::crypto::backup_crypto::{
    check_password_verifier, PasswordVerifier, PASSWORD_VERIFIER_KDF_ARGON2ID,
};
use deep_student_lib::data_governance::sync::asset_filenames;

/// `src-tauri/`（CARGO_MANIFEST_DIR）为基准读仓库内文件。
fn read_repo_file(rel: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("读取 {} 失败（文件被移动/删除？）: {}", path.display(), e))
}

fn verifier_with_params(m_cost: u32, t_cost: u32, p_cost: u32) -> PasswordVerifier {
    PasswordVerifier {
        kdf: PASSWORD_VERIFIER_KDF_ARGON2ID.to_string(),
        m_cost,
        t_cost,
        p_cost,
        // 16 字节 salt / 32 字节摘要，结构合法；摘要值任意（测试只关心
        // 校验路径是否执行，不关心密码是否匹配）。
        salt: "00112233445566778899aabbccddeeff".to_string(),
        digest: "00".repeat(32),
    }
}

// ============================================================================
// P2-2：校验子 KDF 参数无上限钳制
// ============================================================================

/// 已有防线锁定：**结构非法**的 Argon2 参数（零值）经 argon2 crate 的
/// `Params::new` 校验失败，`check_password_verifier` 返回 `Err`（无法校验，
/// 调用方 fail-closed），而不是 `Ok(false)`（密码不一致）——两者语义不同，
/// 混淆会把「云端标记损坏」误报成「密码错误」。
#[test]
fn p2_2_structurally_invalid_kdf_params_fail_closed() {
    for (m, t, p, label) in [
        (0u32, 3u32, 4u32, "m_cost=0"),
        (65536, 0, 4, "t_cost=0"),
        (65536, 3, 0, "p_cost=0"),
    ] {
        let verifier = verifier_with_params(m, t, p);
        assert!(
            check_password_verifier("any-password", &verifier).is_err(),
            "{label} 结构非法，必须 Err（fail-closed）而非 Ok"
        );
    }
}

/// 行为锁定：**上限内**的标记 KDF 参数被原样采用参与复算，而不是钳制/回退到
/// 本机默认值。用一个非默认但 CI 可承受的 m_cost（128 MiB，默认为 64 MiB）
/// 驱动复算路径：返回 `Ok(false)`（摘要不匹配）即证明 KDF 真的按标记参数跑过。
///
/// [R10-verifier 回写] P2-2 的上限钳制已落地（超限 fail-closed，见下一用例），
/// 128 MiB 低于上限（1 GiB），本用例语义不变、继续锁定「合法历史参数必须照常
/// 执行」这半边。
#[test]
fn p2_2_marker_kdf_params_are_honored_not_clamped_to_default() {
    let verifier = verifier_with_params(131072, 1, 1);
    let result = check_password_verifier("any-password", &verifier)
        .expect("128 MiB 为结构合法参数，校验路径应可执行");
    assert!(
        !result,
        "随机摘要不可能与任何密码匹配；Ok(true) 说明复算被跳过或被篡改"
    );
}

/// [R10-verifier 回写] P2-2 已关闭：`derive_key` 对 `m_cost/t_cost/p_cost` 施加
/// 应用级上限（`KDF_MAX_*`），校验子与 DSBK 解密头两条路径共用同一入口，超限
/// 在派生开始前 `Err`（fail-closed）。本用例按原 3 号用例的文档要求改写为
/// **断言钳制边界**：
/// - 超限参数必须 `Err`（无法校验），不得与 `Ok(false)`（密码不一致）混淆；
/// - 上限必须始终覆盖自家默认写入面（收紧上限会拒收自家旧备份，视为回归）。
///
/// 完整验收测试（亚秒返回、DSBK 头同拒、上传零写入）见 `sync_r10_verifier.rs`。
#[test]
fn p2_2_kdf_cost_upper_bound_now_enforced() {
    use deep_student_lib::crypto::backup_crypto::{
        create_password_verifier, KDF_MAX_M_COST_KIB, KDF_MAX_P_COST, KDF_MAX_T_COST,
    };

    // 超限 fail-closed（Err，而非 Ok(false)）
    for (m, t, p, label) in [
        (KDF_MAX_M_COST_KIB + 1, 1u32, 1u32, "m_cost 超限"),
        (u32::MAX, 1, 1, "m_cost 极大"),
        (8, KDF_MAX_T_COST + 1, 1, "t_cost 超限"),
        (8, 1, KDF_MAX_P_COST + 1, "p_cost 超限"),
    ] {
        let verifier = verifier_with_params(m, t, p);
        assert!(
            check_password_verifier("any-password", &verifier).is_err(),
            "{label} 必须 Err（fail-closed）而非 Ok"
        );
    }

    // 上限覆盖默认写入面（默认参数校验子照常工作）
    let default = create_password_verifier("pw").expect("默认参数必须可生成校验子");
    assert!(default.m_cost <= KDF_MAX_M_COST_KIB, "上限不得低于默认 m_cost");
    assert!(default.t_cost <= KDF_MAX_T_COST, "上限不得低于默认 t_cost");
    assert!(default.p_cost <= KDF_MAX_P_COST, "上限不得低于默认 p_cost");
    assert!(check_password_verifier("pw", &default).unwrap());
}

// ============================================================================
// P2-3：resolve 快速路径业务行快照读在事务外
// ============================================================================

/// 源码锁定（诚实仍开）：`data_governance_resolve_record_conflict` 的
/// `already_in_desired_state` 快速路径在 `BEGIN IMMEDIATE` 事务内只重验
/// 冲突 generation，**没有**把业务行重读搬进事务——纯本地编辑不触碰
/// `__sync_conflicts`，窗口内可按旧快照误标 resolved（决策未广播、业务行
/// 无损，仅冲突留痕口径失真）。慢速路径已有事务内 preflight
/// （`apply_downloaded_changes_force_exact_with_hooks` 的第一个 hook）可对照。
///
/// 若本用例失败，说明快速路径新增了事务内业务行重读——请更新本用例为
/// 断言该重读存在，并回写 PROTOCOL-R10 / FIX-QUEUE 的 P2-3 登记。
#[test]
fn p2_3_resolve_fast_path_business_row_recheck_still_missing_source_lock() {
    let source = read_repo_file("src/data_governance/commands_sync.rs");

    let snapshot_read = source
        .find("let current_local_snapshot =")
        .expect("resolve 命令应仍读取 current_local_snapshot");
    let fast_path_start = source
        .find("if already_in_desired_state {")
        .expect("快速路径 already_in_desired_state 分支应存在");
    let fast_path_end = source[fast_path_start..]
        .find("// 通过同步链路回写")
        .map(|i| fast_path_start + i)
        .expect("快速路径之后应仍是同步链路回写注释（慢速路径起点）");
    let fast_path = &source[fast_path_start..fast_path_end];

    assert!(
        snapshot_read < fast_path_start,
        "业务行快照读应仍在快速路径（事务）之前——事务外读是 P2-3 的前提"
    );
    assert!(
        fast_path.contains("BEGIN IMMEDIATE"),
        "快速路径应仍在事务内标记 resolved（该防线不得删除）"
    );
    assert!(
        fast_path.contains("__sync_conflicts"),
        "快速路径应仍在事务内重验冲突 generation（该防线不得删除）"
    );
    assert!(
        !fast_path.contains("get_record_data"),
        "检测到快速路径事务内出现业务行重读：P2-3 可能已被修复，\
         请更新本用例并回写 PROTOCOL-R10 / FIX-QUEUE"
    );
}

// ============================================================================
// P2-1（部分缓解）：旧标记升级信任边界的运维解锁指南
// ============================================================================

/// 文档锁定：P2-1 的代码信任边界未变（v1 无校验子标记由第一台带密码上传的
/// 设备一次性升级，配错密码即锁死正确密码设备的上传），当前唯一交付的缓解
/// 是 R09-restore-ops 写入用户指南的解锁章节与 FAQ。指南被删/改名即视为
/// 缓解失效，本用例失败。
#[test]
fn p2_1_marker_upgrade_unlock_guide_doc_lock() {
    let guide = read_repo_file("../docs/user-guide/16-数据管理与云同步.md");
    assert!(
        guide.contains("云端目录的加密标记与「密码不一致」解锁"),
        "P2-1 的运维解锁章节被删除或改名：请恢复，或交付代码级缓解后再移除"
    );
    assert!(
        guide.contains("但我确定自己的密码没错"),
        "P2-1 的 FAQ 条目（错密码抢先升级的自助解锁）被删除：请恢复"
    );

    // 代码侧的最低可观测性：升级动作至少留有日志（事后可追认哪台设备升级）。
    let sync_manager = read_repo_file("src/cloud_storage/sync_manager.rs");
    assert!(
        sync_manager.contains("一次性升级"),
        "旧标记一次性升级的日志/注释被移除：升级动作必须保持可追溯"
    );
}

// ============================================================================
// R01-P2（部分）：资产文件名长度仍未钳制
// ============================================================================

/// 行为锁定（诚实仍开）：`sanitize_segment` 处理了 Windows 非法字符/保留名/
/// 尾点空格/NFD，但**不限制段长**——300 字符的段原样通过，Windows 默认
/// MAX_PATH（260）下可能无法物化。锁定两点：
/// 1. 幂等不变量对超长段同样成立（净化两次结果一致，防乒乓同步）；
/// 2. 长度确实未被截断（若未来加了长度钳制，本用例失败，提醒同步处理
///    截断碰撞与云端既有 key 的迁移，并回写台账）。
#[test]
fn r01_p2_filename_length_still_unclamped_lock() {
    let long_name = "a".repeat(300);
    let once = asset_filenames::sanitize_segment(&long_name);
    let twice = asset_filenames::sanitize_segment(&once);
    assert_eq!(once, twice, "净化必须幂等（超长段不例外），否则乒乓同步");
    assert_eq!(
        once.chars().count(),
        300,
        "段长被改变：若已加长度钳制（好事），请同步处理截断碰撞/云端 key 迁移，\
         更新本用例并回写 PROTOCOL-R10 / FIX-QUEUE"
    );
}
