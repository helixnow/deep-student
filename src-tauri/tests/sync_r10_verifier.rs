//! [R10-verifier] FINDINGS-R07 P2-2（KDF 参数无上限）与「云端加密标记被删后
//! 默许明文上传」两项产品加固的集成回归测试。
//!
//! 覆盖三条验收线（对应 KEY-ROTATION-R11 §6 的产品要求）：
//!
//! 1. **合法/历史参数必须通过**：默认参数（64 MiB / t=3 / p=4）与历史可能写过的
//!    非默认合法参数（如 128 MiB）的校验子/DSBK 容器照常工作；
//! 2. **异常过大的派生参数在派生开始前被拒绝**（fail-closed、亚秒返回、用户级
//!    文案），且上传前置校验失败时**不写入任何云端对象**（零污染）；
//! 3. **云端加密标记被删除后不得默许明文上传**：本机记得该云端目录曾经加密
//!    （`EncryptedRootMemory`，第二道门禁），明文上传仍被拒绝；加密上传不受影响
//!    （会用本机密码重新登记标记）。
//!
//! 全部用例使用内存云存储与临时目录，不触网，可与其他测试并行。

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use deep_student_lib::cloud_storage::{CloudStorage, CloudSyncManager, FileInfo};
use deep_student_lib::crypto::backup_crypto::{
    check_password_verifier, create_password_verifier, decrypt_backup, decrypt_backup_file,
    encrypt_backup, encrypt_backup_file, EncryptedRootMemory, PasswordVerifier, KDF_MAX_M_COST_KIB,
    KDF_MAX_P_COST, KDF_MAX_T_COST, PASSWORD_VERIFIER_KDF_ARGON2ID,
};
use deep_student_lib::models::AppError;

type CloudResult<T> = Result<T, AppError>;

// ============================================================================
// Fixture: 内存云存储（可逐字节快照 + 可自定义实例绑定指纹）
// ============================================================================

struct MemoryCloudStorage {
    files: Mutex<BTreeMap<String, (Vec<u8>, DateTime<Utc>)>>,
    binding_hint: String,
}

impl MemoryCloudStorage {
    fn new(binding_hint: &str) -> Arc<Self> {
        Arc::new(Self {
            files: Mutex::new(BTreeMap::new()),
            binding_hint: binding_hint.to_string(),
        })
    }

    /// 云端对象全集的逐字节快照：断言「零污染」的依据。
    fn byte_snapshot(&self) -> BTreeMap<String, Vec<u8>> {
        self.files
            .lock()
            .unwrap()
            .iter()
            .map(|(key, (data, _))| (key.clone(), data.clone()))
            .collect()
    }

    fn remove(&self, key: &str) {
        self.files.lock().unwrap().remove(key);
    }
}

/// 孤儿规则规避：测试 crate 不能为 `Arc<本地类型>` 实现外部 trait。
#[derive(Clone)]
struct SharedStorage(Arc<MemoryCloudStorage>);

#[async_trait]
impl CloudStorage for SharedStorage {
    fn provider_name(&self) -> &'static str {
        "memory"
    }

    fn instance_binding_hint(&self) -> String {
        self.0.binding_hint.clone()
    }

    async fn check_connection(&self) -> CloudResult<()> {
        Ok(())
    }

    async fn put(&self, key: &str, data: &[u8]) -> CloudResult<()> {
        self.0
            .files
            .lock()
            .unwrap()
            .insert(key.to_string(), (data.to_vec(), Utc::now()));
        Ok(())
    }

    async fn get(&self, key: &str) -> CloudResult<Option<Vec<u8>>> {
        Ok(self
            .0
            .files
            .lock()
            .unwrap()
            .get(key)
            .map(|(data, _)| data.clone()))
    }

    async fn list(&self, prefix: &str) -> CloudResult<Vec<FileInfo>> {
        let mut files: Vec<FileInfo> = self
            .0
            .files
            .lock()
            .unwrap()
            .iter()
            .filter(|(key, _)| key.starts_with(prefix))
            .map(|(key, (data, modified))| FileInfo {
                key: key.clone(),
                size: data.len() as u64,
                last_modified: *modified,
                etag: None,
            })
            .collect();
        files.sort_by(|left, right| right.last_modified.cmp(&left.last_modified));
        Ok(files)
    }

    async fn delete(&self, key: &str) -> CloudResult<()> {
        self.0.files.lock().unwrap().remove(key);
        Ok(())
    }

    async fn stat(&self, key: &str) -> CloudResult<Option<FileInfo>> {
        Ok(self
            .0
            .files
            .lock()
            .unwrap()
            .get(key)
            .map(|(data, modified)| FileInfo {
                key: key.to_string(),
                size: data.len() as u64,
                last_modified: *modified,
                etag: None,
            }))
    }
}

fn manager(storage: &Arc<MemoryCloudStorage>, device_id: &str) -> CloudSyncManager {
    CloudSyncManager::new(
        Box::new(SharedStorage(Arc::clone(storage))),
        device_id.to_string(),
    )
}

fn manager_with_memory(
    storage: &Arc<MemoryCloudStorage>,
    device_id: &str,
    memory_path: &std::path::Path,
) -> CloudSyncManager {
    manager(storage, device_id).with_encryption_root_memory(EncryptedRootMemory::at(memory_path))
}

/// 结构合法但参数可控的校验子（摘要随机：只驱动校验路径，不要求密码匹配）。
fn verifier_with_params(m_cost: u32, t_cost: u32, p_cost: u32) -> PasswordVerifier {
    PasswordVerifier {
        kdf: PASSWORD_VERIFIER_KDF_ARGON2ID.to_string(),
        m_cost,
        t_cost,
        p_cost,
        salt: "00112233445566778899aabbccddeeff".to_string(),
        digest: "11".repeat(32),
    }
}

// ============================================================================
// 1. 合法/历史参数必须通过
// ============================================================================

/// 默认参数写出的校验子与 DSBK 容器：正确密码 Ok(true) / 错误密码 Ok(false)，
/// 加解密 roundtrip 照常——上限钳制不得拒收自家写入面。
#[test]
fn legal_default_params_still_pass() {
    let verifier = create_password_verifier("r10-correct-pw").unwrap();
    assert!(check_password_verifier("r10-correct-pw", &verifier).unwrap());
    assert!(!check_password_verifier("r10-wrong-pw", &verifier).unwrap());

    let encrypted = encrypt_backup(b"r10 payload", "r10-correct-pw").unwrap();
    assert_eq!(
        decrypt_backup(&encrypted, "r10-correct-pw").unwrap(),
        b"r10 payload"
    );
}

/// 历史版本可能写过的非默认合法参数（128 MiB，低于上限）必须真实执行复算：
/// 随机摘要返回 Ok(false)（跑过 KDF 且不匹配），而不是被上限误拒为 Err。
#[test]
fn legal_legacy_params_still_execute() {
    let verifier = verifier_with_params(131_072, 1, 1);
    let result = check_password_verifier("any-password", &verifier)
        .expect("128 MiB 为合法历史参数，必须低于上限、照常执行");
    assert!(!result, "随机摘要不可能匹配任何密码");
}

/// 上限常量本身必须覆盖默认写入面（防止未来有人把上限改到默认值以下）。
#[test]
fn limits_cover_default_write_surface() {
    let default = create_password_verifier("pw").unwrap();
    assert!(default.m_cost <= KDF_MAX_M_COST_KIB);
    assert!(default.t_cost <= KDF_MAX_T_COST);
    assert!(default.p_cost <= KDF_MAX_P_COST);
}

// ============================================================================
// 2. 异常过大参数：派生前拒绝（Err、亚秒、用户级文案）+ 云端零写入
// ============================================================================

/// 三个参数分别超限（含 u32::MAX 极端值）：必须返回 `Err`（无法校验，
/// fail-closed），不得与 `Ok(false)`（密码不一致）混淆；必须在派生开始前
/// 亚秒返回；文案必须是用户级的（不提 feature/编译等内部实现）。
#[test]
fn oversized_params_rejected_before_derivation() {
    for (m, t, p, label) in [
        (KDF_MAX_M_COST_KIB + 1, 1u32, 1u32, "m_cost 超限一格"),
        (u32::MAX, 1, 1, "m_cost 极大"),
        (8, KDF_MAX_T_COST + 1, 1, "t_cost 超限"),
        (8, 1, KDF_MAX_P_COST + 1, "p_cost 超限"),
        (u32::MAX, u32::MAX, u32::MAX, "全部极大"),
    ] {
        let verifier = verifier_with_params(m, t, p);
        let start = Instant::now();
        let error = check_password_verifier("any-password", &verifier)
            .expect_err(&format!("{label}: 必须 Err（fail-closed）而非 Ok"));
        let elapsed = start.elapsed();
        assert!(
            elapsed < Duration::from_millis(500),
            "{label}: 必须在派生开始前拒绝（实际 {elapsed:?}）"
        );
        let message = error.to_string();
        assert!(
            message.contains("加密参数异常"),
            "{label}: 文案应为用户级: {message}"
        );
        for internal in ["feature", "编译", "Argon2", "argon2"] {
            assert!(
                !message.contains(internal),
                "{label}: 文案不得暴露内部实现（{internal}）: {message}"
            );
        }
    }
}

/// DSBK 备份文件头与校验子同一套上限：v1 整块与 v2 流式容器的头部参数被改成
/// 超限值后，解密必须亚秒 Err，且流式路径不得创建输出文件。
#[test]
fn dsbk_decrypt_rejects_oversized_kdf_params_before_derivation() {
    // v1 整块容器（头部布局 [DSBK][v][m:4][t:4][p:4]...，m_cost 在 5..9）
    let mut v1 = encrypt_backup(b"payload", "pw").unwrap();
    v1[5..9].copy_from_slice(&u32::MAX.to_le_bytes());
    let start = Instant::now();
    let error = decrypt_backup(&v1, "pw").expect_err("超限 v1 头必须拒绝");
    assert!(start.elapsed() < Duration::from_millis(500));
    assert!(error.to_string().contains("加密参数异常"));

    // v2 流式容器（同一头部布局）
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("in.bin");
    let enc = dir.path().join("enc.dsbk");
    let dec = dir.path().join("dec.bin");
    std::fs::write(&input, vec![9u8; 8192]).unwrap();
    encrypt_backup_file(&input, &enc, "pw").unwrap();
    let mut bytes = std::fs::read(&enc).unwrap();
    bytes[5..9].copy_from_slice(&u32::MAX.to_le_bytes());
    std::fs::write(&enc, &bytes).unwrap();
    let start = Instant::now();
    let error = decrypt_backup_file(&enc, &dec, "pw").expect_err("超限 v2 头必须拒绝");
    assert!(start.elapsed() < Duration::from_millis(500));
    assert!(error.to_string().contains("加密参数异常"));
    assert!(!dec.exists(), "拒绝必须发生在创建输出文件之前");
}

/// 云端标记里的校验子参数超限时：上传前置校验（带密码与明文两路）必须失败，
/// 且**不写入任何云端对象**——标记不被改写、不出现任何 backups/ 对象。
#[tokio::test]
async fn upload_precheck_oversized_params_fails_closed_without_write() {
    let storage = MemoryCloudStorage::new("memory|root=oversized-params");

    // 直接向云端放置一个带超限校验子的 v2 标记（模拟被外部改写的云端对象）
    let marker = serde_json::json!({
        "version": 2,
        "createdByDevice": "attacker-or-corruption",
        "createdAt": Utc::now().to_rfc3339(),
        "keyVerifier": {
            "kdf": PASSWORD_VERIFIER_KDF_ARGON2ID,
            "mCost": u32::MAX,
            "tCost": 1,
            "pCost": 1,
            "salt": "00112233445566778899aabbccddeeff",
            "digest": "22".repeat(32),
        },
    });
    storage.files.lock().unwrap().insert(
        ".encryption-marker".to_string(),
        (serde_json::to_vec_pretty(&marker).unwrap(), Utc::now()),
    );
    let snapshot = storage.byte_snapshot();

    let device = manager(&storage, "device-a");

    // 带密码：校验子无法校验（超限）→ fail-closed
    let start = Instant::now();
    let error = device
        .enforce_encryption_policy_before_upload_with_password(Some("any-pw"))
        .await
        .expect_err("超限校验子必须在上传前 fail-closed");
    assert!(
        start.elapsed() < Duration::from_millis(500),
        "拒绝必须发生在派生开始前"
    );
    assert!(
        error.to_string().contains("加密参数异常"),
        "错误应含用户级文案: {error}"
    );

    // 明文：标记存在 → 拒绝（与超限无关的既有门禁，一并确认未被破坏）
    device
        .enforce_encryption_policy_before_upload_with_password(None)
        .await
        .expect_err("有标记时必须拒绝明文上传");

    assert_eq!(
        storage.byte_snapshot(),
        snapshot,
        "两路拒绝后云端对象集合必须逐字节不变（零写入）"
    );
}

// ============================================================================
// 3. 云端加密标记被删除后：本机记忆拒绝明文上传
// ============================================================================

/// 主线：带密码上传登记标记（本机同时记住「曾加密」）→ 云端标记被删 →
/// 明文上传仍被拒绝；换一台全新设备（无记忆）删标记后明文上传不受影响
/// （诚实边界：记忆只保护本机）；本机加密上传照常（重新登记标记）。
#[tokio::test]
async fn deleted_marker_does_not_allow_plaintext_upload_from_this_machine() {
    let storage = MemoryCloudStorage::new("memory|root=marker-deleted");
    let memory_dir = tempfile::tempdir().unwrap();
    let memory_path = memory_dir.path().join("encrypted-roots.json");

    // 设备 A 用密码登记标记：本机记忆同步写入
    let device_a = manager_with_memory(&storage, "device-a", &memory_path);
    device_a
        .enforce_encryption_policy_before_upload_with_password(Some("r10-pw"))
        .await
        .expect("首次加密上传前置应成功并登记标记");
    assert!(memory_path.exists(), "本机应已记住该目录曾经加密");

    // 云端标记被删除（模拟解锁流程误删/第三方清理）
    storage.remove(".encryption-marker");

    // 本机明文上传必须仍被拒绝（第二道门禁）
    let error = device_a
        .enforce_encryption_policy_before_upload_with_password(None)
        .await
        .expect_err("标记被删后本机明文上传必须仍被拒绝");
    let message = error.to_string();
    assert!(
        message.contains("曾启用端到端加密"),
        "错误应解释本机记忆的判定依据: {message}"
    );
    assert!(
        message.contains("加密密码"),
        "错误应给出可操作指引（填写原密码）: {message}"
    );

    // 同一记忆文件的新 manager 实例（模拟应用重启）同样拒绝
    let device_a_restarted = manager_with_memory(&storage, "device-a", &memory_path);
    device_a_restarted
        .ensure_plaintext_upload_allowed()
        .await
        .expect_err("重启后（记忆持久化）明文上传仍必须被拒绝");

    // 本机加密上传不受影响：标记缺失时用本机密码重新登记
    device_a
        .enforce_encryption_policy_before_upload_with_password(Some("r10-pw"))
        .await
        .expect("加密上传应重新登记标记并放行");
    assert!(
        storage.byte_snapshot().contains_key(".encryption-marker"),
        "加密上传应已重新登记云端标记"
    );

    // 诚实边界：另一台无记忆的设备在标记被删期间不受本机记忆保护
    storage.remove(".encryption-marker");
    let fresh_memory = tempfile::tempdir().unwrap();
    let device_b = manager_with_memory(
        &storage,
        "device-b",
        &fresh_memory.path().join("roots.json"),
    );
    device_b
        .ensure_plaintext_upload_allowed()
        .await
        .expect("全新设备无本机记忆，云端也无标记时明文上传按既有语义放行");
}

/// bool 策略入口（记录级同步等拿不到密码原文的调用方）同样受记忆保护：
/// 加密上传登记记忆 → 删标记 → 明文策略检查被拒。
#[tokio::test]
async fn deleted_marker_bool_policy_entry_also_rejected() {
    let storage = MemoryCloudStorage::new("memory|root=bool-entry");
    let memory_dir = tempfile::tempdir().unwrap();
    let memory_path = memory_dir.path().join("roots.json");

    let device = manager_with_memory(&storage, "device-a", &memory_path);
    device
        .enforce_encryption_policy_before_upload(true)
        .await
        .expect("bool 加密入口应登记标记");

    storage.remove(".encryption-marker");

    device
        .enforce_encryption_policy_before_upload(false)
        .await
        .expect_err("标记被删后 bool 明文入口必须仍被拒绝");
}

/// 记忆按云端目录指纹隔离：目录 A 曾加密不影响目录 B 的明文上传。
#[tokio::test]
async fn memory_is_scoped_per_cloud_root() {
    let memory_dir = tempfile::tempdir().unwrap();
    let memory_path = memory_dir.path().join("roots.json");

    let storage_a = MemoryCloudStorage::new("memory|root=scoped-a");
    let device_on_a = manager_with_memory(&storage_a, "device", &memory_path);
    device_on_a
        .enforce_encryption_policy_before_upload_with_password(Some("pw"))
        .await
        .unwrap();
    storage_a.remove(".encryption-marker");
    device_on_a
        .ensure_plaintext_upload_allowed()
        .await
        .expect_err("目录 A 曾加密：明文被拒");

    // 同一台机器（同一记忆文件）、不同云端目录：不受目录 A 的记忆影响
    let storage_b = MemoryCloudStorage::new("memory|root=scoped-b");
    let device_on_b = manager_with_memory(&storage_b, "device", &memory_path);
    device_on_b
        .ensure_plaintext_upload_allowed()
        .await
        .expect("目录 B 从未加密：明文照常放行");
}

/// 云端标记存在但本机尚无记忆时（如从旧版本升级），任何一次触发标记读取的
/// 明文拦截都会补写本机记忆——此后删标记同样拦得住。
#[tokio::test]
async fn plaintext_rejection_backfills_local_memory() {
    let storage = MemoryCloudStorage::new("memory|root=backfill");
    let memory_dir = tempfile::tempdir().unwrap();
    let memory_path = memory_dir.path().join("roots.json");

    // 另一台设备（无本机记忆参与）登记了标记
    manager(&storage, "device-other")
        .enforce_encryption_policy_before_upload_with_password(Some("pw"))
        .await
        .unwrap();

    // 本机第一次明文尝试：被云端标记拦截，同时补写本机记忆
    let device = manager_with_memory(&storage, "device-local", &memory_path);
    device
        .ensure_plaintext_upload_allowed()
        .await
        .expect_err("云端标记存在：明文被拒");
    assert!(memory_path.exists(), "拦截时应补写本机记忆");

    // 标记被删后，本机仍拦得住
    storage.remove(".encryption-marker");
    device
        .ensure_plaintext_upload_allowed()
        .await
        .expect_err("标记被删后本机记忆继续拦截明文上传");
}
