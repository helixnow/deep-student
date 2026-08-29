//! Anki 制卡 Sidekick 模型分层路由（Round 4 #7）
//!
//! 目标：制卡管线中不同职责使用不同强度的模型——
//! 规划（Planner）/ 终审（Critic）用较强模型，批量生成（Generator）用
//! 廉价模型，图像理解（Vlm）用视觉模型。
//!
//! 设计约束（与任务书一致）：
//! 1. 只根据**已配置的槽位**分配：制卡槽（anki_card_model_config_id，
//!    用户通常配廉价模型）、主模型槽（model2_config_id，通常较强）、
//!    视觉槽（任一已启用的多模态文本模型）。缺槽位时降级到同一模型，
//!    绝不因缺配置而报错。
//! 2. 决策可观测：`AnkiRoutingPlan` 全字段可序列化 + debug 日志逐角色输出。
//! 3. 零新增网络调用与配置 UI：本模块为纯函数；能力探测只读现有
//!    模型分配与 API 配置（见 `LLMManager::probe_anki_routing_slots`）。
//! 4. 失败不影响制卡：Generator、Critic、Planner（`plan_route`）和 Vlm
//!    （ChatAnki 图片提取）生产消费者都保留旧单模型路径；槽位探测失败或
//!    配置在探测后消失时静默回退。
//!
//! wire 格式说明：路由模式经 options JSON 的扩展字段
//! `sidekick_model_routing`（"auto" | "single"）传入，缺省 auto。
//! 复用 `anki_protocol::StructuredOutputOptions` 的 serde-default
//! 二次解析模式——`AnkiGenerationOptions` 被多处穷举字面量构造，
//! 直接加字段会波及禁改文件（详见 anki_protocol.rs 模块文档）。

use serde::{Deserialize, Serialize};
use tracing::debug;

use crate::llm_manager::ApiConfig;
use crate::models::ModelAssignments;

// ============================================================
// 角色与模式
// ============================================================

/// 制卡管线中的模型角色
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnkiModelRole {
    /// 规划：分段策略、模板选择、卡片配额规划（低频、高价值 → 较强模型）
    Planner,
    /// 批量生成：逐段流式产卡（高频、成本敏感 → 廉价模型）
    Generator,
    /// 终审：整批质量复核 / 重写建议（低频、高价值 → 较强模型）
    Critic,
    /// 图像理解：图片素材描述 / 图文卡（需要多模态能力）
    Vlm,
}

impl AnkiModelRole {
    pub const ALL: [AnkiModelRole; 4] = [
        AnkiModelRole::Planner,
        AnkiModelRole::Generator,
        AnkiModelRole::Critic,
        AnkiModelRole::Vlm,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            AnkiModelRole::Planner => "planner",
            AnkiModelRole::Generator => "generator",
            AnkiModelRole::Critic => "critic",
            AnkiModelRole::Vlm => "vlm",
        }
    }
}

/// 路由模式（options JSON 扩展字段 `sidekick_model_routing`，缺省 auto）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoutingMode {
    /// 按槽位能力分层（默认）
    Auto,
    /// 全部角色使用同一个制卡模型（旧行为）
    Single,
}

impl Default for RoutingMode {
    fn default() -> Self {
        RoutingMode::Auto
    }
}

/// options JSON 的扩展字段（serde-default 二次解析，见模块文档）
#[derive(Debug, Clone, Default, Deserialize)]
struct SidekickRoutingOptions {
    #[serde(default)]
    sidekick_model_routing: Option<String>,
}

/// 从任务的 anki_generation_options JSON 解析路由模式。
/// 未知值 / 缺失 / 非法 JSON 一律回退 Auto（保守：Auto 在槽位齐全时
/// 与旧行为的 Generator 选择一致，缺槽位时才体现降级差异）。
pub fn parse_routing_mode(options_json: &str) -> RoutingMode {
    let opts: SidekickRoutingOptions = serde_json::from_str(options_json).unwrap_or_default();
    match opts
        .sidekick_model_routing
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("single") | Some("off") | Some("disabled") => RoutingMode::Single,
        _ => RoutingMode::Auto,
    }
}

// ============================================================
// 槽位快照（只读能力探测的输出）
// ============================================================

/// 单个槽位的能力快照（从 ApiConfig 提取的最小只读子集）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlotProbe {
    pub config_id: String,
    pub model: String,
    pub is_multimodal: bool,
    pub is_reasoning: bool,
}

impl SlotProbe {
    pub fn from_config(config: &ApiConfig) -> Self {
        Self {
            config_id: config.id.clone(),
            model: config.model.clone(),
            is_multimodal: config.is_multimodal,
            is_reasoning: config.is_reasoning,
        }
    }
}

/// Sidekick 路由可见的全部槽位。
/// 均为 Option：缺槽位是常态（用户可能只配了一个模型），由 `plan_routing`
/// 负责降级，本结构不做任何判断。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnkiRoutingSlots {
    /// 制卡槽（anki_card_model_config_id）——批量生成的首选（通常廉价）
    pub anki_card: Option<SlotProbe>,
    /// 主模型槽（model2_config_id）——规划/终审的首选（通常较强）
    pub main: Option<SlotProbe>,
    /// 视觉槽——任一已启用的多模态文本模型（探测顺序见 `build_slots`）
    pub vision: Option<SlotProbe>,
}

impl AnkiRoutingSlots {
    pub fn is_empty(&self) -> bool {
        self.anki_card.is_none() && self.main.is_none() && self.vision.is_none()
    }
}

/// 配置是否可作为文本生成槽位（与 routing::resolve_enabled_text_model 同口径，
/// 额外排除生图模型）
fn eligible_text_config(config: &ApiConfig) -> bool {
    config.enabled && !config.is_embedding && !config.is_reranker && !config.is_image_generation
}

/// 纯函数：从模型分配 + API 配置构建槽位快照（只读，无网络/无 DB）。
///
/// 视觉槽探测顺序（全部只在已启用的多模态文本模型中选取）：
/// 1. exam_sheet_ocr_model_config_id（用户显式配置的视觉/OCR 模型）
/// 2. 主模型槽自身多模态
/// 3. 制卡槽自身多模态
/// 4. 其余任一已启用多模态配置（按配置列表顺序，确定性）
pub fn build_slots(assignments: &ModelAssignments, configs: &[ApiConfig]) -> AnkiRoutingSlots {
    let find_eligible = |id: Option<&str>| -> Option<&ApiConfig> {
        let id = id?;
        configs
            .iter()
            .find(|c| c.id == id && eligible_text_config(c))
    };

    let anki_card = find_eligible(assignments.anki_card_model_config_id.as_deref());
    let main = find_eligible(assignments.model2_config_id.as_deref());

    let vision = find_eligible(assignments.exam_sheet_ocr_model_config_id.as_deref())
        .filter(|c| c.is_multimodal)
        .or_else(|| main.filter(|c| c.is_multimodal))
        .or_else(|| anki_card.filter(|c| c.is_multimodal))
        .or_else(|| {
            configs
                .iter()
                .find(|c| eligible_text_config(c) && c.is_multimodal)
        });

    AnkiRoutingSlots {
        anki_card: anki_card.map(SlotProbe::from_config),
        main: main.map(SlotProbe::from_config),
        vision: vision.map(SlotProbe::from_config),
    }
}

// ============================================================
// 路由决策（可观测结构体）
// ============================================================

/// 决策来源槽位
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SlotKind {
    /// 制卡槽（anki_card_model_config_id）
    AnkiCard,
    /// 主模型槽（model2_config_id）
    MainModel,
    /// 视觉槽
    Vision,
}

/// 单角色的路由决策（全字段可序列化，供日志/诊断/前端调试面板消费）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoleDecision {
    pub role: AnkiModelRole,
    pub config_id: String,
    pub model: String,
    /// 实际取用的槽位
    pub slot: SlotKind,
    /// 首选槽位缺失、降级到了其他槽位的同一模型
    pub degraded: bool,
    /// 所选模型是否具备多模态能力（Vlm 角色降级到纯文本模型时为 false，
    /// 调用方据此跳过图像输入而非报错）
    pub is_multimodal: bool,
    /// 人类可读的决策原因（观测用，不参与任何逻辑）
    pub reason: String,
}

/// 完整路由计划：四个角色各一条决策
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnkiRoutingPlan {
    pub mode: RoutingMode,
    pub planner: RoleDecision,
    pub generator: RoleDecision,
    pub critic: RoleDecision,
    pub vlm: RoleDecision,
}

impl AnkiRoutingPlan {
    pub fn decision(&self, role: AnkiModelRole) -> &RoleDecision {
        match role {
            AnkiModelRole::Planner => &self.planner,
            AnkiModelRole::Generator => &self.generator,
            AnkiModelRole::Critic => &self.critic,
            AnkiModelRole::Vlm => &self.vlm,
        }
    }

    /// 计划中实际用到的不同模型配置数量（观测口径）
    pub fn distinct_config_count(&self) -> usize {
        let mut ids: Vec<&str> = AnkiModelRole::ALL
            .iter()
            .map(|r| self.decision(*r).config_id.as_str())
            .collect();
        ids.sort_unstable();
        ids.dedup();
        ids.len()
    }

    /// 决策可观测性：逐角色输出 debug 日志（要求 3）
    pub fn log_debug(&self) {
        debug!(
            "[ANKI_ROUTING] Sidekick 路由计划: mode={:?} distinct_models={}",
            self.mode,
            self.distinct_config_count()
        );
        for role in AnkiModelRole::ALL {
            let d = self.decision(role);
            debug!(
                "[ANKI_ROUTING]   {} -> config_id={} model={} slot={:?} degraded={} multimodal={} ({})",
                d.role.as_str(),
                d.config_id,
                d.model,
                d.slot,
                d.degraded,
                d.is_multimodal,
                d.reason
            );
        }
    }
}

fn decision_from(
    role: AnkiModelRole,
    probe: &SlotProbe,
    slot: SlotKind,
    degraded: bool,
    reason: impl Into<String>,
) -> RoleDecision {
    RoleDecision {
        role,
        config_id: probe.config_id.clone(),
        model: probe.model.clone(),
        slot,
        degraded,
        is_multimodal: probe.is_multimodal,
        reason: reason.into(),
    }
}

/// 核心纯函数：根据槽位快照与模式生成路由计划。
///
/// 角色偏好（Auto 模式）：
/// - Planner / Critic：主模型槽（较强）→ 缺失则降级到制卡槽
/// - Generator：制卡槽（廉价、批量）→ 缺失则降级到主模型槽
/// - Vlm：视觉槽 → 缺失则降级到 Generator 所用模型（标记 degraded，
///   is_multimodal=false 时调用方应跳过图像输入）
///
/// Single 模式：全部角色使用基准模型（制卡槽优先，其次主模型槽）。
///
/// 返回 None 当且仅当没有任何可用槽位——调用方回退旧路径报配置错误，
/// 本模块自身绝不产生错误（要求 5：失败不影响制卡）。
pub fn plan_routing(mode: RoutingMode, slots: &AnkiRoutingSlots) -> Option<AnkiRoutingPlan> {
    // 基准模型：Generator 的首选链（制卡槽 → 主模型槽 → 视觉槽兜底）
    let (base_probe, base_slot, base_degraded) = if let Some(p) = &slots.anki_card {
        (p, SlotKind::AnkiCard, false)
    } else if let Some(p) = &slots.main {
        (p, SlotKind::MainModel, true)
    } else if let Some(p) = &slots.vision {
        (p, SlotKind::Vision, true)
    } else {
        return None;
    };

    if mode == RoutingMode::Single {
        let make = |role: AnkiModelRole| {
            decision_from(
                role,
                base_probe,
                base_slot,
                base_degraded,
                "single 模式：全部角色使用基准制卡模型",
            )
        };
        return Some(AnkiRoutingPlan {
            mode,
            planner: make(AnkiModelRole::Planner),
            generator: make(AnkiModelRole::Generator),
            critic: make(AnkiModelRole::Critic),
            vlm: make(AnkiModelRole::Vlm),
        });
    }

    // Generator：廉价批量生成 = 基准链
    let generator = decision_from(
        AnkiModelRole::Generator,
        base_probe,
        base_slot,
        base_degraded,
        if base_degraded {
            "制卡槽未配置，降级到可用槽位"
        } else {
            "制卡槽（批量生成首选）"
        },
    );

    // Planner / Critic：较强模型 = 主模型槽优先，缺失降级到基准模型
    let strong = |role: AnkiModelRole| -> RoleDecision {
        if let Some(p) = &slots.main {
            decision_from(role, p, SlotKind::MainModel, false, "主模型槽（较强模型）")
        } else {
            decision_from(
                role,
                base_probe,
                base_slot,
                true,
                "主模型槽未配置，降级到基准制卡模型",
            )
        }
    };
    let planner = strong(AnkiModelRole::Planner);
    let critic = strong(AnkiModelRole::Critic);

    // Vlm：视觉槽优先，缺失降级到 Generator 模型
    let vlm = if let Some(p) = &slots.vision {
        decision_from(
            AnkiModelRole::Vlm,
            p,
            SlotKind::Vision,
            false,
            "视觉槽（多模态模型）",
        )
    } else {
        decision_from(
            AnkiModelRole::Vlm,
            base_probe,
            base_slot,
            true,
            "无可用多模态模型，降级到 Generator 模型（调用方应跳过图像输入）",
        )
    };

    Some(AnkiRoutingPlan {
        mode,
        planner,
        generator,
        critic,
        vlm,
    })
}

// ============================================================
// 单元测试
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(id: &str, model: &str, multimodal: bool, reasoning: bool) -> SlotProbe {
        SlotProbe {
            config_id: id.to_string(),
            model: model.to_string(),
            is_multimodal: multimodal,
            is_reasoning: reasoning,
        }
    }

    fn full_slots() -> AnkiRoutingSlots {
        AnkiRoutingSlots {
            anki_card: Some(probe("cfg-cheap", "cheap-flash", false, false)),
            main: Some(probe("cfg-strong", "strong-pro", false, true)),
            vision: Some(probe("cfg-vlm", "vision-vl", true, false)),
        }
    }

    fn config(id: &str, model: &str) -> ApiConfig {
        ApiConfig {
            id: id.to_string(),
            model: model.to_string(),
            enabled: true,
            ..ApiConfig::default()
        }
    }

    fn assignments(
        anki: Option<&str>,
        model2: Option<&str>,
        ocr: Option<&str>,
    ) -> ModelAssignments {
        serde_json::from_str::<ModelAssignments>("{}").map_or_else(
            |_| panic!("ModelAssignments 必须支持空对象反序列化"),
            |mut a| {
                a.anki_card_model_config_id = anki.map(str::to_string);
                a.model2_config_id = model2.map(str::to_string);
                a.exam_sheet_ocr_model_config_id = ocr.map(str::to_string);
                a
            },
        )
    }

    // ---------- 路由模式解析 ----------

    #[test]
    fn mode_defaults_to_auto() {
        // 旧版 options（无扩展字段）
        assert_eq!(
            parse_routing_mode(r#"{"deck_name":"d","note_type":"Basic"}"#),
            RoutingMode::Auto
        );
        // 空对象 / 非法 JSON 同样回退 Auto
        assert_eq!(parse_routing_mode("{}"), RoutingMode::Auto);
        assert_eq!(parse_routing_mode("not json"), RoutingMode::Auto);
    }

    #[test]
    fn mode_parses_single_and_aliases() {
        assert_eq!(
            parse_routing_mode(r#"{"sidekick_model_routing":"single"}"#),
            RoutingMode::Single
        );
        assert_eq!(
            parse_routing_mode(r#"{"sidekick_model_routing":"OFF"}"#),
            RoutingMode::Single
        );
        assert_eq!(
            parse_routing_mode(r#"{"sidekick_model_routing":" disabled "}"#),
            RoutingMode::Single
        );
        // 显式 auto 与未知值都是 Auto
        assert_eq!(
            parse_routing_mode(r#"{"sidekick_model_routing":"auto"}"#),
            RoutingMode::Auto
        );
        assert_eq!(
            parse_routing_mode(r#"{"sidekick_model_routing":"whatever"}"#),
            RoutingMode::Auto
        );
    }

    // ---------- Auto 模式：槽位齐全 ----------

    #[test]
    fn full_slots_assign_roles_by_strength() {
        let plan = plan_routing(RoutingMode::Auto, &full_slots()).expect("plan");
        assert_eq!(plan.planner.config_id, "cfg-strong");
        assert_eq!(plan.planner.slot, SlotKind::MainModel);
        assert!(!plan.planner.degraded);

        assert_eq!(plan.generator.config_id, "cfg-cheap");
        assert_eq!(plan.generator.slot, SlotKind::AnkiCard);
        assert!(!plan.generator.degraded);

        assert_eq!(plan.critic.config_id, "cfg-strong");
        assert!(!plan.critic.degraded);

        assert_eq!(plan.vlm.config_id, "cfg-vlm");
        assert_eq!(plan.vlm.slot, SlotKind::Vision);
        assert!(plan.vlm.is_multimodal);
        assert!(!plan.vlm.degraded);

        assert_eq!(plan.distinct_config_count(), 3);
    }

    // ---------- Auto 模式：缺槽位降级 ----------

    #[test]
    fn missing_main_degrades_planner_and_critic_to_anki_slot() {
        let mut slots = full_slots();
        slots.main = None;
        let plan = plan_routing(RoutingMode::Auto, &slots).expect("plan");
        assert_eq!(plan.planner.config_id, "cfg-cheap");
        assert_eq!(plan.planner.slot, SlotKind::AnkiCard);
        assert!(plan.planner.degraded);
        assert_eq!(plan.critic.config_id, "cfg-cheap");
        assert!(plan.critic.degraded);
        // Generator 不受影响
        assert!(!plan.generator.degraded);
    }

    #[test]
    fn missing_anki_slot_degrades_generator_to_main() {
        let mut slots = full_slots();
        slots.anki_card = None;
        let plan = plan_routing(RoutingMode::Auto, &slots).expect("plan");
        assert_eq!(plan.generator.config_id, "cfg-strong");
        assert_eq!(plan.generator.slot, SlotKind::MainModel);
        assert!(plan.generator.degraded);
        // Planner/Critic 仍用主模型且不算降级
        assert!(!plan.planner.degraded);
    }

    #[test]
    fn missing_vision_degrades_vlm_to_generator_model() {
        let mut slots = full_slots();
        slots.vision = None;
        let plan = plan_routing(RoutingMode::Auto, &slots).expect("plan");
        assert_eq!(plan.vlm.config_id, plan.generator.config_id);
        assert!(plan.vlm.degraded);
        // 降级目标是纯文本模型：调用方据 is_multimodal=false 跳过图像输入
        assert!(!plan.vlm.is_multimodal);
    }

    #[test]
    fn single_configured_model_serves_all_roles() {
        let slots = AnkiRoutingSlots {
            anki_card: Some(probe("only", "only-model", false, false)),
            main: None,
            vision: None,
        };
        let plan = plan_routing(RoutingMode::Auto, &slots).expect("plan");
        for role in AnkiModelRole::ALL {
            assert_eq!(plan.decision(role).config_id, "only");
        }
        assert_eq!(plan.distinct_config_count(), 1);
        // Generator 用的是首选槽位，不算降级；其余角色是降级
        assert!(!plan.generator.degraded);
        assert!(plan.planner.degraded);
        assert!(plan.critic.degraded);
        assert!(plan.vlm.degraded);
    }

    #[test]
    fn empty_slots_yield_no_plan() {
        assert!(plan_routing(RoutingMode::Auto, &AnkiRoutingSlots::default()).is_none());
        assert!(plan_routing(RoutingMode::Single, &AnkiRoutingSlots::default()).is_none());
        assert!(AnkiRoutingSlots::default().is_empty());
    }

    #[test]
    fn only_vision_slot_still_produces_plan() {
        // 极端配置：只配了一个多模态模型 —— 全角色都用它，制卡不中断
        let slots = AnkiRoutingSlots {
            anki_card: None,
            main: None,
            vision: Some(probe("cfg-vlm", "vision-vl", true, false)),
        };
        let plan = plan_routing(RoutingMode::Auto, &slots).expect("plan");
        for role in AnkiModelRole::ALL {
            assert_eq!(plan.decision(role).config_id, "cfg-vlm");
        }
        assert!(plan.generator.degraded);
        assert!(!plan.vlm.degraded); // 视觉角色用视觉槽是首选，不算降级
    }

    // ---------- Single 模式 ----------

    #[test]
    fn single_mode_uses_base_model_for_all_roles() {
        let plan = plan_routing(RoutingMode::Single, &full_slots()).expect("plan");
        for role in AnkiModelRole::ALL {
            assert_eq!(plan.decision(role).config_id, "cfg-cheap");
            assert_eq!(plan.decision(role).slot, SlotKind::AnkiCard);
        }
        assert_eq!(plan.distinct_config_count(), 1);
    }

    // ---------- 可观测性：结构体序列化 ----------

    #[test]
    fn plan_serializes_with_all_roles_and_reasons() {
        let plan = plan_routing(RoutingMode::Auto, &full_slots()).expect("plan");
        let raw = serde_json::to_string(&plan).expect("serialize");
        for key in [
            "planner",
            "generator",
            "critic",
            "vlm",
            "reason",
            "degraded",
        ] {
            assert!(raw.contains(key), "序列化结果缺少字段: {}", key);
        }
        let back: AnkiRoutingPlan = serde_json::from_str(&raw).expect("roundtrip");
        assert_eq!(back, plan);
        // debug 日志路径不 panic
        plan.log_debug();
    }

    // ---------- 槽位构建（build_slots 纯函数） ----------

    #[test]
    fn build_slots_resolves_configured_assignments() {
        let configs = vec![config("cfg-cheap", "cheap-flash"), {
            let mut c = config("cfg-strong", "strong-pro");
            c.is_reasoning = true;
            c
        }];
        let slots = build_slots(
            &assignments(Some("cfg-cheap"), Some("cfg-strong"), None),
            &configs,
        );
        assert_eq!(slots.anki_card.as_ref().unwrap().config_id, "cfg-cheap");
        let main = slots.main.as_ref().unwrap();
        assert_eq!(main.config_id, "cfg-strong");
        assert!(main.is_reasoning);
        // 无多模态配置 → 无视觉槽
        assert!(slots.vision.is_none());
    }

    #[test]
    fn build_slots_skips_disabled_and_non_text_configs() {
        let mut disabled = config("cfg-cheap", "cheap-flash");
        disabled.enabled = false;
        let mut embedding = config("cfg-embed", "embed-v1");
        embedding.is_embedding = true;
        embedding.is_multimodal = true; // 多模态嵌入不得被当作视觉槽
        let configs = vec![disabled, embedding];
        let slots = build_slots(
            &assignments(Some("cfg-cheap"), Some("cfg-embed"), None),
            &configs,
        );
        assert!(slots.anki_card.is_none(), "禁用配置不得成为槽位");
        assert!(slots.main.is_none(), "嵌入模型不得成为文本槽位");
        assert!(slots.vision.is_none(), "嵌入模型不得成为视觉槽位");
        assert!(slots.is_empty());
    }

    #[test]
    fn build_slots_vision_prefers_ocr_assignment_then_falls_back() {
        let mut ocr = config("cfg-ocr", "ocr-vl");
        ocr.is_multimodal = true;
        let mut other_vlm = config("cfg-other-vlm", "other-vl");
        other_vlm.is_multimodal = true;
        let configs = vec![config("cfg-cheap", "cheap-flash"), ocr, other_vlm];

        // 1. 显式 OCR 槽优先
        let slots = build_slots(
            &assignments(Some("cfg-cheap"), None, Some("cfg-ocr")),
            &configs,
        );
        assert_eq!(slots.vision.as_ref().unwrap().config_id, "cfg-ocr");

        // 2. 未配置 OCR 槽：回退到任一已启用多模态配置（列表顺序确定性）
        let slots = build_slots(&assignments(Some("cfg-cheap"), None, None), &configs);
        assert_eq!(slots.vision.as_ref().unwrap().config_id, "cfg-ocr");
    }

    #[test]
    fn build_slots_vision_uses_multimodal_main_or_anki_before_stranger_configs() {
        let mut mm_main = config("cfg-mm-main", "mm-main");
        mm_main.is_multimodal = true;
        let mut stranger = config("cfg-stranger", "stranger-vl");
        stranger.is_multimodal = true;
        // stranger 排在前面，但主模型槽自身多模态应优先
        let configs = vec![stranger, mm_main];
        let slots = build_slots(&assignments(None, Some("cfg-mm-main"), None), &configs);
        assert_eq!(slots.vision.as_ref().unwrap().config_id, "cfg-mm-main");
        // 主模型槽多模态时：planner 与 vlm 同模型，且都不算降级
        let plan = plan_routing(RoutingMode::Auto, &slots).expect("plan");
        assert_eq!(plan.vlm.config_id, "cfg-mm-main");
        assert!(!plan.vlm.degraded);
        assert!(plan.vlm.is_multimodal);
    }

    #[test]
    fn build_slots_missing_assignment_ids_are_ignored() {
        let configs = vec![config("cfg-a", "model-a")];
        // 分配指向不存在的 id：静默忽略，不 panic
        let slots = build_slots(
            &assignments(Some("ghost"), Some("cfg-a"), Some("ghost-2")),
            &configs,
        );
        assert!(slots.anki_card.is_none());
        assert_eq!(slots.main.as_ref().unwrap().config_id, "cfg-a");
    }

    // ---------- 端到端纯逻辑：探测 → 计划 ----------

    #[test]
    fn probe_to_plan_pipeline_prefers_cheap_generator_and_strong_planner() {
        let mut strong = config("cfg-strong", "strong-pro");
        strong.is_reasoning = true;
        strong.is_multimodal = true;
        let configs = vec![config("cfg-cheap", "cheap-flash"), strong];
        let slots = build_slots(
            &assignments(Some("cfg-cheap"), Some("cfg-strong"), None),
            &configs,
        );
        let plan = plan_routing(parse_routing_mode("{}"), &slots).expect("plan");
        assert_eq!(plan.generator.config_id, "cfg-cheap");
        assert_eq!(plan.planner.config_id, "cfg-strong");
        assert_eq!(plan.critic.config_id, "cfg-strong");
        // 主模型多模态 → 视觉槽复用主模型
        assert_eq!(plan.vlm.config_id, "cfg-strong");
        assert_eq!(plan.distinct_config_count(), 2);
    }

    // ---------- Planner / Vlm 生产消费的降级矩阵 ----------

    #[test]
    fn only_main_keeps_planner_primary_and_degrades_generator_and_vlm() {
        let slots = AnkiRoutingSlots {
            anki_card: None,
            main: Some(probe("cfg-main", "main", false, true)),
            vision: None,
        };
        let plan = plan_routing(RoutingMode::Auto, &slots).expect("plan");

        assert_eq!(plan.planner.slot, SlotKind::MainModel);
        assert!(!plan.planner.degraded);
        assert_eq!(plan.generator.config_id, "cfg-main");
        assert!(plan.generator.degraded);
        assert_eq!(plan.vlm.config_id, "cfg-main");
        assert!(plan.vlm.degraded);
    }

    #[test]
    fn multimodal_main_can_serve_planner_and_vlm_as_one_config() {
        let main = probe("cfg-main-vl", "main-vl", true, true);
        let slots = AnkiRoutingSlots {
            anki_card: None,
            main: Some(main.clone()),
            vision: Some(main),
        };
        let plan = plan_routing(RoutingMode::Auto, &slots).expect("plan");

        assert_eq!(plan.planner.slot, SlotKind::MainModel);
        assert_eq!(plan.vlm.slot, SlotKind::Vision);
        assert!(!plan.planner.degraded);
        assert!(!plan.vlm.degraded);
        assert_eq!(plan.distinct_config_count(), 1);
    }

    #[test]
    fn missing_anki_with_distinct_vision_preserves_role_specific_slots() {
        let slots = AnkiRoutingSlots {
            anki_card: None,
            main: Some(probe("cfg-main", "main", false, true)),
            vision: Some(probe("cfg-vlm", "vlm", true, false)),
        };
        let plan = plan_routing(RoutingMode::Auto, &slots).expect("plan");

        assert_eq!(plan.generator.slot, SlotKind::MainModel);
        assert!(plan.generator.degraded);
        assert_eq!(plan.planner.slot, SlotKind::MainModel);
        assert!(!plan.planner.degraded);
        assert_eq!(plan.vlm.slot, SlotKind::Vision);
        assert!(!plan.vlm.degraded);
    }

    #[test]
    fn missing_main_keeps_generator_and_vlm_on_their_own_slots() {
        let slots = AnkiRoutingSlots {
            anki_card: Some(probe("cfg-anki", "anki", false, false)),
            main: None,
            vision: Some(probe("cfg-vlm", "vlm", true, false)),
        };
        let plan = plan_routing(RoutingMode::Auto, &slots).expect("plan");

        assert_eq!(plan.planner.config_id, plan.generator.config_id);
        assert!(plan.planner.degraded);
        assert!(!plan.generator.degraded);
        assert_eq!(plan.vlm.slot, SlotKind::Vision);
        assert!(!plan.vlm.degraded);
    }

    #[test]
    fn duplicate_config_ids_are_deduplicated_without_losing_slot_identity() {
        let shared = probe("cfg-shared", "shared-vl", true, true);
        let slots = AnkiRoutingSlots {
            anki_card: Some(shared.clone()),
            main: Some(shared.clone()),
            vision: Some(shared),
        };
        let plan = plan_routing(RoutingMode::Auto, &slots).expect("plan");

        assert_eq!(plan.planner.slot, SlotKind::MainModel);
        assert_eq!(plan.generator.slot, SlotKind::AnkiCard);
        assert_eq!(plan.vlm.slot, SlotKind::Vision);
        assert_eq!(plan.distinct_config_count(), 1);
    }

    #[test]
    fn single_mode_with_only_vision_marks_every_role_as_base_degraded() {
        let slots = AnkiRoutingSlots {
            anki_card: None,
            main: None,
            vision: Some(probe("cfg-vlm", "vlm", true, false)),
        };
        let plan = plan_routing(RoutingMode::Single, &slots).expect("plan");

        for role in AnkiModelRole::ALL {
            let decision = plan.decision(role);
            assert_eq!(decision.config_id, "cfg-vlm");
            assert_eq!(decision.slot, SlotKind::Vision);
            assert!(decision.degraded);
        }
    }

    // ---------- 生产消费者接线契约（收尾续作 #3） ----------

    #[test]
    fn chatanki_plan_route_consumes_planner_role_through_fallback_adapter() {
        let source = include_str!("chat_v2/tools/chatanki_executor.rs");
        let start = source
            .find("async fn plan_route(")
            .expect("plan_route production function must exist");
        let end = source[start..]
            .find("/// 在 VLM 路径消费")
            .map(|offset| start + offset)
            .expect("VLM helper must follow plan_route");
        let function = &source[start..end];

        assert!(
            function.contains("AnkiModelRole::Planner"),
            "plan_route 必须显式消费 Planner 角色"
        );
        assert!(
            function.contains(".call_anki_routed_raw_prompt("),
            "Planner 调用必须经过可回退的 Sidekick 适配器"
        );
        let routed_call = function
            .find(".call_anki_routed_raw_prompt(")
            .expect("routed Planner call");
        let legacy_fallback = function
            .find(".call_model2_raw_prompt(")
            .expect("legacy model2 fallback");
        assert!(
            routed_call < legacy_fallback && function.contains("planner_decision.is_some()"),
            "model2 只能在 Planner 槽调用失败后作为旧路径兜底"
        );
        assert!(
            function.contains("return None;"),
            "Planner 调用失败必须保留启发式路由降级"
        );
    }

    #[test]
    fn chatanki_vlm_extract_branches_consume_vlm_role_through_fallback_adapter() {
        let source = include_str!("chat_v2/tools/chatanki_executor.rs");
        let start = source
            .find("async fn call_vlm_extract(")
            .expect("VLM production helper must exist");
        let end = source[start..]
            .find("/// 防注入护栏")
            .map(|offset| start + offset)
            .expect("prompt guard must follow VLM helper");
        let helper = &source[start..end];

        assert!(
            helper.contains("AnkiModelRole::Vlm"),
            "VLM extract 必须显式消费 Vlm 角色"
        );
        assert!(
            helper.contains(".call_anki_routed_raw_prompt("),
            "VLM 调用必须经过可回退的 Sidekick 适配器"
        );
        let routed_call = helper
            .find(".call_anki_routed_raw_prompt(")
            .expect("routed VLM call");
        let legacy_fallback = helper
            .find(".call_model2_raw_prompt(")
            .expect("legacy model2 fallback");
        assert!(
            routed_call < legacy_fallback && helper.contains("vlm_decision.is_some()"),
            "model2 只能在 Vlm 槽调用失败后作为旧图片提取路径兜底"
        );
        assert_eq!(
            source.matches("call_vlm_extract(").count(),
            4,
            "应有一个 helper 定义和三条真实 VLM extract 调用路径"
        );
        for task in [
            "chatanki.vlm_full_image_fallback",
            "chatanki.vlm_light_extract",
            "chatanki.vlm_full_extract",
        ] {
            assert!(
                source.contains(task),
                "VLM 生产调用缺少可观测任务标签: {}",
                task
            );
        }
    }
}
