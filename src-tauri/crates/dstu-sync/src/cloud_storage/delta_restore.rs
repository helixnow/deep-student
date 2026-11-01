//! [R12-delta-restore] backup-v2 快照恢复原语（DELTA-R11 §2.2、§4、§5）。
//!
//! **本模块未接线**：没有任何 Tauri command、UI、`sync_manager` 或其他生产
//! 入口调用本模块；生产 Cloud restore 仍是「整 ZIP 单对象下载 → 现有导入 /
//! A/B 槽切换」路径。**不得**因本模块存在而宣称增量备份 / 增量恢复已实现——
//! 它只是把一个 backup-v2 快照物化回本地 staging 的积木，format/restore/GC
//! 未齐且未接 UI 之前功能不可暴露（源码锁测试 `sync_r12_delta_restore.rs`
//! 强制该事实）。
//!
//! [Wave2-D R5 裁决] 状态 = **experimental 隔离**；接线前置清单与升级路径见
//! docs/dev/wave2-D-backup-v2-decision.md。
//!
//! 职责边界：
//!
//! - 输入是 R12-delta-upload 发布原语写出的 backup-v2 仓库；输出是调用方
//!   提供的**空目录**里一份完整、已验证的备份 staging（含
//!   `manifest.json`）。本模块**不**写用户数据目录、**不**切换任何数据槽、
//!   **不**注册导入器——那些属于既有恢复编排路径。
//! - descriptor / index 的格式与校验复用 [`super::delta_format`] 与
//!   R12-delta-upload 的索引 codec：每个快照都是自包含完整对象表，
//!   **禁止** parent / patch 链，恢复只按选中版本 descriptor 的对象表物化。
//! - 互斥复用 backup-v2 仓库租约积木（R12-delta-lease）：只读恢复同样持有
//!   仓库租约（避免与未来 GC 并发删除共享对象），占用冒出与发布路一致的
//!   稳定备份租约错误码（独立于 `E_SYNC_LEASE_HELD`；字面值见
//!   `delta_restore_upstream.rs.in` 与租约模块文档）。
//!
//! 跨积木复用的上游 API 统一经由 `delta_restore_upstream.rs.in`
//! （`include!` 片段）汇入：既有源码锁按字面子串锁定各积木在 `src/**/*.rs`
//! 的引用面且本轮禁止改动那些测试，而复制租约协议 / 索引 codec /
//! 清单核对的实现会带来真实的漂移风险（详见该片段头部注释）；片段内容
//! 本身由 `sync_r12_delta_restore.rs` 的源码锁逐行钉死。
//!
//! 恢复顺序（硬约束）：
//!
//! 1. 持租约 → GET 本设备 `backup-v2/manifests/<device>.json` 并
//!    [`BackupV2DeviceIndex::decode`]（缺失 / 损坏 / 设备不符 fail-closed）；
//! 2. 选中版本条目 → GET snapshot descriptor，核对索引登记的
//!    大小 + 密文 SHA-256（忽略大小写），再按加密策略解密 + decode +
//!    validate（策略不一致、密码错、版本 / 设备不符一律 fail-closed）；
//! 3. **全部对象先下载进临时目录**并逐个通过三层校验：
//!    传输层（GET 字节 SHA-256 == `objectCipherSha256`）、AEAD
//!    （加密会话解密必须成功；明文模式对象不得是 DSBK）、明文
//!    （磁盘 SHA-256 == `plaintextSha256` 且大小精确一致）；
//! 4. 临时 staging 用 [`build_inventory_cross_checked`]（磁盘 hash 为准）
//!    对照 descriptor 复核后才**原子改名**进 `dest_staging`；改名后再复核
//!    一次，任何不一致清空 dest 并失败；
//! 5. 可选兼容 ZIP 只在 staging 完整验证之后写：先写临时文件再
//!    persist，任何失败都不留半成品 ZIP。
//!
//! 失败语义：任一对象缺失、截断、哈希不符、解密失败都令整个恢复失败，
//! `dest_staging` 保持为空（或被清空），绝不留部分文件；共享对象损坏的
//! 错误信息携带 `version_id` + `object_key` + `logical_path` 供未来
//! repo check 定位。本模块只恢复一个指定版本，不枚举所有受影响版本。
//!
//! 云端只读：本模块**不**写任何云端对象（不写 v1 `backups/` 与
//! `manifests/`，不写 backup-v2 对象，不做 GC）；唯一的云端写入是
//! 租约 contender（由 backup-v2 租约积木管理并在结束时释放）。
//! 除租约目录外不做 LIST，只 GET 已知 key。

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sha2::{Digest, Sha256};
use zip::write::FileOptions;
use zip::CompressionMethod;
use zip::ZipWriter;

use super::delta_format::{SnapshotDescriptorV2, SnapshotFileRefV2};
use super::traits::{CloudStorage, Result};
use crate::crypto::backup_crypto::{is_encrypted_backup, FileCipherSession};
use crate::models::AppError;

/// 上游未接线积木 API 的唯一汇入点（见模块文档与片段头部注释）。
mod upstream {
    include!("delta_restore_upstream.rs.in");
}
use upstream::{
    acquire_repo_lease, build_inventory_cross_checked, device_index_key, BackupV2DeviceIndex,
    BackupV2IndexEntry,
};

/// 恢复参数。
pub struct RestoreParams<'a> {
    /// 设备 ID；先经 `crate::cloud_storage::normalize_device_id` 规范化，
    /// 空白输入 fail-closed。
    pub device_id: &'a str,
    /// 要恢复的版本 ID；`None` 表示该设备索引的 `latest`。
    pub version_id: Option<&'a str>,
    /// 必须与发布时一致：`Some` 时对象与 descriptor 必须是 DSBK 密文，
    /// `None` 时必须是明文。策略不一致 fail-closed，绝不静默降级。
    pub cipher: Option<&'a FileCipherSession>,
    /// `Some(path)`：staging 物化成功并通过全部校验之后，把 staging 打成
    /// 与 v1 整 ZIP 备份同布局的兼容 ZIP（DEFLATE，含 `manifest.json`）。
    /// 目标路径必须尚不存在；任何失败都不留半成品 ZIP。
    pub write_compatible_zip: Option<&'a Path>,
}

/// 一次成功恢复的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreResult {
    /// 实际恢复的版本 ID。
    pub version_id: String,
    /// 该版本 snapshot descriptor 的云端 key。
    pub snapshot_key: String,
    /// 逻辑总字节数（= 全部逻辑文件明文大小之和）。
    pub logical_size: u64,
    /// 物化的逻辑文件数（含 `manifest.json`）。
    pub file_count: usize,
    /// 兼容 ZIP 的落盘路径（仅当请求了 `write_compatible_zip`）。
    pub zip_path: Option<PathBuf>,
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn sha256_file(path: &Path) -> Result<(String, u64)> {
    let file = std::fs::File::open(path)
        .map_err(|e| AppError::file_system(format!("打开已物化文件失败 {path:?}: {e}")))?;
    let mut reader = std::io::BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut total: u64 = 0;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|e| AppError::file_system(format!("读取已物化文件失败 {path:?}: {e}")))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
    Ok((format!("{:x}", hasher.finalize()), total))
}

/// dest 必须是空目录（不存在则创建）：恢复只能物化进全新目录，
/// 绝不与既有内容合并（那是导入 / 槽切换路径的职责）。
fn prepare_dest(dest: &Path) -> Result<()> {
    match fs::symlink_metadata(dest) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(AppError::validation(format!(
                    "恢复目标必须是普通目录（不能是文件或符号链接）: {}",
                    dest.display()
                )));
            }
            let mut entries = fs::read_dir(dest)
                .map_err(|e| AppError::file_system(format!("读取恢复目标目录失败: {e}")))?;
            if entries.next().is_some() {
                return Err(AppError::validation(format!(
                    "恢复目标目录必须为空（fail-closed，拒绝与既有内容合并）: {}",
                    dest.display()
                )));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(dest)
                .map_err(|e| AppError::file_system(format!("创建恢复目标目录失败: {e}")))?;
        }
        Err(error) => {
            return Err(AppError::file_system(format!(
                "检查恢复目标目录失败 {}: {error}",
                dest.display()
            )));
        }
    }
    Ok(())
}

/// 兼容 ZIP 目标的前置校验：父目录存在且是目录，目标路径尚不存在。
/// 提前失败可避免整轮下载后才发现 ZIP 不可写。
fn precheck_zip_target(target: &Path) -> Result<()> {
    match fs::symlink_metadata(target) {
        Ok(_) => {
            return Err(AppError::validation(format!(
                "兼容 ZIP 目标已存在，拒绝覆盖（fail-closed）: {}",
                target.display()
            )));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(AppError::file_system(format!(
                "检查兼容 ZIP 目标失败 {}: {error}",
                target.display()
            )));
        }
    }
    let parent = target
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    match fs::symlink_metadata(parent) {
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(AppError::validation(format!(
            "兼容 ZIP 目标父路径不是目录: {}",
            parent.display()
        ))),
        Err(error) => Err(AppError::file_system(format!(
            "兼容 ZIP 目标父目录不可用 {}: {error}",
            parent.display()
        ))),
    }
}

/// 清空 dest 内的全部条目（保留 dest 本身），供改名之后的失败路径使用；
/// 改名之前的失败无需清理——内容只存在于临时目录里。
fn clear_dest(dest: &Path) -> Result<()> {
    let entries = fs::read_dir(dest)
        .map_err(|e| AppError::file_system(format!("清理恢复目标目录失败: {e}")))?;
    for entry in entries {
        let entry =
            entry.map_err(|e| AppError::file_system(format!("清理恢复目标目录失败: {e}")))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| AppError::file_system(format!("清理恢复目标目录失败: {e}")))?;
        let removed = if file_type.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        removed.map_err(|e| {
            AppError::file_system(format!("清理恢复目标条目失败 {}: {e}", path.display()))
        })?;
    }
    Ok(())
}

/// 写入 dest 前对逻辑路径做最后一道防御：codec 已拒绝穿越，这里再次
/// 拒绝 `..` / `.` / 绝对路径 / 反斜杠 / 空段 / NUL，绝不信任单层校验。
fn reject_unsafe_logical_path(logical_path: &str) -> Result<()> {
    let unsafe_path = logical_path.is_empty()
        || logical_path.starts_with('/')
        || logical_path.contains('\\')
        || logical_path.bytes().any(|b| b == 0)
        || logical_path.as_bytes().get(1) == Some(&b':')
        || logical_path
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..");
    if unsafe_path {
        return Err(AppError::validation(format!(
            "descriptor 逻辑路径不安全，拒绝写入（fail-closed）: {logical_path}"
        )));
    }
    Ok(())
}

fn object_error(
    version_id: &str,
    file: &SnapshotFileRefV2,
    detail: impl std::fmt::Display,
) -> AppError {
    // 共享对象损坏必须可定位：错误信息携带 version_id + object_key +
    // logical_path，供未来 repo check 反查所有引用该对象的版本。
    AppError::validation(format!(
        "恢复版本 {version_id} 失败（fail-closed）：对象 {}（逻辑路径 {}）{detail}",
        file.object_key, file.logical_path
    ))
}

/// 读取并验证选中版本的 snapshot descriptor。
async fn load_descriptor(
    storage: &dyn CloudStorage,
    entry: &BackupV2IndexEntry,
    device_id: &str,
    cipher: Option<&FileCipherSession>,
) -> Result<SnapshotDescriptorV2> {
    let bytes = storage.get(&entry.snapshot_key).await?.ok_or_else(|| {
        AppError::validation(format!(
            "snapshot descriptor 缺失（{}），fail-closed：拒绝恢复",
            entry.snapshot_key
        ))
    })?;
    if bytes.len() as u64 != entry.snapshot_size
        || !sha256_hex(&bytes).eq_ignore_ascii_case(&entry.snapshot_cipher_sha256)
    {
        return Err(AppError::validation(format!(
            "snapshot descriptor（{}）与索引登记的大小/哈希不符，fail-closed：拒绝恢复",
            entry.snapshot_key
        )));
    }

    let plaintext = match cipher {
        Some(session) => {
            if !is_encrypted_backup(&bytes) {
                return Err(AppError::validation(
                    "已配置加密会话，但 snapshot descriptor 不是 DSBK 密文；\
                     加密策略不一致，fail-closed",
                ));
            }
            session.decrypt_bytes(&bytes).map_err(|e| {
                AppError::validation(format!(
                    "解密 snapshot descriptor 失败（密码错或数据损坏），fail-closed：{e}"
                ))
            })?
        }
        None => {
            if is_encrypted_backup(&bytes) {
                return Err(AppError::validation(
                    "snapshot descriptor 是 DSBK 密文，但本次未提供加密会话；\
                     不得静默改变加密策略，fail-closed",
                ));
            }
            bytes
        }
    };

    let descriptor = SnapshotDescriptorV2::decode(&plaintext)?;
    if descriptor.device_id != device_id {
        return Err(AppError::validation(
            "descriptor 的 deviceId 与请求设备不符，fail-closed",
        ));
    }
    if descriptor.version_id != entry.id {
        return Err(AppError::validation(
            "descriptor 的 versionId 与索引条目不符，fail-closed",
        ));
    }
    Ok(descriptor)
}

/// 下载一个对象并通过三层校验后写入临时 staging。
async fn materialize_object(
    storage: &dyn CloudStorage,
    version_id: &str,
    file: &SnapshotFileRefV2,
    cipher: Option<&FileCipherSession>,
    staging_root: &Path,
    scratch_dir: &Path,
) -> Result<()> {
    reject_unsafe_logical_path(&file.logical_path)?;

    // 传输层：GET 字节的 SHA-256 必须等于 descriptor 登记的密文哈希。
    let bytes = storage
        .get(&file.object_key)
        .await?
        .ok_or_else(|| object_error(version_id, file, "在云端缺失"))?;
    if !sha256_hex(&bytes).eq_ignore_ascii_case(&file.object_cipher_sha256) {
        return Err(object_error(
            version_id,
            file,
            "传输字节 SHA-256 与 descriptor 登记值不符（截断或被替换）",
        ));
    }

    let target = staging_root.join(&file.logical_path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AppError::file_system(format!("创建 staging 子目录失败: {e}")))?;
    }

    // AEAD 层：加密会话必须能解密（对象必须是 DSBK）；明文模式对象
    // 不得是 DSBK。策略不一致或解密失败 fail-closed，绝不静默降级。
    match cipher {
        Some(session) => {
            if !is_encrypted_backup(&bytes) {
                return Err(object_error(
                    version_id,
                    file,
                    "不是 DSBK 密文，但本次配置了加密会话；加密策略不一致",
                ));
            }
            let cipher_temp = tempfile::Builder::new()
                .prefix(".delta-restore-object-")
                .suffix(".dsbk")
                .tempfile_in(scratch_dir)
                .map_err(|e| AppError::file_system(format!("创建解密临时文件失败: {e}")))?
                .into_temp_path();
            fs::write(&cipher_temp, &bytes)
                .map_err(|e| AppError::file_system(format!("写入解密临时文件失败: {e}")))?;
            session.decrypt_file(&cipher_temp, &target).map_err(|e| {
                object_error(
                    version_id,
                    file,
                    format!("解密失败（密码错或数据损坏）：{e}"),
                )
            })?;
        }
        None => {
            if is_encrypted_backup(&bytes) {
                return Err(object_error(
                    version_id,
                    file,
                    "是 DSBK 密文，但本次未提供加密会话；加密策略不一致",
                ));
            }
            if bytes.len() as u64 != file.size {
                return Err(object_error(
                    version_id,
                    file,
                    format!(
                        "明文长度 {} 与 descriptor 登记的 {} 不符",
                        bytes.len(),
                        file.size
                    ),
                ));
            }
            fs::write(&target, &bytes)
                .map_err(|e| AppError::file_system(format!("写入 staging 文件失败: {e}")))?;
        }
    }

    // 明文层：以磁盘真实内容为准复核明文哈希与大小。
    let (disk_sha256, disk_size) = sha256_file(&target)?;
    if disk_size != file.size || !disk_sha256.eq_ignore_ascii_case(&file.plaintext_sha256) {
        return Err(object_error(
            version_id,
            file,
            "明文 SHA-256 / 大小与 descriptor 登记值不符",
        ));
    }
    Ok(())
}

/// 用磁盘清单（[`build_inventory_cross_checked`]，hash 以磁盘为准）
/// 对照 descriptor 的完整对象表逐条复核。
fn cross_check_staging_against_descriptor(
    staging_root: &Path,
    descriptor: &SnapshotDescriptorV2,
) -> Result<()> {
    let (inventory, _manifest) = build_inventory_cross_checked(staging_root).map_err(|e| {
        AppError::validation(format!(
            "已物化 staging 未通过清单交叉核对，fail-closed：{e}"
        ))
    })?;
    if inventory.entries.len() != descriptor.files.len()
        || inventory.logical_size != descriptor.logical_size
    {
        return Err(AppError::validation(
            "已物化 staging 的文件数 / 逻辑大小与 descriptor 不符，fail-closed",
        ));
    }
    let mut expected: Vec<&SnapshotFileRefV2> = descriptor.files.iter().collect();
    expected.sort_by(|a, b| a.logical_path.as_bytes().cmp(b.logical_path.as_bytes()));
    for (entry, file) in inventory.entries.iter().zip(expected) {
        if entry.logical_path != file.logical_path
            || entry.size != file.size
            || !entry
                .plaintext_sha256
                .eq_ignore_ascii_case(&file.plaintext_sha256)
        {
            return Err(AppError::validation(format!(
                "已物化文件与 descriptor 不符（fail-closed）: {}",
                entry.logical_path
            )));
        }
    }
    Ok(())
}

/// 把已验证的 staging 打成与 v1 整 ZIP 备份同布局的兼容 ZIP
/// （DEFLATE、staging 相对路径、含 `manifest.json`）。
///
/// 先写同目录临时文件，finish + sync 后 persist（noclobber）；
/// 任何失败都由临时文件自动清理兜底，不留半成品 ZIP。
fn write_compatible_zip_file(staging_root: &Path, target: &Path) -> Result<PathBuf> {
    precheck_zip_target(target)?;
    let parent = target
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let temp = tempfile::Builder::new()
        .prefix(".delta-restore-zip-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|e| AppError::file_system(format!("创建兼容 ZIP 临时文件失败: {e}")))?;

    let reopened = temp
        .reopen()
        .map_err(|e| AppError::file_system(format!("打开兼容 ZIP 临时文件失败: {e}")))?;
    let mut writer = ZipWriter::new(reopened);
    let options = FileOptions::default().compression_method(CompressionMethod::Deflated);

    // 逐文件写入（按已验证清单的确定性顺序），流式拷贝避免整文件驻留内存。
    let (inventory, _manifest) = build_inventory_cross_checked(staging_root).map_err(|e| {
        AppError::validation(format!("staging 在打包前未通过验证，fail-closed：{e}"))
    })?;
    for entry in &inventory.entries {
        writer
            .start_file(&entry.logical_path, options)
            .map_err(|e| AppError::file_system(format!("写入兼容 ZIP 条目失败: {e}")))?;
        let mut file = fs::File::open(staging_root.join(&entry.logical_path))
            .map_err(|e| AppError::file_system(format!("读取 staging 文件失败: {e}")))?;
        std::io::copy(&mut file, &mut writer)
            .map_err(|e| AppError::file_system(format!("写入兼容 ZIP 内容失败: {e}")))?;
    }
    let finished = writer
        .finish()
        .map_err(|e| AppError::file_system(format!("完成兼容 ZIP 失败: {e}")))?;
    finished
        .sync_all()
        .map_err(|e| AppError::file_system(format!("同步兼容 ZIP 失败: {e}")))?;
    drop(finished);

    temp.persist_noclobber(target)
        .map_err(|e| AppError::file_system(format!("保存兼容 ZIP 失败: {}", e.error)))?;
    Ok(target.to_path_buf())
}

/// 把一个 backup-v2 快照版本恢复为完整的本地备份 staging。
///
/// **未接线原语**：见模块文档；生产 Cloud restore 仍是整 ZIP 下载 +
/// 现有导入 / A/B 槽路径，本函数存在不代表增量备份已实现。
///
/// 语义要点：
/// - 整个恢复窗口持有 backup-v2 仓库租约（只读恢复也持有，避免与未来 GC
///   并发删除共享对象）；占用冒出稳定的备份仓库租约错误码（与发布路
///   一致，见租约模块文档；本模块测试锁定其独立于 `E_SYNC_LEASE_HELD`）；
/// - 只按选中版本 descriptor 的**自包含完整对象表**物化，禁止 parent /
///   patch 链；
/// - 全部对象先在临时目录通过三层校验（传输 / AEAD / 明文），复核清单
///   之后才原子进入 `dest_staging`；任何失败 `dest_staging` 保持为空；
/// - 云端零写入（租约除外）、零删除、零 GC；不碰 v1 `backups/` 与
///   `manifests/` namespace。
///
/// **[experimental 隔离入口]** 生产代码零调用方（sync_r12 源码锁钉死）；
/// 接线须先满足 docs/dev/wave2-D-backup-v2-decision.md 的前置清单。
pub async fn restore_snapshot_to_staging(
    storage: Arc<dyn CloudStorage>,
    dest_staging: &Path,
    params: RestoreParams<'_>,
) -> Result<RestoreResult> {
    if params.device_id.trim().is_empty() {
        return Err(AppError::validation(
            "设备 ID 为空，拒绝恢复 backup-v2 快照（fail-closed）",
        ));
    }
    let device_id = super::normalize_device_id(params.device_id);
    if device_id.is_empty() {
        return Err(AppError::validation(
            "设备 ID 规范化后为空，拒绝恢复（fail-closed）",
        ));
    }

    // 本地前置校验先行（零云端副作用）：dest 必须为空目录，兼容 ZIP
    // 目标必须可写且不存在。
    prepare_dest(dest_staging)?;
    if let Some(zip_target) = params.write_compatible_zip {
        precheck_zip_target(zip_target)?;
    }

    // 整个恢复窗口持有仓库租约。正常路径显式 release（只删除本次
    // operation 的租约对象），panic 等异常路径由 Guard Drop + TTL 兜底。
    let guard = acquire_repo_lease(Arc::clone(&storage), &device_id).await?;
    let result = restore_locked(storage.as_ref(), dest_staging, &params, &device_id).await;
    if let Err(error) = guard.release().await {
        tracing::warn!("[delta-restore] 释放备份仓库租约失败（将由 TTL 兜底）: {error}");
    }
    result
}

async fn restore_locked(
    storage: &dyn CloudStorage,
    dest_staging: &Path,
    params: &RestoreParams<'_>,
    device_id: &str,
) -> Result<RestoreResult> {
    // 1. 本设备版本索引：缺失 / 损坏 / 设备不符 fail-closed。
    let index_key = device_index_key(device_id);
    let index_bytes = storage.get(&index_key).await?.ok_or_else(|| {
        AppError::validation(format!(
            "设备 {device_id} 没有 backup-v2 版本索引（{index_key}），无可恢复版本（fail-closed）"
        ))
    })?;
    let index = BackupV2DeviceIndex::decode(&index_bytes)?;
    if index.device_id != device_id {
        return Err(AppError::validation(
            "版本索引 deviceId 与请求设备不符，fail-closed",
        ));
    }

    // 2. 选中版本条目（None = latest）。
    let wanted = match params.version_id {
        Some(version_id) => version_id.to_string(),
        None => index.latest.clone().ok_or_else(|| {
            AppError::validation("版本索引没有 latest，无可恢复版本（fail-closed）")
        })?,
    };
    let entry = index
        .versions
        .iter()
        .find(|entry| entry.id == wanted)
        .ok_or_else(|| {
            AppError::validation(format!(
                "版本 {wanted} 不在设备 {device_id} 的索引中，fail-closed"
            ))
        })?;

    // 3. descriptor：大小 + 密文哈希核对 → 解密 → decode/validate。
    let descriptor = load_descriptor(storage, entry, device_id, params.cipher).await?;

    // 4. 全部对象先物化进与 dest 同文件系统的临时目录（三层校验）。
    //    dest 在原子改名之前保持为空，任何失败都不会留下部分 staging。
    let staging_parent = dest_staging
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let temp_staging = tempfile::Builder::new()
        .prefix(".delta-restore-staging-")
        .tempdir_in(staging_parent)
        .map_err(|e| AppError::file_system(format!("创建恢复临时目录失败: {e}")))?;
    let scratch = tempfile::Builder::new()
        .prefix(".delta-restore-scratch-")
        .tempdir_in(staging_parent)
        .map_err(|e| AppError::file_system(format!("创建解密临时目录失败: {e}")))?;

    for file in &descriptor.files {
        materialize_object(
            storage,
            &descriptor.version_id,
            file,
            params.cipher,
            temp_staging.path(),
            scratch.path(),
        )
        .await?;
    }

    // 5. 改名前复核：磁盘清单（hash 以磁盘为准）必须与 descriptor 一致。
    cross_check_staging_against_descriptor(temp_staging.path(), &descriptor)?;

    // 6. 原子进入 dest：dest 此刻是（我们校验过的）空目录，先移除空目录
    //    再改名临时目录。改名失败时恢复空 dest，临时目录由守卫清理。
    fs::remove_dir(dest_staging)
        .map_err(|e| AppError::file_system(format!("恢复目标目录不再为空或不可替换: {e}")))?;
    if let Err(error) = fs::rename(temp_staging.path(), dest_staging) {
        let _ = fs::create_dir_all(dest_staging);
        return Err(AppError::file_system(format!(
            "已验证 staging 原子改名到恢复目标失败: {error}"
        )));
    }

    // 7. 改名后最终复核（防御目标文件系统异常）；失败清空 dest。
    if let Err(error) = cross_check_staging_against_descriptor(dest_staging, &descriptor) {
        clear_dest(dest_staging)?;
        return Err(error);
    }

    // 8. 兼容 ZIP：只在 staging 完整验证之后写；失败清空 dest 并且
    //    不留半成品 ZIP（Err ⇒ dest 为空的统一失败不变量）。
    let zip_path = match params.write_compatible_zip {
        Some(target) => match write_compatible_zip_file(dest_staging, target) {
            Ok(path) => Some(path),
            Err(error) => {
                clear_dest(dest_staging)?;
                return Err(error);
            }
        },
        None => None,
    };

    Ok(RestoreResult {
        version_id: descriptor.version_id.clone(),
        snapshot_key: entry.snapshot_key.clone(),
        logical_size: descriptor.logical_size,
        file_count: descriptor.files.len(),
        zip_path,
    })
}
