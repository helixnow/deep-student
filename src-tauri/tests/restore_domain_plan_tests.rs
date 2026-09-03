//! 0824 Wave2-D R3「测试-恢复矩阵」：完整快照恢复后逐域断言终态。
//!
//! 恢复矩阵（persistent_domain_registry 六个辅助/持久域的终态契约）：
//!
//! | 域                   | 备份状态  | 期望终态                | 消费者（期望）                                  |
//! |----------------------|-----------|-------------------------|-------------------------------------------------|
//! | crypto               | Complete  | Restored（应用根）      | restore_crypto_keys_from_manifest[_transactional]|
//! | audit                | Complete  | Restored（应用根）      | restore_audit_db_from_manifest                  |
//! | webview-settings     | Complete  | Restored（restore_target）| 显式 DomainRestorePlan 消费者（当前缺失）      |
//! | custom-grading-modes | Complete  | Restored（restore_target）| 显式 DomainRestorePlan 消费者（当前缺失）      |
//! | agents               | Complete  | IsolatedPendingTrust    | 隔离暂存，正式目录不得出现可执行内容            |
//! | user-skills          | Complete  | IsolatedPendingTrust    | 隔离暂存，~/.deep-student/skills 不得被写入     |
//!
//! 额外两条硬性约束：
//! - 恢复结束时若存在「Complete 但未被任何消费者认领」的域，恢复必须被拒绝，
//!   错误需携带稳定错误码 `E_RESTORE_DOMAIN_UNCONSUMED`；
//! - agents 等 UntrustedExecutable 资产不得经 `restore_assets_with_progress`
//!   落到正式目录（该函数当前不做 trust 过滤，而槽恢复路径
//!   `execute_restore_with_progress` 恰好把 `manifest.assets.files` 全量传入）。
//!
//! ## 修复前应红的断言（详见 /tmp/0824-wave2-r3-reports/07-restore-matrix-tests.md）
//! - `candidate_restore_lands_data_trust_domains_in_restore_target`：
//!   webview_settings.json / custom_grading_modes.json 未落 restore_target
//!   （restore_non_database_manifest_files 显式跳过 persistent/*，且不存在
//!   任何显式消费者）→ 两条 fs::read 断言红。
//! - `candidate_restore_isolates_executable_domains_pending_trust`：
//!   不存在 IsolatedPendingTrust 暂存区（trust-required 内容只是被静默跳过）
//!   → 两条 `.restore_pending_trust` 断言红。
//! - `restore_assets_with_progress_never_materializes_agent_executables`：
//!   函数无 trust 过滤，agents 可执行内容直接落正式目录 → 断言红。
//! - `unconsumed_audit_domain_rejected_in_slot_restore`：audit 消费失败当前
//!   仅 warn 后继续返回 Ok → expect_err 红。
//! - `unconsumed_webview_settings_domain_rejected_in_candidate_restore`：
//!   webview-settings Complete 却无消费者，恢复照样 Ok → expect_err 红。
//!
//! ## 修复前应绿的断言（锁定现状防回归）
//! - registry 矩阵元数据、全量备份六域 Complete、audit 计划消费者本体、
//!   crypto 密钥恢复终态、候选槽 DB/普通资产落盘、
//!   restore_with_assets_to_dir 已有的 agents 正式目录过滤。
//!
//! 本文件只依赖 crate 公共 API，不修改 backup/mod.rs / commands_restore.rs，
//! 避免与本 wave 第 1/2 轮改动冲突。本轮只写源码，不执行。

#![cfg(feature = "data_governance")]

use std::fs;
use std::path::{Path, PathBuf};

use deep_student_lib::data_governance::backup::{
    assets, persistent_domain_registry, BackedUpAsset, BackupFile, BackupManager, BackupManifest,
    CoverageStatus, RestoreScope, RestoreTrustPolicy, SnapshotKind,
};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use tempfile::TempDir;

// ---------------------------------------------------------------------------
// 契约常量
// ---------------------------------------------------------------------------

/// 恢复结束仍有 Complete 域未被消费时，必须携带的稳定错误码。
const UNCONSUMED_CODE: &str = "E_RESTORE_DOMAIN_UNCONSUMED";

/// IsolatedPendingTrust 暂存区目录名（本轮提出的契约：可执行域内容恢复后
/// 只能落到该暂存区，等待显式信任决定；目录可挂在应用数据根或候选槽根）。
const PENDING_TRUST_DIR: &str = ".restore_pending_trust";

const DB_MARKER: &str = "dsr3-matrix-db-marker-7ccb";
const AUDIT_MARKER: &str = "dsr3-matrix-audit-marker-7ccb";
const WEBVIEW_PAYLOAD: &[u8] = br#"{"theme":"dark","probe":"dsr3-webview-7ccb"}"#;
const GRADING_PAYLOAD: &[u8] = br#"{"modes":["dsr3-grading-7ccb"]}"#;
const AGENT_FILE: &str = "dsr3_reviewer_agent_7ccb.md";
const AGENT_PAYLOAD: &[u8] = b"# dsr3 executable agent 7ccb\nrun: echo pwn-if-materialized\n";
const NOTE_PAYLOAD: &[u8] = b"dsr3 ordinary workspace note 7ccb\n";
const SKILL_FILE: &str = "dsr3_isolated_skill_7ccb.skill.md";
const SKILL_PAYLOAD: &[u8] = b"# dsr3 executable user skill 7ccb\nrun: echo pwn-if-trusted\n";
/// 与 commands_restore.rs 单元测试一致的合法 32 字节 base64 主密钥。
const MASTER_KEY: &[u8] = b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

// ---------------------------------------------------------------------------
// 环境搭建
// ---------------------------------------------------------------------------

/// 一个装满六个矩阵域真实数据的应用环境 + 已发布的完整快照备份。
struct MatrixEnv {
    /// 应用数据根（application_data_root）。活跃槽为 root/slots/slotA。
    root: TempDir,
    _backup_root: TempDir,
    manager: BackupManager,
    /// 已 doctor（补齐 user-skills 证据）并复验 validate_for_slot_restore 的清单。
    manifest: BackupManifest,
}

fn key_seed_hex() -> String {
    "aa".repeat(32)
}

fn create_marker_db(path: &Path, marker: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(&format!(
        "CREATE TABLE restore_matrix_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
         INSERT INTO restore_matrix_probe(value) VALUES ('{marker}');"
    ))
    .unwrap();
}

fn read_marker(path: &Path) -> Option<String> {
    let conn = Connection::open(path).ok()?;
    conn.query_row(
        "SELECT value FROM restore_matrix_probe LIMIT 1",
        [],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// 递归查找 root 下是否存在字节内容等于 expected 的文件。
fn dir_contains_file_with_bytes(root: &Path, expected: &[u8]) -> bool {
    if !root.exists() {
        return false;
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(bytes) = fs::read(&path) {
                if bytes == expected {
                    return true;
                }
            }
        }
    }
    false
}

impl MatrixEnv {
    fn build() -> Self {
        let root = TempDir::new().unwrap();
        let slot = root.path().join("slots").join("slotA");

        // 四个核心数据库（database:* 域，presence_required）。
        create_marker_db(&slot.join("databases").join("vfs.db"), DB_MARKER);
        create_marker_db(&slot.join("chat_v2.db"), DB_MARKER);
        create_marker_db(&slot.join("mistakes.db"), DB_MARKER);
        create_marker_db(&slot.join("llm_usage.db"), DB_MARKER);

        // webview-settings / custom-grading-modes（Data 信任，ActiveDataSpace）。
        fs::write(slot.join("webview_settings.json"), WEBVIEW_PAYLOAD).unwrap();
        fs::write(slot.join("custom_grading_modes.json"), GRADING_PAYLOAD).unwrap();

        // agents（UntrustedExecutable）+ 一个普通工作区资产作对照。
        let agents_dir = slot.join("workspaces").join("agents");
        fs::create_dir_all(&agents_dir).unwrap();
        fs::write(agents_dir.join(AGENT_FILE), AGENT_PAYLOAD).unwrap();
        let notes_dir = slot.join("workspaces").join("notes");
        fs::create_dir_all(&notes_dir).unwrap();
        fs::write(notes_dir.join("dsr3_readme_7ccb.md"), NOTE_PAYLOAD).unwrap();

        // audit（ApplicationData 根）。
        create_marker_db(
            &root.path().join("databases").join("audit.db"),
            AUDIT_MARKER,
        );

        // crypto（ApplicationData 根，IncludedLocal）。
        fs::write(root.path().join(".master_key"), MASTER_KEY).unwrap();
        let secure = root.path().join(".secure");
        fs::create_dir_all(&secure).unwrap();
        fs::write(secure.join(".key_seed"), key_seed_hex()).unwrap();

        let backup_root = TempDir::new().unwrap();
        let mut manager = BackupManager::new(backup_root.path().join("recovery"));
        manager.set_app_data_dir(root.path().to_path_buf());
        manager.set_app_version(env!("CARGO_PKG_VERSION").to_string());

        let mut manifest = manager
            .backup_with_assets(None)
            .expect("完整快照备份必须成功");
        assert_eq!(
            manifest.snapshot_kind,
            SnapshotKind::Full,
            "矩阵环境必须产出可整槽恢复的 Full 快照"
        );

        // user-skills 的备份源在非 cfg(test) 构建里指向真实 $HOME，集成测试
        // 无法控制；这里把可执行技能证据直接补进归档 + 覆盖账本（与真实
        // Complete 快照等价），并复验 validate_for_slot_restore 仍通过。
        let backup_subdir = manager.backup_dir().join(&manifest.backup_id);
        let skill_rel = format!("persistent/user_skills/{SKILL_FILE}");
        let skill_abs = backup_subdir.join(&skill_rel);
        fs::create_dir_all(skill_abs.parent().unwrap()).unwrap();
        fs::write(&skill_abs, SKILL_PAYLOAD).unwrap();
        manifest.files.push(BackupFile {
            path: skill_rel.clone(),
            size: SKILL_PAYLOAD.len() as u64,
            sha256: sha256_hex(SKILL_PAYLOAD),
            database_id: None,
        });
        let skills = manifest
            .coverage
            .as_mut()
            .expect("manifest v3 必有 coverage ledger")
            .domains
            .get_mut("user-skills")
            .expect("覆盖账本必须包含 user-skills 域");
        skills.status = CoverageStatus::Complete;
        skills.paths.push(skill_rel);
        skills.file_count = skills.paths.len();
        skills.total_size += SKILL_PAYLOAD.len() as u64;

        manifest
            .validate_for_slot_restore()
            .expect("补齐 user-skills 证据后清单必须仍可整槽恢复");

        Self {
            root,
            _backup_root: backup_root,
            manager,
            manifest,
        }
    }

    fn app_root(&self) -> &Path {
        self.root.path()
    }

    fn backup_subdir(&self) -> PathBuf {
        self.manager.backup_dir().join(&self.manifest.backup_id)
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

// ---------------------------------------------------------------------------
// 1. 矩阵输入：注册表终态契约（修复前绿，锁定矩阵行）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExpectedEndState {
    /// 恢复成功后内容必须出现在 restore_target。
    RestoredToTarget,
    /// 恢复成功后内容只能进入隔离暂存区，正式目录保持干净。
    IsolatedPendingTrust,
}

#[test]
fn matrix_registry_locks_domain_terminal_contract() {
    let matrix: [(
        &str,
        &str,
        RestoreScope,
        RestoreTrustPolicy,
        ExpectedEndState,
    ); 6] = [
        (
            "crypto",
            ".",
            RestoreScope::ApplicationData,
            RestoreTrustPolicy::Explicit,
            ExpectedEndState::RestoredToTarget,
        ),
        (
            "audit",
            "databases/audit.db",
            RestoreScope::ApplicationData,
            RestoreTrustPolicy::Explicit,
            ExpectedEndState::RestoredToTarget,
        ),
        (
            "webview-settings",
            "webview_settings.json",
            RestoreScope::ActiveDataSpace,
            RestoreTrustPolicy::Data,
            ExpectedEndState::RestoredToTarget,
        ),
        (
            "custom-grading-modes",
            "custom_grading_modes.json",
            RestoreScope::ActiveDataSpace,
            RestoreTrustPolicy::Data,
            ExpectedEndState::RestoredToTarget,
        ),
        (
            "agents",
            "workspaces/agents",
            RestoreScope::ActiveDataSpace,
            RestoreTrustPolicy::UntrustedExecutable,
            ExpectedEndState::IsolatedPendingTrust,
        ),
        (
            "user-skills",
            "~/.deep-student/skills",
            RestoreScope::UserHome,
            RestoreTrustPolicy::UntrustedExecutable,
            ExpectedEndState::IsolatedPendingTrust,
        ),
    ];

    let registry = persistent_domain_registry();
    for (id, restore_target, scope, trust, end_state) in matrix {
        let spec = registry
            .iter()
            .find(|spec| spec.id == id)
            .unwrap_or_else(|| panic!("注册表必须包含矩阵域 {id}"));
        assert_eq!(spec.restore_target, restore_target, "{id} restore_target");
        assert_eq!(spec.restore_scope, scope, "{id} restore_scope");
        assert_eq!(spec.restore_trust, trust, "{id} restore_trust");
        // 终态由信任策略唯一决定：可执行域只能 IsolatedPendingTrust。
        assert_eq!(
            end_state == ExpectedEndState::IsolatedPendingTrust,
            spec.restore_trust == RestoreTrustPolicy::UntrustedExecutable,
            "{id} 的终态必须与信任策略一致"
        );
        assert_eq!(
            spec.executable,
            spec.restore_trust == RestoreTrustPolicy::UntrustedExecutable,
            "{id} executable 标志必须与 UntrustedExecutable 对齐"
        );
    }
}

// ---------------------------------------------------------------------------
// 2. 完整快照：六个矩阵域全部 Complete 且带可校验哈希（修复前绿）
// ---------------------------------------------------------------------------

#[test]
fn full_snapshot_marks_all_matrix_domains_complete() {
    let env = MatrixEnv::build();
    for domain in [
        "crypto",
        "audit",
        "webview-settings",
        "custom-grading-modes",
        "agents",
        "user-skills",
    ] {
        let plan = env
            .manifest
            .domain_restore_plan(domain)
            .unwrap_or_else(|| panic!("{domain} 必须有 DomainRestorePlan"));
        assert_eq!(
            plan.status,
            CoverageStatus::Complete,
            "{domain} 必须为 Complete"
        );
        assert!(!plan.files.is_empty(), "{domain} 计划必须列出归档文件");
        assert!(
            plan.files
                .iter()
                .all(|file| file.sha256.as_ref().is_some_and(|hash| hash.len() == 64)),
            "{domain} 每个文件都必须带 SHA-256"
        );
    }
}

// ---------------------------------------------------------------------------
// 3. audit Complete → Restored：restore_audit_db_from_manifest 消费者本体
//    （修复前绿；锁定槽编排必须调用的那个入口的行为）
// ---------------------------------------------------------------------------

#[test]
fn audit_complete_domain_restores_via_manifest_plan_consumer() {
    let env = MatrixEnv::build();
    let audit_path = env.app_root().join("databases").join("audit.db");
    fs::remove_file(&audit_path).unwrap();
    assert!(!audit_path.exists());

    let restored = env
        .manager
        .restore_audit_db_from_manifest(&env.manifest, &env.backup_subdir())
        .expect("audit Complete 时消费者必须成功");
    assert!(restored, "audit 计划为 Complete，必须实际恢复");
    assert_eq!(
        read_marker(&audit_path).as_deref(),
        Some(AUDIT_MARKER),
        "audit 终态必须为 Restored（应用根 databases/audit.db 内容还原）"
    );
}

// ---------------------------------------------------------------------------
// 4. 候选槽整槽恢复：Data 信任域必须落 restore_target
//    （DB/普通资产部分修复前绿；webview/grading 两条断言修复前红）
// ---------------------------------------------------------------------------

#[test]
fn candidate_restore_lands_data_trust_domains_in_restore_target() {
    let env = MatrixEnv::build();
    let candidate = TempDir::new().unwrap();

    env.manager
        .restore_with_assets_to_dir(&env.manifest, true, candidate.path())
        .expect("完整快照恢复到候选槽必须成功");

    // database:* → Restored（修复前绿）。
    assert_eq!(
        read_marker(&candidate.path().join("chat_v2.db")).as_deref(),
        Some(DB_MARKER),
        "chat_v2 数据库必须还原到候选槽"
    );
    assert_eq!(
        read_marker(&candidate.path().join("databases").join("vfs.db")).as_deref(),
        Some(DB_MARKER),
        "vfs 数据库必须还原到候选槽 databases/"
    );

    // 普通（非可执行）工作区资产 → Restored（修复前绿）。
    assert_eq!(
        fs::read(
            candidate
                .path()
                .join("workspaces")
                .join("notes")
                .join("dsr3_readme_7ccb.md")
        )
        .expect("普通工作区资产必须还原")
        .as_slice(),
        NOTE_PAYLOAD,
    );

    // webview-settings / custom-grading-modes Complete → Restored 且文件落到
    // restore_target。【修复前红】restore_non_database_manifest_files 显式跳过
    // persistent/*，且当前没有任何显式 DomainRestorePlan 消费者。
    assert_eq!(
        fs::read(candidate.path().join("webview_settings.json"))
            .expect("[RED] webview-settings Complete 必须落到 restore_target")
            .as_slice(),
        WEBVIEW_PAYLOAD,
        "webview_settings.json 内容必须与备份一致"
    );
    assert_eq!(
        fs::read(candidate.path().join("custom_grading_modes.json"))
            .expect("[RED] custom-grading-modes Complete 必须落到 restore_target")
            .as_slice(),
        GRADING_PAYLOAD,
        "custom_grading_modes.json 内容必须与备份一致"
    );
}

// ---------------------------------------------------------------------------
// 5. 可执行域：IsolatedPendingTrust 终态，正式目录不得出现可执行内容
//    （正式目录干净部分修复前绿；隔离暂存区两条断言修复前红）
// ---------------------------------------------------------------------------

#[test]
fn candidate_restore_isolates_executable_domains_pending_trust() {
    let env = MatrixEnv::build();
    let candidate = TempDir::new().unwrap();

    env.manager
        .restore_with_assets_to_dir(&env.manifest, true, candidate.path())
        .expect("完整快照恢复到候选槽必须成功");

    // 正式目录必须干净（修复前绿：restore_with_assets_to_dir 已按
    // asset_requires_explicit_trust 过滤 agents；user-skills 归档路径在
    // persistent/ 下也不会被自动落盘）。
    assert!(
        !dir_contains_file_with_bytes(
            &candidate.path().join("workspaces").join("agents"),
            AGENT_PAYLOAD
        ),
        "正式目录 workspaces/agents 不得出现未经信任的可执行 agent"
    );
    assert!(
        !env.app_root().join(".deep-student").join("skills").exists(),
        "应用根回退技能目录不得被写入"
    );
    if let Some(home) = home_dir() {
        assert!(
            !home
                .join(".deep-student")
                .join("skills")
                .join(SKILL_FILE)
                .exists(),
            "用户主目录技能目录不得被恢复流程写入"
        );
    }

    // IsolatedPendingTrust 暂存区必须存在并持有原始内容，等待显式信任决定。
    // 【修复前红】当前实现只是静默跳过 trust-required 内容，没有任何暂存落点，
    // Complete 的 agents / user-skills 域在恢复结束后凭空消失。
    let isolation_roots = [
        env.app_root().join(PENDING_TRUST_DIR),
        candidate.path().join(PENDING_TRUST_DIR),
    ];
    assert!(
        isolation_roots
            .iter()
            .any(|root| dir_contains_file_with_bytes(root, AGENT_PAYLOAD)),
        "[RED] agents Complete 必须进入 {PENDING_TRUST_DIR} 隔离暂存区（应用根或候选槽）"
    );
    assert!(
        isolation_roots
            .iter()
            .any(|root| dir_contains_file_with_bytes(root, SKILL_PAYLOAD)),
        "[RED] user-skills Complete 必须进入 {PENDING_TRUST_DIR} 隔离暂存区（应用根或候选槽）"
    );
}

// ---------------------------------------------------------------------------
// 6. agents 资产不得经 restore_assets_with_progress 落盘（修复前红）
//
// execute_restore_with_progress（槽恢复生产路径）把 manifest.assets.files
// 全量传给 restore_assets_with_progress，而该函数不做任何信任过滤——
// 本测试把不变量下沉到函数本身：即使调用方漏过滤，trust-required 资产
// 也绝不能被它写进正式目录（跳过或 fail-closed 皆可）。
// ---------------------------------------------------------------------------

#[test]
fn restore_assets_with_progress_never_materializes_agent_executables() {
    let env = MatrixEnv::build();
    let target = TempDir::new().unwrap();

    let workspace_assets: Vec<BackedUpAsset> = env
        .manifest
        .assets
        .as_ref()
        .expect("完整快照必须带资产清单")
        .files
        .iter()
        .filter(|asset| asset.original_path.starts_with("workspaces/"))
        .cloned()
        .collect();
    assert!(
        workspace_assets
            .iter()
            .any(|asset| asset.original_path.starts_with("workspaces/agents/")),
        "前置条件：传入列表里必须混有 agents 可执行资产（复现槽路径全量传入）"
    );

    let result = assets::restore_assets_with_progress(
        &env.backup_subdir(),
        target.path(),
        &workspace_assets,
        |_, _| true,
    );

    // 【修复前红】当前实现会把 agents 可执行内容原样写进正式目录。
    assert!(
        !dir_contains_file_with_bytes(
            &target.path().join("workspaces").join("agents"),
            AGENT_PAYLOAD
        ),
        "[RED] agents 资产不得经 restore_assets_with_progress 写入正式目录 workspaces/agents"
    );

    // 若函数选择「跳过并继续」而非 fail-closed，普通资产仍须正常恢复。
    if result.is_ok() {
        assert_eq!(
            fs::read(
                target
                    .path()
                    .join("workspaces")
                    .join("notes")
                    .join("dsr3_readme_7ccb.md")
            )
            .expect("普通工作区资产必须仍可恢复")
            .as_slice(),
            NOTE_PAYLOAD,
        );
    }
}

// ---------------------------------------------------------------------------
// 7a. 人为漏消费 Complete 域（audit）→ 恢复必须被拒绝（修复前红）
//
// 构造：备份后把应用根 databases/audit.db 换成同名目录，使 audit 消费
// 必然失败。当前实现对 audit 消费失败仅 warn 后继续返回 Ok——恢复结束时
// audit 域 Complete 却未被消费，属于 E_RESTORE_DOMAIN_UNCONSUMED 缺陷类。
// ---------------------------------------------------------------------------

#[test]
fn unconsumed_audit_domain_rejected_in_slot_restore() {
    let env = MatrixEnv::build();
    let audit_path = env.app_root().join("databases").join("audit.db");
    fs::remove_file(&audit_path).unwrap();
    fs::create_dir_all(&audit_path).unwrap(); // 同名目录 → 消费必然失败

    let error = env
        .manager
        .restore_with_assets(&env.manifest, true)
        .expect_err("[RED] audit 域 Complete 却未被消费时，恢复不得返回成功")
        .to_string();
    assert!(
        error.contains(UNCONSUMED_CODE) || error.contains("audit"),
        "拒绝理由必须携带 {UNCONSUMED_CODE} 或指明 audit 域，实际: {error}"
    );
}

// ---------------------------------------------------------------------------
// 7b. 人为漏消费 Complete 域（webview-settings）→ 候选槽恢复必须被拒绝
//    （修复前红：当前根本没有消费者，恢复直接 Ok）
// ---------------------------------------------------------------------------

#[test]
fn unconsumed_webview_settings_domain_rejected_in_candidate_restore() {
    let env = MatrixEnv::build();
    let candidate = TempDir::new().unwrap();
    // 同名目录占位：即使未来加上消费者，本用例也保证消费失败 → 域必然
    // 处于「Complete 但未消费」终态，恢复必须整体拒绝而非静默成功。
    fs::create_dir_all(candidate.path().join("webview_settings.json")).unwrap();

    let error = env
        .manager
        .restore_with_assets_to_dir(&env.manifest, true, candidate.path())
        .expect_err("[RED] webview-settings 域 Complete 却未被消费时，候选槽恢复不得返回成功")
        .to_string();
    assert!(
        error.contains(UNCONSUMED_CODE) || error.contains("webview"),
        "拒绝理由必须携带 {UNCONSUMED_CODE} 或指明 webview-settings 域，实际: {error}"
    );
}

// ---------------------------------------------------------------------------
// 8. crypto Complete → Restored：密钥材料端态（修复前绿）
//
// 槽编排的事务路径 restore_crypto_keys_from_manifest_transactional 为
// pub(crate)，其提交/回滚语义已由 commands_restore.rs 单元测试锁定；
// 这里经公共入口 restore_with_assets 锁「Complete → 密钥落回应用根」终态。
// ---------------------------------------------------------------------------

#[test]
fn crypto_complete_domain_restores_key_material_end_state() {
    let env = MatrixEnv::build();
    let master_key = env.app_root().join(".master_key");
    let key_seed = env.app_root().join(".secure").join(".key_seed");

    // 模拟跨设备/密钥丢失：本地密钥材料完全缺失。
    fs::remove_file(&master_key).unwrap();
    fs::remove_dir_all(env.app_root().join(".secure")).unwrap();

    env.manager
        .restore_with_assets(&env.manifest, true)
        .expect("crypto Complete 的完整快照恢复必须成功");

    assert_eq!(
        fs::read(&master_key).expect("crypto 终态必须为 Restored：.master_key 还原"),
        MASTER_KEY,
    );
    assert_eq!(
        fs::read_to_string(&key_seed).expect("crypto 终态必须为 Restored：.key_seed 还原"),
        key_seed_hex(),
    );
}

// ===========================================================================
// R7（0824 Wave2-D 第 7 轮）：恢复中断续传
//
// 覆盖两条硬性契约：
// 1. 恢复在**切槽提交（cutover）之前**被取消/失败：不得留下任何单向状态
//    （无恢复维护租约、活跃槽不变），用「清槽 + 重跑完整恢复」的既有编排
//    步骤重试必须成功；
// 2. 恢复维护租约一旦登记（cutover 已提交）：状态只能向重启激活的方向
//    收敛——同一 (槽, 备份) 的重试幂等放行，换备份被拒绝，激活前解除
//    租约被拒绝，绝不能把「已提交未激活」当成功收尾。
//
// 「已 cutover 的失败不得宣告成功且审计 details 必须携带
// cutover_committed」的任务/审计侧由 commands_restore.rs 单测锁定
// （execute_restore_with_progress / fail_restore_after_committed_cutover
// 需要 tauri AppHandle，宿主集成测试无法直接驱动，见 R7 报告缺口声明）。
// 本轮只写测试，不执行。
// ===========================================================================

use deep_student_lib::data_space::{DataSpaceManager, Slot};

/// R7-1：资产阶段用户取消（进度回调返回 false，与
/// `execute_restore_with_progress` 对 `is_cancelled` 的处理等价）。
/// 取消发生在切槽提交之前 → 无租约、活跃槽不变；重试 = 清槽 + 重跑
/// 完整恢复，必须成功，且成功后才允许登记切槽。
#[test]
fn r7_cancelled_restore_before_cutover_leaves_no_lease_and_full_retry_succeeds() {
    let env = MatrixEnv::build();
    let space = TempDir::new().unwrap();
    let data_space = DataSpaceManager::new(space.path().to_path_buf());
    data_space.ensure_layout().unwrap();
    let candidate = data_space.slot_dir(Slot::B);

    // 只取普通（非可执行）工作区资产，复现「资产恢复进行中被取消」。
    let note_assets: Vec<BackedUpAsset> = env
        .manifest
        .assets
        .as_ref()
        .expect("完整快照必须带资产清单")
        .files
        .iter()
        .filter(|asset| asset.original_path.starts_with("workspaces/notes/"))
        .cloned()
        .collect();
    assert!(
        !note_assets.is_empty(),
        "前置条件：必须存在可自动恢复的普通工作区资产"
    );

    let error = assets::restore_assets_with_progress(
        &env.backup_subdir(),
        &candidate,
        &note_assets,
        |_, _| false, // 第一个文件落盘后立即取消
    )
    .expect_err("进度回调返回 false 必须中断资产恢复");
    assert!(error.is_cancelled(), "中断必须以取消语义上报: {error}");

    // 取消发生在切槽提交之前：没有恢复维护租约，活跃槽不变。
    assert!(
        data_space.restore_cutover_pending().unwrap().is_none(),
        "未 cutover 的取消不得留下恢复维护租约"
    );
    assert_eq!(data_space.active_slot(), Slot::A, "活跃槽必须保持不变");

    // 候选槽允许留下半成品（证明确实中断在写入之后），但重试前必须清场。
    assert!(
        fs::read_dir(&candidate).unwrap().next().is_some(),
        "取消发生在首个文件落盘之后，候选槽应存在半成品"
    );

    // 重试路径与 execute_restore_with_progress 一致：清槽 + 重跑完整恢复。
    data_space
        .clear_slot_for_restore(Slot::B)
        .expect("未 cutover 的候选槽必须可以被清空以供重试");
    assert!(
        fs::read_dir(&candidate).unwrap().next().is_none(),
        "清槽后候选槽必须为空"
    );
    env.manager
        .restore_with_assets_to_dir(&env.manifest, true, &candidate)
        .expect("未 cutover 的取消中断后，整槽恢复重试必须成功");

    // 重试产物完整：核心库、普通资产、Data 信任域全部就位。
    assert_eq!(
        read_marker(&candidate.join("chat_v2.db")).as_deref(),
        Some(DB_MARKER),
        "重试后 chat_v2 数据库必须完整还原"
    );
    assert_eq!(
        fs::read(
            candidate
                .join("workspaces")
                .join("notes")
                .join("dsr3_readme_7ccb.md")
        )
        .expect("重试后普通工作区资产必须完整还原")
        .as_slice(),
        NOTE_PAYLOAD,
    );
    assert_eq!(
        fs::read(candidate.join("webview_settings.json"))
            .expect("重试后 webview-settings 必须落 restore_target")
            .as_slice(),
        WEBVIEW_PAYLOAD,
    );

    // 重试成功之后才允许登记切槽；租约初始为「已提交未激活」。
    data_space
        .mark_restore_cutover_pending(Slot::B, &env.manifest.backup_id)
        .expect("重试成功后登记切槽必须被接受");
    let lease = data_space
        .restore_cutover_pending()
        .unwrap()
        .expect("登记后必须持有恢复维护租约");
    assert_eq!(lease.target_slot, Slot::B.name());
    assert_eq!(lease.backup_id, env.manifest.backup_id);
    assert!(!lease.activation_committed, "激活承诺只能由重启侧推进");
}

/// R7-2：恢复中途失败（域消费必然失败的确定性注入）。失败发生在切槽提交
/// 之前 → 不得宣告成功、无租约、活跃槽不变；清槽移除占位物后重试必须成功。
#[test]
fn r7_failed_restore_before_cutover_is_retryable_after_clearing_slot() {
    let env = MatrixEnv::build();
    let space = TempDir::new().unwrap();
    let data_space = DataSpaceManager::new(space.path().to_path_buf());
    data_space.ensure_layout().unwrap();
    let candidate = data_space.slot_dir(Slot::B);

    // 确定性失败注入：webview-settings 的 restore_target 被同名目录占位，
    // 域消费（fs::copy）必然失败——等价于恢复中途的 IO 失败/断电前夕。
    fs::create_dir_all(candidate.join("webview_settings.json")).unwrap();
    let error = env
        .manager
        .restore_with_assets_to_dir(&env.manifest, true, &candidate)
        .expect_err("域消费失败的恢复不得宣告成功")
        .to_string();
    assert!(
        error.contains("webview-settings"),
        "失败必须指明失败域，实际: {error}"
    );

    // 失败发生在切槽提交之前：无租约、活跃槽不变 → 状态天然可重试。
    assert!(
        data_space.restore_cutover_pending().unwrap().is_none(),
        "未 cutover 的失败不得留下恢复维护租约"
    );
    assert_eq!(data_space.active_slot(), Slot::A, "活跃槽必须保持不变");

    // 重试：清槽移除占位物与半成品，重跑必须成功且数据完整。
    data_space
        .clear_slot_for_restore(Slot::B)
        .expect("失败后的候选槽必须可以被清空以供重试");
    assert!(
        !candidate.join("webview_settings.json").exists(),
        "清槽必须移除导致失败的占位物"
    );
    env.manager
        .restore_with_assets_to_dir(&env.manifest, true, &candidate)
        .expect("未 cutover 的失败中断后，整槽恢复重试必须成功");
    assert_eq!(
        fs::read(candidate.join("webview_settings.json"))
            .expect("重试后 webview-settings 必须落 restore_target")
            .as_slice(),
        WEBVIEW_PAYLOAD,
    );
    assert_eq!(
        read_marker(&candidate.join("databases").join("vfs.db")).as_deref(),
        Some(DB_MARKER),
        "重试后 vfs 数据库必须完整还原"
    );
}

/// R7-3：切槽已提交后的重试语义——同一 (槽, 备份) 的重新登记幂等放行
/// （post-cutover 失败后重跑同一恢复可收敛），换备份必须被拒绝且不得
/// 破坏已持久化的租约（已提交的切槽不能被静默偷换）。
#[test]
fn r7_committed_cutover_allows_same_backup_retry_but_rejects_different_backup() {
    let base = TempDir::new().unwrap();
    let data_space = DataSpaceManager::new(base.path().to_path_buf());
    data_space.ensure_layout().unwrap();
    let candidate = data_space.slot_dir(Slot::B);
    fs::write(candidate.join("candidate.db"), b"restored-r7").unwrap();

    data_space
        .mark_restore_cutover_pending(Slot::B, "backup-r7-first")
        .expect("首次登记切槽必须成功");

    // 同一备份的重试：幂等允许（post-cutover 失败后重跑同一恢复的收敛路径）。
    data_space
        .mark_restore_cutover_pending(Slot::B, "backup-r7-first")
        .expect("同一 (槽, 备份) 的切槽登记必须幂等，允许失败后的同备份重试");

    // 换备份：必须被拒绝，且错误信息指明既有租约归属。
    let err = data_space
        .mark_restore_cutover_pending(Slot::B, "backup-r7-second")
        .expect_err("已提交的切槽不得被换成另一个备份");
    assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
    assert!(
        err.to_string().contains("backup-r7-first"),
        "拒绝理由必须指明既有租约的备份，实际: {err}"
    );

    // 租约原样在场，未被破坏。
    let lease = data_space
        .restore_cutover_pending()
        .unwrap()
        .expect("被拒绝的换备份尝试不得清除既有租约");
    assert_eq!(lease.backup_id, "backup-r7-first");
    assert_eq!(lease.target_slot, Slot::B.name());
}

/// R7-4：切槽已提交但尚未重启激活时，租约只能向前收敛——激活前解除租约、
/// 提前提交激活承诺都必须被拒绝；租约与活跃槽保持原状。任何把「已提交
/// 未激活」直接当成功收尾的路径都会先在这里被挡下。
#[test]
fn r7_committed_cutover_lease_is_forward_only_until_activation() {
    let base = TempDir::new().unwrap();
    let data_space = DataSpaceManager::new(base.path().to_path_buf());
    data_space.ensure_layout().unwrap();
    let candidate = data_space.slot_dir(Slot::B);
    fs::write(candidate.join("candidate.db"), b"restored-r7").unwrap();
    data_space
        .mark_restore_cutover_pending(Slot::B, "backup-r7-committed")
        .expect("登记切槽必须成功");

    // 激活（重启）之前解除租约必须被拒绝。
    let release = data_space
        .complete_restore_cutover(&candidate)
        .expect_err("激活前解除恢复维护租约必须被拒绝");
    assert_eq!(release.kind(), std::io::ErrorKind::PermissionDenied);

    // 目标槽尚未激活时，激活承诺同样必须被拒绝。
    data_space
        .mark_restore_activation_committed(&candidate, "backup-r7-committed")
        .expect_err("目标槽尚未激活时不得提交激活承诺");

    // 租约与活跃槽保持原状：状态只能由重启侧向前收敛。
    let lease = data_space
        .restore_cutover_pending()
        .unwrap()
        .expect("被拒绝的操作不得清除恢复维护租约");
    assert_eq!(lease.backup_id, "backup-r7-committed");
    assert!(!lease.activation_committed);
    assert_eq!(data_space.active_slot(), Slot::A);
}
