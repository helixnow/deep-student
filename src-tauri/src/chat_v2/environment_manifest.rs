//! G08：每任务环境清单（Environment Manifest）+ 漂移检测。
//!
//! # 目标（对标 G08 文档）
//!
//! 每个任务在开始时采集一份环境清单，回答"这个任务跑在什么环境里"：
//!
//! - **OS/架构**：`os` / `arch` / `family`（`std::env::consts`）；
//! - **应用与运行时**：`app_version`（`CARGO_PKG_VERSION`）、`tauri_version`
//!   （`tauri::VERSION`）、`rust_version`（`CARGO_PKG_RUST_VERSION`，Cargo.toml
//!   未声明 `rust-version` 时回退 `"unknown"`——编译期 `env!` 是唯一可靠
//!   来源，本模块不引入 build.rs 依赖）；
//! - **依赖锁/工具 schema**：`tool_schema_hash` —— G01-c `BUILTIN_DESCRIPTORS`
//!   全表的确定性指纹（见下文"指纹方案"）；
//! - **模型 / 技能 / 角色版本**：`model_id` / `skills_loaded`（id+version+hash）
//!   / `role_pack`，由采集调用方从会话上下文（`SendOptions`、
//!   `SessionSkillState`、`role_packs` 解析结果）取快照传入；
//! - **网络与工作目录身份**：`network_allowlist` 快照（shell/network 策略当前
//!   允许的主机/域名集合）与 `workspace_root_ids`（runtime_roots 授权根 id）。
//!
//! 验收语义："环境变化被检测，迁移后重跑有明确可重复边界"——
//! [`EnvironmentManifest::diff`] 做字段级漂移检测，
//! [`EnvironmentManifest::check_replay_compatibility`] 供 G09 回放/复验场景
//! 以 baseline 清单校验当前环境。漂移检测是**记录与显式告警**语义：
//! 本模块只产出 `Vec<EnvDrift>`，绝不阻断任务执行，告警/落盘由调用方决定。
//!
//! # 指纹方案（如何避开 HashMap 红线）
//!
//! AGENTS.md 明令禁止"对含 HashMap 字段的结构做 serde 序列化后哈希"
//! （HashMap 迭代序随机 → 同一内容哈希逐次不同）。本模块**不序列化任何
//! 结构做哈希**，改为显式字段拼接：
//!
//! - 工具表：[`BUILTIN_DESCRIPTORS`] 是编译期**有序静态数组**（非 HashMap，
//!   顺序即注册顺序，逐字节稳定）。[`tool_schema_fingerprint_for`] 把每条
//!   descriptor 的 8 个字段拼成一行定长格式（`name|sensitivity|read_only|…`），
//!   全表按数组序 join 后一次 sha256。枚举值经显式 `match` 映射到小写稳定
//!   码（不用 serde/Debug——前者受 serde 格式演进影响，后者语义上是调试
//!   输出）。新增枚举变体会让 `match` 编译失败，强制审查 hash 口径。
//! - 清单整体：[`EnvironmentManifest::content_fingerprint`] 同样逐字段拼行
//!   （`key=value` 每行一条，多值字段已按确定性序排序）后 sha256；
//!   `captured_at` **不参与**指纹（采集时刻本来就该不同）。
//!
//! # 采集接线点（本模块只交付机制，实际挂线在 pipeline/headless 侧）
//!
//! - `headless::run_headless_turn`：`ensure_headless_session` 之后、
//!   `execute_headless_pipeline` 之前（任务上下文确立点）；
//! - 交互管线：`pipeline` 构造 `PipelineContext` 处（`options.model_id` /
//!   会话 `SessionSkillState` / runtime_roots 解析结果均在此处可得）；
//! - 采集结果经 `task_audit::TaskAuditManifestBuilder::environment_manifest`
//!   挂进任务审计清单（全文留在 audit JSON 内，hash 同源记录——侵入最小，
//!   不落新表、不经 TaskObject）。
//!
//! # 托管运行时（Python/Node）版本
//!
//! 属 G08 文档后续项，本模块不采集；届时在 [`RuntimeIdentity`] 旁加字段即可，
//! 漂移字段同步扩 [`EnvDriftField`]。

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::tool_descriptors::{
    GrantsScopeHint, SideEffectClass, ToolDescriptor, BUILTIN_DESCRIPTORS,
};
use super::tools::ToolSensitivity;

/// 环境清单 schema 版本（结构演进时递增，diff 会将其报为结构性漂移）。
pub const ENVIRONMENT_MANIFEST_SCHEMA_VERSION: u16 = 1;

// ============================================================================
// 结构
// ============================================================================

/// OS/架构身份。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OsIdentity {
    /// `std::env::consts::OS`（如 `macos` / `linux` / `windows`）。
    pub os: String,
    /// `std::env::consts::ARCH`（如 `aarch64` / `x86_64`）。
    pub arch: String,
    /// `std::env::consts::FAMILY`（如 `unix` / `windows`）。
    pub family: String,
}

/// 运行时身份（编译期常量；托管 Python/Node 运行时为 G08 后续项，不在此列）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeIdentity {
    /// Tauri 框架版本（`tauri::VERSION`，即 tauri crate 编译期 `CARGO_PKG_VERSION`）。
    pub tauri_version: String,
    /// Rust toolchain 版本承诺（`CARGO_PKG_RUST_VERSION`；Cargo.toml 未声明
    /// `rust-version` 时为 `"unknown"`）。
    pub rust_version: String,
}

/// 一个已加载技能的确定性钉版条目。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillPin {
    /// 技能 id（目录名）。
    pub skill_id: String,
    /// 技能声明版本（SKILL.md / tap 目录解析值；无则 `None`）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// 技能内容 hash（安装/更新链路产出的 content hash；无则 `None`）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
}

/// 角色包钉版条目。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RolePackPin {
    /// 角色包 id。
    pub pack_id: String,
    /// 角色包版本（`role_packs` 注册表解析结果）。
    pub version: String,
}

/// 采集输入：会话/任务相关的环境事实，由接线方（pipeline / headless）在
/// 任务开始时从会话上下文取快照传入。系统级字段（os/runtime/工具表）由
/// [`EnvironmentManifest::capture`] 自行采集，不在此列。
#[derive(Debug, Clone, Default)]
pub struct CaptureInputs {
    /// 本次任务使用的模型 id（`SendOptions.model_id` / 执行快照解析结果）。
    pub model_id: Option<String>,
    /// 任务开始时已加载的技能钉版列表（`SessionSkillState` 解析出的 id，
    /// 逐个补 version/hash）。
    pub skills_loaded: Vec<SkillPin>,
    /// 任务生效的角色包（如有）。
    pub role_pack: Option<RolePackPin>,
    /// 网络允许清单当前值（如 `connectors.webhook.allowed_hosts`、shell 网络
    /// 策略允许的主机集合）。
    pub network_allowlist: Vec<String>,
    /// 工作目录身份：本会话生效的 runtime root id 列表（`runtime_roots`
    /// 解析结果；记 id 不记路径，避免把用户目录结构写进审计导出物）。
    pub workspace_root_ids: Vec<String>,
}

/// 每任务环境清单。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentManifest {
    pub schema_version: u16,
    /// OS/架构身份。
    pub os: OsIdentity,
    /// 应用版本（`CARGO_PKG_VERSION`）。
    pub app_version: String,
    /// 运行时身份（tauri/rust 编译期版本）。
    pub runtime: RuntimeIdentity,
    /// G01-c 工具注册表全表指纹（见模块文档"指纹方案"）。
    pub tool_schema_hash: String,
    /// 指纹覆盖的工具条数（hash 之外的可读摘要，便于人眼核对）。
    pub tool_count: usize,
    /// 本次任务模型 id。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    /// 已加载技能钉版（按 `skill_id` 排序，确定性）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills_loaded: Vec<SkillPin>,
    /// 角色包钉版（如有）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role_pack: Option<RolePackPin>,
    /// 网络允许清单快照（排序去重，确定性）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub network_allowlist: Vec<String>,
    /// 工作目录身份快照（root id，排序去重，确定性）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub workspace_root_ids: Vec<String>,
    /// 采集时刻（RFC3339）。**不参与**内容指纹与漂移比对。
    pub captured_at: String,
}

// ============================================================================
// 漂移检测
// ============================================================================

/// 漂移字段标识（字段级粒度）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvDriftField {
    /// 清单结构版本不同（跨版本比对，解读需谨慎）。
    SchemaVersion,
    /// OS/架构/族任一变化。
    Os,
    /// 应用版本变化。
    AppVersion,
    /// tauri/rust 版本任一变化。
    Runtime,
    /// 工具注册表指纹变化（工具增删/元数据调整）。
    ToolSchema,
    /// 模型 id 变化。
    Model,
    /// 技能集合或任一技能的 version/hash 变化。
    Skills,
    /// 角色包变化。
    RolePack,
    /// 网络允许清单变化。
    NetworkAllowlist,
    /// 工作目录身份变化。
    WorkspaceRoots,
}

impl EnvDriftField {
    pub fn as_str(self) -> &'static str {
        match self {
            EnvDriftField::SchemaVersion => "schema_version",
            EnvDriftField::Os => "os",
            EnvDriftField::AppVersion => "app_version",
            EnvDriftField::Runtime => "runtime",
            EnvDriftField::ToolSchema => "tool_schema",
            EnvDriftField::Model => "model",
            EnvDriftField::Skills => "skills",
            EnvDriftField::RolePack => "role_pack",
            EnvDriftField::NetworkAllowlist => "network_allowlist",
            EnvDriftField::WorkspaceRoots => "workspace_roots",
        }
    }
}

/// 一条字段级环境漂移记录。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnvDrift {
    /// 漂移字段。
    pub field: EnvDriftField,
    /// 人类可读的确定性差异说明（`'baseline' -> 'current'`，
    /// 集合差异为 `+[added] -[removed]`）。
    pub detail: String,
}

impl fmt::Display for EnvDrift {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.field.as_str(), self.detail)
    }
}

// ============================================================================
// 采集
// ============================================================================

impl EnvironmentManifest {
    /// 任务开始时采集一份环境清单。
    ///
    /// 系统级字段（os/runtime/工具表）在此采集；会话相关字段由 `inputs`
    /// 传入快照。多值字段统一 trim、滤空、排序去重，保证同环境重复采集
    /// 的内容指纹逐字节一致（`captured_at` 除外，它不参与指纹）。
    pub fn capture(inputs: &CaptureInputs) -> Self {
        let mut skills_loaded: Vec<SkillPin> = inputs
            .skills_loaded
            .iter()
            .filter(|pin| !pin.skill_id.trim().is_empty())
            .cloned()
            .collect();
        skills_loaded.sort_by(|a, b| a.skill_id.cmp(&b.skill_id));
        skills_loaded.dedup_by(|next, prev| next.skill_id == prev.skill_id);

        let network_allowlist = sorted_unique(inputs.network_allowlist.iter());
        let workspace_root_ids = sorted_unique(inputs.workspace_root_ids.iter());

        Self {
            schema_version: ENVIRONMENT_MANIFEST_SCHEMA_VERSION,
            os: OsIdentity {
                os: std::env::consts::OS.to_string(),
                arch: std::env::consts::ARCH.to_string(),
                family: std::env::consts::FAMILY.to_string(),
            },
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            runtime: RuntimeIdentity {
                tauri_version: tauri::VERSION.to_string(),
                // 注：rust-version 未声明时 cargo 将该变量展开为空串（非 unset），
                // 故 Some("") 也要归一为 "unknown"。
                rust_version: option_env!("CARGO_PKG_RUST_VERSION")
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("unknown")
                    .to_string(),
            },
            tool_schema_hash: tool_schema_fingerprint(),
            tool_count: BUILTIN_DESCRIPTORS.len(),
            model_id: inputs
                .model_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            skills_loaded,
            role_pack: inputs.role_pack.clone(),
            network_allowlist,
            workspace_root_ids,
            captured_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    /// 清单内容指纹（sha256 hex）。覆盖除 `captured_at` 外的全部字段。
    ///
    /// 逐字段显式拼行后哈希，**不经 serde 序列化**——本结构虽不含
    /// HashMap，但显式拼接使指纹口径永久独立于 serde 格式与未来字段类型
    /// 演进（AGENTS.md HashMap 红线的根因就是"序列化顺序不受控"）。
    pub fn content_fingerprint(&self) -> String {
        let mut lines: Vec<String> = Vec::new();
        lines.push(format!("schema_version={}", self.schema_version));
        lines.push(format!(
            "os={}|{}|{}",
            self.os.os, self.os.arch, self.os.family
        ));
        lines.push(format!("app_version={}", self.app_version));
        lines.push(format!(
            "runtime=tauri:{};rust:{}",
            self.runtime.tauri_version, self.runtime.rust_version
        ));
        lines.push(format!(
            "tool_schema={}({})",
            self.tool_schema_hash, self.tool_count
        ));
        lines.push(format!("model_id={}", opt_display(self.model_id.as_deref())));
        for pin in &self.skills_loaded {
            lines.push(format!(
                "skill={}@{}#{}",
                pin.skill_id,
                opt_display(pin.version.as_deref()),
                opt_display(pin.content_hash.as_deref())
            ));
        }
        if let Some(role_pack) = &self.role_pack {
            lines.push(format!("role_pack={}@{}", role_pack.pack_id, role_pack.version));
        }
        for host in &self.network_allowlist {
            lines.push(format!("network_allow={host}"));
        }
        for root_id in &self.workspace_root_ids {
            lines.push(format!("workspace_root={root_id}"));
        }
        sha256_hex(&lines.join("\n"))
    }

    /// 字段级漂移检测：`self` 为当前环境，`baseline` 为基线（如历史任务
    /// 审计清单中的环境快照）。返回全部检出漂移，无漂移时为空 Vec。
    ///
    /// `captured_at` 不参与比对。集合字段（技能/网络/根）报逐条
    /// added/removed/changed；遍历用 BTreeMap/BTreeSet，输出顺序确定。
    pub fn diff(&self, baseline: &EnvironmentManifest) -> Vec<EnvDrift> {
        let mut drifts = Vec::new();

        if self.schema_version != baseline.schema_version {
            drifts.push(EnvDrift {
                field: EnvDriftField::SchemaVersion,
                detail: format!(
                    "'{}' -> '{}'",
                    baseline.schema_version, self.schema_version
                ),
            });
        }
        if self.os != baseline.os {
            drifts.push(EnvDrift {
                field: EnvDriftField::Os,
                detail: format!(
                    "'{}/{}/{}' -> '{}/{}/{}'",
                    baseline.os.os,
                    baseline.os.arch,
                    baseline.os.family,
                    self.os.os,
                    self.os.arch,
                    self.os.family
                ),
            });
        }
        if self.app_version != baseline.app_version {
            drifts.push(EnvDrift {
                field: EnvDriftField::AppVersion,
                detail: format!("'{}' -> '{}'", baseline.app_version, self.app_version),
            });
        }
        if self.runtime != baseline.runtime {
            drifts.push(EnvDrift {
                field: EnvDriftField::Runtime,
                detail: format!(
                    "'tauri:{} rust:{}' -> 'tauri:{} rust:{}'",
                    baseline.runtime.tauri_version,
                    baseline.runtime.rust_version,
                    self.runtime.tauri_version,
                    self.runtime.rust_version
                ),
            });
        }
        if self.tool_schema_hash != baseline.tool_schema_hash {
            drifts.push(EnvDrift {
                field: EnvDriftField::ToolSchema,
                detail: format!(
                    "hash '{}' ({} tools) -> '{}' ({} tools)",
                    baseline.tool_schema_hash,
                    baseline.tool_count,
                    self.tool_schema_hash,
                    self.tool_count
                ),
            });
        }
        if self.model_id != baseline.model_id {
            drifts.push(EnvDrift {
                field: EnvDriftField::Model,
                detail: format!(
                    "'{}' -> '{}'",
                    opt_display(baseline.model_id.as_deref()),
                    opt_display(self.model_id.as_deref())
                ),
            });
        }

        // 技能：以 skill_id 为键逐条比对（BTreeMap → 确定性遍历序）。
        let baseline_skills: BTreeMap<&str, &SkillPin> = baseline
            .skills_loaded
            .iter()
            .map(|pin| (pin.skill_id.as_str(), pin))
            .collect();
        let current_skills: BTreeMap<&str, &SkillPin> = self
            .skills_loaded
            .iter()
            .map(|pin| (pin.skill_id.as_str(), pin))
            .collect();
        for (skill_id, baseline_pin) in &baseline_skills {
            match current_skills.get(skill_id) {
                None => drifts.push(EnvDrift {
                    field: EnvDriftField::Skills,
                    detail: format!("skill '{skill_id}': removed"),
                }),
                Some(current_pin) => {
                    if current_pin.version != baseline_pin.version
                        || current_pin.content_hash != baseline_pin.content_hash
                    {
                        drifts.push(EnvDrift {
                            field: EnvDriftField::Skills,
                            detail: format!(
                                "skill '{}': '{}#{}' -> '{}#{}'",
                                skill_id,
                                opt_display(baseline_pin.version.as_deref()),
                                opt_display(baseline_pin.content_hash.as_deref()),
                                opt_display(current_pin.version.as_deref()),
                                opt_display(current_pin.content_hash.as_deref())
                            ),
                        });
                    }
                }
            }
        }
        for skill_id in current_skills.keys() {
            if !baseline_skills.contains_key(skill_id) {
                drifts.push(EnvDrift {
                    field: EnvDriftField::Skills,
                    detail: format!("skill '{skill_id}': added"),
                });
            }
        }

        if self.role_pack != baseline.role_pack {
            drifts.push(EnvDrift {
                field: EnvDriftField::RolePack,
                detail: format!(
                    "'{}' -> '{}'",
                    baseline
                        .role_pack
                        .as_ref()
                        .map(|pin| format!("{}@{}", pin.pack_id, pin.version))
                        .unwrap_or_else(|| "<unset>".to_string()),
                    self.role_pack
                        .as_ref()
                        .map(|pin| format!("{}@{}", pin.pack_id, pin.version))
                        .unwrap_or_else(|| "<unset>".to_string())
                ),
            });
        }

        diff_sorted_set(
            &baseline.network_allowlist,
            &self.network_allowlist,
            EnvDriftField::NetworkAllowlist,
            &mut drifts,
        );
        diff_sorted_set(
            &baseline.workspace_root_ids,
            &self.workspace_root_ids,
            EnvDriftField::WorkspaceRoots,
            &mut drifts,
        );

        drifts
    }

    /// 重放/复验兼容性检查：当前环境（`self`）对基线（`baseline`）是否有
    /// 任何漂移。无漂移返回 `Ok(())`，否则返回全部漂移记录。
    ///
    /// **记录与显式告警语义**：本函数只返回漂移清单，调用方（如 G09 回放器）
    /// 负责记录/告警与决定是否继续——环境漂移绝不静默，也绝不由本模块
    /// 单方面阻断执行。
    pub fn check_replay_compatibility(
        &self,
        baseline: &EnvironmentManifest,
    ) -> Result<(), Vec<EnvDrift>> {
        let drifts = self.diff(baseline);
        if drifts.is_empty() {
            Ok(())
        } else {
            Err(drifts)
        }
    }
}

// ============================================================================
// 工具表指纹
// ============================================================================

/// 当前内建工具注册表（G01-c `BUILTIN_DESCRIPTORS` 全表）的确定性指纹。
pub fn tool_schema_fingerprint() -> String {
    tool_schema_fingerprint_for(BUILTIN_DESCRIPTORS)
}

/// 对给定 descriptor 切片计算指纹（按切片顺序逐条拼行后 sha256）。
///
/// 独立成函数以便测试验证"增删工具/改元数据 → hash 变"（静态表本身在
/// 测试中不可变）。生产唯一调用点是 [`tool_schema_fingerprint`]。
pub fn tool_schema_fingerprint_for(descriptors: &[ToolDescriptor]) -> String {
    let mut lines = String::new();
    for descriptor in descriptors {
        if !lines.is_empty() {
            lines.push('\n');
        }
        // 定长字段行：name|sensitivity|read_only|side_effect|timeout|grants|headless|ptc
        lines.push_str(descriptor.name);
        lines.push('|');
        lines.push_str(sensitivity_code(descriptor.sensitivity));
        lines.push('|');
        lines.push_str(bool_code(descriptor.read_only));
        lines.push('|');
        lines.push_str(side_effect_code(descriptor.side_effect_class));
        lines.push('|');
        match descriptor.timeout_secs {
            Some(secs) => lines.push_str(&secs.to_string()),
            None => lines.push('-'),
        }
        lines.push('|');
        lines.push_str(grants_scope_code(descriptor.grants_scope_hint));
        lines.push('|');
        lines.push_str(bool_code(descriptor.headless_allowed));
        lines.push('|');
        lines.push_str(bool_code(descriptor.ptc_allowed));
    }
    sha256_hex(&lines)
}

// ============================================================================
// 内部 helper
// ============================================================================

fn sha256_hex(data: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn opt_display(value: Option<&str>) -> &str {
    value.unwrap_or("<unset>")
}

/// 字符串集合的确定性规范化：trim、滤空、排序、去重。
fn sorted_unique<'a>(items: impl Iterator<Item = &'a String>) -> Vec<String> {
    let mut values: Vec<String> = items
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect();
    values.sort();
    values.dedup();
    values
}

/// 已排序字符串集合的 added/removed 差异（输入须已排序——
/// [`EnvironmentManifest::capture`] 保证；diff 输出顺序即排序序，确定）。
fn diff_sorted_set(
    baseline: &[String],
    current: &[String],
    field: EnvDriftField,
    drifts: &mut Vec<EnvDrift>,
) {
    let added: Vec<&str> = current
        .iter()
        .filter(|item| !baseline.contains(item))
        .map(String::as_str)
        .collect();
    let removed: Vec<&str> = baseline
        .iter()
        .filter(|item| !current.contains(item))
        .map(String::as_str)
        .collect();
    if !added.is_empty() || !removed.is_empty() {
        let mut detail = String::new();
        if !added.is_empty() {
            detail.push_str(&format!("+[{}]", added.join(", ")));
        }
        if !removed.is_empty() {
            if !detail.is_empty() {
                detail.push(' ');
            }
            detail.push_str(&format!("-[{}]", removed.join(", ")));
        }
        drifts.push(EnvDrift { field, detail });
    }
}

// —— 枚举 → 指纹稳定码（显式 match：新增变体编译失败，强制审查 hash 口径）——

fn sensitivity_code(sensitivity: ToolSensitivity) -> &'static str {
    match sensitivity {
        ToolSensitivity::Low => "low",
        ToolSensitivity::Medium => "medium",
        ToolSensitivity::High => "high",
    }
}

fn side_effect_code(class: SideEffectClass) -> &'static str {
    match class {
        SideEffectClass::Read => "read",
        SideEffectClass::WriteLocal => "write_local",
        SideEffectClass::WriteRemote => "write_remote",
        SideEffectClass::Irreversible => "irreversible",
    }
}

fn grants_scope_code(hint: GrantsScopeHint) -> &'static str {
    match hint {
        GrantsScopeHint::Builtin => "builtin",
        GrantsScopeHint::Shell => "shell",
    }
}

fn bool_code(value: bool) -> &'static str {
    if value {
        "1"
    } else {
        "0"
    }
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_v2::tool_descriptors::SideEffectClass;

    fn sample_inputs() -> CaptureInputs {
        CaptureInputs {
            model_id: Some("deepseek-chat".to_string()),
            skills_loaded: vec![
                SkillPin {
                    skill_id: "pdf-study".to_string(),
                    version: Some("1.2.0".to_string()),
                    content_hash: Some("aaaa".to_string()),
                },
                SkillPin {
                    skill_id: "anki-cards".to_string(),
                    version: Some("0.9.1".to_string()),
                    content_hash: None,
                },
            ],
            role_pack: Some(RolePackPin {
                pack_id: "finance-core".to_string(),
                version: "2.0.0".to_string(),
            }),
            network_allowlist: vec![
                "api.example.com".to_string(),
                "arxiv.org".to_string(),
            ],
            workspace_root_ids: vec!["ws:a1b2".to_string(), "auth:c3d4".to_string()],
        }
    }

    fn sample_manifest() -> EnvironmentManifest {
        EnvironmentManifest::capture(&sample_inputs())
    }

    // ---------- 采集 ----------

    #[test]
    fn capture_produces_complete_manifest() {
        let manifest = sample_manifest();
        assert_eq!(manifest.schema_version, ENVIRONMENT_MANIFEST_SCHEMA_VERSION);
        assert!(!manifest.os.os.is_empty());
        assert!(!manifest.os.arch.is_empty());
        assert!(!manifest.os.family.is_empty());
        assert_eq!(manifest.app_version, env!("CARGO_PKG_VERSION"));
        assert!(!manifest.runtime.tauri_version.is_empty());
        assert!(!manifest.runtime.rust_version.is_empty());
        assert_eq!(manifest.tool_schema_hash.len(), 64);
        assert!(manifest.tool_schema_hash.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(manifest.tool_count, BUILTIN_DESCRIPTORS.len());
        assert_eq!(manifest.model_id.as_deref(), Some("deepseek-chat"));
        assert_eq!(manifest.skills_loaded.len(), 2);
        assert_eq!(
            manifest.role_pack.as_ref().map(|p| p.pack_id.as_str()),
            Some("finance-core")
        );
        assert_eq!(manifest.network_allowlist.len(), 2);
        assert_eq!(manifest.workspace_root_ids.len(), 2);
        // RFC3339 可解析
        assert!(chrono::DateTime::parse_from_rfc3339(&manifest.captured_at).is_ok());
    }

    #[test]
    fn capture_normalizes_multivalue_fields() {
        let mut inputs = sample_inputs();
        // 乱序 + 重复 + 空白，应被规范化为排序去重结果
        inputs.network_allowlist = vec![
            " b.com ".to_string(),
            "a.com".to_string(),
            "b.com".to_string(),
            "   ".to_string(),
        ];
        inputs.skills_loaded.push(SkillPin {
            skill_id: "pdf-study".to_string(),
            version: Some("9.9.9".to_string()),
            content_hash: None,
        });
        let manifest = EnvironmentManifest::capture(&inputs);
        assert_eq!(
            manifest.network_allowlist,
            vec!["a.com".to_string(), "b.com".to_string()]
        );
        assert_eq!(manifest.skills_loaded.len(), 2); // 同 id 去重
        assert_eq!(manifest.skills_loaded[0].skill_id, "anki-cards"); // 按 id 排序
    }

    // ---------- 确定性 ----------

    #[test]
    fn fingerprint_is_deterministic_across_captures() {
        let a = EnvironmentManifest::capture(&sample_inputs());
        let b = EnvironmentManifest::capture(&sample_inputs());
        assert_eq!(a.content_fingerprint(), b.content_fingerprint());
    }

    #[test]
    fn fingerprint_ignores_captured_at() {
        let mut a = sample_manifest();
        let fingerprint = a.content_fingerprint();
        a.captured_at = "1970-01-01T00:00:00Z".to_string();
        assert_eq!(a.content_fingerprint(), fingerprint);
    }

    #[test]
    fn tool_schema_fingerprint_is_stable_across_calls() {
        assert_eq!(tool_schema_fingerprint(), tool_schema_fingerprint());
        assert_eq!(tool_schema_fingerprint().len(), 64);
    }

    // ---------- 工具表变化 → hash 变 ----------

    #[test]
    fn tool_schema_fingerprint_reacts_to_table_changes() {
        let baseline = tool_schema_fingerprint_for(BUILTIN_DESCRIPTORS);

        // 删一条
        let removed = tool_schema_fingerprint_for(&BUILTIN_DESCRIPTORS[1..]);
        assert_ne!(baseline, removed);

        // 增一条
        let mut extended = BUILTIN_DESCRIPTORS.to_vec();
        let extra = ToolDescriptor {
            name: "g08_test_extra_tool",
            sensitivity: ToolSensitivity::Low,
            read_only: true,
            side_effect_class: SideEffectClass::Read,
            timeout_secs: None,
            grants_scope_hint: GrantsScopeHint::Builtin,
            headless_allowed: false,
            ptc_allowed: false,
        };
        extended.push(extra);
        assert_ne!(baseline, tool_schema_fingerprint_for(&extended));

        // 改一条元数据（敏感度）
        let mut mutated = BUILTIN_DESCRIPTORS.to_vec();
        mutated[0].sensitivity = ToolSensitivity::High;
        assert_ne!(baseline, tool_schema_fingerprint_for(&mutated));

        // 空表与全表不同
        assert_ne!(baseline, tool_schema_fingerprint_for(&[]));
    }

    // ---------- 逐字段漂移检出 ----------

    fn assert_single_drift(
        baseline: &EnvironmentManifest,
        current: &EnvironmentManifest,
        field: EnvDriftField,
    ) {
        let drifts = current.diff(baseline);
        assert_eq!(drifts.len(), 1, "drifts: {drifts:?}");
        assert_eq!(drifts[0].field, field);
        assert!(!drifts[0].detail.is_empty());
    }

    #[test]
    fn diff_detects_each_field_drift() {
        let baseline = sample_manifest();

        let mut current = baseline.clone();
        current.schema_version += 1;
        assert_single_drift(&baseline, &current, EnvDriftField::SchemaVersion);

        let mut current = baseline.clone();
        current.os.arch = "x86_64".to_string();
        assert_single_drift(&baseline, &current, EnvDriftField::Os);

        let mut current = baseline.clone();
        current.app_version = "0.0.0-test".to_string();
        assert_single_drift(&baseline, &current, EnvDriftField::AppVersion);

        let mut current = baseline.clone();
        current.runtime.tauri_version = "9.9.9".to_string();
        assert_single_drift(&baseline, &current, EnvDriftField::Runtime);

        let mut current = baseline.clone();
        current.tool_schema_hash = "0".repeat(64);
        assert_single_drift(&baseline, &current, EnvDriftField::ToolSchema);

        let mut current = baseline.clone();
        current.model_id = Some("other-model".to_string());
        assert_single_drift(&baseline, &current, EnvDriftField::Model);

        let mut current = baseline.clone();
        current.role_pack = None;
        assert_single_drift(&baseline, &current, EnvDriftField::RolePack);

        let mut current = baseline.clone();
        current.network_allowlist.push("new-host.example.com".to_string());
        assert_single_drift(&baseline, &current, EnvDriftField::NetworkAllowlist);

        let mut current = baseline.clone();
        current.workspace_root_ids.pop();
        assert_single_drift(&baseline, &current, EnvDriftField::WorkspaceRoots);
    }

    #[test]
    fn skills_diff_reports_added_removed_and_changed() {
        // capture 按 skill_id 排序：[0]=anki-cards，[1]=pdf-study
        let baseline = sample_manifest();
        let mut current = baseline.clone();
        // 改版本（pdf-study: 1.2.0 -> 1.3.0）
        current.skills_loaded[1].version = Some("1.3.0".to_string());
        // 删 anki-cards、增 new-skill
        current.skills_loaded.remove(0);
        current.skills_loaded.push(SkillPin {
            skill_id: "new-skill".to_string(),
            version: None,
            content_hash: None,
        });

        let drifts = current.diff(&baseline);
        let skill_drifts: Vec<&EnvDrift> = drifts
            .iter()
            .filter(|d| d.field == EnvDriftField::Skills)
            .collect();
        assert_eq!(skill_drifts.len(), 3, "drifts: {drifts:?}");
        assert!(skill_drifts
            .iter()
            .any(|d| d.detail.contains("anki-cards") && d.detail.contains("removed")));
        assert!(skill_drifts
            .iter()
            .any(|d| d.detail.contains("new-skill") && d.detail.contains("added")));
        assert!(skill_drifts
            .iter()
            .any(|d| d.detail.contains("pdf-study")
                && d.detail.contains("1.2.0")
                && d.detail.contains("1.3.0")));
    }

    #[test]
    fn set_diff_reports_added_and_removed_deterministically() {
        let baseline = sample_manifest();
        let mut current = baseline.clone();
        current.network_allowlist = vec!["zzz.example.com".to_string()];
        let drifts = current.diff(&baseline);
        assert_eq!(drifts.len(), 1);
        assert_eq!(drifts[0].field, EnvDriftField::NetworkAllowlist);
        // removed 按排序序列出，added 同理
        assert_eq!(
            drifts[0].detail,
            "+[zzz.example.com] -[api.example.com, arxiv.org]"
        );
    }

    // ---------- 重放兼容检查 ----------

    #[test]
    fn replay_compatibility_passes_when_no_drift() {
        let baseline = sample_manifest();
        let mut current = baseline.clone();
        // captured_at 不同不算漂移
        current.captured_at = "2030-01-01T00:00:00Z".to_string();
        assert!(current.check_replay_compatibility(&baseline).is_ok());
    }

    #[test]
    fn replay_compatibility_reports_all_drifts() {
        let baseline = sample_manifest();
        let mut current = baseline.clone();
        current.model_id = None;
        current.os.os = "linux".to_string();
        let err = current
            .check_replay_compatibility(&baseline)
            .expect_err("drifts must be reported");
        assert_eq!(err.len(), 2);
        assert!(err.iter().any(|d| d.field == EnvDriftField::Model));
        assert!(err.iter().any(|d| d.field == EnvDriftField::Os));
        // Display 可用（告警文案）
        let rendered = err[0].to_string();
        assert!(rendered.starts_with('['));
    }

    // ---------- 序列化口径 ----------

    #[test]
    fn manifest_serializes_camel_case() {
        let manifest = sample_manifest();
        let value = serde_json::to_value(&manifest).unwrap();
        assert!(value.get("schemaVersion").is_some());
        assert!(value.get("appVersion").is_some());
        assert!(value.get("toolSchemaHash").is_some());
        assert!(value.get("toolCount").is_some());
        assert!(value.get("modelId").is_some());
        assert!(value.get("skillsLoaded").is_some());
        assert!(value.get("rolePack").is_some());
        assert!(value.get("networkAllowlist").is_some());
        assert!(value.get("workspaceRootIds").is_some());
        assert!(value.get("capturedAt").is_some());
        let skill = &value["skillsLoaded"][0];
        assert_eq!(skill["skillId"], "anki-cards"); // capture 按 id 排序
        assert!(skill.get("version").is_some());
        assert!(skill.get("contentHash").is_none()); // None → skip
        assert!(value["skillsLoaded"][1].get("contentHash").is_some());
    }
}
