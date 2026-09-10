//! Shared object, provenance, and delivery contracts for agent tasks.
//!
//! A model being able to see content is not the same as an executor being able
//! to operate on it. `TaskObjectHandle` keeps those concerns explicit across
//! chat attachments, browser downloads, MCP resources, and future connectors.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};

/// schema v2：`ObjectProvenance.derived_from` 由 `Vec<String>` 升级为
/// `Vec<DerivedEdge>`（带 transform_id / 参数指纹 / 观测时间）。
const TASK_OBJECT_SCHEMA_VERSION: u16 = 2;
/// 持久化的 v1 数据（derived_from 为字符串数组）仍可反序列化并通过校验。
const MIN_SUPPORTED_TASK_OBJECT_SCHEMA_VERSION: u16 = 1;

/// 旧格式 `derived_from` 字符串升级后的占位 transform 标识。
pub const LEGACY_DERIVED_TRANSFORM_ID: &str = "legacy_unknown";

/// 计算 transform 参数的确定性 sha256 指纹。
///
/// `params` 必须由调用方以 `serde_json::json!` 字面量显式构造（字段固定、
/// 顺序固定）。**严禁**把含 `HashMap` 的结构序列化后传入——HashMap 迭代序
/// 随机，同一内容哈希逐次不同（见项目 AGENTS.md 红线）。
pub fn hash_transform_params(params: &serde_json::Value) -> String {
    hex::encode(Sha256::digest(params.to_string().as_bytes()))
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskObjectKind {
    File,
    Folder,
    Message,
    Event,
    Record,
    Page,
    Artifact,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedLocator {
    pub root_id: String,
    pub relative_path: String,
}

impl ManagedLocator {
    pub fn new(
        root_id: impl Into<String>,
        relative_path: impl Into<String>,
    ) -> Result<Self, String> {
        let locator = Self {
            root_id: root_id.into(),
            relative_path: relative_path.into(),
        };
        locator.validate()?;
        Ok(locator)
    }

    pub fn validate(&self) -> Result<(), String> {
        let root = self.root_id.trim();
        if root.is_empty() || root.contains('/') || root.contains('\\') {
            return Err("root_id must be a non-empty runtime-root identifier".to_string());
        }

        let path = self.relative_path.trim();
        if path.is_empty() || path.starts_with('/') || path.starts_with('\\') {
            return Err("relative_path must be a non-empty relative path".to_string());
        }
        if path == "." {
            return Ok(());
        }
        if path.contains('\\') {
            return Err("relative_path must use forward slashes".to_string());
        }
        if path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err("relative_path contains an unsafe path segment".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderObjectRef {
    pub provider: String,
    pub external_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ObjectCapabilities {
    pub readable: bool,
    pub materializable: bool,
    pub writable: bool,
    pub shareable: bool,
    pub sendable: bool,
    pub deletable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ObjectAcl {
    pub access: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub principal_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_at: Option<String>,
}

/// 一条血缘边：本对象由哪个来源对象经哪次变换而来。
///
/// 序列化恒为 v2 对象格式；反序列化兼容 v1 纯字符串格式（自动升级为
/// `transform_id = legacy_unknown`、无参数指纹、空观测时间）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DerivedEdge {
    /// 来源标识：上游 handle_id / URL / VFS resource id / 运行时路径等。
    pub source_handle_id: String,
    /// 产生本对象的变换标识，如 `fetch.binary`、`xlsx.edit_cells`。
    pub transform_id: String,
    /// 变换参数的确定性 sha256（见 `hash_transform_params`）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transform_params_hash: Option<String>,
    pub observed_at: String,
}

impl DerivedEdge {
    pub fn new(source_handle_id: impl Into<String>, transform_id: impl Into<String>) -> Self {
        Self {
            source_handle_id: source_handle_id.into(),
            transform_id: transform_id.into(),
            transform_params_hash: None,
            observed_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    pub fn with_params_hash(mut self, hash: impl Into<String>) -> Self {
        self.transform_params_hash = Some(hash.into());
        self
    }

    pub fn observed_at(mut self, observed_at: impl Into<String>) -> Self {
        self.observed_at = observed_at.into();
        self
    }
}

impl<'de> Deserialize<'de> for DerivedEdge {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct DerivedEdgeV2 {
            source_handle_id: String,
            transform_id: String,
            #[serde(default)]
            transform_params_hash: Option<String>,
            #[serde(default)]
            observed_at: String,
        }

        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Wire {
            V2(DerivedEdgeV2),
            Legacy(String),
        }

        match Wire::deserialize(deserializer)? {
            Wire::V2(edge) => Ok(Self {
                source_handle_id: edge.source_handle_id,
                transform_id: edge.transform_id,
                transform_params_hash: edge.transform_params_hash,
                observed_at: edge.observed_at,
            }),
            Wire::Legacy(source) => Ok(Self {
                source_handle_id: source,
                transform_id: LEGACY_DERIVED_TRANSFORM_ID.to_string(),
                transform_params_hash: None,
                observed_at: String::new(),
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ObjectProvenance {
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub derived_from: Vec<DerivedEdge>,
    pub observed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskObjectHandle {
    pub schema_version: u16,
    pub handle_id: String,
    pub kind: TaskObjectKind,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locator: Option<ManagedLocator>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_ref: Option<ProviderObjectRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acl: Option<ObjectAcl>,
    pub capabilities: ObjectCapabilities,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    pub provenance: ObjectProvenance,
}

impl TaskObjectHandle {
    pub fn new(
        handle_id: impl Into<String>,
        kind: TaskObjectKind,
        display_name: impl Into<String>,
        provenance: ObjectProvenance,
    ) -> Self {
        Self {
            schema_version: TASK_OBJECT_SCHEMA_VERSION,
            handle_id: handle_id.into(),
            kind,
            display_name: display_name.into(),
            media_type: None,
            size_bytes: None,
            sha256: None,
            locator: None,
            provider_ref: None,
            acl: None,
            capabilities: ObjectCapabilities::default(),
            expires_at: None,
            provenance,
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        // v1（字符串 derived_from）与 v2（DerivedEdge）均可通过校验；
        // 拒绝未知的新版本与非法的 0。
        if self.schema_version < MIN_SUPPORTED_TASK_OBJECT_SCHEMA_VERSION
            || self.schema_version > TASK_OBJECT_SCHEMA_VERSION
        {
            return Err(format!(
                "unsupported task object schema version: {}",
                self.schema_version
            ));
        }
        if self.handle_id.trim().is_empty() || self.display_name.trim().is_empty() {
            return Err("handle_id and display_name are required".to_string());
        }
        if let Some(locator) = &self.locator {
            locator.validate()?;
        }
        if let Some(hash) = &self.sha256 {
            if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err("sha256 must be a 64-character hexadecimal digest".to_string());
            }
        }
        if self.capabilities.materializable && self.locator.is_none() {
            return Err("materializable objects require a managed locator".to_string());
        }
        Ok(())
    }
}

/// `TaskObjectHandle` 的统一构造入口（G11-P1）。
///
/// - `handle_id` / `kind` / `display_name` / `provenance.source` 为必填；
/// - 血缘必须显式：调用 `derived_edge(s)` 填来源，或 `origin_unknown(reason)`
///   声明无来源（落 debug log），否则 `build()` 报错；
/// - `build()` 内部调用 `TaskObjectHandle::validate()`。
#[derive(Debug, Clone)]
pub struct TaskObjectHandleBuilder {
    handle_id: String,
    kind: TaskObjectKind,
    display_name: String,
    source: String,
    source_uri: Option<String>,
    server: Option<String>,
    tool: Option<String>,
    derived_from: Option<Vec<DerivedEdge>>,
    origin_unknown_reason: Option<String>,
    media_type: Option<String>,
    size_bytes: Option<u64>,
    sha256: Option<String>,
    locator: Option<ManagedLocator>,
    provider_ref: Option<ProviderObjectRef>,
    acl: Option<ObjectAcl>,
    capabilities: ObjectCapabilities,
    expires_at: Option<String>,
    observed_at: Option<String>,
}

impl TaskObjectHandleBuilder {
    pub fn new(
        handle_id: impl Into<String>,
        kind: TaskObjectKind,
        display_name: impl Into<String>,
        source: impl Into<String>,
    ) -> Self {
        Self {
            handle_id: handle_id.into(),
            kind,
            display_name: display_name.into(),
            source: source.into(),
            source_uri: None,
            server: None,
            tool: None,
            derived_from: None,
            origin_unknown_reason: None,
            media_type: None,
            size_bytes: None,
            sha256: None,
            locator: None,
            provider_ref: None,
            acl: None,
            capabilities: ObjectCapabilities::default(),
            expires_at: None,
            observed_at: None,
        }
    }

    pub fn source_uri(mut self, value: Option<impl Into<String>>) -> Self {
        self.source_uri = value.map(Into::into);
        self
    }

    pub fn server(mut self, value: Option<impl Into<String>>) -> Self {
        self.server = value.map(Into::into);
        self
    }

    pub fn tool(mut self, value: Option<impl Into<String>>) -> Self {
        self.tool = value.map(Into::into);
        self
    }

    /// 追加一条血缘边（可多次调用）。
    pub fn derived_edge(mut self, edge: DerivedEdge) -> Self {
        self.derived_from.get_or_insert_with(Vec::new).push(edge);
        self
    }

    /// 一次性设置全部血缘边。
    pub fn derived_edges(mut self, edges: Vec<DerivedEdge>) -> Self {
        self.derived_from = Some(edges);
        self
    }

    /// 显式声明"无可靠来源"的逃生门：血缘留空并落 debug log。
    pub fn origin_unknown(mut self, reason: impl Into<String>) -> Self {
        self.origin_unknown_reason = Some(reason.into());
        self.derived_from = Some(Vec::new());
        self
    }

    pub fn media_type(mut self, value: Option<impl Into<String>>) -> Self {
        self.media_type = value.map(Into::into);
        self
    }

    pub fn size_bytes(mut self, value: Option<u64>) -> Self {
        self.size_bytes = value;
        self
    }

    pub fn sha256(mut self, value: Option<impl Into<String>>) -> Self {
        self.sha256 = value.map(Into::into);
        self
    }

    pub fn locator(mut self, value: Option<ManagedLocator>) -> Self {
        self.locator = value;
        self
    }

    pub fn provider_ref(mut self, value: Option<ProviderObjectRef>) -> Self {
        self.provider_ref = value;
        self
    }

    pub fn acl(mut self, value: Option<ObjectAcl>) -> Self {
        self.acl = value;
        self
    }

    pub fn capabilities(mut self, value: ObjectCapabilities) -> Self {
        self.capabilities = value;
        self
    }

    pub fn expires_at(mut self, value: Option<impl Into<String>>) -> Self {
        self.expires_at = value.map(Into::into);
        self
    }

    /// 缺省为 `build()` 时刻的 UTC now（与历史产出点行为一致）。
    pub fn observed_at(mut self, value: impl Into<String>) -> Self {
        self.observed_at = Some(value.into());
        self
    }

    pub fn build(self) -> Result<TaskObjectHandle, String> {
        let derived_from = match self.derived_from {
            Some(edges) => edges,
            None => {
                return Err(format!(
                    "derived_from lineage must be explicit for handle {} \
                     (use derived_edge(s) or origin_unknown)",
                    self.handle_id
                ))
            }
        };
        if let Some(reason) = &self.origin_unknown_reason {
            log::debug!(
                "[task_objects] handle {} built with origin_unknown lineage: {}",
                self.handle_id,
                reason
            );
        }
        let provenance = ObjectProvenance {
            source: self.source,
            source_uri: self.source_uri,
            server: self.server,
            tool: self.tool,
            derived_from,
            observed_at: self
                .observed_at
                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
        };
        let mut handle =
            TaskObjectHandle::new(self.handle_id, self.kind, self.display_name, provenance);
        handle.media_type = self.media_type;
        handle.size_bytes = self.size_bytes;
        handle.sha256 = self.sha256;
        handle.locator = self.locator;
        handle.provider_ref = self.provider_ref;
        handle.acl = self.acl;
        handle.capabilities = self.capabilities;
        handle.expires_at = self.expires_at;
        handle.validate()?;
        Ok(handle)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BatchItemStatus {
    Pending,
    Succeeded,
    Failed,
    Skipped,
    Compensated,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BatchManifestItem {
    pub item_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_handle_id: Option<String>,
    pub status: BatchItemStatus,
    pub attempts: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BatchManifest {
    pub manifest_id: String,
    pub expected_items: u64,
    pub observed_items: u64,
    pub coverage_complete: bool,
    pub truncated: bool,
    pub items: Vec<BatchManifestItem>,
}

impl BatchManifest {
    pub fn can_claim_complete_success(&self) -> bool {
        self.coverage_complete
            && !self.truncated
            && self.observed_items == self.expected_items
            && self.items.len() as u64 == self.expected_items
            && self
                .items
                .iter()
                .all(|item| item.status == BatchItemStatus::Succeeded)
    }
}

// ============================================================================
// 分页语料清单（G11-P2：CorpusManifest）
// ============================================================================
//
// 附件/资料超过单次携带上限时产出完整分页清单，绝不静默丢弃第 N 个文件：
// - `total_count` 在创建时钉定（接受时的全量对象数；G07-b BatchCoverage
//   可直接消费作「处理全部文件」的验收分母）；
// - 重复引用按 handle_id 去重并保留 `ref_count`；同名不同内容文件、多版本
//   云对象的 handle_id 各不相同，各自独立成条、绝不合并；
// - 清单建成后不可变（内容寻址快照语义）：成员句柄内嵌 sha256，源文件中途
//   修改只会产生新句柄，不影响既有页；
// - 清单自身物化为 artifacts root 下的 JSON 文件，经 G05-P2
//   `read_task_object_page`（PTC object_read，白名单仅含 artifacts）分页回读
//   任意页；成员对象经各自 locator 读取（如 temp root 走 workspace_file_read）。

/// CorpusManifest 当前 schema 版本。
pub const CORPUS_MANIFEST_SCHEMA_VERSION: u16 = 1;

/// 清单条目：对象句柄 + 引用计数。
///
/// 同一对象被重复引用（同 handle_id）时去重为单条，`ref_count` 累计引用
/// 次数——「重复引用不错误合并」指不丢计数，而非保留多份拷贝。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CorpusManifestEntry {
    pub handle: TaskObjectHandle,
    pub ref_count: u32,
}

/// 清单单页。`page_no` 从 1 开始连续编号；仅末页可不满 `page_size`。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CorpusManifestPage {
    pub page_no: u32,
    pub object_handles: Vec<CorpusManifestEntry>,
}

/// 分页语料清单：一次性钉定全量对象成员，供上下文只携带第一页时
/// 仍能对「全部文件」负责。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CorpusManifest {
    pub schema_version: u16,
    pub manifest_id: String,
    /// 去重后的对象总数（= 全页条目数之和），创建时钉定、之后不漂移。
    /// 输入引用总数 = 各条目 `ref_count` 之和。
    pub total_count: u64,
    pub page_size: u32,
    pub pages: Vec<CorpusManifestPage>,
    pub created_at: String,
    pub source_session_id: String,
}

impl CorpusManifest {
    /// 从有序句柄列表构建分页清单：按 handle_id 去重（保留 ref_count，
    /// 条目顺序 = 首次出现序），再按 `page_size` 连续切片分页。
    ///
    /// 去重索引用 HashMap 仅作查找，产出与序列化只含顺序 Vec——不涉及
    /// HashMap 迭代序（见项目 AGENTS.md 红线）。
    pub fn build(
        manifest_id: impl Into<String>,
        source_session_id: impl Into<String>,
        handles: Vec<TaskObjectHandle>,
        page_size: u32,
    ) -> Result<Self, String> {
        if page_size == 0 {
            return Err("page_size must be positive".to_string());
        }

        let mut index_by_handle_id: HashMap<String, usize> = HashMap::new();
        let mut entries: Vec<CorpusManifestEntry> = Vec::new();
        for handle in handles {
            handle.validate()?;
            let handle_id = handle.handle_id.clone();
            if let Some(&index) = index_by_handle_id.get(&handle_id) {
                entries[index].ref_count = entries[index]
                    .ref_count
                    .checked_add(1)
                    .ok_or_else(|| format!("ref_count overflow for handle '{handle_id}'"))?;
                continue;
            }
            index_by_handle_id.insert(handle_id, entries.len());
            entries.push(CorpusManifestEntry {
                handle,
                ref_count: 1,
            });
        }

        let total_count = entries.len() as u64;
        let pages: Vec<CorpusManifestPage> = entries
            .chunks(page_size as usize)
            .enumerate()
            .map(|(index, chunk)| CorpusManifestPage {
                page_no: (index + 1) as u32,
                object_handles: chunk.to_vec(),
            })
            .collect();

        let manifest = Self {
            schema_version: CORPUS_MANIFEST_SCHEMA_VERSION,
            manifest_id: manifest_id.into(),
            total_count,
            page_size,
            pages,
            created_at: chrono::Utc::now().to_rfc3339(),
            source_session_id: source_session_id.into(),
        };
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != CORPUS_MANIFEST_SCHEMA_VERSION {
            return Err(format!(
                "unsupported corpus manifest schema version: {}",
                self.schema_version
            ));
        }
        if self.manifest_id.trim().is_empty() {
            return Err("manifest_id is required".to_string());
        }
        if self.page_size == 0 {
            return Err("page_size must be positive".to_string());
        }
        let page_size = self.page_size as usize;
        let mut counted = 0u64;
        let mut seen: HashSet<&str> = HashSet::new();
        for (index, page) in self.pages.iter().enumerate() {
            if page.page_no as usize != index + 1 {
                return Err(format!(
                    "page_no must be sequential from 1 (page index {} has page_no {})",
                    index, page.page_no
                ));
            }
            if page.object_handles.is_empty() {
                return Err(format!("page {} is empty", page.page_no));
            }
            if page.object_handles.len() > page_size {
                return Err(format!(
                    "page {} exceeds page_size {}",
                    page.page_no, self.page_size
                ));
            }
            if index + 1 != self.pages.len() && page.object_handles.len() != page_size {
                return Err(format!("non-final page {} must be full", page.page_no));
            }
            for entry in &page.object_handles {
                if entry.ref_count == 0 {
                    return Err(format!(
                        "entry '{}' has ref_count 0",
                        entry.handle.handle_id
                    ));
                }
                if !seen.insert(entry.handle.handle_id.as_str()) {
                    return Err(format!(
                        "duplicate handle '{}' across pages",
                        entry.handle.handle_id
                    ));
                }
                counted += 1;
            }
        }
        if counted != self.total_count {
            return Err(format!(
                "total_count {} does not match {} listed entries",
                self.total_count, counted
            ));
        }
        Ok(())
    }

    /// 模型可见告知文本：第一批已进上下文 + 完整清单的分页回读指引 +
    /// 固定验收分母。`carried_count` 为本次实际随上下文携带的条目数
    /// （通常 = 第一页大小），`locator` 为清单自身的物化位置。
    pub fn model_notice(&self, carried_count: usize, locator: &ManagedLocator) -> String {
        format!(
            "本次接受 {total} 个文件对象（重复引用已按 handle 去重并保留 refCount），超出单次携带上限 {page_size}，已启用分页语料清单：\n\
             - 第 1 页 {carried} 个对象已物化并随 <attachment_metadata> 进入上下文，可直接处理；\n\
             - 完整清单 {manifest_id} 共 {pages} 页（每页 ≤ {page_size} 项），物化于 {root}:{path}；\
             用 object_read 分页回读清单可获得任意成员的 rootId/relativePath/sha256；\n\
             - 全部成员已物化到会话受管 root（locator 见清单条目），取得路径后可用 workspace_file_read 或 local_shell_execute 按需处理；\n\
             - 「处理全部文件」的验收分母固定为 totalCount={total}（接受时钉定），逐项核对，不得遗漏，不得因同名或重复引用而错误合并。",
            total = self.total_count,
            page_size = self.page_size,
            carried = carried_count,
            manifest_id = self.manifest_id,
            pages = self.pages.len(),
            root = locator.root_id,
            path = locator.relative_path,
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OperationState {
    Draft,
    Confirmed,
    Committed,
    Failed,
    Compensated,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorOperationReceipt {
    pub operation_id: String,
    pub idempotency_key: String,
    pub provider: String,
    pub action: String,
    pub state: OperationState,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub object_handle_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recipient_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
    pub irreversible: bool,
    pub preview_sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub committed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ConnectorOperationReceipt {
    pub fn confirm(&mut self, observed_preview_sha256: &str) -> Result<(), String> {
        if self.state != OperationState::Draft {
            return Err("only a draft operation can be confirmed".to_string());
        }
        if observed_preview_sha256 != self.preview_sha256 {
            return Err(
                "operation preview changed; review the latest target and payload".to_string(),
            );
        }
        self.state = OperationState::Confirmed;
        Ok(())
    }

    pub fn commit(&mut self, committed_at: impl Into<String>) -> Result<(), String> {
        if self.state != OperationState::Confirmed {
            return Err("operation must be confirmed before commit".to_string());
        }
        self.state = OperationState::Committed;
        self.committed_at = Some(committed_at.into());
        Ok(())
    }
}

// ============================================================================
// 物化对象分页回读（G05-P2 追加；只新增读取 API，不改既有逻辑）
// ============================================================================
//
// PTC `object_read` 宿主函数的读取原语：把 "locator → 受管 root 内文件的一页
// 字节" 做成纯函数（不依赖 AppHandle / 数据库，便于单测与其他宿主复用）。
// 安全边界（fail-closed）：
// - root_id 白名单 [`OBJECT_READABLE_ROOT_IDS`]：仅 artifacts 类会话受管根可读；
// - locator 段级校验（无 `..` / 绝对路径 / 反斜杠）之外，落盘前对 root 与目标
//   双侧 canonicalize 并做前缀检查，符号链接逃逸同样拒绝；
// - 单页 ≤ [`OBJECT_READ_PAGE_MAX_BYTES`]；整文件 sha256 供调用方校验分页拼接
//   完整性——只哈希文件字节，不涉及任何 HashMap 序列化（见 AGENTS.md 红线）。

/// object_read 可读的受管 root 白名单（仅 artifacts 类会话受管根）。
pub const OBJECT_READABLE_ROOT_IDS: &[&str] = &["artifacts"];

/// object_read 单页字节上限（32 KiB）。
pub const OBJECT_READ_PAGE_MAX_BYTES: u64 = 32 * 1024;

/// 物化对象的一页内容（序列化键与 PTC `object_read` 脚本侧契约一致）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TaskObjectPage {
    /// 文本页为 UTF-8 字符串；二进制页为 base64（`encoding` 标记区分）。
    pub content: String,
    /// `"utf-8"` | `"base64"`。
    pub encoding: String,
    /// 本页起始字节偏移（越界请求收敛为 `total_size`）。
    pub offset: u64,
    /// 下一页起始字节偏移。文本页按 UTF-8 字符边界收敛，可能小于
    /// `offset + limit`；逐页拼接即得原文。
    pub next_offset: u64,
    pub total_size: u64,
    pub eof: bool,
    /// 整文件字节的 sha256（hex）。
    pub sha256: String,
}

/// 读取受管对象的一页字节。
///
/// `root_dir` 是 `locator.root_id` 对应的运行时根（调用方负责解析；本函数
/// 内部会重新 canonicalize 并校验目标解析在 root 内）。`offset`/`limit`
/// 为字节语义；`limit` 超 [`OBJECT_READ_PAGE_MAX_BYTES`] 自动收敛。
/// `offset >= total_size` 返回空页 + `eof=true`（便于循环终止），其余非法
/// 输入（白名单外 root / 路径逃逸 / 非文件 / UTF-8 切半字符的 offset）报错。
pub fn read_task_object_page(
    root_dir: &Path,
    locator: &ManagedLocator,
    offset: u64,
    limit: u64,
) -> Result<TaskObjectPage, String> {
    if !OBJECT_READABLE_ROOT_IDS.contains(&locator.root_id.as_str()) {
        return Err(format!(
            "root_id '{}' is not object-readable (allowed: {})",
            locator.root_id,
            OBJECT_READABLE_ROOT_IDS.join(", ")
        ));
    }
    // 防御纵深：反序列化/手工构造的 locator 未必走过 ManagedLocator::new。
    locator.validate()?;
    if limit == 0 {
        return Err("limit must be positive".to_string());
    }
    let limit = limit.min(OBJECT_READ_PAGE_MAX_BYTES);

    // 段级归一（validate 已拒绝 `..` / 绝对路径 / 反斜杠；此处再挡一层）。
    let mut relative = PathBuf::new();
    for component in Path::new(&locator.relative_path).components() {
        match component {
            std::path::Component::Normal(part) => relative.push(part),
            std::path::Component::CurDir => {}
            _ => return Err("relative_path escapes the managed root".to_string()),
        }
    }
    if relative.as_os_str().is_empty() {
        return Err("relative_path does not identify a file".to_string());
    }

    // 双侧 canonicalize：root 不存在/目标不存在/符号链接逃逸全部 fail-closed。
    let root_canon = root_dir
        .canonicalize()
        .map_err(|e| format!("managed root '{}' is unavailable: {e}", locator.root_id))?;
    let file_canon = root_canon
        .join(&relative)
        .canonicalize()
        .map_err(|e| format!("object '{}' is not readable: {e}", locator.relative_path))?;
    if !file_canon.starts_with(&root_canon) {
        return Err("object path escapes the managed root".to_string());
    }
    if !file_canon.is_file() {
        return Err(format!("object '{}' is not a file", locator.relative_path));
    }

    let bytes = std::fs::read(&file_canon)
        .map_err(|e| format!("failed to read object '{}': {e}", locator.relative_path))?;
    let total_size = bytes.len() as u64;
    let sha256 = hex::encode(Sha256::digest(&bytes));
    let is_text = std::str::from_utf8(&bytes).is_ok();
    let encoding = if is_text { "utf-8" } else { "base64" }.to_string();

    if offset >= total_size {
        return Ok(TaskObjectPage {
            content: String::new(),
            encoding,
            offset: total_size,
            next_offset: total_size,
            total_size,
            eof: true,
            sha256,
        });
    }

    let mut end = (offset + limit).min(total_size);
    if is_text {
        // 文本不切半字符。offset 必须落在字符边界（脚本应沿用上一页的
        // next_offset）；end 回退到边界（UTF-8 续字节形如 0b10xx_xxxx；
        // end == total_size 即文件尾，天然是边界，不得索引 bytes[end]）。
        if (bytes[offset as usize] & 0b1100_0000) == 0b1000_0000 {
            return Err(
                "offset splits a UTF-8 character; use next_offset from the previous page"
                    .to_string(),
            );
        }
        while end > offset && end < total_size && (bytes[end as usize] & 0b1100_0000) == 0b1000_0000
        {
            end -= 1;
        }
        if end == offset {
            // 单个字符比 limit 还宽：放行完整字符（最多超 3 字节），保证翻页必前进。
            end = offset + 1;
            while end < total_size && (bytes[end as usize] & 0b1100_0000) == 0b1000_0000 {
                end += 1;
            }
        }
        let content = String::from_utf8(bytes[offset as usize..end as usize].to_vec())
            .map_err(|_| "internal error: page slice is not valid UTF-8".to_string())?;
        Ok(TaskObjectPage {
            content,
            encoding,
            offset,
            next_offset: end,
            total_size,
            eof: end >= total_size,
            sha256,
        })
    } else {
        use base64::Engine as _;
        let content =
            base64::engine::general_purpose::STANDARD.encode(&bytes[offset as usize..end as usize]);
        Ok(TaskObjectPage {
            content,
            encoding,
            offset,
            next_offset: end,
            total_size,
            eof: end >= total_size,
            sha256,
        })
    }
}

// ============================================================================
// 受管对象写入（G05-P3：object_write 的四层路径安全原语）
// ============================================================================
//
// 与 `read_task_object_page` 同一安全姿势：
// - root_id 白名单 [`OBJECT_WRITABLE_ROOT_IDS`]：仅 artifacts 类会话受管根可写；
// - locator 段级校验 + 双侧 canonicalize 前缀检查（父目录与已存在目标分别
//   校验，符号链接逃逸 fail-closed）；
// - `expected_sha256` 乐观锁：目标已存在且指纹不匹配时拒绝（防并发覆盖）；
// - 单次写入内容 ≤ [`OBJECT_WRITE_MAX_BYTES`]；只哈希文件字节，不涉及任何
//   HashMap 序列化（见 AGENTS.md 红线）。

/// object_write 可写的受管 root 白名单（仅 artifacts 类会话受管根）。
pub const OBJECT_WRITABLE_ROOT_IDS: &[&str] = &["artifacts"];

/// 单次 object_write 内容字节上限（256 KiB）。
pub const OBJECT_WRITE_MAX_BYTES: u64 = 256 * 1024;

/// 一次受管写入的结果（序列化键与 PTC `object_write` 脚本侧契约一致）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TaskObjectWriteOutcome {
    /// 写入后整文件字节的 sha256（hex）。
    pub sha256: String,
    /// 写入后整文件字节数。
    pub total_size: u64,
    /// 本次写入的内容字节数。
    pub written_bytes: u64,
    /// 目标是否由本次写入新建。
    pub created: bool,
}

/// 受管写入一个对象（pwrite 语义）。
///
/// `root_dir` 是 `locator.root_id` 对应的运行时根（调用方负责解析；本函数
/// 内部在写入前重新 canonicalize 并校验目标解析在 root 内——root 尚不存在
/// 时先创建，因为写入面本来就允许产生副作用）。`offset=None` 整体覆盖/新建；
/// `offset=Some(n)` 从第 n 字节起原地覆盖（n 不得超过现有长度；内容越过
/// 文件尾则文件增长）。`expected_sha256` 乐观锁仅对已存在的目标生效——
/// 传入时目标必须存在且指纹匹配，否则拒绝（防并发覆盖/内容漂移）。
pub fn write_task_object_page(
    root_dir: &Path,
    locator: &ManagedLocator,
    content: &[u8],
    offset: Option<u64>,
    expected_sha256: Option<&str>,
) -> Result<TaskObjectWriteOutcome, String> {
    if !OBJECT_WRITABLE_ROOT_IDS.contains(&locator.root_id.as_str()) {
        return Err(format!(
            "root_id '{}' is not object-writable (allowed: {})",
            locator.root_id,
            OBJECT_WRITABLE_ROOT_IDS.join(", ")
        ));
    }
    // 防御纵深：反序列化/手工构造的 locator 未必走过 ManagedLocator::new。
    locator.validate()?;
    if content.len() as u64 > OBJECT_WRITE_MAX_BYTES {
        return Err(format!(
            "content is {} bytes, exceeding the {} byte write cap",
            content.len(),
            OBJECT_WRITE_MAX_BYTES
        ));
    }

    // 段级归一（与读侧相同：拒绝 `..` / 绝对路径 / 反斜杠 / 纯 `.`）。
    let mut relative = PathBuf::new();
    for component in Path::new(&locator.relative_path).components() {
        match component {
            std::path::Component::Normal(part) => relative.push(part),
            std::path::Component::CurDir => {}
            _ => return Err("relative_path escapes the managed root".to_string()),
        }
    }
    if relative.as_os_str().is_empty() {
        return Err("relative_path does not identify a file".to_string());
    }

    // root 可不存在（写入面允许创建），先建再 canonicalize。
    std::fs::create_dir_all(root_dir)
        .map_err(|e| format!("managed root '{}' is unavailable: {e}", locator.root_id))?;
    let root_canon = root_dir
        .canonicalize()
        .map_err(|e| format!("managed root '{}' is unavailable: {e}", locator.root_id))?;

    // 父目录：创建后经 canonicalize + 前缀校验（符号链接逃逸 fail-closed）。
    let target_rel = root_canon.join(&relative);
    let parent = target_rel
        .parent()
        .ok_or_else(|| "relative_path does not identify a file".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("failed to create parent directory: {e}"))?;
    let parent_canon = parent
        .canonicalize()
        .map_err(|e| format!("parent directory is unavailable: {e}"))?;
    if !parent_canon.starts_with(&root_canon) {
        return Err("object path escapes the managed root".to_string());
    }
    let file_name = target_rel
        .file_name()
        .ok_or_else(|| "relative_path does not identify a file".to_string())?;
    let target = parent_canon.join(file_name);

    // 目标已存在：再 canonicalize 一层（挡父目录内符号链接），乐观锁校验。
    let existed = target.exists();
    let mut current: Vec<u8> = Vec::new();
    if existed {
        let target_canon = target
            .canonicalize()
            .map_err(|e| format!("object '{}' is unavailable: {e}", locator.relative_path))?;
        if !target_canon.starts_with(&root_canon) {
            return Err("object path escapes the managed root".to_string());
        }
        if !target_canon.is_file() {
            return Err(format!("object '{}' is not a file", locator.relative_path));
        }
        current = std::fs::read(&target_canon)
            .map_err(|e| format!("failed to read object '{}': {e}", locator.relative_path))?;
        if let Some(expected) = expected_sha256 {
            let actual = hex::encode(Sha256::digest(&current));
            if actual != expected {
                return Err(format!(
                    "expected_sha256 mismatch for '{}': content changed since it was read \
                     (expected {expected}, actual {actual}); re-read and retry",
                    locator.relative_path
                ));
            }
        }
    } else if expected_sha256.is_some() {
        return Err(format!(
            "expected_sha256 given but object '{}' does not exist",
            locator.relative_path
        ));
    }

    // pwrite 语义组装新内容。
    let next: Vec<u8> = match offset {
        None => content.to_vec(),
        Some(at) => {
            if at > current.len() as u64 {
                return Err(format!(
                    "offset {at} exceeds current size {}; append with offset=size \
                     or overwrite with offset=None",
                    current.len()
                ));
            }
            let at = at as usize;
            let mut buf = Vec::with_capacity(at + content.len().max(current.len() - at));
            buf.extend_from_slice(&current[..at]);
            buf.extend_from_slice(content);
            let tail_start = (at + content.len()).min(current.len());
            buf.extend_from_slice(&current[tail_start..]);
            buf
        }
    };

    // 原子落盘：tmp + rename（与物化结果同一姿势）。
    let tmp = parent_canon.join(format!(
        ".{}.ptc-write-{}.tmp",
        file_name.to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    std::fs::write(&tmp, &next).map_err(|e| format!("failed to write object: {e}"))?;
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("failed to finalize object write: {e}"));
    }

    Ok(TaskObjectWriteOutcome {
        sha256: hex::encode(Sha256::digest(&next)),
        total_size: next.len() as u64,
        written_bytes: content.len() as u64,
        created: !existed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provenance() -> ObjectProvenance {
        ObjectProvenance {
            source: "chat_attachment".to_string(),
            source_uri: None,
            server: None,
            tool: None,
            derived_from: Vec::new(),
            observed_at: "2026-07-19T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn managed_locator_rejects_escape_and_absolute_paths() {
        assert!(ManagedLocator::new("temp", "attachments/image.png").is_ok());
        assert!(ManagedLocator::new("temp", "../secret").is_err());
        assert!(ManagedLocator::new("temp", "/etc/passwd").is_err());
        assert!(ManagedLocator::new("temp", "a\\b.txt").is_err());
    }

    #[test]
    fn materializable_handle_requires_managed_locator() {
        let mut handle =
            TaskObjectHandle::new("obj_1", TaskObjectKind::File, "image.png", provenance());
        handle.capabilities.materializable = true;
        assert!(handle.validate().is_err());
        handle.locator = Some(ManagedLocator::new("temp", "attachments/image.png").unwrap());
        assert!(handle.validate().is_ok());
    }

    #[test]
    fn incomplete_batch_cannot_claim_complete_success() {
        let manifest = BatchManifest {
            manifest_id: "batch_1".to_string(),
            expected_items: 2,
            observed_items: 1,
            coverage_complete: false,
            truncated: true,
            items: vec![BatchManifestItem {
                item_id: "one".to_string(),
                object_handle_id: None,
                status: BatchItemStatus::Succeeded,
                attempts: 1,
                error: None,
            }],
        };
        assert!(!manifest.can_claim_complete_success());
    }

    #[test]
    fn connector_commit_requires_matching_preview_confirmation() {
        let mut receipt = ConnectorOperationReceipt {
            operation_id: "op_1".to_string(),
            idempotency_key: "idem_1".to_string(),
            provider: "mail".to_string(),
            action: "send".to_string(),
            state: OperationState::Draft,
            object_handle_ids: vec!["obj_1".to_string()],
            recipient_ids: vec!["user@example.com".to_string()],
            destination: None,
            irreversible: true,
            preview_sha256: "a".repeat(64),
            committed_at: None,
            error: None,
        };
        assert!(receipt.commit("2026-07-19T00:00:00Z").is_err());
        assert!(receipt.confirm(&"b".repeat(64)).is_err());
        receipt.confirm(&"a".repeat(64)).unwrap();
        receipt.commit("2026-07-19T00:00:00Z").unwrap();
        assert_eq!(receipt.state, OperationState::Committed);
    }

    #[test]
    fn derived_edge_serializes_v2_and_reads_legacy_string() {
        let edge = DerivedEdge::new("obj_src", "fetch.binary")
            .with_params_hash("ab".repeat(32))
            .observed_at("2026-09-07T00:00:00Z");
        let value = serde_json::to_value(&edge).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "sourceHandleId": "obj_src",
                "transformId": "fetch.binary",
                "transformParamsHash": "ab".repeat(32),
                "observedAt": "2026-09-07T00:00:00Z",
            })
        );
        // v2 对象 roundtrip
        let parsed: DerivedEdge = serde_json::from_value(value).unwrap();
        assert_eq!(parsed, edge);
        // v1 纯字符串自动升级为 legacy_unknown
        let legacy: DerivedEdge = serde_json::from_value(serde_json::json!("obj_src")).unwrap();
        assert_eq!(legacy.source_handle_id, "obj_src");
        assert_eq!(legacy.transform_id, LEGACY_DERIVED_TRANSFORM_ID);
        assert_eq!(legacy.transform_params_hash, None);
        assert!(legacy.observed_at.is_empty());
    }

    #[test]
    fn schema_v1_handle_with_string_lineage_still_validates() {
        let legacy_json = serde_json::json!({
            "schemaVersion": 1,
            "handleId": "obj_old",
            "kind": "file",
            "displayName": "old.png",
            "capabilities": {
                "readable": true,
                "materializable": false,
                "writable": false,
                "shareable": false,
                "sendable": false,
                "deletable": false,
            },
            "provenance": {
                "source": "url_download",
                "derivedFrom": ["https://example.com/a.png"],
                "observedAt": "2026-07-19T00:00:00Z",
            },
        });
        let handle: TaskObjectHandle = serde_json::from_value(legacy_json).unwrap();
        assert_eq!(handle.schema_version, 1);
        assert_eq!(handle.provenance.derived_from.len(), 1);
        assert_eq!(
            handle.provenance.derived_from[0].transform_id,
            LEGACY_DERIVED_TRANSFORM_ID
        );
        assert!(handle.validate().is_ok());
        // 未来版本仍被拒绝
        let mut future = handle.clone();
        future.schema_version = TASK_OBJECT_SCHEMA_VERSION + 1;
        assert!(future.validate().is_err());
    }

    #[test]
    fn builder_requires_explicit_lineage() {
        let result =
            TaskObjectHandleBuilder::new("obj_1", TaskObjectKind::File, "a.png", "test").build();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("derived_from"));
    }

    #[test]
    fn builder_origin_unknown_builds_with_empty_lineage() {
        let handle = TaskObjectHandleBuilder::new("obj_1", TaskObjectKind::File, "a.png", "test")
            .origin_unknown("test_no_referrer")
            .build()
            .unwrap();
        assert!(handle.provenance.derived_from.is_empty());
        assert_eq!(handle.schema_version, TASK_OBJECT_SCHEMA_VERSION);
    }

    #[test]
    fn builder_build_runs_validation() {
        // 非法 sha256 必须被 validate 拦截
        let result = TaskObjectHandleBuilder::new("obj_1", TaskObjectKind::File, "a.png", "test")
            .derived_edge(DerivedEdge::new("src", "test.op"))
            .sha256(Some("not-a-hash"))
            .build();
        assert!(result.is_err());
        // 合法构造
        let handle = TaskObjectHandleBuilder::new("obj_1", TaskObjectKind::File, "a.png", "test")
            .derived_edge(
                DerivedEdge::new("src", "test.op")
                    .with_params_hash(hash_transform_params(&serde_json::json!({"k": "v"}))),
            )
            .sha256(Some("a".repeat(64)))
            .build()
            .unwrap();
        assert_eq!(handle.provenance.derived_from.len(), 1);
        assert_eq!(handle.provenance.derived_from[0].transform_id, "test.op");
        assert!(handle.provenance.derived_from[0]
            .transform_params_hash
            .is_some());
    }

    // —— G05-P2 分页回读（read_task_object_page）——

    fn paged_locator(root_id: &str, relative_path: &str) -> ManagedLocator {
        ManagedLocator::new(root_id, relative_path).expect("locator")
    }

    #[test]
    fn read_page_multi_page_concat_matches_original_and_sha256() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let mut text = String::new();
        for i in 0..200 {
            text.push_str(&format!("第{i}行：深度学习与程序合成 αβγ🦀\n"));
        }
        std::fs::write(dir.path().join("big.txt"), &text).expect("write");
        let locator = paged_locator("artifacts", "big.txt");

        let mut joined = String::new();
        let mut offset = 0;
        let mut pages = 0;
        let sha = loop {
            let page = read_task_object_page(dir.path(), &locator, offset, 4096).expect("page");
            assert_eq!(page.offset, offset);
            joined.push_str(&page.content);
            offset = page.next_offset;
            pages += 1;
            if page.eof {
                break page.sha256;
            }
        };
        assert_eq!(joined, text);
        assert_eq!(sha, hex::encode(Sha256::digest(text.as_bytes())));
        assert!(pages >= 3, "expected multiple pages, got {pages}");
        // 文本页全部 UTF-8（天然成立：String），且每页 ≤ limit 字节
        // （末页除外语义无限制，仅校验单调前进）。
    }

    #[test]
    fn read_page_rejects_foreign_roots_and_escapes() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        std::fs::write(dir.path().join("f.txt"), "safe").expect("write");
        // root 白名单
        for root_id in ["temp", "workspace", "skill:x"] {
            let err = read_task_object_page(dir.path(), &paged_locator(root_id, "f.txt"), 0, 100)
                .unwrap_err();
            assert!(err.contains("not object-readable"), "unexpected: {err}");
        }
        // 段级逃逸（绕过 new 的校验直接构造，验证内部防御纵深）
        let escape = ManagedLocator {
            root_id: "artifacts".to_string(),
            relative_path: "../outside.txt".to_string(),
        };
        let err = read_task_object_page(dir.path(), &escape, 0, 100).unwrap_err();
        assert!(err.contains("unsafe path segment"), "unexpected: {err}");
        let absolute = ManagedLocator {
            root_id: "artifacts".to_string(),
            relative_path: "/etc/passwd".to_string(),
        };
        assert!(read_task_object_page(dir.path(), &absolute, 0, 100).is_err());
        // 目录而非文件
        std::fs::create_dir(dir.path().join("subdir")).expect("mkdir");
        let err = read_task_object_page(dir.path(), &paged_locator("artifacts", "subdir"), 0, 100)
            .unwrap_err();
        assert!(err.contains("not a file"), "unexpected: {err}");
        // 不存在
        assert!(
            read_task_object_page(dir.path(), &paged_locator("artifacts", "nope.txt"), 0, 100)
                .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn read_page_rejects_symlink_escape() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let outside = tempfile::NamedTempFile::new().expect("outside file");
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link.txt")).expect("symlink");
        let err =
            read_task_object_page(dir.path(), &paged_locator("artifacts", "link.txt"), 0, 100)
                .unwrap_err();
        assert!(
            err.contains("escapes the managed root"),
            "unexpected: {err}"
        );
    }

    #[test]
    fn read_page_utf8_boundary_and_progress_guarantee() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let text = "汉".repeat(10); // 30 字节，每字 3 字节
        std::fs::write(dir.path().join("han.txt"), &text).expect("write");
        let locator = paged_locator("artifacts", "han.txt");

        // limit=7 落在第 3 字中间：页收敛为 2 字（6 字节），next_offset=6
        let page = read_task_object_page(dir.path(), &locator, 0, 7).expect("page");
        assert_eq!(page.content, "汉汉");
        assert_eq!(page.next_offset, 6);
        assert!(!page.eof);
        // offset 切半字符 → 结构化错误
        let err = read_task_object_page(dir.path(), &locator, 1, 7).unwrap_err();
        assert!(
            err.contains("splits a UTF-8 character"),
            "unexpected: {err}"
        );
        // limit=1 小于单字宽度：放行完整字符保证前进
        let page = read_task_object_page(dir.path(), &locator, 0, 1).expect("page");
        assert_eq!(page.content, "汉");
        assert_eq!(page.next_offset, 3);
    }

    #[test]
    fn read_page_binary_returns_base64() {
        use base64::Engine as _;
        let dir = tempfile::TempDir::new().expect("temp dir");
        let mut bytes = vec![0xFF, 0xFE, 0x00, 0x01];
        bytes.extend_from_slice(&[7u8; 200]);
        std::fs::write(dir.path().join("bin.dat"), &bytes).expect("write");
        let locator = paged_locator("artifacts", "bin.dat");

        let page = read_task_object_page(dir.path(), &locator, 0, 100).expect("page");
        assert_eq!(page.encoding, "base64");
        assert_eq!(page.next_offset, 100);
        assert!(!page.eof);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&page.content)
            .expect("base64");
        assert_eq!(decoded, bytes[..100]);
        assert_eq!(page.sha256, hex::encode(Sha256::digest(&bytes)));
        // limit 超 32KB 收敛
        let page = read_task_object_page(dir.path(), &locator, 0, 999_999).expect("page");
        assert!(page.eof);
        assert_eq!(page.next_offset, bytes.len() as u64);
    }

    #[test]
    fn read_page_offset_edges_and_empty_file() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        std::fs::write(dir.path().join("a.txt"), "hello").expect("write");
        std::fs::write(dir.path().join("empty.txt"), "").expect("write");

        let locator = paged_locator("artifacts", "a.txt");
        for offset in [5, 99] {
            let page = read_task_object_page(dir.path(), &locator, offset, 10).expect("page");
            assert!(page.eof);
            assert_eq!(page.content, "");
            assert_eq!(page.offset, 5);
            assert_eq!(page.next_offset, 5);
            assert_eq!(page.total_size, 5);
        }
        let empty = paged_locator("artifacts", "empty.txt");
        let page = read_task_object_page(dir.path(), &empty, 0, 10).expect("page");
        assert!(page.eof);
        assert_eq!(page.total_size, 0);
        assert_eq!(page.encoding, "utf-8");
        // limit=0 拒绝
        assert!(read_task_object_page(dir.path(), &locator, 0, 0).is_err());
    }

    // —— G11-P2 分页语料清单（CorpusManifest）——

    /// 构造内容寻址风格的成员句柄：`sha_fill` 必须是合法 hex 字符。
    fn corpus_handle(handle_id: &str, display_name: &str, sha_fill: char) -> TaskObjectHandle {
        TaskObjectHandleBuilder::new(
            handle_id,
            TaskObjectKind::File,
            display_name,
            "chat_context_ref",
        )
        .tool(Some("send_time_attachment_stage"))
        .derived_edge(DerivedEdge::new("res_1", "attachment.stage_context"))
        .sha256(Some(sha_fill.to_string().repeat(64)))
        .build()
        .expect("corpus member handle")
    }

    fn distinct_corpus_handles(count: usize) -> Vec<TaskObjectHandle> {
        const HEX: &[u8] = b"0123456789abcdef";
        (1..=count)
            .map(|i| {
                corpus_handle(
                    &format!("attachment:src_{i}:{}", "0".repeat(8)),
                    &format!("file_{i}.bin"),
                    HEX[i % HEX.len()] as char,
                )
            })
            .collect()
    }

    #[test]
    fn corpus_manifest_paginates_without_dropping_any_file() {
        // 25 个文件、page_size 20 → 2 页（20 + 5），第 21 个起全部在清单中
        let manifest =
            CorpusManifest::build("corpus_test", "sess_1", distinct_corpus_handles(25), 20)
                .expect("build");
        assert_eq!(manifest.total_count, 25);
        assert_eq!(manifest.page_size, 20);
        assert_eq!(manifest.pages.len(), 2);
        assert_eq!(manifest.pages[0].page_no, 1);
        assert_eq!(manifest.pages[0].object_handles.len(), 20);
        assert_eq!(manifest.pages[1].page_no, 2);
        assert_eq!(manifest.pages[1].object_handles.len(), 5);
        // 第 21 个文件（首个超出页）确实在第二页
        assert_eq!(
            manifest.pages[1].object_handles[0].handle.handle_id,
            "attachment:src_21:00000000"
        );
        // 全量 handle_id 无一丢失、无一重复
        let all: HashSet<&str> = manifest
            .pages
            .iter()
            .flat_map(|page| page.object_handles.iter())
            .map(|entry| entry.handle.handle_id.as_str())
            .collect();
        assert_eq!(all.len(), 25);
        manifest.validate().expect("valid");

        // serde roundtrip + camelCase 键
        let value = serde_json::to_value(&manifest).unwrap();
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["totalCount"], 25);
        assert_eq!(value["pageSize"], 20);
        assert_eq!(value["pages"][0]["pageNo"], 1);
        assert_eq!(
            value["pages"][0]["objectHandles"][0]["refCount"],
            serde_json::json!(1)
        );
        assert!(value.get("createdAt").is_some());
        assert_eq!(value["sourceSessionId"], "sess_1");
        let parsed: CorpusManifest = serde_json::from_value(value).unwrap();
        assert_eq!(parsed, manifest);
    }

    #[test]
    fn corpus_manifest_keeps_same_name_files_as_distinct_entries() {
        // 同名不同内容：handle_id/sha 不同 → 各自独立成条，绝不合并
        let first = corpus_handle("attachment:src_a:aa", "报告.pdf", 'a');
        let second = corpus_handle("attachment:src_b:bb", "报告.pdf", 'b');
        let manifest =
            CorpusManifest::build("corpus_test", "sess_1", vec![first, second], 20).unwrap();
        assert_eq!(manifest.total_count, 2);
        let entries = &manifest.pages[0].object_handles;
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].handle.display_name, "报告.pdf");
        assert_eq!(entries[1].handle.display_name, "报告.pdf");
        assert_ne!(
            entries[0].handle.handle_id, entries[1].handle.handle_id,
            "same-name files must not be merged"
        );
        assert!(entries.iter().all(|entry| entry.ref_count == 1));
    }

    #[test]
    fn corpus_manifest_dedupes_repeated_refs_and_keeps_ref_count() {
        let dup = || corpus_handle("attachment:src_a:aa", "a.bin", 'a');
        let manifest = CorpusManifest::build(
            "corpus_test",
            "sess_1",
            vec![
                dup(),
                corpus_handle("attachment:src_b:bb", "b.bin", 'b'),
                dup(),
                dup(),
            ],
            20,
        )
        .unwrap();
        assert_eq!(manifest.total_count, 2, "去重后对象数");
        let entries = &manifest.pages[0].object_handles;
        // 顺序 = 首次出现序；重复引用保留计数
        assert_eq!(entries[0].handle.handle_id, "attachment:src_a:aa");
        assert_eq!(entries[0].ref_count, 3);
        assert_eq!(entries[1].handle.handle_id, "attachment:src_b:bb");
        assert_eq!(entries[1].ref_count, 1);
        // 引用总数 = 接受时的输入数
        let ref_sum: u64 = manifest
            .pages
            .iter()
            .flat_map(|page| page.object_handles.iter())
            .map(|entry| entry.ref_count as u64)
            .sum();
        assert_eq!(ref_sum, 4);
    }

    #[test]
    fn corpus_manifest_notice_states_totals_and_readback_path() {
        let manifest =
            CorpusManifest::build("corpus_abc", "sess_1", distinct_corpus_handles(21), 20).unwrap();
        let locator = ManagedLocator::new("artifacts", "corpus/corpus_abc.json").unwrap();
        let notice = manifest.model_notice(20, &locator);
        assert!(notice.contains("21"), "{notice}");
        assert!(notice.contains("第 1 页 20"), "{notice}");
        assert!(notice.contains("corpus_abc"), "{notice}");
        assert!(notice.contains("共 2 页"), "{notice}");
        assert!(
            notice.contains("artifacts:corpus/corpus_abc.json"),
            "{notice}"
        );
        assert!(notice.contains("object_read"), "{notice}");
        assert!(notice.contains("totalCount=21"), "{notice}");
        assert!(notice.contains("分母"), "{notice}");
    }

    #[test]
    fn corpus_manifest_pages_are_snapshot_immutable_after_source_change() {
        // 内容寻址快照语义：源文件中途修改产生新句柄，既有页不受影响
        let v1 = corpus_handle("attachment:src_a:sha_v1", "a.bin", 'a');
        let manifest = CorpusManifest::build("corpus_abc", "sess_1", vec![v1], 20).unwrap();
        let before = serde_json::to_string(&manifest).unwrap();

        // 「修改后的源」是另一个句柄（sha 变化 → handle_id 变化）
        let v2 = corpus_handle("attachment:src_a:sha_v2", "a.bin", 'b');
        let after = serde_json::to_string(&manifest).unwrap();
        assert_eq!(before, after, "既有页不得随源变化");
        assert_eq!(
            manifest.pages[0].object_handles[0].handle.handle_id,
            "attachment:src_a:sha_v1"
        );
        assert!(after.contains("sha_v1"));
        assert!(!after.contains("sha_v2"));

        // 修改后的对象若被接受，进入新的清单，与旧清单各自独立
        let manifest2 = CorpusManifest::build("corpus_def", "sess_1", vec![v2], 20).unwrap();
        assert_eq!(
            manifest2.pages[0].object_handles[0].handle.handle_id,
            "attachment:src_a:sha_v2"
        );
        assert_ne!(manifest.manifest_id, manifest2.manifest_id);
    }

    #[test]
    fn corpus_manifest_validate_rejects_bad_shape() {
        // page_size = 0
        assert!(CorpusManifest::build("m", "s", vec![corpus_handle("h1", "a", 'a')], 0).is_err());
        // total_count 与全页条目数不符
        let mut manifest =
            CorpusManifest::build("m", "s", vec![corpus_handle("h1", "a", 'a')], 20).unwrap();
        manifest.total_count = 2;
        assert!(manifest.validate().is_err());
        // 未支持的新版本
        let mut future =
            CorpusManifest::build("m", "s", vec![corpus_handle("h1", "a", 'a')], 20).unwrap();
        future.schema_version = CORPUS_MANIFEST_SCHEMA_VERSION + 1;
        assert!(future.validate().is_err());

        let dup = corpus_handle("h1", "a", 'a');
        let entry = |handle: TaskObjectHandle| CorpusManifestEntry {
            handle,
            ref_count: 1,
        };
        // 跨页重复 handle（与第一页同 handle_id）
        let mut duplicated =
            CorpusManifest::build("m", "s", distinct_corpus_handles(2), 1).unwrap();
        let first_handle = duplicated.pages[0].object_handles[0].handle.clone();
        duplicated.pages[1].object_handles = vec![entry(first_handle)];
        assert!(duplicated.validate().is_err());
        // page_no 不连续
        let mut bad_no = CorpusManifest::build("m", "s", distinct_corpus_handles(2), 1).unwrap();
        bad_no.pages[1].page_no = 7;
        assert!(bad_no.validate().is_err());
        // 非末页不满（手工构造）
        let partial_first = CorpusManifest {
            schema_version: CORPUS_MANIFEST_SCHEMA_VERSION,
            manifest_id: "m".to_string(),
            total_count: 2,
            page_size: 2,
            pages: vec![
                CorpusManifestPage {
                    page_no: 1,
                    object_handles: vec![entry(dup.clone())],
                },
                CorpusManifestPage {
                    page_no: 2,
                    object_handles: vec![entry(corpus_handle("h2", "b", 'b'))],
                },
            ],
            created_at: "2026-09-08T00:00:00Z".to_string(),
            source_session_id: "s".to_string(),
        };
        assert!(partial_first.validate().is_err());
        // 空页
        let empty_page = CorpusManifest {
            pages: vec![CorpusManifestPage {
                page_no: 1,
                object_handles: Vec::new(),
            }],
            total_count: 0,
            ..partial_first
        };
        assert!(empty_page.validate().is_err());
    }

    // —— write_task_object_page（G05-P3）——

    #[test]
    fn write_page_create_overwrite_and_pwrite() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let locator = paged_locator("artifacts", "notes/out.txt");
        // 新建（父目录自动创建，root 由 TempDir 已存在）
        let out = write_task_object_page(dir.path(), &locator, b"hello world", None, None)
            .expect("create");
        assert!(out.created);
        assert_eq!(out.total_size, 11);
        assert_eq!(out.sha256, hex::encode(Sha256::digest(b"hello world")));
        // 整体覆盖
        let out =
            write_task_object_page(dir.path(), &locator, b"ABCDEF", None, None).expect("overwrite");
        assert!(!out.created);
        assert_eq!(
            std::fs::read(dir.path().join("notes/out.txt")).unwrap(),
            b"ABCDEF"
        );
        // pwrite：offset=2 覆盖 "CD" → "xy"，尾部 "EF" 保留
        let out =
            write_task_object_page(dir.path(), &locator, b"xy", Some(2), None).expect("pwrite");
        assert_eq!(out.written_bytes, 2);
        assert_eq!(
            std::fs::read(dir.path().join("notes/out.txt")).unwrap(),
            b"ABxyEF"
        );
        // pwrite 越过文件尾：文件增长
        let out =
            write_task_object_page(dir.path(), &locator, b"ZZZZ", Some(4), None).expect("extend");
        assert_eq!(out.total_size, 8);
        assert_eq!(
            std::fs::read(dir.path().join("notes/out.txt")).unwrap(),
            b"ABxyZZZZ"
        );
    }

    #[test]
    fn write_page_optimistic_lock_and_offset_bounds() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let locator = paged_locator("artifacts", "lock.txt");
        write_task_object_page(dir.path(), &locator, b"v1", None, None).unwrap();
        let sha_v1 = hex::encode(Sha256::digest(b"v1"));
        // 指纹匹配 → 放行
        write_task_object_page(dir.path(), &locator, b"v2", None, Some(&sha_v1)).unwrap();
        // 指纹过期 → 拒绝
        let err = write_task_object_page(dir.path(), &locator, b"v3", None, Some(&sha_v1))
            .expect_err("stale sha must be rejected");
        assert!(
            err.contains("expected_sha256 mismatch"),
            "unexpected: {err}"
        );
        // 目标不存在却给了乐观锁 → 拒绝
        let err = write_task_object_page(
            dir.path(),
            &paged_locator("artifacts", "ghost.txt"),
            b"x",
            None,
            Some(&sha_v1),
        )
        .expect_err("lock on missing file must be rejected");
        assert!(err.contains("does not exist"), "unexpected: {err}");
        // offset 越过当前长度 → 拒绝
        let err = write_task_object_page(dir.path(), &locator, b"x", Some(99), None)
            .expect_err("out-of-range offset must be rejected");
        assert!(err.contains("exceeds current size"), "unexpected: {err}");
        // 内容超上限 → 拒绝
        let big = vec![b'x'; (OBJECT_WRITE_MAX_BYTES + 1) as usize];
        assert!(write_task_object_page(dir.path(), &locator, &big, None, None).is_err());
    }

    #[test]
    fn write_page_rejects_foreign_roots_and_escapes() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        // 白名单外 root
        assert!(write_task_object_page(
            dir.path(),
            &paged_locator("temp", "a.txt"),
            b"x",
            None,
            None
        )
        .is_err());
        // ManagedLocator::new 段级校验已拒 `..`；手工构造绕过构造器的 locator
        // 也必须被防御纵深拦下
        let evil = ManagedLocator {
            root_id: "artifacts".to_string(),
            relative_path: "../evil.txt".to_string(),
        };
        let err = write_task_object_page(dir.path(), &evil, b"x", None, None)
            .expect_err("escape must be rejected");
        assert!(
            err.contains("unsafe path segment") || err.contains("escapes"),
            "unexpected: {err}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_page_rejects_symlink_escape() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let outside = tempfile::TempDir::new().expect("outside dir");
        std::fs::write(outside.path().join("victim.txt"), b"keep").unwrap();
        let link = dir.path().join("linked");
        std::os::unix::fs::symlink(outside.path(), &link).expect("symlink");
        let locator = paged_locator("artifacts", "linked/victim.txt");
        let err = write_task_object_page(dir.path(), &locator, b"pwned", None, None)
            .expect_err("symlink escape must be rejected");
        assert!(
            err.contains("escapes the managed root"),
            "unexpected: {err}"
        );
        // 目标原样未动
        assert_eq!(
            std::fs::read(outside.path().join("victim.txt")).unwrap(),
            b"keep"
        );
    }
}
