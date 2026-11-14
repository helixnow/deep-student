# 跨 lane 服务草稿：L23-sync-providers

> 生成文件（`node scripts/electron-migration/services-draft.mjs`），不要手改。这是 `contracts/services/`
> 正式契约的**输入**：提供方 lane 据此设计 `<service>@1` 接口，消费方 lane 据此确认依赖。
>
> 方法：tree-sitter-rust 解析全部 Rust 文件，建立模块树（`mod` 声明 + `#[path]`）与 `use` / `pub use`
> 重导出链；把 (1) `use` 导入、(2) 代码中的限定路径（含 `Type::method`）解析到定义处，定义与引用分属
> 不同 lane 即记一条。值上的方法调用（`x.method()`）需要类型推断，**不统计**——"提供"清单偏少不偏多。
> `?` = 不确定（经 glob 重导出，或定义文件不在模块树内）。计数 = 引用点（导入名在文件中的出现次数）；
> prod / test 按是否位于 `#[cfg(test)]` / `mod tests` / `tests/` 区分。

## 提供给其他 lane（82 个条目，其中 29 个有生产代码引用）

| 条目 | 种类 | 定义 | 消费方（prod/test 引用点） | 签名 |
|---|---|---|---|---|
| `dstu_sync::cloud_storage::traits::CloudStorage` ? | trait | `crates/dstu-sync/src/cloud_storage/traits.rs:293` | L20-sync 104/23<br>L22-app-commands 0/31 | `pub trait CloudStorage: Send + Sync` |
| `dstu_sync::cloud_storage::config::CloudStorageConfig` ? | struct | `crates/dstu-sync/src/cloud_storage/config.rs:216` | L21-backup-governance 11/5<br>L20-sync 10/1<br>F4-security 0/4<br>L22-app-commands 0/2 | `pub struct CloudStorageConfig` |
| `dstu_sync::cloud_storage::is_cloud_rate_limited` | fn | `crates/dstu-sync/src/cloud_storage/mod.rs:90` | L20-sync 18/0 | `pub fn is_cloud_rate_limited(message: &str) -> bool` |
| `dstu_sync::cloud_storage::create_storage` | fn | `crates/dstu-sync/src/cloud_storage/mod.rs:218` | L20-sync 9/0<br>L21-backup-governance 1/0<br>F4-security 0/5<br>L22-app-commands 0/1 | `pub async fn create_storage(config: &CloudStorageConfig) -> Result<Box<dyn CloudStorage>>` |
| `dstu_sync::cloud_storage::sync_e2ee_error` | fn | `crates/dstu-sync/src/cloud_storage/mod.rs:111` | L20-sync 7/0 | `pub fn sync_e2ee_error(code: &'static str, message: impl std::fmt::Display) -> String` |
| `dstu_sync::cloud_storage::config::StorageProvider` | enum | `crates/dstu-sync/src/cloud_storage/config.rs:96` | L21-backup-governance 4/6<br>F4-security 0/4<br>L22-app-commands 0/2 | `pub enum StorageProvider` |
| `dstu_sync::cloud_storage::config::PlatformStorageCapabilities` | struct | `crates/dstu-sync/src/cloud_storage/config.rs:15` | L21-backup-governance 3/0 | `pub struct PlatformStorageCapabilities` |
| `dstu_sync::cloud_storage::config::PlatformStorageCapabilities::current` | method | `crates/dstu-sync/src/cloud_storage/config.rs:24` | L21-backup-governance 3/0 | `pub fn current() -> Self` |
| `dstu_sync::cloud_storage::SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE` | const | `crates/dstu-sync/src/cloud_storage/mod.rs:95` | L20-sync 3/0 | `pub const SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE: &str = "E_SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED"` |
| `dstu_sync::cloud_storage::traits::is_sync_cancelled` | fn | `crates/dstu-sync/src/cloud_storage/traits.rs:95` | L20-sync 3/0 | `pub fn is_sync_cancelled() -> bool` |
| `dstu_sync::cloud_storage::resume::cleanup_stale_parts` | fn | `crates/dstu-sync/src/cloud_storage/resume.rs:130` | L20-sync 2/0 | `pub(crate) fn cleanup_stale_parts(dest: &Path, keep: &Path)` |
| `dstu_sync::cloud_storage::resume::content_keyed_part_path` | fn | `crates/dstu-sync/src/cloud_storage/resume.rs:108` | L20-sync 2/0 | `pub(crate) fn content_keyed_part_path(dest: &Path, checksum: &str) -> std::path::PathBuf` |
| `dstu_sync::cloud_storage::resume::get_file_with_optional_resume` | fn | `crates/dstu-sync/src/cloud_storage/resume.rs:43` | L20-sync 2/0 | `pub(crate) async fn get_file_with_optional_resume( storage: &dyn CloudStorage, key: &str, dest: &Path, expected_checksum: Option<&str>, progress: Option<DownloadProgressCallback>, ) -> Result<String>` |
| `dstu_sync::cloud_storage::SYNC_E2EE_PASSWORD_REQUIRED_CODE` | const | `crates/dstu-sync/src/cloud_storage/mod.rs:101` | L20-sync 2/0 | `pub const SYNC_E2EE_PASSWORD_REQUIRED_CODE: &str = "E_SYNC_E2EE_PASSWORD_REQUIRED"` |
| `dstu_sync::cloud_storage::SYNC_E2EE_WRONG_PASSWORD_CODE` | const | `crates/dstu-sync/src/cloud_storage/mod.rs:97` | L20-sync 2/0 | `pub const SYNC_E2EE_WRONG_PASSWORD_CODE: &str = "E_SYNC_E2EE_WRONG_PASSWORD"` |
| `dstu_sync::cloud_storage::sync_lease::acquire_sync_target_lease` | fn | `crates/dstu-sync/src/cloud_storage/sync_lease.rs:411` | L20-sync 2/0 | `pub async fn acquire_sync_target_lease( storage: Arc<dyn CloudStorage>, holder_device_id: &str, ) -> Result<SyncTargetLeaseGuard>` |
| `dstu_sync::cloud_storage::repo_check::run_repo_check` | fn | `crates/dstu-sync/src/cloud_storage/repo_check.rs:384` | L20-sync 1/0<br>L22-app-commands 0/11 | `pub async fn run_repo_check(storage: &dyn CloudStorage) -> Result<RepoCheckReport>` |
| `dstu_sync::cloud_storage::sync_manager::CloudSyncManager::new` | method | `crates/dstu-sync/src/cloud_storage/sync_manager.rs:316` | L20-sync 1/0<br>L22-app-commands 0/7 | `pub fn new(storage: Box<dyn CloudStorage>, device_id: String) -> Self` |
| `dstu_sync::cloud_storage::config::WebDavConfig` | struct | `crates/dstu-sync/src/cloud_storage/config.rs:119` | L21-backup-governance 1/4<br>F4-security 0/1<br>L22-app-commands 0/1 | `pub struct WebDavConfig` |
| `dstu_sync::cloud_storage::config::FtpConfig` | struct | `crates/dstu-sync/src/cloud_storage/config.rs:182` | L21-backup-governance 1/2<br>F4-security 0/1 | `pub struct FtpConfig` |
| `dstu_sync::cloud_storage::delta_format::MAX_LOGICAL_PATH_BYTES` | const | `crates/dstu-sync/src/cloud_storage/delta_format.rs:33` | L21-backup-governance 1/0<br>L22-app-commands 0/3 | `pub const MAX_LOGICAL_PATH_BYTES: usize = 4096` |
| `dstu_sync::cloud_storage::delta_format::MAX_SNAPSHOT_FILES` | const | `crates/dstu-sync/src/cloud_storage/delta_format.rs:31` | L21-backup-governance 1/0<br>L22-app-commands 0/3 | `pub const MAX_SNAPSHOT_FILES: usize = 100_000` |
| `dstu_sync::cloud_storage::config::S3Config` | struct | `crates/dstu-sync/src/cloud_storage/config.rs:141` | L21-backup-governance 1/1<br>F4-security 0/1 | `pub struct S3Config` |
| `dstu_sync::cloud_storage::repo_check::RepoCheckReport` | struct | `crates/dstu-sync/src/cloud_storage/repo_check.rs:122` | L20-sync 1/0<br>L22-app-commands 0/1 | `pub struct RepoCheckReport` |
| `dstu_sync::cloud_storage::resume::persist_download` | fn | `crates/dstu-sync/src/cloud_storage/resume.rs:153` | L20-sync 1/0 | `pub(crate) fn persist_download(part: &Path, dest: &Path) -> Result<()>` |
| `dstu_sync::cloud_storage::traits::clear_cancel_token` | fn | `crates/dstu-sync/src/cloud_storage/traits.rs:88` | L20-sync 1/0 | `pub fn clear_cancel_token()` |
| `dstu_sync::cloud_storage::traits::clear_status_hook` | fn | `crates/dstu-sync/src/cloud_storage/traits.rs:51` | L20-sync 1/0 | `pub fn clear_status_hook()` |
| `dstu_sync::cloud_storage::traits::set_cancel_token` | fn | `crates/dstu-sync/src/cloud_storage/traits.rs:81` | L20-sync 1/0 | `pub fn set_cancel_token(token: tokio_util::sync::CancellationToken)` |
| `dstu_sync::cloud_storage::traits::set_status_hook` | fn | `crates/dstu-sync/src/cloud_storage/traits.rs:44` | L20-sync 1/0 | `pub fn set_status_hook(hook: StatusHook)` |
| `dstu_sync::cloud_storage::traits::FileInfo` | struct | `crates/dstu-sync/src/cloud_storage/traits.rs:145` | L20-sync 0/18<br>L22-app-commands 0/72 | `pub struct FileInfo` |
| `dstu_sync::cloud_storage::traits::Result` | type | `crates/dstu-sync/src/cloud_storage/traits.rs:18` | L20-sync 0/36 | `pub type Result<T> = std::result::Result<T, AppError>` |
| `dstu_sync::cloud_storage::repo_check::RepoCheckStatus` | enum | `crates/dstu-sync/src/cloud_storage/repo_check.rs:95` | L22-app-commands 0/13 | `pub enum RepoCheckStatus` |
| `dstu_sync::cloud_storage::delta_gc::sweep_gc_candidates` | fn | `crates/dstu-sync/src/cloud_storage/delta_gc.rs:578` | L22-app-commands 0/12 | `pub async fn sweep_gc_candidates( storage: Arc<dyn CloudStorage>, params: GcParams<'_>, ) -> Result<GcSweepResult>` |
| `dstu_sync::cloud_storage::delta_upload::BACKUP_V2_OBJECTS_PREFIX` | const | `crates/dstu-sync/src/cloud_storage/delta_upload.rs:72` | L22-app-commands 0/12 | `pub const BACKUP_V2_OBJECTS_PREFIX: &str = "backup-v2/objects/"` |
| `dstu_sync::cloud_storage::repo_check::RepoCheckProblemKind` | enum | `crates/dstu-sync/src/cloud_storage/repo_check.rs:67` | L22-app-commands 0/12 | `pub enum RepoCheckProblemKind` |
| `dstu_sync::cloud_storage::traits::ListOutcome` | struct | `crates/dstu-sync/src/cloud_storage/traits.rs:164` | L22-app-commands 0/12 | `pub struct ListOutcome` |
| `dstu_sync::cloud_storage::backup_lease::BACKUP_REPO_LEASE_PREFIX` | const | `crates/dstu-sync/src/cloud_storage/backup_lease.rs:42` | L22-app-commands 0/11 | `pub const BACKUP_REPO_LEASE_PREFIX: &str = "backup-v2/locks/"` |
| `dstu_sync::cloud_storage::delta_gc::collect_gc_candidates` | fn | `crates/dstu-sync/src/cloud_storage/delta_gc.rs:464` | L22-app-commands 0/11 | `pub async fn collect_gc_candidates( storage: Arc<dyn CloudStorage>, params: GcParams<'_>, ) -> Result<GcCollectResult>` |
| `dstu_sync::cloud_storage::sync_lease::acquire_sync_target_lease_with_ttl` | fn | `crates/dstu-sync/src/cloud_storage/sync_lease.rs:419` | L22-app-commands 0/11 | `pub async fn acquire_sync_target_lease_with_ttl( storage: Arc<dyn CloudStorage>, holder_device_id: &str, ttl: Duration, ) -> Result<SyncTargetLeaseGuard>` |
| `dstu_sync::cloud_storage::delta_format::SnapshotDescriptorV2` | struct | `crates/dstu-sync/src/cloud_storage/delta_format.rs:64` | L22-app-commands 0/10 | `pub struct SnapshotDescriptorV2` |
| `dstu_sync::cloud_storage::delta_gc::BACKUP_V2_GC_CANDIDATES_PREFIX` | const | `crates/dstu-sync/src/cloud_storage/delta_gc.rs:86` | L22-app-commands 0/9 | `pub const BACKUP_V2_GC_CANDIDATES_PREFIX: &str = "backup-v2/gc/candidates/"` |
| `dstu_sync::cloud_storage::delta_upload::device_index_key` | fn | `crates/dstu-sync/src/cloud_storage/delta_upload.rs:324` | L22-app-commands 0/9 | `pub fn device_index_key(device_id: &str) -> String` |
| `dstu_sync::cloud_storage::backup_lease::acquire_backup_repo_lease_with_ttl` | fn | `crates/dstu-sync/src/cloud_storage/backup_lease.rs:399` | L22-app-commands 0/8 | `pub async fn acquire_backup_repo_lease_with_ttl( storage: Arc<dyn CloudStorage>, holder_device_id: &str, ttl: Duration, ) -> Result<BackupRepoLeaseGuard>` |
| `dstu_sync::cloud_storage::backup_lease::BACKUP_LEASE_HELD_ERROR_CODE` | const | `crates/dstu-sync/src/cloud_storage/backup_lease.rs:44` | L22-app-commands 0/8 | `pub const BACKUP_LEASE_HELD_ERROR_CODE: &str = "E_BACKUP_LEASE_HELD"` |
| `dstu_sync::cloud_storage::sync_manager::CloudSyncManager` | struct | `crates/dstu-sync/src/cloud_storage/sync_manager.rs:276` | L22-app-commands 0/8 | `pub struct CloudSyncManager` |
| `dstu_sync::cloud_storage::sync_lease::SYNC_LEASE_HELD_ERROR_CODE` | const | `crates/dstu-sync/src/cloud_storage/sync_lease.rs:31` | L22-app-commands 0/7 | `pub const SYNC_LEASE_HELD_ERROR_CODE: &str = "E_SYNC_LEASE_HELD"` |
| `dstu_sync::cloud_storage::backup_lease::BackupRepoLease` | struct | `crates/dstu-sync/src/cloud_storage/backup_lease.rs:58` | L22-app-commands 0/6 | `pub struct BackupRepoLease` |
| `dstu_sync::cloud_storage::delta_gc::GcCandidateV2` | struct | `crates/dstu-sync/src/cloud_storage/delta_gc.rs:157` | L22-app-commands 0/6 | `pub struct GcCandidateV2` |
| `dstu_sync::cloud_storage::delta_format::BackupV2RepoConfig` | struct | `crates/dstu-sync/src/cloud_storage/delta_format.rs:87` | L22-app-commands 0/5 | `pub struct BackupV2RepoConfig` |
| `dstu_sync::cloud_storage::delta_format::SnapshotDescriptorV2::decode` | method | `crates/dstu-sync/src/cloud_storage/delta_format.rs:239` | L22-app-commands 0/5 | `pub fn decode(bytes: &[u8]) -> Result<Self>` |
| `dstu_sync::cloud_storage::delta_upload::PublishResult` | struct | `crates/dstu-sync/src/cloud_storage/delta_upload.rs:106` | L22-app-commands 0/5 | `pub struct PublishResult` |
| `dstu_sync::cloud_storage::sync_lease::SYNC_TARGET_LEASE_PREFIX` | const | `crates/dstu-sync/src/cloud_storage/sync_lease.rs:29` | L22-app-commands 0/5 | `pub const SYNC_TARGET_LEASE_PREFIX: &str = "data_governance/locks/sync-target"` |
| `dstu_sync::cloud_storage::backup_lease::BACKUP_REPO_LEASE_FORMAT_VERSION` | const | `crates/dstu-sync/src/cloud_storage/backup_lease.rs:48` | L22-app-commands 0/4 | `pub const BACKUP_REPO_LEASE_FORMAT_VERSION: u32 = 1` |
| `dstu_sync::cloud_storage::delta_upload::BACKUP_V2_CONFIG_KEY` | const | `crates/dstu-sync/src/cloud_storage/delta_upload.rs:78` | L22-app-commands 0/4 | `pub const BACKUP_V2_CONFIG_KEY: &str = "backup-v2/config.dsbk"` |
| `dstu_sync::cloud_storage::delta_upload::BACKUP_V2_MANIFESTS_PREFIX` | const | `crates/dstu-sync/src/cloud_storage/delta_upload.rs:76` | L22-app-commands 0/4 | `pub const BACKUP_V2_MANIFESTS_PREFIX: &str = "backup-v2/manifests/"` |
| `dstu_sync::cloud_storage::delta_upload::BACKUP_V2_SNAPSHOTS_PREFIX` | const | `crates/dstu-sync/src/cloud_storage/delta_upload.rs:74` | L22-app-commands 0/4 | `pub const BACKUP_V2_SNAPSHOTS_PREFIX: &str = "backup-v2/snapshots/"` |
| `dstu_sync::cloud_storage::delta_format::SnapshotFileRefV2` | struct | `crates/dstu-sync/src/cloud_storage/delta_format.rs:45` | L22-app-commands 0/3 | `pub struct SnapshotFileRefV2` |
| `dstu_sync::cloud_storage::delta_upload::BackupV2DeviceIndex::decode` | method | `crates/dstu-sync/src/cloud_storage/delta_upload.rs:315` | L22-app-commands 0/3 | `pub fn decode(bytes: &[u8]) -> Result<Self>` |
| `dstu_sync::cloud_storage::delta_upload::publish_verified_staging` | fn | `crates/dstu-sync/src/cloud_storage/delta_upload.rs:568` | L22-app-commands 0/3 | `pub async fn publish_verified_staging( storage: Arc<dyn CloudStorage>, staging_root: &Path, params: PublishParams<'_>, ) -> Result<PublishResult>` |
| `dstu_sync::cloud_storage::delta_upload::PublishParams` | struct | `crates/dstu-sync/src/cloud_storage/delta_upload.rs:90` | L22-app-commands 0/3 | `pub struct PublishParams<'a>` |
| `dstu_sync::cloud_storage::sync_lease::SyncTargetLease` | struct | `crates/dstu-sync/src/cloud_storage/sync_lease.rs:51` | L22-app-commands 0/3 | `pub struct SyncTargetLease` |
| `dstu_sync::cloud_storage::traits::ListOutcome::complete` | method | `crates/dstu-sync/src/cloud_storage/traits.rs:171` | L22-app-commands 0/3 | `pub fn complete(files: Vec<FileInfo>) -> Self` |
| `dstu_sync::cloud_storage::delta_format::BackupV2RepoConfig::decode` | method | `crates/dstu-sync/src/cloud_storage/delta_format.rs:279` | L22-app-commands 0/2 | `pub fn decode(bytes: &[u8]) -> Result<Self>` |
| `dstu_sync::cloud_storage::delta_format::DELTA_FORMAT_VERSION` | const | `crates/dstu-sync/src/cloud_storage/delta_format.rs:29` | L22-app-commands 0/2 | `pub const DELTA_FORMAT_VERSION: u32 = 2` |
| `dstu_sync::cloud_storage::delta_gc::GC_CANDIDATE_FORMAT` | const | `crates/dstu-sync/src/cloud_storage/delta_gc.rs:88` | L22-app-commands 0/2 | `pub const GC_CANDIDATE_FORMAT: &str = "backup-v2-gc-candidate"` |
| `dstu_sync::cloud_storage::delta_gc::GC_CANDIDATE_FORMAT_VERSION` | const | `crates/dstu-sync/src/cloud_storage/delta_gc.rs:90` | L22-app-commands 0/2 | `pub const GC_CANDIDATE_FORMAT_VERSION: u32 = 2` |
| `dstu_sync::cloud_storage::delta_gc::GcParams` | struct | `crates/dstu-sync/src/cloud_storage/delta_gc.rs:96` | L22-app-commands 0/2 | `pub struct GcParams<'a>` |
| `dstu_sync::cloud_storage::delta_upload::BackupV2DeviceIndex` | struct | `crates/dstu-sync/src/cloud_storage/delta_upload.rs:161` | L22-app-commands 0/2 | `pub struct BackupV2DeviceIndex` |
| `dstu_sync::cloud_storage::sync_manager::EncryptionMarker` | struct | `crates/dstu-sync/src/cloud_storage/sync_manager.rs:164` | L22-app-commands 0/2 | `pub struct EncryptionMarker` |
| `dstu_sync::cloud_storage::traits::DownloadProgressCallback` | type | `crates/dstu-sync/src/cloud_storage/traits.rs:24` | L22-app-commands 0/2 | `pub type DownloadProgressCallback = Box<dyn Fn(u64, u64) + Send + Sync>` |
| `dstu_sync::cloud_storage::backup_lease::DEFAULT_BACKUP_LEASE_TTL` | const | `crates/dstu-sync/src/cloud_storage/backup_lease.rs:46` | L22-app-commands 0/1 | `pub const DEFAULT_BACKUP_LEASE_TTL: Duration = Duration::from_secs(10 * 60)` |
| `dstu_sync::cloud_storage::delta_format::BACKUP_V2_FORMAT` | const | `crates/dstu-sync/src/cloud_storage/delta_format.rs:27` | L22-app-commands 0/1 | `pub const BACKUP_V2_FORMAT: &str = "backup-v2"` |
| `dstu_sync::cloud_storage::delta_format::MAX_OBJECT_KEY_BYTES` | const | `crates/dstu-sync/src/cloud_storage/delta_format.rs:35` | L22-app-commands 0/1 | `pub const MAX_OBJECT_KEY_BYTES: usize = 512` |
| `dstu_sync::cloud_storage::delta_format::SNAPSHOT_V2_FORMAT` | const | `crates/dstu-sync/src/cloud_storage/delta_format.rs:25` | L22-app-commands 0/1 | `pub const SNAPSHOT_V2_FORMAT: &str = "snapshot-v2"` |
| `dstu_sync::cloud_storage::delta_gc::DEFAULT_GC_GRACE` | const | `crates/dstu-sync/src/cloud_storage/delta_gc.rs:93` | L22-app-commands 0/1 | `pub const DEFAULT_GC_GRACE: Duration = Duration::from_secs(60 * 60)` |
| `dstu_sync::cloud_storage::delta_gc::GcCandidateV2::decode` | method | `crates/dstu-sync/src/cloud_storage/delta_gc.rs:230` | L22-app-commands 0/1 | `pub fn decode(bytes: &[u8]) -> Result<Self>` |
| `dstu_sync::cloud_storage::delta_restore::restore_snapshot_to_staging` | fn | `crates/dstu-sync/src/cloud_storage/delta_restore.rs:521` | L22-app-commands 0/1 | `pub async fn restore_snapshot_to_staging( storage: Arc<dyn CloudStorage>, dest_staging: &Path, params: RestoreParams<'_>, ) -> Result<RestoreResult>` |
| `dstu_sync::cloud_storage::delta_restore::RestoreParams` | struct | `crates/dstu-sync/src/cloud_storage/delta_restore.rs:85` | L22-app-commands 0/1 | `pub struct RestoreParams<'a>` |
| `dstu_sync::cloud_storage::delta_restore::RestoreResult` | struct | `crates/dstu-sync/src/cloud_storage/delta_restore.rs:102` | L22-app-commands 0/1 | `pub struct RestoreResult` |
| `dstu_sync::cloud_storage::delta_upload::DEFAULT_BACKUP_V2_MAX_VERSIONS` | const | `crates/dstu-sync/src/cloud_storage/delta_upload.rs:83` | L22-app-commands 0/1 | `pub const DEFAULT_BACKUP_V2_MAX_VERSIONS: usize = 10` |
| `dstu_sync::cloud_storage::sync_lease::SYNC_TARGET_LEASE_FORMAT_VERSION` | const | `crates/dstu-sync/src/cloud_storage/sync_lease.rs:41` | L22-app-commands 0/1 | `pub const SYNC_TARGET_LEASE_FORMAT_VERSION: u32 = 1` |
| `dstu_sync::cloud_storage::sync_manager::BackupVersion` | struct | `crates/dstu-sync/src/cloud_storage/sync_manager.rs:107` | L22-app-commands 0/1 | `pub struct BackupVersion` |

### 引用点样例

- `dstu_sync::cloud_storage::traits::CloudStorage` — L20-sync: `crates/dstu-sync/src/data_governance/sync/mod.rs:1000`, `crates/dstu-sync/src/data_governance/sync/mod.rs:1037`, `crates/dstu-sync/src/data_governance/sync/mod.rs:1574`, `crates/dstu-sync/src/data_governance/sync/mod.rs:1670`；L22-app-commands: `tests/sync_r10_chaos_idempotent.rs:37`, `tests/sync_r10_chaos_mixed_e2ee.rs:62`, `tests/sync_r10_chaos_truncation.rs:85`, `tests/sync_r10_download.rs:106`
- `dstu_sync::cloud_storage::config::CloudStorageConfig` — L21-backup-governance: `crates/dstu-sync/src/cloud_config_commands.rs:429`, `crates/dstu-sync/src/cloud_config_commands.rs:435`, `crates/dstu-sync/src/cloud_config_commands.rs:448`, `crates/dstu-sync/src/cloud_config_commands.rs:468`；L20-sync: `src/data_governance/commands_sync.rs:36`, `src/data_governance/commands_sync.rs:68`, `src/data_governance/commands_sync.rs:1284`, `src/data_governance/commands_sync.rs:1589`；F4-security: `tests/cloud_half_configured_credentials_tests.rs:26`, `tests/cloud_half_configured_credentials_tests.rs:27`, `tests/cloud_half_configured_credentials_tests.rs:108`, `tests/cloud_half_configured_credentials_tests.rs:142`；L22-app-commands: `tests/sync_r10_provider_contract.rs:154`, `tests/sync_r10_provider_contract.rs:155`
- `dstu_sync::cloud_storage::is_cloud_rate_limited` — L20-sync: `crates/dstu-sync/src/data_governance/sync/mod.rs:144`, `crates/dstu-sync/src/data_governance/sync/mod.rs:2545`, `crates/dstu-sync/src/data_governance/sync/mod.rs:2595`, `crates/dstu-sync/src/data_governance/sync/mod.rs:2628`
- `dstu_sync::cloud_storage::create_storage` — L21-backup-governance: `crates/dstu-sync/src/cloud_config_commands.rs:794`；L20-sync: `src/data_governance/commands_sync.rs:71`, `src/data_governance/commands_sync.rs:1321`, `src/data_governance/commands_sync.rs:1689`, `src/data_governance/commands_sync.rs:2993`；F4-security: `tests/cloud_half_configured_credentials_tests.rs:78`, `tests/cloud_half_configured_credentials_tests.rs:103`, `tests/cloud_half_configured_credentials_tests.rs:134`, `tests/cloud_half_configured_credentials_tests.rs:166`；L22-app-commands: `tests/sync_r10_provider_contract.rs:171`
- `dstu_sync::cloud_storage::sync_e2ee_error` — L20-sync: `crates/dstu-sync/src/data_governance/sync/mod.rs:949`, `crates/dstu-sync/src/data_governance/sync/mod.rs:954`, `crates/dstu-sync/src/data_governance/sync/mod.rs:961`, `crates/dstu-sync/src/data_governance/sync/mod.rs:1015`
- `dstu_sync::cloud_storage::config::StorageProvider` — L21-backup-governance: `crates/dstu-sync/src/cloud_config_commands.rs:10`, `crates/dstu-sync/src/cloud_config_commands.rs:436`, `crates/dstu-sync/src/cloud_config_commands.rs:449`, `crates/dstu-sync/src/cloud_config_commands.rs:469`；F4-security: `tests/cloud_half_configured_credentials_tests.rs:19`, `tests/cloud_half_configured_credentials_tests.rs:28`, `tests/cloud_half_configured_credentials_tests.rs:109`, `tests/cloud_half_configured_credentials_tests.rs:143`；L22-app-commands: `tests/sync_r10_provider_contract.rs:23`, `tests/sync_r10_provider_contract.rs:156`
- `dstu_sync::cloud_storage::config::PlatformStorageCapabilities` — L21-backup-governance: `crates/dstu-sync/src/cloud_config_commands.rs:316`, `crates/dstu-sync/src/cloud_config_commands.rs:502`, `crates/dstu-sync/src/cloud_config_commands.rs:530`
- `dstu_sync::cloud_storage::config::PlatformStorageCapabilities::current` — L21-backup-governance: `crates/dstu-sync/src/cloud_config_commands.rs:307`, `crates/dstu-sync/src/cloud_config_commands.rs:494`, `crates/dstu-sync/src/cloud_config_commands.rs:523`
- `dstu_sync::cloud_storage::SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE` — L20-sync: `crates/dstu-sync/src/data_governance/sync/mod.rs:962`, `crates/dstu-sync/src/data_governance/sync/mod.rs:1016`, `crates/dstu-sync/src/data_governance/sync/mod.rs:10348`
- `dstu_sync::cloud_storage::traits::is_sync_cancelled` — L20-sync: `crates/dstu-sync/src/data_governance/sync/mod.rs:2649`, `crates/dstu-sync/src/data_governance/sync/mod.rs:10342`, `src/data_governance/commands_sync.rs:3312`
- `dstu_sync::cloud_storage::resume::cleanup_stale_parts` — L20-sync: `crates/dstu-sync/src/data_governance/sync/mod.rs:10365`, `crates/dstu-sync/src/data_governance/sync/mod.rs:10410`
- `dstu_sync::cloud_storage::resume::content_keyed_part_path` — L20-sync: `crates/dstu-sync/src/data_governance/sync/mod.rs:10361`, `crates/dstu-sync/src/data_governance/sync/mod.rs:10409`
- `dstu_sync::cloud_storage::resume::get_file_with_optional_resume` — L20-sync: `crates/dstu-sync/src/data_governance/sync/mod.rs:10366`, `crates/dstu-sync/src/data_governance/sync/mod.rs:10411`
- `dstu_sync::cloud_storage::SYNC_E2EE_PASSWORD_REQUIRED_CODE` — L20-sync: `crates/dstu-sync/src/data_governance/sync/mod.rs:955`, `crates/dstu-sync/src/data_governance/sync/mod.rs:10392`
- `dstu_sync::cloud_storage::SYNC_E2EE_WRONG_PASSWORD_CODE` — L20-sync: `crates/dstu-sync/src/data_governance/sync/mod.rs:950`, `crates/dstu-sync/src/data_governance/sync/mod.rs:10438`
- `dstu_sync::cloud_storage::sync_lease::acquire_sync_target_lease` — L20-sync: `src/data_governance/commands_sync.rs:1714`, `src/data_governance/commands_sync.rs:3027`
- `dstu_sync::cloud_storage::repo_check::run_repo_check` — L20-sync: `src/data_governance/commands_sync.rs:5163`；L22-app-commands: `tests/sync_r11_repo_check.rs:352`, `tests/sync_r11_repo_check.rs:371`, `tests/sync_r11_repo_check.rs:397`, `tests/sync_r11_repo_check.rs:432`
- `dstu_sync::cloud_storage::sync_manager::CloudSyncManager::new` — L20-sync: `src/data_governance/commands_sync.rs:60`；L22-app-commands: `tests/sync_r10_download.rs:321`, `tests/sync_r10_download.rs:357`, `tests/sync_r10_verifier.rs:142`, `tests/sync_r11_repo_check.rs:305`
- `dstu_sync::cloud_storage::config::WebDavConfig` — L21-backup-governance: `crates/dstu-sync/src/cloud_config_commands.rs:437`, `crates/dstu-sync/src/cloud_credentials.rs:164`, `crates/dstu-sync/src/cloud_credentials.rs:211`, `crates/dstu-sync/src/cloud_credentials.rs:234`；F4-security: `tests/cloud_half_configured_credentials_tests.rs:29`；L22-app-commands: `tests/sync_r10_provider_contract.rs:157`
- `dstu_sync::cloud_storage::config::FtpConfig` — L21-backup-governance: `crates/dstu-sync/src/cloud_config_commands.rs:472`, `crates/dstu-sync/src/cloud_credentials.rs:177`, `crates/dstu-sync/src/cloud_credentials.rs:284`；F4-security: `tests/cloud_half_configured_credentials_tests.rs:146`
- `dstu_sync::cloud_storage::delta_format::MAX_LOGICAL_PATH_BYTES` — L21-backup-governance: `crates/dstu-sync/src/data_governance/backup/delta_inventory.rs:101`；L22-app-commands: `tests/sync_r12_delta_format.rs:249`, `tests/sync_r12_delta_format.rs:250`, `tests/sync_r12_delta_format.rs:255`
- `dstu_sync::cloud_storage::delta_format::MAX_SNAPSHOT_FILES` — L21-backup-governance: `crates/dstu-sync/src/data_governance/backup/delta_inventory.rs:206`；L22-app-commands: `tests/sync_r12_delta_format.rs:225`, `tests/sync_r12_delta_format.rs:226`, `tests/sync_r12_delta_format.rs:230`
- `dstu_sync::cloud_storage::config::S3Config` — L21-backup-governance: `crates/dstu-sync/src/cloud_config_commands.rs:451`, `crates/dstu-sync/src/cloud_credentials.rs:169`；F4-security: `tests/cloud_half_configured_credentials_tests.rs:111`
- `dstu_sync::cloud_storage::repo_check::RepoCheckReport` — L20-sync: `src/data_governance/commands_sync.rs:5154`；L22-app-commands: `tests/sync_r11_repo_check.rs:338`
- `dstu_sync::cloud_storage::resume::persist_download` — L20-sync: `crates/dstu-sync/src/data_governance/sync/mod.rs:10375`
- `dstu_sync::cloud_storage::traits::clear_cancel_token` — L20-sync: `src/data_governance/commands_sync.rs:2850`
- `dstu_sync::cloud_storage::traits::clear_status_hook` — L20-sync: `src/data_governance/commands_sync.rs:2849`
- `dstu_sync::cloud_storage::traits::set_cancel_token` — L20-sync: `src/data_governance/commands_sync.rs:2835`
- `dstu_sync::cloud_storage::traits::set_status_hook` — L20-sync: `src/data_governance/commands_sync.rs:2839`
- `dstu_sync::cloud_storage::traits::FileInfo` — L20-sync: `crates/dstu-sync/src/data_governance/sync/mod.rs:17897`, `crates/dstu-sync/src/data_governance/sync/mod.rs:17904`, `crates/dstu-sync/src/data_governance/sync/mod.rs:17928`, `crates/dstu-sync/src/data_governance/sync/mod.rs:17929`；L22-app-commands: `tests/sync_r10_chaos_idempotent.rs:58`, `tests/sync_r10_chaos_idempotent.rs:65`, `tests/sync_r10_chaos_idempotent.rs:79`, `tests/sync_r10_chaos_idempotent.rs:80`
- `dstu_sync::cloud_storage::traits::Result` — L20-sync: `crates/dstu-sync/src/data_governance/sync/mod.rs:17884`, `crates/dstu-sync/src/data_governance/sync/mod.rs:17887`, `crates/dstu-sync/src/data_governance/sync/mod.rs:17894`, `crates/dstu-sync/src/data_governance/sync/mod.rs:17897`
- `dstu_sync::cloud_storage::repo_check::RepoCheckStatus` — L22-app-commands: `tests/sync_r11_repo_check.rs:354`, `tests/sync_r11_repo_check.rs:373`, `tests/sync_r11_repo_check.rs:399`, `tests/sync_r11_repo_check.rs:434`
- `dstu_sync::cloud_storage::delta_gc::sweep_gc_candidates` — L22-app-commands: `tests/sync_r12_delta_gc.rs:436`, `tests/sync_r12_delta_gc.rs:521`, `tests/sync_r12_delta_gc.rs:538`, `tests/sync_r12_delta_gc.rs:600`
- `dstu_sync::cloud_storage::delta_upload::BACKUP_V2_OBJECTS_PREFIX` — L22-app-commands: `tests/sync_r12_delta_gc.rs:582`, `tests/sync_r12_delta_upload.rs:354`, `tests/sync_r12_delta_upload.rs:469`, `tests/sync_r12_delta_upload.rs:556`
- `dstu_sync::cloud_storage::repo_check::RepoCheckProblemKind` — L22-app-commands: `tests/sync_r11_repo_check.rs:339`, `tests/sync_r11_repo_check.rs:375`, `tests/sync_r11_repo_check.rs:437`, `tests/sync_r11_repo_check.rs:442`
- `dstu_sync::cloud_storage::traits::ListOutcome` — L22-app-commands: `tests/sync_r10_chaos_truncation.rs:110`, `tests/sync_r10_chaos_truncation.rs:113`, `tests/sync_r11_lease.rs:148`, `tests/sync_r11_lease.rs:165`
- `dstu_sync::cloud_storage::backup_lease::BACKUP_REPO_LEASE_PREFIX` — L22-app-commands: `tests/sync_r12_backup_lease.rs:78`, `tests/sync_r12_backup_lease.rs:88`, `tests/sync_r12_backup_lease.rs:117`, `tests/sync_r12_backup_lease.rs:170`
- `dstu_sync::cloud_storage::delta_gc::collect_gc_candidates` — L22-app-commands: `tests/sync_r12_delta_gc.rs:422`, `tests/sync_r12_delta_gc.rs:491`, `tests/sync_r12_delta_gc.rs:505`, `tests/sync_r12_delta_gc.rs:572`
- `dstu_sync::cloud_storage::sync_lease::acquire_sync_target_lease_with_ttl` — L22-app-commands: `tests/sync_r11_lease.rs:196`, `tests/sync_r11_lease.rs:197`, `tests/sync_r11_lease.rs:233`, `tests/sync_r11_lease.rs:238`
- `dstu_sync::cloud_storage::delta_format::SnapshotDescriptorV2` — L22-app-commands: `tests/sync_r12_delta_format.rs:27`, `tests/sync_r12_delta_format.rs:29`, `tests/sync_r12_delta_format.rs:112`, `tests/sync_r12_delta_format.rs:150`
- `dstu_sync::cloud_storage::delta_gc::BACKUP_V2_GC_CANDIDATES_PREFIX` — L22-app-commands: `tests/sync_r12_delta_gc.rs:382`, `tests/sync_r12_delta_gc.rs:464`, `tests/sync_r12_delta_gc.rs:532`, `tests/sync_r12_delta_gc.rs:548`
- `dstu_sync::cloud_storage::delta_upload::device_index_key` — L22-app-commands: `tests/sync_r12_delta_gc.rs:358`, `tests/sync_r12_delta_gc.rs:457`, `tests/sync_r12_delta_gc.rs:780`, `tests/sync_r12_delta_restore.rs:670`
- `dstu_sync::cloud_storage::backup_lease::acquire_backup_repo_lease_with_ttl` — L22-app-commands: `tests/sync_r12_backup_lease.rs:214`, `tests/sync_r12_backup_lease.rs:215`, `tests/sync_r12_backup_lease.rs:262`, `tests/sync_r12_backup_lease.rs:267`
- `dstu_sync::cloud_storage::backup_lease::BACKUP_LEASE_HELD_ERROR_CODE` — L22-app-commands: `tests/sync_r12_backup_lease.rs:229`, `tests/sync_r12_backup_lease.rs:271`, `tests/sync_r12_backup_lease.rs:318`, `tests/sync_r12_backup_lease.rs:364`
- `dstu_sync::cloud_storage::sync_manager::CloudSyncManager` — L22-app-commands: `tests/sync_r10_download.rs:236`, `tests/sync_r10_verifier.rs:141`, `tests/sync_r10_verifier.rs:152`, `tests/sync_r11_repo_check.rs:304`
- `dstu_sync::cloud_storage::sync_lease::SYNC_LEASE_HELD_ERROR_CODE` — L22-app-commands: `tests/sync_r11_lease.rs:211`, `tests/sync_r11_lease.rs:242`, `tests/sync_r11_lease.rs:264`, `tests/sync_r11_lease.rs:312`
- `dstu_sync::cloud_storage::backup_lease::BackupRepoLease` — L22-app-commands: `tests/sync_r12_backup_lease.rs:104`, `tests/sync_r12_backup_lease.rs:105`, `tests/sync_r12_backup_lease.rs:116`, `tests/sync_r12_delta_gc.rs:200`
- `dstu_sync::cloud_storage::delta_gc::GcCandidateV2` — L22-app-commands: `tests/sync_r12_delta_gc.rs:380`, `tests/sync_r12_delta_gc.rs:836`, `tests/sync_r12_delta_gc.rs:844`, `tests/sync_r12_delta_gc.rs:849`
- `dstu_sync::cloud_storage::delta_format::BackupV2RepoConfig` — L22-app-commands: `tests/sync_r12_delta_format.rs:40`, `tests/sync_r12_delta_format.rs:41`, `tests/sync_r12_delta_format.rs:126`, `tests/sync_r12_delta_format.rs:165`
- `dstu_sync::cloud_storage::delta_format::SnapshotDescriptorV2::decode` — L22-app-commands: `tests/sync_r12_delta_format.rs:60`, `tests/sync_r12_delta_format.rs:66`, `tests/sync_r12_delta_gc.rs:353`, `tests/sync_r12_delta_restore.rs:353`
- `dstu_sync::cloud_storage::delta_upload::PublishResult` — L22-app-commands: `tests/sync_r12_delta_gc.rs:307`, `tests/sync_r12_delta_gc.rs:327`, `tests/sync_r12_delta_restore.rs:261`, `tests/sync_r12_delta_upload.rs:272`
- `dstu_sync::cloud_storage::sync_lease::SYNC_TARGET_LEASE_PREFIX` — L22-app-commands: `tests/sync_r11_lease.rs:70`, `tests/sync_r11_lease.rs:99`, `tests/sync_r11_lease.rs:152`, `tests/sync_r12_backup_lease.rs:362`
- `dstu_sync::cloud_storage::backup_lease::BACKUP_REPO_LEASE_FORMAT_VERSION` — L22-app-commands: `tests/sync_r12_backup_lease.rs:106`, `tests/sync_r12_delta_gc.rs:201`, `tests/sync_r12_delta_restore.rs:366`, `tests/sync_r12_delta_upload.rs:320`
- `dstu_sync::cloud_storage::delta_upload::BACKUP_V2_CONFIG_KEY` — L22-app-commands: `tests/sync_r12_delta_gc.rs:456`, `tests/sync_r12_delta_gc.rs:860`, `tests/sync_r12_delta_upload.rs:391`, `tests/sync_r12_delta_upload.rs:733`
- `dstu_sync::cloud_storage::delta_upload::BACKUP_V2_MANIFESTS_PREFIX` — L22-app-commands: `tests/sync_r12_delta_gc.rs:571`, `tests/sync_r12_delta_gc.rs:599`, `tests/sync_r12_delta_upload.rs:570`, `tests/sync_r12_delta_upload.rs:643`
- `dstu_sync::cloud_storage::delta_upload::BACKUP_V2_SNAPSHOTS_PREFIX` — L22-app-commands: `tests/sync_r12_delta_upload.rs:583`, `tests/sync_r12_delta_upload.rs:599`, `tests/sync_r12_delta_upload.rs:611`, `tests/sync_r12_delta_upload.rs:640`
- `dstu_sync::cloud_storage::delta_format::SnapshotFileRefV2` — L22-app-commands: `tests/sync_r12_delta_format.rs:17`, `tests/sync_r12_delta_format.rs:18`, `tests/sync_r12_delta_format.rs:27`
- `dstu_sync::cloud_storage::delta_upload::BackupV2DeviceIndex::decode` — L22-app-commands: `tests/sync_r12_delta_gc.rs:360`, `tests/sync_r12_delta_gc.rs:785`, `tests/sync_r12_delta_upload.rs:304`
- `dstu_sync::cloud_storage::delta_upload::publish_verified_staging` — L22-app-commands: `tests/sync_r12_delta_gc.rs:308`, `tests/sync_r12_delta_restore.rs:262`, `tests/sync_r12_delta_upload.rs:273`
- `dstu_sync::cloud_storage::delta_upload::PublishParams` — L22-app-commands: `tests/sync_r12_delta_gc.rs:311`, `tests/sync_r12_delta_restore.rs:265`, `tests/sync_r12_delta_upload.rs:276`
- 其余 22 个条目的引用点见 `draft.json`。

## 消费其他 lane

### F4-security（30 个条目，prod 576 / test 59）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_core::models::AppError::validation` | method | 152/0 | `crates/dstu-sync/src/cloud_storage/backup_lease.rs`, `crates/dstu-sync/src/cloud_storage/bad_object.rs`, `crates/dstu-sync/src/cloud_storage/delta_format.rs` 等 16 个 |
| `dstu_core::models::AppError::network` ? | method | 125/2 | `crates/dstu-sync/src/cloud_storage/backup_lease.rs`, `crates/dstu-sync/src/cloud_storage/delta_gc.rs`, `crates/dstu-sync/src/cloud_storage/delta_upload.rs` 等 11 个 |
| `dstu_core::models::AppError::file_system` ? | method | 122/7 | `crates/dstu-sync/src/cloud_storage/delta_restore.rs`, `crates/dstu-sync/src/cloud_storage/delta_upload.rs`, `crates/dstu-sync/src/cloud_storage/ftp.rs` 等 11 个 |
| `dstu_core::models::AppError::internal` | method | 55/0 | `crates/dstu-sync/src/cloud_storage/backup_lease.rs`, `crates/dstu-sync/src/cloud_storage/bad_object.rs`, `crates/dstu-sync/src/cloud_storage/delta_format.rs` 等 15 个 |
| `dstu_core::models::AppError` | struct | 27/30 | `crates/dstu-sync/src/cloud_storage/backup_lease.rs`, `crates/dstu-sync/src/cloud_storage/bad_object.rs`, `crates/dstu-sync/src/cloud_storage/delta_format.rs` 等 28 个 |
| `dstu_core::models::AppError::configuration` ? | method | 20/0 | `crates/dstu-sync/src/cloud_storage/mod.rs`, `crates/dstu-sync/src/cloud_storage/sync_manager.rs`, `crates/dstu-sync/src/cloud_storage/traits.rs` 等 5 个 |
| `dstu_core::models::AppError::conflict` | method | 18/0 | `crates/dstu-sync/src/cloud_storage/backup_lease.rs`, `crates/dstu-sync/src/cloud_storage/delta_upload.rs`, `crates/dstu-sync/src/cloud_storage/e2ee_claim.rs` 等 5 个 |
| `dstu_core::models::AppError::not_found` | method | 13/1 | `crates/dstu-sync/src/cloud_storage/ftp.rs`, `crates/dstu-sync/src/cloud_storage/resume.rs`, `crates/dstu-sync/src/cloud_storage/s3.rs` 等 7 个 |
| `dstu_security::crypto::backup_crypto::is_encrypted_backup` | fn | 10/3 | `crates/dstu-sync/src/cloud_storage/delta_gc.rs`, `crates/dstu-sync/src/cloud_storage/delta_restore.rs`, `crates/dstu-sync/src/cloud_storage/delta_upload.rs` 等 6 个 |
| `dstu_security::crypto::backup_crypto::FileCipherSession` | struct | 9/0 | `crates/dstu-sync/src/cloud_storage/delta_gc.rs`, `crates/dstu-sync/src/cloud_storage/delta_restore.rs`, `crates/dstu-sync/src/cloud_storage/delta_upload.rs` |
| `dstu_security::crypto::backup_crypto::DSBK_V2_HEADER_LEN` | const | 3/2 | `crates/dstu-sync/src/cloud_storage/repo_check.rs`, `crates/dstu-sync/src/cloud_storage/sync_manager.rs` |
| `dstu_security::crypto::backup_crypto::EncryptedRootMemory` | struct | 3/0 | `crates/dstu-sync/src/cloud_storage/sync_manager.rs` |
| `dstu_core::models::AppError::authentication` | method | 2/0 | `crates/dstu-sync/src/cloud_storage/ftp.rs` |
| `dstu_security::crypto::backup_crypto::decrypt_backup_file` | fn | 2/0 | `crates/dstu-sync/src/cloud_storage/mod.rs`, `crates/dstu-sync/src/cloud_storage/sync_manager.rs` |
| `dstu_security::crypto::backup_crypto::DSBK_GCM_TAG_LEN` | const | 2/0 | `crates/dstu-sync/src/cloud_storage/repo_check.rs` |
| `dstu_security::crypto::backup_crypto::EncryptedRootMemory::fingerprint` | method | 2/0 | `crates/dstu-sync/src/cloud_storage/sync_manager.rs` |
| `dstu_core::models::AppErrorType` | enum | 1/2 | `crates/dstu-sync/src/cloud_storage/mod.rs` |
| `dstu_security::crypto::backup_crypto::check_password_verifier` | fn | 1/2 | `crates/dstu-sync/src/cloud_storage/sync_manager.rs` |
| `dstu_security::crypto::backup_crypto::encrypt_backup_file` | fn | 1/2 | `crates/dstu-sync/src/cloud_storage/mod.rs`, `crates/dstu-sync/src/cloud_storage/repo_check.rs`, `tests/sync_r09_file_e2ee.rs` |
| `dstu_core::models::AppError::with_details` ? | method | 1/0 | `crates/dstu-sync/src/cloud_storage/mod.rs` |
| `dstu_security::crypto::backup_crypto::create_password_verifier` | fn | 1/0 | `crates/dstu-sync/src/cloud_storage/sync_manager.rs` |
| `dstu_security::crypto::backup_crypto::DSBK_MAGIC` | const | 1/0 | `crates/dstu-sync/src/cloud_storage/repo_check.rs` |
| `dstu_security::crypto::backup_crypto::DSBK_MAX_PLAINTEXT_CHUNK` | const | 1/0 | `crates/dstu-sync/src/cloud_storage/repo_check.rs` |
| `dstu_security::crypto::backup_crypto::DSBK_V1_HEADER_LEN` | const | 1/0 | `crates/dstu-sync/src/cloud_storage/repo_check.rs` |
| `dstu_security::crypto::backup_crypto::DSBK_V2_CHUNK_OFFSET` | const | 1/0 | `crates/dstu-sync/src/cloud_storage/repo_check.rs` |
| `dstu_security::crypto::backup_crypto::EncryptedRootMemory::at` | method | 1/0 | `crates/dstu-sync/src/cloud_storage/sync_manager.rs` |
| `dstu_security::crypto::backup_crypto::PasswordVerifier` | struct | 1/0 | `crates/dstu-sync/src/cloud_storage/sync_manager.rs` |
| `dstu_security::crypto::backup_crypto::encrypt_backup` | fn | 0/6 | `crates/dstu-sync/src/cloud_storage/sync_manager.rs`, `tests/sync_file_level_e2ee.rs`, `tests/sync_provider_contract_tests.rs` 等 4 个 |
| `dstu_security::crypto::backup_crypto::decrypt_backup` | fn | 0/1 | `tests/sync_r09_file_e2ee.rs` |
| `dstu_security::crypto::backup_crypto::FileCipherSession::with_params` | method | 0/1 | `crates/dstu-sync/src/cloud_storage/sync_manager.rs` |

### L21-backup-governance（28 个条目，prod 29 / test 69）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_sync::cloud_credentials::hydrate_cloud_config` | fn | 12/0 | `crates/dstu-sync/src/cloud_storage/mod.rs` |
| `dstu_sync::data_governance::backup::delta_inventory::InventoryEntry` | struct | 4/0 | `crates/dstu-sync/src/cloud_storage/delta_upload.rs` |
| `dstu_sync::cloud_config_commands::FTP_UNSUPPORTED_ON_ANDROID_CODE` ? | const | 2/10 | `crates/dstu-sync/src/cloud_storage/config.rs`, `crates/dstu-sync/src/cloud_storage/mod.rs`, `tests/sync_android_device_switch.rs` 等 4 个 |
| `dstu_sync::cloud_config_commands::FTP_UNSUPPORTED_ON_ANDROID_MESSAGE` ? | const | 2/7 | `crates/dstu-sync/src/cloud_storage/config.rs`, `crates/dstu-sync/src/cloud_storage/mod.rs`, `tests/sync_android_device_switch.rs` 等 4 个 |
| `dstu_sync::cloud_config_commands::S3_UNSUPPORTED_IN_BUILD_CODE` ? | const | 2/7 | `crates/dstu-sync/src/cloud_storage/config.rs`, `crates/dstu-sync/src/cloud_storage/mod.rs`, `tests/sync_android_device_switch.rs` 等 4 个 |
| `dstu_sync::cloud_config_commands::S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE` ? | const | 2/5 | `crates/dstu-sync/src/cloud_storage/config.rs`, `crates/dstu-sync/src/cloud_storage/mod.rs`, `tests/sync_android_device_switch.rs` 等 4 个 |
| `dstu_sync::data_governance::backup::delta_inventory::DeltaInventory` | struct | 2/0 | `crates/dstu-sync/src/cloud_storage/delta_upload.rs` |
| `dstu_sync::data_governance::backup::BackupError` | enum | 1/0 | `crates/dstu-sync/src/cloud_storage/delta_upload.rs` |
| `dstu_sync::data_governance::backup::delta_inventory::build_inventory_cross_checked` | fn | 1/0 | `crates/dstu-sync/src/cloud_storage/delta_upload.rs` |
| `dstu_sync::data_governance::backup::delta_inventory::diff` | fn | 1/0 | `crates/dstu-sync/src/cloud_storage/delta_upload.rs` |
| `dstu_sync::cloud_config_commands::CloudConfigSsotError` ? | enum | 0/6 | `tests/sync_android_device_switch.rs`, `tests/sync_android_restart.rs` |
| `dstu_sync::cloud_config_commands::SafeCloudStorageConfig` ? | enum | 0/6 | `tests/sync_android_device_switch.rs`, `tests/sync_android_restart.rs` |
| `dstu_sync::cloud_config_commands::load_cloud_config_ssot` ? | fn | 0/3 | `tests/sync_android_restart.rs` |
| `dstu_sync::cloud_config_commands::load_cloud_config_ssot_with_capabilities` ? | fn | 0/3 | `tests/sync_android_device_switch.rs` |
| `dstu_sync::cloud_config_commands::save_cloud_config_ssot_with_capabilities` ? | fn | 0/3 | `tests/sync_android_device_switch.rs` |
| `dstu_sync::cloud_config_commands::CLOUD_CONFIG_SSOT_SETTING_KEY` ? | const | 0/2 | `tests/sync_android_device_switch.rs`, `tests/sync_android_restart.rs` |
| `dstu_sync::cloud_config_commands::SafeFtpConfig` ? | struct | 0/2 | `tests/sync_android_device_switch.rs`, `tests/sync_android_restart.rs` |
| `dstu_sync::cloud_config_commands::save_cloud_config_ssot` ? | fn | 0/2 | `tests/sync_android_restart.rs` |
| `dstu_sync::data_governance::backup::BackupManager::new` | method | 0/2 | `tests/sync_android_device_switch.rs` |
| `dstu_sync::data_governance::backup::BackupManifest::load_from_file` | method | 0/2 | `tests/sync_android_device_switch.rs` |
| `dstu_sync::data_governance::backup::zip_export::import_backup_from_zip_with_password` | fn | 0/2 | `tests/sync_android_device_switch.rs` |
| `dstu_sync::cloud_config_commands::SafeS3Config` ? | struct | 0/1 | `tests/sync_android_device_switch.rs` |
| `dstu_sync::cloud_config_commands::SafeWebDavConfig` ? | struct | 0/1 | `tests/sync_android_restart.rs` |
| `dstu_sync::data_governance::backup::BackupManager` | struct | 0/1 | `tests/sync_android_device_switch.rs` |
| `dstu_sync::data_governance::backup::BackupManifest` | struct | 0/1 | `tests/sync_android_device_switch.rs` |
| `dstu_sync::data_governance::backup::zip_export::export_backup_to_zip` | fn | 0/1 | `tests/sync_android_device_switch.rs` |
| `dstu_sync::data_governance::backup::zip_export::import_backup_from_zip` | fn | 0/1 | `tests/sync_android_device_switch.rs` |
| `dstu_sync::data_governance::backup::zip_export::ZipExportOptions` | struct | 0/1 | `tests/sync_android_device_switch.rs` |

### F3-storage（22 个条目，prod 28 / test 75）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_storage::data_space::device_id::get_device_id` | fn | 6/0 | `crates/dstu-sync/src/cloud_storage/mod.rs` |
| `dstu_storage::data_space::device_id::normalize_device_id` | fn | 5/0 | `crates/dstu-sync/src/cloud_storage/delta_gc.rs`, `crates/dstu-sync/src/cloud_storage/delta_restore.rs`, `crates/dstu-sync/src/cloud_storage/delta_upload.rs` 等 5 个 |
| `dstu_storage::data_space::device_id::device_id_short_hash` | fn | 4/4 | `crates/dstu-sync/src/cloud_storage/mod.rs`, `crates/dstu-sync/src/cloud_storage/sync_manager.rs` |
| `dstu_storage::backup_common::calculate_file_hash` | fn | 3/2 | `crates/dstu-sync/src/cloud_storage/resume.rs`, `crates/dstu-sync/src/cloud_storage/s3.rs`, `crates/dstu-sync/src/cloud_storage/webdav.rs` 等 4 个 |
| `dstu_storage::backup_common::DataGovernanceOperationGuard::try_acquire` | method | 3/0 | `crates/dstu-sync/src/cloud_storage/mod.rs` |
| `dstu_storage::backup_common::DataGovernanceOperationKind` | enum | 3/0 | `crates/dstu-sync/src/cloud_storage/mod.rs` |
| `dstu_storage::data_space::get_data_space_manager` | fn | 1/2 | `crates/dstu-sync/src/cloud_storage/sync_manager.rs`, `tests/sync_r06_delete_resolve_tests.rs`, `tests/sync_r07_delete_resolve_lock_tests.rs` |
| `dstu_storage::data_space::device_id::generate_device_id_after_restore` | fn | 1/0 | `crates/dstu-sync/src/cloud_storage/mod.rs` |
| `dstu_storage::data_space::device_id::persist_device_id_after_restore` | fn | 1/0 | `crates/dstu-sync/src/cloud_storage/mod.rs` |
| `dstu_storage::data_space::device_id::rotate_device_id_after_restore` | fn | 1/0 | `crates/dstu-sync/src/cloud_storage/mod.rs` |
| `dstu_storage::data_space::Slot` | enum | 0/36 | `tests/sync_android_device_switch.rs`, `tests/sync_android_restart.rs` |
| `dstu_storage::data_space::DataSpaceManager::new` | method | 0/11 | `tests/sync_android_device_switch.rs`, `tests/sync_android_restart.rs` |
| `dstu_storage::data_space::init_data_space_manager` | fn | 0/4 | `tests/sync_android_device_switch.rs`, `tests/sync_android_restart.rs`, `tests/sync_r06_delete_resolve_tests.rs` 等 4 个 |
| `dstu_storage::migration::coordinator::MigrationCoordinator` | struct | 0/3 | `tests/sync_provider_contract_tests.rs`, `tests/sync_real_flow_smoke_tests.rs`, `tests/sync_schema_coverage_tests.rs` |
| `dstu_storage::migration::coordinator::MigrationCoordinator::new` | method | 0/3 | `tests/sync_provider_contract_tests.rs`, `tests/sync_real_flow_smoke_tests.rs`, `tests/sync_schema_coverage_tests.rs` |
| `dstu_storage::data_space::DataSpaceManager` | struct | 0/2 | `tests/sync_android_device_switch.rs`, `tests/sync_android_restart.rs` |
| `dstu_storage::database::Database` | struct | 0/2 | `tests/sync_android_device_switch.rs`, `tests/sync_android_restart.rs` |
| `dstu_storage::database::Database::new` ? | method | 0/2 | `tests/sync_android_device_switch.rs`, `tests/sync_android_restart.rs` |
| `dstu_storage::migration::ALL_MIGRATION_SETS` | const | 0/1 | `tests/sync_schema_coverage_tests.rs` |
| `dstu_storage::schema_registry::DatabaseId` ? | enum | 0/1 | `tests/sync_schema_coverage_tests.rs` |
| `dstu_storage::schema_registry::DatabaseId::all_ordered` ? | method | 0/1 | `tests/sync_schema_coverage_tests.rs` |
| `dstu_storage::schema_registry::DatabaseId::as_str` | method | 0/1 | `tests/sync_schema_coverage_tests.rs` |

### L13-vfs-api（1 个条目，prod 0 / test 2）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::question_sync_service::SyncConfig` | struct | 0/2 | `tests/sync_r07_autosync_pending_tests.rs` |

### L20-sync（57 个条目，prod 0 / test 1411）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_sync::data_governance::sync::ChangeOperation` ? | enum | 0/294 | `tests/sync_adversarial_tests.rs`, `tests/sync_chaos_tests.rs`, `tests/sync_integration_deep_tests.rs` 等 14 个 |
| `dstu_sync::data_governance::sync::SyncManager::apply_downloaded_changes` | method | 0/242 | `tests/sync_adversarial_tests.rs`, `tests/sync_chaos_tests.rs`, `tests/sync_integration_deep_tests.rs` 等 11 个 |
| `dstu_sync::data_governance::sync::SyncChangeWithData` | struct | 0/156 | `tests/sync_adversarial_tests.rs`, `tests/sync_chaos_tests.rs`, `tests/sync_integration_deep_tests.rs` 等 16 个 |
| `dstu_sync::data_governance::sync::SyncDirection` | enum | 0/119 | `tests/sync_file_level_e2ee.rs`, `tests/sync_provider_contract_tests.rs`, `tests/sync_r07_cross_platform_names_tests.rs` 等 8 个 |
| `dstu_sync::data_governance::sync::SyncManager::new` | method | 0/92 | `tests/sync_file_level_e2ee.rs`, `tests/sync_provider_contract_tests.rs`, `tests/sync_r07_cross_platform_names_tests.rs` 等 10 个 |
| `dstu_sync::data_governance::sync::conflict_resolver::ConflictPolicy` | enum | 0/65 | `tests/sync_adversarial_tests.rs`, `tests/sync_pathological_tests.rs`, `tests/sync_proptest.rs` 等 11 个 |
| `dstu_sync::data_governance::sync::SyncManager::apply_downloaded_changes_with_conflict_guard` | method | 0/55 | `tests/sync_adversarial_tests.rs`, `tests/sync_integration_deep_tests.rs`, `tests/sync_pathological_tests.rs` 等 11 个 |
| `dstu_sync::data_governance::sync::SyncManager` | struct | 0/52 | `tests/sync_adversarial_tests.rs`, `tests/sync_chaos_tests.rs`, `tests/sync_comprehensive_tests.rs` 等 23 个 |
| `dstu_sync::data_governance::sync::classification::sync_classification_registry` | fn | 0/35 | `tests/sync_comprehensive_tests.rs`, `tests/sync_real_flow_smoke_tests.rs`, `tests/sync_schema_coverage_tests.rs` |
| `dstu_sync::data_governance::sync::hlc::Hlc::new` | method | 0/31 | `tests/sync_integration_deep_tests.rs`, `tests/sync_pathological_tests.rs`, `tests/sync_real_business_tables_tests.rs` 等 5 个 |
| `dstu_sync::data_governance::sync::field_merge::merge_field` | fn | 0/28 | `tests/sync_comprehensive_tests.rs` |
| `dstu_sync::data_governance::sync::hlc::Hlc` | struct | 0/20 | `tests/sync_integration_deep_tests.rs`, `tests/sync_pathological_tests.rs`, `tests/sync_real_business_tables_tests.rs` 等 5 个 |
| `dstu_sync::data_governance::sync::SyncManager::with_encryption` | method | 0/20 | `tests/sync_file_level_e2ee.rs`, `tests/sync_provider_contract_tests.rs`, `tests/sync_r07_e2ee_wrong_password_tests.rs` 等 5 个 |
| `dstu_sync::data_governance::sync::classification::TableClassification` | struct | 0/18 | `tests/sync_comprehensive_tests.rs`, `tests/sync_real_flow_smoke_tests.rs`, `tests/sync_schema_coverage_tests.rs` |
| `dstu_sync::data_governance::sync::SyncManager::get_pending_changes` | method | 0/16 | `tests/sync_provider_contract_tests.rs`, `tests/sync_r02_hardening_tests.rs`, `tests/sync_real_business_tables_tests.rs` 等 4 个 |
| `dstu_sync::data_governance::sync::classification::SyncCategory` | enum | 0/15 | `tests/sync_comprehensive_tests.rs`, `tests/sync_real_flow_smoke_tests.rs`, `tests/sync_schema_coverage_tests.rs` |
| `dstu_sync::data_governance::sync::SyncManager::reset_sync_baseline_after_restore` | method | 0/14 | `tests/sync_comprehensive_tests.rs`, `tests/sync_real_flow_smoke_tests.rs`, `tests/sync_regression_tests.rs` |
| `dstu_sync::data_governance::sync::asset_filenames::encode_segment` | fn | 0/9 | `tests/sync_r07_cross_platform_names_tests.rs`, `tests/sync_r07_filename_tests.rs` |
| `dstu_sync::data_governance::sync::classification::TableClassification::row_sync_tables` | method | 0/9 | `tests/sync_comprehensive_tests.rs`, `tests/sync_real_flow_smoke_tests.rs`, `tests/sync_schema_coverage_tests.rs` |
| `dstu_sync::data_governance::sync::SyncManager::get_database_sync_state` | method | 0/8 | `tests/sync_comprehensive_tests.rs`, `tests/sync_provider_contract_tests.rs`, `tests/sync_real_flow_smoke_tests.rs` 等 4 个 |
| `dstu_sync::data_governance::sync::BlobsManifest` | struct | 0/7 | `tests/sync_file_level_e2ee.rs`, `tests/sync_r09_file_e2ee.rs` |
| `dstu_sync::data_governance::sync::MergeStrategy` ? | enum | 0/7 | `tests/sync_provider_contract_tests.rs`, `tests/sync_real_flow_smoke_tests.rs` |
| `dstu_sync::data_governance::sync::SyncManager::has_prune_gap` | method | 0/7 | `tests/sync_comprehensive_tests.rs` |
| `dstu_sync::data_governance::sync::SyncManager::enrich_changes_with_data` | method | 0/6 | `tests/sync_provider_contract_tests.rs`, `tests/sync_r02_hardening_tests.rs`, `tests/sync_real_flow_smoke_tests.rs` |
| `deep_student_lib::data_governance::commands_sync::data_governance_resolve_record_conflict` | fn | 0/5 | `tests/sync_r06_delete_resolve_tests.rs`, `tests/sync_r07_delete_resolve_lock_tests.rs` |
| `dstu_sync::data_governance::sync::AssetDirsManifest` | struct | 0/5 | `tests/sync_provider_contract_tests.rs`, `tests/sync_r07_filename_tests.rs`, `tests/sync_r09_filenames.rs` |
| `dstu_sync::data_governance::sync::BlobEntry` | struct | 0/5 | `tests/sync_file_level_e2ee.rs`, `tests/sync_r09_file_e2ee.rs` |
| `dstu_sync::data_governance::sync::SyncManager::filter_pending_changes_for_database` | method | 0/5 | `tests/sync_real_flow_smoke_tests.rs` |
| `dstu_sync::data_governance::sync::WorkspacesManifest` | struct | 0/5 | `tests/sync_provider_contract_tests.rs`, `tests/sync_r09_file_e2ee.rs` |
| `dstu_sync::data_governance::sync::asset_filenames::FILENAME_CONFLICT_MARKER` | const | 0/4 | `tests/sync_r07_cross_platform_names_tests.rs`, `tests/sync_r07_filename_tests.rs`, `tests/sync_r09_filenames.rs` |
| `dstu_sync::data_governance::sync::SyncManager::apply_merge_strategy` | method | 0/4 | `tests/sync_regression_tests.rs` |
| `dstu_sync::data_governance::sync::SyncManifest` | struct | 0/4 | `tests/sync_provider_contract_tests.rs`, `tests/sync_real_flow_smoke_tests.rs` |
| `dstu_sync::data_governance::sync::tombstone::download_blob_tombstones` | fn | 0/4 | `tests/sync_scenarios_tests.rs` |
| `dstu_sync::data_governance::sync::tombstone::PlainCodec` | struct | 0/4 | `tests/sync_scenarios_tests.rs` |
| `dstu_sync::data_governance::sync::AssetSyncOutcome` | struct | 0/3 | `tests/sync_r07_filename_tests.rs`, `tests/sync_r09_filenames.rs` |
| `dstu_sync::data_governance::sync::classification::TableClassification::checksum_tables` | method | 0/3 | `tests/sync_comprehensive_tests.rs`, `tests/sync_schema_coverage_tests.rs` |
| `dstu_sync::data_governance::sync::classification::TableClassification::get_business_unique_keys` | method | 0/3 | `tests/sync_comprehensive_tests.rs` |
| `dstu_sync::data_governance::sync::SyncManager::cleanup_synced_changes` | method | 0/3 | `tests/sync_regression_tests.rs` |
| `deep_student_lib::data_governance::commands_sync::data_governance_list_record_conflicts` | fn | 0/2 | `tests/sync_r06_delete_resolve_tests.rs`, `tests/sync_r07_delete_resolve_lock_tests.rs` |
| `dstu_sync::data_governance::sync::classification::TableClassification::change_log_trigger_exempt` | method | 0/2 | `tests/sync_schema_coverage_tests.rs` |
| `dstu_sync::data_governance::sync::classification::TableClassification::is_excluded_from_checksum` | method | 0/2 | `tests/sync_schema_coverage_tests.rs` |
| `dstu_sync::data_governance::sync::SyncError` | enum | 0/2 | `tests/sync_r09_filenames.rs`, `tests/sync_real_flow_smoke_tests.rs` |
| `dstu_sync::data_governance::sync::SyncManager::mark_synced_with_timestamp` | method | 0/2 | `tests/sync_provider_contract_tests.rs`, `tests/sync_real_flow_smoke_tests.rs` |
| `dstu_sync::data_governance::sync::SyncTransactionStatus` | enum | 0/2 | `tests/sync_provider_contract_tests.rs` |
| `dstu_sync::data_governance::sync::tombstone::apply_blob_tombstones` | fn | 0/2 | `tests/sync_scenarios_tests.rs`, `tests/sync_weird_tests.rs` |
| `dstu_sync::data_governance::sync::tombstone::BlobTombstoneEntry` | struct | 0/2 | `tests/sync_scenarios_tests.rs`, `tests/sync_weird_tests.rs` |
| `dstu_sync::data_governance::sync::tombstone::BlobTombstones` | struct | 0/2 | `tests/sync_scenarios_tests.rs`, `tests/sync_weird_tests.rs` |
| `dstu_sync::data_governance::sync::WorkspaceEntry` | struct | 0/2 | `tests/sync_r09_file_e2ee.rs` |
| `dstu_sync::data_governance::sync::ApplyChangesResult` | struct | 0/1 | `tests/sync_r02_hardening_tests.rs` |
| `dstu_sync::data_governance::sync::asset_filenames::encode_asset_key_segments` | fn | 0/1 | `tests/sync_r09_filenames.rs` |
| `dstu_sync::data_governance::sync::AssetFileEntry` | struct | 0/1 | `tests/sync_r09_filenames.rs` |
| `dstu_sync::data_governance::sync::conflict_resolver::ConflictAwareApplyResult` | struct | 0/1 | `tests/sync_r02_hardening_tests.rs` |
| `dstu_sync::data_governance::sync::hlc::Hlc::parse` | method | 0/1 | `tests/sync_weird_tests.rs` |
| `dstu_sync::data_governance::sync::SyncManager::apply_downloaded_changes_force_exact_with_hooks` | method | 0/1 | `tests/sync_weird_tests.rs` |
| `dstu_sync::data_governance::sync::SyncManager::replay_quarantined_changes` | method | 0/1 | `tests/sync_regression_tests.rs` |
| `dstu_sync::data_governance::sync::tombstone::download_asset_tombstones` | fn | 0/1 | `tests/sync_scenarios_tests.rs` |
| `dstu_sync::data_governance::sync::tombstone::download_blob_tombstones_for_device` | fn | 0/1 | `tests/sync_weird_tests.rs` |
