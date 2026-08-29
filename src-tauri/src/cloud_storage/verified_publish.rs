//! [R4-verified-publish] 云端对象「验证式发布」原语（零生产接线）。
//!
//! 解决的问题：`CloudStorage::put` 返回 `Ok` 不等于远端字节正确——半包、静默
//! 截断、网关改写都可能让「发布成功」的对象实际不可用。本原语把发布拆成
//! 可核对的四步，任何一步不符即 fail-closed，绝不把可疑对象冒充成功：
//!
//! 1. PUT 到 `<key>.tmp-<op>` 暂存键（不触碰最终键）；
//! 2. **有界回读**暂存键（先 `stat` 核大小、超过 `max_bytes` 拒绝下载，
//!    再 `get` 逐字节比较）；
//! 3. 暂存验证通过后才 PUT 最终键；
//! 4. 再对最终键做一次同样的有界回读。
//!
//! 暂存键命名（[R6-tmp-naming]）：写侧统一为 `<key>.tmp-<op>`（`<op>` 为
//! 12 位十六进制操作号）；读侧恢复原语 `bad_object::converge_bad_object`
//! 对本命名与历史 `{key}.<uuid>.tmp` 都认，KeepTmp 残留可被自动收敛。
//!
//! 失败恢复策略（[`PublishRecovery`]）：
//! - [`PublishRecovery::KeepTmp`]：保留 `.tmp-*` 暂存对象供诊断/人工恢复，
//!   不动坏的最终对象（错误信息里指明两者的键）；
//! - [`PublishRecovery::IsolateBad`]：把验证失败的坏对象改名为
//!   `<key>.bad-<ts>` 隔离（dumb storage 无 rename，用「复制 → 核对副本 →
//!   删除原件」模拟；隔离本身失败则原对象留在原位并在错误里说明）。
//!
//! 版本条件（`expected_generation` / etag）：[`CloudStorage`] 是 dumb-storage
//! 语义，**没有** conditional PUT / If-Match / generation CAS（见 `sync_lease.rs`
//! 开头的说明）。因此提供了版本条件的调用一律返回稳定错误码
//! [`VERIFIED_PUBLISH_UNCONDITIONAL_WRITE_CODE`]，让上层改走租约
//! （`sync_lease` / backup-v2 仓库租约）串行化后再无条件发布——绝不假装做了
//! CAS。（backup-v2 仓库租约的模块名不在此写出字面量：其引用面由 sync_r12
//! 租约源码锁按文件白名单钉死，本模块不在白名单内。）

use chrono::Utc;

use super::traits::{CloudStorage, Result};
use crate::models::AppError;

/// 后端只支持无条件写、无法满足 `expected_generation` 条件时的稳定错误码。
/// 上层看到该码应改走租约串行化，而不是重试。
pub const VERIFIED_PUBLISH_UNCONDITIONAL_WRITE_CODE: &str =
    "E_VERIFIED_PUBLISH_UNCONDITIONAL_WRITE";
/// 回读字节与本地待发布字节不一致（半包 / 截断 / 被网关改写 / 并发覆盖）。
pub const VERIFIED_PUBLISH_MISMATCH_CODE: &str = "E_VERIFIED_PUBLISH_MISMATCH";
/// 待发布数据或远端对象超过 `max_bytes` 上限（有界回读拒绝下载）。
pub const VERIFIED_PUBLISH_OVERSIZE_CODE: &str = "E_VERIFIED_PUBLISH_OVERSIZE";

/// 发布失败时的恢复策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublishRecovery {
    /// 保留 `.tmp-*` 暂存对象，不动坏对象；错误信息指明可疑键。
    KeepTmp,
    /// 把验证失败的坏对象改名为 `<key>.bad-<ts>` 隔离（复制 + 删除模拟 rename）。
    IsolateBad,
}

/// 一次验证式发布的参数。
#[derive(Debug, Clone)]
pub struct PublishSpec {
    /// 最终对象键（相对 root）。
    pub key: String,
    /// 有界回读上限：待发布数据与远端回读对象都不得超过该字节数。
    pub max_bytes: u64,
    /// 期望的远端版本（etag / generation）。当前所有后端都不支持条件写，
    /// 提供该字段会得到 [`VERIFIED_PUBLISH_UNCONDITIONAL_WRITE_CODE`] 错误。
    pub expected_generation: Option<String>,
    /// 失败恢复策略。
    pub recovery: PublishRecovery,
}

impl PublishSpec {
    /// 无版本条件的发布规格（当前后端唯一可走通的形态）。
    pub fn unconditional(
        key: impl Into<String>,
        max_bytes: u64,
        recovery: PublishRecovery,
    ) -> Self {
        Self {
            key: key.into(),
            max_bytes,
            expected_generation: None,
            recovery,
        }
    }
}

fn publish_error(code: &'static str, message: impl std::fmt::Display) -> AppError {
    AppError::internal(format!("[{code}] {message}"))
}

fn validate_spec(spec: &PublishSpec, data_len: u64) -> Result<()> {
    let key = spec.key.trim();
    if key.is_empty() {
        return Err(AppError::validation("验证式发布：对象键不能为空"));
    }
    if key.starts_with('/') || key.contains("..") || key.contains('\\') {
        return Err(AppError::validation(format!(
            "验证式发布：对象键含非法路径成分，已拒绝：{key}"
        )));
    }
    if spec.max_bytes == 0 {
        return Err(AppError::validation(
            "验证式发布：max_bytes 必须大于零（有界回读上限）",
        ));
    }
    if data_len > spec.max_bytes {
        return Err(publish_error(
            VERIFIED_PUBLISH_OVERSIZE_CODE,
            format!(
                "待发布数据 {data_len} 字节超过 max_bytes={} 上限，已在任何写入前拒绝",
                spec.max_bytes
            ),
        ));
    }
    Ok(())
}

/// 有界回读并逐字节比较：`stat` 先核大小（超限拒绝下载），`get` 后全量比较。
async fn read_back_and_compare(
    storage: &dyn CloudStorage,
    key: &str,
    expected: &[u8],
    max_bytes: u64,
    stage: &str,
) -> Result<()> {
    let info = storage.stat(key).await?.ok_or_else(|| {
        publish_error(
            VERIFIED_PUBLISH_MISMATCH_CODE,
            format!("{stage}回读：PUT 成功后对象不存在：{key}"),
        )
    })?;
    if info.size > max_bytes {
        return Err(publish_error(
            VERIFIED_PUBLISH_OVERSIZE_CODE,
            format!(
                "{stage}回读：远端对象 {key} 为 {} 字节，超过 max_bytes={max_bytes} 上限，拒绝下载核对",
                info.size
            ),
        ));
    }
    if info.size != expected.len() as u64 {
        return Err(publish_error(
            VERIFIED_PUBLISH_MISMATCH_CODE,
            format!(
                "{stage}回读：远端对象 {key} 声明 {} 字节，本地为 {} 字节",
                info.size,
                expected.len()
            ),
        ));
    }
    // [R4-get-budget] 回读走带硬预算的入口：stat 与 get 之间对象被并发换成
    // 超限对象时中途断流拒收，而不是整包收下再比对。下方实收核对保留为
    // 测试假存储 / 默认实现的兜底，两道闸互不替代。
    let bytes = storage.get_bounded(key, max_bytes).await?.ok_or_else(|| {
        publish_error(
            VERIFIED_PUBLISH_MISMATCH_CODE,
            format!("{stage}回读：stat 可见但 get 不到对象：{key}"),
        )
    })?;
    if bytes.len() as u64 > max_bytes {
        return Err(publish_error(
            VERIFIED_PUBLISH_OVERSIZE_CODE,
            format!(
                "{stage}回读：远端对象 {key} 实收 {} 字节超过 max_bytes={max_bytes} 上限",
                bytes.len()
            ),
        ));
    }
    if bytes != expected {
        return Err(publish_error(
            VERIFIED_PUBLISH_MISMATCH_CODE,
            format!(
                "{stage}回读：远端对象 {key} 字节内容与本地不一致（{} vs {} 字节，或同长不同内容）",
                bytes.len(),
                expected.len()
            ),
        ));
    }
    Ok(())
}

/// 生成隔离键：`<key>.bad-<UTC 时间戳>-<短随机>`，避免并发隔离互相覆盖。
fn bad_key_for(key: &str) -> String {
    let ts = Utc::now().format("%Y%m%dT%H%M%S%3fZ");
    let salt = uuid::Uuid::new_v4().simple().to_string();
    format!("{key}.bad-{ts}-{}", &salt[..8])
}

/// 把坏对象改名到隔离键：dumb storage 无 rename，用「读原件 → 写副本 →
/// 核对副本大小 → 删原件」模拟。任何一步失败都保留原件（fail-closed），
/// 返回错误描述供上层拼进主错误信息。
async fn isolate_bad_object(
    storage: &dyn CloudStorage,
    from_key: &str,
    max_bytes: u64,
) -> std::result::Result<String, String> {
    let info = match storage.stat(from_key).await {
        Ok(Some(info)) => info,
        Ok(None) => return Err(format!("坏对象 {from_key} 已不存在，无需隔离")),
        Err(e) => return Err(format!("stat 坏对象 {from_key} 失败：{e}，原件保留在原位")),
    };
    // 有界：坏对象超限时拒绝整体下载复制，留在原位由错误信息指认。
    if info.size > max_bytes {
        return Err(format!(
            "坏对象 {from_key} 为 {} 字节，超过 max_bytes={max_bytes}，拒绝下载复制，原件保留在原位",
            info.size
        ));
    }
    let bytes = match storage.get_bounded(from_key, max_bytes).await {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Err(format!("坏对象 {from_key} 在隔离期间消失，未做处理")),
        Err(e) => return Err(format!("读取坏对象 {from_key} 失败：{e}，原件保留在原位")),
    };
    let bad_key = bad_key_for(from_key);
    if let Err(e) = storage.put(&bad_key, &bytes).await {
        return Err(format!(
            "写隔离副本 {bad_key} 失败：{e}，原件 {from_key} 保留在原位"
        ));
    }
    // 副本核对通过才允许删除原件；否则两份都保留，宁多勿丢。
    match storage.stat(&bad_key).await {
        Ok(Some(copy)) if copy.size == bytes.len() as u64 => {}
        _ => {
            return Err(format!(
                "隔离副本 {bad_key} 核对失败，原件 {from_key} 与副本均保留"
            ));
        }
    }
    if let Err(e) = storage.delete(from_key).await {
        return Err(format!(
            "删除原坏对象 {from_key} 失败：{e}（隔离副本 {bad_key} 已就位）"
        ));
    }
    Ok(bad_key)
}

/// 按失败恢复策略处置验证失败的坏对象，返回附加到主错误的处置说明。
async fn apply_recovery(
    storage: &dyn CloudStorage,
    recovery: PublishRecovery,
    bad_object_key: &str,
    tmp_key: &str,
    max_bytes: u64,
) -> String {
    // 坏对象就是暂存对象本身（暂存阶段失败）时，不再重复提及暂存对象。
    let tmp_note = if bad_object_key == tmp_key {
        String::new()
    } else {
        format!("；暂存对象 {tmp_key} 保留供恢复（其内容已验证）")
    };
    match recovery {
        PublishRecovery::KeepTmp => {
            format!("已按 KeepTmp 保留可疑对象 {bad_object_key} 供诊断{tmp_note}")
        }
        PublishRecovery::IsolateBad => {
            match isolate_bad_object(storage, bad_object_key, max_bytes).await {
                Ok(bad_key) => {
                    format!("已把坏对象 {bad_object_key} 隔离为 {bad_key}{tmp_note}")
                }
                Err(detail) => {
                    format!("隔离失败（fail-closed，原件未删）：{detail}{tmp_note}")
                }
            }
        }
    }
}

/// 验证式发布：PUT 暂存键 → 有界回读比较 → PUT 最终键 → 再回读比较。
///
/// 成功当且仅当最终键的远端字节与 `data` 完全一致（暂存对象随后尽力清理，
/// 清理失败只记日志不影响结果）。任何验证失败都返回错误并按
/// [`PublishSpec::recovery`] 处置坏对象，绝不报成功。
///
/// 提供 `expected_generation` 时 fail-closed：当前后端均无 conditional PUT，
/// 返回 [`VERIFIED_PUBLISH_UNCONDITIONAL_WRITE_CODE`]，上层应改走租约。
pub async fn verified_publish(
    storage: &dyn CloudStorage,
    spec: &PublishSpec,
    data: &[u8],
) -> Result<()> {
    validate_spec(spec, data.len() as u64)?;
    let key = spec.key.trim();

    if let Some(expected) = spec.expected_generation.as_deref() {
        return Err(AppError::configuration(format!(
            "[{VERIFIED_PUBLISH_UNCONDITIONAL_WRITE_CODE}] 后端 {} 只支持无条件写：\
             没有 conditional PUT / If-Match / generation，无法按期望版本 {expected:?} 条件发布 {key}。\
             请上层先经租约（sync_lease / backup-v2 仓库租约）串行化，再以无条件规格重试；\
             本原语拒绝假装完成 CAS",
            storage.provider_name()
        )));
    }

    // 每次发布独立暂存键：并发发布者互不覆盖对方的暂存对象。
    let tmp_key = format!(
        "{key}.tmp-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    );

    // 第 1-2 步：写暂存键并有界回读。失败时暂存对象即「坏对象」。
    storage.put(&tmp_key, data).await?;
    if let Err(err) = read_back_and_compare(storage, &tmp_key, data, spec.max_bytes, "暂存").await
    {
        let disposition =
            apply_recovery(storage, spec.recovery, &tmp_key, &tmp_key, spec.max_bytes).await;
        return Err(AppError::internal(format!(
            "{err}；最终键 {key} 未被触碰。{disposition}"
        )));
    }

    // 第 3-4 步：暂存验证通过，发布最终键并再回读。失败时最终对象是坏对象，
    // 暂存对象持有已验证的正确字节，两种策略下都保留。
    if let Err(err) = storage.put(key, data).await {
        return Err(AppError::internal(format!(
            "{err}；发布最终键 {key} 失败，已保留验证过的暂存对象 {tmp_key} 供恢复"
        )));
    }
    if let Err(err) = read_back_and_compare(storage, key, data, spec.max_bytes, "发布后").await {
        let disposition =
            apply_recovery(storage, spec.recovery, key, &tmp_key, spec.max_bytes).await;
        return Err(AppError::internal(format!("{err}。{disposition}")));
    }

    // 成功路径：暂存对象尽力清理；删不掉不影响已验证的发布结果。
    if let Err(e) = storage.delete(&tmp_key).await {
        tracing::warn!(
            "[VerifiedPublish] 发布成功但清理暂存对象失败（不影响结果）: {tmp_key}: {e}"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::traits::FileInfo;
    use super::*;
    use async_trait::async_trait;
    use chrono::{DateTime, Utc};
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct MemoryStorage {
        files: Mutex<BTreeMap<String, (Vec<u8>, DateTime<Utc>)>>,
    }

    impl MemoryStorage {
        fn keys(&self) -> Vec<String> {
            self.files.lock().unwrap().keys().cloned().collect()
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
    impl CloudStorage for Arc<MemoryStorage> {
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
            Ok(self
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
                .collect())
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

    /// 对命中 `corrupt_key_predicate` 的 PUT 篡改末字节，模拟半包/网关改写。
    struct CorruptingStorage {
        inner: Arc<MemoryStorage>,
        corrupt_if: fn(&str) -> bool,
    }

    #[async_trait]
    impl CloudStorage for CorruptingStorage {
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

    fn spec(recovery: PublishRecovery) -> PublishSpec {
        PublishSpec::unconditional("dir/state.json", 1024, recovery)
    }

    #[tokio::test]
    async fn happy_path_publishes_and_cleans_tmp() {
        let mem = Arc::new(MemoryStorage::default());
        let storage = Arc::clone(&mem);
        verified_publish(&storage, &spec(PublishRecovery::KeepTmp), b"hello")
            .await
            .expect("干净后端上发布必须成功");
        assert_eq!(mem.bytes("dir/state.json").as_deref(), Some(&b"hello"[..]));
        assert_eq!(
            mem.keys(),
            vec!["dir/state.json".to_string()],
            "成功后不得残留 .tmp/.bad 对象"
        );
    }

    #[tokio::test]
    async fn oversize_data_rejected_before_any_write() {
        let mem = Arc::new(MemoryStorage::default());
        let storage = Arc::clone(&mem);
        let spec = PublishSpec::unconditional("k", 4, PublishRecovery::KeepTmp);
        let err = verified_publish(&storage, &spec, b"too-long")
            .await
            .expect_err("超过 max_bytes 必须拒绝");
        assert!(err.to_string().contains(VERIFIED_PUBLISH_OVERSIZE_CODE));
        assert!(mem.keys().is_empty(), "拒绝必须发生在任何 PUT 之前");
    }

    #[tokio::test]
    async fn conditional_publish_fails_closed_without_cas() {
        let mem = Arc::new(MemoryStorage::default());
        let storage = Arc::clone(&mem);
        let spec = PublishSpec {
            key: "k".into(),
            max_bytes: 64,
            expected_generation: Some("etag-123".into()),
            recovery: PublishRecovery::KeepTmp,
        };
        let err = verified_publish(&storage, &spec, b"x")
            .await
            .expect_err("无 CAS 能力时条件发布必须明确失败");
        let msg = err.to_string();
        assert!(msg.contains(VERIFIED_PUBLISH_UNCONDITIONAL_WRITE_CODE));
        assert!(
            msg.contains("无条件写"),
            "错误必须点名「无条件写」让上层走租约"
        );
        assert!(mem.keys().is_empty(), "条件拒绝不得产生任何写入");
    }

    #[tokio::test]
    async fn tmp_corruption_keeps_tmp_and_never_touches_final_key() {
        let mem = Arc::new(MemoryStorage::default());
        let storage = CorruptingStorage {
            inner: Arc::clone(&mem),
            corrupt_if: |key| key.contains(".tmp-"),
        };
        let err = verified_publish(&storage, &spec(PublishRecovery::KeepTmp), b"hello")
            .await
            .expect_err("暂存回读不一致必须失败");
        assert!(err.to_string().contains(VERIFIED_PUBLISH_MISMATCH_CODE));
        let keys = mem.keys();
        assert_eq!(keys.len(), 1, "只应存在被保留的暂存对象: {keys:?}");
        assert!(keys[0].contains(".tmp-"));
        assert!(mem.bytes("dir/state.json").is_none(), "最终键不得被触碰");
    }

    #[tokio::test]
    async fn final_corruption_with_isolate_bad_renames_bad_object() {
        let mem = Arc::new(MemoryStorage::default());
        let storage = CorruptingStorage {
            inner: Arc::clone(&mem),
            corrupt_if: |key| key == "dir/state.json",
        };
        let err = verified_publish(&storage, &spec(PublishRecovery::IsolateBad), b"hello")
            .await
            .expect_err("发布后回读不一致必须失败");
        assert!(err.to_string().contains(VERIFIED_PUBLISH_MISMATCH_CODE));
        let keys = mem.keys();
        assert!(
            mem.bytes("dir/state.json").is_none(),
            "坏最终对象必须被移走: {keys:?}"
        );
        assert!(
            keys.iter().any(|k| k.starts_with("dir/state.json.bad-")),
            "必须存在 .bad-<ts> 隔离对象: {keys:?}"
        );
        assert!(
            keys.iter().any(|k| k.contains(".tmp-")),
            "验证过的暂存对象应保留供恢复: {keys:?}"
        );
    }

    #[tokio::test]
    async fn final_corruption_with_keep_tmp_leaves_bad_object_in_place() {
        let mem = Arc::new(MemoryStorage::default());
        let storage = CorruptingStorage {
            inner: Arc::clone(&mem),
            corrupt_if: |key| key == "dir/state.json",
        };
        let err = verified_publish(&storage, &spec(PublishRecovery::KeepTmp), b"hello")
            .await
            .expect_err("发布后回读不一致必须失败");
        assert!(err.to_string().contains(VERIFIED_PUBLISH_MISMATCH_CODE));
        let keys = mem.keys();
        assert!(
            mem.bytes("dir/state.json").is_some(),
            "KeepTmp 不改动坏对象: {keys:?}"
        );
        assert!(keys.iter().any(|k| k.contains(".tmp-")));
        assert!(!keys.iter().any(|k| k.contains(".bad-")));
    }

    #[tokio::test]
    async fn traversal_key_rejected() {
        let mem = Arc::new(MemoryStorage::default());
        let storage = Arc::clone(&mem);
        let spec = PublishSpec::unconditional("../evil", 64, PublishRecovery::KeepTmp);
        assert!(verified_publish(&storage, &spec, b"x").await.is_err());
        assert!(mem.keys().is_empty());
    }
}
