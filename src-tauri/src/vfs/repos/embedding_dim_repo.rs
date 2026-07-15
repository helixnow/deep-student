//! VFS 向量维度注册仓库
//!
//! 管理 vfs_embedding_dims 表的 CRUD 操作
//!
//! ## 2026-01 配置化维度管理
//! - 支持手动创建新维度（维度范围 64-8192）
//! - 支持级联删除维度及其关联数据
//! - 移除硬编码维度列表，改为数据库驱动

use crate::vfs::error::VfsError;
use rusqlite::{params, Connection, OptionalExtension, Row};
use sha2::{Digest, Sha256};

/// 维度值范围常量
pub const MIN_DIMENSION: i32 = 64;
pub const MAX_DIMENSION: i32 = 8192;
const INDEX_PROFILE_SCHEMA_VERSION: i32 = 1;

/// 预置常用维度（用于 UI 快捷选择）
pub const PRESET_DIMENSIONS: &[i32] = &[256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096];

/// 维度注册记录
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsEmbeddingDim {
    pub dimension: i32,
    pub modality: String, // "text" | "multimodal"
    pub lance_table_name: String,
    pub record_count: i64,
    pub created_at: i64,
    pub last_used_at: i64,
    /// 绑定的模型配置 ID
    pub model_config_id: Option<String>,
    /// 绑定的模型名称（用于显示）
    pub model_name: Option<String>,
    /// Active vector-space profile.  Rows from another profile must never be
    /// written to this dimension's compatibility table.
    pub active_profile_id: Option<String>,
    pub model_fingerprint: Option<String>,
    pub embedding_protocol: String,
    /// Compatibility metadata only. Per-Unit generations govern visibility.
    pub active_generation: i64,
    pub ann_metric: String,
    pub ann_index_version: i32,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsIndexProfile {
    pub id: String,
    pub model_fingerprint: String,
    pub model_config_id: Option<String>,
    pub model_name: Option<String>,
    pub dimension: i32,
    pub modality: String,
    pub embedding_protocol: String,
    pub schema_version: i32,
    pub lance_table_name: String,
    /// Compatibility metadata only. Per-Unit generations govern visibility.
    pub active_generation: i64,
    pub state: String,
    pub ann_metric: String,
    pub ann_index_version: i32,
    pub created_at: i64,
    pub updated_at: i64,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn row_to_dim(row: &Row) -> rusqlite::Result<VfsEmbeddingDim> {
    Ok(VfsEmbeddingDim {
        dimension: row.get("dimension")?,
        modality: row.get("modality")?,
        lance_table_name: row.get("lance_table_name")?,
        record_count: row.get("record_count")?,
        created_at: row.get("created_at")?,
        last_used_at: row.get("last_used_at")?,
        model_config_id: row.get("model_config_id").ok(),
        model_name: row.get("model_name").ok(),
        active_profile_id: row.get("active_profile_id").ok(),
        model_fingerprint: row.get("model_fingerprint").ok(),
        embedding_protocol: row
            .get("embedding_protocol")
            .unwrap_or_else(|_| "legacy".to_string()),
        active_generation: row.get("active_generation").unwrap_or(0),
        ann_metric: row
            .get("ann_metric")
            .unwrap_or_else(|_| "legacy_l2".to_string()),
        ann_index_version: row.get("ann_index_version").unwrap_or(0),
    })
}

fn row_to_profile(row: &Row) -> rusqlite::Result<VfsIndexProfile> {
    Ok(VfsIndexProfile {
        id: row.get("id")?,
        model_fingerprint: row.get("model_fingerprint")?,
        model_config_id: row.get("model_config_id")?,
        model_name: row.get("model_name")?,
        dimension: row.get("dimension")?,
        modality: row.get("modality")?,
        embedding_protocol: row.get("embedding_protocol")?,
        schema_version: row.get("schema_version")?,
        lance_table_name: row.get("lance_table_name")?,
        active_generation: row.get("active_generation")?,
        state: row.get("state")?,
        ann_metric: row.get("ann_metric")?,
        ann_index_version: row.get("ann_index_version")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn committed_profile_segment_count(
    conn: &Connection,
    profile_id: &str,
    modality: &str,
) -> Result<i64, VfsError> {
    let ledger_match = match modality {
        "text" => {
            "s.modality = 'text'
             AND u.text_profile_id = s.index_profile_id
             AND u.text_generation = s.generation"
        }
        "image" | "multimodal" => {
            "s.modality IN ('image', 'multimodal')
             AND u.mm_profile_id = s.index_profile_id
             AND u.mm_generation = s.generation"
        }
        _ => {
            return Err(VfsError::InvalidArgument {
                param: "modality".to_string(),
                reason: format!("Unsupported embedding modality: {}", modality),
            })
        }
    };
    let sql = format!(
        "SELECT COUNT(*)
         FROM vfs_index_segments s
         JOIN vfs_index_units u ON u.id = s.unit_id
         WHERE s.index_profile_id = ?1
           AND {ledger_match}"
    );
    Ok(conn.query_row(&sql, params![profile_id], |row| row.get(0))?)
}

pub fn embedding_protocol_for_modality(modality: &str) -> Result<&'static str, VfsError> {
    match modality {
        "text" => Ok("text-embedding-v1"),
        "image" | "multimodal" => Ok("multimodal-embedding-v1"),
        _ => Err(VfsError::InvalidArgument {
            param: "modality".to_string(),
            reason: format!("Unsupported embedding modality: {}", modality),
        }),
    }
}

pub fn model_fingerprint(model_config_id: &str, model_name: &str, protocol: &str) -> String {
    model_fingerprint_with_transport(
        model_config_id,
        model_name,
        protocol,
        None,
        None,
        None,
        None,
        None,
    )
}

fn normalized_public_base_url(raw: &str) -> String {
    let trimmed = raw.trim();
    let Ok(mut url) = url::Url::parse(trimmed) else {
        return trimmed.trim_end_matches('/').to_ascii_lowercase();
    };
    // Credentials and query parameters may contain secrets and never belong in
    // a vector-space fingerprint.
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.set_fragment(None);
    let normalized_path = url.path().trim_end_matches('/').to_string();
    url.set_path(if normalized_path.is_empty() {
        "/"
    } else {
        &normalized_path
    });
    url.to_string().trim_end_matches('/').to_string()
}

#[allow(clippy::too_many_arguments)]
pub fn model_fingerprint_with_transport(
    model_config_id: &str,
    model_name: &str,
    protocol: &str,
    provider_type: Option<&str>,
    provider_scope: Option<&str>,
    base_url: Option<&str>,
    api_protocol: Option<&str>,
    model_adapter: Option<&str>,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"vfs-index-profile-v2\0");
    let normalized_base_url = base_url.map(normalized_public_base_url).unwrap_or_default();
    for (label, value) in [
        ("protocol", protocol),
        ("config_id", model_config_id),
        ("model", model_name),
        ("provider_type", provider_type.unwrap_or_default()),
        ("provider_scope", provider_scope.unwrap_or_default()),
        ("base_url", normalized_base_url.as_str()),
        ("api_protocol", api_protocol.unwrap_or_default()),
        ("model_adapter", model_adapter.unwrap_or_default()),
    ] {
        hasher.update(label.as_bytes());
        hasher.update(b"\0");
        hasher.update(value.as_bytes());
        hasher.update(b"\0");
    }
    format!("sha256:{:x}", hasher.finalize())
}

pub fn model_fingerprint_for_config(
    config: &crate::llm_manager::ApiConfig,
    modality: &str,
) -> Result<String, VfsError> {
    let protocol = embedding_protocol_for_modality(modality)?;
    Ok(model_fingerprint_with_transport(
        &config.id,
        &config.model,
        protocol,
        config.provider_type.as_deref(),
        config.provider_scope.as_deref(),
        Some(&config.base_url),
        config.api_protocol.as_deref(),
        Some(&config.model_adapter),
    ))
}

fn validate_dimension_and_modality(dimension: i32, modality: &str) -> Result<(), VfsError> {
    if !(MIN_DIMENSION..=MAX_DIMENSION).contains(&dimension) {
        return Err(VfsError::InvalidArgument {
            param: "dimension".to_string(),
            reason: format!(
                "Dimension {} out of valid range [{}, {}]",
                dimension, MIN_DIMENSION, MAX_DIMENSION
            ),
        });
    }
    embedding_protocol_for_modality(modality)?;
    Ok(())
}

fn ensure_binding_is_compatible(
    conn: &Connection,
    dimension: i32,
    modality: &str,
    requested_model_config_id: Option<&str>,
    requested_model_name: Option<&str>,
) -> Result<(), VfsError> {
    let Some(requested) = requested_model_config_id.filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let protocol = embedding_protocol_for_modality(modality)?;
    let requested_name = requested_model_name.unwrap_or(requested);
    let requested_fingerprint = model_fingerprint(requested, requested_name, protocol);
    let existing: Option<(i64, Option<String>, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT record_count, model_config_id, model_name, model_fingerprint
             FROM vfs_embedding_dims WHERE dimension = ?1 AND modality = ?2",
            params![dimension, modality],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    if let Some((record_count, current, current_name, current_fingerprint)) = existing {
        let legacy_match = current_fingerprint
            .as_deref()
            .is_some_and(|value| value.starts_with("legacy:"))
            && current.as_deref() == Some(requested)
            && current_name.as_deref().unwrap_or(requested) == requested_name;
        let exact_match = current_fingerprint.as_deref() == Some(requested_fingerprint.as_str());
        if record_count > 0 && !legacy_match && !exact_match {
            return Err(VfsError::InvalidArgument {
                param: "model_config_id".to_string(),
                reason: format!(
                    "Vector space {}:{} already contains {} rows from model {:?}/{:?} fingerprint {:?}; rebuild into a new index profile before binding model {}/{}",
                    modality,
                    dimension,
                    record_count,
                    current,
                    current_name,
                    current_fingerprint,
                    requested,
                    requested_name
                ),
            });
        }
    }
    Ok(())
}

/// 生成 LanceDB 表名
///
/// ★ 2026-01 修复：统一使用 vfs_emb_ 前缀，与 VfsLanceStore 保持一致
pub fn generate_lance_table_name(modality: &str, dimension: i32) -> String {
    format!("vfs_emb_{}_{}", modality, dimension)
}

pub fn generate_profile_lance_table_name(
    modality: &str,
    dimension: i32,
    fingerprint: &str,
) -> String {
    let suffix = fingerprint
        .strip_prefix("sha256:")
        .unwrap_or(fingerprint)
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .take(16)
        .collect::<String>();
    format!("vfs_emb_{}_{}_{}", modality, dimension, suffix)
}

fn generate_index_profile_id(
    fingerprint: &str,
    dimension: i32,
    modality: &str,
    protocol: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"vfs-index-profile-id-v1\0");
    let dimension = dimension.to_string();
    let schema_version = INDEX_PROFILE_SCHEMA_VERSION.to_string();
    for value in [
        fingerprint,
        modality,
        dimension.as_str(),
        protocol,
        schema_version.as_str(),
    ] {
        hasher.update(value.as_bytes());
        hasher.update(b"\0");
    }
    format!("profile_{:x}", hasher.finalize())
}

/// 注册新维度（如果已存在则仅更新 last_used_at，保留已有的模型绑定）
pub fn register(
    conn: &Connection,
    dimension: i32,
    modality: &str,
) -> Result<VfsEmbeddingDim, VfsError> {
    validate_dimension_and_modality(dimension, modality)?;
    let now = now_ms();
    let table_name = generate_lance_table_name(modality, dimension);

    // 与 register_with_model 不同：此版本在 CONFLICT 时仅更新 last_used_at，
    // 不修改 model_config_id 和 model_name（保留已有绑定）
    conn.execute(
        "INSERT INTO vfs_embedding_dims (
            dimension, modality, lance_table_name, record_count, created_at, last_used_at, model_config_id, model_name
        ) VALUES (?1, ?2, ?3, 0, ?4, ?4, NULL, NULL)
        ON CONFLICT(dimension, modality) DO UPDATE SET
            last_used_at = ?4",
        params![dimension, modality, table_name, now],
    )?;

    get_by_key(conn, dimension, modality)?.ok_or_else(|| VfsError::NotFound {
        resource_type: "EmbeddingDim".to_string(),
        id: format!("{}:{}", dimension, modality),
    })
}

/// 注册新维度并绑定模型
pub fn register_with_model(
    conn: &Connection,
    dimension: i32,
    modality: &str,
    model_config_id: Option<&str>,
    model_name: Option<&str>,
) -> Result<VfsEmbeddingDim, VfsError> {
    register_with_model_fingerprint(conn, dimension, modality, model_config_id, model_name, None)
}

pub fn register_with_model_fingerprint(
    conn: &Connection,
    dimension: i32,
    modality: &str,
    model_config_id: Option<&str>,
    model_name: Option<&str>,
    fingerprint_override: Option<&str>,
) -> Result<VfsEmbeddingDim, VfsError> {
    conn.execute_batch("SAVEPOINT vfs_register_model_profile")?;
    let result = register_with_model_fingerprint_inner(
        conn,
        dimension,
        modality,
        model_config_id,
        model_name,
        fingerprint_override,
    );
    match result {
        Ok(value) => {
            conn.execute_batch("RELEASE SAVEPOINT vfs_register_model_profile")?;
            Ok(value)
        }
        Err(error) => {
            if let Err(rollback_error) = conn.execute_batch(
                "ROLLBACK TO SAVEPOINT vfs_register_model_profile;
                 RELEASE SAVEPOINT vfs_register_model_profile;",
            ) {
                return Err(VfsError::Database(format!(
                    "{}; profile registration rollback failed: {}",
                    error, rollback_error
                )));
            }
            Err(error)
        }
    }
}

fn register_with_model_fingerprint_inner(
    conn: &Connection,
    dimension: i32,
    modality: &str,
    model_config_id: Option<&str>,
    model_name: Option<&str>,
    fingerprint_override: Option<&str>,
) -> Result<VfsEmbeddingDim, VfsError> {
    validate_dimension_and_modality(dimension, modality)?;
    let now = now_ms();
    let protocol = embedding_protocol_for_modality(modality)?;
    let effective_model_id = model_config_id.filter(|value| !value.is_empty());
    let effective_model_name = model_name
        .filter(|value| !value.is_empty())
        .or(effective_model_id);
    let fingerprint = effective_model_id.map(|id| {
        fingerprint_override
            .map(str::to_string)
            .unwrap_or_else(|| model_fingerprint(id, effective_model_name.unwrap_or(id), protocol))
    });
    let existing = get_by_key(conn, dimension, modality)?;
    let same_space = existing
        .as_ref()
        .is_some_and(|current| current.model_fingerprint.as_deref() == fingerprint.as_deref());
    let previous_profile_id = existing
        .as_ref()
        .and_then(|current| current.active_profile_id.clone());
    let previous_profile_assigned = if let Some(profile_id) = previous_profile_id.as_deref() {
        let unit_profile_column = if modality == "text" {
            "text_profile_id"
        } else {
            "mm_profile_id"
        };
        conn.query_row(
            &format!(
                "SELECT EXISTS(SELECT 1 FROM vfs_index_units WHERE {} = ?1)",
                unit_profile_column
            ),
            params![profile_id],
            |row| row.get::<_, bool>(0),
        )?
    } else {
        false
    };
    let previous_profile_has_committed_manifest = previous_profile_id
        .as_deref()
        .map(|profile_id| committed_profile_segment_count(conn, profile_id, modality))
        .transpose()?
        .is_some_and(|count| count > 0);
    let switching_space = !same_space && fingerprint.is_some();
    let switching_committed_space = switching_space && previous_profile_has_committed_manifest;
    let reusable_profile: Option<(String, String)> =
        if let Some(fingerprint) = fingerprint.as_deref() {
            conn.query_row(
                "SELECT id, lance_table_name FROM vfs_index_profiles
             WHERE model_fingerprint = ?1 AND dimension = ?2 AND modality = ?3
               AND embedding_protocol = ?4 AND schema_version = ?5",
                params![
                    fingerprint,
                    dimension,
                    modality,
                    protocol,
                    INDEX_PROFILE_SCHEMA_VERSION
                ],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
        } else {
            None
        };
    let table_name = match (&existing, &fingerprint) {
        (Some(current), _) if same_space => current.lance_table_name.clone(),
        (_, Some(_)) if reusable_profile.is_some() => reusable_profile
            .as_ref()
            .expect("checked reusable profile")
            .1
            .clone(),
        (_, Some(new_fingerprint)) => {
            generate_profile_lance_table_name(modality, dimension, new_fingerprint)
        }
        (Some(current), None) => current.lance_table_name.clone(),
        (None, None) => generate_lance_table_name(modality, dimension),
    };
    let profile_id = if same_space {
        previous_profile_id
            .clone()
            .unwrap_or_else(|| format!("profile_legacy_{}_{}", modality, dimension))
    } else {
        fingerprint
            .as_ref()
            .map(|value| {
                reusable_profile
                    .as_ref()
                    .map(|profile| profile.0.clone())
                    .unwrap_or_else(|| {
                        generate_index_profile_id(value, dimension, modality, protocol)
                    })
            })
            .unwrap_or_else(|| format!("profile_unbound_{}_{}", modality, dimension))
    };

    // M1 fix: None 保留旧值（COALESCE），非 None 更新新值。
    // 显式解绑请使用 update_model_binding 传空字符串，或新增 clear_model_binding 方法。
    conn.execute(
        "INSERT INTO vfs_embedding_dims (
            dimension, modality, lance_table_name, record_count, created_at, last_used_at, model_config_id, model_name
        ) VALUES (?1, ?2, ?3, 0, ?4, ?4, ?5, ?6)
        ON CONFLICT(dimension, modality) DO UPDATE SET
            last_used_at = ?4,
            model_config_id = COALESCE(?5, model_config_id),
            model_name = COALESCE(?6, model_name),
            lance_table_name = excluded.lance_table_name",
        params![dimension, modality, table_name, now, model_config_id, model_name],
    )?;

    let effective_fingerprint =
        fingerprint.unwrap_or_else(|| format!("unbound:{}:{}:{}", modality, dimension, protocol));
    if switching_committed_space {
        if let Some(previous_profile_id) = previous_profile_id.as_deref() {
            conn.execute(
                "UPDATE vfs_index_profiles SET state = 'queryable', updated_at = ?2
                 WHERE id = ?1 AND state <> 'retired'",
                params![previous_profile_id, now],
            )?;
        }
    } else if !same_space {
        if let Some(previous_profile_id) = previous_profile_id.as_deref() {
            conn.execute(
                "UPDATE vfs_index_profiles SET state = 'retired', updated_at = ?2
                 WHERE id = ?1",
                params![previous_profile_id, now],
            )?;
        }
    }
    if same_space {
        conn.execute(
            "UPDATE vfs_index_profiles SET
                model_fingerprint = ?2, model_config_id = COALESCE(?3, model_config_id),
                model_name = COALESCE(?4, model_name), embedding_protocol = ?5,
                lance_table_name = ?6, state = 'active', updated_at = ?7
             WHERE id = ?1",
            params![
                profile_id,
                effective_fingerprint,
                effective_model_id,
                model_name,
                protocol,
                table_name,
                now,
            ],
        )?;
    } else {
        let new_state = if switching_committed_space {
            "building"
        } else {
            "active"
        };
        conn.execute(
            "INSERT INTO vfs_index_profiles (
                id, model_fingerprint, model_config_id, model_name, dimension, modality,
                embedding_protocol, schema_version, lance_table_name, active_generation,
                state, ann_metric, ann_index_version, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, 'exact', 0, ?11, ?11)
             ON CONFLICT(model_fingerprint, dimension, modality, embedding_protocol, schema_version)
             DO UPDATE SET model_name = COALESCE(excluded.model_name, model_name),
                           model_config_id = COALESCE(excluded.model_config_id, model_config_id),
                           state = excluded.state, updated_at = excluded.updated_at",
            params![
                profile_id,
                effective_fingerprint,
                effective_model_id,
                model_name,
                dimension,
                modality,
                protocol,
                INDEX_PROFILE_SCHEMA_VERSION,
                table_name,
                new_state,
                now,
            ],
        )?;
    }
    conn.execute(
        "UPDATE vfs_embedding_dims
         SET active_profile_id = ?3,
             model_fingerprint = ?4,
             embedding_protocol = ?5,
             lance_table_name = ?6,
             model_config_id = COALESCE(?7, model_config_id),
             model_name = COALESCE(?8, model_name)
         WHERE dimension = ?1 AND modality = ?2",
        params![
            dimension,
            modality,
            profile_id,
            effective_fingerprint,
            protocol,
            table_name,
            effective_model_id,
            model_name,
        ],
    )?;

    if switching_space && previous_profile_assigned {
        let (state_column, profile_column) = if modality == "text" {
            ("text_state", "text_profile_id")
        } else {
            ("mm_state", "mm_profile_id")
        };
        if let Some(previous_profile_id) = previous_profile_id.as_deref() {
            let unit_sql = format!(
                "UPDATE vfs_index_units SET {} = 'pending', updated_at = ?2
                 WHERE {} = ?1",
                state_column, profile_column
            );
            conn.execute(&unit_sql, params![previous_profile_id, now])?;
            let (resource_state, retry_column, retry_at_column, error_column) =
                if modality == "text" {
                    (
                        "index_state",
                        "index_retry_count",
                        "index_next_retry_at",
                        "index_error",
                    )
                } else {
                    (
                        "mm_index_state",
                        "mm_index_retry_count",
                        "mm_index_next_retry_at",
                        "mm_index_error",
                    )
                };
            let resource_sql = format!(
                "UPDATE resources SET {} = 'pending', {} = 0, {} = 0, {} = NULL
                 WHERE id IN (SELECT resource_id FROM vfs_index_units WHERE {} = ?1)",
                resource_state, retry_column, retry_at_column, error_column, profile_column
            );
            conn.execute(&resource_sql, params![previous_profile_id])?;
        }
    }

    get_by_key(conn, dimension, modality)?.ok_or_else(|| VfsError::NotFound {
        resource_type: "EmbeddingDim".to_string(),
        id: format!("{}:{}", dimension, modality),
    })
}

/// 按主键查询
pub fn get_by_key(
    conn: &Connection,
    dimension: i32,
    modality: &str,
) -> Result<Option<VfsEmbeddingDim>, VfsError> {
    let result = conn
        .query_row(
            "SELECT * FROM vfs_embedding_dims WHERE dimension = ?1 AND modality = ?2",
            params![dimension, modality],
            row_to_dim,
        )
        .optional()?;
    Ok(result)
}

/// 查询所有已注册维度
pub fn list_all(conn: &Connection) -> Result<Vec<VfsEmbeddingDim>, VfsError> {
    let mut stmt = conn.prepare("SELECT * FROM vfs_embedding_dims ORDER BY modality, dimension")?;
    let dims = stmt
        .query_map([], row_to_dim)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(dims)
}

/// 按模态查询已注册维度
pub fn list_by_modality(
    conn: &Connection,
    modality: &str,
) -> Result<Vec<VfsEmbeddingDim>, VfsError> {
    let mut stmt =
        conn.prepare("SELECT * FROM vfs_embedding_dims WHERE modality = ?1 ORDER BY dimension")?;
    let dims = stmt
        .query_map(params![modality], row_to_dim)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(dims)
}

/// 更新记录数
pub fn update_count(
    conn: &Connection,
    dimension: i32,
    modality: &str,
    count: i64,
) -> Result<(), VfsError> {
    let now = now_ms();
    conn.execute(
        "UPDATE vfs_embedding_dims SET
            record_count = ?3,
            last_used_at = ?4
        WHERE dimension = ?1 AND modality = ?2",
        params![dimension, modality, count, now],
    )?;
    Ok(())
}

/// 增加记录数
pub fn increment_count(
    conn: &Connection,
    dimension: i32,
    modality: &str,
    delta: i64,
) -> Result<(), VfsError> {
    let now = now_ms();
    conn.execute(
        "UPDATE vfs_embedding_dims SET
            record_count = record_count + ?3,
            last_used_at = ?4
        WHERE dimension = ?1 AND modality = ?2",
        params![dimension, modality, delta, now],
    )?;
    Ok(())
}

/// 减少记录数
pub fn decrement_count(
    conn: &Connection,
    dimension: i32,
    modality: &str,
    delta: i64,
) -> Result<(), VfsError> {
    let now = now_ms();
    conn.execute(
        "UPDATE vfs_embedding_dims SET
            record_count = MAX(0, record_count - ?3),
            last_used_at = ?4
        WHERE dimension = ?1 AND modality = ?2",
        params![dimension, modality, delta, now],
    )?;
    Ok(())
}

/// 删除维度记录
pub fn delete(conn: &Connection, dimension: i32, modality: &str) -> Result<bool, VfsError> {
    let rows = conn.execute(
        "DELETE FROM vfs_embedding_dims WHERE dimension = ?1 AND modality = ?2",
        params![dimension, modality],
    )?;
    Ok(rows > 0)
}

/// 创建新维度（配置化入口）
///
/// 校验维度范围 [MIN_DIMENSION, MAX_DIMENSION]，如果维度已存在则返回现有记录
pub fn create_dimension(
    conn: &Connection,
    dimension: i32,
    modality: &str,
    model_config_id: Option<&str>,
    model_name: Option<&str>,
) -> Result<VfsEmbeddingDim, VfsError> {
    validate_dimension_and_modality(dimension, modality)?;
    register_with_model(conn, dimension, modality, model_config_id, model_name)
}

pub fn get_active_profile(
    conn: &Connection,
    dimension: i32,
    modality: &str,
) -> Result<Option<VfsIndexProfile>, VfsError> {
    Ok(conn
        .query_row(
            "SELECT p.* FROM vfs_embedding_dims d
             JOIN vfs_index_profiles p ON p.id = d.active_profile_id
             WHERE d.dimension = ?1 AND d.modality = ?2
               AND p.state IN ('active', 'building', 'queryable')",
            params![dimension, modality],
            row_to_profile,
        )
        .optional()?)
}

pub fn get_profile_by_id(
    conn: &Connection,
    profile_id: &str,
) -> Result<Option<VfsIndexProfile>, VfsError> {
    Ok(conn
        .query_row(
            "SELECT * FROM vfs_index_profiles WHERE id = ?1",
            params![profile_id],
            row_to_profile,
        )
        .optional()?)
}

/// Start a gradual model migration.  Existing referenced profiles remain
/// queryable while this profile receives all new writes.
pub fn begin_profile_rebuild(
    conn: &Connection,
    dimension: i32,
    modality: &str,
    model_config_id: &str,
    model_name: &str,
) -> Result<VfsIndexProfile, VfsError> {
    register_with_model(
        conn,
        dimension,
        modality,
        Some(model_config_id),
        Some(model_name),
    )?;
    get_active_profile(conn, dimension, modality)?.ok_or_else(|| VfsError::NotFound {
        resource_type: "IndexProfile".to_string(),
        id: format!("{}:{}:{}", modality, dimension, model_config_id),
    })
}

/// Promote a building profile after its SQLite Segment manifest is non-empty.
/// Old referenced profiles remain queryable until their references reach zero.
pub fn activate_profile(
    conn: &Connection,
    profile_id: &str,
    min_segment_count: i64,
) -> Result<VfsIndexProfile, VfsError> {
    let profile = get_profile_by_id(conn, profile_id)?.ok_or_else(|| VfsError::NotFound {
        resource_type: "IndexProfile".to_string(),
        id: profile_id.to_string(),
    })?;
    let segment_count = committed_profile_segment_count(conn, profile_id, &profile.modality)?;
    if segment_count < min_segment_count.max(1) {
        return Err(VfsError::InvalidState {
            message: format!(
                "Profile {} has {} validated segments; {} required",
                profile_id,
                segment_count,
                min_segment_count.max(1)
            ),
        });
    }
    conn.execute(
        "UPDATE vfs_index_profiles SET state = 'active', updated_at = ?2 WHERE id = ?1",
        params![profile_id, now_ms()],
    )?;
    get_profile_by_id(conn, profile_id)?.ok_or_else(|| VfsError::NotFound {
        resource_type: "IndexProfile".to_string(),
        id: profile_id.to_string(),
    })
}

pub fn list_active_profiles(
    conn: &Connection,
    modality: Option<&str>,
) -> Result<Vec<VfsIndexProfile>, VfsError> {
    let mut profiles = Vec::new();
    if let Some(modality) = modality {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT p.* FROM vfs_index_profiles p
             WHERE p.state IN ('active', 'building', 'queryable') AND p.modality = ?1
               AND (EXISTS (SELECT 1 FROM vfs_embedding_dims d WHERE d.active_profile_id = p.id)
                    OR EXISTS (SELECT 1 FROM vfs_index_segments s WHERE s.index_profile_id = p.id))
             ORDER BY p.modality, p.dimension, p.id",
        )?;
        let rows = stmt.query_map(params![modality], row_to_profile)?;
        for row in rows {
            profiles.push(row?);
        }
    } else {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT p.* FROM vfs_index_profiles p
             WHERE p.state IN ('active', 'building', 'queryable')
               AND (EXISTS (SELECT 1 FROM vfs_embedding_dims d WHERE d.active_profile_id = p.id)
                    OR EXISTS (SELECT 1 FROM vfs_index_segments s WHERE s.index_profile_id = p.id))
             ORDER BY p.modality, p.dimension, p.id",
        )?;
        let rows = stmt.query_map([], row_to_profile)?;
        for row in rows {
            profiles.push(row?);
        }
    }
    Ok(profiles)
}

pub fn set_ann_status(
    conn: &Connection,
    dimension: i32,
    modality: &str,
    metric: &str,
    version: i32,
) -> Result<(), VfsError> {
    let now = now_ms();
    conn.execute(
        "UPDATE vfs_embedding_dims
         SET ann_metric = ?3, ann_index_version = ?4, last_used_at = ?5
         WHERE dimension = ?1 AND modality = ?2",
        params![dimension, modality, metric, version, now],
    )?;
    conn.execute(
        "UPDATE vfs_index_profiles
         SET ann_metric = ?2, ann_index_version = ?3, updated_at = ?4
         WHERE id = (SELECT active_profile_id FROM vfs_embedding_dims WHERE dimension = ?1 AND modality = ?5)",
        params![dimension, metric, version, now, modality],
    )?;
    Ok(())
}

pub fn set_profile_ann_status(
    conn: &Connection,
    profile_id: &str,
    metric: &str,
    version: i32,
) -> Result<(), VfsError> {
    conn.execute(
        "UPDATE vfs_index_profiles
         SET ann_metric = ?2, ann_index_version = ?3, updated_at = ?4
         WHERE id = ?1",
        params![profile_id, metric, version, now_ms()],
    )?;
    Ok(())
}

/// 级联删除维度及其关联数据（事务保护）
///
/// 删除顺序：
/// 1. vfs_index_segments 中该维度的所有记录
/// 2. 重置受影响的 vfs_index_units 状态（避免孤儿 units）
/// 3. vfs_embedding_dims 中的维度记录
///
/// S3 fix: 使用事务包裹，确保原子性
/// ★ 审计修复：删除 segments 后重置受影响 units 的状态，防止孤儿 units
///
/// 返回删除的 segment 数量
pub fn delete_dimension_cascade(
    conn: &Connection,
    dimension: i32,
    modality: &str,
) -> Result<usize, VfsError> {
    let tx = conn.unchecked_transaction()?;

    let deleted_segments: usize = tx.execute(
        "DELETE FROM vfs_index_segments WHERE embedding_dim = ?1 AND modality = ?2",
        params![dimension, modality],
    )?;

    // ★ 审计修复：重置受影响 units 的状态，防止孤儿 units
    // 找到不再有任何同模态 segments 的 units，重置其状态为 pending
    let now = now_ms();
    if modality == "multimodal" {
        tx.execute(
            "UPDATE vfs_index_units SET
                mm_state = 'pending',
                mm_embedding_dim = NULL,
                mm_error = NULL,
                updated_at = ?1
            WHERE mm_embedding_dim = ?2
            AND id NOT IN (
                SELECT DISTINCT unit_id FROM vfs_index_segments WHERE modality = 'multimodal'
            )",
            params![now, dimension],
        )?;
    } else {
        tx.execute(
            "UPDATE vfs_index_units SET
                text_state = 'pending',
                text_embedding_dim = NULL,
                text_chunk_count = 0,
                text_error = NULL,
                updated_at = ?1
            WHERE text_embedding_dim = ?2
            AND id NOT IN (
                SELECT DISTINCT unit_id FROM vfs_index_segments WHERE modality = 'text'
            )",
            params![now, dimension],
        )?;
    }

    tx.execute(
        "DELETE FROM vfs_embedding_dims WHERE dimension = ?1 AND modality = ?2",
        params![dimension, modality],
    )?;
    tx.execute(
        "DELETE FROM vfs_index_profiles WHERE dimension = ?1 AND modality = ?2",
        params![dimension, modality],
    )?;

    tx.commit()?;

    Ok(deleted_segments)
}

/// 检查是否有正在索引的 units 使用了指定维度
///
/// S8 fix: 删除维度前检查，避免产生孤儿向量数据
pub fn has_indexing_units_for_dimension(
    conn: &Connection,
    dimension: i32,
    modality: &str,
) -> Result<bool, VfsError> {
    let is_multimodal = modality == "multimodal";
    let count: i64 = if is_multimodal {
        conn.query_row(
            "SELECT COUNT(*) FROM vfs_index_units
             WHERE mm_state = 'indexing' AND EXISTS (
                 SELECT 1 FROM vfs_index_segments
                 WHERE vfs_index_segments.unit_id = vfs_index_units.id
                 AND vfs_index_segments.embedding_dim = ?1
                 AND vfs_index_segments.modality = ?2
             )",
            params![dimension, modality],
            |row| row.get(0),
        )?
    } else {
        conn.query_row(
            "SELECT COUNT(*) FROM vfs_index_units
             WHERE text_state = 'indexing' AND EXISTS (
                 SELECT 1 FROM vfs_index_segments
                 WHERE vfs_index_segments.unit_id = vfs_index_units.id
                 AND vfs_index_segments.embedding_dim = ?1
                 AND vfs_index_segments.modality = ?2
             )",
            params![dimension, modality],
            |row| row.get(0),
        )?
    };

    // 也检查 embedding_dim 匹配但还没有 segments 的 indexing units
    let count2: i64 = if is_multimodal {
        conn.query_row(
            "SELECT COUNT(*) FROM vfs_index_units
             WHERE mm_state = 'indexing' AND mm_embedding_dim = ?1",
            params![dimension],
            |row| row.get(0),
        )?
    } else {
        conn.query_row(
            "SELECT COUNT(*) FROM vfs_index_units
             WHERE text_state = 'indexing' AND text_embedding_dim = ?1",
            params![dimension],
            |row| row.get(0),
        )?
    };

    Ok(count > 0 || count2 > 0)
}

/// 获取所有 LanceDB 表名
pub fn list_lance_table_names(conn: &Connection) -> Result<Vec<String>, VfsError> {
    let mut stmt = conn.prepare("SELECT lance_table_name FROM vfs_embedding_dims")?;
    let names = stmt
        .query_map([], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(names)
}

/// 更新维度的模型绑定
pub fn update_model_binding(
    conn: &Connection,
    dimension: i32,
    modality: &str,
    model_config_id: &str,
    model_name: &str,
) -> Result<bool, VfsError> {
    if get_by_key(conn, dimension, modality)?.is_none() {
        return Ok(false);
    }
    register_with_model(
        conn,
        dimension,
        modality,
        Some(model_config_id),
        Some(model_name),
    )?;
    Ok(true)
}

/// M1 fix: 清除维度的模型绑定（设为 NULL）
///
/// 用于显式解绑模型，与 register_with_model 的 COALESCE 行为互补。
pub fn clear_model_binding(
    conn: &Connection,
    dimension: i32,
    modality: &str,
) -> Result<bool, VfsError> {
    if let Some(existing) = get_by_key(conn, dimension, modality)? {
        if existing.record_count > 0 {
            return Err(VfsError::InvalidArgument {
                param: "model_config_id".to_string(),
                reason: "Cannot clear a model binding while the vector space contains rows; rebuild or delete the dimension first".to_string(),
            });
        }
    }
    let now = now_ms();
    let rows = conn.execute(
        "UPDATE vfs_embedding_dims SET
            model_config_id = NULL,
            model_name = NULL,
            last_used_at = ?3
        WHERE dimension = ?1 AND modality = ?2",
        params![dimension, modality, now],
    )?;
    Ok(rows > 0)
}

/// 按模型配置 ID 查询维度
pub fn list_by_model(
    conn: &Connection,
    model_config_id: &str,
) -> Result<Vec<VfsEmbeddingDim>, VfsError> {
    let mut stmt = conn.prepare(
        "SELECT * FROM vfs_embedding_dims WHERE model_config_id = ?1 ORDER BY modality, dimension",
    )?;
    let dims = stmt
        .query_map(params![model_config_id], row_to_dim)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(dims)
}

/// 查询所有有模型绑定的维度（用于跨维度检索）
pub fn list_with_model_binding(conn: &Connection) -> Result<Vec<VfsEmbeddingDim>, VfsError> {
    let mut stmt = conn.prepare(
        "SELECT * FROM vfs_embedding_dims WHERE model_config_id IS NOT NULL AND record_count > 0 ORDER BY modality, dimension"
    )?;
    let dims = stmt
        .query_map([], row_to_dim)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(dims)
}

/// 根据资源从 Segments 统计并更新所有维度的 record_count
///
/// ★ 审计修复：仅在 record_count > 0 时更新 last_used_at，
/// 避免空维度的 last_used_at 被无意义地刷新
pub fn refresh_counts_from_segments(conn: &Connection) -> Result<(), VfsError> {
    let now = now_ms();

    // 更新所有维度的 record_count，仅在有数据时更新 last_used_at
    conn.execute(
        "UPDATE vfs_embedding_dims SET
            record_count = (
                SELECT COUNT(*) FROM vfs_index_segments
                WHERE vfs_index_segments.modality = vfs_embedding_dims.modality
                AND vfs_index_segments.embedding_dim = vfs_embedding_dims.dimension
            ),
            last_used_at = CASE
                WHEN (
                    SELECT COUNT(*) FROM vfs_index_segments
                    WHERE vfs_index_segments.modality = vfs_embedding_dims.modality
                    AND vfs_index_segments.embedding_dim = vfs_embedding_dims.dimension
                ) > 0 THEN ?1
                ELSE last_used_at
            END",
        params![now],
    )?;

    let committed_manifest_exists = "EXISTS (
            SELECT 1
            FROM vfs_index_segments s
            JOIN vfs_index_units u ON u.id = s.unit_id
            WHERE s.index_profile_id = vfs_index_profiles.id
              AND (
                  (vfs_index_profiles.modality = 'text'
                   AND s.modality = 'text'
                   AND u.text_profile_id = s.index_profile_id
                   AND u.text_generation = s.generation)
                  OR
                  (vfs_index_profiles.modality IN ('image', 'multimodal')
                   AND s.modality IN ('image', 'multimodal')
                   AND u.mm_profile_id = s.index_profile_id
                   AND u.mm_generation = s.generation)
              )
        )";
    conn.execute(
        &format!(
            "UPDATE vfs_index_profiles
             SET state = 'retired', updated_at = ?1
             WHERE state = 'queryable'
               AND NOT {committed_manifest_exists}
               AND NOT EXISTS (
                   SELECT 1 FROM vfs_embedding_dims d
                   WHERE d.active_profile_id = vfs_index_profiles.id
               )"
        ),
        params![now],
    )?;
    conn.execute(
        &format!(
            "UPDATE vfs_index_profiles
             SET state = 'active', updated_at = ?1
             WHERE state = 'building'
               AND {committed_manifest_exists}"
        ),
        params![now],
    )?;

    Ok(())
}

// ============================================================================
// 单元测试
// ============================================================================
#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::{params, Connection};

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("Failed to create in-memory database");
        conn.execute(
            r#"
            CREATE TABLE vfs_index_units (
                id TEXT PRIMARY KEY,
                text_state TEXT NOT NULL,
                text_embedding_dim INTEGER,
                mm_state TEXT NOT NULL,
                mm_embedding_dim INTEGER
            )
            "#,
            [],
        )
        .expect("Failed to create vfs_index_units table");
        conn.execute(
            r#"
            CREATE TABLE vfs_index_segments (
                id TEXT PRIMARY KEY,
                unit_id TEXT NOT NULL,
                modality TEXT NOT NULL,
                embedding_dim INTEGER NOT NULL
            )
            "#,
            [],
        )
        .expect("Failed to create vfs_index_segments table");
        conn
    }

    #[test]
    fn test_has_indexing_units_for_dimension_text() {
        let conn = setup_test_db();
        conn.execute(
            "INSERT INTO vfs_index_units (id, text_state, text_embedding_dim, mm_state, mm_embedding_dim)
             VALUES ('unit_text', 'indexing', NULL, 'disabled', NULL)",
            [],
        )
        .expect("Failed to insert text unit");
        conn.execute(
            "INSERT INTO vfs_index_segments (id, unit_id, modality, embedding_dim)
             VALUES ('seg_text', 'unit_text', 'text', 512)",
            [],
        )
        .expect("Failed to insert text segment");

        let has_text = has_indexing_units_for_dimension(&conn, 512, "text")
            .expect("Failed to query text indexing units");
        let has_mm = has_indexing_units_for_dimension(&conn, 512, "multimodal")
            .expect("Failed to query multimodal indexing units");

        assert!(has_text, "text indexing should be detected");
        assert!(
            !has_mm,
            "multimodal indexing should not be detected for text-only units"
        );
    }

    #[test]
    fn test_has_indexing_units_for_dimension_multimodal() {
        let conn = setup_test_db();
        conn.execute(
            "INSERT INTO vfs_index_units (id, text_state, text_embedding_dim, mm_state, mm_embedding_dim)
             VALUES ('unit_mm', 'disabled', NULL, 'indexing', NULL)",
            [],
        )
        .expect("Failed to insert multimodal unit");
        conn.execute(
            "INSERT INTO vfs_index_segments (id, unit_id, modality, embedding_dim)
             VALUES ('seg_mm', 'unit_mm', 'multimodal', 1024)",
            [],
        )
        .expect("Failed to insert multimodal segment");

        let has_mm = has_indexing_units_for_dimension(&conn, 1024, "multimodal")
            .expect("Failed to query multimodal indexing units");
        let has_text = has_indexing_units_for_dimension(&conn, 1024, "text")
            .expect("Failed to query text indexing units");

        assert!(has_mm, "multimodal indexing should be detected");
        assert!(
            !has_text,
            "text indexing should not be detected for multimodal-only units"
        );
    }

    #[test]
    fn model_name_change_rolls_profiles_without_a_query_gap() {
        let (_temp, db) = crate::vfs::database::setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let now = now_ms();

        let first =
            register_with_model(&conn, 768, "text", Some("cfg_same"), Some("model-a")).unwrap();
        let first_profile_id = first.active_profile_id.unwrap();
        conn.execute(
            "INSERT INTO resources
             (id, hash, type, storage_mode, data, ref_count, index_state, created_at, updated_at)
             VALUES ('res_profile_roll', 'hash_profile_roll', 'note', 'inline', 'text', 0, 'indexed', ?1, ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO vfs_index_units
             (id, resource_id, unit_index, text_content, text_required, text_state,
              text_embedding_dim, text_profile_id, text_generation, created_at, updated_at)
             VALUES ('unit_profile_roll', 'res_profile_roll', 0, 'text', 1, 'indexed',
                     768, ?1, 1, ?2, ?2)",
            params![first_profile_id, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO vfs_index_segments
             (id, unit_id, segment_index, modality, embedding_dim, lance_row_id,
              index_profile_id, generation, created_at, updated_at)
             VALUES ('seg_profile_old', 'unit_profile_roll', 0, 'text', 768,
                     'emb_profile_old', ?1, 1, ?2, ?2)",
            params![first_profile_id, now],
        )
        .unwrap();
        refresh_counts_from_segments(&conn).unwrap();
        conn.execute(
            "UPDATE vfs_embedding_dims SET record_count = 0
             WHERE dimension = 768 AND modality = 'text'",
            [],
        )
        .unwrap();

        let second =
            register_with_model(&conn, 768, "text", Some("cfg_same"), Some("model-b")).unwrap();
        let second_profile_id = second.active_profile_id.unwrap();
        assert_ne!(first_profile_id, second_profile_id);
        assert_ne!(
            model_fingerprint("cfg_same", "model-a", "text-embedding-v1"),
            model_fingerprint("cfg_same", "model-b", "text-embedding-v1")
        );
        assert_eq!(
            get_profile_by_id(&conn, &first_profile_id)
                .unwrap()
                .unwrap()
                .state,
            "queryable"
        );
        assert_eq!(
            get_profile_by_id(&conn, &second_profile_id)
                .unwrap()
                .unwrap()
                .state,
            "building"
        );
        let pending: (String, i32, i64) = conn
            .query_row(
                "SELECT index_state, index_retry_count, index_next_retry_at
                 FROM resources WHERE id = 'res_profile_roll'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(pending, ("pending".to_string(), 0, 0));

        conn.execute(
            "UPDATE vfs_index_units SET text_profile_id = ?1, text_generation = 2
             WHERE id = 'unit_profile_roll'",
            params![second_profile_id],
        )
        .unwrap();
        conn.execute(
            "DELETE FROM vfs_index_segments WHERE id = 'seg_profile_old'",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO vfs_index_segments
             (id, unit_id, segment_index, modality, embedding_dim, lance_row_id,
              index_profile_id, generation, created_at, updated_at)
             VALUES ('seg_profile_new', 'unit_profile_roll', 0, 'text', 768,
                     'emb_profile_new', ?1, 2, ?2, ?2)",
            params![second_profile_id, now],
        )
        .unwrap();
        refresh_counts_from_segments(&conn).unwrap();
        assert_eq!(
            get_profile_by_id(&conn, &first_profile_id)
                .unwrap()
                .unwrap()
                .state,
            "retired"
        );
        assert_eq!(
            get_profile_by_id(&conn, &second_profile_id)
                .unwrap()
                .unwrap()
                .state,
            "active"
        );
    }

    #[test]
    fn legacy_profile_registration_without_override_creates_a_new_space() {
        let (_temp, db) = crate::vfs::database::setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let now = now_ms();
        let legacy = register_with_model(
            &conn,
            768,
            "text",
            Some("cfg-legacy-direct"),
            Some("Legacy display name"),
        )
        .unwrap();
        let legacy_profile_id = legacy.active_profile_id.unwrap();
        conn.execute(
            "INSERT INTO resources
             (id, hash, type, storage_mode, data, ref_count, index_state, created_at, updated_at)
             VALUES ('res_legacy_direct', 'hash_legacy_direct', 'note', 'inline', 'text',
                     0, 'indexed', ?1, ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO vfs_index_units
             (id, resource_id, unit_index, text_content, text_required, text_state,
              text_embedding_dim, text_profile_id, text_generation, created_at, updated_at)
             VALUES ('unit_legacy_direct', 'res_legacy_direct', 0, 'text', 1, 'indexed',
                     768, ?1, 1, ?2, ?2)",
            params![legacy_profile_id, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO vfs_index_segments
             (id, unit_id, segment_index, modality, embedding_dim, lance_row_id,
              index_profile_id, generation, created_at, updated_at)
             VALUES ('seg_legacy_direct', 'unit_legacy_direct', 0, 'text', 768,
                     'emb_legacy_direct', ?1, 1, ?2, ?2)",
            params![legacy_profile_id, now],
        )
        .unwrap();
        refresh_counts_from_segments(&conn).unwrap();
        conn.execute(
            "UPDATE vfs_embedding_dims
             SET model_fingerprint = 'legacy:model-config:cfg-legacy-direct',
                 model_name = 'Provider - model-real'
             WHERE dimension = 768 AND modality = 'text'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE vfs_index_profiles
             SET model_fingerprint = 'legacy:model-config:cfg-legacy-direct',
                 model_name = 'Provider - model-real'
             WHERE id = ?1",
            params![legacy_profile_id],
        )
        .unwrap();

        let strong = register_with_model(
            &conn,
            768,
            "text",
            Some("cfg-legacy-direct"),
            Some("model-real"),
        )
        .unwrap();
        let strong_profile_id = strong.active_profile_id.unwrap();
        let strong_fingerprint =
            model_fingerprint("cfg-legacy-direct", "model-real", "text-embedding-v1");

        assert_ne!(strong_profile_id, legacy_profile_id);
        assert_ne!(strong.lance_table_name, legacy.lance_table_name);
        assert_eq!(
            strong.model_fingerprint.as_deref(),
            Some(strong_fingerprint.as_str())
        );
        let old_profile = get_profile_by_id(&conn, &legacy_profile_id)
            .unwrap()
            .unwrap();
        let new_profile = get_profile_by_id(&conn, &strong_profile_id)
            .unwrap()
            .unwrap();
        assert_eq!(
            old_profile.model_fingerprint,
            "legacy:model-config:cfg-legacy-direct"
        );
        assert_eq!(old_profile.state, "queryable");
        assert_eq!(new_profile.state, "building");

        let active_binding: (String, String) = conn
            .query_row(
                "SELECT active_profile_id, model_fingerprint
                 FROM vfs_embedding_dims
                 WHERE dimension = 768 AND modality = 'text'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(active_binding, (strong_profile_id, strong_fingerprint));
        let pending: (String, String) = conn
            .query_row(
                "SELECT u.text_state, r.index_state
                 FROM vfs_index_units u
                 JOIN resources r ON r.id = u.resource_id
                 WHERE u.id = 'unit_legacy_direct'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(pending, ("pending".to_string(), "pending".to_string()));
    }

    #[test]
    fn assigned_unit_without_committed_manifest_rebuilds_without_queryable_old_profile() {
        let (_temp, db) = crate::vfs::database::setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let now = now_ms();
        let first =
            register_with_model(&conn, 768, "text", Some("cfg-empty-a"), Some("model-a")).unwrap();
        let first_profile_id = first.active_profile_id.unwrap();
        conn.execute(
            "INSERT INTO resources
             (id, hash, type, storage_mode, data, ref_count, index_state, created_at, updated_at)
             VALUES ('res_empty_manifest', 'hash_empty_manifest', 'note', 'inline', 'text',
                     0, 'indexed', ?1, ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO vfs_index_units
             (id, resource_id, unit_index, text_content, text_required, text_state,
              text_embedding_dim, text_profile_id, text_generation, created_at, updated_at)
             VALUES ('unit_empty_manifest', 'res_empty_manifest', 0, 'text', 1, 'indexed',
                     768, ?1, 3, ?2, ?2)",
            params![first_profile_id, now],
        )
        .unwrap();

        let second =
            register_with_model(&conn, 768, "text", Some("cfg-empty-b"), Some("model-b")).unwrap();
        let second_profile_id = second.active_profile_id.unwrap();
        assert_eq!(
            get_profile_by_id(&conn, &first_profile_id)
                .unwrap()
                .unwrap()
                .state,
            "retired"
        );
        assert_eq!(
            get_profile_by_id(&conn, &second_profile_id)
                .unwrap()
                .unwrap()
                .state,
            "active"
        );
        let unit_state: String = conn
            .query_row(
                "SELECT text_state FROM vfs_index_units WHERE id = 'unit_empty_manifest'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let resource_state: String = conn
            .query_row(
                "SELECT index_state FROM resources WHERE id = 'res_empty_manifest'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(unit_state, "pending");
        assert_eq!(resource_state, "pending");
    }

    #[test]
    fn profile_activation_requires_committed_unit_generation_manifest() {
        let (_temp, db) = crate::vfs::database::setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let now = now_ms();
        let first = register_with_model(
            &conn,
            768,
            "text",
            Some("cfg-generation-a"),
            Some("model-a"),
        )
        .unwrap();
        let first_profile_id = first.active_profile_id.unwrap();
        conn.execute(
            "INSERT INTO resources
             (id, hash, type, storage_mode, data, ref_count, index_state, created_at, updated_at)
             VALUES ('res_generation_manifest', 'hash_generation_manifest', 'note', 'inline',
                     'text', 0, 'indexed', ?1, ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO vfs_index_units
             (id, resource_id, unit_index, text_content, text_required, text_state,
              text_embedding_dim, text_profile_id, text_generation, created_at, updated_at)
             VALUES ('unit_generation_manifest', 'res_generation_manifest', 0, 'text', 1,
                     'indexed', 768, ?1, 2, ?2, ?2)",
            params![first_profile_id, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO vfs_index_segments
             (id, unit_id, segment_index, modality, embedding_dim, lance_row_id,
              index_profile_id, generation, created_at, updated_at)
             VALUES ('seg_generation_old', 'unit_generation_manifest', 0, 'text', 768,
                     'emb_generation_old', ?1, 2, ?2, ?2)",
            params![first_profile_id, now],
        )
        .unwrap();

        let second = register_with_model(
            &conn,
            768,
            "text",
            Some("cfg-generation-b"),
            Some("model-b"),
        )
        .unwrap();
        let second_profile_id = second.active_profile_id.unwrap();
        assert_eq!(
            get_profile_by_id(&conn, &second_profile_id)
                .unwrap()
                .unwrap()
                .state,
            "building"
        );

        conn.execute(
            "INSERT INTO vfs_index_segments
             (id, unit_id, segment_index, modality, embedding_dim, lance_row_id,
              index_profile_id, generation, created_at, updated_at)
             VALUES ('seg_generation_stale', 'unit_generation_manifest', 1, 'text', 768,
                     'emb_generation_stale', ?1, 1, ?2, ?2)",
            params![second_profile_id, now],
        )
        .unwrap();
        conn.execute(
            "UPDATE vfs_index_units
             SET text_profile_id = ?1, text_generation = 2
             WHERE id = 'unit_generation_manifest'",
            params![second_profile_id],
        )
        .unwrap();
        refresh_counts_from_segments(&conn).unwrap();
        assert_eq!(
            get_profile_by_id(&conn, &second_profile_id)
                .unwrap()
                .unwrap()
                .state,
            "building"
        );
        assert!(activate_profile(&conn, &second_profile_id, 1).is_err());

        conn.execute(
            "INSERT INTO vfs_index_segments
             (id, unit_id, segment_index, modality, embedding_dim, lance_row_id,
              index_profile_id, generation, created_at, updated_at)
             VALUES ('seg_generation_current', 'unit_generation_manifest', 2, 'text', 768,
                     'emb_generation_current', ?1, 2, ?2, ?2)",
            params![second_profile_id, now],
        )
        .unwrap();
        refresh_counts_from_segments(&conn).unwrap();
        assert_eq!(
            get_profile_by_id(&conn, &second_profile_id)
                .unwrap()
                .unwrap()
                .state,
            "active"
        );
        activate_profile(&conn, &second_profile_id, 1).unwrap();
    }

    #[test]
    fn profile_identity_includes_dimension_and_registration_is_atomic() {
        let (_temp, db) = crate::vfs::database::setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let fingerprint = model_fingerprint("cfg-shared", "model-shared", "text-embedding-v1");
        let first = register_with_model_fingerprint(
            &conn,
            768,
            "text",
            Some("cfg-shared"),
            Some("model-shared"),
            Some(&fingerprint),
        )
        .unwrap();
        let second = register_with_model_fingerprint(
            &conn,
            1024,
            "text",
            Some("cfg-shared"),
            Some("model-shared"),
            Some(&fingerprint),
        )
        .unwrap();
        assert_ne!(first.active_profile_id, second.active_profile_id);
        assert_ne!(first.lance_table_name, second.lance_table_name);

        let first_profile_id = first.active_profile_id.unwrap();
        conn.execute_batch(
            "CREATE TRIGGER reject_profile_switch
             BEFORE UPDATE OF active_profile_id ON vfs_embedding_dims
             WHEN OLD.dimension = 768 AND NEW.model_name = 'model-rejected'
             BEGIN SELECT RAISE(ABORT, 'reject profile switch'); END;",
        )
        .unwrap();
        let rejected = register_with_model(
            &conn,
            768,
            "text",
            Some("cfg-rejected"),
            Some("model-rejected"),
        );
        assert!(rejected.is_err());
        let current = get_by_key(&conn, 768, "text").unwrap().unwrap();
        assert_eq!(
            current.active_profile_id.as_deref(),
            Some(first_profile_id.as_str())
        );
        assert_eq!(current.model_name.as_deref(), Some("model-shared"));
        assert_eq!(
            get_profile_by_id(&conn, &first_profile_id)
                .unwrap()
                .unwrap()
                .state,
            "active"
        );
        let rejected_profiles: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM vfs_index_profiles WHERE model_config_id = 'cfg-rejected'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rejected_profiles, 0);
    }

    #[test]
    fn endpoint_change_rolls_profile_without_hashing_secrets() {
        let mut first_config = crate::llm_manager::ApiConfig {
            id: "cfg_transport".to_string(),
            model: "embed-model".to_string(),
            name: "Display name".to_string(),
            base_url: "https://user:secret@example.com/v1/?api_key=hidden".to_string(),
            provider_type: Some("openai-compatible".to_string()),
            provider_scope: Some("custom".to_string()),
            api_protocol: Some("openai".to_string()),
            model_adapter: "openai".to_string(),
            api_key: "first-secret".to_string(),
            enabled: true,
            is_embedding: true,
            ..Default::default()
        };
        let first_fingerprint = model_fingerprint_for_config(&first_config, "text").unwrap();
        first_config.api_key = "rotated-secret".to_string();
        first_config.headers = Some(std::collections::HashMap::from([(
            "Authorization".to_string(),
            "Bearer another-secret".to_string(),
        )]));
        assert_eq!(
            model_fingerprint_for_config(&first_config, "text").unwrap(),
            first_fingerprint,
            "credentials and headers must not affect vector-space identity"
        );

        let mut second_config = first_config.clone();
        second_config.base_url = "https://example.net/v1".to_string();
        let second_fingerprint = model_fingerprint_for_config(&second_config, "text").unwrap();
        assert_ne!(first_fingerprint, second_fingerprint);

        let (_temp, db) = crate::vfs::database::setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let first = register_with_model_fingerprint(
            &conn,
            768,
            "text",
            Some(&first_config.id),
            Some(&first_config.model),
            Some(&first_fingerprint),
        )
        .unwrap();
        let first_profile = first.active_profile_id.unwrap();
        let second = register_with_model_fingerprint(
            &conn,
            768,
            "text",
            Some(&second_config.id),
            Some(&second_config.model),
            Some(&second_fingerprint),
        )
        .unwrap();
        let second_profile = second.active_profile_id.unwrap();
        assert_ne!(first_profile, second_profile);
        assert_eq!(
            get_profile_by_id(&conn, &first_profile)
                .unwrap()
                .unwrap()
                .state,
            "retired"
        );
    }

    // 不再基于未知维度进行阻断（避免全局删除受阻）
}
