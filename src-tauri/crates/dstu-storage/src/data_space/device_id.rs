//! 设备 ID：路径解析、生成、持久化与恢复后轮换。
//!
//! 从 `cloud_storage::sync_manager` 下沉（vfs 只依赖存储层身份，不依赖整个云同步）。
//! 原路径 `crate::cloud_storage::{get_device_id, ...}` 由 `cloud_storage` 重导出保留。

use sha2::{Digest, Sha256};
use std::path::Path;
use uuid::Uuid;

/// [R12-neutral-names] per-device manifest 文件名与新写入 `createdByDevice` 的短哈希长度。
const DEVICE_ID_SHORT_HASH_LEN: usize = 16;

pub fn normalize_device_id(device_id: &str) -> String {
    let trimmed = device_id.trim();
    if !trimmed.is_empty()
        && trimmed.len() <= 128
        && !matches!(trimmed, "." | "..")
        && trimmed
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return trimmed.to_string();
    }

    let mut hasher = Sha256::new();
    hasher.update(trimmed.as_bytes());
    format!("device-{}", hex::encode(hasher.finalize()))
}

/// [R12-neutral-names] 设备 ID 短哈希（SHA256 hex 前缀）。
///
/// 用于 `manifests/<hash>.json` 与新写入的 `.encryption-marker.createdByDevice`。
/// 完整 device_id 仍写在 manifest 内容的 `deviceId` 字段；旧 `manifests/<device_id>.json`
/// 读取侧继续兼容。调用方应传入已经 [`normalize_device_id`] 过的值。
pub fn device_id_short_hash(device_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(device_id.as_bytes());
    hex::encode(hasher.finalize())
        .chars()
        .take(DEVICE_ID_SHORT_HASH_LEN)
        .collect()
}

/// 主路径文件名：`<app_data_dir>/.device_id`（与数据槽 `slots/` 同根）
const DEVICE_ID_FILE_NAME: &str = ".device_id";
/// 历史遗留：data_governance 早期把设备 ID 写在 `<app_data_dir>/device_id`
const LEGACY_ROOT_DEVICE_ID_FILE_NAME: &str = "device_id";

/// 设备 ID 主路径：Tauri 应用数据目录（与数据槽同根）。
///
/// 数据空间管理器在启动早期初始化；若尚未初始化（如纯单元测试进程），
/// 返回 None，调用方必须显式处理"无法持久化"这一事实。
fn primary_device_id_path() -> Option<std::path::PathBuf> {
    crate::data_space::get_data_space_manager()
        .map(|manager| manager.base_dir().join(DEVICE_ID_FILE_NAME))
}

/// 旧候选路径（只读迁移来源，按历史优先级排列）。
///
/// 包含旧 app 根文件 `device_id` 与早期写入的全局目录副本。这些路径不再
/// 作为新 ID 的写入目标，仅用于一次性迁移与轮换后的副本同步。
fn legacy_device_id_paths() -> Vec<std::path::PathBuf> {
    let mut paths = Vec::new();
    if let Some(manager) = crate::data_space::get_data_space_manager() {
        paths.push(manager.base_dir().join(LEGACY_ROOT_DEVICE_ID_FILE_NAME));
    }
    for dir in [dirs::data_local_dir(), dirs::config_dir(), dirs::home_dir()]
        .into_iter()
        .flatten()
    {
        paths.push(dir.join("deep-student").join(DEVICE_ID_FILE_NAME));
    }
    paths
}

fn read_device_id_file(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(normalize_device_id(trimmed))
    }
}

/// 原子写入设备 ID（临时文件 + fsync + rename），避免半写文件产生残缺身份。
fn write_device_id_atomic(path: &Path, id: &str) -> std::io::Result<()> {
    use std::io::Write;

    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "device id path has no parent",
        )
    })?;
    std::fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(id.as_bytes())?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

fn device_hostname() -> String {
    std::env::var("COMPUTERNAME") // Windows
        .or_else(|_| std::env::var("HOSTNAME")) // Linux/Unix
        .or_else(|_| std::env::var("HOST")) // macOS
        .unwrap_or_else(|_| "device".to_string())
}

#[derive(Debug)]
struct DeviceIdResolution {
    id: String,
    /// id 是否落在磁盘上（读自主路径/旧路径，或新生成后成功写入主路径）。
    persisted: bool,
}

/// 解析（或生成）设备 ID 的核心逻辑，路径全部注入以便测试。
///
/// 顺序：主路径 → 旧路径（命中即一次性迁移到主路径）→ 生成新 ID 并只写主路径。
/// 生成后写入失败时如实返回 `persisted: false`，不假装成功。
fn resolve_or_create_device_id(
    primary: Option<&Path>,
    legacy: &[std::path::PathBuf],
) -> DeviceIdResolution {
    if let Some(primary) = primary {
        if let Some(id) = read_device_id_file(primary) {
            return DeviceIdResolution {
                id,
                persisted: true,
            };
        }
    }

    for path in legacy {
        let Some(id) = read_device_id_file(path) else {
            continue;
        };
        // 一次性迁移到主路径。迁移失败不阻塞返回：旧路径仍可读，
        // 下次调用会重试迁移，身份本身不受影响。
        if let Some(primary) = primary {
            match write_device_id_atomic(primary, &id) {
                Ok(()) => tracing::info!(
                    "设备 ID 已从旧路径 {} 迁移到主路径 {}",
                    path.display(),
                    primary.display()
                ),
                Err(error) => tracing::warn!(
                    "设备 ID 迁移到主路径 {} 失败（旧路径仍可用，稍后重试）: {}",
                    primary.display(),
                    error
                ),
            }
        }
        return DeviceIdResolution {
            id,
            persisted: true,
        };
    }

    // 生成新的设备 ID（结合主机名以保证一定程度的可读性），只写主路径。
    let short_uuid = &Uuid::new_v4().to_string()[..8];
    let new_id = normalize_device_id(&format!("{}-{}", device_hostname(), short_uuid));
    let persisted = match primary {
        Some(primary) => match write_device_id_atomic(primary, &new_id) {
            Ok(()) => {
                tracing::info!("新设备 ID 已保存到主路径: {}", primary.display());
                true
            }
            Err(error) => {
                tracing::error!(
                    "新设备 ID 写入主路径 {} 失败，无法持久化: {}",
                    primary.display(),
                    error
                );
                false
            }
        },
        None => {
            tracing::error!("应用数据目录尚未初始化，设备 ID 无法持久化");
            false
        }
    };
    DeviceIdResolution {
        id: new_id,
        persisted,
    }
}

/// 持久化失败时的进程级兜底身份。
///
/// 主路径不可写时不能"每次调用都生成新 ID 还假装成功"：那会让同一进程
/// 的上传以无数个一次性设备身份散落在云端。这里退化为进程内稳定的临时
/// 身份，并用 error 级日志显式暴露持久化失败。
static UNPERSISTED_DEVICE_ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// 获取或生成设备 ID
///
/// 优先级：
/// 1. 环境变量 DEVICE_ID
/// 2. 主路径 `<app_data_dir>/.device_id`（与数据槽同根）
/// 3. 旧路径一次性迁移：`<app_data_dir>/device_id`、
///    data_local_dir/config_dir/home_dir 下的 `deep-student/.device_id`
/// 4. 生成新 ID 并写入主路径；写入失败则退化为进程内稳定的临时 ID（记录 error 日志）
pub fn get_device_id() -> String {
    // 优先从环境变量获取
    if let Ok(id) = std::env::var("DEVICE_ID") {
        if !id.is_empty() {
            return normalize_device_id(&id);
        }
    }

    // 一旦进入过"持久化失败"状态，本进程内保持同一临时身份，避免身份漂移。
    if let Some(id) = UNPERSISTED_DEVICE_ID.get() {
        return id.clone();
    }

    let primary = primary_device_id_path();
    let resolution = resolve_or_create_device_id(primary.as_deref(), &legacy_device_id_paths());
    if resolution.persisted {
        resolution.id
    } else {
        UNPERSISTED_DEVICE_ID
            .get_or_init(|| {
                tracing::error!(
                    "设备 ID 持久化失败，本进程内使用临时设备 ID {}（重启后会变化，云端会出现新设备目录）",
                    resolution.id
                );
                resolution.id.clone()
            })
            .clone()
    }
}

/// 恢复备份后轮换设备 ID。
///
/// restore 会把本机数据回退到过去时间点；继续沿用旧 device_id 会触发
/// data_governance 的回声过滤，使旧身份在备份点之后上传过的变更永远不被本机重新消费。
/// 轮换后本机以“新设备”身份重新追赶旧设备目录。
pub fn generate_device_id_after_restore() -> String {
    let short_uuid = &Uuid::new_v4().to_string()[..8];
    normalize_device_id(&format!("{}-{}", device_hostname(), short_uuid))
}

/// 把新身份写到主路径与仍存在的旧副本，路径注入以便测试。
///
/// - 主路径写入失败 → 直接返回错误，不假装成功。
/// - 旧副本仅在文件已存在时更新（防止降级/旧代码读到已被轮换掉的旧身份），
///   主路径已写成功时旧副本失败只降级为 warn。
/// - 主路径不可用（数据目录未初始化）时，退化为写第一个可写的旧路径。
fn persist_device_id_to_paths(
    primary: Option<&Path>,
    legacy: &[std::path::PathBuf],
    new_id: &str,
) -> std::io::Result<()> {
    if new_id.trim().is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "new device id must not be empty",
        ));
    }

    let mut primary_written = false;
    if let Some(primary) = primary {
        write_device_id_atomic(primary, new_id)?;
        primary_written = true;
    }

    let mut wrote_any = primary_written;
    for path in legacy {
        if !path.exists() {
            continue;
        }
        match write_device_id_atomic(path, new_id) {
            Ok(()) => wrote_any = true,
            Err(error) => {
                if primary_written {
                    tracing::warn!(
                        "更新旧设备 ID 副本 {} 失败（主路径已更新，读取仍以主路径为准）: {}",
                        path.display(),
                        error
                    );
                } else {
                    return Err(error);
                }
            }
        }
    }

    if !wrote_any {
        for path in legacy {
            if write_device_id_atomic(path, new_id).is_ok() {
                wrote_any = true;
                break;
            }
        }
    }
    if !wrote_any {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no writable device id location",
        ));
    }
    Ok(())
}

/// Persist a pre-generated restore identity. Supplying the identity from the
/// restore journal makes retries idempotent after a crash or partial I/O error.
pub fn persist_device_id_after_restore(new_id: &str) -> std::io::Result<()> {
    let primary = primary_device_id_path();
    persist_device_id_to_paths(primary.as_deref(), &legacy_device_id_paths(), new_id)?;
    std::env::set_var("DEVICE_ID", new_id);
    Ok(())
}

pub fn rotate_device_id_after_restore() -> std::io::Result<(String, String)> {
    let old_id = get_device_id();
    let new_id = generate_device_id_after_restore();
    persist_device_id_after_restore(&new_id)?;
    tracing::info!("设备 ID 已在恢复后轮换: old={}, new={}", old_id, new_id);
    Ok((old_id, new_id))
}

#[cfg(test)]
mod device_id_tests {
    use super::*;
    use std::path::PathBuf;

    fn write(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    #[test]
    fn primary_path_takes_precedence_over_legacy() {
        let temp = tempfile::tempdir().unwrap();
        let primary = temp.path().join(".device_id");
        let legacy = temp.path().join("legacy").join(".device_id");
        write(&primary, "primary-id");
        write(&legacy, "legacy-id");

        let resolution = resolve_or_create_device_id(Some(&primary), &[legacy]);
        assert_eq!(resolution.id, "primary-id");
        assert!(resolution.persisted);
    }

    #[test]
    fn legacy_id_is_migrated_to_primary_once() {
        let temp = tempfile::tempdir().unwrap();
        let primary = temp.path().join(".device_id");
        let legacy = temp.path().join("legacy").join(".device_id");
        write(&legacy, "old-device");

        let resolution = resolve_or_create_device_id(Some(&primary), &[legacy.clone()]);
        assert_eq!(resolution.id, "old-device");
        assert!(resolution.persisted);
        // 迁移后主路径持有同一身份；此后即使旧文件被改动也不再影响读取。
        assert_eq!(
            std::fs::read_to_string(&primary).unwrap().trim(),
            "old-device"
        );
        write(&legacy, "tampered");
        let second = resolve_or_create_device_id(Some(&primary), &[legacy]);
        assert_eq!(second.id, "old-device");
    }

    #[test]
    fn legacy_candidates_are_consulted_in_priority_order() {
        let temp = tempfile::tempdir().unwrap();
        let primary = temp.path().join(".device_id");
        let app_root_legacy = temp.path().join("device_id");
        let global_legacy = temp.path().join("deep-student").join(".device_id");
        write(&app_root_legacy, "app-root-id");
        write(&global_legacy, "global-id");

        let resolution =
            resolve_or_create_device_id(Some(&primary), &[app_root_legacy, global_legacy]);
        assert_eq!(resolution.id, "app-root-id");
    }

    #[test]
    fn generated_id_is_persisted_to_primary_and_stable_afterwards() {
        let temp = tempfile::tempdir().unwrap();
        let primary = temp.path().join(".device_id");

        let first = resolve_or_create_device_id(Some(&primary), &[]);
        assert!(first.persisted, "新生成的 ID 必须成功写入主路径");
        assert!(!first.id.is_empty());
        assert_eq!(std::fs::read_to_string(&primary).unwrap().trim(), first.id);

        let second = resolve_or_create_device_id(Some(&primary), &[]);
        assert_eq!(second.id, first.id, "再次解析必须读回同一身份");
    }

    #[test]
    fn persist_failure_is_reported_instead_of_faked() {
        let temp = tempfile::tempdir().unwrap();
        // 用一个普通文件占住"父目录"位置，使 create_dir_all 必然失败。
        let blocker = temp.path().join("blocker");
        std::fs::write(&blocker, "file").unwrap();
        let primary = blocker.join(".device_id");

        let resolution = resolve_or_create_device_id(Some(&primary), &[]);
        assert!(
            !resolution.persisted,
            "主路径不可写时必须如实报告未持久化，而不是假装成功"
        );

        // 主路径完全缺失（数据目录未初始化）同样不能宣称已持久化。
        let resolution = resolve_or_create_device_id(None, &[]);
        assert!(!resolution.persisted);
    }

    #[test]
    fn persist_writes_primary_and_refreshes_existing_legacy_copies() {
        let temp = tempfile::tempdir().unwrap();
        let primary = temp.path().join(".device_id");
        let stale_legacy = temp.path().join("device_id");
        let absent_legacy = temp.path().join("deep-student").join(".device_id");
        write(&stale_legacy, "old-identity");

        persist_device_id_to_paths(
            Some(&primary),
            &[stale_legacy.clone(), absent_legacy.clone()],
            "rotated-identity",
        )
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(&primary).unwrap().trim(),
            "rotated-identity"
        );
        // 已存在的旧副本必须同步更新，否则旧读取逻辑会复活轮换前的身份。
        assert_eq!(
            std::fs::read_to_string(&stale_legacy).unwrap().trim(),
            "rotated-identity"
        );
        // 不存在的旧路径不应被无谓创建。
        assert!(!absent_legacy.exists());
    }

    #[test]
    fn persist_fails_when_primary_is_unwritable() {
        let temp = tempfile::tempdir().unwrap();
        let blocker = temp.path().join("blocker");
        std::fs::write(&blocker, "file").unwrap();
        let primary = blocker.join(".device_id");
        let legacy: Vec<PathBuf> = vec![temp.path().join("device_id")];

        let error =
            persist_device_id_to_paths(Some(&primary), &legacy, "new-identity").unwrap_err();
        assert!(!legacy[0].exists(), "主路径失败时不应留下部分写入");
        let _ = error;
    }

    #[test]
    fn persist_falls_back_to_legacy_when_primary_unavailable() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("deep-student").join(".device_id");

        persist_device_id_to_paths(None, &[legacy.clone()], "fallback-identity").unwrap();
        assert_eq!(
            std::fs::read_to_string(&legacy).unwrap().trim(),
            "fallback-identity"
        );
    }

    #[test]
    fn persist_rejects_empty_identity() {
        let temp = tempfile::tempdir().unwrap();
        let primary = temp.path().join(".device_id");
        assert!(persist_device_id_to_paths(Some(&primary), &[], "  ").is_err());
    }

    #[test]
    fn read_device_id_file_normalizes_and_rejects_blank() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(".device_id");

        write(&path, "  spaced-id \n");
        assert_eq!(read_device_id_file(&path).unwrap(), "spaced-id");

        write(&path, "   \n");
        assert_eq!(read_device_id_file(&path), None);

        // 非法字符会被 normalize 成稳定哈希，而不是原样进入云端路径。
        write(&path, "../evil");
        let normalized = read_device_id_file(&path).unwrap();
        assert!(normalized.starts_with("device-"));
    }
}
