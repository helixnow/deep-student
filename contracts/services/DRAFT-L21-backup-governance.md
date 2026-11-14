# 跨 lane 服务草稿：L21-backup-governance

> 生成文件（`node scripts/electron-migration/services-draft.mjs`），不要手改。这是 `contracts/services/`
> 正式契约的**输入**：提供方 lane 据此设计 `<service>@1` 接口，消费方 lane 据此确认依赖。
>
> 方法：tree-sitter-rust 解析全部 Rust 文件，建立模块树（`mod` 声明 + `#[path]`）与 `use` / `pub use`
> 重导出链；把 (1) `use` 导入、(2) 代码中的限定路径（含 `Type::method`）解析到定义处，定义与引用分属
> 不同 lane 即记一条。值上的方法调用（`x.method()`）需要类型推断，**不统计**——"提供"清单偏少不偏多。
> `?` = 不确定（经 glob 重导出，或定义文件不在模块树内）。计数 = 引用点（导入名在文件中的出现次数）；
> prod / test 按是否位于 `#[cfg(test)]` / `mod tests` / `tests/` 区分。

## 提供给其他 lane（81 个条目，其中 55 个有生产代码引用）

| 条目 | 种类 | 定义 | 消费方（prod/test 引用点） | 签名 |
|---|---|---|---|---|
| `deep_student_lib::data_governance::commands_backup::open_sync_connection` | fn | `src/data_governance/commands_backup.rs:113` | L20-sync 36/0 | `pub(super) fn open_sync_connection<P: AsRef<Path>>( path: P, ) -> rusqlite::Result<rusqlite::Connection>` |
| `deep_student_lib::data_governance::commands_backup::resolve_database_path` | fn | `src/data_governance/commands_backup.rs:130` | L20-sync 33/0 | `pub(super) fn resolve_database_path(db_id: &DatabaseId, active_dir: &Path) -> PathBuf` |
| `dstu_sync::cloud_credentials::hydrate_cloud_config` | fn | `crates/dstu-sync/src/cloud_credentials.rs:127` | L23-sync-providers 12/0<br>L20-sync 8/0<br>F4-security 1/0 | `pub fn hydrate_cloud_config( app: &tauri::AppHandle, config: &mut crate::cloud_storage::CloudStorageConfig, )` |
| `deep_student_lib::data_governance::commands_backup::get_active_data_dir` | fn | `src/data_governance/commands_backup.rs:43` | L20-sync 20/0 | `pub(super) fn get_active_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String>` |
| `deep_student_lib::data_governance::commands::check_maintenance_mode` | fn | `src/data_governance/commands.rs:106` | L20-sync 11/0 | `pub(super) fn check_maintenance_mode(app: &tauri::AppHandle) -> Result<(), String>` |
| `deep_student_lib::data_governance::commands::try_save_audit_log` | fn | `src/data_governance/commands.rs:382` | L20-sync 8/0 | `pub(super) fn try_save_audit_log(app: &tauri::AppHandle, log: AuditLog)` |
| `dstu_sync::cloud_credentials::get_secure_store` | fn | `crates/dstu-sync/src/cloud_credentials.rs:48` | F4-security 7/0 | `pub fn get_secure_store(app: Option<&tauri::AppHandle>) -> SecureStore` |
| `deep_student_lib::data_governance::commands_backup::apply_downloaded_changes_to_databases` | fn | `src/data_governance/commands_backup.rs:374` | L20-sync 5/0 | `pub(super) fn apply_downloaded_changes_to_databases( changes: &[SyncChangeWithData], active_dir: &std::path::Path, strategy: MergeStrategy, ) -> Result<ApplyToDbsResult, String>` |
| `deep_student_lib::data_governance::commands_backup::get_app_data_dir` | fn | `src/data_governance/commands_backup.rs:30` | L20-sync 5/0 | `pub(super) fn get_app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String>` |
| `dstu_sync::data_governance::backup::delta_inventory::InventoryEntry` | struct | `crates/dstu-sync/src/data_governance/backup/delta_inventory.rs:52` | L23-sync-providers 4/0 | `pub struct InventoryEntry` |
| `dstu_sync::cloud_config_commands::CloudConfigSsotError` ? | enum | `crates/dstu-sync/src/cloud_config_commands.rs:160` | L20-sync 3/0<br>L23-sync-providers 0/6 | `pub enum CloudConfigSsotError` |
| `dstu_sync::backup_job_manager::BackupJobPhase` | enum | `crates/dstu-sync/src/backup_job_manager.rs:126` | F4-security 3/0<br>L02-llm-manager 0/1 | `pub enum BackupJobPhase` |
| `deep_student_lib::data_governance::commands_backup::build_id_column_map` | fn | `src/data_governance/commands_backup.rs:227` | L20-sync 3/0 | `pub(super) fn build_id_column_map() -> std::collections::HashMap<String, String>` |
| `deep_student_lib::data_governance::commands::AuditHealthState` | struct | `src/data_governance/commands.rs:129` | F2-shell 3/0 | `pub struct AuditHealthState` |
| `deep_student_lib::data_governance::commands::persist_migration_error` | fn | `src/data_governance/commands.rs:61` | F2-shell 3/0 | `pub fn persist_migration_error(app_data_dir: &Path, error: &str)` |
| `dstu_sync::cloud_config_commands::FTP_UNSUPPORTED_ON_ANDROID_CODE` ? | const | `crates/dstu-sync/src/cloud_config_commands.rs:17` | L23-sync-providers 2/10 | `pub const FTP_UNSUPPORTED_ON_ANDROID_CODE: &str = "E_FTP_UNSUPPORTED_ON_ANDROID"` |
| `dstu_sync::cloud_config_commands::FTP_UNSUPPORTED_ON_ANDROID_MESSAGE` ? | const | `crates/dstu-sync/src/cloud_config_commands.rs:24` | L23-sync-providers 2/7 | `pub const FTP_UNSUPPORTED_ON_ANDROID_MESSAGE: &str = "FTP/FTPS storage is not available on Android."` |
| `dstu_sync::cloud_config_commands::S3_UNSUPPORTED_IN_BUILD_CODE` ? | const | `crates/dstu-sync/src/cloud_config_commands.rs:28` | L23-sync-providers 2/7 | `pub const S3_UNSUPPORTED_IN_BUILD_CODE: &str = "E_S3_UNSUPPORTED_IN_BUILD"` |
| `dstu_sync::cloud_config_commands::S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE` ? | const | `crates/dstu-sync/src/cloud_config_commands.rs:40` | L23-sync-providers 2/5 | `pub const S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE: &str = "当前安装包不支持 S3 兼容存储，请改用 WebDAV。"` |
| `dstu_sync::data_governance::backup::BackupManifest` | struct | `crates/dstu-sync/src/data_governance/backup/mod.rs:742` | F4-security 2/0<br>L23-sync-providers 0/1<br>L22-app-commands 0/4 | `pub struct BackupManifest` |
| `deep_student_lib::chat_v2::tools::data_governance_executor::DataGovernanceToolExecutor` | struct | `src/chat_v2/tools/data_governance_executor.rs:64` | F1-kernel 1/2<br>L13-vfs-api 1/0 | `pub struct DataGovernanceToolExecutor` |
| `deep_student_lib::data_governance::commands_backup::ApplyToDbsResult` | struct | `src/data_governance/commands_backup.rs:141` | L20-sync 2/0 | `pub(super) struct ApplyToDbsResult` |
| `deep_student_lib::data_governance::commands_backup::validate_user_path` | fn | `src/data_governance/commands_backup.rs:643` | L20-sync 2/0 | `pub(super) fn validate_user_path(path: &Path, _app_data_dir: &Path) -> Result<(), String>` |
| `deep_student_lib::data_governance::commands::SYNC_LOCK_TIMEOUT_SECS` | const | `src/data_governance/commands.rs:176` | L20-sync 2/0 | `pub(super) const SYNC_LOCK_TIMEOUT_SECS: u64 = 60` |
| `dstu_sync::cloud_config_commands::load_hydrated_cloud_config_ssot` ? | fn | `crates/dstu-sync/src/cloud_config_commands.rs:547` | L20-sync 2/0 | `pub fn load_hydrated_cloud_config_ssot( app: &tauri::AppHandle, database: &crate::database::Database, ) -> Result<CloudStorageConfig, CloudConfigSsotError>` |
| `dstu_sync::cloud_credentials::SettingsDatabaseProvider` | trait | `crates/dstu-sync/src/cloud_credentials.rs:26` | F1-kernel 2/0 | `pub trait SettingsDatabaseProvider: Send + Sync` |
| `dstu_sync::data_governance::backup::assets::AssetBackupConfig` | struct | `crates/dstu-sync/src/data_governance/backup/assets.rs:372` | F4-security 2/0 | `pub struct AssetBackupConfig` |
| `dstu_sync::data_governance::backup::BackupKeyPolicy` | enum | `crates/dstu-sync/src/data_governance/backup/mod.rs:471` | F4-security 2/0 | `pub enum BackupKeyPolicy` |
| `dstu_sync::data_governance::backup::CoverageStatus` | enum | `crates/dstu-sync/src/data_governance/backup/mod.rs:491` | F4-security 2/0 | `pub enum CoverageStatus` |
| `dstu_sync::data_governance::backup::delta_inventory::DeltaInventory` | struct | `crates/dstu-sync/src/data_governance/backup/delta_inventory.rs:63` | L23-sync-providers 2/0 | `pub struct DeltaInventory` |
| `dstu_sync::data_governance::backup::SnapshotKind` | enum | `crates/dstu-sync/src/data_governance/backup/mod.rs:450` | F4-security 2/0 | `pub enum SnapshotKind` |
| `dstu_sync::hooks::SyncFieldMerger` | trait | `crates/dstu-sync/src/hooks.rs:19` | F1-kernel 2/0 | `pub trait SyncFieldMerger: Send + Sync` |
| `dstu_sync::data_governance::backup::delta_inventory::build_inventory_cross_checked` | fn | `crates/dstu-sync/src/data_governance/backup/delta_inventory.rs:294` | L23-sync-providers 1/0<br>L22-app-commands 0/5 | `pub fn build_inventory_cross_checked( staging_root: &Path, ) -> Result<(DeltaInventory, BackupManifest), BackupError>` |
| `dstu_sync::data_governance::backup::delta_inventory::diff` | fn | `crates/dstu-sync/src/data_governance/backup/delta_inventory.rs:305` | L23-sync-providers 1/0<br>L22-app-commands 0/4 | `pub fn diff(prev: &DeltaInventory, current: &DeltaInventory) -> InventoryDiff` |
| `dstu_sync::backup_job_manager::BackupJobKind` | enum | `crates/dstu-sync/src/backup_job_manager.rs:69` | F4-security 1/0<br>L02-llm-manager 0/2 | `pub enum BackupJobKind` |
| `dstu_sync::data_governance::backup::BackupManager` | struct | `crates/dstu-sync/src/data_governance/backup/mod.rs:2232` | F4-security 1/0<br>L23-sync-providers 0/1<br>L22-app-commands 0/1 | `pub struct BackupManager` |
| `dstu_sync::data_governance::backup::zip_export::export_backup_to_zip` | fn | `crates/dstu-sync/src/data_governance/backup/zip_export.rs:1028` | F4-security 1/0<br>L23-sync-providers 0/1<br>L22-app-commands 0/1 | `pub fn export_backup_to_zip( backup_dir: &Path, options: &ZipExportOptions, ) -> Result<ZipExportResult, ZipExportError>` |
| `dstu_sync::data_governance::backup::zip_export::ZipExportOptions` | struct | `crates/dstu-sync/src/data_governance/backup/zip_export.rs:535` | F4-security 1/0<br>L23-sync-providers 0/1<br>L22-app-commands 0/1 | `pub struct ZipExportOptions` |
| `dstu_sync::backup_job_manager::BackupJobParams` | struct | `crates/dstu-sync/src/backup_job_manager.rs:316` | F4-security 1/0<br>L02-llm-manager 0/1 | `pub struct BackupJobParams` |
| `deep_student_lib::chat_v2::tools::data_governance_executor::DataGovernanceToolExecutor::new` | method | `src/chat_v2/tools/data_governance_executor.rs:67` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `deep_student_lib::data_governance::commands_backup::BackupSnapshotBarrier::enter` | method | `src/data_governance/commands_backup.rs:1094` | F4-security 1/0 | `pub(crate) fn enter(app: &tauri::AppHandle) -> Result<Self, String>` |
| `deep_student_lib::data_governance::commands_restore::finalize_restore_activation` | fn | `src/data_governance/commands_restore.rs:144` | F2-shell 1/0 | `pub(crate) fn finalize_restore_activation(active_dir: &Path) -> Result<bool, String>` |
| `deep_student_lib::data_governance::commands::clear_migration_error` | fn | `src/data_governance/commands.rs:77` | F2-shell 1/0 | `pub fn clear_migration_error(app_data_dir: &Path)` |
| `deep_student_lib::data_governance::init::initialize_with_report` | fn | `src/data_governance/init.rs:141` | F2-shell 1/0 | `pub fn initialize_with_report( app_data_dir: &Path, ) -> Result<InitializationResult, DataGovernanceError>` |
| `deep_student_lib::data_governance::should_force_maintenance_mode_on_init_failure` | fn | `src/data_governance/mod.rs:148` | F2-shell 1/0 | `pub fn should_force_maintenance_mode_on_init_failure(err: &DataGovernanceError) -> bool` |
| `dstu_sync::backup_job_manager::BackupJobManagerState` | struct | `crates/dstu-sync/src/backup_job_manager.rs:832` | F4-security 1/0 | `pub struct BackupJobManagerState` |
| `dstu_sync::backup_job_manager::BackupJobResultPayload` | struct | `crates/dstu-sync/src/backup_job_manager.rs:142` | F4-security 1/0 | `pub struct BackupJobResultPayload` |
| `dstu_sync::cloud_credentials::register_settings_database_provider` | fn | `crates/dstu-sync/src/cloud_credentials.rs:35` | F1-kernel 1/0 | `pub fn register_settings_database_provider( provider: Arc<dyn SettingsDatabaseProvider>, ) -> Result<Disposer, SlotOccupied>` |
| `dstu_sync::data_governance::backup::BackupConfig` | struct | `crates/dstu-sync/src/data_governance/backup/mod.rs:1774` | F4-security 1/0 | `pub struct BackupConfig` |
| `dstu_sync::data_governance::backup::BackupError` | enum | `crates/dstu-sync/src/data_governance/backup/mod.rs:1830` | L23-sync-providers 1/0 | `pub enum BackupError` |
| `dstu_sync::data_governance::backup::BackupManager::with_config` | method | `crates/dstu-sync/src/data_governance/backup/mod.rs:2255` | F4-security 1/0 | `pub fn with_config(backup_dir: PathBuf, config: BackupConfig) -> Self` |
| `dstu_sync::data_governance::backup::BackupTier` | enum | `crates/dstu-sync/src/data_governance/backup/mod.rs:1937` | F4-security 1/0 | `pub enum BackupTier` |
| `dstu_sync::data_governance::backup::zip_export::portable_manifest_bytes` | fn | `crates/dstu-sync/src/data_governance/backup/zip_export.rs:91` | F4-security 1/0 | `pub fn portable_manifest_bytes(backup_dir: &Path) -> Result<Vec<u8>, ZipExportError>` |
| `dstu_sync::hooks::merge_profile_json_for_sync` | fn | `crates/dstu-sync/src/hooks.rs:35` | L20-sync 1/0 | `pub fn merge_profile_json_for_sync(local_json: &str, remote_json: &str) -> Option<String>` |
| `dstu_sync::hooks::register_sync_field_merger` | fn | `crates/dstu-sync/src/hooks.rs:28` | F1-kernel 1/0 | `pub fn register_sync_field_merger( merger: Arc<dyn SyncFieldMerger>, ) -> Result<Disposer, SlotOccupied>` |
| `dstu_sync::data_governance::backup::delta_inventory::MANIFEST_LOGICAL_PATH` | const | `crates/dstu-sync/src/data_governance/backup/delta_inventory.rs:41` | L22-app-commands 0/23 | `pub const MANIFEST_LOGICAL_PATH: &str = "manifest.json"` |
| `dstu_sync::cloud_config_commands::SafeCloudStorageConfig` ? | enum | `crates/dstu-sync/src/cloud_config_commands.rs:91` | L23-sync-providers 0/6 | `pub enum SafeCloudStorageConfig` |
| `dstu_sync::data_governance::backup::delta_inventory::build_inventory` | fn | `crates/dstu-sync/src/data_governance/backup/delta_inventory.rs:148` | L22-app-commands 0/6 | `pub fn build_inventory(staging_root: &Path) -> Result<DeltaInventory, BackupError>` |
| `dstu_sync::backup_job_manager::INCREMENTAL_BACKUP_DISABLED_MESSAGE` | const | `crates/dstu-sync/src/backup_job_manager.rs:805` | L02-llm-manager 0/5 | `pub const INCREMENTAL_BACKUP_DISABLED_MESSAGE: &str = "Incremental backup has been removed; use full backup or cloud sync"` |
| `dstu_sync::data_governance::backup::BackupFile` | struct | `crates/dstu-sync/src/data_governance/backup/mod.rs:1761` | L22-app-commands 0/4 | `pub struct BackupFile` |
| `dstu_sync::data_governance::backup::BackupManifest::new` | method | `crates/dstu-sync/src/data_governance/backup/mod.rs:788` | L22-app-commands 0/4 | `pub fn new(app_version: &str) -> Self` |
| `dstu_sync::data_governance::backup::zip_export::import_backup_from_zip_with_password` | fn | `crates/dstu-sync/src/data_governance/backup/zip_export.rs:1882` | L23-sync-providers 0/2<br>L22-app-commands 0/2 | `pub fn import_backup_from_zip_with_password( zip_path: &Path, target_dir: &Path, password: Option<&str>, ) -> Result<usize, ZipExportError>` |
| `dstu_sync::cloud_config_commands::load_cloud_config_ssot` ? | fn | `crates/dstu-sync/src/cloud_config_commands.rs:518` | L23-sync-providers 0/3 | `pub fn load_cloud_config_ssot( database: &crate::database::Database, ) -> Result<SafeCloudStorageConfig, CloudConfigSsotError>` |
| `dstu_sync::cloud_config_commands::load_cloud_config_ssot_with_capabilities` ? | fn | `crates/dstu-sync/src/cloud_config_commands.rs:528` | L23-sync-providers 0/3 | `pub fn load_cloud_config_ssot_with_capabilities( database: &crate::database::Database, capabilities: crate::cloud_storage::PlatformStorageCapabilities, ) -> Result<SafeCloudStorageConfig, CloudConfigSsotError>` |
| `dstu_sync::cloud_config_commands::save_cloud_config_ssot_with_capabilities` ? | fn | `crates/dstu-sync/src/cloud_config_commands.rs:499` | L23-sync-providers 0/3 | `pub fn save_cloud_config_ssot_with_capabilities( database: &crate::database::Database, config: SafeCloudStorageConfig, capabilities: crate::cloud_storage::PlatformStorageCapabilities, ) -> Result<SafeCloudStorageConfig, CloudConfigSsotError>` |
| `dstu_sync::data_governance::backup::BackupManager::new` | method | `crates/dstu-sync/src/data_governance/backup/mod.rs:2245` | L23-sync-providers 0/2<br>L22-app-commands 0/1 | `pub fn new(backup_dir: PathBuf) -> Self` |
| `dstu_sync::data_governance::backup::delta_inventory::validate_logical_path` | fn | `crates/dstu-sync/src/data_governance/backup/delta_inventory.rs:97` | L22-app-commands 0/3 | `pub fn validate_logical_path(value: &str) -> Result<(), BackupError>` |
| `dstu_sync::cloud_config_commands::CLOUD_CONFIG_SSOT_SETTING_KEY` ? | const | `crates/dstu-sync/src/cloud_config_commands.rs:14` | L23-sync-providers 0/2 | `pub const CLOUD_CONFIG_SSOT_SETTING_KEY: &str = "cloud_storage.config.safe_v1"` |
| `dstu_sync::cloud_config_commands::SafeFtpConfig` ? | struct | `crates/dstu-sync/src/cloud_config_commands.rs:69` | L23-sync-providers 0/2 | `pub struct SafeFtpConfig` |
| `dstu_sync::cloud_config_commands::save_cloud_config_ssot` ? | fn | `crates/dstu-sync/src/cloud_config_commands.rs:487` | L23-sync-providers 0/2 | `pub fn save_cloud_config_ssot( database: &crate::database::Database, config: SafeCloudStorageConfig, ) -> Result<SafeCloudStorageConfig, CloudConfigSsotError>` |
| `dstu_sync::data_governance::backup::BackupManifest::load_from_file` | method | `crates/dstu-sync/src/data_governance/backup/mod.rs:1638` | L23-sync-providers 0/2 | `pub fn load_from_file(path: &Path) -> Result<Self, BackupError>` |
| `dstu_sync::data_governance::backup::delta_inventory::manifest_unchanged_ignoring_volatile` | fn | `crates/dstu-sync/src/data_governance/backup/delta_inventory.rs:349` | L22-app-commands 0/2 | `pub fn manifest_unchanged_ignoring_volatile( prev: &[u8], current: &[u8], ) -> Result<bool, BackupError>` |
| `dstu_sync::data_governance::backup::zip_export::import_backup_from_zip` | fn | `crates/dstu-sync/src/data_governance/backup/zip_export.rs:1873` | L23-sync-providers 0/1<br>L22-app-commands 0/1 | `pub fn import_backup_from_zip(zip_path: &Path, target_dir: &Path) -> Result<usize, ZipExportError>` |
| `dstu_sync::backup_job_manager::BackupJobManager` | struct | `crates/dstu-sync/src/backup_job_manager.rs:819` | L02-llm-manager 0/1 | `pub struct BackupJobManager` |
| `dstu_sync::backup_job_manager::BackupJobManager::new_for_tests` | method | `crates/dstu-sync/src/backup_job_manager.rs:869` | L02-llm-manager 0/1 | `pub fn new_for_tests() -> Self` |
| `dstu_sync::backup_job_manager::BackupJobStatus` | enum | `crates/dstu-sync/src/backup_job_manager.rs:77` | L02-llm-manager 0/1 | `pub enum BackupJobStatus` |
| `dstu_sync::cloud_config_commands::SafeS3Config` ? | struct | `crates/dstu-sync/src/cloud_config_commands.rs:57` | L23-sync-providers 0/1 | `pub struct SafeS3Config` |
| `dstu_sync::cloud_config_commands::SafeWebDavConfig` ? | struct | `crates/dstu-sync/src/cloud_config_commands.rs:50` | L23-sync-providers 0/1 | `pub struct SafeWebDavConfig` |
| `dstu_sync::data_governance::backup::delta_inventory::VOLATILE_MANIFEST_FIELDS` | const | `crates/dstu-sync/src/data_governance/backup/delta_inventory.rs:45` | L22-app-commands 0/1 | `pub const VOLATILE_MANIFEST_FIELDS: [&str; 3] = ["created_at", "backup_id", "snapshot_epoch"]` |
| `dstu_sync::data_governance::backup::zip_export::import_backup_from_zip_resumable` | fn | `crates/dstu-sync/src/data_governance/backup/zip_export.rs:2009` | L22-app-commands 0/1 | `pub fn import_backup_from_zip_resumable<F, C>( zip_path: &Path, target_dir: &Path, progress_callback: F, cancel_check: C, password: Option<&str>, ) -> Result<usize, ZipExportError> where F: FnMut(ZipImportProgress), C: Fn() -> bool,` |
| `dstu_sync::data_governance::backup::zip_export::import_backup_from_zip_with_progress` | fn | `crates/dstu-sync/src/data_governance/backup/zip_export.rs:1971` | L22-app-commands 0/1 | `pub fn import_backup_from_zip_with_progress<F, C>( zip_path: &Path, target_dir: &Path, progress_callback: F, cancel_check: C, password: Option<&str>, ) -> Result<usize, ZipExportError> where F: FnMut(ZipImportProgress), C: Fn() -> bool,` |

### 引用点样例

- `deep_student_lib::data_governance::commands_backup::open_sync_connection` — L20-sync: `src/data_governance/commands_sync.rs:95`, `src/data_governance/commands_sync.rs:222`, `src/data_governance/commands_sync.rs:340`, `src/data_governance/commands_sync.rs:401`
- `deep_student_lib::data_governance::commands_backup::resolve_database_path` — L20-sync: `src/data_governance/commands_sync.rs:94`, `src/data_governance/commands_sync.rs:217`, `src/data_governance/commands_sync.rs:336`, `src/data_governance/commands_sync.rs:1043`
- `dstu_sync::cloud_credentials::hydrate_cloud_config` — L23-sync-providers: `crates/dstu-sync/src/cloud_storage/mod.rs:302`, `crates/dstu-sync/src/cloud_storage/mod.rs:316`, `crates/dstu-sync/src/cloud_storage/mod.rs:328`, `crates/dstu-sync/src/cloud_storage/mod.rs:340`；L20-sync: `src/data_governance/commands_sync.rs:1320`, `src/data_governance/commands_sync.rs:1647`, `src/data_governance/commands_sync.rs:2936`, `src/data_governance/commands_sync.rs:4071`；F4-security: `src/secure_store.rs:12`
- `deep_student_lib::data_governance::commands_backup::get_active_data_dir` — L20-sync: `src/data_governance/commands_sync.rs:1034`, `src/data_governance/commands_sync.rs:1291`, `src/data_governance/commands_sync.rs:1465`, `src/data_governance/commands_sync.rs:1694`
- `deep_student_lib::data_governance::commands::check_maintenance_mode` — L20-sync: `src/data_governance/commands_sync.rs:1032`, `src/data_governance/commands_sync.rs:1289`, `src/data_governance/commands_sync.rs:1443`, `src/data_governance/commands_sync.rs:1598`
- `deep_student_lib::data_governance::commands::try_save_audit_log` — L20-sync: `src/data_governance/commands_sync.rs:1661`, `src/data_governance/commands_sync.rs:2244`, `src/data_governance/commands_sync.rs:2246`, `src/data_governance/commands_sync.rs:2279`
- `dstu_sync::cloud_credentials::get_secure_store` — F4-security: `src/secure_store.rs:32`, `src/secure_store.rs:46`, `src/secure_store.rs:55`, `src/secure_store.rs:70`
- `deep_student_lib::data_governance::commands_backup::apply_downloaded_changes_to_databases` — L20-sync: `src/data_governance/commands_sync.rs:1948`, `src/data_governance/commands_sync.rs:2013`, `src/data_governance/commands_sync.rs:2694`, `src/data_governance/commands_sync.rs:3712`
- `deep_student_lib::data_governance::commands_backup::get_app_data_dir` — L20-sync: `src/data_governance/commands_sync.rs:1695`, `src/data_governance/commands_sync.rs:2389`, `src/data_governance/commands_sync.rs:2611`, `src/data_governance/commands_sync.rs:3009`
- `dstu_sync::data_governance::backup::delta_inventory::InventoryEntry` — L23-sync-providers: `crates/dstu-sync/src/cloud_storage/delta_upload.rs:388`, `crates/dstu-sync/src/cloud_storage/delta_upload.rs:391`, `crates/dstu-sync/src/cloud_storage/delta_upload.rs:484`, `crates/dstu-sync/src/cloud_storage/delta_upload.rs:630`
- `dstu_sync::cloud_config_commands::CloudConfigSsotError` — L20-sync: `src/data_governance/commands_sync.rs:19`, `src/data_governance/commands_sync.rs:1636`, `src/data_governance/commands_sync.rs:2920`；L23-sync-providers: `tests/sync_android_device_switch.rs:541`, `tests/sync_android_device_switch.rs:546`, `tests/sync_android_device_switch.rs:560`, `tests/sync_android_device_switch.rs:633`
- `dstu_sync::backup_job_manager::BackupJobPhase` — F4-security: `src/backup_config.rs:373`, `src/backup_config.rs:456`, `src/backup_config.rs:519`；L02-llm-manager: `tests/c1_cross_lang_consistency.rs:65`
- `deep_student_lib::data_governance::commands_backup::build_id_column_map` — L20-sync: `src/data_governance/commands_sync.rs:32`, `src/data_governance/commands_sync.rs:4686`, `src/data_governance/commands_sync.rs:5266`
- `deep_student_lib::data_governance::commands::AuditHealthState` — F2-shell: `src/lib.rs:1094`, `src/lib.rs:1164`, `src/lib.rs:1303`
- `deep_student_lib::data_governance::commands::persist_migration_error` — F2-shell: `src/lib.rs:1176`, `src/lib.rs:1210`, `src/lib.rs:1282`
- `dstu_sync::cloud_config_commands::FTP_UNSUPPORTED_ON_ANDROID_CODE` — L23-sync-providers: `crates/dstu-sync/src/cloud_storage/config.rs:388`, `crates/dstu-sync/src/cloud_storage/mod.rs:273`, `tests/sync_android_device_switch.rs:482`, `tests/sync_android_device_switch.rs:500`
- `dstu_sync::cloud_config_commands::FTP_UNSUPPORTED_ON_ANDROID_MESSAGE` — L23-sync-providers: `crates/dstu-sync/src/cloud_storage/config.rs:389`, `crates/dstu-sync/src/cloud_storage/mod.rs:274`, `tests/sync_android_device_switch.rs:486`, `tests/sync_android_device_switch.rs:505`
- `dstu_sync::cloud_config_commands::S3_UNSUPPORTED_IN_BUILD_CODE` — L23-sync-providers: `crates/dstu-sync/src/cloud_storage/config.rs:356`, `crates/dstu-sync/src/cloud_storage/mod.rs:259`, `tests/sync_android_device_switch.rs:590`, `tests/sync_android_device_switch.rs:605`
- `dstu_sync::cloud_config_commands::S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE` — L23-sync-providers: `crates/dstu-sync/src/cloud_storage/config.rs:357`, `crates/dstu-sync/src/cloud_storage/mod.rs:260`, `tests/sync_android_device_switch.rs:575`, `tests/sync_android_device_switch.rs:580`
- `dstu_sync::data_governance::backup::BackupManifest` — F4-security: `src/backup_config.rs:249`, `src/backup_config.rs:544`；L23-sync-providers: `tests/sync_android_device_switch.rs:718`；L22-app-commands: `tests/sync_r12_delta_gc.rs:44`, `tests/sync_r12_delta_inventory.rs:16`, `tests/sync_r12_delta_restore.rs:42`, `tests/sync_r12_delta_upload.rs:39`
- `deep_student_lib::chat_v2::tools::data_governance_executor::DataGovernanceToolExecutor` — F1-kernel: `src/agent_wiring/roster.rs:16`, `src/agent_wiring/tests/descriptor_tests.rs:84`, `src/agent_wiring/tests/headless_tests.rs:28`；L13-vfs-api: `src/chat_v2/tools/mod.rs:60`
- `deep_student_lib::data_governance::commands_backup::ApplyToDbsResult` — L20-sync: `src/data_governance/commands_sync.rs:135`, `src/data_governance/commands_sync.rs:167`
- `deep_student_lib::data_governance::commands_backup::validate_user_path` — L20-sync: `src/data_governance/commands_sync.rs:2468`, `src/data_governance/commands_sync.rs:2628`
- `deep_student_lib::data_governance::commands::SYNC_LOCK_TIMEOUT_SECS` — L20-sync: `src/data_governance/commands_sync.rs:2584`, `src/data_governance/commands_sync.rs:2591`
- `dstu_sync::cloud_config_commands::load_hydrated_cloud_config_ssot` — L20-sync: `src/data_governance/commands_sync.rs:1634`, `src/data_governance/commands_sync.rs:2918`
- `dstu_sync::cloud_credentials::SettingsDatabaseProvider` — F1-kernel: `src/extensions.rs:209`, `src/extensions.rs:225`
- `dstu_sync::data_governance::backup::assets::AssetBackupConfig` — F4-security: `src/backup_config.rs:15`, `src/backup_config.rs:439`
- `dstu_sync::data_governance::backup::BackupKeyPolicy` — F4-security: `src/backup_config.rs:15`, `src/backup_config.rs:260`
- `dstu_sync::data_governance::backup::CoverageStatus` — F4-security: `src/backup_config.rs:15`, `src/backup_config.rs:266`
- `dstu_sync::data_governance::backup::delta_inventory::DeltaInventory` — L23-sync-providers: `crates/dstu-sync/src/cloud_storage/delta_upload.rs:387`, `crates/dstu-sync/src/cloud_storage/delta_upload.rs:398`
- `dstu_sync::data_governance::backup::SnapshotKind` — F4-security: `src/backup_config.rs:15`, `src/backup_config.rs:255`
- `dstu_sync::hooks::SyncFieldMerger` — F1-kernel: `src/extensions.rs:242`, `src/extensions.rs:258`
- `dstu_sync::data_governance::backup::delta_inventory::build_inventory_cross_checked` — L23-sync-providers: `crates/dstu-sync/src/cloud_storage/delta_upload.rs:599`；L22-app-commands: `tests/sync_r12_delta_inventory.rs:121`, `tests/sync_r12_delta_inventory.rs:155`, `tests/sync_r12_delta_inventory.rs:174`, `tests/sync_r12_delta_inventory.rs:175`
- `dstu_sync::data_governance::backup::delta_inventory::diff` — L23-sync-providers: `crates/dstu-sync/src/cloud_storage/delta_upload.rs:634`；L22-app-commands: `tests/sync_r12_delta_inventory.rs:177`, `tests/sync_r12_delta_inventory.rs:205`, `tests/sync_r12_delta_inventory.rs:259`, `tests/sync_r12_delta_inventory.rs:295`
- `dstu_sync::backup_job_manager::BackupJobKind` — F4-security: `src/backup_config.rs:364`；L02-llm-manager: `tests/c1_cross_lang_consistency.rs:6`, `tests/c1_cross_lang_consistency.rs:54`
- `dstu_sync::data_governance::backup::BackupManager` — F4-security: `src/backup_config.rs:15`；L23-sync-providers: `tests/sync_android_device_switch.rs:42`；L22-app-commands: `tests/sync_r10_download.rs:402`
- `dstu_sync::data_governance::backup::zip_export::export_backup_to_zip` — F4-security: `src/backup_config.rs:526`；L23-sync-providers: `tests/sync_android_device_switch.rs:735`；L22-app-commands: `tests/sync_r10_download.rs:442`
- `dstu_sync::data_governance::backup::zip_export::ZipExportOptions` — F4-security: `src/backup_config.rs:513`；L23-sync-providers: `tests/sync_android_device_switch.rs:737`；L22-app-commands: `tests/sync_r10_download.rs:444`
- `dstu_sync::backup_job_manager::BackupJobParams` — F4-security: `src/backup_config.rs:367`；L02-llm-manager: `tests/c1_cross_lang_consistency.rs:56`
- `deep_student_lib::chat_v2::tools::data_governance_executor::DataGovernanceToolExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:72`
- `deep_student_lib::data_governance::commands_backup::BackupSnapshotBarrier::enter` — F4-security: `src/backup_config.rs:429`
- `deep_student_lib::data_governance::commands_restore::finalize_restore_activation` — F2-shell: `src/lib.rs:1169`
- `deep_student_lib::data_governance::commands::clear_migration_error` — F2-shell: `src/lib.rs:1113`
- `deep_student_lib::data_governance::init::initialize_with_report` — F2-shell: `src/lib.rs:1098`
- `deep_student_lib::data_governance::should_force_maintenance_mode_on_init_failure` — F2-shell: `src/lib.rs:1266`
- `dstu_sync::backup_job_manager::BackupJobManagerState` — F4-security: `src/backup_config.rs:360`
- `dstu_sync::backup_job_manager::BackupJobResultPayload` — F4-security: `src/backup_config.rs:591`
- `dstu_sync::cloud_credentials::register_settings_database_provider` — F1-kernel: `src/extensions.rs:211`
- `dstu_sync::data_governance::backup::BackupConfig` — F4-security: `src/backup_config.rs:421`
- `dstu_sync::data_governance::backup::BackupError` — L23-sync-providers: `crates/dstu-sync/src/cloud_storage/delta_upload.rs:356`
- `dstu_sync::data_governance::backup::BackupManager::with_config` — F4-security: `src/backup_config.rs:419`
- `dstu_sync::data_governance::backup::BackupTier` — F4-security: `src/backup_config.rs:52`
- `dstu_sync::data_governance::backup::zip_export::portable_manifest_bytes` — F4-security: `src/backup_config.rs:540`
- `dstu_sync::hooks::merge_profile_json_for_sync` — L20-sync: `crates/dstu-sync/src/data_governance/sync/field_merge.rs:309`
- `dstu_sync::hooks::register_sync_field_merger` — F1-kernel: `src/extensions.rs:244`
- `dstu_sync::data_governance::backup::delta_inventory::MANIFEST_LOGICAL_PATH` — L22-app-commands: `tests/sync_r12_delta_gc.rs:262`, `tests/sync_r12_delta_gc.rs:289`, `tests/sync_r12_delta_inventory.rs:70`, `tests/sync_r12_delta_inventory.rs:98`
- `dstu_sync::cloud_config_commands::SafeCloudStorageConfig` — L23-sync-providers: `tests/sync_android_device_switch.rs:31`, `tests/sync_android_device_switch.rs:527`, `tests/sync_android_device_switch.rs:616`, `tests/sync_android_restart.rs:205`
- `dstu_sync::data_governance::backup::delta_inventory::build_inventory` — L22-app-commands: `tests/sync_r12_delta_inventory.rs:256`, `tests/sync_r12_delta_inventory.rs:257`, `tests/sync_r12_delta_inventory.rs:293`, `tests/sync_r12_delta_inventory.rs:294`
- `dstu_sync::backup_job_manager::INCREMENTAL_BACKUP_DISABLED_MESSAGE` — L02-llm-manager: `tests/c1_cross_lang_consistency.rs:40`, `tests/c1_cross_lang_consistency.rs:43`, `tests/c1_cross_lang_consistency.rs:45`, `tests/c1_cross_lang_consistency.rs:68`
- `dstu_sync::data_governance::backup::BackupFile` — L22-app-commands: `tests/sync_r12_delta_gc.rs:254`, `tests/sync_r12_delta_inventory.rs:62`, `tests/sync_r12_delta_restore.rs:207`, `tests/sync_r12_delta_upload.rs:218`
- 其余 21 个条目的引用点见 `draft.json`。

## 消费其他 lane

### F3-storage（65 个条目，prod 293 / test 432）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_storage::schema_registry::DatabaseId` ? | enum | 49/180 | `crates/dstu-sync/src/data_governance/backup/mod.rs`, `src/data_governance/commands.rs`, `src/data_governance/commands_backup.rs` 等 6 个 |
| `dstu_storage::audit::AuditOperation` | enum | 39/0 | `src/data_governance/commands.rs`, `src/data_governance/commands_backup.rs`, `src/data_governance/commands_restore.rs` 等 6 个 |
| `dstu_storage::audit::AuditLog::new` | method | 29/0 | `src/data_governance/commands.rs`, `src/data_governance/commands_backup.rs`, `src/data_governance/commands_restore.rs` 等 4 个 |
| `dstu_storage::audit::BackupType` | enum | 22/0 | `src/data_governance/commands_backup.rs`, `src/data_governance/commands_zip.rs`, `src/data_governance/dto/mod.rs` |
| `dstu_storage::schema_registry::DatabaseId::all_ordered` ? | method | 18/13 | `crates/dstu-sync/src/data_governance/backup/mod.rs`, `src/data_governance/commands.rs`, `src/data_governance/commands_backup.rs` 等 6 个 |
| `dstu_storage::schema_registry::SchemaRegistry` | struct | 13/12 | `src/data_governance/commands.rs`, `src/data_governance/init.rs`, `src/data_governance/migration_tests.rs` 等 4 个 |
| `dstu_storage::data_space::get_data_space_manager` | fn | 12/0 | `crates/dstu-sync/src/data_governance/backup/mod.rs`, `src/data_governance/commands_backup.rs`, `src/data_governance/commands_restore.rs` 等 4 个 |
| `dstu_storage::audit::AuditStatus` | enum | 11/5 | `src/data_governance/commands.rs`, `src/data_governance/commands_types.rs`, `src/data_governance/critical_audit_tests.rs` 等 5 个 |
| `dstu_storage::database::Database` | struct | 11/1 | `crates/dstu-sync/src/cloud_config_commands.rs`, `crates/dstu-sync/src/cloud_credentials.rs` |
| `dstu_storage::audit::AuditLog` | struct | 7/0 | `src/data_governance/commands.rs`, `src/data_governance/commands_backup.rs`, `src/data_governance/commands_restore.rs` 等 6 个 |
| `dstu_storage::backup_common::DataGovernanceOperationKind` | enum | 7/0 | `src/data_governance/commands_asset.rs`, `src/data_governance/commands_backup.rs` |
| `dstu_storage::migration::MigrationError` ? | enum | 6/16 | `src/data_governance/critical_audit_tests.rs`, `src/data_governance/init.rs`, `src/data_governance/migration_tests.rs` 等 5 个 |
| `dstu_storage::llm_usage::database::LlmUsageDatabase` | struct | 6/0 | `src/data_governance/commands.rs`, `src/data_governance/commands_backup.rs`, `src/data_governance/commands_restore.rs` |
| `dstu_storage::migration::coordinator::MigrationCoordinator::new` | method | 5/7 | `src/data_governance/commands.rs`, `src/data_governance/critical_audit_tests.rs`, `src/data_governance/init.rs` 等 6 个 |
| `dstu_storage::audit::AuditDatabase` | struct | 5/0 | `src/data_governance/commands.rs`, `src/data_governance/init.rs` |
| `dstu_storage::backup_common::DataGovernanceOperationGuard::acquire` | method | 5/0 | `src/data_governance/commands_asset.rs`, `src/data_governance/commands_backup.rs` |
| `dstu_storage::migration::coordinator::MigrationCoordinator` | struct | 3/8 | `src/data_governance/commands.rs`, `src/data_governance/critical_audit_tests.rs`, `src/data_governance/init.rs` 等 7 个 |
| `dstu_storage::data_space::startup_health::StartupComponentHealth` ? | struct | 3/2 | `src/data_governance/commands_types.rs`, `src/data_governance/init.rs`, `src/data_governance/mod.rs` |
| `dstu_storage::backup_common::get_available_disk_space` | fn | 3/0 | `src/data_governance/commands.rs`, `src/data_governance/commands_backup.rs`, `src/data_governance/commands_restore.rs` |
| `dstu_storage::data_space::startup_health::StartupComponentHealthState` | struct | 3/0 | `src/data_governance/commands.rs`, `src/data_governance/mod.rs` |
| `dstu_storage::unified_file_manager::is_virtual_uri` | fn | 3/0 | `src/data_governance/commands_zip.rs` |
| `dstu_storage::unified_file_manager::queue_persistable_saf_uri` | fn | 3/0 | `src/data_governance/commands_zip.rs` |
| `dstu_storage::unified_file_manager::reject_double_encoded_virtual_uri` | fn | 3/0 | `src/data_governance/commands_zip.rs` |
| `dstu_storage::audit::AuditError` | enum | 2/0 | `src/data_governance/init.rs` |
| `dstu_storage::backup_common::DataGovernanceOperationGuard` | struct | 2/0 | `src/data_governance/commands_asset.rs`, `src/data_governance/commands_backup.rs` |
| `dstu_storage::backup_common::ImportProgress` | struct | 2/0 | `crates/dstu-sync/src/backup_job_manager.rs` |
| `dstu_storage::data_space::startup_health::StartupComponentIssue` | struct | 2/0 | `src/data_governance/commands_types.rs`, `src/data_governance/mod.rs` |
| `dstu_storage::schema_registry::SchemaRegistryError` | enum | 2/0 | `src/data_governance/init.rs`, `src/data_governance/mod.rs` |
| `dstu_storage::audit::AuditRepository::init` | method | 1/10 | `src/data_governance/commands.rs`, `src/data_governance/critical_audit_tests.rs`, `src/data_governance/migration_tests.rs` 等 4 个 |
| `dstu_storage::audit::AuditFilter` | struct | 1/7 | `src/data_governance/commands.rs`, `src/data_governance/critical_audit_tests.rs`, `src/data_governance/migration_tests.rs` 等 4 个 |
| `dstu_storage::audit::AuditRepository` | struct | 1/3 | `src/data_governance/commands.rs`, `src/data_governance/critical_audit_tests.rs`, `src/data_governance/migration_tests.rs` 等 4 个 |
| `dstu_storage::schema_registry::DatabaseStatus` | struct | 1/3 | `src/data_governance/commands.rs` |
| `dstu_storage::audit::AuditRepository::cleanup_keep_recent` | method | 1/0 | `src/data_governance/commands.rs` |
| `dstu_storage::audit::AuditRepository::cleanup_old_entries` | method | 1/0 | `src/data_governance/commands.rs` |
| `dstu_storage::audit::AuditRepository::query_paged` | method | 1/0 | `src/data_governance/commands.rs` |
| `dstu_storage::audit::AuditRepository::save` | method | 1/0 | `src/data_governance/commands.rs` |
| `dstu_storage::audit::SyncDirection` | enum | 1/0 | `src/data_governance/dto/mod.rs` |
| `dstu_storage::backup_common::calculate_bytes_hash` | fn | 1/0 | `crates/dstu-sync/src/data_governance/backup/zip_export.rs` |
| `dstu_storage::backup_common::current_data_governance_operation` | fn | 1/0 | `src/data_governance/commands.rs` |
| `dstu_storage::backup_common::DataGovernanceOperationSnapshot` | struct | 1/0 | `src/data_governance/commands_types.rs` |
| `dstu_storage::backup_common::is_crypto_secret_backup_relative_path` | fn | 1/0 | `crates/dstu-sync/src/data_governance/backup/zip_export.rs` |
| `dstu_storage::data_space::startup_health::StartupComponentStatus` | enum | 1/0 | `src/data_governance/mod.rs` |
| `dstu_storage::migration::get_migration_set` | fn | 1/0 | `src/data_governance/commands.rs` |
| `dstu_storage::unified_file_manager::copy_file` | fn | 1/0 | `src/data_governance/commands_zip.rs` |
| `dstu_storage::unified_file_manager::ensure_local_path` | fn | 1/0 | `src/data_governance/commands_zip.rs` |
| `dstu_storage::data_space::Slot` | enum | 0/29 | `src/data_governance/commands_restore.rs`, `tests/restore_domain_plan_tests.rs` |
| `dstu_storage::migration::mistakes::MISTAKES_MIGRATIONS` | const | 0/21 | `src/data_governance/commands.rs`, `src/data_governance/critical_audit_tests.rs`, `src/data_governance/migration_tests.rs` 等 4 个 |
| `dstu_storage::migration::vfs::VFS_MIGRATION_SET` | const | 0/17 | `src/data_governance/critical_audit_tests.rs`, `src/data_governance/migration_tests.rs`, `src/data_governance/tests.rs` |
| `dstu_storage::migration::chat_v2::CHAT_V2_MIGRATION_SET` | const | 0/13 | `src/data_governance/critical_audit_tests.rs`, `src/data_governance/migration_tests.rs`, `src/data_governance/tests.rs` |
| `dstu_storage::migration::llm_usage::LLM_USAGE_MIGRATION_SET` | const | 0/13 | `src/data_governance/critical_audit_tests.rs`, `src/data_governance/migration_tests.rs`, `src/data_governance/tests.rs` |
| `dstu_storage::migration::coordinator::MigrationReport` | struct | 0/12 | `src/data_governance/critical_audit_tests.rs`, `src/data_governance/migration_compat_tests.rs`, `src/data_governance/migration_tests.rs` 等 4 个 |
| `dstu_storage::backup_common::calculate_file_hash` | fn | 0/9 | `crates/dstu-sync/src/data_governance/backup/portable_precheck.rs`, `crates/dstu-sync/src/data_governance/backup/zip_export.rs`, `tests/zip_export_import_restore_tests.rs` |
| `dstu_storage::audit::AuditRepository::query` | method | 0/7 | `src/data_governance/critical_audit_tests.rs`, `src/data_governance/migration_tests.rs`, `src/data_governance/tests.rs` |
| `dstu_storage::data_space::DataSpaceManager::new` | method | 0/6 | `src/data_governance/commands_restore.rs`, `tests/restore_domain_plan_tests.rs` |
| `dstu_storage::migration::coordinator::DatabaseMigrationReport` | struct | 0/6 | `src/data_governance/critical_audit_tests.rs`, `src/data_governance/migration_tests.rs`, `src/data_governance/tests.rs` |
| `dstu_storage::migration::definitions::MigrationDef::new` | method | 0/6 | `src/data_governance/migration_tests.rs`, `src/data_governance/tests.rs` |
| `dstu_storage::migration::verifier::MigrationVerifier::verify` | method | 0/6 | `src/data_governance/migration_tests.rs`, `src/data_governance/tests.rs` |
| `dstu_storage::audit::AuditRepository::log_migration_complete` | method | 0/5 | `src/data_governance/critical_audit_tests.rs`, `src/data_governance/migration_tests.rs`, `src/data_governance/tests.rs` |
| `dstu_storage::audit::AuditRepository::count_by_type` | method | 0/4 | `src/data_governance/critical_audit_tests.rs`, `src/data_governance/migration_tests.rs`, `src/data_governance/tests.rs` |
| `dstu_storage::migration::verifier::MigrationVerifier` | struct | 0/3 | `src/data_governance/critical_audit_tests.rs`, `src/data_governance/migration_tests.rs`, `src/data_governance/tests.rs` |
| `dstu_storage::audit::AuditRepository::log_migration_failed` | method | 0/2 | `src/data_governance/migration_tests.rs` |
| `dstu_storage::data_space::DataSpaceManager` | struct | 0/2 | `src/data_governance/commands_restore.rs`, `tests/restore_domain_plan_tests.rs` |
| `dstu_storage::migration::ALL_MIGRATION_SETS` | const | 0/2 | `src/data_governance/migration_tests.rs` |
| `dstu_storage::database::Database::new` ? | method | 0/1 | `crates/dstu-sync/src/cloud_config_commands.rs` |
| `dstu_storage::migration::chat_v2::CHAT_V2_SCHEMA_VERSION` | const | 0/1 | `crates/dstu-sync/src/data_governance/backup/mod.rs` |

### L20-sync（62 个条目，prod 86 / test 15）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_sync::data_governance::sync::MergeStrategy` ? | enum | 14/4 | `src/data_governance/commands_backup.rs`, `src/data_governance/dto/mod.rs` |
| `dstu_sync::data_governance::sync::SyncChangeWithData` | struct | 4/4 | `src/data_governance/commands_backup.rs` |
| `dstu_sync::data_governance::sync::ChangeOperation` ? | enum | 3/3 | `src/data_governance/commands_backup.rs`, `src/data_governance/dto/mod.rs` |
| `deep_student_lib::data_governance::commands_sync::SyncExecutionResponse` | struct | 2/4 | `src/chat_v2/tools/data_governance_executor.rs`, `src/data_governance/dto/mod.rs` |
| `deep_student_lib::data_governance::commands_sync::data_governance_get_sync_status` | fn | 2/0 | `src/chat_v2/tools/data_governance_executor.rs`, `src/data_governance/mod.rs` |
| `deep_student_lib::data_governance::commands_sync::data_governance_run_sync` | fn | 2/0 | `src/chat_v2/tools/data_governance_executor.rs`, `src/data_governance/mod.rs` |
| `dstu_sync::data_governance::sync::classification::SyncCategory` | enum | 2/0 | `src/data_governance/commands_backup.rs` |
| `dstu_sync::data_governance::sync::SyncManager` | struct | 2/0 | `src/data_governance/commands_backup.rs` |
| `dstu_sync::data_governance::sync::SyncManager::timestamp_value_to_lww_string` | method | 2/0 | `src/data_governance/commands_backup.rs` |
| `deep_student_lib::data_governance::commands_sync::ConflictDetectionResponse` | struct | 1/0 | `src/data_governance/dto/mod.rs` |
| `deep_student_lib::data_governance::commands_sync::data_governance_count_record_conflicts` | fn | 1/0 | `src/data_governance/mod.rs` |
| `deep_student_lib::data_governance::commands_sync::data_governance_detect_conflicts` | fn | 1/0 | `src/data_governance/mod.rs` |
| `deep_student_lib::data_governance::commands_sync::data_governance_detect_prune_gap` | fn | 1/0 | `src/data_governance/mod.rs` |
| `deep_student_lib::data_governance::commands_sync::data_governance_export_sync_data` | fn | 1/0 | `src/data_governance/mod.rs` |
| `deep_student_lib::data_governance::commands_sync::data_governance_import_sync_data` | fn | 1/0 | `src/data_governance/mod.rs` |
| `deep_student_lib::data_governance::commands_sync::data_governance_list_record_conflicts` | fn | 1/0 | `src/data_governance/mod.rs` |
| `deep_student_lib::data_governance::commands_sync::data_governance_list_sync_snapshot_batches` | fn | 1/0 | `src/data_governance/mod.rs` |
| `deep_student_lib::data_governance::commands_sync::data_governance_list_unsynced_items` | fn | 1/0 | `src/data_governance/mod.rs` |
| `deep_student_lib::data_governance::commands_sync::data_governance_mark_asset_deleted` | fn | 1/0 | `src/data_governance/mod.rs` |
| `deep_student_lib::data_governance::commands_sync::data_governance_mark_blob_deleted` | fn | 1/0 | `src/data_governance/mod.rs` |
| `deep_student_lib::data_governance::commands_sync::data_governance_purge_resolved_conflicts` | fn | 1/0 | `src/data_governance/mod.rs` |
| `deep_student_lib::data_governance::commands_sync::data_governance_repo_check` | fn | 1/0 | `src/data_governance/mod.rs` |
| `deep_student_lib::data_governance::commands_sync::data_governance_resolve_conflicts` | fn | 1/0 | `src/data_governance/mod.rs` |
| `deep_student_lib::data_governance::commands_sync::data_governance_resolve_record_conflict` | fn | 1/0 | `src/data_governance/mod.rs` |
| `deep_student_lib::data_governance::commands_sync::data_governance_rollback_sync_snapshot_batch` | fn | 1/0 | `src/data_governance/mod.rs` |
| `deep_student_lib::data_governance::commands_sync::data_governance_run_sync_with_progress` | fn | 1/0 | `src/data_governance/mod.rs` |
| `deep_student_lib::data_governance::commands_sync::DatabaseConflictResponse` | struct | 1/0 | `src/data_governance/dto/mod.rs` |
| `deep_student_lib::data_governance::commands_sync::DatabaseSyncStatusResponse` | struct | 1/0 | `src/data_governance/dto/mod.rs` |
| `deep_student_lib::data_governance::commands_sync::SyncExportData` | struct | 1/0 | `src/data_governance/dto/mod.rs` |
| `deep_student_lib::data_governance::commands_sync::SyncExportResponse` | struct | 1/0 | `src/data_governance/dto/mod.rs` |
| `deep_student_lib::data_governance::commands_sync::SyncImportResponse` | struct | 1/0 | `src/data_governance/dto/mod.rs` |
| `deep_student_lib::data_governance::commands_sync::SyncResultResponse` | struct | 1/0 | `src/data_governance/dto/mod.rs` |
| `deep_student_lib::data_governance::commands_sync::SyncStatusResponse` | struct | 1/0 | `src/data_governance/dto/mod.rs` |
| `dstu_sync::data_governance::sync::ChangeLogEntry` | struct | 1/0 | `src/data_governance/dto/mod.rs` |
| `dstu_sync::data_governance::sync::ChangeLogStats` | struct | 1/0 | `src/data_governance/dto/mod.rs` |
| `dstu_sync::data_governance::sync::classification::sync_classification_registry` | fn | 1/0 | `src/data_governance/commands_backup.rs` |
| `dstu_sync::data_governance::sync::ConflictDetectionResult` | struct | 1/0 | `src/data_governance/dto/mod.rs` |
| `dstu_sync::data_governance::sync::ConflictRecord` | struct | 1/0 | `src/data_governance/dto/mod.rs` |
| `dstu_sync::data_governance::sync::DatabaseConflict` | struct | 1/0 | `src/data_governance/dto/mod.rs` |
| `dstu_sync::data_governance::sync::DatabaseConflictType` | enum | 1/0 | `src/data_governance/dto/mod.rs` |
| `dstu_sync::data_governance::sync::DatabaseSyncState` | struct | 1/0 | `src/data_governance/dto/mod.rs` |
| `dstu_sync::data_governance::sync::emitter::EVENT_NAME` | const | 1/0 | `src/data_governance/mod.rs` |
| `dstu_sync::data_governance::sync::emitter::SyncProgressEmitter` | struct | 1/0 | `src/data_governance/mod.rs` |
| `dstu_sync::data_governance::sync::MergeApplicationResult` | struct | 1/0 | `src/data_governance/dto/mod.rs` |
| `dstu_sync::data_governance::sync::PendingChanges` | struct | 1/0 | `src/data_governance/dto/mod.rs` |
| `dstu_sync::data_governance::sync::progress::SyncPhase` | enum | 1/0 | `src/data_governance/mod.rs` |
| `dstu_sync::data_governance::sync::progress::SyncProgress` | struct | 1/0 | `src/data_governance/mod.rs` |
| `dstu_sync::data_governance::sync::RecordSnapshot` | struct | 1/0 | `src/data_governance/dto/mod.rs` |
| `dstu_sync::data_governance::sync::ResolvedRecord` | struct | 1/0 | `src/data_governance/dto/mod.rs` |
| `dstu_sync::data_governance::sync::state::SyncStateStore::open_default` | method | 1/0 | `src/data_governance/commands_restore.rs` |
| `dstu_sync::data_governance::sync::SyncDirection` | enum | 1/0 | `src/data_governance/dto/mod.rs` |
| `dstu_sync::data_governance::sync::SyncExecutionResult` | struct | 1/0 | `src/data_governance/dto/mod.rs` |
| `dstu_sync::data_governance::sync::SyncManager::apply_downloaded_changes_with_conflict_guard` | method | 1/0 | `src/data_governance/commands_backup.rs` |
| `dstu_sync::data_governance::sync::SyncManager::compare_lww_timestamps` | method | 1/0 | `src/data_governance/commands_backup.rs` |
| `dstu_sync::data_governance::sync::SyncManager::get_record_data` | method | 1/0 | `src/data_governance/commands_backup.rs` |
| `dstu_sync::data_governance::sync::SyncManager::lww_device_pair` | method | 1/0 | `src/data_governance/commands_backup.rs` |
| `dstu_sync::data_governance::sync::SyncManager::records_semantically_equal_for_sync` | method | 1/0 | `src/data_governance/commands_backup.rs` |
| `dstu_sync::data_governance::sync::SyncManager::replay_quarantined_changes` | method | 1/0 | `src/data_governance/commands_backup.rs` |
| `dstu_sync::data_governance::sync::SyncManager::reset_sync_baseline_after_restore` | method | 1/0 | `src/data_governance/commands_restore.rs` |
| `dstu_sync::data_governance::sync::SyncManifest` | struct | 1/0 | `src/data_governance/dto/mod.rs` |
| `dstu_sync::data_governance::sync::SyncResult` | struct | 1/0 | `src/data_governance/dto/mod.rs` |
| `dstu_sync::data_governance::sync::SyncTransactionStatus` | enum | 1/0 | `src/data_governance/dto/mod.rs` |

### F4-security（33 个条目，prod 76 / test 8）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_core::error_details::CommandError` | struct | 9/0 | `crates/dstu-sync/src/cloud_config_commands.rs` |
| `dstu_core::error_details::CommandError::new` | method | 8/0 | `crates/dstu-sync/src/cloud_config_commands.rs` |
| `dstu_security::secure_store::SecureStore::restrict_permissions` ? | method | 7/0 | `crates/dstu-sync/src/data_governance/backup/mod.rs` |
| `dstu_security::secure_store::CloudStorageCredentials` ? | struct | 5/2 | `crates/dstu-sync/src/cloud_config_commands.rs`, `crates/dstu-sync/src/cloud_credentials.rs` |
| `dstu_security::secure_store::SecureStoreConfig` ? | struct | 4/1 | `crates/dstu-sync/src/cloud_config_commands.rs`, `crates/dstu-sync/src/cloud_credentials.rs`, `crates/dstu-sync/src/data_governance/backup/mod.rs` |
| `dstu_core::tool_names::strip_tool_namespace` ? | fn | 4/0 | `src/chat_v2/tools/data_governance_executor.rs` |
| `dstu_security::secure_store::SecureStore::new_with_dir` ? | method | 3/1 | `crates/dstu-sync/src/cloud_config_commands.rs`, `crates/dstu-sync/src/cloud_credentials.rs`, `crates/dstu-sync/src/data_governance/backup/mod.rs` |
| `dstu_security::crypto_publication::remove_journal` | fn | 3/0 | `crates/dstu-sync/src/data_governance/backup/mod.rs` |
| `dstu_security::crypto::backup_crypto::decrypt_backup_file` | fn | 2/2 | `crates/dstu-sync/src/data_governance/backup/portable_precheck.rs`, `crates/dstu-sync/src/data_governance/backup/zip_export.rs`, `tests/zip_export_import_restore_tests.rs` |
| `dstu_security::secure_store::cloud_encryption_password_too_short` ? | fn | 2/0 | `crates/dstu-sync/src/cloud_config_commands.rs`, `src/data_governance/commands_zip.rs` |
| `dstu_security::secure_store::CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE` ? | const | 2/0 | `crates/dstu-sync/src/cloud_config_commands.rs` |
| `dstu_security::secure_store::cloud_encryption_password_too_short_message` ? | fn | 2/0 | `crates/dstu-sync/src/cloud_config_commands.rs`, `src/data_governance/commands_zip.rs` |
| `dstu_security::secure_store::SecureStore` ? | struct | 2/0 | `crates/dstu-sync/src/cloud_config_commands.rs`, `crates/dstu-sync/src/cloud_credentials.rs` |
| `dstu_security::secure_store::SecureStore::new` ? | method | 2/0 | `crates/dstu-sync/src/cloud_config_commands.rs`, `crates/dstu-sync/src/cloud_credentials.rs` |
| `dstu_security::secure_store::SecureStore::validate_backup_seed_file` ? | method | 2/0 | `crates/dstu-sync/src/data_governance/backup/mod.rs` |
| `dstu_security::secure_store::SecureStoreError` ? | enum | 2/0 | `crates/dstu-sync/src/cloud_config_commands.rs` |
| `dstu_security::crypto::backup_crypto::encrypt_backup_file` | fn | 1/2 | `crates/dstu-sync/src/data_governance/backup/portable_precheck.rs`, `crates/dstu-sync/src/data_governance/backup/zip_export.rs`, `tests/zip_export_import_restore_tests.rs` |
| `deep_student_lib::backup_config::default_recovery_backup_dir` | fn | 1/0 | `src/data_governance/commands_backup.rs` |
| `dstu_core::agent::ToolCall` ? | struct | 1/0 | `src/chat_v2/tools/data_governance_executor.rs` |
| `dstu_core::agent::ToolResultInfo` ? | struct | 1/0 | `src/chat_v2/tools/data_governance_executor.rs` |
| `dstu_core::agent::ToolResultInfo::failure` ? | method | 1/0 | `src/chat_v2/tools/data_governance_executor.rs` |
| `dstu_core::agent::ToolResultInfo::success` ? | method | 1/0 | `src/chat_v2/tools/data_governance_executor.rs` |
| `dstu_core::models::AppError` | struct | 1/0 | `crates/dstu-sync/src/cloud_config_commands.rs` |
| `dstu_security::crypto_publication::CryptoPublicationJournal` | struct | 1/0 | `crates/dstu-sync/src/data_governance/backup/mod.rs` |
| `dstu_security::crypto_publication::journal_path` | fn | 1/0 | `crates/dstu-sync/src/data_governance/backup/mod.rs` |
| `dstu_security::crypto_publication::rollback_dir` | fn | 1/0 | `crates/dstu-sync/src/data_governance/backup/mod.rs` |
| `dstu_security::crypto_publication::sync_directory` | fn | 1/0 | `crates/dstu-sync/src/data_governance/backup/mod.rs` |
| `dstu_security::crypto_publication::write_journal` | fn | 1/0 | `crates/dstu-sync/src/data_governance/backup/mod.rs` |
| `dstu_security::secure_store::CLOUD_CREDENTIALS_GENERATION_CONFLICT_CODE` ? | const | 1/0 | `crates/dstu-sync/src/cloud_config_commands.rs` |
| `dstu_security::secure_store::CLOUD_ENCRYPTION_PASSWORD_TOO_WEAK_CODE` ? | const | 1/0 | `crates/dstu-sync/src/cloud_config_commands.rs` |
| `dstu_security::secure_store::SecureStore::reseal_seed_file_for_current_platform` ? | method | 1/0 | `crates/dstu-sync/src/data_governance/backup/mod.rs` |
| `dstu_security::secure_store::SecureStore::resolve_seed_file_plaintext` ? | method | 1/0 | `crates/dstu-sync/src/data_governance/backup/zip_export.rs` |
| `dstu_util::utils::text::safe_truncate_chars` ? | fn | 1/0 | `src/data_governance/commands.rs` |

### L23-sync-providers（10 个条目，prod 27 / test 18）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_sync::cloud_storage::config::CloudStorageConfig` ? | struct | 11/5 | `crates/dstu-sync/src/cloud_config_commands.rs`, `crates/dstu-sync/src/cloud_credentials.rs`, `src/data_governance/commands_zip.rs` |
| `dstu_sync::cloud_storage::config::StorageProvider` | enum | 4/6 | `crates/dstu-sync/src/cloud_config_commands.rs`, `crates/dstu-sync/src/cloud_credentials.rs` |
| `dstu_sync::cloud_storage::config::PlatformStorageCapabilities` | struct | 3/0 | `crates/dstu-sync/src/cloud_config_commands.rs` |
| `dstu_sync::cloud_storage::config::PlatformStorageCapabilities::current` | method | 3/0 | `crates/dstu-sync/src/cloud_config_commands.rs` |
| `dstu_sync::cloud_storage::config::WebDavConfig` | struct | 1/4 | `crates/dstu-sync/src/cloud_config_commands.rs`, `crates/dstu-sync/src/cloud_credentials.rs` |
| `dstu_sync::cloud_storage::config::FtpConfig` | struct | 1/2 | `crates/dstu-sync/src/cloud_config_commands.rs`, `crates/dstu-sync/src/cloud_credentials.rs` |
| `dstu_sync::cloud_storage::config::S3Config` | struct | 1/1 | `crates/dstu-sync/src/cloud_config_commands.rs`, `crates/dstu-sync/src/cloud_credentials.rs` |
| `dstu_sync::cloud_storage::create_storage` | fn | 1/0 | `crates/dstu-sync/src/cloud_config_commands.rs` |
| `dstu_sync::cloud_storage::delta_format::MAX_LOGICAL_PATH_BYTES` | const | 1/0 | `crates/dstu-sync/src/data_governance/backup/delta_inventory.rs` |
| `dstu_sync::cloud_storage::delta_format::MAX_SNAPSHOT_FILES` | const | 1/0 | `crates/dstu-sync/src/data_governance/backup/delta_inventory.rs` |

### F1-kernel（6 个条目，prod 14 / test 3）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent_api::executor::ToolSensitivity` ? | enum | 3/2 | `src/chat_v2/tools/data_governance_executor.rs` |
| `dstu_agent_api::executor::ToolConcurrency` ? | enum | 3/1 | `src/chat_v2/tools/data_governance_executor.rs` |
| `dstu_kernel::disposer::Disposer` | struct | 2/0 | `crates/dstu-sync/src/cloud_credentials.rs`, `crates/dstu-sync/src/hooks.rs` |
| `dstu_kernel::slot::Slot` | struct | 2/0 | `crates/dstu-sync/src/cloud_credentials.rs`, `crates/dstu-sync/src/hooks.rs` |
| `dstu_kernel::slot::Slot::new` | method | 2/0 | `crates/dstu-sync/src/cloud_credentials.rs`, `crates/dstu-sync/src/hooks.rs` |
| `dstu_kernel::slot::SlotOccupied` | struct | 2/0 | `crates/dstu-sync/src/cloud_credentials.rs`, `crates/dstu-sync/src/hooks.rs` |

### L04-chat-session（3 个条目，prod 13 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::database::ChatV2Database` ? | struct | 6/0 | `src/data_governance/commands.rs`, `src/data_governance/commands_backup.rs`, `src/data_governance/commands_restore.rs` |
| `dstu_agent::chat_v2::tools::executor::ExecutionContext` ? | struct | 6/0 | `src/chat_v2/tools/data_governance_executor.rs` |
| `dstu_agent::chat_v2::tools::executor::ToolExecutor` ? | trait | 1/0 | `src/chat_v2/tools/data_governance_executor.rs` |

### L05-agent-workspace（1 个条目，prod 6 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::workspace::coordinator::WorkspaceCoordinator` ? | struct | 6/0 | `src/data_governance/commands.rs`, `src/data_governance/commands_backup.rs`, `src/data_governance/commands_restore.rs` |

### L22-app-commands（1 个条目，prod 6 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::commands::AppState` | struct | 6/0 | `src/data_governance/commands.rs`, `src/data_governance/commands_backup.rs`, `src/data_governance/commands_restore.rs` |

### L15-review-analytics（2 个条目，prod 2 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_learning::mastery::service::MasteryService::new` ? | method | 1/0 | `src/data_governance/commands_backup.rs` |
| `dstu_learning::mastery::service::MasteryService::recompute_all_states_with_conn` ? | method | 1/0 | `src/data_governance/commands_backup.rs` |

### F2-shell（2 个条目，prod 2 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_platform::startup_gate::STARTUP_READY_WAIT` | const | 1/0 | `src/data_governance/commands.rs` |
| `dstu_platform::startup_gate::wait_startup_ready` | fn | 1/0 | `src/data_governance/commands.rs` |

### L13-vfs-api（3 个条目，prod 1 / test 3）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::database::VfsDatabase::new` | method | 1/1 | `src/data_governance/commands_backup.rs`, `src/data_governance/migration_compat_tests.rs` |
| `dstu_vfs::vfs::database::setup_migrated_test_db` | fn | 0/1 | `crates/dstu-sync/src/data_governance/backup/mod.rs` |
| `dstu_vfs::vfs::types::VfsCreateNoteParams` ? | struct | 0/1 | `src/data_governance/migration_compat_tests.rs` |

### L11-vfs-repos（1 个条目，prod 0 / test 1）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::repos::embedding_dim_repo::register_with_model` ? | fn | 0/1 | `crates/dstu-sync/src/data_governance/backup/mod.rs` |

### L10-notes（2 个条目，prod 0 / test 2）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::create_note` ? | method | 0/1 | `src/data_governance/migration_compat_tests.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::search_notes_with_snippets` | method | 0/1 | `src/data_governance/migration_compat_tests.rs` |

## glob 导入（模块级，不确定具体条目）

- 被 F4-security 导入：`use dstu_sync::cloud_config_commands::*` @ `src/cloud_config_commands.rs:8`
- 导入 F4-security：`use dstu_security::secure_store::*` @ `crates/dstu-sync/src/lib.rs:35`
