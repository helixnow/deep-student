//! [R4-bad-write] 坏正式对象收敛（bad-write convergence）。
//!
//! 消费「先写暂存键 → 回读校验 → 发布正式对象 → 回读校验」写入协议
//! （见 `sync_manager::save_manifest_at_key`，现行经 `verified_publish` 原语）
//! 失败后留下的残局。暂存键命名读侧统一都认（[R6-tmp-naming]）：历史
//! `{key}.<uuid>.tmp` 与现行 `{key}.tmp-<op>`，见 [`is_tmp_object_key`]。
//!
//! - **正式对象损坏、存在能重新通过校验的 `.tmp`** → 先把坏正式对象隔离到
//!   可审计前缀 [`QUARANTINE_PREFIX`]（附原因记录），再用 `.tmp` 内容收敛
//!   正式对象（发布后回读校验，失败则保留 `.tmp` 并报错）；
//! - **正式对象缺失、存在已校验 `.tmp`**（发布 put 整体失败的残局）→ 直接用
//!   `.tmp` 收敛，无需隔离；
//! - **只有坏正式对象、无可用 `.tmp`** → 隔离 + fail-closed 返回错误，绝不
//!   冒充成功；
//! - **正式对象健康** → 原样不动（`.tmp` 残留留给正常发布路径清理）。
//!
//! 安全边界：
//! - 隔离永远是「先复制到 `.quarantine/` 并回读核对 + 写原因记录」，随后才
//!   考虑删除原对象；**用户备份数据对象（[`USER_BACKUP_DATA_PREFIXES`] 前缀）
//!   一律不自动删除**，只复制 + 记录，删除权留给用户。
//! - `.tmp` 候选不信任历史校验结论：收敛前必须**当场重新校验**，未通过者
//!   跳过并保留（供审计），不删除。
//! - 本模块零生产接线：由上层编排（如 `CloudSyncManager` 的恢复入口）显式
//!   调用，不改 coordinator。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::traits::{CloudStorage, Result, MEMORY_GET_DEFAULT_BUDGET_BYTES};
use crate::models::AppError;

/// 隔离前缀：所有被判定为「坏写」的正式对象副本与原因记录都放在这里，
/// 与 `backups/` / `manifests/` 等业务前缀天然隔离，可整目录审计。
pub const QUARANTINE_PREFIX: &str = ".quarantine/";

/// 只有坏正式对象、无可用已校验 `.tmp` 时的 fail-closed 稳定错误码。
pub const BAD_OBJECT_FAIL_CLOSED_CODE: &str = "E_SYNC_BAD_OBJECT_FAIL_CLOSED";

/// 用户备份数据对象前缀：隔离时**只复制 + 记录，绝不自动删除原对象**。
///
/// - `backups/`：整包 ZIP/DSBK 备份对象（`sync_manager` 上传产物）；
/// - `backup-v2/`：文件级 / 增量备份仓库对象。
pub const USER_BACKUP_DATA_PREFIXES: &[&str] = &["backups/", "backup-v2/"];

/// 历史写入协议使用的临时对象后缀（`{key}.<uuid>.tmp`）。
const TMP_SUFFIX: &str = ".tmp";

/// 现行 [`super::verified_publish`] 原语的暂存键中缀（`{key}.tmp-<op>`）。
const TMP_OP_MARKER: &str = ".tmp-";

/// [R6-tmp-naming] 两代写入协议的暂存对象命名，读侧统一都认：
/// - 历史 `{key}.<uuid>.tmp`（旧 `save_manifest_at_key` 协议）；
/// - 现行 `{key}.tmp-<op>`（[`super::verified_publish`] 暂存键，`<op>` 为
///   12 位十六进制操作号）。
///
/// `.tmp-<op>` 只在 `<op>` 段整体为字母数字时命中：verified_publish 暂存键
/// 被隔离后的 `{key}.tmp-<op>.bad-<ts>-<salt>` 含 `.` / `-`，不会被误认。
fn is_tmp_object_key(key: &str) -> bool {
    if key.ends_with(TMP_SUFFIX) {
        return true;
    }
    key.rfind(TMP_OP_MARKER).is_some_and(|idx| {
        let op = &key[idx + TMP_OP_MARKER.len()..];
        !op.is_empty() && op.bytes().all(|b| b.is_ascii_alphanumeric())
    })
}

/// 内容校验器：`Ok(())` 表示字节可信可发布；`Err(reason)` 的 reason 会被
/// 写进隔离原因记录。校验必须只依赖字节本身（如 JSON 解码 + 业务校验）。
pub type ValidateFn<'a> = &'a (dyn Fn(&[u8]) -> std::result::Result<(), String> + Send + Sync);

/// 隔离原因记录（序列化为 `.quarantine/<key>.<stamp>.reason.json`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantineRecord {
    /// 记录格式版本，当前为 1。
    pub schema: u32,
    /// 被隔离的正式对象 key。
    pub original_key: String,
    /// 坏字节副本在隔离前缀下的 key。
    pub quarantined_key: String,
    /// 校验失败原因（来自 [`ValidateFn`]）。
    pub reason: String,
    /// 坏字节的 SHA256（hex），审计时核对副本与记录是否配套。
    pub bad_sha256: String,
    /// 坏字节大小。
    pub bad_size: u64,
    /// 检测时间（UTC）。
    pub detected_at: DateTime<Utc>,
    /// 执行隔离的设备 ID。
    pub device_id: String,
    /// 原正式对象是否已被删除。用户备份数据对象恒为 `false`（不自动删除）。
    pub original_deleted: bool,
    /// 若本次同时用某个已校验 `.tmp` 收敛了正式对象，记录该 `.tmp` 的 key。
    pub recovered_from_tmp: Option<String>,
}

/// [`converge_bad_object`] 的成功结局。fail-closed 场景直接返回 `Err`。
#[derive(Debug, Clone)]
pub enum BadObjectOutcome {
    /// 正式对象存在且通过校验，未做任何写操作。
    AlreadyHealthy,
    /// 正式对象不存在，也没有可用的已校验 `.tmp`：无残局可收敛。
    Absent,
    /// 已用已校验 `.tmp` 收敛正式对象。
    RecoveredFromTmp {
        /// 收敛后的正式对象 key。
        key: String,
        /// 被消费（发布成功后删除）的 `.tmp` key。
        tmp_key: String,
        /// 若正式对象原本存在但损坏，这里是它的隔离记录；正式对象原本
        /// 缺失时为 `None`（没有坏字节需要隔离）。
        quarantine: Option<QuarantineRecord>,
    },
}

/// 判断 key 是否属于用户备份数据对象（隔离时不得自动删除原对象）。
pub fn is_user_backup_data_object(key: &str) -> bool {
    USER_BACKUP_DATA_PREFIXES
        .iter()
        .any(|prefix| key.starts_with(prefix))
}

/// 坏正式对象收敛入口。
///
/// 语义见模块级文档。`validate` 对正式对象与每个 `.tmp` 候选都会**当场**
/// 执行——不信任任何历史校验结论。
pub async fn converge_bad_object(
    storage: &dyn CloudStorage,
    device_id: &str,
    key: &str,
    validate: ValidateFn<'_>,
) -> Result<BadObjectOutcome> {
    if key.is_empty() || key.starts_with(QUARANTINE_PREFIX) || is_tmp_object_key(key) {
        return Err(AppError::validation(format!(
            "坏写收敛只接受业务正式对象 key（非空、不在隔离前缀下、非 .tmp / .tmp-<op> 暂存键）: {key:?}"
        )));
    }

    // [R4-get-budget] 有界读取。本函数签名没有按对象类型的预算参数（调用方
    // 如 sync_manager 持有 MANIFEST_OBJECT_MAX_BYTES，但改签名需与调用方协同，
    // 本轮不在写权限内），先以旧入口兜底预算显式设界：与生产后端 `get()` 等值，
    // 但让测试假存储 / 纯内存后端也获得预算语义。
    match storage
        .get_bounded(key, MEMORY_GET_DEFAULT_BUDGET_BYTES)
        .await?
    {
        Some(bytes) => match validate(&bytes) {
            Ok(()) => Ok(BadObjectOutcome::AlreadyHealthy),
            Err(reason) => {
                // 先找可用 .tmp，再隔离：原因记录里可以写全 recovered_from_tmp。
                let verified_tmp = find_verified_tmp(storage, key, validate).await?;
                let record = quarantine_bad_object(
                    storage,
                    device_id,
                    key,
                    &bytes,
                    &reason,
                    verified_tmp.as_ref().map(|(tmp_key, _)| tmp_key.as_str()),
                )
                .await?;
                match verified_tmp {
                    Some((tmp_key, good_bytes)) => {
                        publish_verified(storage, key, &good_bytes).await?;
                        if let Err(error) = storage.delete(&tmp_key).await {
                            tracing::warn!(
                                "[BadWrite] 收敛成功后删除已消费临时对象 {} 失败（不影响结果）: {}",
                                tmp_key,
                                error
                            );
                        }
                        Ok(BadObjectOutcome::RecoveredFromTmp {
                            key: key.to_string(),
                            tmp_key,
                            quarantine: Some(record),
                        })
                    }
                    None => Err(AppError::validation(format!(
                        "[{BAD_OBJECT_FAIL_CLOSED_CODE}] 正式对象 {key} 校验失败（{reason}），\
                         且无可用已校验 .tmp 收敛：坏字节已隔离到 {}（原因记录见同名 .reason.json），\
                         本次 fail-closed，不冒充成功",
                        record.quarantined_key
                    ))),
                }
            }
        },
        None => match find_verified_tmp(storage, key, validate).await? {
            Some((tmp_key, good_bytes)) => {
                publish_verified(storage, key, &good_bytes).await?;
                if let Err(error) = storage.delete(&tmp_key).await {
                    tracing::warn!(
                        "[BadWrite] 收敛成功后删除已消费临时对象 {} 失败（不影响结果）: {}",
                        tmp_key,
                        error
                    );
                }
                Ok(BadObjectOutcome::RecoveredFromTmp {
                    key: key.to_string(),
                    tmp_key,
                    quarantine: None,
                })
            }
            None => Ok(BadObjectOutcome::Absent),
        },
    }
}

/// 在 `{key}.` 前缀下寻找**当场重新通过校验**的最新暂存候选
/// （[`is_tmp_object_key`]：历史 `.tmp` 后缀与现行 `.tmp-<op>` 都认）。
///
/// 未通过校验的候选跳过并保留（供审计），不删除。依赖 `list` 契约
/// （递归、按 last_modified 降序），最新的可信候选优先。
async fn find_verified_tmp(
    storage: &dyn CloudStorage,
    key: &str,
    validate: ValidateFn<'_>,
) -> Result<Option<(String, Vec<u8>)>> {
    let candidate_prefix = format!("{key}.");
    for info in storage.list(&candidate_prefix).await? {
        if !is_tmp_object_key(&info.key) {
            continue;
        }
        let Some(bytes) = storage
            .get_bounded(&info.key, MEMORY_GET_DEFAULT_BUDGET_BYTES)
            .await?
        else {
            continue;
        };
        match validate(&bytes) {
            Ok(()) => return Ok(Some((info.key, bytes))),
            Err(reason) => {
                tracing::warn!(
                    "[BadWrite] 临时对象 {} 未通过重新校验，跳过并保留（供审计）: {}",
                    info.key,
                    reason
                );
            }
        }
    }
    Ok(None)
}

/// 把坏正式对象隔离到 [`QUARANTINE_PREFIX`]：复制坏字节（回读核对）+
/// 写原因记录（回读核对），随后仅对**非**用户备份数据对象删除原对象。
///
/// 任一步失败即返回错误（fail-closed）：没有可信的审计痕迹之前，调用方
/// 不得覆盖或发布任何内容。
async fn quarantine_bad_object(
    storage: &dyn CloudStorage,
    device_id: &str,
    key: &str,
    bad_bytes: &[u8],
    reason: &str,
    recovered_from_tmp: Option<&str>,
) -> Result<QuarantineRecord> {
    let detected_at = Utc::now();
    let stamp = format!(
        "{}-{}",
        detected_at.format("%Y%m%dT%H%M%S%3fZ"),
        &Uuid::new_v4().simple().to_string()[..8]
    );
    let quarantined_key = format!("{QUARANTINE_PREFIX}{key}.{stamp}.bad");
    let reason_key = format!("{QUARANTINE_PREFIX}{key}.{stamp}.reason.json");

    storage.put(&quarantined_key, bad_bytes).await?;
    // [R4-get-budget] 回读预算 = 刚写入的本地字节数：远端把副本膨胀得更大
    // 同样是「审计痕迹不可信」，中途断流拒收。
    match storage
        .get_bounded(&quarantined_key, bad_bytes.len() as u64)
        .await?
    {
        Some(read_back) if read_back.as_slice() == bad_bytes => {}
        _ => {
            return Err(AppError::internal(format!(
                "隔离副本 {quarantined_key} 回读校验失败：审计痕迹不可信，已停止（原对象未动）"
            )));
        }
    }

    // 只有元数据对象（manifest 等）才移走原对象；用户备份数据对象只复制 + 记录。
    let delete_original = !is_user_backup_data_object(key);
    let mut original_deleted = false;
    if delete_original {
        match storage.delete(key).await {
            Ok(()) => original_deleted = true,
            Err(error) => {
                tracing::warn!(
                    "[BadWrite] 删除坏正式对象 {} 失败（副本已在隔离区，记录将如实标注未删除）: {}",
                    key,
                    error
                );
            }
        }
    }

    let record = QuarantineRecord {
        schema: 1,
        original_key: key.to_string(),
        quarantined_key: quarantined_key.clone(),
        reason: reason.to_string(),
        bad_sha256: sha256_hex(bad_bytes),
        bad_size: bad_bytes.len() as u64,
        detected_at,
        device_id: device_id.to_string(),
        original_deleted,
        recovered_from_tmp: recovered_from_tmp.map(str::to_string),
    };
    let record_bytes = serde_json::to_vec_pretty(&record)
        .map_err(|error| AppError::internal(format!("序列化隔离原因记录失败: {error}")))?;
    storage.put(&reason_key, &record_bytes).await?;
    match storage
        .get_bounded(&reason_key, record_bytes.len() as u64)
        .await?
    {
        Some(read_back) if read_back == record_bytes => {}
        _ => {
            return Err(AppError::internal(format!(
                "隔离原因记录 {reason_key} 回读校验失败：审计痕迹不完整，已停止"
            )));
        }
    }

    Ok(record)
}

/// 用已校验字节发布正式对象，发布后回读核对；失败即报错（调用方保留 `.tmp`）。
async fn publish_verified(storage: &dyn CloudStorage, key: &str, data: &[u8]) -> Result<()> {
    storage.put(key, data).await?;
    match storage.get_bounded(key, data.len() as u64).await? {
        Some(read_back) if read_back.as_slice() == data => Ok(()),
        _ => Err(AppError::internal(format!(
            "坏写收敛发布 {key} 后回读校验失败：已保留已校验 .tmp，本次不得报成功"
        ))),
    }
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud_storage::traits::FileInfo;
    use async_trait::async_trait;
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryStorage {
        files: Mutex<BTreeMap<String, (Vec<u8>, DateTime<Utc>)>>,
    }

    impl MemoryStorage {
        fn keys_with_prefix(&self, prefix: &str) -> Vec<String> {
            self.files
                .lock()
                .unwrap()
                .keys()
                .filter(|key| key.starts_with(prefix))
                .cloned()
                .collect()
        }

        fn bytes(&self, key: &str) -> Option<Vec<u8>> {
            self.files
                .lock()
                .unwrap()
                .get(key)
                .map(|(data, _)| data.clone())
        }
    }

    #[async_trait]
    impl CloudStorage for MemoryStorage {
        fn provider_name(&self) -> &'static str {
            "memory"
        }

        async fn check_connection(&self) -> Result<()> {
            Ok(())
        }

        async fn put(&self, key: &str, data: &[u8]) -> Result<()> {
            self.files
                .lock()
                .unwrap()
                .insert(key.to_string(), (data.to_vec(), Utc::now()));
            Ok(())
        }

        async fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
            Ok(self.bytes(key))
        }

        async fn list(&self, prefix: &str) -> Result<Vec<FileInfo>> {
            let mut files: Vec<FileInfo> = self
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

        async fn delete(&self, key: &str) -> Result<()> {
            self.files.lock().unwrap().remove(key);
            Ok(())
        }

        async fn stat(&self, key: &str) -> Result<Option<FileInfo>> {
            Ok(self
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

    fn json_validate(bytes: &[u8]) -> std::result::Result<(), String> {
        serde_json::from_slice::<serde_json::Value>(bytes)
            .map(|_| ())
            .map_err(|error| format!("JSON 解析失败: {error}"))
    }

    fn tmp_key_for(key: &str) -> String {
        format!("{key}.{}.tmp", Uuid::new_v4())
    }

    const KEY: &str = "manifests/abcdef0123456789.json";
    const GOOD: &[u8] = br#"{"versions":[],"latest":null}"#;
    const BAD: &[u8] = b"{ corrupt json";

    /// 【必须 3-a】正式坏 + .tmp 好 → 收敛：坏对象进隔离区（含原因记录），
    /// 正式 key 变成 .tmp 的已校验内容，被消费的 .tmp 删除。
    #[tokio::test]
    async fn bad_final_with_verified_tmp_converges() {
        let storage = MemoryStorage::default();
        storage.put(KEY, BAD).await.unwrap();
        let tmp_key = tmp_key_for(KEY);
        storage.put(&tmp_key, GOOD).await.unwrap();

        let outcome = converge_bad_object(&storage, "device-a", KEY, &json_validate)
            .await
            .expect("坏正式 + 好 .tmp 必须收敛成功");

        let BadObjectOutcome::RecoveredFromTmp {
            key,
            tmp_key: consumed,
            quarantine,
        } = outcome
        else {
            panic!("期望 RecoveredFromTmp，得到其他结局");
        };
        assert_eq!(key, KEY);
        assert_eq!(consumed, tmp_key);
        assert_eq!(
            storage.bytes(KEY).unwrap(),
            GOOD,
            "正式对象必须收敛为 .tmp 内容"
        );
        assert!(storage.bytes(&tmp_key).is_none(), "被消费的 .tmp 应删除");

        let record = quarantine.expect("坏正式对象存在，必须有隔离记录");
        assert_eq!(record.original_key, KEY);
        assert_eq!(record.bad_sha256, sha256_hex(BAD));
        assert!(
            record.original_deleted,
            "manifest 属元数据，原坏对象应移入隔离区"
        );
        assert_eq!(record.recovered_from_tmp.as_deref(), Some(tmp_key.as_str()));
        assert_eq!(
            storage.bytes(&record.quarantined_key).unwrap(),
            BAD,
            "隔离区必须保存完整坏字节供审计"
        );
        let reason_keys: Vec<String> = storage
            .keys_with_prefix(QUARANTINE_PREFIX)
            .into_iter()
            .filter(|key| key.ends_with(".reason.json"))
            .collect();
        assert_eq!(reason_keys.len(), 1, "必须有且仅有一条原因记录");
        let stored: QuarantineRecord =
            serde_json::from_slice(&storage.bytes(&reason_keys[0]).unwrap()).unwrap();
        assert_eq!(stored.reason, record.reason);
        assert!(!stored.reason.is_empty(), "原因必须被记录");
    }

    /// 【必须 3-b】只有坏正式、无 .tmp → fail-closed（稳定错误码）且隔离。
    #[tokio::test]
    async fn bad_final_without_tmp_fails_closed_and_quarantines() {
        let storage = MemoryStorage::default();
        storage.put(KEY, BAD).await.unwrap();

        let error = converge_bad_object(&storage, "device-a", KEY, &json_validate)
            .await
            .expect_err("无可用 .tmp 必须 fail-closed");
        assert!(
            error.to_string().contains(BAD_OBJECT_FAIL_CLOSED_CODE),
            "错误必须携带稳定 fail-closed 码: {error}"
        );

        let quarantined = storage.keys_with_prefix(QUARANTINE_PREFIX);
        assert!(
            quarantined.iter().any(|key| key.ends_with(".bad")),
            "坏字节必须已隔离: {quarantined:?}"
        );
        assert!(
            quarantined.iter().any(|key| key.ends_with(".reason.json")),
            "原因记录必须已写入: {quarantined:?}"
        );
        assert!(
            storage.bytes(KEY).is_none(),
            "元数据坏对象应移入隔离区，正式 key 不残留坏字节"
        );
    }

    /// 【必须 4】用户备份数据对象（backups/ 前缀）即使坏也**不自动删除**：
    /// 只复制进隔离区 + 记录，原对象保留，且仍 fail-closed。
    #[tokio::test]
    async fn user_backup_data_object_is_never_auto_deleted() {
        let storage = MemoryStorage::default();
        let backup_key = "backups/AbCdEf0123456789012345.zip";
        storage.put(backup_key, BAD).await.unwrap();

        let error = converge_bad_object(&storage, "device-a", backup_key, &json_validate)
            .await
            .expect_err("无可用 .tmp 必须 fail-closed");
        assert!(error.to_string().contains(BAD_OBJECT_FAIL_CLOSED_CODE));

        assert_eq!(
            storage.bytes(backup_key).unwrap(),
            BAD,
            "用户备份数据对象绝不自动删除"
        );
        let reason_keys: Vec<String> = storage
            .keys_with_prefix(QUARANTINE_PREFIX)
            .into_iter()
            .filter(|key| key.ends_with(".reason.json"))
            .collect();
        assert_eq!(reason_keys.len(), 1);
        let record: QuarantineRecord =
            serde_json::from_slice(&storage.bytes(&reason_keys[0]).unwrap()).unwrap();
        assert!(!record.original_deleted, "记录必须如实标注原对象未删除");
    }

    /// 健康正式对象：不做任何写操作，隔离区保持为空。
    #[tokio::test]
    async fn healthy_final_is_untouched() {
        let storage = MemoryStorage::default();
        storage.put(KEY, GOOD).await.unwrap();

        let outcome = converge_bad_object(&storage, "device-a", KEY, &json_validate)
            .await
            .unwrap();
        assert!(matches!(outcome, BadObjectOutcome::AlreadyHealthy));
        assert_eq!(storage.bytes(KEY).unwrap(), GOOD);
        assert!(storage.keys_with_prefix(QUARANTINE_PREFIX).is_empty());
    }

    /// .tmp 候选必须当场重新校验：坏 .tmp 不得被采信，也不删除（留审计）。
    #[tokio::test]
    async fn unverifiable_tmp_is_not_trusted_and_is_retained() {
        let storage = MemoryStorage::default();
        storage.put(KEY, BAD).await.unwrap();
        let bad_tmp = tmp_key_for(KEY);
        storage.put(&bad_tmp, b"also { corrupt").await.unwrap();

        let error = converge_bad_object(&storage, "device-a", KEY, &json_validate)
            .await
            .expect_err("只有坏 .tmp 等同于无 .tmp，必须 fail-closed");
        assert!(error.to_string().contains(BAD_OBJECT_FAIL_CLOSED_CODE));
        assert!(
            storage.bytes(&bad_tmp).is_some(),
            "未通过校验的 .tmp 保留供审计，不自动删除"
        );
    }

    /// 正式对象缺失 + 已校验 .tmp（发布 put 整体失败的残局）→ 直接收敛，无隔离。
    #[tokio::test]
    async fn missing_final_with_verified_tmp_converges_without_quarantine() {
        let storage = MemoryStorage::default();
        let tmp_key = tmp_key_for(KEY);
        storage.put(&tmp_key, GOOD).await.unwrap();

        let outcome = converge_bad_object(&storage, "device-a", KEY, &json_validate)
            .await
            .unwrap();
        let BadObjectOutcome::RecoveredFromTmp { quarantine, .. } = outcome else {
            panic!("期望 RecoveredFromTmp");
        };
        assert!(quarantine.is_none(), "无坏字节则无需隔离");
        assert_eq!(storage.bytes(KEY).unwrap(), GOOD);
        assert!(storage.bytes(&tmp_key).is_none());
        assert!(storage.keys_with_prefix(QUARANTINE_PREFIX).is_empty());
    }

    /// 正式对象缺失且无 .tmp：无残局可收敛，诚实返回 Absent。
    #[tokio::test]
    async fn missing_final_without_tmp_is_absent() {
        let storage = MemoryStorage::default();
        let outcome = converge_bad_object(&storage, "device-a", KEY, &json_validate)
            .await
            .unwrap();
        assert!(matches!(outcome, BadObjectOutcome::Absent));
    }

    /// 多个可信 .tmp 时按 list 契约（last_modified 降序）取最新者。
    #[tokio::test]
    async fn newest_verified_tmp_wins() {
        let storage = MemoryStorage::default();
        storage.put(KEY, BAD).await.unwrap();
        let older_tmp = tmp_key_for(KEY);
        storage.put(&older_tmp, br#"{"gen":1}"#).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let newer_tmp = tmp_key_for(KEY);
        storage.put(&newer_tmp, br#"{"gen":2}"#).await.unwrap();

        let outcome = converge_bad_object(&storage, "device-a", KEY, &json_validate)
            .await
            .unwrap();
        let BadObjectOutcome::RecoveredFromTmp { tmp_key, .. } = outcome else {
            panic!("期望 RecoveredFromTmp");
        };
        assert_eq!(tmp_key, newer_tmp, "应消费最新的可信 .tmp");
        assert_eq!(storage.bytes(KEY).unwrap(), br#"{"gen":2}"#);
        assert!(
            storage.bytes(&older_tmp).is_some(),
            "未被消费的旧 .tmp 保留，交给正常发布路径清理"
        );
    }

    /// [R6-tmp-naming] 现行 verified_publish 暂存键（`{key}.tmp-<op>`，不以
    /// `.tmp` 结尾）的残留同样可被收敛：坏正式对象进隔离区，正式 key 收敛为
    /// 暂存内容，被消费的暂存对象删除。
    #[tokio::test]
    async fn verified_publish_style_tmp_residue_converges() {
        let storage = MemoryStorage::default();
        storage.put(KEY, BAD).await.unwrap();
        let publish_tmp = format!("{KEY}.tmp-{}", &Uuid::new_v4().simple().to_string()[..12]);
        storage.put(&publish_tmp, GOOD).await.unwrap();

        let outcome = converge_bad_object(&storage, "device-a", KEY, &json_validate)
            .await
            .expect("verified_publish 命名的暂存残留必须同样可收敛");
        let BadObjectOutcome::RecoveredFromTmp { tmp_key, .. } = outcome else {
            panic!("期望 RecoveredFromTmp");
        };
        assert_eq!(tmp_key, publish_tmp);
        assert_eq!(storage.bytes(KEY).unwrap(), GOOD);
        assert!(
            storage.bytes(&publish_tmp).is_none(),
            "被消费的暂存对象应删除"
        );
    }

    /// [R6-tmp-naming] 两代命名都认；隔离产物（`.bad-<ts>-<salt>`）不得被误认。
    #[test]
    fn tmp_object_key_recognition_covers_both_generations() {
        assert!(
            is_tmp_object_key("manifests/a.json.0123abcd.tmp"),
            "历史 .tmp 后缀"
        );
        assert!(
            is_tmp_object_key("manifests/a.json.tmp-0123abcd4567"),
            "现行 .tmp-<op>"
        );
        assert!(!is_tmp_object_key("manifests/a.json"), "正式对象不是暂存键");
        assert!(
            !is_tmp_object_key(
                "manifests/a.json.tmp-0123abcd4567.bad-20250101T000000000Z-cafe0123"
            ),
            "verified_publish 隔离产物不得被误认为暂存键"
        );
        assert!(
            !is_tmp_object_key("manifests/a.json.tmp-"),
            "空操作号不算暂存键"
        );
    }

    /// 入口 key 卫兵：隔离前缀下的对象与两代暂存键本身都不接受收敛。
    #[tokio::test]
    async fn rejects_non_final_keys() {
        let storage = MemoryStorage::default();
        for key in [
            "",
            ".quarantine/manifests/a.json.x.bad",
            "manifests/a.json.123.tmp",
            "manifests/a.json.tmp-0123abcd4567",
        ] {
            assert!(
                converge_bad_object(&storage, "device-a", key, &json_validate)
                    .await
                    .is_err(),
                "非法 key 必须被拒绝: {key:?}"
            );
        }
    }

    // ==================== [R7-badwrite-converge] 坏写后下一轮收敛 ====================
    //
    // 上方各测试的残局都是手工摆的；本节把两个模块真正串起来：先让
    // `verified_publish`（KeepTmp 策略）在故障注入后端上**真实**跑出残局，
    // 坏写当轮结束后故障消失（瞬态半包/网关改写模型），下一轮再由
    // `converge_bad_object` 在干净后端上收敛。锁的是跨模块契约：
    // verified_publish 写侧留下的暂存键命名与残局形状，读侧 bad_object
    // 必须原样认得（[R6-tmp-naming]），且下一轮 / 再下一轮语义诚实。

    use crate::cloud_storage::verified_publish::{
        verified_publish, PublishRecovery, PublishSpec, VERIFIED_PUBLISH_MISMATCH_CODE,
    };
    use std::sync::Arc;

    /// 对命中谓词的 PUT 篡改末字节（同长不同内容），模拟半包/网关改写。
    /// 包在 `Arc<MemoryStorage>` 外：坏写轮走本包装（故障在场），下一轮收敛
    /// 直接用干净的内层（故障已消失），正好对应「坏写后下一轮」的时间线。
    struct CorruptingPutStorage {
        inner: Arc<MemoryStorage>,
        corrupt_if: fn(&str) -> bool,
    }

    #[async_trait]
    impl CloudStorage for CorruptingPutStorage {
        fn provider_name(&self) -> &'static str {
            "memory-corrupting"
        }

        async fn check_connection(&self) -> Result<()> {
            Ok(())
        }

        async fn put(&self, key: &str, data: &[u8]) -> Result<()> {
            let mut stored = data.to_vec();
            if (self.corrupt_if)(key) {
                if let Some(last) = stored.last_mut() {
                    *last ^= 0xFF;
                }
            }
            self.inner.put(key, &stored).await
        }

        async fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
            self.inner.get(key).await
        }

        async fn list(&self, prefix: &str) -> Result<Vec<FileInfo>> {
            self.inner.list(prefix).await
        }

        async fn delete(&self, key: &str) -> Result<()> {
            self.inner.delete(key).await
        }

        async fn stat(&self, key: &str) -> Result<Option<FileInfo>> {
            self.inner.stat(key).await
        }
    }

    /// 【R7 主线】verified_publish KeepTmp「发布后回读不一致」的真实残局
    /// （坏正式 + 已验证 `.tmp-<op>`）→ 下一轮 converge_bad_object 收敛：
    /// 坏字节进隔离区（记录指认 recovered_from_tmp），正式键收敛为发布内容，
    /// 残局暂存键被消费；再下一轮 AlreadyHealthy 且审计痕迹保留。
    #[tokio::test]
    async fn real_keep_tmp_endgame_converges_on_next_round() {
        let mem = Arc::new(MemoryStorage::default());

        // ---- 坏写轮：只有最终键的 PUT 被网关改写，暂存键完好 ----
        let bad_round = CorruptingPutStorage {
            inner: Arc::clone(&mem),
            corrupt_if: |key| key == KEY,
        };
        let spec = PublishSpec::unconditional(KEY, 1024, PublishRecovery::KeepTmp);
        let err = verified_publish(&bad_round, &spec, GOOD)
            .await
            .expect_err("发布后回读不一致必须失败");
        assert!(err.to_string().contains(VERIFIED_PUBLISH_MISMATCH_CODE));

        // ---- 残局形状：坏正式对象在场且确实过不了校验；恰有一个已验证暂存键 ----
        let corrupted = mem.bytes(KEY).expect("KeepTmp 不动坏的最终对象");
        assert_ne!(corrupted, GOOD);
        assert!(
            json_validate(&corrupted).is_err(),
            "坏字节必须过不了当场校验"
        );
        let residue_tmps: Vec<String> = mem
            .keys_with_prefix(&format!("{KEY}."))
            .into_iter()
            .filter(|key| key.contains(TMP_OP_MARKER))
            .collect();
        assert_eq!(
            residue_tmps.len(),
            1,
            "KeepTmp 残局应恰有一个暂存对象: {residue_tmps:?}"
        );
        let residue_tmp = residue_tmps[0].clone();
        assert_eq!(
            mem.bytes(&residue_tmp).unwrap(),
            GOOD,
            "暂存对象持有已验证字节"
        );
        // [R6-tmp-naming] 跨模块命名契约：写侧运行时生成的暂存键，读侧必须认。
        assert!(
            is_tmp_object_key(&residue_tmp),
            "verified_publish 运行时暂存键必须被 bad_object 认得: {residue_tmp}"
        );

        // ---- 下一轮：故障消失，直接在干净内层上收敛 ----
        let outcome = converge_bad_object(&*mem, "device-b", KEY, &json_validate)
            .await
            .expect("真实 KeepTmp 残局必须能收敛");
        let BadObjectOutcome::RecoveredFromTmp {
            key,
            tmp_key,
            quarantine,
        } = outcome
        else {
            panic!("期望 RecoveredFromTmp");
        };
        assert_eq!(key, KEY);
        assert_eq!(
            tmp_key, residue_tmp,
            "消费的必须是 verified_publish 留下的暂存键"
        );
        assert_eq!(
            mem.bytes(KEY).unwrap(),
            GOOD,
            "正式键收敛为当初要发布的内容"
        );
        assert!(mem.bytes(&residue_tmp).is_none(), "被消费的暂存对象应删除");

        let record = quarantine.expect("坏正式对象在场，必须有隔离记录");
        assert_eq!(record.bad_sha256, sha256_hex(&corrupted));
        assert_eq!(
            record.recovered_from_tmp.as_deref(),
            Some(residue_tmp.as_str())
        );
        assert_eq!(
            mem.bytes(&record.quarantined_key).unwrap(),
            corrupted,
            "隔离区保存的必须是坏写轮的原坏字节"
        );

        // ---- 再下一轮：幂等，无新写操作，审计痕迹不被清理 ----
        let again = converge_bad_object(&*mem, "device-b", KEY, &json_validate)
            .await
            .unwrap();
        assert!(matches!(again, BadObjectOutcome::AlreadyHealthy));
        assert_eq!(
            mem.bytes(&record.quarantined_key).unwrap(),
            corrupted,
            "已收敛后再巡检不得动隔离区审计痕迹"
        );
    }

    /// 【R7】verified_publish KeepTmp「暂存阶段就被改写」的真实残局：只剩一个
    /// **过不了校验**的 `.tmp-<op>`，最终键从未被触碰。下一轮收敛必须诚实返回
    /// Absent（坏 .tmp 不采信、不冒充成功），且残局保留供审计、隔离区为空。
    #[tokio::test]
    async fn real_keep_tmp_staging_endgame_stays_honest_absent() {
        let mem = Arc::new(MemoryStorage::default());
        let bad_round = CorruptingPutStorage {
            inner: Arc::clone(&mem),
            corrupt_if: |key| key.contains(TMP_OP_MARKER),
        };
        let spec = PublishSpec::unconditional(KEY, 1024, PublishRecovery::KeepTmp);
        let err = verified_publish(&bad_round, &spec, GOOD)
            .await
            .expect_err("暂存回读不一致必须失败");
        assert!(err.to_string().contains(VERIFIED_PUBLISH_MISMATCH_CODE));
        assert!(mem.bytes(KEY).is_none(), "暂存阶段失败时最终键不得被触碰");

        let outcome = converge_bad_object(&*mem, "device-b", KEY, &json_validate)
            .await
            .unwrap();
        assert!(
            matches!(outcome, BadObjectOutcome::Absent),
            "坏 .tmp 不得被采信为可收敛残局"
        );
        assert!(
            mem.bytes(KEY).is_none(),
            "不得用未通过校验的字节冒充正式对象"
        );
        let retained: Vec<String> = mem
            .keys_with_prefix(&format!("{KEY}."))
            .into_iter()
            .filter(|key| key.contains(TMP_OP_MARKER))
            .collect();
        assert_eq!(retained.len(), 1, "坏暂存对象保留供审计，不自动删除");
        assert!(
            mem.keys_with_prefix(QUARANTINE_PREFIX).is_empty(),
            "正式对象缺失时没有坏字节需要隔离"
        );
    }

    /// 【R7】只有坏正式（fail-closed 隔离）之后的「下一轮」：坏字节已移入
    /// 隔离区，再巡检必须诚实返回 Absent，不重复隔离、不冒充成功；且当轮
    /// fail-closed 错误必须点名隔离副本 key，让运维能顺着错误找到审计痕迹。
    #[tokio::test]
    async fn fail_closed_round_then_next_round_is_honest_absent() {
        let storage = MemoryStorage::default();
        storage.put(KEY, BAD).await.unwrap();

        let error = converge_bad_object(&storage, "device-a", KEY, &json_validate)
            .await
            .expect_err("无可用 .tmp 必须 fail-closed");
        let message = error.to_string();
        assert!(message.contains(BAD_OBJECT_FAIL_CLOSED_CODE));
        let bad_copies: Vec<String> = storage
            .keys_with_prefix(QUARANTINE_PREFIX)
            .into_iter()
            .filter(|key| key.ends_with(".bad"))
            .collect();
        assert_eq!(bad_copies.len(), 1);
        assert!(
            message.contains(&bad_copies[0]),
            "fail-closed 错误必须点名隔离副本 key: {message}"
        );

        let outcome = converge_bad_object(&storage, "device-a", KEY, &json_validate)
            .await
            .expect("坏字节已隔离后，下一轮巡检不应再报错");
        assert!(
            matches!(outcome, BadObjectOutcome::Absent),
            "下一轮必须诚实返回 Absent，不冒充成功"
        );
        let reason_count = storage
            .keys_with_prefix(QUARANTINE_PREFIX)
            .into_iter()
            .filter(|key| key.ends_with(".reason.json"))
            .count();
        assert_eq!(reason_count, 1, "下一轮不得重复隔离、重复写记录");
    }

    /// 【R7】用户备份数据对象反复 fail-closed：无论巡检多少轮，原对象一个
    /// 字节都不得被自动删除（删除权永远留给用户）。
    #[tokio::test]
    async fn user_backup_bad_object_survives_repeated_rounds() {
        let storage = MemoryStorage::default();
        let backup_key = "backup-v2/objects/aa/bb/deadbeef";
        storage.put(backup_key, BAD).await.unwrap();

        for round in 1..=2 {
            let error = converge_bad_object(&storage, "device-a", backup_key, &json_validate)
                .await
                .expect_err("用户备份坏对象每一轮都必须 fail-closed");
            assert!(
                error.to_string().contains(BAD_OBJECT_FAIL_CLOSED_CODE),
                "第 {round} 轮错误必须携带稳定码"
            );
            assert_eq!(
                storage.bytes(backup_key).unwrap(),
                BAD,
                "第 {round} 轮之后原对象必须原样保留"
            );
        }
    }

    /// 【R7】[R6-tmp-naming] 两代残局并存时按 last_modified 取最新可信者：
    /// 历史 `{key}.<uuid>.tmp`（旧）与现行 `{key}.tmp-<op>`（新）同场，收敛
    /// 必须消费更新的 verified_publish 暂存键，旧代残留保留。
    #[tokio::test]
    async fn cross_generation_residue_newest_verified_tmp_wins() {
        let storage = MemoryStorage::default();
        storage.put(KEY, BAD).await.unwrap();
        let legacy_tmp = tmp_key_for(KEY);
        storage.put(&legacy_tmp, br#"{"gen":1}"#).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let publish_tmp = format!("{KEY}.tmp-{}", &Uuid::new_v4().simple().to_string()[..12]);
        storage.put(&publish_tmp, br#"{"gen":2}"#).await.unwrap();

        let outcome = converge_bad_object(&storage, "device-a", KEY, &json_validate)
            .await
            .unwrap();
        let BadObjectOutcome::RecoveredFromTmp { tmp_key, .. } = outcome else {
            panic!("期望 RecoveredFromTmp");
        };
        assert_eq!(tmp_key, publish_tmp, "两代并存时应消费最新的可信暂存键");
        assert_eq!(storage.bytes(KEY).unwrap(), br#"{"gen":2}"#);
        assert!(
            storage.bytes(&legacy_tmp).is_some(),
            "未被消费的旧代残留保留，交给正常发布路径清理"
        );
    }
}
