//! [0824-W2-R4] E2EE 云 root 认领 / 升级的并发竞态（lost-update）测试。
//!
//! ## 被测的竞态窗口（修复前为「盲 PUT」，本文件应为红）
//!
//! `CloudSyncManager::verify_encryption_password_before_upload` 与
//! `persist_encryption_marker` 都是「读状态 → 无条件 PUT `.encryption-marker`」：
//!
//! - **空仓认领臂**（marker Absent）：读到 Absent 后直接 PUT 一个带本机密码
//!   校验子的 v2 标记；
//! - **v1→v2 升级臂**（marker v1 无校验子）：读到 v1 后直接 PUT 升级后的 v2；
//! - **幂等登记入口** `persist_encryption_marker`：读到 Absent 后直接 PUT v1。
//!
//! PUT 后的「回读校验」只比对**自己刚写入的字节**，无法发现「别人在我读状态
//! 与我 PUT 之间已经完成了认领」——两台设备都会拿到成功返回，后写者静默覆盖
//! 先写者（经典 lost update）。后果：两台设备各自以为用自己的密码认领了同一
//! 云 root，实际只有最后一个 PUT 的校验子存活，另一台设备此后所有上传都会被
//! 自己的「已认领成功」的密码拦下，且没有任何一步告诉过它认领已被覆盖。
//!
//! ## 竞态的确定性复现方式
//!
//! 真并发（tokio::join + 真实调度）无法稳定命中窗口，这里改用确定性交错：
//! 给「第二台设备」的存储包一层 [`StaleFirstMarkerRead`]——它的**第一次**
//! `.encryption-marker` GET 返回进入写窗口之前捕获的快照（即该设备真实读到的
//! 旧状态），之后的 GET（包括 PUT 后的回读）全部透传共享存储。这精确等价于：
//!
//! ```text
//! B: GET marker → Absent/v1        （B 完成状态读取，停在写入前）
//! A: GET marker → Absent/v1
//! A: PUT marker(A)；回读 = A ✓     （A 报成功）
//! B: PUT marker(B)                 （盲 PUT，覆盖 A）
//! B: 回读 = B ✓                    （B 也报成功 ← 竞态成立）
//! ```
//!
//! ## 修复前后的预期
//!
//! - **修复前（盲 PUT）：本文件全部为红。** 两臂都会出现「双成功 + 覆盖」。
//! - **修复后：** 任何正确的修复形态都应转绿——例如写前在同一把锁/租约下
//!   重读并核对状态未变、条件 PUT（If-None-Match / If-Match 语义）、或回读时
//!   能识别「回读内容不是自己写入的即认领已被人抢先」并报失败。测试只钉
//!   语义（至多一个成功、已有标记不得被覆盖、升级写至多一次），不钉具体
//!   修复手段：第二台设备的**后续** GET 都透传真实云端，重读类修复能看到
//!   真相并正确失败/验证。
//!
//! 全部使用内存 CloudStorage，独立于 Tauri runtime 与 docker。

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::Utc;
use deep_student_lib::cloud_storage::{
    device_id_short_hash, CloudStorage, CloudSyncManager, EncryptionMarker, FileInfo,
};
use deep_student_lib::crypto::backup_crypto;
use deep_student_lib::models::AppError;

const ENCRYPTION_MARKER_KEY: &str = ".encryption-marker";
const ENCRYPTION_MARKER_VERSION_WITH_VERIFIER: u32 = 2;

type CloudResult<T> = Result<T, AppError>;

// ============================================================================
// 共享内存 CloudStorage（Clone 共享底层状态；额外统计 marker 的 PUT 次数）
// ============================================================================

#[derive(Clone, Default)]
struct MemStorage {
    files: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
    /// `.encryption-marker` 被 PUT 的累计次数（含所有设备、含通过包装层的写入）。
    marker_puts: Arc<AtomicUsize>,
}

impl MemStorage {
    fn new() -> Self {
        Self::default()
    }

    fn object(&self, key: &str) -> Option<Vec<u8>> {
        self.files.lock().unwrap().get(key).cloned()
    }

    fn marker_put_count(&self) -> usize {
        self.marker_puts.load(Ordering::SeqCst)
    }

    fn reset_marker_put_count(&self) {
        self.marker_puts.store(0, Ordering::SeqCst);
    }

    /// 直接解析云端标记原文（绕过管理器的 fail-closed 包装）。
    fn parsed_marker(&self) -> Option<EncryptionMarker> {
        self.object(ENCRYPTION_MARKER_KEY)
            .map(|raw| serde_json::from_slice(&raw).expect("云端标记必须始终是合法 JSON"))
    }
}

#[async_trait]
impl CloudStorage for MemStorage {
    fn provider_name(&self) -> &'static str {
        "memory-claim-race"
    }

    async fn check_connection(&self) -> CloudResult<()> {
        Ok(())
    }

    async fn put(&self, key: &str, data: &[u8]) -> CloudResult<()> {
        if key == ENCRYPTION_MARKER_KEY {
            self.marker_puts.fetch_add(1, Ordering::SeqCst);
        }
        self.files
            .lock()
            .unwrap()
            .insert(key.to_string(), data.to_vec());
        Ok(())
    }

    async fn get(&self, key: &str) -> CloudResult<Option<Vec<u8>>> {
        Ok(self.files.lock().unwrap().get(key).cloned())
    }

    async fn list(&self, prefix: &str) -> CloudResult<Vec<FileInfo>> {
        Ok(self
            .files
            .lock()
            .unwrap()
            .iter()
            .filter(|(key, _)| key.starts_with(prefix))
            .map(|(key, value)| FileInfo {
                key: key.clone(),
                size: value.len() as u64,
                last_modified: Utc::now(),
                etag: None,
            })
            .collect())
    }

    async fn delete(&self, key: &str) -> CloudResult<()> {
        self.files.lock().unwrap().remove(key);
        Ok(())
    }

    async fn stat(&self, key: &str) -> CloudResult<Option<FileInfo>> {
        Ok(self.files.lock().unwrap().get(key).map(|value| FileInfo {
            key: key.to_string(),
            size: value.len() as u64,
            last_modified: Utc::now(),
            etag: None,
        }))
    }
}

// ============================================================================
// 竞态窗口模拟层：第一次 marker GET 返回写窗口之前的快照，其余全部透传
// ============================================================================

/// 把「第二台设备已经读完状态、正停在 PUT 之前」这一交错固化下来：
///
/// - 构造时由测试显式传入该设备读到的旧状态快照（`None` = 当时没有标记）；
/// - 第一次 `get(.encryption-marker)` 返回该快照——对应状态机的「读状态」步；
/// - 之后的一切 GET（含 PUT 后回读、修复引入的任何重读）都透传共享存储，
///   保证「写前重读 / 条件写」类修复能看到真实云端并正确落败。
struct StaleFirstMarkerRead {
    inner: MemStorage,
    stale_snapshot: Option<Vec<u8>>,
    stale_reads_remaining: AtomicUsize,
}

impl StaleFirstMarkerRead {
    fn new(inner: MemStorage, stale_snapshot: Option<Vec<u8>>) -> Self {
        Self {
            inner,
            stale_snapshot,
            stale_reads_remaining: AtomicUsize::new(1),
        }
    }
}

#[async_trait]
impl CloudStorage for StaleFirstMarkerRead {
    fn provider_name(&self) -> &'static str {
        "memory-claim-race-stale-read"
    }

    async fn check_connection(&self) -> CloudResult<()> {
        self.inner.check_connection().await
    }

    async fn put(&self, key: &str, data: &[u8]) -> CloudResult<()> {
        self.inner.put(key, data).await
    }

    async fn get(&self, key: &str) -> CloudResult<Option<Vec<u8>>> {
        if key == ENCRYPTION_MARKER_KEY {
            let remaining = self.stale_reads_remaining.load(Ordering::SeqCst);
            if remaining > 0
                && self
                    .stale_reads_remaining
                    .compare_exchange(remaining, remaining - 1, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
            {
                return Ok(self.stale_snapshot.clone());
            }
        }
        self.inner.get(key).await
    }

    async fn list(&self, prefix: &str) -> CloudResult<Vec<FileInfo>> {
        self.inner.list(prefix).await
    }

    async fn delete(&self, key: &str) -> CloudResult<()> {
        self.inner.delete(key).await
    }

    async fn stat(&self, key: &str) -> CloudResult<Option<FileInfo>> {
        self.inner.stat(key).await
    }
}

// ============================================================================
// Fixture 辅助
// ============================================================================

fn manager_on(storage: &MemStorage, device_id: &str) -> CloudSyncManager {
    CloudSyncManager::new(Box::new(storage.clone()), device_id.to_string())
}

/// 第二台设备：状态读取停留在 `stale_snapshot` 时刻的管理器。
fn racing_manager_on(
    storage: &MemStorage,
    device_id: &str,
    stale_snapshot: Option<Vec<u8>>,
) -> CloudSyncManager {
    CloudSyncManager::new(
        Box::new(StaleFirstMarkerRead::new(storage.clone(), stale_snapshot)),
        device_id.to_string(),
    )
}

/// 铸造旧版应用留下的 v1 标记（无校验子），返回其原始字节与解析结果。
async fn mint_v1_marker(storage: &MemStorage) -> (Vec<u8>, EncryptionMarker) {
    let legacy_writer = manager_on(storage, "device-legacy-writer");
    let legacy = legacy_writer.persist_encryption_marker().await.unwrap();
    assert_eq!(legacy.version, 1);
    assert!(legacy.key_verifier.is_none());
    let raw = storage
        .object(ENCRYPTION_MARKER_KEY)
        .expect("v1 标记必须已落地");
    (raw, legacy)
}

/// 断言云端标记的校验子当前只认 `expected_password`（且拒绝 `rejected_password`）。
fn assert_cloud_marker_bound_to_password(
    storage: &MemStorage,
    expected_password: &str,
    rejected_password: &str,
) {
    let marker = storage.parsed_marker().expect("云端必须存在标记");
    let verifier = marker
        .key_verifier
        .as_ref()
        .expect("认领/升级完成后的标记必须携带校验子");
    assert!(
        backup_crypto::check_password_verifier(expected_password, verifier).unwrap(),
        "云端标记的校验子必须仍绑定赢家的密码"
    );
    assert!(
        !backup_crypto::check_password_verifier(rejected_password, verifier).unwrap(),
        "云端标记的校验子不得同时放行另一台设备的密码"
    );
}

// ============================================================================
// 1. 空仓双口令并发认领：至多一个成功
// ============================================================================

/// 【修复前应红】空 root 上两台设备各持不同密码并发认领。
///
/// 交错：B 先读到 Absent（停在写入前）→ A 完整认领成功（pw-alpha 固化进 v2
/// 标记）→ B 恢复执行，盲 PUT 自己的 v2(pw-beta) 覆盖 A，且回读只比对自己的
/// 字节，B 也报成功。
///
/// 钉死的语义：**至多一台设备的认领可以返回成功。** A 是无争抢完成的一方，
/// 它的成功不可剥夺，因此 B 必须失败；且云端标记必须仍绑定 A 的密码。
/// 修复前两台都成功、云端只剩 pw-beta 的校验子（A 被静默锁在门外）→ 本测试红。
#[tokio::test]
async fn race_empty_root_concurrent_claim_with_two_passwords_at_most_one_succeeds() {
    let storage = MemStorage::new();
    assert!(
        storage.object(ENCRYPTION_MARKER_KEY).is_none(),
        "前置条件：空仓，无任何标记"
    );

    // B 在 A 写入前完成了状态读取：捕获此刻（Absent）的快照。
    let device_b = racing_manager_on(&storage, "device-b", None);

    // A 无争抢地完成认领：这一侧的成功是既成事实。
    let device_a = manager_on(&storage, "device-a");
    let claimed_by_a = device_a
        .verify_encryption_password_before_upload("pw-alpha-2026")
        .await
        .expect("A 的认领没有争抢，必须成功");
    assert_eq!(
        claimed_by_a.version,
        ENCRYPTION_MARKER_VERSION_WITH_VERIFIER
    );
    assert_eq!(
        claimed_by_a.created_by_device,
        device_id_short_hash("device-a")
    );

    // B 从「读到 Absent」处恢复执行，试图用另一个密码认领同一 root。
    let b_result = device_b
        .verify_encryption_password_before_upload("pw-beta-2026")
        .await;

    // 至多一个成功：A 已成功，B 必须失败。
    // 修复前（盲 PUT）：B 覆盖 A 的标记、回读比对自己的字节通过 → b_result 为
    // Ok → 此断言失败（红）。
    assert!(
        b_result.is_err(),
        "空仓双口令并发认领必须至多一个成功：A 已用 pw-alpha 完成认领，\
         B 的 pw-beta 认领不得也返回成功（盲 PUT 会让两台设备都以为自己认领了\
         同一 root，实际 A 的校验子已被 B 静默覆盖，A 从此被自己的密码锁在门外）。\
         B 实际返回: {b_result:?}"
    );

    // 云端标记必须仍是 A 的认领结果：绑定 pw-alpha、拒绝 pw-beta、署名 A。
    // 修复前：标记已被 B 覆盖为 pw-beta → 以下断言失败（红）。
    assert_cloud_marker_bound_to_password(&storage, "pw-alpha-2026", "pw-beta-2026");
    let final_marker = storage.parsed_marker().unwrap();
    assert_eq!(
        final_marker.created_by_device,
        device_id_short_hash("device-a"),
        "竞态落败方不得改写认领成功方的署名"
    );

    // 竞态解决后，两侧行为必须与「B 从未参与竞态」一致：
    // A 的密码继续放行，B 的密码继续被拦。
    device_a
        .verify_encryption_password_before_upload("pw-alpha-2026")
        .await
        .expect("赢家密码必须继续放行");
    assert!(
        manager_on(&storage, "device-b")
            .verify_encryption_password_before_upload("pw-beta-2026")
            .await
            .is_err(),
        "输家密码此后必须持续被校验子拦截"
    );
}

// ============================================================================
// 2. 已有 marker：第二设备不得覆盖
// ============================================================================

/// 【修复前应红】root 已被 A 认领（v2 标记 + 校验子），第二台设备 B 走
/// `persist_encryption_marker`（记录级同步的 bool 策略入口，拿不到密码原文）
/// 时读到的是 A 写入之前的旧状态（Absent）。
///
/// 该入口的注释承诺「已存在则保持原样」，但这个承诺建立在读-写窗口内无人
/// 写入的假设上：B 依据过期的 Absent 盲 PUT 一个**无校验子的 v1 标记**，
/// 会把 A 的 v2 标记连同密码校验子一起抹掉——此后任何密码都能「升级认领」
/// 该 root，E2EE 密码校验被整体降级。
///
/// 钉死的语义：**已有标记在任何情况下不得被第二台设备覆盖**——无论 B 的调用
/// 返回什么，云端对象必须逐字节保持 A 的认领结果。修复前 B 的 v1 覆盖了
/// A 的 v2 → 本测试红。
#[tokio::test]
async fn race_second_device_must_not_overwrite_existing_marker() {
    let storage = MemStorage::new();

    // B 在 A 认领之前读过一次云端：捕获 Absent 快照。
    let device_b = racing_manager_on(&storage, "device-b", None);

    // A 完成认领：v2 标记 + pw-alpha 校验子。
    let device_a = manager_on(&storage, "device-a");
    device_a
        .verify_encryption_password_before_upload("pw-alpha-2026")
        .await
        .expect("A 的认领没有争抢，必须成功");
    let marker_bytes_after_a = storage
        .object(ENCRYPTION_MARKER_KEY)
        .expect("A 认领后标记必须存在");

    // B 从过期的 Absent 状态恢复执行幂等登记。
    let b_result = device_b.persist_encryption_marker().await;

    // 无论 B 的返回值如何（幂等入口可以把「已有标记」当成功返回），
    // 云端对象必须逐字节保持 A 的 v2 标记。
    // 修复前（盲 PUT）：B 写入无校验子的 v1，覆盖 A 的 v2 → 断言失败（红）。
    let marker_bytes_after_b = storage
        .object(ENCRYPTION_MARKER_KEY)
        .expect("标记对象不得消失");
    assert_eq!(
        marker_bytes_after_b, marker_bytes_after_a,
        "已有加密标记不得被第二台设备覆盖：B 依据过期的 Absent 读盲 PUT v1 标记，\
         会抹掉 A 的密码校验子并把 E2EE 校验整体降级（任何密码都能重新认领）。\
         B 的调用返回: {b_result:?}"
    );

    // 语义复核：标记仍是 v2、仍绑定 A 的密码。
    let final_marker = storage.parsed_marker().unwrap();
    assert_eq!(
        final_marker.version, ENCRYPTION_MARKER_VERSION_WITH_VERIFIER,
        "v2 标记不得被降级回无校验子的 v1"
    );
    assert_cloud_marker_bound_to_password(&storage, "pw-alpha-2026", "pw-beta-2026");

    // 覆盖如果发生，错密码设备将畅通无阻——反向钉死：错密码必须仍被拦。
    assert!(
        manager_on(&storage, "device-c")
            .verify_encryption_password_before_upload("pw-anything-else")
            .await
            .is_err(),
        "已认领 root 上错密码设备必须持续被拦截（标记被降级覆盖后这里会放行）"
    );
}

// ============================================================================
// 3. v1→v2 升级：不得两人同时升级成功
// ============================================================================

/// 【修复前应红】空仓 + v1 旧标记（无校验子、无备份可试解）：升级臂保持
/// 「第一台带密码的设备认领」的旧行为，于是两台各持不同密码的设备并发触发
/// 升级时，竞争的就是「谁的密码被固化为该 root 此后所有设备的校验基准」。
///
/// 交错：B 先读到 v1（停在升级写入前）→ A 完成 v1→v2 升级（pw-alpha 固化）
/// → B 恢复执行，依据过期的 v1 状态盲 PUT 自己的 v2(pw-beta) 覆盖 A。
///
/// 钉死的语义：**不得两台设备同时升级成功。** A 的升级无争抢完成，B 必须
/// 失败；云端校验子必须仍绑定 pw-alpha；首次写入者/时间保持旧标记的值。
/// 修复前 A、B 双双报成功、最终只有 pw-beta 存活 → 本测试红。
#[tokio::test]
async fn race_v1_to_v2_upgrade_must_not_let_both_devices_win() {
    let storage = MemStorage::new();
    let (v1_bytes, legacy) = mint_v1_marker(&storage).await;

    // B 在 A 升级之前读过标记：捕获 v1 快照。
    let device_b = racing_manager_on(&storage, "device-b", Some(v1_bytes));

    // A 无争抢地完成一次性升级：pw-alpha 成为该 root 的校验基准。
    let device_a = manager_on(&storage, "device-a");
    let upgraded_by_a = device_a
        .verify_encryption_password_before_upload("pw-alpha-2026")
        .await
        .expect("A 的升级没有争抢，必须成功");
    assert_eq!(
        upgraded_by_a.version,
        ENCRYPTION_MARKER_VERSION_WITH_VERIFIER
    );

    // B 从「读到 v1」处恢复执行，用另一个密码走同一条升级臂。
    let b_result = device_b
        .verify_encryption_password_before_upload("pw-beta-2026")
        .await;

    // 不得两人同时升级成功：A 已赢，B 必须失败。
    // 修复前（盲 PUT）：B 依据过期的 v1 状态覆盖写 v2(pw-beta)，回读比对自己
    // 的字节通过 → b_result 为 Ok → 此断言失败（红）。
    assert!(
        b_result.is_err(),
        "v1→v2 升级不得两台设备同时成功：A 已把 pw-alpha 固化进 v2 标记，\
         B 依据过期的 v1 读再次升级会把校验基准整个换成 pw-beta，\
         A 与此前所有按 pw-alpha 配置的设备全部被静默锁死。B 实际返回: {b_result:?}"
    );

    // 云端标记必须仍是 A 的升级结果，且升级不得改写首次写入者与时间。
    // 修复前：校验子已被 B 换成 pw-beta → 断言失败（红）。
    assert_cloud_marker_bound_to_password(&storage, "pw-alpha-2026", "pw-beta-2026");
    let final_marker = storage.parsed_marker().unwrap();
    assert_eq!(
        final_marker.created_by_device,
        device_id_short_hash("device-legacy-writer"),
        "无论谁赢得升级竞态，首次写入者都必须保持 v1 标记的值"
    );
    assert_eq!(
        final_marker.created_at, legacy.created_at,
        "无论谁赢得升级竞态，首次写入时间都必须保持 v1 标记的值"
    );

    // 竞态解决后：赢家密码放行，输家密码被拦。
    device_a
        .verify_encryption_password_before_upload("pw-alpha-2026")
        .await
        .expect("赢家密码必须继续放行");
    assert!(
        manager_on(&storage, "device-b")
            .verify_encryption_password_before_upload("pw-beta-2026")
            .await
            .is_err(),
        "输家密码此后必须持续被校验子拦截"
    );
}

/// 【修复前应红】同一正确密码的两台设备并发触发 v1→v2 升级：即便双方密码
/// 相同（覆盖后功能上无害），**升级这个状态转移本身也至多发生一次**。
///
/// 这是把「不得两人同时升级成功」钉到写路径上的更强不变式：第二台设备要么
/// 失败重试，要么在重读后发现标记已升级、按校验子验证通过——但**不得再对
/// 已升级的标记执行覆盖写**。允许双写意味着写路径根本没有并发控制，只是
/// 这次碰巧双方密码相同；下一次（测试 3 的场景）就是真丢数据。
///
/// 修复前：A、B 各盲 PUT 一次，升级窗口内对 marker 共 2 次 PUT → 本测试红。
#[tokio::test]
async fn race_v1_to_v2_upgrade_same_password_writes_marker_at_most_once() {
    let storage = MemStorage::new();
    let (v1_bytes, _) = mint_v1_marker(&storage).await;

    // 从这里开始统计升级窗口内的 marker 写入次数。
    storage.reset_marker_put_count();

    // B 在 A 升级之前读过标记：捕获 v1 快照。两台设备持同一正确密码。
    let device_b = racing_manager_on(&storage, "device-b", Some(v1_bytes));

    let device_a = manager_on(&storage, "device-a");
    device_a
        .verify_encryption_password_before_upload("shared-team-pw")
        .await
        .expect("A 的升级没有争抢，必须成功");

    let b_result = device_b
        .verify_encryption_password_before_upload("shared-team-pw")
        .await;

    // B 允许成功（重读后按已升级标记的校验子验证通过）也允许失败（要求重试），
    // 但升级写入至多发生一次。
    // 修复前（盲 PUT）：A、B 各写一次 → 计数为 2 → 此断言失败（红）。
    assert!(
        storage.marker_put_count() <= 1,
        "v1→v2 升级窗口内 `.encryption-marker` 至多允许一次写入，实际 {} 次：\
         第二台设备依据过期的 v1 读又执行了一次覆盖写（盲 PUT）。本例双方密码\
         相同故覆盖碰巧无害，但同一写路径在双口令场景（见上一测试）就是丢认领。\
         B 的调用返回: {b_result:?}",
        storage.marker_put_count()
    );

    // 无论 B 成功与否，云端标记必须绑定共同密码且为 v2。
    let final_marker = storage.parsed_marker().unwrap();
    assert_eq!(
        final_marker.version,
        ENCRYPTION_MARKER_VERSION_WITH_VERIFIER
    );
    assert!(
        backup_crypto::check_password_verifier(
            "shared-team-pw",
            final_marker.key_verifier.as_ref().unwrap()
        )
        .unwrap(),
        "升级后的标记必须绑定共同密码"
    );
}
