//! [R12-delta-format] backup-v2 快照描述与仓库配置的纯 codec（DELTA-R11 §3–§5）。
//!
//! 本模块**只做格式**：schema、上限校验、编码/解码往返与 fail-closed 拒绝。
//! 它没有接入任何上传、下载、命令或 UI 路径；生产 Cloud backup 仍是
//! 「全量 ZIP → 单对象 `put_file`」，**不得**因本模块存在而宣称增量备份已实现。
//!
//! [Wave2-D R5 裁决] 状态 = **experimental 隔离**；接线前置清单与升级路径见
//! docs/dev/wave2-D-backup-v2-decision.md。
//!
//! 硬约束（对应 DELTA-R11 §4）：
//!
//! - 每个 [`SnapshotDescriptorV2`] 都是**自包含**的完整对象表；schema 使用
//!   `deny_unknown_fields`，任何 `parent` / `patch` / 未来扩展字段都会在解码时
//!   直接失败，不可能悄悄变成恢复链依赖；
//! - `formatVersion` 必须**恰好**等于 2：未来版本 fail-closed，绝不猜测解读；
//! - 所有上限（文件数、路径字节数、objectKey 字节数）超限即拒绝，**不截断**；
//! - [`BackupV2RepoConfig`] 只承载格式与 `idKeyEpoch`，不含任何密钥材料。

use serde::{Deserialize, Serialize};

use super::traits::Result;
use crate::models::AppError;

/// snapshot descriptor 的固定 format 字符串。
pub const SNAPSHOT_V2_FORMAT: &str = "snapshot-v2";
/// repository config 的固定 format 字符串。
pub const BACKUP_V2_FORMAT: &str = "backup-v2";
/// 本 codec 唯一接受的 formatVersion；不是「≥」，未来版本必须拒绝。
pub const DELTA_FORMAT_VERSION: u32 = 2;
/// 单个 descriptor 允许引用的最大逻辑文件数。
pub const MAX_SNAPSHOT_FILES: usize = 100_000;
/// `logicalPath` 的最大 UTF-8 字节数。
pub const MAX_LOGICAL_PATH_BYTES: usize = 4096;
/// `objectKey` 的最大 UTF-8 字节数。
pub const MAX_OBJECT_KEY_BYTES: usize = 512;
/// `versionId` / `deviceId` 这类标识符的最大字节数（防御性上限）。
pub const MAX_IDENTIFIER_BYTES: usize = 256;

/// backup-v2 中一个逻辑文件到不可变云端对象的直接引用。
///
/// 未变文件复用旧对象引用、变更文件写新随机对象都以本结构表达；
/// 它**不是** patch/delta：恢复时按引用直接下载对象，不追父版本。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotFileRefV2 {
    /// staging 内的相对逻辑路径（`/` 分隔；拒绝 `..`、绝对路径、空段、反斜杠、NUL）。
    pub logical_path: String,
    /// 明文字节数；descriptor 的 `logicalSize` 必须等于所有文件之和。
    pub size: u64,
    /// 明文 SHA-256（64 位 hex）。
    pub plaintext_sha256: String,
    /// 云端对象 key（随机命名、不可变；拒绝穿越）。
    pub object_key: String,
    /// 云端对象密文 SHA-256（64 位 hex），恢复时先于 AEAD 验证。
    pub object_cipher_sha256: String,
}

/// backup-v2 的自包含完整快照描述（DELTA-R11 §3.2 `backup-v2/snapshots/…`）。
///
/// 一个 descriptor 直接列出该恢复点的**全部**对象引用；没有 `parent`、没有
/// patch 链。schema 层面通过 `deny_unknown_fields` 保证这类字段无法混入。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotDescriptorV2 {
    /// 固定为 [`SNAPSHOT_V2_FORMAT`]。
    pub format: String,
    /// 固定为 [`DELTA_FORMAT_VERSION`]；其他值（含未来版本）一律拒绝。
    pub format_version: u32,
    /// 版本 ID（与版本索引条目一致）。
    pub version_id: String,
    /// 产生本快照的设备 ID。
    pub device_id: String,
    /// RFC 3339 创建时间。
    pub created_at: String,
    /// 完整逻辑文件表；空表合法（空 staging 也是一个可恢复时点）。
    pub files: Vec<SnapshotFileRefV2>,
    /// 逻辑总字节数；必须精确等于 `files[].size` 之和。
    pub logical_size: u64,
}

/// backup-v2 加密仓库配置（DELTA-R11 §3.2 `backup-v2/config.dsbk` 的明文 schema）。
///
/// 只描述格式与 `idKeyEpoch`；**不含**任何密钥、salt、wrapped key 等密钥材料，
/// 那些属于外层 DSBK 容器与未来 key 管理路，不属于本 codec。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupV2RepoConfig {
    /// 固定为 [`BACKUP_V2_FORMAT`]。
    pub format: String,
    /// 固定为 [`DELTA_FORMAT_VERSION`]；未来版本 fail-closed。
    pub format_version: u32,
    /// 对象 ID key 的版本纪元（≥ 1）；轮换 `id_key` 时递增。
    pub id_key_epoch: u32,
}

fn is_hex_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn validate_identifier(field: &str, value: &str) -> Result<()> {
    if value.is_empty() {
        return Err(AppError::validation(format!("{field} 不能为空")));
    }
    if value.len() > MAX_IDENTIFIER_BYTES {
        return Err(AppError::validation(format!(
            "{field} 超过 {MAX_IDENTIFIER_BYTES} 字节上限"
        )));
    }
    if value
        .chars()
        .any(|c| c.is_control() || c == '/' || c == '\\')
    {
        return Err(AppError::validation(format!(
            "{field} 含控制字符或路径分隔符"
        )));
    }
    Ok(())
}

/// 校验相对逻辑路径：拒绝 `..`、`.`、绝对路径、空段、反斜杠与 NUL；超限拒绝，不截断。
fn validate_relative_path(field: &str, value: &str, max_bytes: usize) -> Result<()> {
    if value.is_empty() {
        return Err(AppError::validation(format!("{field} 不能为空")));
    }
    if value.len() > max_bytes {
        return Err(AppError::validation(format!(
            "{field} 超过 {max_bytes} 字节上限（不截断，直接拒绝）"
        )));
    }
    if value.bytes().any(|b| b == 0) {
        return Err(AppError::validation(format!("{field} 含 NUL 字节")));
    }
    if value.contains('\\') {
        return Err(AppError::validation(format!(
            "{field} 含反斜杠；只允许 `/` 分隔的相对路径"
        )));
    }
    if value.starts_with('/') {
        return Err(AppError::validation(format!("{field} 不允许绝对路径")));
    }
    // 拒绝 Windows 盘符形式的绝对/漂移路径（如 `C:\` 已被反斜杠拦截，`C:/` 在此拦截）。
    if value.as_bytes().get(1) == Some(&b':') {
        return Err(AppError::validation(format!("{field} 不允许盘符路径")));
    }
    for segment in value.split('/') {
        if segment.is_empty() {
            return Err(AppError::validation(format!(
                "{field} 含空路径段（前导/尾随/重复 `/`）"
            )));
        }
        if segment == "." || segment == ".." {
            return Err(AppError::validation(format!(
                "{field} 含 `.`/`..` 路径段，拒绝目录穿越"
            )));
        }
    }
    Ok(())
}

impl SnapshotFileRefV2 {
    /// 单条引用的完整校验；descriptor 级校验（重复路径、logicalSize）另行执行。
    pub fn validate(&self) -> Result<()> {
        validate_relative_path("logicalPath", &self.logical_path, MAX_LOGICAL_PATH_BYTES)?;
        validate_relative_path("objectKey", &self.object_key, MAX_OBJECT_KEY_BYTES)?;
        if !is_hex_sha256(&self.plaintext_sha256) {
            return Err(AppError::validation(
                "plaintextSha256 必须是 64 位十六进制 SHA-256",
            ));
        }
        if !is_hex_sha256(&self.object_cipher_sha256) {
            return Err(AppError::validation(
                "objectCipherSha256 必须是 64 位十六进制 SHA-256",
            ));
        }
        Ok(())
    }
}

impl SnapshotDescriptorV2 {
    /// 全量校验：format/version 精确匹配、标识符、时间、文件表上限、
    /// 重复路径 fail-closed、`logicalSize` 与文件之和精确一致。
    pub fn validate(&self) -> Result<()> {
        if self.format != SNAPSHOT_V2_FORMAT {
            return Err(AppError::validation(format!(
                "snapshot descriptor format 必须是 {SNAPSHOT_V2_FORMAT}，实际为 {}",
                self.format
            )));
        }
        if self.format_version != DELTA_FORMAT_VERSION {
            return Err(AppError::validation(format!(
                "snapshot descriptor formatVersion 必须恰好为 {DELTA_FORMAT_VERSION}，\
                 实际为 {}；未来版本 fail-closed，不猜测解读",
                self.format_version
            )));
        }
        validate_identifier("versionId", &self.version_id)?;
        validate_identifier("deviceId", &self.device_id)?;
        if chrono::DateTime::parse_from_rfc3339(&self.created_at).is_err() {
            return Err(AppError::validation("createdAt 必须是合法 RFC 3339 时间戳"));
        }
        if self.files.len() > MAX_SNAPSHOT_FILES {
            return Err(AppError::validation(format!(
                "descriptor 文件数 {} 超过上限 {MAX_SNAPSHOT_FILES}（不截断，直接拒绝）",
                self.files.len()
            )));
        }
        let mut seen_paths = std::collections::HashSet::with_capacity(self.files.len());
        let mut sum: u64 = 0;
        for file in &self.files {
            file.validate()?;
            if !seen_paths.insert(file.logical_path.as_str()) {
                return Err(AppError::validation(format!(
                    "logicalPath 重复：{}（fail-closed，拒绝整个 descriptor）",
                    file.logical_path
                )));
            }
            sum = sum.checked_add(file.size).ok_or_else(|| {
                AppError::validation("files[].size 之和溢出 u64，拒绝 descriptor")
            })?;
        }
        if self.logical_size != sum {
            return Err(AppError::validation(format!(
                "logicalSize({}) 必须精确等于 files[].size 之和({sum})",
                self.logical_size
            )));
        }
        Ok(())
    }

    /// 校验后编码为规范 JSON 字节。非法结构直接失败，绝不写出半合法对象。
    pub fn encode(&self) -> Result<Vec<u8>> {
        self.validate()?;
        serde_json::to_vec(self)
            .map_err(|e| AppError::internal(format!("snapshot descriptor 序列化失败: {e}")))
    }

    /// 解码并全量校验。未知字段（含 `parent`/`patch`）、未来版本、超限、
    /// 穿越路径、非法 hex、重复路径与 `logicalSize` 不一致均 fail-closed。
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let descriptor: Self = serde_json::from_slice(bytes)
            .map_err(|e| AppError::validation(format!("snapshot descriptor 解析失败: {e}")))?;
        descriptor.validate()?;
        Ok(descriptor)
    }
}

impl BackupV2RepoConfig {
    /// 校验 format/version 精确匹配与 `idKeyEpoch ≥ 1`。
    pub fn validate(&self) -> Result<()> {
        if self.format != BACKUP_V2_FORMAT {
            return Err(AppError::validation(format!(
                "repository config format 必须是 {BACKUP_V2_FORMAT}，实际为 {}",
                self.format
            )));
        }
        if self.format_version != DELTA_FORMAT_VERSION {
            return Err(AppError::validation(format!(
                "repository config formatVersion 必须恰好为 {DELTA_FORMAT_VERSION}，\
                 实际为 {}；未来版本 fail-closed",
                self.format_version
            )));
        }
        if self.id_key_epoch == 0 {
            return Err(AppError::validation(
                "idKeyEpoch 必须 ≥ 1（0 视为未初始化，fail-closed）",
            ));
        }
        Ok(())
    }

    /// 校验后编码为 JSON 字节。
    pub fn encode(&self) -> Result<Vec<u8>> {
        self.validate()?;
        serde_json::to_vec(self)
            .map_err(|e| AppError::internal(format!("repository config 序列化失败: {e}")))
    }

    /// 解码并校验；未知字段（例如任何密钥材料字段）直接拒绝。
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let config: Self = serde_json::from_slice(bytes)
            .map_err(|e| AppError::validation(format!("repository config 解析失败: {e}")))?;
        config.validate()?;
        Ok(config)
    }
}
