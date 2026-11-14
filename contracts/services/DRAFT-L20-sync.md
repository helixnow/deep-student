# 跨 lane 服务草稿：L20-sync

> 生成文件（`node scripts/electron-migration/services-draft.mjs`），不要手改。这是 `contracts/services/`
> 正式契约的**输入**：提供方 lane 据此设计 `<service>@1` 接口，消费方 lane 据此确认依赖。
>
> 方法：tree-sitter-rust 解析全部 Rust 文件，建立模块树（`mod` 声明 + `#[path]`）与 `use` / `pub use`
> 重导出链；把 (1) `use` 导入、(2) 代码中的限定路径（含 `Type::method`）解析到定义处，定义与引用分属
> 不同 lane 即记一条。值上的方法调用（`x.method()`）需要类型推断，**不统计**——"提供"清单偏少不偏多。
> `?` = 不确定（经 glob 重导出，或定义文件不在模块树内）。计数 = 引用点（导入名在文件中的出现次数）；
> prod / test 按是否位于 `#[cfg(test)]` / `mod tests` / `tests/` 区分。

## 提供给其他 lane（116 个条目，其中 63 个有生产代码引用）

| 条目 | 种类 | 定义 | 消费方（prod/test 引用点） | 签名 |
|---|---|---|---|---|
| `dstu_sync::data_governance::sync::MergeStrategy` ? | enum | `crates/dstu-sync/src/data_governance/sync/mod.rs:311` | L21-backup-governance 14/4<br>L23-sync-providers 0/7 | `pub enum MergeStrategy` |
| `dstu_sync::data_governance::sync::SyncChangeWithData` | struct | `crates/dstu-sync/src/data_governance/sync/mod.rs:9769` | L21-backup-governance 4/4<br>L23-sync-providers 0/156<br>L22-app-commands 0/21 | `pub struct SyncChangeWithData` |
| `dstu_sync::data_governance::sync::ChangeOperation` ? | enum | `crates/dstu-sync/src/data_governance/sync/mod.rs:9734` | L21-backup-governance 3/3<br>L23-sync-providers 0/294<br>L22-app-commands 0/19 | `pub enum ChangeOperation` |
| `dstu_sync::data_governance::sync::SyncManager` | struct | `crates/dstu-sync/src/data_governance/sync/mod.rs:819` | L21-backup-governance 2/0<br>L23-sync-providers 0/52<br>L22-app-commands 0/12 | `pub struct SyncManager` |
| `dstu_sync::data_governance::sync::classification::SyncCategory` | enum | `crates/dstu-sync/src/data_governance/sync/classification.rs:5` | L21-backup-governance 2/0<br>L23-sync-providers 0/15 | `pub enum SyncCategory` |
| `deep_student_lib::data_governance::commands_sync::SyncExecutionResponse` | struct | `src/data_governance/commands_sync.rs:2322` | L21-backup-governance 2/4 | `pub struct SyncExecutionResponse` |
| `deep_student_lib::data_governance::commands_sync::data_governance_get_sync_status` | fn | `src/data_governance/commands_sync.rs:1026` | L21-backup-governance 2/0 | `pub async fn data_governance_get_sync_status( app: tauri::AppHandle, ) -> Result<SyncStatusResponse, String>` |
| `deep_student_lib::data_governance::commands_sync::data_governance_run_sync` | fn | `src/data_governance/commands_sync.rs:1586` | L21-backup-governance 2/0 | `pub async fn data_governance_run_sync( app: tauri::AppHandle, direction: String, cloud_config: Option<CloudStorageConfig>, strategy: Option<String>, ) -> Result<SyncExecutionResponse, String>` |
| `dstu_sync::data_governance::sync::SyncManager::timestamp_value_to_lww_string` | method | `crates/dstu-sync/src/data_governance/sync/mod.rs:4672` | L21-backup-governance 2/0 | `pub fn timestamp_value_to_lww_string(value: &serde_json::Value) -> Option<String>` |
| `dstu_sync::data_governance::sync::SyncDirection` | enum | `crates/dstu-sync/src/data_governance/sync/mod.rs:10106` | L21-backup-governance 1/0<br>L23-sync-providers 0/119 | `pub enum SyncDirection` |
| `dstu_sync::data_governance::sync::SyncManager::apply_downloaded_changes_with_conflict_guard` | method | `crates/dstu-sync/src/data_governance/sync/mod.rs:7760` | L21-backup-governance 1/0<br>L23-sync-providers 0/55<br>L22-app-commands 0/9 | `pub fn apply_downloaded_changes_with_conflict_guard( conn: &Connection, changes: &[SyncChangeWithData], id_column_map: Option<&HashMap<String, String>>, policy: conflict_resolver::ConflictPolicy, cloud_device_id: Option<&str>, local_device_id: Option<&str>, ) -> Result< ( ApplyChangesResult, conflict_resolver::Confl...` |
| `dstu_sync::data_governance::sync::classification::sync_classification_registry` | fn | `crates/dstu-sync/src/data_governance/sync/classification.rs:49` | L21-backup-governance 1/0<br>L23-sync-providers 0/35 | `pub fn sync_classification_registry() -> Vec<TableClassification>` |
| `dstu_sync::data_governance::sync::SyncManager::reset_sync_baseline_after_restore` | method | `crates/dstu-sync/src/data_governance/sync/mod.rs:4432` | L21-backup-governance 1/0<br>L23-sync-providers 0/14 | `pub fn reset_sync_baseline_after_restore( conn: &Connection, ) -> Result<(usize, usize), SyncError>` |
| `deep_student_lib::data_governance::commands_sync::data_governance_resolve_record_conflict` | fn | `src/data_governance/commands_sync.rs:4611` | L21-backup-governance 1/0<br>L23-sync-providers 0/5<br>L22-app-commands 0/2 | `pub async fn data_governance_resolve_record_conflict( app: tauri::AppHandle, database_name: String, table_name: String, record_id: String, resolution: String, merged_data_json: Option<String>, expected_conflict_ids: Vec<i64>, ) -> Result<(), String>` |
| `dstu_sync::data_governance::sync::SyncManifest` | struct | `crates/dstu-sync/src/data_governance/sync/mod.rs:171` | L21-backup-governance 1/0<br>L23-sync-providers 0/4<br>L22-app-commands 0/2 | `pub struct SyncManifest` |
| `dstu_sync::data_governance::sync::SyncTransactionStatus` | enum | `crates/dstu-sync/src/data_governance/sync/mod.rs:219` | L21-backup-governance 1/0<br>L23-sync-providers 0/2<br>L22-app-commands 0/2 | `pub enum SyncTransactionStatus` |
| `deep_student_lib::data_governance::commands_sync::data_governance_list_record_conflicts` | fn | `src/data_governance/commands_sync.rs:4407` | L21-backup-governance 1/0<br>L23-sync-providers 0/2 | `pub async fn data_governance_list_record_conflicts( app: tauri::AppHandle, limit: Option<u32>, offset: Option<u32>, ) -> Result<Vec<RecordConflictRow>, String>` |
| `deep_student_lib::data_governance::commands_sync::data_governance_list_sync_snapshot_batches` | fn | `src/data_governance/commands_sync.rs:5187` | L21-backup-governance 1/0<br>L22-app-commands 0/1 | `pub async fn data_governance_list_sync_snapshot_batches( app: tauri::AppHandle, limit: Option<u32>, ) -> Result<Vec<SyncSnapshotBatchRow>, String>` |
| `deep_student_lib::data_governance::commands_sync::data_governance_rollback_sync_snapshot_batch` | fn | `src/data_governance/commands_sync.rs:5245` | L21-backup-governance 1/0<br>L22-app-commands 0/1 | `pub async fn data_governance_rollback_sync_snapshot_batch( app: tauri::AppHandle, database_name: String, batch_id: String, ) -> Result<RollbackSnapshotResponse, String>` |
| `dstu_sync::data_governance::sync::DatabaseSyncState` | struct | `crates/dstu-sync/src/data_governance/sync/mod.rs:205` | L21-backup-governance 1/0<br>L22-app-commands 0/1 | `pub struct DatabaseSyncState` |
| `dstu_sync::data_governance::sync::SyncManager::replay_quarantined_changes` | method | `crates/dstu-sync/src/data_governance/sync/mod.rs:6884` | L21-backup-governance 1/0<br>L23-sync-providers 0/1 | `pub fn replay_quarantined_changes( conn: &Connection, id_columns: Option<&HashMap<String, String>>, max_attempts: i64, ) -> Result<usize, SyncError>` |
| `deep_student_lib::data_governance::commands_sync::ConflictDetectionResponse` | struct | `src/data_governance/commands_sync.rs:1385` | L21-backup-governance 1/0 | `pub struct ConflictDetectionResponse` |
| `deep_student_lib::data_governance::commands_sync::data_governance_count_record_conflicts` | fn | `src/data_governance/commands_sync.rs:4551` | L21-backup-governance 1/0 | `pub async fn data_governance_count_record_conflicts( app: tauri::AppHandle, ) -> Result<RecordConflictCounts, String>` |
| `deep_student_lib::data_governance::commands_sync::data_governance_detect_conflicts` | fn | `src/data_governance/commands_sync.rs:1281` | L21-backup-governance 1/0 | `pub async fn data_governance_detect_conflicts( app: tauri::AppHandle, cloud_manifest_json: Option<String>, cloud_config: Option<CloudStorageConfig>, ) -> Result<ConflictDetectionResponse, String>` |
| `deep_student_lib::data_governance::commands_sync::data_governance_detect_prune_gap` | fn | `src/data_governance/commands_sync.rs:5071` | L21-backup-governance 1/0 | `pub async fn data_governance_detect_prune_gap( app: tauri::AppHandle, mut cloud_config: CloudStorageConfig, ) -> Result<PruneGapResponse, String>` |
| `deep_student_lib::data_governance::commands_sync::data_governance_export_sync_data` | fn | `src/data_governance/commands_sync.rs:2369` | L21-backup-governance 1/0 | `pub async fn data_governance_export_sync_data( app: tauri::AppHandle, window: Window, output_path: Option<String>, ) -> Result<SyncExportResponse, String>` |
| `deep_student_lib::data_governance::commands_sync::data_governance_import_sync_data` | fn | `src/data_governance/commands_sync.rs:2571` | L21-backup-governance 1/0 | `pub async fn data_governance_import_sync_data( app: tauri::AppHandle, window: Window, input_path: String, strategy: Option<String>, ) -> Result<SyncImportResponse, String>` |
| `deep_student_lib::data_governance::commands_sync::data_governance_list_unsynced_items` | fn | `src/data_governance/commands_sync.rs:5813` | L21-backup-governance 1/0 | `pub async fn data_governance_list_unsynced_items( app: tauri::AppHandle, mut cloud_config: CloudStorageConfig, ) -> Result<UnsyncedItemsReport, String>` |
| `deep_student_lib::data_governance::commands_sync::data_governance_mark_asset_deleted` | fn | `src/data_governance/commands_sync.rs:4105` | L21-backup-governance 1/0 | `pub async fn data_governance_mark_asset_deleted( app: tauri::AppHandle, key: String, size: Option<u64>, mut cloud_config: CloudStorageConfig, ) -> Result<(), String>` |
| `deep_student_lib::data_governance::commands_sync::data_governance_mark_blob_deleted` | fn | `src/data_governance/commands_sync.rs:4063` | L21-backup-governance 1/0 | `pub async fn data_governance_mark_blob_deleted( app: tauri::AppHandle, hash: String, relative_path: Option<String>, size: Option<u64>, mut cloud_config: CloudStorageConfig, ) -> Result<(), String>` |
| `deep_student_lib::data_governance::commands_sync::data_governance_purge_resolved_conflicts` | fn | `src/data_governance/commands_sync.rs:5011` | L21-backup-governance 1/0 | `pub async fn data_governance_purge_resolved_conflicts( app: tauri::AppHandle, older_than_days: Option<u32>, ) -> Result<u64, String>` |
| `deep_student_lib::data_governance::commands_sync::data_governance_repo_check` | fn | `src/data_governance/commands_sync.rs:5151` | L21-backup-governance 1/0 | `pub async fn data_governance_repo_check( app: tauri::AppHandle, mut cloud_config: CloudStorageConfig, ) -> Result<crate::cloud_storage::repo_check::RepoCheckReport, String>` |
| `deep_student_lib::data_governance::commands_sync::data_governance_resolve_conflicts` | fn | `src/data_governance/commands_sync.rs:1429` | L21-backup-governance 1/0 | `pub async fn data_governance_resolve_conflicts( app: tauri::AppHandle, strategy: String, cloud_manifest_json: String, ) -> Result<SyncResultResponse, String>` |
| `deep_student_lib::data_governance::commands_sync::data_governance_run_sync_with_progress` | fn | `src/data_governance/commands_sync.rs:2859` | L21-backup-governance 1/0 | `pub async fn data_governance_run_sync_with_progress( app: tauri::AppHandle, direction: String, cloud_config: Option<CloudStorageConfig>, strategy: Option<String>, ) -> Result<SyncExecutionResponse, String>` |
| `deep_student_lib::data_governance::commands_sync::DatabaseConflictResponse` | struct | `src/data_governance/commands_sync.rs:1402` | L21-backup-governance 1/0 | `pub struct DatabaseConflictResponse` |
| `deep_student_lib::data_governance::commands_sync::DatabaseSyncStatusResponse` | struct | `src/data_governance/commands_sync.rs:1252` | L21-backup-governance 1/0 | `pub struct DatabaseSyncStatusResponse` |
| `deep_student_lib::data_governance::commands_sync::SyncExportData` | struct | `src/data_governance/commands_sync.rs:2509` | L21-backup-governance 1/0 | `pub struct SyncExportData` |
| `deep_student_lib::data_governance::commands_sync::SyncExportResponse` | struct | `src/data_governance/commands_sync.rs:2548` | L21-backup-governance 1/0 | `pub struct SyncExportResponse` |
| `deep_student_lib::data_governance::commands_sync::SyncImportResponse` | struct | `src/data_governance/commands_sync.rs:2757` | L21-backup-governance 1/0 | `pub struct SyncImportResponse` |
| `deep_student_lib::data_governance::commands_sync::SyncResultResponse` | struct | `src/data_governance/commands_sync.rs:1550` | L21-backup-governance 1/0 | `pub struct SyncResultResponse` |
| `deep_student_lib::data_governance::commands_sync::SyncStatusResponse` | struct | `src/data_governance/commands_sync.rs:1224` | L21-backup-governance 1/0 | `pub struct SyncStatusResponse` |
| `dstu_sync::data_governance::sync::ChangeLogEntry` | struct | `crates/dstu-sync/src/data_governance/sync/mod.rs:9902` | L21-backup-governance 1/0 | `pub struct ChangeLogEntry` |
| `dstu_sync::data_governance::sync::ChangeLogStats` | struct | `crates/dstu-sync/src/data_governance/sync/mod.rs:9668` | L21-backup-governance 1/0 | `pub struct ChangeLogStats` |
| `dstu_sync::data_governance::sync::ConflictDetectionResult` | struct | `crates/dstu-sync/src/data_governance/sync/mod.rs:281` | L21-backup-governance 1/0 | `pub struct ConflictDetectionResult` |
| `dstu_sync::data_governance::sync::ConflictRecord` | struct | `crates/dstu-sync/src/data_governance/sync/mod.rs:258` | L21-backup-governance 1/0 | `pub struct ConflictRecord` |
| `dstu_sync::data_governance::sync::DatabaseConflict` | struct | `crates/dstu-sync/src/data_governance/sync/mod.rs:230` | L21-backup-governance 1/0 | `pub struct DatabaseConflict` |
| `dstu_sync::data_governance::sync::DatabaseConflictType` | enum | `crates/dstu-sync/src/data_governance/sync/mod.rs:243` | L21-backup-governance 1/0 | `pub enum DatabaseConflictType` |
| `dstu_sync::data_governance::sync::emitter::EVENT_NAME` | const | `crates/dstu-sync/src/data_governance/sync/emitter.rs:12` | L21-backup-governance 1/0 | `pub const EVENT_NAME: &str = "data-governance-sync-progress"` |
| `dstu_sync::data_governance::sync::emitter::SyncProgressEmitter` | struct | `crates/dstu-sync/src/data_governance/sync/emitter.rs:22` | L21-backup-governance 1/0 | `pub struct SyncProgressEmitter` |
| `dstu_sync::data_governance::sync::MergeApplicationResult` | struct | `crates/dstu-sync/src/data_governance/sync/mod.rs:10063` | L21-backup-governance 1/0 | `pub struct MergeApplicationResult` |
| `dstu_sync::data_governance::sync::PendingChanges` | struct | `crates/dstu-sync/src/data_governance/sync/mod.rs:9982` | L21-backup-governance 1/0 | `pub struct PendingChanges` |
| `dstu_sync::data_governance::sync::progress::SyncPhase` | enum | `crates/dstu-sync/src/data_governance/sync/progress.rs:11` | L21-backup-governance 1/0 | `pub enum SyncPhase` |
| `dstu_sync::data_governance::sync::progress::SyncProgress` | struct | `crates/dstu-sync/src/data_governance/sync/progress.rs:61` | L21-backup-governance 1/0 | `pub struct SyncProgress` |
| `dstu_sync::data_governance::sync::RecordSnapshot` | struct | `crates/dstu-sync/src/data_governance/sync/mod.rs:9679` | L21-backup-governance 1/0 | `pub struct RecordSnapshot` |
| `dstu_sync::data_governance::sync::ResolvedRecord` | struct | `crates/dstu-sync/src/data_governance/sync/mod.rs:9715` | L21-backup-governance 1/0 | `pub struct ResolvedRecord` |
| `dstu_sync::data_governance::sync::state::SyncStateStore::open_default` | method | `crates/dstu-sync/src/data_governance/sync/state.rs:22` | L21-backup-governance 1/0 | `pub fn open_default() -> Result<Self, SyncError>` |
| `dstu_sync::data_governance::sync::state::SyncStateStore::reset_default_after_local_purge` | method | `crates/dstu-sync/src/data_governance/sync/state.rs:528` | F2-shell 1/0 | `pub fn reset_default_after_local_purge() -> Result<(), SyncError>` |
| `dstu_sync::data_governance::sync::SyncExecutionResult` | struct | `crates/dstu-sync/src/data_governance/sync/mod.rs:10138` | L21-backup-governance 1/0 | `pub struct SyncExecutionResult` |
| `dstu_sync::data_governance::sync::SyncManager::compare_lww_timestamps` | method | `crates/dstu-sync/src/data_governance/sync/mod.rs:4657` | L21-backup-governance 1/0 | `pub fn compare_lww_timestamps( local_timestamp: &str, local_device_id: &str, local_content_tiebreaker: &str, cloud_timestamp: &str, cloud_device_id: &str, cloud_content_tiebreaker: &str, ) -> std::cmp::Ordering` |
| `dstu_sync::data_governance::sync::SyncManager::get_record_data` | method | `crates/dstu-sync/src/data_governance/sync/mod.rs:9095` | L21-backup-governance 1/0 | `pub fn get_record_data( conn: &Connection, table_name: &str, record_id: &str, id_column: &str, ) -> Result<Option<serde_json::Value>, SyncError>` |
| `dstu_sync::data_governance::sync::SyncManager::lww_device_pair` | method | `crates/dstu-sync/src/data_governance/sync/mod.rs:4688` | L21-backup-governance 1/0 | `pub fn lww_device_pair<'a>( local_data: &'a serde_json::Value, cloud_data: Option<&'a serde_json::Value>, cloud_device_hint: Option<&'a str>, ) -> (&'a str, &'a str)` |
| `dstu_sync::data_governance::sync::SyncManager::records_semantically_equal_for_sync` | method | `crates/dstu-sync/src/data_governance/sync/mod.rs:9012` | L21-backup-governance 1/0 | `pub fn records_semantically_equal_for_sync( local: &serde_json::Value, cloud: &serde_json::Value, ) -> bool` |
| `dstu_sync::data_governance::sync::SyncResult` | struct | `crates/dstu-sync/src/data_governance/sync/mod.rs:324` | L21-backup-governance 1/0 | `pub struct SyncResult` |
| `dstu_sync::data_governance::sync::SyncManager::apply_downloaded_changes` | method | `crates/dstu-sync/src/data_governance/sync/mod.rs:7035` | L23-sync-providers 0/242<br>L22-app-commands 0/11 | `pub fn apply_downloaded_changes<C>( conn: &Connection, changes: C, id_column_map: Option<&HashMap<String, String>>, ) -> Result<ApplyChangesResult, SyncError> where C: AsRef<[SyncChangeWithData]>,` |
| `dstu_sync::data_governance::sync::SyncManager::new` | method | `crates/dstu-sync/src/data_governance/sync/mod.rs:856` | L23-sync-providers 0/92<br>L22-app-commands 0/21 | `pub fn new(device_id: String) -> Self` |
| `dstu_sync::data_governance::sync::conflict_resolver::ConflictPolicy` | enum | `crates/dstu-sync/src/data_governance/sync/conflict_resolver.rs:51` | L23-sync-providers 0/65<br>L22-app-commands 0/12 | `pub enum ConflictPolicy` |
| `dstu_sync::data_governance::sync::hlc::Hlc::new` | method | `crates/dstu-sync/src/data_governance/sync/hlc.rs:31` | L23-sync-providers 0/31 | `pub fn new(millis: u64, counter: u16) -> Self` |
| `dstu_sync::data_governance::sync::field_merge::merge_field` | fn | `crates/dstu-sync/src/data_governance/sync/field_merge.rs:95` | L23-sync-providers 0/28 | `pub fn merge_field( table_name: &str, column_name: &str, local_value: Option<&Value>, remote_value: Option<&Value>, ) -> MergeResult` |
| `dstu_sync::data_governance::sync::SyncManager::with_encryption` | method | `crates/dstu-sync/src/data_governance/sync/mod.rs:870` | L23-sync-providers 0/20<br>L22-app-commands 0/4 | `pub fn with_encryption(device_id: String, password: Option<String>) -> Self` |
| `dstu_sync::data_governance::sync::hlc::Hlc` | struct | `crates/dstu-sync/src/data_governance/sync/hlc.rs:18` | L23-sync-providers 0/20 | `pub struct Hlc` |
| `dstu_sync::data_governance::sync::SyncManager::get_pending_changes` | method | `crates/dstu-sync/src/data_governance/sync/mod.rs:4205` | L23-sync-providers 0/16<br>L22-app-commands 0/3 | `pub fn get_pending_changes( conn: &Connection, table_filter: Option<&str>, limit: Option<usize>, ) -> Result<PendingChanges, SyncError>` |
| `dstu_sync::data_governance::sync::classification::TableClassification` | struct | `crates/dstu-sync/src/data_governance/sync/classification.rs:22` | L23-sync-providers 0/18 | `pub struct TableClassification` |
| `dstu_sync::data_governance::sync::asset_filenames::encode_segment` | fn | `crates/dstu-sync/src/data_governance/sync/asset_filenames.rs:63` | L23-sync-providers 0/9 | `pub fn encode_segment(raw: &str) -> Result<String, FilenameCodecError>` |
| `dstu_sync::data_governance::sync::classification::TableClassification::row_sync_tables` | method | `crates/dstu-sync/src/data_governance/sync/classification.rs:1292` | L23-sync-providers 0/9 | `pub fn row_sync_tables() -> Vec<TableClassification>` |
| `dstu_sync::data_governance::sync::SyncManager::get_database_sync_state` | method | `crates/dstu-sync/src/data_governance/sync/mod.rs:9469` | L23-sync-providers 0/8 | `pub fn get_database_sync_state( conn: &Connection, database_name: &str, ) -> Result<DatabaseSyncState, SyncError>` |
| `dstu_sync::data_governance::sync::BlobsManifest` | struct | `crates/dstu-sync/src/data_governance/sync/mod.rs:524` | L23-sync-providers 0/7 | `pub struct BlobsManifest` |
| `dstu_sync::data_governance::sync::SyncManager::has_prune_gap` | method | `crates/dstu-sync/src/data_governance/sync/mod.rs:8122` | L23-sync-providers 0/7 | `pub fn has_prune_gap(since_version: u64, min_available_version: Option<u64>) -> bool` |
| `dstu_sync::data_governance::sync::history::rollback_batch` | fn | `crates/dstu-sync/src/data_governance/sync/history.rs:351` | L22-app-commands 0/6 | `pub fn rollback_batch( conn: &Connection, batch_id: &str, id_column_map: Option<&HashMap<String, String>>, database_name: Option<&str>, ) -> Result<RollbackOutcome, SyncError>` |
| `dstu_sync::data_governance::sync::SyncManager::enrich_changes_with_data` | method | `crates/dstu-sync/src/data_governance/sync/mod.rs:9412` | L23-sync-providers 0/6 | `pub fn enrich_changes_with_data( conn: &Connection, entries: &[ChangeLogEntry], id_column_map: Option<&HashMap<String, String>>, ) -> Result<Vec<SyncChangeWithData>, SyncError>` |
| `dstu_sync::data_governance::sync::AssetDirsManifest` | struct | `crates/dstu-sync/src/data_governance/sync/mod.rs:575` | L23-sync-providers 0/5 | `pub struct AssetDirsManifest` |
| `dstu_sync::data_governance::sync::BlobEntry` | struct | `crates/dstu-sync/src/data_governance/sync/mod.rs:533` | L23-sync-providers 0/5 | `pub struct BlobEntry` |
| `dstu_sync::data_governance::sync::SyncManager::filter_pending_changes_for_database` | method | `crates/dstu-sync/src/data_governance/sync/mod.rs:4262` | L23-sync-providers 0/5 | `pub fn filter_pending_changes_for_database( pending: PendingChanges, database_name: &str, ) -> PendingChanges` |
| `dstu_sync::data_governance::sync::WorkspacesManifest` | struct | `crates/dstu-sync/src/data_governance/sync/mod.rs:477` | L23-sync-providers 0/5 | `pub struct WorkspacesManifest` |
| `dstu_sync::data_governance::sync::asset_filenames::FILENAME_CONFLICT_MARKER` | const | `crates/dstu-sync/src/data_governance/sync/asset_filenames.rs:23` | L23-sync-providers 0/4 | `pub const FILENAME_CONFLICT_MARKER: &str = "[filename-conflict]"` |
| `dstu_sync::data_governance::sync::SyncManager::apply_merge_strategy` | method | `crates/dstu-sync/src/data_governance/sync/mod.rs:4532` | L23-sync-providers 0/4 | `pub fn apply_merge_strategy( strategy: MergeStrategy, conflicts: &[ConflictRecord], ) -> Result<MergeApplicationResult, SyncError>` |
| `dstu_sync::data_governance::sync::tombstone::download_blob_tombstones` | fn | `crates/dstu-sync/src/data_governance/sync/tombstone.rs:946` | L23-sync-providers 0/4 | `pub async fn download_blob_tombstones( storage: &dyn CloudStorage, codec: &dyn PayloadCodec, ) -> Result<BlobTombstones, SyncError>` |
| `dstu_sync::data_governance::sync::tombstone::PlainCodec` | struct | `crates/dstu-sync/src/data_governance/sync/tombstone.rs:56` | L23-sync-providers 0/4 | `pub struct PlainCodec` |
| `dstu_sync::data_governance::sync::tombstone::validate_tombstone_timestamp` | fn | `crates/dstu-sync/src/data_governance/sync/tombstone.rs:724` | L22-app-commands 0/4 | `pub fn validate_tombstone_timestamp(timestamp: &str, label: &str) -> Result<(), SyncError>` |
| `dstu_sync::data_governance::sync::AssetSyncOutcome` | struct | `crates/dstu-sync/src/data_governance/sync/mod.rs:608` | L23-sync-providers 0/3 | `pub struct AssetSyncOutcome` |
| `dstu_sync::data_governance::sync::classification::TableClassification::checksum_tables` | method | `crates/dstu-sync/src/data_governance/sync/classification.rs:1313` | L23-sync-providers 0/3 | `pub fn checksum_tables(database: &str) -> Vec<TableClassification>` |
| `dstu_sync::data_governance::sync::classification::TableClassification::get_business_unique_keys` | method | `crates/dstu-sync/src/data_governance/sync/classification.rs:1357` | L23-sync-providers 0/3 | `pub fn get_business_unique_keys(database: &str, table_name: &str) -> Vec<String>` |
| `dstu_sync::data_governance::sync::SyncChangesPayload` | struct | `crates/dstu-sync/src/data_governance/sync/mod.rs:9954` | L22-app-commands 0/3 | `pub struct SyncChangesPayload` |
| `dstu_sync::data_governance::sync::SyncError` | enum | `crates/dstu-sync/src/data_governance/sync/mod.rs:400` | L23-sync-providers 0/2<br>L22-app-commands 0/1 | `pub enum SyncError` |
| `dstu_sync::data_governance::sync::SyncManager::cleanup_synced_changes` | method | `crates/dstu-sync/src/data_governance/sync/mod.rs:4393` | L23-sync-providers 0/3 | `pub fn cleanup_synced_changes(conn: &Connection, older_than: &str) -> Result<usize, SyncError>` |
| `dstu_sync::data_governance::sync::ApplyChangesResult` | struct | `crates/dstu-sync/src/data_governance/sync/mod.rs:9846` | L23-sync-providers 0/1<br>L22-app-commands 0/1 | `pub struct ApplyChangesResult` |
| `dstu_sync::data_governance::sync::classification::TableClassification::change_log_trigger_exempt` | method | `crates/dstu-sync/src/data_governance/sync/classification.rs:1305` | L23-sync-providers 0/2 | `pub fn change_log_trigger_exempt(database: &str, table_name: &str, operation: &str) -> bool` |
| `dstu_sync::data_governance::sync::classification::TableClassification::is_excluded_from_checksum` | method | `crates/dstu-sync/src/data_governance/sync/classification.rs:1322` | L23-sync-providers 0/2 | `pub fn is_excluded_from_checksum(database: &str, table_name: &str) -> bool` |
| `dstu_sync::data_governance::sync::conflict_resolver::ConflictAwareApplyResult` | struct | `crates/dstu-sync/src/data_governance/sync/conflict_resolver.rs:94` | L23-sync-providers 0/1<br>L22-app-commands 0/1 | `pub struct ConflictAwareApplyResult` |
| `dstu_sync::data_governance::sync::SyncManager::mark_synced_with_timestamp` | method | `crates/dstu-sync/src/data_governance/sync/mod.rs:4349` | L23-sync-providers 0/2 | `pub fn mark_synced_with_timestamp( conn: &Connection, change_ids: &[i64], ) -> Result<usize, SyncError>` |
| `dstu_sync::data_governance::sync::tombstone::apply_blob_tombstones` | fn | `crates/dstu-sync/src/data_governance/sync/tombstone.rs:1515` | L23-sync-providers 0/2 | `pub async fn apply_blob_tombstones( storage: &dyn CloudStorage, tombstones: &BlobTombstones, blobs_dir: &Path, blobs_cloud_prefix: &str, delete_cloud: bool, ) -> Result<Vec<String>, SyncError>` |
| `dstu_sync::data_governance::sync::tombstone::BlobTombstoneEntry` | struct | `crates/dstu-sync/src/data_governance/sync/tombstone.rs:102` | L23-sync-providers 0/2 | `pub struct BlobTombstoneEntry` |
| `dstu_sync::data_governance::sync::tombstone::BlobTombstones` | struct | `crates/dstu-sync/src/data_governance/sync/tombstone.rs:112` | L23-sync-providers 0/2 | `pub struct BlobTombstones` |
| `dstu_sync::data_governance::sync::WorkspaceEntry` | struct | `crates/dstu-sync/src/data_governance/sync/mod.rs:493` | L23-sync-providers 0/2 | `pub struct WorkspaceEntry` |
| `dstu_sync::data_governance::sync::asset_filenames::encode_asset_key_segments` | fn | `crates/dstu-sync/src/data_governance/sync/asset_filenames.rs:173` | L23-sync-providers 0/1 | `pub fn encode_asset_key_segments( root: &str, top: &str, raw_segments: &[&str], ) -> Result<String, FilenameCodecError>` |
| `dstu_sync::data_governance::sync::AssetFileEntry` | struct | `crates/dstu-sync/src/data_governance/sync/mod.rs:583` | L23-sync-providers 0/1 | `pub struct AssetFileEntry` |
| `dstu_sync::data_governance::sync::history::DEFAULT_MAX_BATCHES` | const | `crates/dstu-sync/src/data_governance/sync/history.rs:60` | L22-app-commands 0/1 | `pub const DEFAULT_MAX_BATCHES: usize = 50` |
| `dstu_sync::data_governance::sync::history::new_batch_id` | fn | `crates/dstu-sync/src/data_governance/sync/history.rs:63` | L22-app-commands 0/1 | `pub fn new_batch_id() -> String` |
| `dstu_sync::data_governance::sync::history::prune_batches_to_cap` | fn | `crates/dstu-sync/src/data_governance/sync/history.rs:175` | L22-app-commands 0/1 | `pub fn prune_batches_to_cap(conn: &Connection, max_batches: usize) -> Result<u64, SyncError>` |
| `dstu_sync::data_governance::sync::history::REASON_CONFLICT_RESOLVE` | const | `crates/dstu-sync/src/data_governance/sync/history.rs:55` | L22-app-commands 0/1 | `pub const REASON_CONFLICT_RESOLVE: &str = "conflict_resolve"` |
| `dstu_sync::data_governance::sync::history::REASON_POLICY_OVERRIDE` | const | `crates/dstu-sync/src/data_governance/sync/history.rs:53` | L22-app-commands 0/1 | `pub const REASON_POLICY_OVERRIDE: &str = "policy_override"` |
| `dstu_sync::data_governance::sync::history::REASON_ROLLBACK_UNDO` | const | `crates/dstu-sync/src/data_governance/sync/history.rs:57` | L22-app-commands 0/1 | `pub const REASON_ROLLBACK_UNDO: &str = "rollback_undo"` |
| `dstu_sync::data_governance::sync::history::snapshot_record_with_data` | fn | `crates/dstu-sync/src/data_governance/sync/history.rs:102` | L22-app-commands 0/1 | `pub fn snapshot_record_with_data( conn: &Connection, batch_id: &str, reason: &str, table_name: &str, record_id: &str, current: Option<&serde_json::Value>, ) -> Result<bool, SyncError>` |
| `dstu_sync::data_governance::sync::hlc::Hlc::parse` | method | `crates/dstu-sync/src/data_governance/sync/hlc.rs:41` | L23-sync-providers 0/1 | `pub fn parse(s: &str) -> Option<Self>` |
| `dstu_sync::data_governance::sync::SyncManager::apply_downloaded_changes_force_exact_with_hooks` | method | `crates/dstu-sync/src/data_governance/sync/mod.rs:7612` | L23-sync-providers 0/1 | `pub fn apply_downloaded_changes_force_exact_with_hooks<P, F>( conn: &Connection, changes: &[SyncChangeWithData], id_column_map: Option<&HashMap<String, String>>, preflight: P, finalize: F, ) -> Result<ApplyChangesResult, SyncError> where P: FnOnce(&Connection) -> Result<(), SyncError>, F: FnOnce(&Connection, &ApplyC...` |
| `dstu_sync::data_governance::sync::tombstone::download_asset_tombstones` | fn | `crates/dstu-sync/src/data_governance/sync/tombstone.rs:1100` | L23-sync-providers 0/1 | `pub async fn download_asset_tombstones( storage: &dyn CloudStorage, codec: &dyn PayloadCodec, ) -> Result<AssetTombstones, SyncError>` |
| `dstu_sync::data_governance::sync::tombstone::download_blob_tombstones_for_device` | fn | `crates/dstu-sync/src/data_governance/sync/tombstone.rs:1084` | L23-sync-providers 0/1 | `pub async fn download_blob_tombstones_for_device( storage: &dyn CloudStorage, codec: &dyn PayloadCodec, device_id: &str, ) -> Result<BlobTombstones, SyncError>` |

### 引用点样例

- `dstu_sync::data_governance::sync::MergeStrategy` — L21-backup-governance: `src/data_governance/commands_backup.rs:270`, `src/data_governance/commands_backup.rs:377`, `src/data_governance/commands_backup.rs:273`, `src/data_governance/commands_backup.rs:275`；L23-sync-providers: `tests/sync_provider_contract_tests.rs:15`, `tests/sync_provider_contract_tests.rs:673`, `tests/sync_provider_contract_tests.rs:790`, `tests/sync_real_flow_smoke_tests.rs:15`
- `dstu_sync::data_governance::sync::SyncChangeWithData` — L21-backup-governance: `src/data_governance/commands_backup.rs:268`, `src/data_governance/commands_backup.rs:375`, `src/data_governance/commands_backup.rs:411`, `src/data_governance/commands_backup.rs:476`；L23-sync-providers: `tests/sync_adversarial_tests.rs:102`, `tests/sync_adversarial_tests.rs:103`, `tests/sync_adversarial_tests.rs:1058`, `tests/sync_adversarial_tests.rs:1104`；L22-app-commands: `tests/sync_r10_chaos_clock.rs:67`, `tests/sync_r10_chaos_clock.rs:68`, `tests/sync_r10_chaos_clock.rs:91`, `tests/sync_r10_chaos_clock.rs:92`
- `dstu_sync::data_governance::sync::ChangeOperation` — L21-backup-governance: `src/data_governance/commands_backup.rs:11`, `src/data_governance/commands_backup.rs:341`, `src/data_governance/commands_backup.rs:712`, `src/data_governance/commands_backup.rs:783`；L23-sync-providers: `tests/sync_adversarial_tests.rs:99`, `tests/sync_adversarial_tests.rs:107`, `tests/sync_adversarial_tests.rs:144`, `tests/sync_adversarial_tests.rs:176`；L22-app-commands: `tests/sync_r10_chaos_clock.rs:19`, `tests/sync_r10_chaos_clock.rs:71`, `tests/sync_r10_chaos_clock.rs:95`, `tests/sync_r10_chaos_idempotent.rs:121`
- `dstu_sync::data_governance::sync::SyncManager` — L21-backup-governance: `src/data_governance/commands_backup.rs:11`, `src/data_governance/commands_backup.rs:575`；L23-sync-providers: `tests/sync_adversarial_tests.rs:496`, `tests/sync_adversarial_tests.rs:498`, `tests/sync_adversarial_tests.rs:500`, `tests/sync_adversarial_tests.rs:502`；L22-app-commands: `tests/sync_r10_chaos_clock.rs:19`, `tests/sync_r10_chaos_idempotent.rs:20`, `tests/sync_r10_chaos_mixed_e2ee.rs:23`, `tests/sync_r10_chaos_truncation.rs:21`
- `dstu_sync::data_governance::sync::classification::SyncCategory` — L21-backup-governance: `src/data_governance/commands_backup.rs:11`, `src/data_governance/commands_backup.rs:230`；L23-sync-providers: `tests/sync_comprehensive_tests.rs:65`, `tests/sync_comprehensive_tests.rs:961`, `tests/sync_comprehensive_tests.rs:995`, `tests/sync_real_flow_smoke_tests.rs:1024`
- `deep_student_lib::data_governance::commands_sync::SyncExecutionResponse` — L21-backup-governance: `src/chat_v2/tools/data_governance_executor.rs:949`, `src/chat_v2/tools/data_governance_executor.rs:966`, `src/chat_v2/tools/data_governance_executor.rs:984`, `src/chat_v2/tools/data_governance_executor.rs:999`
- `deep_student_lib::data_governance::commands_sync::data_governance_get_sync_status` — L21-backup-governance: `src/chat_v2/tools/data_governance_executor.rs:223`, `src/data_governance/mod.rs:104`
- `deep_student_lib::data_governance::commands_sync::data_governance_run_sync` — L21-backup-governance: `src/chat_v2/tools/data_governance_executor.rs:328`, `src/data_governance/mod.rs:104`
- `dstu_sync::data_governance::sync::SyncManager::timestamp_value_to_lww_string` — L21-backup-governance: `src/data_governance/commands_backup.rs:307`, `src/data_governance/commands_backup.rs:313`
- `dstu_sync::data_governance::sync::SyncDirection` — L21-backup-governance: `src/data_governance/dto/mod.rs:114`；L23-sync-providers: `tests/sync_file_level_e2ee.rs:29`, `tests/sync_file_level_e2ee.rs:180`, `tests/sync_file_level_e2ee.rs:203`, `tests/sync_file_level_e2ee.rs:227`
- `dstu_sync::data_governance::sync::SyncManager::apply_downloaded_changes_with_conflict_guard` — L21-backup-governance: `src/data_governance/commands_backup.rs:518`；L23-sync-providers: `tests/sync_adversarial_tests.rs:713`, `tests/sync_adversarial_tests.rs:958`, `tests/sync_adversarial_tests.rs:1165`, `tests/sync_adversarial_tests.rs:1293`；L22-app-commands: `tests/sync_r10_chaos_clock.rs:114`, `tests/sync_r11_history.rs:206`, `tests/sync_r11_history.rs:260`, `tests/sync_r11_history.rs:414`
- `dstu_sync::data_governance::sync::classification::sync_classification_registry` — L21-backup-governance: `src/data_governance/commands_backup.rs:229`；L23-sync-providers: `tests/sync_comprehensive_tests.rs:26`, `tests/sync_comprehensive_tests.rs:827`, `tests/sync_comprehensive_tests.rs:839`, `tests/sync_comprehensive_tests.rs:849`
- `dstu_sync::data_governance::sync::SyncManager::reset_sync_baseline_after_restore` — L21-backup-governance: `src/data_governance/commands_restore.rs:1147`；L23-sync-providers: `tests/sync_comprehensive_tests.rs:254`, `tests/sync_comprehensive_tests.rs:315`, `tests/sync_comprehensive_tests.rs:366`, `tests/sync_comprehensive_tests.rs:402`
- `deep_student_lib::data_governance::commands_sync::data_governance_resolve_record_conflict` — L21-backup-governance: `src/data_governance/mod.rs:104`；L23-sync-providers: `tests/sync_r06_delete_resolve_tests.rs:255`, `tests/sync_r07_delete_resolve_lock_tests.rs:222`, `tests/sync_r07_delete_resolve_lock_tests.rs:275`, `tests/sync_r07_delete_resolve_lock_tests.rs:321`；L22-app-commands: `tests/sync_r11_history.rs:752`, `tests/sync_r12_conflict_fast_path.rs:208`
- `dstu_sync::data_governance::sync::SyncManifest` — L21-backup-governance: `src/data_governance/dto/mod.rs:114`；L23-sync-providers: `tests/sync_provider_contract_tests.rs:1174`, `tests/sync_provider_contract_tests.rs:635`, `tests/sync_real_flow_smoke_tests.rs:1617`, `tests/sync_real_flow_smoke_tests.rs:1631`；L22-app-commands: `tests/sync_r12_record_path_names.rs:141`, `tests/sync_r12_record_path_names.rs:152`
- `dstu_sync::data_governance::sync::SyncTransactionStatus` — L21-backup-governance: `src/data_governance/dto/mod.rs:114`；L23-sync-providers: `tests/sync_provider_contract_tests.rs:15`, `tests/sync_provider_contract_tests.rs:1177`；L22-app-commands: `tests/sync_r12_record_path_names.rs:20`, `tests/sync_r12_record_path_names.rs:155`
- `deep_student_lib::data_governance::commands_sync::data_governance_list_record_conflicts` — L21-backup-governance: `src/data_governance/mod.rs:104`；L23-sync-providers: `tests/sync_r06_delete_resolve_tests.rs:291`, `tests/sync_r07_delete_resolve_lock_tests.rs:249`
- `deep_student_lib::data_governance::commands_sync::data_governance_list_sync_snapshot_batches` — L21-backup-governance: `src/data_governance/mod.rs:104`；L22-app-commands: `tests/sync_r11_history.rs:773`
- `deep_student_lib::data_governance::commands_sync::data_governance_rollback_sync_snapshot_batch` — L21-backup-governance: `src/data_governance/mod.rs:104`；L22-app-commands: `tests/sync_r11_history.rs:786`
- `dstu_sync::data_governance::sync::DatabaseSyncState` — L21-backup-governance: `src/data_governance/dto/mod.rs:114`；L22-app-commands: `tests/sync_r12_record_path_names.rs:145`
- `dstu_sync::data_governance::sync::SyncManager::replay_quarantined_changes` — L21-backup-governance: `src/data_governance/commands_backup.rs:572`；L23-sync-providers: `tests/sync_regression_tests.rs:1116`
- `deep_student_lib::data_governance::commands_sync::ConflictDetectionResponse` — L21-backup-governance: `src/data_governance/dto/mod.rs:101`
- `deep_student_lib::data_governance::commands_sync::data_governance_count_record_conflicts` — L21-backup-governance: `src/data_governance/mod.rs:104`
- `deep_student_lib::data_governance::commands_sync::data_governance_detect_conflicts` — L21-backup-governance: `src/data_governance/mod.rs:104`
- `deep_student_lib::data_governance::commands_sync::data_governance_detect_prune_gap` — L21-backup-governance: `src/data_governance/mod.rs:104`
- `deep_student_lib::data_governance::commands_sync::data_governance_export_sync_data` — L21-backup-governance: `src/data_governance/mod.rs:104`
- `deep_student_lib::data_governance::commands_sync::data_governance_import_sync_data` — L21-backup-governance: `src/data_governance/mod.rs:104`
- `deep_student_lib::data_governance::commands_sync::data_governance_list_unsynced_items` — L21-backup-governance: `src/data_governance/mod.rs:104`
- `deep_student_lib::data_governance::commands_sync::data_governance_mark_asset_deleted` — L21-backup-governance: `src/data_governance/mod.rs:104`
- `deep_student_lib::data_governance::commands_sync::data_governance_mark_blob_deleted` — L21-backup-governance: `src/data_governance/mod.rs:104`
- `deep_student_lib::data_governance::commands_sync::data_governance_purge_resolved_conflicts` — L21-backup-governance: `src/data_governance/mod.rs:104`
- `deep_student_lib::data_governance::commands_sync::data_governance_repo_check` — L21-backup-governance: `src/data_governance/mod.rs:104`
- `deep_student_lib::data_governance::commands_sync::data_governance_resolve_conflicts` — L21-backup-governance: `src/data_governance/mod.rs:104`
- `deep_student_lib::data_governance::commands_sync::data_governance_run_sync_with_progress` — L21-backup-governance: `src/data_governance/mod.rs:104`
- `deep_student_lib::data_governance::commands_sync::DatabaseConflictResponse` — L21-backup-governance: `src/data_governance/dto/mod.rs:101`
- `deep_student_lib::data_governance::commands_sync::DatabaseSyncStatusResponse` — L21-backup-governance: `src/data_governance/dto/mod.rs:101`
- `deep_student_lib::data_governance::commands_sync::SyncExportData` — L21-backup-governance: `src/data_governance/dto/mod.rs:101`
- `deep_student_lib::data_governance::commands_sync::SyncExportResponse` — L21-backup-governance: `src/data_governance/dto/mod.rs:101`
- `deep_student_lib::data_governance::commands_sync::SyncImportResponse` — L21-backup-governance: `src/data_governance/dto/mod.rs:101`
- `deep_student_lib::data_governance::commands_sync::SyncResultResponse` — L21-backup-governance: `src/data_governance/dto/mod.rs:101`
- `deep_student_lib::data_governance::commands_sync::SyncStatusResponse` — L21-backup-governance: `src/data_governance/dto/mod.rs:101`
- `dstu_sync::data_governance::sync::ChangeLogEntry` — L21-backup-governance: `src/data_governance/dto/mod.rs:114`
- `dstu_sync::data_governance::sync::ChangeLogStats` — L21-backup-governance: `src/data_governance/dto/mod.rs:114`
- `dstu_sync::data_governance::sync::ConflictDetectionResult` — L21-backup-governance: `src/data_governance/dto/mod.rs:114`
- `dstu_sync::data_governance::sync::ConflictRecord` — L21-backup-governance: `src/data_governance/dto/mod.rs:114`
- `dstu_sync::data_governance::sync::DatabaseConflict` — L21-backup-governance: `src/data_governance/dto/mod.rs:114`
- `dstu_sync::data_governance::sync::DatabaseConflictType` — L21-backup-governance: `src/data_governance/dto/mod.rs:114`
- `dstu_sync::data_governance::sync::emitter::EVENT_NAME` — L21-backup-governance: `src/data_governance/mod.rs:120`
- `dstu_sync::data_governance::sync::emitter::SyncProgressEmitter` — L21-backup-governance: `src/data_governance/mod.rs:120`
- `dstu_sync::data_governance::sync::MergeApplicationResult` — L21-backup-governance: `src/data_governance/dto/mod.rs:114`
- `dstu_sync::data_governance::sync::PendingChanges` — L21-backup-governance: `src/data_governance/dto/mod.rs:114`
- `dstu_sync::data_governance::sync::progress::SyncPhase` — L21-backup-governance: `src/data_governance/mod.rs:120`
- `dstu_sync::data_governance::sync::progress::SyncProgress` — L21-backup-governance: `src/data_governance/mod.rs:120`
- `dstu_sync::data_governance::sync::RecordSnapshot` — L21-backup-governance: `src/data_governance/dto/mod.rs:114`
- `dstu_sync::data_governance::sync::ResolvedRecord` — L21-backup-governance: `src/data_governance/dto/mod.rs:114`
- `dstu_sync::data_governance::sync::state::SyncStateStore::open_default` — L21-backup-governance: `src/data_governance/commands_restore.rs:189`
- `dstu_sync::data_governance::sync::state::SyncStateStore::reset_default_after_local_purge` — F2-shell: `src/lib.rs:1021`
- `dstu_sync::data_governance::sync::SyncExecutionResult` — L21-backup-governance: `src/data_governance/dto/mod.rs:114`
- `dstu_sync::data_governance::sync::SyncManager::compare_lww_timestamps` — L21-backup-governance: `src/data_governance/commands_backup.rs:325`
- `dstu_sync::data_governance::sync::SyncManager::get_record_data` — L21-backup-governance: `src/data_governance/commands_backup.rs:276`
- 其余 56 个条目的引用点见 `draft.json`。

## 消费其他 lane

### L23-sync-providers（23 个条目，prod 174 / test 78）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_sync::cloud_storage::traits::CloudStorage` ? | trait | 104/23 | `crates/dstu-sync/src/data_governance/sync/mod.rs`, `crates/dstu-sync/src/data_governance/sync/tombstone.rs`, `src/data_governance/commands_sync.rs` |
| `dstu_sync::cloud_storage::is_cloud_rate_limited` | fn | 18/0 | `crates/dstu-sync/src/data_governance/sync/mod.rs`, `src/data_governance/commands_sync.rs` |
| `dstu_sync::cloud_storage::config::CloudStorageConfig` ? | struct | 10/1 | `src/data_governance/commands_sync.rs` |
| `dstu_sync::cloud_storage::create_storage` | fn | 9/0 | `src/data_governance/commands_sync.rs` |
| `dstu_sync::cloud_storage::sync_e2ee_error` | fn | 7/0 | `crates/dstu-sync/src/data_governance/sync/mod.rs` |
| `dstu_sync::cloud_storage::SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE` | const | 3/0 | `crates/dstu-sync/src/data_governance/sync/mod.rs` |
| `dstu_sync::cloud_storage::traits::is_sync_cancelled` | fn | 3/0 | `crates/dstu-sync/src/data_governance/sync/mod.rs`, `src/data_governance/commands_sync.rs` |
| `dstu_sync::cloud_storage::resume::cleanup_stale_parts` | fn | 2/0 | `crates/dstu-sync/src/data_governance/sync/mod.rs` |
| `dstu_sync::cloud_storage::resume::content_keyed_part_path` | fn | 2/0 | `crates/dstu-sync/src/data_governance/sync/mod.rs` |
| `dstu_sync::cloud_storage::resume::get_file_with_optional_resume` | fn | 2/0 | `crates/dstu-sync/src/data_governance/sync/mod.rs` |
| `dstu_sync::cloud_storage::SYNC_E2EE_PASSWORD_REQUIRED_CODE` | const | 2/0 | `crates/dstu-sync/src/data_governance/sync/mod.rs` |
| `dstu_sync::cloud_storage::SYNC_E2EE_WRONG_PASSWORD_CODE` | const | 2/0 | `crates/dstu-sync/src/data_governance/sync/mod.rs` |
| `dstu_sync::cloud_storage::sync_lease::acquire_sync_target_lease` | fn | 2/0 | `src/data_governance/commands_sync.rs` |
| `dstu_sync::cloud_storage::repo_check::RepoCheckReport` | struct | 1/0 | `src/data_governance/commands_sync.rs` |
| `dstu_sync::cloud_storage::repo_check::run_repo_check` | fn | 1/0 | `src/data_governance/commands_sync.rs` |
| `dstu_sync::cloud_storage::resume::persist_download` | fn | 1/0 | `crates/dstu-sync/src/data_governance/sync/mod.rs` |
| `dstu_sync::cloud_storage::sync_manager::CloudSyncManager::new` | method | 1/0 | `src/data_governance/commands_sync.rs` |
| `dstu_sync::cloud_storage::traits::clear_cancel_token` | fn | 1/0 | `src/data_governance/commands_sync.rs` |
| `dstu_sync::cloud_storage::traits::clear_status_hook` | fn | 1/0 | `src/data_governance/commands_sync.rs` |
| `dstu_sync::cloud_storage::traits::set_cancel_token` | fn | 1/0 | `src/data_governance/commands_sync.rs` |
| `dstu_sync::cloud_storage::traits::set_status_hook` | fn | 1/0 | `src/data_governance/commands_sync.rs` |
| `dstu_sync::cloud_storage::traits::Result` | type | 0/36 | `crates/dstu-sync/src/data_governance/sync/mod.rs`, `crates/dstu-sync/src/data_governance/sync/tombstone.rs`, `src/data_governance/commands_sync.rs` |
| `dstu_sync::cloud_storage::traits::FileInfo` | struct | 0/18 | `crates/dstu-sync/src/data_governance/sync/mod.rs`, `crates/dstu-sync/src/data_governance/sync/tombstone.rs`, `src/data_governance/commands_sync.rs` |

### L21-backup-governance（15 个条目，prod 141 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::data_governance::commands_backup::open_sync_connection` | fn | 36/0 | `src/data_governance/commands_sync.rs` |
| `deep_student_lib::data_governance::commands_backup::resolve_database_path` | fn | 33/0 | `src/data_governance/commands_sync.rs` |
| `deep_student_lib::data_governance::commands_backup::get_active_data_dir` | fn | 20/0 | `src/data_governance/commands_sync.rs` |
| `deep_student_lib::data_governance::commands::check_maintenance_mode` | fn | 11/0 | `src/data_governance/commands_sync.rs` |
| `deep_student_lib::data_governance::commands::try_save_audit_log` | fn | 8/0 | `src/data_governance/commands_sync.rs` |
| `dstu_sync::cloud_credentials::hydrate_cloud_config` | fn | 8/0 | `src/data_governance/commands_sync.rs` |
| `deep_student_lib::data_governance::commands_backup::apply_downloaded_changes_to_databases` | fn | 5/0 | `src/data_governance/commands_sync.rs` |
| `deep_student_lib::data_governance::commands_backup::get_app_data_dir` | fn | 5/0 | `src/data_governance/commands_sync.rs` |
| `deep_student_lib::data_governance::commands_backup::build_id_column_map` | fn | 3/0 | `src/data_governance/commands_sync.rs` |
| `dstu_sync::cloud_config_commands::CloudConfigSsotError` ? | enum | 3/0 | `src/data_governance/commands_sync.rs` |
| `deep_student_lib::data_governance::commands_backup::ApplyToDbsResult` | struct | 2/0 | `src/data_governance/commands_sync.rs` |
| `deep_student_lib::data_governance::commands_backup::validate_user_path` | fn | 2/0 | `src/data_governance/commands_sync.rs` |
| `deep_student_lib::data_governance::commands::SYNC_LOCK_TIMEOUT_SECS` | const | 2/0 | `src/data_governance/commands_sync.rs` |
| `dstu_sync::cloud_config_commands::load_hydrated_cloud_config_ssot` ? | fn | 2/0 | `src/data_governance/commands_sync.rs` |
| `dstu_sync::hooks::merge_profile_json_for_sync` | fn | 1/0 | `crates/dstu-sync/src/data_governance/sync/field_merge.rs` |

### F3-storage（16 个条目，prod 100 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_storage::schema_registry::DatabaseId::all_ordered` ? | method | 34/0 | `crates/dstu-sync/src/data_governance/sync/mod.rs`, `src/data_governance/commands_sync.rs` |
| `dstu_storage::audit::SyncDirection` | enum | 18/0 | `src/data_governance/commands_sync.rs` |
| `dstu_storage::audit::AuditOperation` | enum | 7/0 | `src/data_governance/commands_sync.rs` |
| `dstu_storage::schema_registry::DatabaseId` ? | enum | 7/0 | `crates/dstu-sync/src/data_governance/sync/mod.rs`, `src/data_governance/commands_sync.rs` |
| `dstu_storage::audit::AuditLog::new` | method | 6/0 | `src/data_governance/commands_sync.rs` |
| `dstu_storage::backup_common::BACKUP_GLOBAL_LIMITER` | static | 6/0 | `src/data_governance/commands_sync.rs` |
| `dstu_storage::backup_common::calculate_file_hash` | fn | 6/0 | `crates/dstu-sync/src/data_governance/sync/mod.rs` |
| `dstu_storage::data_space::device_id::get_device_id` | fn | 3/0 | `crates/dstu-sync/src/data_governance/sync/mod.rs` |
| `dstu_storage::data_space::device_id::device_id_short_hash` | fn | 2/0 | `crates/dstu-sync/src/data_governance/sync/mod.rs`, `crates/dstu-sync/src/data_governance/sync/tombstone.rs` |
| `dstu_storage::data_space::device_id::normalize_device_id` | fn | 2/0 | `crates/dstu-sync/src/data_governance/sync/mod.rs` |
| `dstu_storage::unified_file_manager::is_virtual_uri` | fn | 2/0 | `src/data_governance/commands_sync.rs` |
| `dstu_storage::unified_file_manager::queue_persistable_saf_uri` | fn | 2/0 | `src/data_governance/commands_sync.rs` |
| `dstu_storage::unified_file_manager::reject_double_encoded_virtual_uri` | fn | 2/0 | `src/data_governance/commands_sync.rs` |
| `dstu_storage::audit::AuditLog` | struct | 1/0 | `src/data_governance/commands_sync.rs` |
| `dstu_storage::unified_file_manager::copy_file` | fn | 1/0 | `src/data_governance/commands_sync.rs` |
| `dstu_storage::unified_file_manager::ensure_local_path` | fn | 1/0 | `src/data_governance/commands_sync.rs` |

### L10-notes（20 个条目，prod 26 / test 20）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::repos::note_format_repo::NoteFormatRepo::required_capabilities` | method | 6/0 | `crates/dstu-sync/src/data_governance/sync/note_history.rs` |
| `dstu_vfs::vfs::repos::note_format_repo::NoteFormatRepo::detect` | method | 4/0 | `crates/dstu-sync/src/data_governance/sync/note_history.rs` |
| `dstu_vfs::vfs::repos::note_format_repo::NoteFormatRepo::ensure_supported` | method | 4/0 | `crates/dstu-sync/src/data_governance/sync/note_history.rs` |
| `dstu_vfs::vfs::repos::note_format_repo::NoteFormat` | struct | 3/0 | `crates/dstu-sync/src/data_governance/sync/note_history.rs` |
| `dstu_vfs::vfs::repos::note_format_repo::NoteFormatRepo::get` | method | 2/0 | `crates/dstu-sync/src/data_governance/sync/note_history.rs` |
| `dstu_vfs::vfs::repos::note_revision_repo::NoteRevisionRepo::set_pinned` ? | method | 1/2 | `crates/dstu-sync/src/data_governance/sync/note_history.rs` |
| `dstu_vfs::vfs::repos::note_format_repo::NoteFormatRepo` | struct | 1/0 | `crates/dstu-sync/src/data_governance/sync/note_history.rs` |
| `dstu_vfs::vfs::repos::note_format_repo::NoteFormatRepo::insert` | method | 1/0 | `crates/dstu-sync/src/data_governance/sync/note_history.rs` |
| `dstu_vfs::vfs::repos::note_format_repo::NoteFormatRepo::serializer` | method | 1/0 | `crates/dstu-sync/src/data_governance/sync/note_history.rs` |
| `dstu_vfs::vfs::repos::note_relation_repo::NoteRelationRepo::invalidate_missing_blocks` | method | 1/0 | `crates/dstu-sync/src/data_governance/sync/note_history.rs` |
| `dstu_vfs::vfs::repos::note_revision_repo::NoteAssetRef` | struct | 1/0 | `crates/dstu-sync/src/data_governance/sync/note_history.rs` |
| `dstu_vfs::vfs::repos::note_revision_repo::NoteRevisionRepo::snapshot` | method | 1/0 | `crates/dstu-sync/src/data_governance/sync/note_history.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::create_note` ? | method | 0/5 | `crates/dstu-sync/src/data_governance/sync/note_history.rs` |
| `dstu_vfs::vfs::repos::note_revision_repo::NoteRevisionRepo` | struct | 0/4 | `crates/dstu-sync/src/data_governance/sync/note_history.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo` | struct | 0/3 | `crates/dstu-sync/src/data_governance/sync/note_history.rs` |
| `dstu_vfs::vfs::repos::note_revision_repo::NoteRevisionRepo::get` ? | method | 0/2 | `crates/dstu-sync/src/data_governance/sync/note_history.rs` |
| `dstu_vfs::vfs::repos::note_relation_repo::NoteRelationRepo::get` | method | 0/1 | `crates/dstu-sync/src/data_governance/sync/note_history.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::update_note_with_conn` | method | 0/1 | `crates/dstu-sync/src/data_governance/sync/note_history.rs` |
| `dstu_vfs::vfs::repos::note_revision_repo::NoteRevisionRepo::list` ? | method | 0/1 | `crates/dstu-sync/src/data_governance/sync/note_history.rs` |
| `dstu_vfs::vfs::repos::note_revision_repo::NoteRevisionRepo::restore_copy` ? | method | 0/1 | `crates/dstu-sync/src/data_governance/sync/note_history.rs` |

### L05-agent-workspace（1 个条目，prod 8 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::workspace::coordinator::WorkspaceCoordinator` ? | struct | 8/0 | `src/data_governance/commands_sync.rs` |

### F4-security（8 个条目，prod 5 / test 6）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_security::crypto::backup_crypto::FileCipherSession` | struct | 2/0 | `crates/dstu-sync/src/data_governance/sync/mod.rs` |
| `dstu_security::crypto::backup_crypto::is_encrypted_backup` | fn | 1/1 | `crates/dstu-sync/src/data_governance/sync/mod.rs` |
| `dstu_security::crypto::backup_crypto::encrypt_backup_file` | fn | 1/0 | `crates/dstu-sync/src/data_governance/sync/mod.rs` |
| `dstu_security::crypto::backup_crypto::FileCipherSession::new` | method | 1/0 | `crates/dstu-sync/src/data_governance/sync/mod.rs` |
| `dstu_core::models::AppErrorType` | enum | 0/2 | `crates/dstu-sync/src/data_governance/sync/tombstone.rs` |
| `dstu_core::models::AppError` | struct | 0/1 | `crates/dstu-sync/src/data_governance/sync/tombstone.rs` |
| `dstu_core::models::AppError::new` | method | 0/1 | `crates/dstu-sync/src/data_governance/sync/tombstone.rs` |
| `dstu_security::crypto::backup_crypto::FileCipherSession::with_params` | method | 0/1 | `crates/dstu-sync/src/data_governance/sync/mod.rs` |

### L11-vfs-repos（3 个条目，prod 3 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::repos::id_alias::resolve_alias_with_lookup` | fn | 1/0 | `crates/dstu-sync/src/data_governance/sync/mod.rs` |
| `dstu_vfs::vfs::repos::id_alias::resolve_persisted_id_alias` | fn | 1/0 | `crates/dstu-sync/src/data_governance/sync/mod.rs` |
| `dstu_vfs::vfs::repos::id_alias::table_exists` | fn | 1/0 | `crates/dstu-sync/src/data_governance/sync/mod.rs` |

### L22-app-commands（1 个条目，prod 2 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::commands::AppState` | struct | 2/0 | `src/data_governance/commands_sync.rs` |

### L13-vfs-api（3 个条目，prod 0 / test 16）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::database::setup_migrated_test_db` | fn | 0/10 | `crates/dstu-sync/src/data_governance/sync/mod.rs`, `crates/dstu-sync/src/data_governance/sync/note_history.rs` |
| `dstu_vfs::vfs::types::VfsCreateNoteParams` ? | struct | 0/5 | `crates/dstu-sync/src/data_governance/sync/note_history.rs` |
| `dstu_vfs::vfs::types::VfsUpdateNoteParams` ? | struct | 0/1 | `crates/dstu-sync/src/data_governance/sync/note_history.rs` |

### F1-kernel（1 个条目，prod 0 / test 1）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::extensions::register_extensions` | fn | 0/1 | `src/sync_app_tests.rs` |

### L17-memory-research（1 个条目，prod 0 / test 2）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_memory::memory::learner_profile::LearningGoal` | struct | 0/2 | `src/sync_app_tests.rs` |
