//! [R4-bad-write] 坏正式对象收敛（bad-write convergence）。
//!
//! 消费「先写 `{key}.<uuid>.tmp` → 回读校验 → 发布正式对象 → 回读校验」写入
//! 协议（见 `sync_manager::save_manifest_at_key`）失败后留下的残局：
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

use super::traits::{CloudStorage, Result};
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

/// 写入协议使用的临时对象后缀（`{key}.<uuid>.tmp`）。
const TMP_SUFFIX: &str = ".tmp";

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
    if key.is_empty() || key.starts_with(QUARANTINE_PREFIX) || key.ends_with(TMP_SUFFIX) {
        return Err(AppError::validation(format!(
            "坏写收敛只接受业务正式对象 key（非空、不在隔离前缀下、非 .tmp）: {key:?}"
        )));
    }

    match storage.get(key).await? {
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

/// 在 `{key}.` 前缀下寻找**当场重新通过校验**的最新 `.tmp` 候选。
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
        if !info.key.ends_with(TMP_SUFFIX) {
            continue;
        }
        let Some(bytes) = storage.get(&info.key).await? else {
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
    match storage.get(&quarantined_key).await? {
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
    match storage.get(&reason_key).await? {
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
    match storage.get(key).await? {
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
        assert_eq!(storage.bytes(KEY).unwrap(), GOOD, "正式对象必须收敛为 .tmp 内容");
        assert!(storage.bytes(&tmp_key).is_none(), "被消费的 .tmp 应删除");

        let record = quarantine.expect("坏正式对象存在，必须有隔离记录");
        assert_eq!(record.original_key, KEY);
        assert_eq!(record.bad_sha256, sha256_hex(BAD));
        assert!(record.original_deleted, "manifest 属元数据，原坏对象应移入隔离区");
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
        assert!(
            !record.original_deleted,
            "记录必须如实标注原对象未删除"
        );
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

    /// 入口 key 卫兵：隔离前缀下的对象与 .tmp 本身不接受收敛。
    #[tokio::test]
    async fn rejects_non_final_keys() {
        let storage = MemoryStorage::default();
        for key in [
            "",
            ".quarantine/manifests/a.json.x.bad",
            "manifests/a.json.123.tmp",
        ] {
            assert!(
                converge_bad_object(&storage, "device-a", key, &json_validate)
                    .await
                    .is_err(),
                "非法 key 必须被拒绝: {key:?}"
            );
        }
    }
}
