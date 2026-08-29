//! [R12-delta-inventory] 已验证 staging 的规范文件清单（DELTA-R11 §R12）。
//! 模块标识：`delta_inventory`（源码锁按此字面量定位本文件）。
//!
//! 本模块**只做清单**：遍历一个已验证的备份 staging 根目录，产出按
//! `logical_path` 字节序排序的规范文件表（相对 POSIX 路径、大小、明文
//! SHA-256），并提供两次清单之间的 [`diff`]（reuse / upload-new / deleted）。
//!
//! 它没有接入任何上传、恢复、命令或 UI 路径，也**不分配**云端
//! `object_key`（对象命名属于 upload 路，不属于本模块）。生产 Cloud backup
//! 仍是「全量 ZIP → 单对象 `put_file`」，**不得**因本模块存在而宣称增量
//! 备份已实现。
//!
//! [Wave2-D R5 裁决] 状态 = **experimental 隔离**；接线前置清单与升级路径见
//! docs/dev/wave2-D-backup-v2-decision.md。
//!
//! 硬约束：
//!
//! - hash 一律以磁盘真实内容为准；[`BackupManifest`] 只用于交叉核对，
//!   任何不一致都 fail-closed（说明 staging 未通过验证，拒绝出清单）；
//! - 路径校验与 `cloud_storage::delta_format` 同语义：拒绝 `..`、`.`、
//!   绝对路径、空段、反斜杠、NUL、盘符；超过
//!   [`MAX_LOGICAL_PATH_BYTES`] 直接拒绝，不截断；
//! - `logical_size` 用 `checked_add` 累加，溢出 fail-closed；
//! - `manifest.json` 参与清单列出，但含每版必变的 volatile 字段
//!   （[`VOLATILE_MANIFEST_FIELDS`]），因此在复用判定里按 always-changed
//!   处理：[`InventoryDiff::reuse_candidates`] 永远不把它标为可复用；
//!   跨版本的「内容是否实际变化」判断请用
//!   [`manifest_unchanged_ignoring_volatile`] 比较剥离 volatile 字段后的
//!   canonicalized JSON。

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use walkdir::WalkDir;

use super::{calculate_file_sha256, BackupError, BackupManifest};
use crate::cloud_storage::delta_format::{MAX_LOGICAL_PATH_BYTES, MAX_SNAPSHOT_FILES};

/// staging 根目录里清单文件的逻辑路径。
pub const MANIFEST_LOGICAL_PATH: &str = "manifest.json";

/// `manifest.json` 顶层每版必变的字段：即使数据零变化，这些字段也会不同，
/// 因此复用比较必须忽略它们（清单本身按 always-changed 处理）。
pub const VOLATILE_MANIFEST_FIELDS: [&str; 3] = ["created_at", "backup_id", "snapshot_epoch"];

/// `manifest.json` 里 `assets` 资产结果内每版必变的时间戳字段。
const VOLATILE_ASSET_RESULT_FIELDS: [&str; 2] = ["started_at", "completed_at"];

/// 清单中的一个逻辑文件。**不含**云端 `object_key`：对象命名属于 upload 路。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InventoryEntry {
    /// staging 内的相对 POSIX 路径（`/` 分隔）。
    pub logical_path: String,
    /// 磁盘上的真实字节数。
    pub size: u64,
    /// 磁盘真实内容的明文 SHA-256（64 位小写 hex）。
    pub plaintext_sha256: String,
}

/// 一次 staging 的规范文件清单：按 `logical_path` 字节序排序。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeltaInventory {
    /// 按 `logical_path` 字节序升序排列的文件表。
    pub entries: Vec<InventoryEntry>,
    /// 所有 `entries[].size` 之和（`checked_add`，溢出 fail-closed）。
    pub logical_size: u64,
}

/// 两次清单的差异。三个列表均按 `logical_path` 字节序排序。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InventoryDiff {
    /// path + size + sha256 完全一致的文件（含未变的 `manifest.json`）。
    pub reuse: Vec<InventoryEntry>,
    /// 新增或内容变化的文件，需要上传新对象。
    pub upload_new: Vec<InventoryEntry>,
    /// 上一版存在、当前版不存在的逻辑路径。
    pub deleted: Vec<String>,
}

impl InventoryDiff {
    /// 可安全复用旧对象的文件。
    ///
    /// `manifest.json` 含 [`VOLATILE_MANIFEST_FIELDS`]，每版必变，按
    /// always-changed 处理：即使两版字节完全一致也不进入复用候选。
    pub fn reuse_candidates(&self) -> Vec<&InventoryEntry> {
        self.reuse
            .iter()
            .filter(|entry| entry.logical_path != MANIFEST_LOGICAL_PATH)
            .collect()
    }
}

/// 校验相对逻辑路径，与 `cloud_storage::delta_format` 的路径规则同语义：
/// 拒绝 `..`、`.`、绝对路径、空段、反斜杠、NUL、盘符；超过
/// [`MAX_LOGICAL_PATH_BYTES`] 字节直接拒绝，不截断。
pub fn validate_logical_path(value: &str) -> Result<(), BackupError> {
    if value.is_empty() {
        return Err(BackupError::Manifest("logical_path 不能为空".to_string()));
    }
    if value.len() > MAX_LOGICAL_PATH_BYTES {
        return Err(BackupError::Manifest(format!(
            "logical_path 超过 {MAX_LOGICAL_PATH_BYTES} 字节上限（不截断，直接拒绝）"
        )));
    }
    if value.bytes().any(|b| b == 0) {
        return Err(BackupError::Manifest(
            "logical_path 含 NUL 字节".to_string(),
        ));
    }
    if value.contains('\\') {
        return Err(BackupError::Manifest(
            "logical_path 含反斜杠；只允许 `/` 分隔的相对路径".to_string(),
        ));
    }
    if value.starts_with('/') {
        return Err(BackupError::Manifest(
            "logical_path 不允许绝对路径".to_string(),
        ));
    }
    if value.as_bytes().get(1) == Some(&b':') {
        return Err(BackupError::Manifest(
            "logical_path 不允许盘符路径".to_string(),
        ));
    }
    for segment in value.split('/') {
        if segment.is_empty() {
            return Err(BackupError::Manifest(
                "logical_path 含空路径段（前导/尾随/重复 `/`）".to_string(),
            ));
        }
        if segment == "." || segment == ".." {
            return Err(BackupError::Manifest(
                "logical_path 含 `.`/`..` 路径段，拒绝目录穿越".to_string(),
            ));
        }
    }
    Ok(())
}

/// 遍历已验证 staging 根目录，产出规范清单。
///
/// - hash 以磁盘真实内容为准（不信任任何旁路元数据）；
/// - 符号链接与非普通文件 fail-closed（已验证 staging 不应含它们）；
/// - 路径非法 / 超长 / 非 UTF-8 fail-closed，绝不跳过或截断；
/// - 文件数超过 [`MAX_SNAPSHOT_FILES`] fail-closed；
/// - `logical_size` 用 `checked_add` 累加，溢出 fail-closed。
pub fn build_inventory(staging_root: &Path) -> Result<DeltaInventory, BackupError> {
    let root_metadata = fs::symlink_metadata(staging_root)?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(BackupError::BackupDirectory(format!(
            "staging 根必须是普通目录: {}",
            staging_root.display()
        )));
    }

    let mut entries: Vec<InventoryEntry> = Vec::new();
    for entry in WalkDir::new(staging_root).follow_links(false) {
        let entry = entry
            .map_err(|error| BackupError::BackupDirectory(format!("遍历 staging 失败: {error}")))?;
        let file_type = entry.file_type();
        if file_type.is_symlink() {
            return Err(BackupError::BackupDirectory(format!(
                "staging 含符号链接，fail-closed: {}",
                entry.path().display()
            )));
        }
        if !file_type.is_file() {
            continue;
        }

        let relative = entry.path().strip_prefix(staging_root).map_err(|_| {
            BackupError::BackupDirectory(format!(
                "staging 条目不在根目录内: {}",
                entry.path().display()
            ))
        })?;
        let mut logical_path = String::new();
        for component in relative.components() {
            let segment = component.as_os_str().to_str().ok_or_else(|| {
                BackupError::Manifest(format!(
                    "staging 路径不是合法 UTF-8，拒绝出清单: {}",
                    entry.path().display()
                ))
            })?;
            if !logical_path.is_empty() {
                logical_path.push('/');
            }
            logical_path.push_str(segment);
        }
        validate_logical_path(&logical_path)?;

        let size = entry
            .metadata()
            .map_err(|error| {
                BackupError::BackupDirectory(format!("读取 staging 文件元数据失败: {error}"))
            })?
            .len();
        let plaintext_sha256 = calculate_file_sha256(entry.path())?;
        entries.push(InventoryEntry {
            logical_path,
            size,
            plaintext_sha256,
        });

        if entries.len() > MAX_SNAPSHOT_FILES {
            return Err(BackupError::BackupDirectory(format!(
                "staging 文件数超过上限 {MAX_SNAPSHOT_FILES}（不截断，直接拒绝）"
            )));
        }
    }

    entries.sort_by(|a, b| a.logical_path.as_bytes().cmp(b.logical_path.as_bytes()));
    let mut logical_size: u64 = 0;
    for pair in entries.windows(2) {
        if pair[0].logical_path == pair[1].logical_path {
            return Err(BackupError::BackupDirectory(format!(
                "logical_path 重复，fail-closed: {}",
                pair[0].logical_path
            )));
        }
    }
    for entry in &entries {
        logical_size = logical_size.checked_add(entry.size).ok_or_else(|| {
            BackupError::BackupDirectory("entries[].size 之和溢出 u64，拒绝出清单".to_string())
        })?;
    }

    Ok(DeltaInventory {
        entries,
        logical_size,
    })
}

/// 用 [`BackupManifest`] 对磁盘清单做交叉核对。hash 以磁盘内容为准：
/// manifest 声称的文件缺失、大小不符或 SHA-256 不符都说明 staging 未通过
/// 验证，fail-closed 拒绝，而不是采信 manifest。
pub fn cross_check_manifest(
    inventory: &DeltaInventory,
    manifest: &BackupManifest,
) -> Result<(), BackupError> {
    let by_path: BTreeMap<&str, &InventoryEntry> = inventory
        .entries
        .iter()
        .map(|entry| (entry.logical_path.as_str(), entry))
        .collect();

    if !by_path.contains_key(MANIFEST_LOGICAL_PATH) {
        return Err(BackupError::IntegrityCheckFailed(format!(
            "staging 缺少 {MANIFEST_LOGICAL_PATH}，不是已验证 staging"
        )));
    }

    let mut check = |path: &str, size: u64, sha256: Option<&str>| -> Result<(), BackupError> {
        let normalized = path.replace('\\', "/");
        let entry = by_path.get(normalized.as_str()).ok_or_else(|| {
            BackupError::IntegrityCheckFailed(format!(
                "manifest 声称的文件在磁盘上缺失: {normalized}"
            ))
        })?;
        if entry.size != size {
            return Err(BackupError::IntegrityCheckFailed(format!(
                "{normalized} 磁盘大小 {} 与 manifest 声称的 {size} 不符（磁盘为准，拒绝）",
                entry.size
            )));
        }
        if let Some(expected) = sha256 {
            if !expected.eq_ignore_ascii_case(&entry.plaintext_sha256) {
                return Err(BackupError::IntegrityCheckFailed(format!(
                    "{normalized} 磁盘 SHA-256 与 manifest 声称值不符（磁盘为准，拒绝）"
                )));
            }
        }
        Ok(())
    };

    for file in &manifest.files {
        check(&file.path, file.size, Some(file.sha256.as_str()))?;
    }
    if let Some(assets) = &manifest.assets {
        for asset in &assets.files {
            if asset.is_directory {
                continue;
            }
            check(&asset.relative_path, asset.size, asset.checksum.as_deref())?;
        }
    }
    Ok(())
}

/// 遍历 staging 并用其根目录下的 `manifest.json` 交叉核对。
///
/// 任何不一致 fail-closed；返回磁盘清单与解析后的 manifest。
pub fn build_inventory_cross_checked(
    staging_root: &Path,
) -> Result<(DeltaInventory, BackupManifest), BackupError> {
    let inventory = build_inventory(staging_root)?;
    let manifest = BackupManifest::load_from_file(&staging_root.join(MANIFEST_LOGICAL_PATH))?;
    cross_check_manifest(&inventory, &manifest)?;
    Ok((inventory, manifest))
}

/// 比较两次清单：path + size + sha256 完全一致 → reuse；当前版新增或内容
/// 变化 → upload-new；上一版存在而当前版不存在 → deleted。
pub fn diff(prev: &DeltaInventory, current: &DeltaInventory) -> InventoryDiff {
    let prev_by_path: BTreeMap<&str, &InventoryEntry> = prev
        .entries
        .iter()
        .map(|entry| (entry.logical_path.as_str(), entry))
        .collect();
    let current_paths: BTreeMap<&str, ()> = current
        .entries
        .iter()
        .map(|entry| (entry.logical_path.as_str(), ()))
        .collect();

    let mut reuse = Vec::new();
    let mut upload_new = Vec::new();
    for entry in &current.entries {
        match prev_by_path.get(entry.logical_path.as_str()) {
            Some(previous)
                if previous.size == entry.size
                    && previous.plaintext_sha256 == entry.plaintext_sha256 =>
            {
                reuse.push(entry.clone());
            }
            _ => upload_new.push(entry.clone()),
        }
    }
    let deleted = prev
        .entries
        .iter()
        .filter(|entry| !current_paths.contains_key(entry.logical_path.as_str()))
        .map(|entry| entry.logical_path.clone())
        .collect();

    InventoryDiff {
        reuse,
        upload_new,
        deleted,
    }
}

/// 剥离 volatile 字段后比较两份 `manifest.json` 的 canonicalized JSON。
///
/// 忽略顶层 [`VOLATILE_MANIFEST_FIELDS`] 与 `assets` 内的每版时间戳；
/// 返回 `true` 表示两版 manifest 除 volatile 字段外内容完全一致。
/// 非法 JSON fail-closed。
pub fn manifest_unchanged_ignoring_volatile(
    prev: &[u8],
    current: &[u8],
) -> Result<bool, BackupError> {
    let prev = canonicalize_manifest_value(prev)?;
    let current = canonicalize_manifest_value(current)?;
    Ok(prev == current)
}

fn canonicalize_manifest_value(bytes: &[u8]) -> Result<serde_json::Value, BackupError> {
    let mut value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|e| BackupError::Manifest(format!("manifest 不是合法 JSON: {e}")))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| BackupError::Manifest("manifest 顶层必须是 JSON 对象".to_string()))?;
    for field in VOLATILE_MANIFEST_FIELDS {
        object.remove(field);
    }
    if let Some(assets) = object.get_mut("assets").and_then(|a| a.as_object_mut()) {
        for field in VOLATILE_ASSET_RESULT_FIELDS {
            assets.remove(field);
        }
    }
    Ok(value)
}
