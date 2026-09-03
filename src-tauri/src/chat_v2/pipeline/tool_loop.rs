//! 工具环执行（`execute_with_tools`）与 prompt-cache「工具面冻结」原语区。
//!
//! # 冻结矩阵速查（完整矩阵见 `docs/dev/wave2-A/r2-freeze-matrix.md`，
//! 冻/不冻 + 清/不清终稿见 `docs/dev/wave2-A/r9-clear-freeze-matrix.md`）
//!
//! **冻什么**（三层，粒度由粗到细）：
//! - **tools 名字序** —— 会话级、append-only 首见序基线
//!   （[`freeze_tool_schema_order_for_prompt_cache`] +
//!   [`merge_frozen_tool_schema_order_baseline`]，经 helpers 的
//!   `load/store_session_frozen_tool_schema_order` 持久化到
//!   session.metadata `frozenToolSchemaOrder` 键）：已发出工具的相对
//!   顺序跨轮、跨进程不变，新工具只按首见轮次追加末尾，禁止字母序
//!   插入已发出前缀中段（对 Anthropic 那是 tools 第 0 字节起变化）；
//! - **已发出 schema 字节** —— 窗口级（一次 `execute_with_tools` 工具环
//!   或一个多变体变体环 = 一个稳定窗口，
//!   [`freeze_tool_schemas_for_prompt_cache`]）：同名 schema 窗口内变化
//!   （MCP 刷新 / load_skills 披露不同版本）时继续发送首见冻结字节，
//!   变更延迟到下一稳定窗口生效；摘要见 [`tool_schema_digest`]
//!   （持久化键 `toolSchemaDigest`，缺省 None 不构成变更）；
//! - **generation 代号** —— 会话级单调（`helpers::ToolFaceBaseline`，
//!   持久化键 `toolFacePrefixGeneration`）：本文件只随基线原样透传，
//!   任何单变体路径都无权 bump。
//!
//! **不冻什么**（明确豁免，勿在本文件加冻结）：
//! - 技能正文（transient 注入消息体）—— 正文字节仍不落库；本文件只做
//!   轮内位置锚定（P1-8 `frozen_turn_skill_injection`）并随锚点持久化
//!   正文摘要（anchors `skill_content_digests` / `skill_content_rev`，
//!   r3 落地）。重放由 history 侧 digest 门禁把关：mismatch →
//!   warn+skip+切代信号，绝不用当轮新正文伪装旧历史；删除 / 正文缺失
//!   同样 warn+skip 但**不进信号**（r5 刻意收窄，反例留档见
//!   skill_replay_edit_delete_tests）；
//! - available_skills 目录换代 —— 首写冻结快照（repo
//!   `freeze_session_available_skills_snapshot`）+ 独立目录代
//!   `availableSkillsSnapshotGeneration` / 换代声明
//!   `availableSkillsSnapshotPendingGeneration`（r4–r5 落地）。目录
//!   换代走目录代，**不走**本文件的 tool-face generation，两套代际
//!   互不搭线；
//! - system 前缀内 user_profile 等易变段 —— prompt_builder 侧语义，
//!   每轮可随记忆库变化，明确不冻。
//!
//! **代际何时切**（唯一切代点 = fan-out join 收敛
//! `helpers::converge_session_tool_face_prefix`）：
//! - ≥2 变体本地 order 互异、不可 append-only 对齐（存在变体本地
//!   order 不是收敛结果的前缀）→ 真分叉，`generation += 1`；这仍是
//!   tool-face generation **唯一** bump 来源；
//! - 单变体纯前缀扩展 / 窗口 digest 变化 → **不切代**：本文件单变体
//!   路径只打日志（见 [`freeze_tool_face_for_prompt_cache`] 调用处），
//!   变更随下一稳定窗口 / 多变体 converge 评估；
//! - digest 共识采纳（r6 接线）：converge 仅当存在「本地 order ==
//!   收敛 order」的变体、且这些变体报告的 digest 全部一致，才把该
//!   digest 写入基线；真分叉 / digest 互异 / 全空（None）保持既有值，
//!   None 永不抹掉——采纳本身绝不触发 bump；
//! - 技能 digest mismatch 信号不在这里切代：走 available_skills 目录代
//!   （`helpers::record_skill_digest_prefix_generation_signal` → pending
//!   generation 声明），绝不伪造工具面分叉逼 converge +1。

use super::*;

use super::super::context::{DoomLoopGuard, DoomLoopVerdict, DOOM_LOOP_ABORT_THRESHOLD};

#[derive(Debug, Clone)]
pub(crate) struct ExternalToolRoute {
    pub raw_tool_name: String,
    pub preferred_server_id: Option<String>,
}

/// G6 排序键：工具 schema 为 OpenAI function 格式
/// `{"type":"function","function":{"name":...}}`，名字在 `function.name`；
/// 顶层 `name` 仅作非标准 schema 的回退。此前只读顶层 name，
/// function 格式下恒为 ""，排序退化为 no-op。
pub(crate) fn tool_schema_sort_key(tool: &Value) -> &str {
    tool.get("function")
        .and_then(|function| function.get("name"))
        .and_then(|name| name.as_str())
        .or_else(|| tool.get("name").and_then(|name| name.as_str()))
        .unwrap_or("")
}

/// Prompt cache（G6）：工具 schema 确定性排序。Anthropic 等 provider 将
/// tools 纳入缓存前缀，顺序跨轮漂移会整段打爆缓存；对不计前缀的
/// provider 稳定排序亦无害。
pub(crate) fn sort_tool_schemas_for_prompt_cache(tools: &mut [Value]) {
    tools.sort_by(|a, b| tool_schema_sort_key(a).cmp(tool_schema_sort_key(b)));
}

/// Prompt cache（P0，DESIGN「tools 会话内冻结 + append-only」）：工具环
/// 生命周期内 tools 顺序冻结。首轮按名字排序建立基线（G6 确定性）；
/// 后续轮次已发出的工具严格保持基线相对顺序（前缀字节不变），环内
/// load_skills 渐进披露的新工具按首见轮次追加到末尾（同轮新增按名字
/// 排序保证确定性），并记入基线供之后轮次复用。禁止按字母序插入中段
/// —— 对 Anthropic 那是 tools 第 0 字节起变化，整段缓存前缀失效。
///
/// `frozen_names` 由调用方在环外持有（append-only 首见序基线），
/// 空表示首轮尚未建立基线。
pub(crate) fn freeze_tool_schema_order_for_prompt_cache(
    tools: &mut [Value],
    frozen_names: &mut Vec<String>,
) {
    if frozen_names.is_empty() {
        sort_tool_schemas_for_prompt_cache(tools);
    } else {
        let frozen_index: std::collections::HashMap<&str, usize> = frozen_names
            .iter()
            .enumerate()
            .map(|(index, name)| (name.as_str(), index))
            .collect();
        // stable sort：基线内按冻结序，新工具排在全部基线之后、彼此按名字
        tools.sort_by(|a, b| {
            let key_a = tool_schema_sort_key(a);
            let key_b = tool_schema_sort_key(b);
            match (frozen_index.get(key_a), frozen_index.get(key_b)) {
                (Some(index_a), Some(index_b)) => index_a.cmp(index_b),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => key_a.cmp(key_b),
            }
        });
    }
    for tool in tools.iter() {
        let key = tool_schema_sort_key(tool);
        if key.is_empty() {
            continue;
        }
        if !frozen_names.iter().any(|name| name == key) {
            frozen_names.push(key.to_string());
        }
    }
}

/// P0 tools 会话冻结：把一次执行推进后的局部基线合并回会话级基线。
/// append-only：只把 `entry` 缺失的名字按 `baseline` 顺序追加到末尾，
/// 绝不删除或重排 `entry` 已有条目 —— 并行变体各自写回时共享基线保持
/// 单调，已发出的 tools 前缀序不被打乱。
pub(crate) fn merge_frozen_tool_schema_order_baseline(
    entry: &mut Vec<String>,
    baseline: &[String],
) {
    for name in baseline {
        if !entry.iter().any(|existing| existing == name) {
            entry.push(name.clone());
        }
    }
}

/// P0 tools 冻结（字节级加强）：在名字序冻结之上，把已发出工具的
/// **schema 序列化字节**在稳定窗口内冻结。
///
/// - 首见工具：记入 `frozen_schemas`（名字 → 首次发出的完整 schema）；
/// - 已发出工具：无条件回写冻结副本 —— 同名 schema 在窗口内变化
///   （MCP 服务器刷新、load_skills 重复披露不同版本）时本窗口继续发送
///   冻结字节，变更延迟到下一稳定窗口（`frozen_schemas` 重建时）生效。
///   注意 serde_json 开启 preserve_order：键序不同的 Value 可以 `==` 相等
///   但序列化字节不同，所以不能只在 `!=` 时回写，必须无条件回写才能
///   保证已发出前缀逐字节不变；
/// - 新工具只追加：顺序由 `freeze_tool_schema_order_for_prompt_cache`
///   的 append-only 首见序基线保证，禁止插入已发出前缀中段。
///
/// `frozen_schemas` 由调用方按稳定窗口持有（一次 `execute_with_tools`
/// 工具环 = 一个稳定窗口）：窗口内字节冻结，跨窗口允许采纳新字节。
/// 名字序基线（`frozen_names`）仍按会话级持有/持久化，两者分工不同。
///
/// digest 计算见 [`tool_schema_digest`]；单变体路径 digest 变化**不切代**
/// （generation 不 bump），变更随下一稳定窗口 / 多变体 converge 评估。
pub(crate) fn freeze_tool_schemas_for_prompt_cache(
    tools: &mut [Value],
    frozen_names: &mut Vec<String>,
    frozen_schemas: &mut HashMap<String, Value>,
) {
    freeze_tool_schema_order_for_prompt_cache(tools, frozen_names);
    for tool in tools.iter_mut() {
        let key = tool_schema_sort_key(tool).to_string();
        if key.is_empty() {
            continue;
        }
        match frozen_schemas.get(&key) {
            Some(frozen) => {
                if frozen != tool {
                    log::info!(
                        "[ChatV2::pipeline] Tool schema for '{}' changed mid-window; \
                         serving frozen bytes, deferring change to next stable window",
                        key
                    );
                }
                *tool = frozen.clone();
            }
            None => {
                frozen_schemas.insert(key, tool.clone());
            }
        }
    }
}

/// 代际统一冻结原语（Wave2-A r2，供本文件与 #3 统一入口复用）：
/// 当前稳定窗口字节冻结快照（`frozen_schemas`）的 schema digest。
///
/// 算法：按工具**名字序**遍历冻结副本，逐项以
/// `名字 + 0x1f + schema JSON 序列化字节 + 0x1e` 喂入 sha256
/// （复用 `DoomLoopGuard::fingerprint` 的 0x1f 分隔骨架；serde_json
/// preserve_order 下冻结副本的序列化字节窗口内稳定，digest 可靠），
/// 输出小写十六进制。名字序遍历保证与 HashMap 迭代序无关，同一冻结
/// 内容恒得同一 digest。
///
/// 空窗口（本窗口尚未发出任何工具）返回 `None` —— 与
/// `ToolFacePrefixSnapshot::schema_digest` 的缺省语义对齐（缺 digest
/// 不构成变更，不得抹掉已持久化值）。
pub(crate) fn tool_schema_digest(frozen_schemas: &HashMap<String, Value>) -> Option<String> {
    if frozen_schemas.is_empty() {
        return None;
    }
    let mut entries: Vec<(&String, &Value)> = frozen_schemas.iter().collect();
    entries.sort_by_key(|(name, _)| *name);
    let mut hasher = Sha256::new();
    for (name, schema) in entries {
        hasher.update(name.as_bytes());
        hasher.update(b"\x1f");
        hasher.update(serde_json::to_string(schema).unwrap_or_default().as_bytes());
        hasher.update(b"\x1e");
    }
    Some(format!("{:x}", hasher.finalize()))
}

/// 统一冻结原语（Wave2-A r2 #3 门面）：单变体 tool_loop 与多变体
/// variant 环共用的「名字序冻结 + 字节冻结 + digest」单入口。
///
/// 内部即 [`freeze_tool_schemas_for_prompt_cache`]（append-only 首见序
/// 基线 + 已发出 schema 窗口内字节回写，语义逐字不变），随后返回
/// [`tool_schema_digest`] 计算的当前窗口冻结快照摘要：
/// - `Some(digest)`：本窗口已发出至少一个工具，digest 为名字序稳定哈希；
/// - `None`：空窗口（尚未发出任何工具），与
///   `ToolFacePrefixSnapshot::schema_digest` 缺省语义对齐 —— 调用方
///   不得用 None 抹掉已有 digest。
///
/// 这是新门面而非替代：[`freeze_tool_schema_order_for_prompt_cache`] /
/// [`freeze_tool_schemas_for_prompt_cache`] 仍为公开原语（测试与其他
/// 调用方在用）。digest 变化的处置由调用方决定：单变体只打日志不切代，
/// 多变体写入 `VariantMeta.tool_face_prefix` 交 join 收敛点评估。
pub(crate) fn freeze_tool_face_for_prompt_cache(
    tools: &mut [Value],
    frozen_names: &mut Vec<String>,
    frozen_schemas: &mut HashMap<String, Value>,
) -> Option<String> {
    freeze_tool_schemas_for_prompt_cache(tools, frozen_names, frozen_schemas);
    tool_schema_digest(frozen_schemas)
}

/// Responses reasoning items 工具轮写入：adapter 已按「相邻后继
/// function_call」配好 `(tool_call_id, item)`，逐条按 tool_call_id 键控
/// 写入（禁止全部绑到本批第一个 tool id）。未配对残留条目（provider
/// 把 reasoning item 发在所有 function_call 之后等异常时序）兜底挂到
/// `fallback_tool_call_id`（本批第一个 tool_call），用 `or_insert` 只在
/// 该 id 尚无 reasoning item 时写入 —— 绝不覆盖已配对条目。
pub(crate) fn assign_tool_round_reasoning_items(
    dest: &mut HashMap<String, Value>,
    items: Vec<(Option<String>, Value)>,
    fallback_tool_call_id: Option<&str>,
) {
    for (paired_tool_call_id, item) in items {
        match paired_tool_call_id {
            Some(tool_call_id) => {
                dest.insert(tool_call_id, item);
            }
            None => {
                if let Some(fallback_id) = fallback_tool_call_id {
                    dest.entry(fallback_id.to_string()).or_insert(item);
                }
            }
        }
    }
}

/// Responses reasoning items 纯文本终轮写入：无 tool_call_id 可键控的
/// 未配对条目挂到哨兵键 [`crate::chat_v2::types::RESPONSES_FINAL_REASONING_KEY`]
/// 持久化；history 重放附到最终 assistant 文本消息 metadata，下一轮
/// Responses input 原样回传 encrypted reasoning。多条未配对时后到覆盖
/// （最贴近最终正文的 item 生效）；已配对条目仍按 tool_call_id 写入。
pub(crate) fn assign_final_round_reasoning_items(
    dest: &mut HashMap<String, Value>,
    items: Vec<(Option<String>, Value)>,
) {
    for (paired_tool_call_id, item) in items {
        let key = paired_tool_call_id
            .unwrap_or_else(|| crate::chat_v2::types::RESPONSES_FINAL_REASONING_KEY.to_string());
        dest.insert(key, item);
    }
}

/// Retain usage reported before a failed terminal event. Responses providers
/// commonly emit usage immediately before `response.incomplete`/`failed`;
/// losing it here would make persisted message metadata and billing logs show 0.
fn retain_failed_round_usage(
    total_usage: &mut TokenUsage,
    reported_usage: Option<TokenUsage>,
) -> Option<TokenUsage> {
    let reported_usage = reported_usage.filter(TokenUsage::has_tokens);
    if let Some(usage) = reported_usage.as_ref() {
        total_usage.accumulate(usage);
    }
    reported_usage
}

/// 🔧 P1-3 修复：stream hooks 的 RAII 注销守卫。
///
/// 外层 `tokio::select!` 命中取消分支时会直接 drop 整个 `execute_with_tools`
/// future，导致函数体内的显式 `unregister_stream_hooks` 永远不会执行，
/// `hooks_registry` 中残留 `Arc<ChatV2LLMAdapter>`（内含 emitter/Window 引用）。
/// 本守卫在 Drop 时向运行时补一次异步注销。每次 pipeline 执行使用独立 run key，
/// 因而旧任务的延迟注销不可能命中取消后立即启动、且复用 assistant message ID 的新任务。
pub(crate) struct StreamHooksGuard {
    llm_manager: Arc<LLMManager>,
    stream_event: String,
    owner: Arc<dyn LLMStreamHooks>,
    armed: bool,
}

/// Build a hook/cancel-channel key scoped to one concrete pipeline execution.
///
/// The `_var_` delimiter remains before the run-scoped suffix so model2 reconnect routing can
/// recover the original session ID with `rsplit_once("_var_")`.
pub(crate) fn build_run_scoped_stream_event(
    session_id: &str,
    stream_scope_id: &str,
    run_id: &str,
    stream_generation: Option<u64>,
) -> String {
    let base = format!(
        "chat_v2_event_{}_var_{}_run_{}",
        session_id, stream_scope_id, run_id
    );
    match stream_generation {
        Some(generation) => format!(
            "{}{}{}",
            base,
            crate::llm_manager::CHAT_V2_STREAM_GENERATION_MARKER,
            generation
        ),
        None => base,
    }
}

impl StreamHooksGuard {
    pub(crate) fn new(
        llm_manager: Arc<LLMManager>,
        stream_event: String,
        owner: Arc<dyn LLMStreamHooks>,
    ) -> Self {
        Self {
            llm_manager,
            stream_event,
            owner,
            armed: true,
        }
    }

    /// 正常路径已显式注销后调用，避免 Drop 再补发一次异步注销
    /// （防止与后续同键的重新注册产生竞态，如工作区继续轮）。
    pub(crate) fn disarm(&mut self) {
        self.armed = false;
    }

    pub(crate) async fn cleanup(&mut self) {
        if !self.armed {
            return;
        }
        self.llm_manager
            .unregister_stream_hooks_if_owner(&self.stream_event, &self.owner)
            .await;
        self.llm_manager
            .clear_cancel_artifacts(&self.stream_event)
            .await;
        self.disarm();
    }
}

impl Drop for StreamHooksGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let llm_manager = self.llm_manager.clone();
        let owner = self.owner.clone();
        let stream_event = std::mem::take(&mut self.stream_event);
        if stream_event.is_empty() {
            return;
        }
        // drop 通常发生在 tokio worker 线程上；若运行时已关闭（进程退出），
        // 注册表随进程销毁，跳过即可。
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                llm_manager
                    .unregister_stream_hooks_if_owner(&stream_event, &owner)
                    .await;
                llm_manager.clear_cancel_artifacts(&stream_event).await;
            });
        }
    }
}

impl ChatV2Pipeline {
    /// 执行 LLM 调用（支持多轮工具调用）
    ///
    /// ## 多轮工具流程
    /// 1. 调用 LLM 获取响应
    /// 2. 如果响应包含工具调用，执行工具
    /// 3. 将工具结果添加到聊天历史
    /// 4. 迭代执行直到无工具调用或达到最大轮次
    ///
    /// ## 参数
    /// - `ctx`: 流水线上下文（可变，用于存储工具结果）
    /// - `emitter`: 事件发射器
    /// - `system_prompt`: 系统提示
    /// - `recursion_depth`: 当前递归深度
    ///
    /// ## 错误
    /// - 超过最大递归深度 (MAX_TOOL_RECURSION = 5)
    /// - LLM 调用失败
    pub(crate) async fn execute_with_tools(
        &self,
        ctx: &mut PipelineContext,
        emitter: Arc<ChatV2EventEmitter>,
        system_prompt: &str,
        recursion_depth: u32,
    ) -> ChatV2Result<()> {
        // 工具轮次必须在同一个 future 内迭代。这里曾通过 Box::pin 自递归，
        // 每轮都会嵌套 poll 一个体积很大的 future，多轮工具调用可耗尽 Tokio worker 栈。
        let mut recursion_depth = recursion_depth;
        // 工作区注入节流状态：在整个工具循环生命周期内复用，
        // 让冷却时间与 max_injections_per_round 跨多轮工具检查点真实生效
        // （此前每个检查点都 new 一个注入器，节流形同虚设）
        let mut workspace_injection_throttle =
            super::super::workspace::injector::InjectionThrottle::new();
        // ============================================================
        // P1-8 技能锚定：本轮注入首轮构建后冻结（位置 = 历史末尾、当前 user
        // 之前），后续轮次逐字节复用；环内 load_skills 新加载的技能按
        // tool_call_id 锚定到对应 tool result 之后，绝不重插到当前 user 之前。
        // ============================================================
        let mut frozen_turn_skill_injection: Option<TransientSkillMessages> = None;
        // P0（DESIGN「tools 会话内冻结」）+ P1 代际（方案 A）：会话权威
        // 工具面基线 `(g, B_g, digest)` 经 load_session_tool_face_prefix
        // 载入（含跨进程恢复 + 加锁回填）—— 同一 session 内已发出的 tools
        // 顺序跨轮（跨 execute_with_tools 调用 / 下一稳定窗口）保持，禁止
        // 每轮重建字母序。会话首轮基线为空，首次 freeze 按字母序建立；
        // 环内 load_skills 新工具只追加末尾，推进后写回会话级状态。
        let tool_face_baseline = self.load_session_tool_face_prefix(&ctx.session_id);
        let mut frozen_tool_schema_order: Vec<String> = tool_face_baseline.order;
        // 代际纪律（方案 A，fan-out 统一代际）：单变体路径**永不**因纯前缀
        // 扩展或 schema digest 变化 bump generation；代际切换只发生在多变体
        // converge（互异不可 append-only 对齐的尾部）。这里只透传会话当前
        // 代号供日志观测。
        let prefix_generation: u64 = tool_face_baseline.generation;
        // 会话基线 digest（对应 ToolFacePrefixSnapshot::schema_digest）：
        // 从持久化基线起步，本窗口 freeze 后与窗口 digest 对账，变化仅
        // 打日志（不切代、不中途写回）。
        let mut baseline_schema_digest: Option<String> = tool_face_baseline.schema_digest;
        // P0 字节级冻结：已发出工具的 schema 序列化字节在本稳定窗口
        // （本次 execute_with_tools 工具环）内不变。同名 schema 中途变化
        // （MCP 刷新 / load_skills 披露不同版本）时本窗口继续发送首见
        // 字节，变更延迟到下一稳定窗口生效；新工具只追加末尾。
        // 窗口级持有（不随名字序基线持久化）：跨窗口允许采纳新字节。
        let mut frozen_tool_schemas: HashMap<String, Value> = HashMap::new();
        let mut injected_skill_ids: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        let mut in_loop_skill_batches: Vec<(String, Vec<LegacyChatMessage>)> = Vec::new();
        let mut cumulative_skill_audit = SkillInjectionAudit::default();
        loop {
            // WI-13: PipelineHook 回合边界 —— 每轮迭代开头、doom-loop/上限检查
            // 与本轮 LLM 调用之前触发（内置 TaskAuditHook 在此落审计日志）。
            for hook in self.hooks.iter() {
                hook.before_turn(self, ctx, recursion_depth).await?;
            }

            // ============================================================
            // 🆕 2026-07 Doom loop 终止：上一轮检测到同一「工具名+参数」指纹
            // 连续第 5 次出现，不再调用 LLM，生成 tool_limit 块提示用户。
            // （拦截结果已在上一轮以合成失败回喂，此处只负责终止收尾）
            // ============================================================
            if ctx.doom_loop_guard.abort_triggered() {
                let tool_name = ctx
                    .doom_loop_guard
                    .abort_tool_name()
                    .unwrap_or("<unknown>")
                    .to_string();
                log::warn!(
                "[ChatV2::pipeline] Doom loop abort: tool={} repeated {} times with identical arguments, terminating tool loop at depth={}",
                tool_name,
                DOOM_LOOP_ABORT_THRESHOLD,
                recursion_depth
            );
                let limit_message = format!(
                    "⚠️ 检测到重复调用循环，已终止本轮执行\n\n\
                AI 连续 {} 次以完全相同的参数调用工具「{}」，为防止无效死循环已暂停自动执行。\n\n\
                您可以：\n\
                • 补充信息或调整指令后重新发送\n\
                • 发送「继续」让 AI 换一种策略再试\n\
                • 手动完成剩余步骤",
                    DOOM_LOOP_ABORT_THRESHOLD, tool_name
                );
                let result_payload = serde_json::json!({
                    "content": limit_message,
                    "reason": "doom_loop",
                    "toolName": tool_name,
                    "repeatCount": DOOM_LOOP_ABORT_THRESHOLD,
                });
                self.push_tool_limit_block(ctx, &emitter, limit_message, result_payload);
                return Ok(());
            }

            // 检查递归深度限制
            // 🔧 配置化：使用用户设置的限制值，默认 MAX_TOOL_RECURSION (30)
            // 🔧 2026-07（短板 #13）：与多变体路径共用 effective_max_tool_rounds
            let max_recursion = effective_max_tool_rounds(ctx.options.max_tool_recursion);

            // 🔒 安全修复：心跳机制仅信任白名单内部工具
            // 外部/MCP 工具不能通过返回 continue_execution 绕过递归限制
            const ABSOLUTE_MAX_RECURSION: u32 = 150;
            const MAX_HEARTBEAT_COUNT: u32 = 50;
            const HEARTBEAT_TOOLS: &[&str] = &["coordinator_sleep", "builtin-coordinator_sleep"];

            // 🔧 F5 修复：只看最近一轮的心跳（由上一轮工具执行后写入），
            // 而非扫描 ctx.tool_results 全量历史 —— 否则一次 continue_execution=true
            // 会让所有后续轮次都被视为有心跳，心跳计数语义失真
            let has_heartbeat = ctx.last_round_heartbeat;

            // 追踪连续心跳次数，超过上限后忽略心跳
            if has_heartbeat {
                ctx.heartbeat_count += 1;
                if ctx.heartbeat_count > MAX_HEARTBEAT_COUNT {
                    log::warn!(
                    "[ChatV2::pipeline] Heartbeat count exceeded limit: count={}, max={}, ignoring heartbeat",
                    ctx.heartbeat_count,
                    MAX_HEARTBEAT_COUNT
                );
                }
            } else {
                ctx.heartbeat_count = 0;
            }

            let heartbeat_effective = has_heartbeat && ctx.heartbeat_count <= MAX_HEARTBEAT_COUNT;

            // 绝对上限检查（不可绕过）
            if recursion_depth > ABSOLUTE_MAX_RECURSION {
                log::error!(
                "[ChatV2::pipeline] ABSOLUTE recursion limit reached: depth={}, absolute_max={}",
                recursion_depth,
                ABSOLUTE_MAX_RECURSION
            );
                return Err(ChatV2Error::Tool(format!(
                    "达到绝对递归上限 ({})，任务已终止",
                    ABSOLUTE_MAX_RECURSION
                )));
            }

            // 普通限制检查（仅白名单工具的有效心跳可绕过）
            if recursion_depth > max_recursion && !heartbeat_effective {
                log::warn!(
                    "[ChatV2::pipeline] Tool recursion limit reached: depth={}, max={}",
                    recursion_depth,
                    max_recursion
                );

                // 创建 tool_limit 块，提示用户达到限制
                let limit_message = format!(
                    "⚠️ 已达到工具调用限制（{} 轮）\n\n\
                AI 已执行了 {} 轮工具调用。为防止无限循环，已暂停自动执行。\n\n\
                如果任务尚未完成，您可以：\n\
                • 发送「继续」让 AI 继续执行\n\
                • 发送新的指令调整方向\n\
                • 手动完成剩余步骤",
                    max_recursion, max_recursion
                );
                let result_payload = serde_json::json!({
                    "content": limit_message,
                    "recursionDepth": recursion_depth,
                    "maxRecursion": max_recursion,
                });
                self.push_tool_limit_block(ctx, &emitter, limit_message, result_payload);

                // 正常返回，不抛出错误
                return Ok(());
            }

            // ============================================================
            // 🔧 P1-4：工具环内 compaction —— 检查点 A/B 命中阈值后不再只设标志
            // 等回合结束（pipeline 阶段 7），改为在下一轮 LLM 调用前真正执行压缩，
            // 防止长工具链在环内上下文溢出。防重入由 session 级 compaction_locks
            // 保证（与回合末路径复用同一把锁）。
            // ============================================================
            if ctx.needs_compaction {
                // WI-13: PipelineHook 压缩边界 —— 环内 compaction 真正执行前触发。
                for hook in self.hooks.iter() {
                    hook.before_compaction(self, ctx, recursion_depth).await;
                }
                match self.run_compaction(ctx).await {
                    Ok(outcome) if outcome.did_compact() => {
                        // 压缩已落盘：重新加载历史并重编译冻结上下文，让本轮 prompt
                        // 立即应用压缩视图（隐藏旧消息 + 注入锚定摘要）。
                        // ctx.tool_results（当前环内工具链）独立于 chat_history，
                        // 仍会在下方全量追加，不受重载影响。
                        let prev_history = ctx.chat_history.clone();
                        let reload_ok = match self.load_chat_history(ctx).await {
                            Ok(()) => match self.compile_frozen_context(ctx).await {
                                Ok(()) => true,
                                Err(e) => {
                                    log::warn!(
                                        "[ChatV2::pipeline] In-loop context recompile after compaction failed: {}; keeping pre-compaction in-memory history",
                                        e
                                    );
                                    false
                                }
                            },
                            Err(e) => {
                                log::warn!(
                                    "[ChatV2::pipeline] In-loop history reload after compaction failed: {}; keeping pre-compaction in-memory history",
                                    e
                                );
                                false
                            }
                        };
                        if reload_ok {
                            log::info!(
                                "[ChatV2::pipeline] In-loop compaction applied at depth={}: history now {} messages",
                                recursion_depth,
                                ctx.chat_history.len()
                            );
                            // 🆕 重载后若压缩视图仍不够、发生了 FIFO 截断，上报事件
                            self.notify_context_trimmed(ctx, &emitter);
                        } else {
                            // 回滚到压缩前的内存历史（压缩记录已落盘，下次
                            // load_chat_history 仍会应用视图），本轮沿用旧 prompt
                            ctx.chat_history = prev_history;
                        }
                    }
                    // 跳过/无需（锁占用/会话过短等），标志已在 run_compaction 内清零；
                    // 🆕 真正失败（摘要失败/lineage 失效）时发 compaction_failed 事件
                    Ok(outcome) => {
                        if outcome.is_failed() {
                            if let Some(reason) = outcome.reason_code() {
                                emitter.emit_compaction_failed(reason);
                            }
                        }
                    }
                    Err(e) => {
                        // DB 硬错误：清零标志防止环内反复重试，退化为 FIFO 截断
                        log::error!(
                            "[ChatV2::pipeline] In-loop compaction failed for session={} (non-fatal, falling back to FIFO trim): {}",
                            ctx.session_id,
                            e
                        );
                        ctx.needs_compaction = false;
                        emitter.emit_compaction_failed(
                            super::compaction::CompactionSkipReason::InternalError.as_code(),
                        );
                    }
                }
            }

            log::info!(
            "[ChatV2::pipeline] Executing LLM call: session={}, recursion_depth={}, tool_results={}",
            ctx.session_id,
            recursion_depth,
            ctx.tool_results.len()
        );

            // 创建 LLM 适配器
            // 🔧 修复：默认启用 thinking，确保思维链内容能正确累积和保存
            let enable_thinking = ctx.options.enable_thinking.unwrap_or(true);
            log::info!(
                "[ChatV2::pipeline] enable_thinking={} (from options: {:?})",
                enable_thinking,
                ctx.options.enable_thinking
            );
            let wrap_token_policy = self
                .resolve_active_api_config(ctx)
                .await
                .map(|config| {
                    crate::utils::model_special_tokens::ModelWrapTokenPolicy::for_provider_model(
                        config.provider_type.as_deref(),
                        config.provider_scope.as_deref(),
                        &config.model,
                    )
                })
                .unwrap_or(crate::utils::model_special_tokens::ModelWrapTokenPolicy::Disabled);
            let adapter = Arc::new(ChatV2LLMAdapter::new(
                emitter.clone(),
                ctx.assistant_message_id.clone(),
                enable_thinking,
                ctx.options.skill_state_version,
                Some(format!("tool-round-{}", recursion_depth)),
                wrap_token_policy,
            ));

            // 🔧 修复：存储 adapter 引用到 ctx，确保取消时可以获取已累积内容
            ctx.current_adapter = Some(adapter.clone());

            // ============================================================
            // 构建聊天历史（真实历史 + 瞬态技能消息 + 当前用户消息 + 当前轮工具结果）
            // ============================================================
            let mut messages = ctx.chat_history.clone();

            // P1-8 技能锚定：本轮注入只在首轮构建并冻结。已锚定在可回放历史中
            // 的技能（history.rs 按 meta.skill_injection_anchors 还原）不再重复
            // 注入，注入点因此在首次注入后冻结，跨轮 [history][skills][userN]
            // live == replay；同轮后续轮次逐字节复用冻结结果。
            if frozen_turn_skill_injection.is_none() {
                let skill_state =
                    self.load_effective_session_skill_state(&ctx.session_id, &ctx.options);
                let empty_skill_contents = std::collections::HashMap::new();
                let skill_contents = ctx
                    .options
                    .replay_skill_contents
                    .as_ref()
                    .or(ctx.options.skill_contents.as_ref())
                    .unwrap_or(&empty_skill_contents);
                injected_skill_ids = anchored_skill_ids_in_history(&ctx.chat_history);
                let built = build_transient_skill_messages_with_audit_excluding(
                    &skill_state,
                    skill_contents,
                    ctx.options.skill_dependencies.as_ref(),
                    // 🔧 P1-2 修复：context_limit 显式配置时为权威值，不再被 32K 常量 min() 钳制
                    ctx.options.context_limit.map(|v| v as usize),
                    &injected_skill_ids,
                );
                injected_skill_ids.extend(built.audit.injected_skill_ids.iter().cloned());
                cumulative_skill_audit = built.audit.clone();
                if !built.audit.injected_skill_ids.is_empty() {
                    // Wave2-A r3：锚定时刻立刻记录正文 digest。正文来源即上面
                    // 渲染注入消息所用的同一 `skill_contents`（replay_skill_contents
                    // 优先、退回 options.skill_contents）——digest 与发出的字节
                    // 严格同源。正文不可得的 id 不写（重放侧按「旧锚点无 digest」
                    // 走兼容分支），绝不编造假 digest；anchors 只存 hash 不存正文。
                    let content_digests: Vec<(String, String)> = built
                        .audit
                        .injected_skill_ids
                        .iter()
                        .filter_map(|id| {
                            skill_contents.get(id).map(|body| {
                                (
                                    id.clone(),
                                    crate::chat_v2::types::skill_body_digest(id, body),
                                )
                            })
                        })
                        .collect();
                    let anchors = ctx
                        .options
                        .skill_injection_anchors
                        .get_or_insert_with(Default::default);
                    anchors.turn_skill_ids = built.audit.injected_skill_ids.clone();
                    anchors.before_turn_user = ctx.options.is_continue != Some(true);
                    for (id, digest) in content_digests {
                        anchors.skill_content_digests.insert(id, digest);
                    }
                }
                frozen_turn_skill_injection = Some(built);
            }
            let frozen_skill_messages = frozen_turn_skill_injection
                .as_ref()
                .map(|built| built.messages.clone())
                .unwrap_or_default();
            let skill_audit = cumulative_skill_audit.clone();
            let injected_skill_count = skill_audit.injected_skill_ids.len();
            let round_id = format!("tool-round-{}", recursion_depth);
            let insertion_index = messages.len();
            insert_transient_skill_messages(&mut messages, insertion_index, frozen_skill_messages);
            emitter.emit_skill_injection_audit(
                &ctx.assistant_message_id,
                json!({
                    "injectedSkillIds": skill_audit.injected_skill_ids.clone(),
                    "droppedSkillIds": skill_audit.dropped_skill_ids.clone(),
                    "missingSkillIds": skill_audit.missing_skill_ids.clone(),
                    "estimatedTokens": skill_audit.estimated_tokens,
                    "skillStateVersion": skill_audit.skill_state_version,
                }),
                None,
                Some(skill_audit.skill_state_version),
                Some(round_id.as_str()),
            );

            if ctx.options.is_continue != Some(true) {
                // 🔴 关键修复：添加当前用户消息到消息列表
                // 之前这里缺失，导致 LLM 看不到用户当前发送的问题
                let current_user_message = ctx
                    .compiled_current_user_message
                    .clone()
                    .unwrap_or_else(|| self.build_current_user_message(ctx));
                messages.push(current_user_message);
            }
            log::debug!(
            "[ChatV2::pipeline] Built LLM messages: history={}, transient_skills={}, current_user={}, content_len={}, has_images={}, has_docs={}",
            ctx.chat_history.len(),
            injected_skill_count,
            ctx.options.is_continue != Some(true),
            ctx.user_content.len(),
            ctx.attachments.iter().any(|a| a.mime_type.starts_with("image/")),
            ctx.attachments.iter().any(|a| !a.mime_type.starts_with("image/"))
        );

            // 如果有工具结果（递归调用时），将**所有**工具结果添加到消息历史
            // 🔧 关键修复：由于 messages 每次从 chat_history.clone() 重建，
            // 之前只添加"新"工具结果会导致历史丢失。现在改为每次添加所有工具结果，
            // 确保 LLM 能看到完整的工具调用历史（符合 Anthropic 最佳实践：
            // "Messages API 是无状态的，必须每次发送完整对话历史"）
            if !ctx.tool_results.is_empty() {
                let tool_messages = ctx.all_tool_results_to_messages();
                let tool_count = tool_messages.len();
                messages.extend(tool_messages);

                // P1-8：环内 load_skills 新加载的技能按记录顺序回放到对应
                // tool result 之后，当前 user 之前的内存前缀保持逐字节不变。
                for (anchor_call_id, batch) in &in_loop_skill_batches {
                    insert_skill_messages_after_tool_result(
                        &mut messages,
                        anchor_call_id,
                        batch.clone(),
                    );
                }

                log::debug!(
                "[ChatV2::pipeline] Added ALL {} tool result messages to chat history (tool_results count: {})",
                tool_count,
                ctx.tool_results.len()
            );
            }

            // ============================================================
            // 调用 LLM
            // ============================================================
            // 构建 LLM 调用上下文
            let mut llm_context: HashMap<String, Value> = HashMap::new();

            // 注入检索到的来源到上下文
            if let Some(ref rag_sources) = ctx.retrieved_sources.rag {
                llm_context.insert(
                    "prefetched_rag_sources".into(),
                    serde_json::to_value(rag_sources).unwrap_or(Value::Null),
                );
            }
            if let Some(ref memory_sources) = ctx.retrieved_sources.memory {
                llm_context.insert(
                    "prefetched_memory_sources".into(),
                    serde_json::to_value(memory_sources).unwrap_or(Value::Null),
                );
            }
            if let Some(ref web_sources) = ctx.retrieved_sources.web_search {
                llm_context.insert(
                    "prefetched_web_search_sources".into(),
                    serde_json::to_value(web_sources).unwrap_or(Value::Null),
                );
            }
            llm_context.insert(
                "memory_enabled".into(),
                Value::Bool(ctx.options.memory_enabled.unwrap_or(true)),
            );
            llm_context.insert(
                "rag_enabled".into(),
                Value::Bool(ctx.options.rag_enabled.unwrap_or(true)),
            );
            llm_context.insert(
                "web_search_enabled".into(),
                Value::Bool(ctx.options.web_search_enabled.unwrap_or(true)),
            );

            // ====================================================================
            // 🆕 图片压缩策略：vision_quality 智能默认
            // ====================================================================
            // 策略逻辑：
            // 1. 用户显式指定 → 直接使用
            // 2. auto/空 → 根据图片数量和来源自动选择：
            //    - 单图 + 非 PDF：high（保持原质量，便于 OCR）
            //    - 2-5 张图：medium
            //    - 6+ 张图或 PDF/教材：low（最大压缩，节省 token）
            let vision_quality = {
                // 检查用户是否显式指定
                let user_specified = ctx
                    .options
                    .vision_quality
                    .as_deref()
                    .filter(|v| !v.is_empty() && *v != "auto");

                if let Some(vq) = user_specified {
                    // 用户显式指定
                    log::debug!("[ChatV2::pipeline] vision_quality: user specified '{}'", vq);
                    vq.to_string()
                } else {
                    // 自动策略：统计图片数量和 PDF/教材来源
                    let mut image_count = 0usize;
                    let mut has_pdf_or_textbook = false;

                    for ctx_ref in &ctx.user_context_refs {
                        // 统计图片块数量
                        for block in &ctx_ref.formatted_blocks {
                            if matches!(
                                block,
                                super::super::resource_types::ContentBlock::Image { .. }
                            ) {
                                image_count += 1;
                            }
                        }
                        // 检查是否有 PDF/教材来源（通过 type_id 判断）
                        let type_id_lower = ctx_ref.type_id.to_lowercase();
                        if type_id_lower.contains("pdf")
                            || type_id_lower.contains("textbook")
                            || type_id_lower.contains("file")
                            || ctx_ref.resource_id.starts_with("tb_")
                        {
                            has_pdf_or_textbook = true;
                        }
                    }

                    // 智能策略
                    let auto_quality = if has_pdf_or_textbook || image_count >= 6 {
                        "low" // PDF/教材 或大量图片：最大压缩
                    } else if image_count >= 2 {
                        "medium" // 中等数量：平衡压缩
                    } else {
                        "high" // 单图或无图：保持原质量
                    };

                    log::info!(
                    "[ChatV2::pipeline] vision_quality: auto -> '{}' (images={}, has_pdf_or_textbook={})",
                    auto_quality, image_count, has_pdf_or_textbook
                );
                    auto_quality.to_string()
                }
            };

            // 注入到 LLM 上下文
            llm_context.insert(
                "vision_quality".into(),
                Value::String(vision_quality.clone()),
            );

            // ====================================================================
            // 统一工具注入：使用 schema_tool_ids 注入工具 Schema
            // 遵循文档 26：统一工具注入系统架构设计
            // 🆕 文档 29 P1-4：自动注入 attempt_completion 工具（Agent 模式必备）
            // ====================================================================

            // 构建工具列表，自动添加 Agent 必备工具（如果有其他工具被注入）
            // 注意：内置工具（包括 TodoList）应该通过内置 MCP 服务器注入，不在此处添加
            let effective_tool_ids: Option<Vec<String>> = match ctx.options.schema_tool_ids.as_ref()
            {
                Some(ids) if !ids.is_empty() => {
                    let mut extended_ids = ids.clone();

                    // 🆕 自动添加 attempt_completion 到工具列表（如果尚未包含）
                    // 这是唯一需要在此添加的工具，因为它是 Agent 模式的终止信号
                    if !extended_ids
                        .iter()
                        .any(|id| id == super::super::tools::attempt_completion::TOOL_NAME)
                    {
                        extended_ids
                            .push(super::super::tools::attempt_completion::TOOL_NAME.to_string());
                        log::debug!(
                            "[ChatV2::pipeline] Auto-injected attempt_completion tool (Agent mode)"
                        );
                    }

                    Some(extended_ids)
                }
                _ => None,
            };

            let injected_count = super::super::tools::injector::inject_tool_schemas(
                effective_tool_ids.as_ref(),
                &mut llm_context,
            );
            if injected_count > 0 {
                log::info!(
                    "[ChatV2::pipeline] Injected {} tool schemas via schema_tool_ids",
                    injected_count
                );
            }

            // ====================================================================
            // 🆕 Workspace 工具注入：已迁移到内置 MCP 服务器
            // ====================================================================
            // 2026-01-16: Workspace 工具已迁移到 builtinMcpServer.ts，
            // 通过前端 mcp_tool_schemas 传递，不再需要后端自动注入。
            // 执行器 WorkspaceToolExecutor 仍然保留，负责处理 builtin-workspace_* 工具调用。
            //
            // 旧代码已移除：后端自动注入会导致工具重复（builtin-workspace_create vs workspace_create）
            if ctx.get_workspace_id().is_some() && self.workspace_coordinator.is_some() {
                log::debug!(
                "[ChatV2::pipeline] Workspace session detected, tools should come from builtin MCP server"
            );
            }

            // ====================================================================
            // 🆕 MCP 工具注入：使用前端传递的 mcp_tool_schemas
            // ====================================================================
            // 架构说明：
            // - 前端 mcpService 管理多 MCP 服务器连接，并缓存工具 Schema
            // - 前端 TauriAdapter 从 mcpService 获取选中服务器的工具 Schema
            // - 后端直接使用前端传递的 Schema，无需自己连接 MCP 服务器
            // - 🔧 P1-49：后端应用 whitelist/blacklist 策略过滤，确保配置生效

            // 🔧 工具名称映射：sanitized API name → original name（含 `:` 等特殊字符）
            // 用于 LLM 返回工具调用时反向映射回原始名称
            let mut mcp_tool_name_mapping: HashMap<String, ExternalToolRoute> = HashMap::new();

            // 🔍 调试日志：检查 mcp_tool_schemas 在 pipeline 中的状态
            let mcp_schema_count = ctx
                .options
                .mcp_tool_schemas
                .as_ref()
                .map(|s| s.len())
                .unwrap_or(0);
            log::info!(
                "[ChatV2::pipeline] 🔍 MCP tool schemas check: count={}, is_some={}",
                mcp_schema_count,
                ctx.options.mcp_tool_schemas.is_some()
            );

            if let Some(ref tool_schemas) = ctx.options.mcp_tool_schemas {
                if !tool_schemas.is_empty() {
                    log::info!(
                        "[ChatV2::pipeline] Processing {} MCP tool schemas from frontend",
                        tool_schemas.len()
                    );

                    // 🔧 P1-49: 读取 MCP 策略配置（whitelist/blacklist）
                    let (whitelist, blacklist) = load_mcp_tool_policy(self.main_db.as_ref());

                    log::debug!(
                        "[ChatV2::pipeline] MCP policy: whitelist={:?}, blacklist={:?}",
                        whitelist,
                        blacklist
                    );

                    // 将前端传递的 MCP 工具 Schema 转换为 LLM 可用的格式
                    // 🔧 P1-49: 应用 whitelist/blacklist 过滤
                    let mcp_tool_values: Vec<Value> = tool_schemas
                    .iter()
                    .filter(|tool| {
                        let allowed =
                            is_mcp_tool_allowed_by_policy(tool, &whitelist, &blacklist);
                        if !allowed && blacklist.iter().any(|b| b == &tool.name) {
                            log::debug!(
                                "[ChatV2::pipeline] Tool '{}' blocked by blacklist",
                                tool.name
                            );
                        } else if !allowed {
                            log::debug!("[ChatV2::pipeline] Tool '{}' not in whitelist", tool.name);
                        }
                        allowed
                    })
                    .filter_map(|tool| {
                        let Some(prepared) = prepare_external_tool_schema(tool, true) else {
                            log::warn!(
                                "[ChatV2::pipeline] Skipping MCP tool with blank API name: raw='{}'",
                                external_tool_raw_name(&tool.name)
                            );
                            return None;
                        };
                        if tool
                            .server_id
                            .as_deref()
                            .is_some_and(|server_id| server_id.trim().is_empty())
                        {
                            log::warn!(
                                "[ChatV2::pipeline] Ignoring blank MCP server id for tool '{}'",
                                prepared.raw_tool_name
                            );
                        }
                        mcp_tool_name_mapping.insert(
                            prepared.api_name.clone(),
                            ExternalToolRoute {
                                raw_tool_name: prepared.raw_tool_name,
                                preferred_server_id: prepared.preferred_server_id,
                            },
                        );
                        Some(prepared.schema)
                    })
                    .collect();

                    let filtered_count = mcp_tool_values.len();
                    let original_count = tool_schemas.len();
                    if filtered_count < original_count {
                        log::info!(
                            "[ChatV2::pipeline] MCP policy filtered: {}/{} tools allowed",
                            filtered_count,
                            original_count
                        );
                    }

                    // 合并到 custom_tools（如果已存在则追加）
                    if !mcp_tool_values.is_empty() {
                        if let Some(existing) = llm_context.get_mut("custom_tools") {
                            if let Some(arr) = existing.as_array_mut() {
                                for schema in mcp_tool_values {
                                    arr.push(schema);
                                }
                                log::info!(
                                    "[ChatV2::pipeline] Appended {} MCP tools to custom_tools",
                                    filtered_count
                                );
                            }
                        } else {
                            llm_context
                                .insert("custom_tools".into(), Value::Array(mcp_tool_values));
                            log::info!(
                                "[ChatV2::pipeline] Injected {} MCP tools as custom_tools",
                                filtered_count
                            );
                        }
                    }

                    // 记录工具名称用于调试
                    let tool_names: Vec<&str> =
                        tool_schemas.iter().map(|t| t.name.as_str()).collect();
                    log::debug!(
                        "[ChatV2::pipeline] MCP tools (before filter): {:?}",
                        tool_names
                    );
                }
            }

            // 🔧 Prompt cache（G6 + P0 冻结）：custom_tools 由客户端
            // schema_tool_ids（注入器）与 MCP 追加合并而来，顺序依赖客户端与
            // 发现时序。首轮按名字排序建立基线；后续轮次冻结基线相对顺序，
            // 且已发出工具的 schema 序列化字节窗口内冻结（同名变更延迟到
            // 下一稳定窗口），环内 load_skills 新工具只追加末尾，禁止
            // 字母序插入中段打爆 Anthropic 缓存前缀。
            if let Some(custom_tools) = llm_context
                .get_mut("custom_tools")
                .and_then(|v| v.as_array_mut())
            {
                // 代际统一（Wave2-A r2 #3）：统一冻结原语 = 名字序冻结 +
                // 字节冻结 + 当前窗口冻结快照 digest（名字序稳定哈希，见
                // tool_schema_digest）。digest 变化 = 窗口内首建或前缀追加
                // 新工具（已发出条目字节冻结，不可能原地变）—— 单变体
                // **不 bump generation**，只记日志并把新 digest 写入本地
                // 快照，变更随下一稳定窗口 / 多变体 converge 评估。
                let window_schema_digest = freeze_tool_face_for_prompt_cache(
                    custom_tools,
                    &mut frozen_tool_schema_order,
                    &mut frozen_tool_schemas,
                );
                if window_schema_digest.is_some() && window_schema_digest != baseline_schema_digest
                {
                    log::info!(
                        "[ChatV2::pipeline] Tool schema digest changed (session_id={}, generation={}, {:?} -> {:?}); \
                         single-variant path keeps generation unchanged — 变更随下一稳定窗口/多变体 converge 评估",
                        ctx.session_id,
                        prefix_generation,
                        baseline_schema_digest.as_deref().map(|d| &d[..12.min(d.len())]),
                        window_schema_digest.as_deref().map(|d| &d[..12.min(d.len())]),
                    );
                    baseline_schema_digest = window_schema_digest;
                }
                // 名字序基线推进后写回会话级状态，下一轮（下一稳定窗口）复用；
                // 纯前缀扩展**不切代**（generation 不随写回变动，store 沿用
                // 会话当前代号）；字节冻结（frozen_tool_schemas）保持窗口级
                // 不写回，窗口 digest 变化只打上方日志、不随 store 持久化
                // —— digest 推进只发生在多变体 converge 收敛点。
                self.store_session_frozen_tool_schema_order(
                    &ctx.session_id,
                    &frozen_tool_schema_order,
                );
            }

            // 生成流事件标识符。assistant_message_id 在取消后重试时会复用，因此还需要
            // run-scoped UUID；否则旧 StreamHooksGuard 的异步 cleanup 可能删除新注册的 hook。
            // 使用 `_var_` 分隔符与多变体键（chat_v2_event_{session}_{variant}）约定一致，
            // 使 model2_pipeline 的 reconnect 事件能通过 rsplit("_var_") 正确还原 session_id，
            // 前端 llm_request_body 过滤（prefix 或 prefix_ 开头）也保持兼容。
            let stream_run_id = uuid::Uuid::new_v4().simple().to_string();
            let stream_event = build_run_scoped_stream_event(
                &ctx.session_id,
                &ctx.assistant_message_id,
                &stream_run_id,
                ctx.options.stream_generation,
            );

            // 注册 LLM 流式回调 hooks
            // 🔧 P1-3 修复（取消泄漏）：外层 tokio::select! 命中取消分支时整个 future 被 drop，
            // 下方的显式 unregister_stream_hooks 永远不会执行。RAII guard 在 Drop 时
            // 补一次异步注销；run-scoped key 保证延迟 cleanup 不会伤及后续重试。
            let registered_hooks: Arc<dyn LLMStreamHooks> = adapter.clone();
            let mut hooks_guard = StreamHooksGuard::new(
                self.llm_manager.clone(),
                stream_event.clone(),
                registered_hooks.clone(),
            );
            self.llm_manager
                .register_stream_hooks(&stream_event, registered_hooks.clone())
                .await;

            // 获取调用选项
            // 🔧 P0修复：始终禁用 LLM Manager 内部的工具执行，由 Pipeline 完全接管
            // 这避免了工具被执行两次（LLM Manager 内部一次，Pipeline 一次）
            // 以及工具调用 start 事件被重复发射的问题
            let disable_tools = true;
            // 🔧 P0修复：优先使用 model2_override_id（ModelPanel 中选择的模型），其次使用 model_id
            let model_override = ctx
                .options
                .model2_override_id
                .clone()
                .or_else(|| ctx.options.model_id.clone());
            let temp_override = ctx.options.temperature;
            let top_p_override = ctx.options.top_p;
            let frequency_penalty_override = ctx.options.frequency_penalty;
            let presence_penalty_override = ctx.options.presence_penalty;
            let max_tokens_override = ctx.options.max_tokens;
            // 🔧 P1修复：将 context_limit 作为 max_input_tokens_override 传递给 LLM
            let max_input_tokens_override = ctx.options.context_limit.map(|v| v as usize);
            // 🔧 P2修复：始终使用 prompt_builder 生成的 system_prompt（XML 格式）
            // prompt_builder 已经将前端传入的 system_prompt_override 作为 base_prompt 处理
            // 不再让前端的值直接覆盖，避免丢失 LaTeX 规则等 XML 格式内容
            let system_prompt_override = Some(system_prompt.to_string());

            // 获取 window 用于流式事件发射
            let window = emitter.window();

            log::info!(
            "[ChatV2::pipeline] Calling LLMManager, stream_event={}, model_override={:?}, top_p={:?}, max_tokens={:?}, max_input_tokens={:?}",
            stream_event,
            model_override,
            top_p_override,
            max_tokens_override,
            max_input_tokens_override
        );

            // 调用 LLMManager 的流式接口
            // 🔧 P1修复：添加 Pipeline 层超时保护，不完全依赖上游 LLM 配置
            let llm_future = self.llm_manager.call_unified_model_2_stream(
                &llm_context,
                &messages,
                "",   // subject - Chat V2 不使用科目
                true, // enable_chain_of_thought
                enable_thinking,
                Some("chat_v2"),
                window,
                &stream_event,
                Some(ctx.assistant_message_id.as_str()),
                None, // trace_id
                disable_tools,
                max_input_tokens_override, // 🔧 P1修复：传递 context_limit 作为输入 token 限制
                model_override.clone(),
                temp_override,
                system_prompt_override.clone(),
                top_p_override,
                frequency_penalty_override,
                presence_penalty_override,
                max_tokens_override,
                ctx.options.reasoning_effort.clone(),
                ctx.options.thinking_budget,
            );

            const LLM_MAX_RETRIES: u32 = 2;
            const LLM_RETRY_DELAY_MS: u64 = 1000;
            // 🔧 F2 修复：超时语义从「总时长 600s」改为「空闲 600s + 绝对上限 2h」。
            // 长 agentic 生成只要流式持续健康输出就不会被掐断；
            // 真正挂起（10 分钟无任何数据）或病态慢滴流（总时长 2h）才超时。
            // 🔧 2026-07：空闲阈值与是否断流改为每次请求时读取设置
            // chat.stream.timeout_ms / chat.stream.auto_cancel_on_timeout（无需重启生效）。
            let stream_idle_cfg = load_stream_idle_config(self.main_db.as_ref());
            let idle_limit = stream_idle_cfg.idle_limit;
            let total_limit = Duration::from_secs(LLM_STREAM_MAX_TOTAL_SECS);
            let timeout_error = |reason: String| crate::models::AppError::llm(reason);
            let is_retryable_llm_error = |err_str: &str| {
                let lower = err_str.to_ascii_lowercase();
                lower.contains("connection")
                    || lower.contains("timeout")
                    || lower.contains("timed out")
                    || lower.contains("reset")
                    || lower.contains("broken pipe")
                    || lower.contains("connect")
                    || lower.contains("temporarily unavailable")
                    || lower.contains("status: 429")
                    || lower.contains("status: 502")
                    || lower.contains("status: 503")
                    || lower.contains("status: 504")
            };

            let mut call_result = {
                let adapter_for_idle = adapter.clone();
                match wait_llm_stream_with_idle_timeout(
                    llm_future,
                    idle_limit,
                    total_limit,
                    stream_idle_cfg.cancel_on_idle,
                    move || adapter_for_idle.idle_elapsed(),
                )
                .await
                {
                    LlmStreamWaitOutcome::Completed(result) => result,
                    LlmStreamWaitOutcome::IdleTimeout { idle_secs } => {
                        log::error!(
                        "[ChatV2::pipeline] LLM stream idle timeout after {}s without data, session={}",
                        idle_secs,
                        ctx.session_id
                    );
                        Err(timeout_error(format!(
                            "LLM stream call timed out: no data received for {}s",
                            idle_secs
                        )))
                    }
                    LlmStreamWaitOutcome::TotalTimeout { total_secs } => {
                        log::error!(
                            "[ChatV2::pipeline] LLM stream exceeded absolute limit {}s, session={}",
                            total_secs,
                            ctx.session_id
                        );
                        Err(timeout_error(format!(
                            "LLM stream call exceeded absolute time limit ({}s)",
                            total_secs
                        )))
                    }
                }
            };

            // 瞬时网络错误仅允许在尚未产生任何输出时重试。流一旦输出正文或思维链，
            // 换模型/重放请求会把两次生成拼接成一个伪造回答；此时必须终止本轮，
            // 由下一次显式重试重新冻结模型和上下文。
            let stream_has_output = !adapter.get_accumulated_content().is_empty()
                || adapter
                    .get_accumulated_reasoning()
                    .is_some_and(|reasoning| !reasoning.is_empty());
            if call_result.is_err() && stream_has_output {
                log::warn!(
                    "[ChatV2::pipeline] Stream failed after output; suppressing automatic retry/failover for session={}",
                    ctx.session_id
                );
            }
            if call_result.is_err() && !stream_has_output {
                for retry in 1..=LLM_MAX_RETRIES {
                    if ctx
                        .cancellation_token
                        .as_ref()
                        .map(|t| t.is_cancelled())
                        .unwrap_or(false)
                    {
                        break;
                    }

                    // 🔧 P0 修复：is_err 守卫下用 match 取错误，替换掉脆弱的
                    // `call_result.as_ref().err().unwrap()` 风格
                    let err_str = match call_result.as_ref() {
                        Err(err) => format!("{:?}", err),
                        Ok(_) => break,
                    };
                    if !is_retryable_llm_error(&err_str) {
                        break;
                    }

                    let delay = LLM_RETRY_DELAY_MS * (1_u64 << (retry - 1));
                    log::warn!(
                        "[ChatV2::pipeline] Transient LLM error, retry {}/{} after {}ms: {}",
                        retry,
                        LLM_MAX_RETRIES,
                        delay,
                        err_str
                    );
                    emitter.emit_stream_reconnect(
                        &ctx.assistant_message_id,
                        retry,
                        LLM_MAX_RETRIES,
                    );
                    // 🔧 P0 修复：退避 sleep 与取消令牌 select，用户点停止后
                    // 不再需要等完 1s/2s 指数退避才能响应取消
                    let cancelled_during_backoff =
                        if let Some(token) = ctx.cancellation_token.as_ref() {
                            tokio::select! {
                                _ = token.cancelled() => true,
                                _ = tokio::time::sleep(Duration::from_millis(delay)) => false,
                            }
                        } else {
                            tokio::time::sleep(Duration::from_millis(delay)).await;
                            false
                        };
                    if cancelled_during_backoff {
                        break;
                    }

                    // 重新注册 hooks，并重置 adapter 累积状态
                    // 🔧 修复：重新注册并不会清空 adapter（Arc 共享同一实例），
                    // 若失败尝试已流出部分内容，必须显式重置，否则重试响应会被
                    // 追加到旧的部分内容之后，导致内容重复落库/重复执行工具调用
                    self.llm_manager
                        .unregister_stream_hooks_if_owner(&stream_event, &registered_hooks)
                        .await;
                    adapter.reset_stream_state();
                    self.llm_manager
                        .register_stream_hooks(&stream_event, registered_hooks.clone())
                        .await;

                    let retry_future = self.llm_manager.call_unified_model_2_stream(
                        &llm_context,
                        &messages,
                        "",
                        true,
                        enable_thinking,
                        Some("chat_v2"),
                        emitter.window(),
                        &stream_event,
                        Some(ctx.assistant_message_id.as_str()),
                        None,
                        disable_tools,
                        max_input_tokens_override,
                        model_override.clone(),
                        temp_override,
                        system_prompt_override.clone(),
                        top_p_override,
                        frequency_penalty_override,
                        presence_penalty_override,
                        max_tokens_override,
                        ctx.options.reasoning_effort.clone(),
                        ctx.options.thinking_budget,
                    );

                    call_result = {
                        let adapter_for_idle = adapter.clone();
                        match wait_llm_stream_with_idle_timeout(
                            retry_future,
                            idle_limit,
                            total_limit,
                            stream_idle_cfg.cancel_on_idle,
                            move || adapter_for_idle.idle_elapsed(),
                        )
                        .await
                        {
                            LlmStreamWaitOutcome::Completed(result) => result,
                            LlmStreamWaitOutcome::IdleTimeout { idle_secs } => {
                                log::error!(
                                "[ChatV2::pipeline] LLM stream retry idle timeout after {}s, session={}, retry={}/{}",
                                idle_secs,
                                ctx.session_id,
                                retry,
                                LLM_MAX_RETRIES
                            );
                                Err(timeout_error(format!(
                                    "LLM stream call timed out: no data received for {}s",
                                    idle_secs
                                )))
                            }
                            LlmStreamWaitOutcome::TotalTimeout { total_secs } => {
                                log::error!(
                                "[ChatV2::pipeline] LLM stream retry exceeded absolute limit {}s, session={}, retry={}/{}",
                                total_secs,
                                ctx.session_id,
                                retry,
                                LLM_MAX_RETRIES
                            );
                                Err(timeout_error(format!(
                                    "LLM stream call exceeded absolute time limit ({}s)",
                                    total_secs
                                )))
                            }
                        }
                    };

                    if call_result.is_ok() {
                        log::info!("[ChatV2::pipeline] LLM retry {} succeeded", retry);
                        break;
                    }
                }
            }

            // 注销 hooks（正常路径显式注销；guard 仅兜底 select! drop 取消路径）
            hooks_guard.cleanup().await;

            // 处理 LLM 调用结果
            // 🔧 P1-1 修复：llm_manager 存在与 pipeline CancellationToken 平行的第二条取消通道
            // （registry / cancel channel），触发时正常返回 Ok(cancelled=true)。
            // 必须记录该标志并在下方短路，否则「已停止」的会话仍会执行带副作用的工具调用并继续递归。
            // （Err 分支所有路径都会提前 return，因此这里不需要初始值。）
            let llm_stream_cancelled;
            match call_result {
                Ok(output) => {
                    llm_stream_cancelled = output.cancelled;
                    log::info!(
                        "[ChatV2::pipeline] LLM call succeeded, cancelled={}, content_len={}",
                        output.cancelled,
                        output.assistant_message.len()
                    );

                    // 更新上下文
                    ctx.final_content = adapter.get_accumulated_content();
                    ctx.final_reasoning = adapter.get_accumulated_reasoning();
                    // 🔧 修复：保存流式过程中创建的块 ID，确保 save_results 使用相同的 ID
                    ctx.streaming_thinking_block_id = adapter.get_thinking_block_id();
                    ctx.streaming_content_block_id = adapter.get_content_block_id();

                    log::info!(
                    "[ChatV2::pipeline] After LLM call: final_content_len={}, final_reasoning={:?}, thinking_block_id={:?}, content_block_id={:?}",
                    ctx.final_content.len(),
                    ctx.final_reasoning.as_ref().map(|r| r.len()),
                    ctx.streaming_thinking_block_id,
                    ctx.streaming_content_block_id
                );

                    // 如果 adapter 累积内容为空但输出不为空，使用 LLM 输出
                    if ctx.final_content.is_empty() && !output.assistant_message.is_empty() {
                        ctx.final_content = output.assistant_message.clone();
                    }

                    // ============================================================
                    // Token 使用量统计与累加（Prompt 4）
                    // ============================================================
                    let round_usage = self.get_or_estimate_usage(
                        &adapter,
                        &messages,
                        &ctx.final_content,
                        system_prompt,
                        ctx.options.model_id.as_deref(),
                    );

                    // 累加到 PipelineContext.token_usage
                    ctx.token_usage.accumulate(&round_usage);

                    log::info!(
                    "[ChatV2::pipeline] Token usage for round {}: prompt={}, completion={}, total={}, source={}; Accumulated: prompt={}, completion={}, total={}, source={}",
                    recursion_depth,
                    round_usage.prompt_tokens,
                    round_usage.completion_tokens,
                    round_usage.total_tokens,
                    round_usage.source,
                    ctx.token_usage.prompt_tokens,
                    ctx.token_usage.completion_tokens,
                    ctx.token_usage.total_tokens,
                    ctx.token_usage.source
                );

                    // 🆕 P1: 检查点 A — LLM 回复后读取真实 usage，决定是否需要压缩
                    // 压缩本身延迟到 execute_internal 结尾执行，避免打断工具递归
                    // （配置只解析一次，同时供压缩判断与用量记录的协议归属使用）
                    let active_cfg = self.resolve_active_api_config(ctx).await;
                    if !ctx.needs_compaction
                        && super::compaction::should_compact(ctx, active_cfg.as_ref())
                    {
                        ctx.needs_compaction = true;
                    }

                    // 记录 LLM 使用量到数据库
                    // 🔧 修复：优先使用解析后的模型显示名称，避免显示配置 ID
                    let model_for_usage = ctx
                        .model_display_name
                        .as_deref()
                        .or(ctx.options.model_id.as_deref())
                        .unwrap_or("unknown");
                    crate::llm_usage::record_llm_usage_cache_ext(
                        crate::llm_usage::CallerType::ChatV2,
                        model_for_usage,
                        round_usage.prompt_tokens,
                        round_usage.completion_tokens,
                        round_usage.reasoning_tokens,
                        round_usage.cached_tokens,
                        // 缓存写入量（Anthropic cache_creation / Responses
                        // cache_write_tokens）；无测量落 NULL，报表算 write/read 比
                        round_usage.cache_write_tokens,
                        Some(ctx.session_id.clone()),
                        None, // duration_ms - 在 adapter 层面已记录
                        true,
                        None,
                        // 生效协议（openai_chat_completions / openai_responses / ...），
                        // 配置无法解析时留 NULL 而不是猜测
                        active_cfg
                            .as_ref()
                            .map(crate::llm_manager::effective_api_protocol_for_config),
                        // 真实 token 来源：API 精确值 / tiktoken / heuristic 估算
                        Some(round_usage.source.to_string()),
                    );
                }
                Err(e) => {
                    let failed_round_usage =
                        retain_failed_round_usage(&mut ctx.token_usage, adapter.get_api_usage());
                    if let Some(usage) = failed_round_usage.as_ref() {
                        log::info!(
                            "[ChatV2::pipeline] Retained partial usage from failed LLM round {}: prompt={}, completion={}, total={}; accumulated_total={}",
                            recursion_depth,
                            usage.prompt_tokens,
                            usage.completion_tokens,
                            usage.total_tokens,
                            ctx.token_usage.total_tokens
                        );
                    }

                    let error_message = e.to_string();

                    // 🔧 P0 修复：外部取消优先于错误上报。
                    // 用户点停止时，进行中的流常以连接类错误收场（或重试循环
                    // 检测到取消后 break 落到本分支）。此时必须映射为 Cancelled
                    // 走取消收尾（保存部分内容 + emit_stream_cancelled），
                    // 而不是误报 stream_error 吓到用户。
                    let externally_cancelled = ctx
                        .cancellation_token
                        .as_ref()
                        .map(|t| t.is_cancelled())
                        .unwrap_or(false);

                    // 记录失败/取消的 LLM 调用（部分用量仍需入账）
                    // 🔧 修复：优先使用解析后的模型显示名称，避免显示配置 ID
                    let model_for_usage = ctx
                        .model_display_name
                        .as_deref()
                        .or(ctx.options.model_id.as_deref())
                        .unwrap_or("unknown");
                    let failed_round_protocol = self
                        .resolve_active_api_config(ctx)
                        .await
                        .as_ref()
                        .map(crate::llm_manager::effective_api_protocol_for_config);
                    crate::llm_usage::record_llm_usage_cache_ext(
                        crate::llm_usage::CallerType::ChatV2,
                        model_for_usage,
                        failed_round_usage
                            .as_ref()
                            .map(|usage| usage.prompt_tokens)
                            .unwrap_or(0),
                        failed_round_usage
                            .as_ref()
                            .map(|usage| usage.completion_tokens)
                            .unwrap_or(0),
                        failed_round_usage
                            .as_ref()
                            .and_then(|usage| usage.reasoning_tokens),
                        failed_round_usage
                            .as_ref()
                            .and_then(|usage| usage.cached_tokens),
                        // 失败轮已上报的缓存写入量同样入账（Responses 常在
                        // failed/incomplete 终态前发 usage）；无测量落 NULL
                        failed_round_usage
                            .as_ref()
                            .and_then(|usage| usage.cache_write_tokens),
                        Some(ctx.session_id.clone()),
                        None,
                        false,
                        Some(if externally_cancelled {
                            format!("cancelled by user (original error: {})", error_message)
                        } else {
                            error_message.clone()
                        }),
                        failed_round_protocol,
                        // 失败轮保留到的部分 usage 同样带真实来源；无 usage 时留空
                        failed_round_usage
                            .as_ref()
                            .map(|usage| usage.source.to_string()),
                    );

                    if externally_cancelled {
                        log::info!(
                            "[ChatV2::pipeline] LLM round ended after external cancellation, mapping to Cancelled (original error: {})",
                            error_message
                        );
                        // 与内部取消路径（llm_stream_cancelled）保持一致：
                        // 捞回本轮部分内容，供外层取消收尾保存
                        let partial_content = adapter.get_accumulated_content();
                        let partial_reasoning = adapter.get_accumulated_reasoning();
                        let has_partial_output = !partial_content.is_empty()
                            || partial_reasoning
                                .as_ref()
                                .is_some_and(|reasoning| !reasoning.is_empty());
                        if has_partial_output {
                            ctx.final_content = partial_content;
                            ctx.final_reasoning = partial_reasoning;
                            ctx.streaming_thinking_block_id = adapter.get_thinking_block_id();
                            ctx.streaming_content_block_id = adapter.get_content_block_id();
                            if ctx.has_interleaved_blocks() {
                                ctx.collect_round_blocks(
                                    adapter.get_thinking_block_id(),
                                    adapter.get_accumulated_reasoning(),
                                    adapter.get_content_block_id(),
                                    Some(ctx.final_content.clone()),
                                    &ctx.assistant_message_id.clone(),
                                );
                            }
                        }
                        adapter.finalize_all();
                        ctx.pending_reasoning_for_api = None;
                        return Err(ChatV2Error::Cancelled);
                    }

                    // 调用 adapter 的错误处理（仅真实错误；取消不发 error 块）
                    adapter.on_error(&error_message);
                    log::error!("[ChatV2::pipeline] LLM call failed: {}", error_message);

                    if error_message.to_ascii_lowercase().contains("timed out") {
                        return Err(ChatV2Error::Timeout(error_message));
                    }
                    return Err(ChatV2Error::Llm(error_message));
                }
            }

            // ============================================================
            // 🔧 P1-1 修复：LLM 流被内部取消（cancelled=true）时立即短路。
            // 丢弃已收集的工具调用（不执行、不递归），把已流出的部分内容收进
            // interleaved 列表后走取消收尾路径（外层 execute() 会保存部分结果）。
            // ============================================================
            if llm_stream_cancelled {
                let dropped_tool_calls = adapter.take_tool_calls();
                if !dropped_tool_calls.is_empty() {
                    log::warn!(
                    "[ChatV2::pipeline] LLM stream cancelled internally, discarding {} pending tool call(s) without execution, session={}",
                    dropped_tool_calls.len(),
                    ctx.session_id
                );
                }
                // 已发生过工具轮时，本轮部分内容需进入 interleaved 列表才能被保存
                // （save_results 检测到 interleaved 块后只保存 interleaved 列表）
                if ctx.has_interleaved_blocks() {
                    ctx.collect_round_blocks(
                        adapter.get_thinking_block_id(),
                        adapter.get_accumulated_reasoning(),
                        adapter.get_content_block_id(),
                        Some(ctx.final_content.clone()),
                        &ctx.assistant_message_id.clone(),
                    );
                }
                adapter.finalize_all();
                ctx.pending_reasoning_for_api = None;
                return Err(ChatV2Error::Cancelled);
            }

            // ============================================================
            // 处理 LLM 返回的工具调用
            // 工具调用通过 LLMStreamHooks.on_tool_call() 回调收集到 adapter 中。
            // 在 LLM 调用完成后，从 adapter 取出收集到的工具调用进行处理。
            // ============================================================
            let tool_calls = adapter.take_tool_calls();

            // 🆕 服务端联网搜索（DeepSeek Responses web_search 工具）：搜索结果由
            // 服务端直接注入模型上下文，无本地工具调用；把来源收集到
            // ctx.retrieved_sources.web_search，供 save_results 持久化检索块。
            if let Some(web_sources) = adapter.take_web_search_sources() {
                if !web_sources.is_empty() {
                    log::info!(
                        "[ChatV2::pipeline] Server-side web search sources: {} (session={})",
                        web_sources.len(),
                        ctx.session_id
                    );
                    ctx.retrieved_sources.web_search = Some(web_sources);
                }
            }

            // P2-13 收尾：服务端 web_search_call 完整 item 累积到 ctx，随
            // assistant 消息 meta 持久化（键 openai_responses_web_search_items），
            // history 重放时原样回传 input（DeepSeek Responses 无状态恢复搜索结果）
            let web_search_items = adapter.take_web_search_items();
            if !web_search_items.is_empty() {
                log::debug!(
                    "[ChatV2::pipeline] Collected {} server-side web_search_call item(s) for replay (session={})",
                    web_search_items.len(),
                    ctx.session_id
                );
                ctx.merge_response_web_search_items(web_search_items);
            }

            // 如果有工具调用，执行并递归
            if !tool_calls.is_empty() {
                log::info!(
                "[ChatV2::pipeline] LLM returned {} tool calls, executing (parallel-safe calls run concurrently)...",
                tool_calls.len()
            );

                // ============================================================
                // Interleaved Thinking 支持：收集本轮产生的 thinking/content 块
                // 在工具调用之前，将本轮的 thinking 块添加到交替列表
                // 🔧 P1-2 修复：Claude/GPT 系模型经常在 tool_use 之前输出一段伴随说明文本
                // （text-before-tool_use）。该文本已实时流到前端，必须同时收进 interleaved
                // 列表持久化（否则刷新后消失），并在下方回传给下一轮 LLM。
                // ============================================================
                let current_reasoning = adapter.get_accumulated_reasoning();
                let round_content = adapter.get_accumulated_content();
                ctx.collect_round_blocks(
                    adapter.get_thinking_block_id(),
                    current_reasoning.clone(),
                    adapter.get_content_block_id(),
                    if round_content.is_empty() {
                        None
                    } else {
                        Some(round_content.clone())
                    },
                    &ctx.assistant_message_id.clone(),
                );

                // 🔧 修复：发射 thinking 块的 end 事件，通知前端思维链已结束
                // 之前只调用了 collect_round_blocks 收集数据，但没有发射 end 事件
                // 这导致前端一直显示"思考中..."状态
                adapter.finalize_all();

                // 🔧 DeepSeek Thinking Mode：保存 reasoning_content 用于下一轮 API 调用
                // 根据 DeepSeek API 文档，在工具调用迭代中需要回传 reasoning_content
                ctx.pending_reasoning_for_api = current_reasoning;
                log::debug!(
                "[ChatV2::pipeline] Interleaved: collected thinking block for round {}, total blocks={}, pending_reasoning={}",
                recursion_depth,
                ctx.interleaved_block_ids.len(),
                ctx.pending_reasoning_for_api.as_ref().map(|s| s.len()).unwrap_or(0)
            );

                // ============================================================
                // 🆕 P15 修复（补充）：工具执行前中间保存点
                // 确保 thinking 块等已生成内容在工具执行（可能阻塞）前被持久化
                // 关键场景：coordinator_sleep 会阻塞，如果只在工具执行后保存，保存永远不会执行
                // ============================================================
                // 🔧 P0-3 修复：进入可能长阻塞的工具执行前，关键保存失败重试一次，
                // 仍失败升级 error（见 save_intermediate_results_with_retry），不中断流程
                if self
                    .save_intermediate_results_with_retry(ctx, "pre-tool-execution")
                    .await
                    && !ctx.interleaved_blocks.is_empty()
                {
                    log::info!(
                        "[ChatV2::pipeline] Pre-tool intermediate save completed, blocks={}",
                        ctx.interleaved_block_ids.len()
                    );
                }

                // 并行执行所有工具调用
                let canvas_note_id = ctx.options.canvas_note_id.clone();
                let skill_contents = ctx.options.skill_contents.clone();
                let skill_embedded_tools = ctx.options.skill_embedded_tools.clone();
                let skill_admission_errors = ctx.options.skill_admission_errors.clone();
                let skill_package_roots = ctx.options.skill_package_roots.clone();
                let active_skill_ids = ctx.options.active_skill_ids.clone();
                let execution_allowed_tools = ctx.options.execution_allowed_tools.clone();
                let rag_top_k = ctx.options.rag_top_k;
                let rag_enable_reranking = ctx.options.rag_enable_reranking;
                let memory_enabled = ctx.options.memory_enabled.unwrap_or(true);
                let rag_enabled = ctx.options.rag_enabled.unwrap_or(true);
                let web_search_enabled = ctx.options.web_search_enabled.unwrap_or(true);
                let round_id = format!("tool-round-{}", recursion_depth);

                // ============================================================
                // 🆕 2026-07 Doom loop 检测（借鉴 参考实现）：按执行顺序观察每个
                // 调用的「工具名+参数」指纹，连续第 3 次相同的调用被拦截（不执行），
                // 以合成失败结果回喂 LLM 要求改变策略；连续第 5 次落终止标记，
                // 下一轮递归入口生成 tool_limit 块终止循环。
                // 心跳白名单工具（coordinator_sleep）豁免——重复同参调用是合法轮询。
                // ============================================================
                let (calls_to_execute, doom_synthetic) = self.apply_doom_loop_guard(
                    &mut ctx.doom_loop_guard,
                    &tool_calls,
                    &emitter,
                    &ctx.assistant_message_id,
                    None,
                    ctx.options.skill_state_version,
                    Some(round_id.as_str()),
                );

                // 🆕 取消支持：传递取消令牌给工具执行器
                let cancel_token = ctx.cancellation_token();
                let executed_results = if calls_to_execute.is_empty() {
                    Vec::new()
                } else {
                    self.execute_tool_calls(
                        &calls_to_execute,
                        &emitter,
                        &ctx.session_id,
                        &ctx.assistant_message_id,
                        None,
                        ctx.options.skill_state_version,
                        Some(round_id.as_str()),
                        &canvas_note_id,
                        &skill_contents,
                        &skill_embedded_tools,
                        &skill_admission_errors,
                        &skill_package_roots,
                        &active_skill_ids,
                        &execution_allowed_tools,
                        cancel_token,
                        rag_top_k,
                        rag_enable_reranking,
                        memory_enabled,
                        rag_enabled,
                        web_search_enabled,
                        &mcp_tool_name_mapping,
                    )
                    .await?
                };
                // 拦截的合成失败结果按原始 tool_calls 顺序归并回结果列表，
                // 保证每个 tool_call 都有对应 tool 消息（协议完整性）且历史确定
                let tool_results = merge_round_results_in_call_order(
                    &tool_calls,
                    executed_results,
                    doom_synthetic,
                );

                // 记录执行结果
                let success_count = tool_results.iter().filter(|r| r.success).count();
                log::info!(
                    "[ChatV2::pipeline] Tool execution completed: {}/{} succeeded",
                    success_count,
                    tool_results.len()
                );

                // ============================================================
                // 🆕 渐进披露：load_skills 执行后动态追加工具到 tools 数组
                // ============================================================
                for tool_result in &tool_results {
                    if super::super::tools::SkillsExecutor::is_load_skills_tool(
                        &tool_result.tool_name,
                    ) && tool_result.success
                    {
                        // 从工具结果中提取加载的 skill_ids
                        if let Some(skill_ids) = tool_result
                            .output
                            .get("result")
                            .and_then(|r| r.get("loaded_skill_ids").or_else(|| r.get("skill_ids")))
                            .and_then(|ids| ids.as_array())
                        {
                            let loaded_skill_ids: Vec<String> = skill_ids
                                .iter()
                                .filter_map(|id| id.as_str().map(|s| s.to_string()))
                                .collect();

                            if !loaded_skill_ids.is_empty() {
                                // 从 skill_embedded_tools 中获取对应的工具 Schema
                                if let Some(ref embedded_tools_map) =
                                    ctx.options.skill_embedded_tools
                                {
                                    let mut new_tools: Vec<super::super::types::McpToolSchema> =
                                        Vec::new();
                                    for skill_id in &loaded_skill_ids {
                                        if let Some(tools) = embedded_tools_map.get(skill_id) {
                                            for tool in tools {
                                                new_tools.push(tool.clone());
                                            }
                                        }
                                    }

                                    if !new_tools.is_empty() {
                                        // 动态追加到 mcp_tool_schemas（去重）
                                        let mcp_schemas = ctx
                                            .options
                                            .mcp_tool_schemas
                                            .get_or_insert_with(Vec::new);
                                        let before_count = mcp_schemas.len();

                                        // 收集已存在的工具名称用于去重（使用 owned String 避免借用问题）
                                        let existing_names: std::collections::HashSet<String> =
                                            mcp_schemas.iter().map(|t| t.name.clone()).collect();

                                        let mut added_count = 0;
                                        for tool in new_tools {
                                            if !existing_names.contains(&tool.name) {
                                                mcp_schemas.push(tool);
                                                added_count += 1;
                                            }
                                        }

                                        if added_count > 0 {
                                            log::info!(
                                            "[ChatV2::pipeline] 🆕 Progressive disclosure: added {} tools from skills {:?}, total tools: {} -> {}",
                                            added_count,
                                            loaded_skill_ids,
                                            before_count,
                                            mcp_schemas.len()
                                        );
                                        }
                                    }
                                }

                                // ============================================================
                                // P1-8 环内技能锚定：新加载技能（差集）锚到本次
                                // load_skills 的 tool result 之后追加，禁止删光后
                                // 整包重插到当前 user 之前（那会改写同轮内存前缀）。
                                // ============================================================
                                if let Some(anchor_call_id) =
                                    tool_result.tool_call_id.clone().filter(|id| !id.is_empty())
                                {
                                    let empty_skill_contents = std::collections::HashMap::new();
                                    let batch_contents = ctx
                                        .options
                                        .replay_skill_contents
                                        .as_ref()
                                        .or(ctx.options.skill_contents.as_ref())
                                        .unwrap_or(&empty_skill_contents);
                                    let batch = build_in_loop_skill_messages(
                                        &loaded_skill_ids,
                                        batch_contents,
                                        ctx.options.skill_dependencies.as_ref(),
                                        ctx.options.context_limit.map(|v| v as usize),
                                        &injected_skill_ids,
                                        ctx.options.skill_state_version.unwrap_or(0),
                                    );
                                    cumulative_skill_audit
                                        .missing_skill_ids
                                        .extend(batch.audit.missing_skill_ids.clone());
                                    cumulative_skill_audit
                                        .dropped_skill_ids
                                        .extend(batch.audit.dropped_skill_ids.clone());
                                    if !batch.audit.injected_skill_ids.is_empty() {
                                        injected_skill_ids
                                            .extend(batch.audit.injected_skill_ids.iter().cloned());
                                        cumulative_skill_audit
                                            .injected_skill_ids
                                            .extend(batch.audit.injected_skill_ids.iter().cloned());
                                        cumulative_skill_audit.estimated_tokens +=
                                            batch.audit.estimated_tokens;
                                        // Wave2-A r3：环内锚定同样在写锚点时立刻记
                                        // digest，正文来源即渲染本批消息的同一
                                        // `batch_contents`（replay_skill_contents 优先、
                                        // 退回 options.skill_contents）。tool 级与 turn
                                        // 级共用消息级 skill_content_digests map（按
                                        // skill_id 键，同轮同 id 必同体）。正文不可得
                                        // 不写假 digest；不 bump prefix generation。
                                        let content_digests: Vec<(String, String)> = batch
                                            .audit
                                            .injected_skill_ids
                                            .iter()
                                            .filter_map(|id| {
                                                batch_contents.get(id).map(|body| {
                                                    (
                                                        id.clone(),
                                                        crate::chat_v2::types::skill_body_digest(
                                                            id, body,
                                                        ),
                                                    )
                                                })
                                            })
                                            .collect();
                                        let anchors = ctx
                                            .options
                                            .skill_injection_anchors
                                            .get_or_insert_with(Default::default);
                                        anchors.tool_anchored.push(
                                            crate::chat_v2::types::ToolAnchoredSkills {
                                                tool_call_id: anchor_call_id.clone(),
                                                skill_ids: batch.audit.injected_skill_ids.clone(),
                                            },
                                        );
                                        for (id, digest) in content_digests {
                                            anchors.skill_content_digests.insert(id, digest);
                                        }
                                        log::info!(
                                            "[ChatV2::pipeline] P1-8: anchored {} in-loop skill(s) after load_skills tool_call_id={}",
                                            batch.audit.injected_skill_ids.len(),
                                            anchor_call_id
                                        );
                                        in_loop_skill_batches
                                            .push((anchor_call_id, batch.messages));
                                    }
                                }
                            }
                        }
                    }
                }

                // ============================================================
                // Interleaved Thinking 支持：添加工具调用块到交替列表
                // ============================================================
                let message_id = ctx.assistant_message_id.clone();
                for tool_result in &tool_results {
                    ctx.add_tool_block(tool_result, &message_id);
                }
                log::debug!(
                    "[ChatV2::pipeline] Interleaved: added {} tool blocks, total blocks={}",
                    tool_results.len(),
                    ctx.interleaved_block_ids.len()
                );

                // 🆕 文档 29 P1-4：检测 attempt_completion 的 task_completed 标志
                // 如果检测到任务完成，终止递归循环，不再继续调用 LLM
                let task_completed = tool_results.iter().any(|r| {
                    r.output
                        .get("task_completed")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                });

                // 🔒 安全修复：心跳检测仅信任白名单内部工具
                let has_continue_execution = tool_results.iter().any(|r| {
                    HEARTBEAT_TOOLS.contains(&r.tool_name.as_str())
                        && r.output
                            .get("continue_execution")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false)
                });
                // 🔧 F5 修复：记录本轮心跳，供下一轮递归入口判断（替代全量历史扫描）
                ctx.last_round_heartbeat = has_continue_execution;
                if has_continue_execution {
                    log::info!(
                    "[ChatV2::pipeline] Heartbeat detected from whitelisted tool, will bypass recursion limit (count: {})",
                    ctx.heartbeat_count
                );
                }

                // 🆕 持久化 TodoList 状态（消息内继续执行支持）
                // 检测是否有 todo 工具调用，如果有则持久化到数据库
                for tool_result in &tool_results {
                    if tool_result.tool_name.contains("todo_") {
                        // 从内存获取当前 TodoList 状态并持久化
                        if let Some(todo_list) =
                            super::super::tools::todo_executor::get_todo_list(&ctx.session_id)
                        {
                            if let Err(e) = super::super::tools::todo_executor::persist_todo_list(
                                &self.db,
                                &ctx.session_id,
                                &ctx.assistant_message_id,
                                None, // variant_id 暂时为 None，后续可从 ctx 获取
                                &todo_list,
                            ) {
                                log::warn!("[ChatV2::pipeline] Failed to persist TodoList: {}", e);
                            } else {
                                log::debug!(
                                "[ChatV2::pipeline] TodoList persisted: session={}, progress={}/{}",
                                ctx.session_id,
                                todo_list.completed_count(),
                                todo_list.total_count()
                            );
                            }
                        }
                        break; // 只需持久化一次
                    }
                }

                // 将工具结果添加到上下文
                // 🔧 思维链修复：为这一批工具结果中的第一个附加当前轮次的思维链
                // 一轮 LLM 调用可能产生多个工具调用，但只有一个思维链
                // 🔧 Gemini 3 修复：同时附加 thought_signature（工具调用必需）
                let cached_thought_sig = adapter.get_thought_signature();
                let tool_results_count = tool_results.len();
                let pending_reasoning = ctx.pending_reasoning_for_api.clone();
                let tool_results_with_reasoning: Vec<_> = tool_results
                    .into_iter()
                    .enumerate()
                    .map(|(i, mut result)| {
                        if i == 0 {
                            // 只有第一个工具结果携带这一轮的思维链
                            result.reasoning_content = pending_reasoning.clone();
                            // 🔧 Gemini 3：附加 thought_signature 以便后续请求回传
                            result.thought_signature = cached_thought_sig.clone();
                        }
                        result
                    })
                    .collect();
                // Responses reasoning items 按相邻配对写入：一次响应可含多个
                // reasoning item（每个 function_call 各带一个），按 adapter 已
                // 配好的 tool_call_id 键控（禁止全部绑到本批第一个 tool id）。
                // 未配对的残留条目兜底挂到第一个尚无 reasoning item 的 tool_call。
                {
                    let fallback_tool_call_id = tool_results_with_reasoning
                        .first()
                        .and_then(|r| r.tool_call_id.clone())
                        .filter(|id| !id.is_empty());
                    assign_tool_round_reasoning_items(
                        &mut ctx.response_reasoning_by_tool_call_id,
                        adapter.get_response_reasoning_items(),
                        fallback_tool_call_id.as_deref(),
                    );
                }
                // 🔧 P1-2 修复：记录本轮伴随文本（text-before-tool_use），
                // 由 tool_results_to_messages_impl 回填到对应 assistant(tool_call) 消息的
                // content 字段，让下一轮 LLM 能看到自己上一轮说过什么
                if !round_content.is_empty() {
                    if let Some(first_tool_call_id) = tool_results_with_reasoning
                        .first()
                        .and_then(|r| r.tool_call_id.clone())
                        .filter(|id| !id.is_empty())
                    {
                        ctx.round_text_by_tool_call_id
                            .insert(first_tool_call_id, round_content.clone());
                    }
                }
                ctx.add_tool_results(tool_results_with_reasoning);

                // 🆕 P1: 检查点 B — 工具结果累加后，预估下一轮 prompt 是否会溢出
                if !ctx.needs_compaction {
                    let cfg = self.resolve_active_api_config(ctx).await;
                    let tool_delta: u32 = ctx
                        .tool_results
                        .iter()
                        .rev()
                        .take(tool_results_count)
                        .map(|r| {
                            super::compaction::estimate_json_tokens(
                                &r.output,
                                ctx.options.model_id.as_deref(),
                            )
                        })
                        .sum();
                    if super::compaction::should_compact_after_tool(ctx, cfg.as_ref(), tool_delta) {
                        ctx.needs_compaction = true;
                    }
                }

                // ============================================================
                // 🆕 P15 修复：工具执行后中间保存点
                // 确保工具执行结果被持久化，防止后续阻塞操作（如睡眠）期间刷新丢失数据
                // ============================================================
                // 🔧 P0-3 修复：工具结果保存同样重试一次（后续可能进入阻塞等待），
                // 仍失败升级 error，不阻塞流程
                if self
                    .save_intermediate_results_with_retry(ctx, "post-tool-execution")
                    .await
                {
                    log::info!(
                    "[ChatV2::pipeline] Intermediate save completed after tool round {}, blocks={}",
                    recursion_depth,
                    ctx.interleaved_block_ids.len()
                );
                }

                // ============================================================
                // 空闲期检测点 2：工具执行完成后检查 inbox
                // 设计文档 30：在工具执行完成后、下一轮 LLM 调用前检查
                // ============================================================
                if let Some(workspace_id) = ctx.get_workspace_id() {
                    if let Some(ref coordinator) = self.workspace_coordinator {
                        use super::super::workspace::WorkspaceInjector;

                        let injector = WorkspaceInjector::new(coordinator.clone());
                        let max_injections = 2u32; // 整个工具循环内最多处理 2 批消息

                        if let Ok(injection_result) = injector.check_and_inject(
                            &mut workspace_injection_throttle,
                            workspace_id,
                            &ctx.session_id,
                            max_injections,
                        ) {
                            if !injection_result.messages.is_empty() {
                                let formatted = WorkspaceInjector::format_injected_messages(
                                    &injection_result.messages,
                                );
                                // 🆕 契约 C11：内存注入照旧，持久化 + 事件发射为附加动作
                                // （借用冲突规避：workspace_id 借自 ctx，先克隆再传 &mut ctx）
                                let workspace_id_owned = workspace_id.to_string();
                                ctx.inject_workspace_messages(formatted.clone());
                                self.persist_and_emit_workspace_injection(
                                    ctx,
                                    &emitter,
                                    &workspace_id_owned,
                                    &injection_result.messages,
                                    &formatted,
                                    Some(round_id.as_str()),
                                );

                                log::info!(
                                "[ChatV2::pipeline] Workspace tool-phase injection: {} messages, depth={}",
                                injection_result.messages.len(),
                                recursion_depth
                            );
                            }
                        }
                    }
                }

                if task_completed {
                    log::info!(
                    "[ChatV2::pipeline] Task completed detected via attempt_completion, stopping recursive loop at depth={}",
                    recursion_depth
                );

                    // 收集当前轮次的块（无需再次调用 LLM）
                    ctx.collect_round_blocks(
                        adapter.get_thinking_block_id(),
                        adapter.get_accumulated_reasoning(),
                        adapter.get_content_block_id(),
                        Some(ctx.final_content.clone()),
                        &ctx.assistant_message_id.clone(),
                    );

                    // 清除 pending_reasoning
                    ctx.pending_reasoning_for_api = None;

                    return Ok(());
                }

                // 进入下一轮 LLM 调用处理工具结果。保持同一 future，避免递归 poll 栈增长。
                log::debug!(
                    "[ChatV2::pipeline] Continuing tool loop, depth={}->{}",
                    recursion_depth,
                    recursion_depth + 1
                );
                recursion_depth += 1;
                continue;
            }

            // ============================================================
            // 无工具调用，这是最后一轮 LLM 调用
            // 收集最终的 thinking 和 content 块
            // ============================================================
            // Responses reasoning item：纯文本轮无 tool_call_id 可键控，挂到
            // 哨兵键持久化；history 重放附到最终 assistant 文本消息 metadata，
            // 下一轮 Responses input 原样回传 encrypted reasoning。
            // 多条时后到覆盖（最贴近最终正文的 item 生效）。
            assign_final_round_reasoning_items(
                &mut ctx.response_reasoning_by_tool_call_id,
                adapter.get_response_reasoning_items(),
            );

            ctx.collect_round_blocks(
                adapter.get_thinking_block_id(),
                adapter.get_accumulated_reasoning(),
                adapter.get_content_block_id(),
                Some(ctx.final_content.clone()),
                &ctx.assistant_message_id.clone(),
            );

            // 🔧 DeepSeek Thinking Mode：清除 pending_reasoning
            // 根据 DeepSeek API 文档，新的用户问题不需要回传之前的 reasoning_content
            ctx.pending_reasoning_for_api = None;

            log::info!(
            "[ChatV2::pipeline] LLM call completed without tool calls, recursion_depth={}, total interleaved_blocks={}",
            recursion_depth,
            ctx.interleaved_block_ids.len()
        );

            return Ok(());
        }
    }

    /// 并行执行多个工具调用
    ///
    /// 使用 `futures::future::join_all` 并行执行所有工具调用，
    /// 超时策略由 ToolExecutorRegistry 统一控制。
    ///
    /// ## 参数
    /// - `tool_calls`: 工具调用列表
    /// - `emitter`: 事件发射器
    /// - `session_id`: 会话 ID（用于工具状态隔离，如 TodoList）
    /// - `message_id`: 消息 ID（用于关联块）
    /// - `canvas_note_id`: Canvas 笔记 ID，用于 Canvas 工具默认值
    /// - `skill_embedded_tools`: 当前技能注入出的工具定义快照
    ///
    /// ## 返回
    /// 工具调用结果列表
    /// 🆕 2026-07: 生成 tool_limit 块（发射 start/end 事件 + 收进 interleaved 列表）
    ///
    /// 供两处停机路径共用：递归上限（recursionDepth/maxRecursion payload）
    /// 与 doom loop 终止（reason=doom_loop payload）。
    fn push_tool_limit_block(
        &self,
        ctx: &mut PipelineContext,
        emitter: &Arc<ChatV2EventEmitter>,
        limit_message: String,
        result_payload: Value,
    ) {
        let block_id = MessageBlock::generate_id();
        let now_ms = chrono::Utc::now().timestamp_millis();

        emitter.emit_start(
            event_types::TOOL_LIMIT,
            &ctx.assistant_message_id,
            Some(&block_id),
            None,
            None,
        );
        emitter.emit_end(
            event_types::TOOL_LIMIT,
            &block_id,
            Some(result_payload),
            None,
        );

        let tool_limit_block = MessageBlock {
            id: block_id.clone(),
            message_id: ctx.assistant_message_id.clone(),
            block_type: block_types::TOOL_LIMIT.to_string(),
            status: block_status::SUCCESS.to_string(),
            content: Some(limit_message),
            tool_name: None,
            tool_input: None,
            tool_output: None,
            citations: None,
            error: None,
            started_at: Some(now_ms),
            ended_at: Some(now_ms),
            first_chunk_at: Some(now_ms),
            block_index: 0, // 会被 add_interleaved_block 覆盖
        };
        ctx.add_interleaved_block(tool_limit_block);

        log::info!(
            "[ChatV2::pipeline] Created tool_limit block: id={}, message_id={}",
            block_id,
            ctx.assistant_message_id
        );
    }

    /// 🆕 契约 C11：工作区注入消息持久化 + 事件发射
    ///
    /// 两个注入检查点（pipeline.rs 空闲期 / tool_loop.rs 工具轮间）共用。
    /// `ctx.inject_workspace_messages` 只把消息 push 进内存 chat_history 喂 LLM，
    /// 用户在子代理嵌入对话里看不到"主代理插话了什么"。本方法作为**附加**动作：
    /// 1. 构造 `workspace_injection` 块并收进 interleaved 列表（后续
    ///    save_results / 中间保存会据此重建消息 block_ids，只写 DB 不进列表
    ///    会被最终保存覆盖丢块）；
    /// 2. 立即落库（create_block + 追加消息 block_ids，参考 sleep_executor
    ///    的 P16 预存模式），防止后续阻塞/崩溃期间刷新丢数据；失败只 warn；
    /// 3. 发射 start/chunk/end 事件供前端实时渲染。
    ///
    /// 同步方法：连接获取、写入、drop 均在本函数内完成，不跨 await。
    pub(super) fn persist_and_emit_workspace_injection(
        &self,
        ctx: &mut PipelineContext,
        emitter: &Arc<ChatV2EventEmitter>,
        workspace_id: &str,
        messages: &[crate::chat_v2::workspace::WorkspaceMessage],
        formatted: &str,
        round_id: Option<&str>,
    ) {
        let block_id = MessageBlock::generate_id();
        let now_ms = chrono::Utc::now().timestamp_millis();

        // 发送者 session_id 去重列表（保持首次出现顺序）
        let mut senders: Vec<String> = Vec::new();
        for msg in messages {
            if !senders.iter().any(|s| s == &msg.sender_session_id) {
                senders.push(msg.sender_session_id.clone());
            }
        }
        // 类型字符串列表（snake_case，与 format_injected_messages 的序列化一致）
        let message_types: Vec<String> = messages
            .iter()
            .map(|msg| {
                serde_json::to_string(&msg.message_type)
                    .unwrap_or_default()
                    .trim_matches('"')
                    .to_string()
            })
            .collect();

        let injection_meta = json!({
            "workspace_id": workspace_id,
            "message_count": messages.len(),
            "senders": senders,
            "message_types": message_types,
            "injected_at": chrono::Utc::now().to_rfc3339(),
        });

        let mut block = MessageBlock {
            id: block_id.clone(),
            message_id: ctx.assistant_message_id.clone(),
            block_type: block_types::WORKSPACE_INJECTION.to_string(),
            status: block_status::SUCCESS.to_string(),
            content: Some(formatted.to_string()),
            tool_name: None,
            tool_input: None,
            tool_output: Some(injection_meta.clone()),
            citations: None,
            error: None,
            started_at: Some(now_ms),
            ended_at: Some(now_ms),
            first_chunk_at: Some(now_ms),
            block_index: 0, // 会被 add_interleaved_block 重新分配
        };

        // 1. 收进 interleaved 列表（最终保存的 block_ids 来源），
        //    并把分配到的时序索引同步给即将落库的副本
        block.block_index = ctx.add_interleaved_block(block.clone());

        // 2. 立即落库（崩溃安全）；失败只 log warn，不中断注入
        match self.db.get_conn_safe() {
            Ok(conn) => {
                if let Err(e) = ChatV2Repo::create_block_with_conn(&conn, &block) {
                    log::warn!(
                        "[ChatV2::pipeline] Failed to persist workspace_injection block: id={}, err={:?}",
                        block_id,
                        e
                    );
                }
                if let Err(e) = Self::append_block_id_to_message_block_ids(
                    &conn,
                    &ctx.session_id,
                    &ctx.assistant_message_id,
                    &block_id,
                ) {
                    log::warn!(
                        "[ChatV2::pipeline] Failed to append workspace_injection block to message: msg={}, block={}, err={}",
                        ctx.assistant_message_id,
                        block_id,
                        e
                    );
                }
            }
            Err(e) => {
                log::warn!(
                    "[ChatV2::pipeline] No DB connection for workspace_injection persistence (injection continues): {:?}",
                    e
                );
            }
        }

        // 3. 事件发射（前端实时渲染）
        let skill_state_version = ctx.options.skill_state_version;
        emitter.emit_start_with_meta(
            event_types::WORKSPACE_INJECTION,
            &ctx.assistant_message_id,
            Some(&block_id),
            Some(json!({
                "workspaceId": workspace_id,
                "messageCount": messages.len(),
            })),
            None,
            skill_state_version,
            round_id,
        );
        emitter.emit_chunk_with_meta(
            event_types::WORKSPACE_INJECTION,
            &block_id,
            formatted,
            None,
            skill_state_version,
            round_id,
        );
        emitter.emit_end_with_meta(
            event_types::WORKSPACE_INJECTION,
            &block_id,
            Some(json!({ "result": injection_meta })),
            None,
            skill_state_version,
            round_id,
        );

        log::info!(
            "[ChatV2::pipeline] Created workspace_injection block: id={}, message_id={}, messages={}",
            block_id,
            ctx.assistant_message_id,
            messages.len()
        );
    }

    /// 追加 block_id 到消息的 block_ids_json（消息不存在则创建）。
    ///
    /// 与 sleep_executor 的 P16 append 逻辑同构：workspace_injection 块
    /// 在两个注入检查点落库时，必须同步进消息 block_ids，否则刷新后
    /// 加载消息不会包含该块。
    fn append_block_id_to_message_block_ids(
        conn: &rusqlite::Connection,
        session_id: &str,
        message_id: &str,
        block_id: &str,
    ) -> Result<(), String> {
        let existing_block_ids: Result<Option<String>, _> = conn.query_row(
            "SELECT block_ids_json FROM chat_v2_messages WHERE id = ?1",
            rusqlite::params![message_id],
            |row| row.get(0),
        );

        let now_ms = chrono::Utc::now().timestamp_millis();

        match existing_block_ids {
            Ok(block_ids_json) => {
                let mut block_ids: Vec<String> = block_ids_json
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default();

                if !block_ids.iter().any(|id| id == block_id) {
                    block_ids.push(block_id.to_string());
                }

                let block_ids_json = serde_json::to_string(&block_ids)
                    .map_err(|e| format!("Failed to serialize block_ids: {}", e))?;

                conn.execute(
                    "UPDATE chat_v2_messages SET block_ids_json = ?1 WHERE id = ?2",
                    rusqlite::params![block_ids_json, message_id],
                )
                .map_err(|e| format!("Failed to update message block_ids: {}", e))?;
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                let block_ids = vec![block_id.to_string()];
                let block_ids_json = serde_json::to_string(&block_ids)
                    .map_err(|e| format!("Failed to serialize block_ids: {}", e))?;

                conn.execute(
                    r#"INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp)
                       VALUES (?1, ?2, 'assistant', ?3, ?4)"#,
                    rusqlite::params![message_id, session_id, block_ids_json, now_ms],
                )
                .map_err(|e| format!("Failed to create message: {}", e))?;
            }
            Err(e) => {
                return Err(format!("Failed to read message: {}", e));
            }
        }

        Ok(())
    }

    /// 🆕 2026-07 Doom loop 检测：按执行顺序观察本轮工具调用，拦截连续重复调用
    ///
    /// 返回 `(calls_to_execute, synthetic_results)`：
    /// - `calls_to_execute`: 通过检测、应正常执行的调用（保持原顺序）；
    /// - `synthetic_results`: 被拦截调用的合成失败结果（含 block_id，事件已发射），
    ///   由调用方按原始 tool_calls 顺序归并回结果列表回喂 LLM。
    ///
    /// 心跳白名单工具（coordinator_sleep）参与指纹序列（打断其他工具的连续链，
    /// 使「查询→睡眠→查询」合法轮询不被误伤）但自身豁免拦截。
    /// 单变体与多变体路径共用（多变体持有变体局部 DoomLoopGuard）。
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn apply_doom_loop_guard(
        &self,
        guard: &mut DoomLoopGuard,
        tool_calls: &[ToolCall],
        emitter: &Arc<ChatV2EventEmitter>,
        message_id: &str,
        variant_id: Option<&str>,
        skill_state_version: Option<u64>,
        round_id: Option<&str>,
    ) -> (Vec<ToolCall>, Vec<ToolResultInfo>) {
        let mut calls_to_execute: Vec<ToolCall> = Vec::with_capacity(tool_calls.len());
        let mut synthetic_results: Vec<ToolResultInfo> = Vec::new();

        for tc in tool_calls {
            let verdict = guard.observe(&tc.name, &tc.arguments);

            // 心跳工具豁免拦截（observe 已更新指纹链）
            if is_doom_loop_exempt_tool(&tc.name) {
                calls_to_execute.push(tc.clone());
                continue;
            }

            match verdict {
                DoomLoopVerdict::Execute => calls_to_execute.push(tc.clone()),
                DoomLoopVerdict::SkipRepeated { count } => {
                    log::warn!(
                        "[ChatV2::pipeline] Doom loop detected: tool={} repeated {} times with identical arguments, intercepting call (id={})",
                        tc.name,
                        count,
                        tc.id
                    );
                    synthetic_results.push(self.emit_doom_loop_interception(
                        tc,
                        count,
                        false,
                        emitter,
                        message_id,
                        variant_id,
                        skill_state_version,
                        round_id,
                    ));
                }
                DoomLoopVerdict::Abort { count } => {
                    log::error!(
                        "[ChatV2::pipeline] Doom loop abort threshold reached: tool={} repeated {} times, tool loop will terminate (id={})",
                        tc.name,
                        count,
                        tc.id
                    );
                    guard.mark_abort(&tc.name);
                    synthetic_results.push(self.emit_doom_loop_interception(
                        tc,
                        count,
                        true,
                        emitter,
                        message_id,
                        variant_id,
                        skill_state_version,
                        round_id,
                    ));
                }
            }
        }

        (calls_to_execute, synthetic_results)
    }

    /// 为被 doom loop 拦截的调用发射前端事件并构造合成失败结果
    #[allow(clippy::too_many_arguments)]
    fn emit_doom_loop_interception(
        &self,
        tc: &ToolCall,
        count: u32,
        is_abort: bool,
        emitter: &Arc<ChatV2EventEmitter>,
        message_id: &str,
        variant_id: Option<&str>,
        skill_state_version: Option<u64>,
        round_id: Option<&str>,
    ) -> ToolResultInfo {
        let block_id = MessageBlock::generate_id();

        // 发射 start + error 事件，让用户在前端看到被拦截的调用
        emitter.emit_start_with_meta(
            event_types::TOOL_CALL,
            message_id,
            Some(&block_id),
            Some(json!({
                "toolName": tc.name,
                "toolInput": tc.arguments,
                "toolCallId": tc.id,
                "_doomLoopIntercepted": true,
                "_repeatCount": count,
            })),
            variant_id,
            skill_state_version,
            round_id,
        );
        let display_msg = format!(
            "检测到重复调用循环：工具 {} 连续第 {} 次以完全相同的参数被调用，本次调用已被拦截（未执行）。",
            tc.name, count
        );
        emitter.emit_error_with_meta(
            event_types::TOOL_CALL,
            &block_id,
            &display_msg,
            variant_id,
            skill_state_version,
            round_id,
        );

        // 回喂 LLM 的合成失败结果：明确要求改变策略
        let llm_error = if is_abort {
            format!(
                "LOOP DETECTED — tool call intercepted (NOT executed). You have called '{}' {} times in a row with identical arguments. The tool loop is being terminated and the user will be asked to take over. Do NOT repeat this call.",
                tc.name, count
            )
        } else {
            format!(
                "LOOP DETECTED — tool call intercepted (NOT executed). This is the {}th consecutive call to '{}' with identical arguments. Repeating the exact same call will keep failing. You MUST change strategy: adjust the arguments, use a different tool, or ask the user for help (ask_user). If you cannot make progress, explain the blocker to the user instead of retrying.",
                count, tc.name
            )
        };

        ToolResultInfo {
            tool_call_id: Some(tc.id.clone()),
            block_id: Some(block_id),
            tool_name: tc.name.clone(),
            input: tc.arguments.clone(),
            output: json!({
                "error": "doom_loop_detected",
                "repeat_count": count,
                "intercepted": true,
            }),
            success: false,
            error: Some(llm_error),
            duration_ms: Some(0),
            reasoning_content: None,
            thought_signature: None,
        }
    }

    /// 对工具调用列表进行依赖感知排序
    ///
    /// 规则（按优先级从高到低）：
    /// 1. chatanki: run/start → control → status/analyze → wait → export/sync
    /// 2. pptx/xlsx/docx: _create 必须在 _read/_extract/_get/_replace/_edit/_to_spec 之前
    /// 3. 同优先级内保持原始顺序（stable sort）
    fn ordered_tool_calls_for_execution(&self, tool_calls: &[ToolCall]) -> Vec<ToolCall> {
        order_tool_calls_for_execution(tool_calls)
    }

    pub(crate) async fn execute_tool_calls(
        &self,
        tool_calls: &[ToolCall],
        emitter: &Arc<ChatV2EventEmitter>,
        session_id: &str,
        message_id: &str,
        variant_id: Option<&str>,
        skill_state_version: Option<u64>,
        round_id: Option<&str>,
        canvas_note_id: &Option<String>,
        skill_contents: &Option<std::collections::HashMap<String, String>>,
        skill_embedded_tools: &Option<
            std::collections::HashMap<String, Vec<super::super::types::McpToolSchema>>,
        >,
        skill_admission_errors: &Option<std::collections::HashMap<String, String>>,
        skill_package_roots: &Option<std::collections::HashMap<String, String>>,
        _active_skill_ids: &Option<Vec<String>>,
        execution_allowed_tools: &Option<Vec<String>>,
        cancellation_token: Option<&CancellationToken>,
        rag_top_k: Option<u32>,
        rag_enable_reranking: Option<bool>,
        memory_enabled: bool,
        rag_enabled: bool,
        web_search_enabled: bool,
        tool_name_mapping: &HashMap<String, ExternalToolRoute>,
    ) -> ChatV2Result<Vec<ToolResultInfo>> {
        // 🔧 反向映射：LLM 返回的 sanitized 工具名 → 原始名（含 `:` 等特殊字符）
        let tool_calls: Vec<ToolCall> = tool_calls
            .iter()
            .map(|tc| {
                if let Some(route) = tool_name_mapping.get(&tc.name) {
                    log::debug!(
                        "[ChatV2::pipeline] Reverse-mapping tool name: {} → {}",
                        tc.name,
                        route.raw_tool_name
                    );
                    let mut arguments = tc.arguments.clone();
                    if let Some(server_id) = route.preferred_server_id.as_deref() {
                        if let Some(obj) = arguments.as_object_mut() {
                            obj.insert("_serverId".to_string(), json!(server_id));
                        }
                    }
                    ToolCall {
                        id: tc.id.clone(),
                        name: route.raw_tool_name.clone(),
                        arguments,
                    }
                } else {
                    tc.clone()
                }
            })
            .collect();
        let ordered_tool_calls = self.ordered_tool_calls_for_execution(&tool_calls);

        // 🆕 2026-07 并行工具调用：按 executor 声明的并发等级
        // （ToolConcurrency::ReadOnly / SafeParallel / Serial）把依赖感知排序后的
        // 调用列表切成连续分段——连续的并行安全工具组成并行段（有界并发执行），
        // 其余保持串行。需要进入审批流程的工具一律归入串行段。
        // 结果按 ordered_tool_calls 顺序回填（与原顺序 for 循环产出顺序一致）。
        let parallel_flags: Vec<bool> = ordered_tool_calls
            .iter()
            .map(|tc| self.is_parallel_eligible_tool_call(tc))
            .collect();
        let segments = plan_parallel_segments(&parallel_flags);
        log::debug!(
            "[ChatV2::pipeline] Executing {} tool calls in {} segment(s), {} parallel-eligible",
            ordered_tool_calls.len(),
            segments.len(),
            parallel_flags.iter().filter(|f| **f).count()
        );

        // 🔧 2026-02-16: 追踪本批次 _create 工具返回的 file_id，用于修正依赖工具中
        // LLM 凭空捏造的 resource_id（LLM 在同一批次生成 create + read/edit 时，
        // 无法提前知道 create 返回的实际 file_id）
        // key: 文档类型前缀 ("xlsx" / "pptx" / "docx")
        // value: create 工具返回的实际 file_id
        let mut created_file_ids: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();

        let mut tool_results: Vec<ToolResultInfo> = Vec::with_capacity(ordered_tool_calls.len());
        for (is_parallel, range) in segments {
            if is_parallel {
                // ============================================================
                // 并行段：有界并发执行（ReadOnly/SafeParallel 工具）
                // - `buffered(N)` 同时最多驱动 N 个 future，且按输入顺序产出，
                //   因此结果天然按原始 tool_call 顺序回填历史；
                // - 每个工具的块 id 独立，start/end 事件乱序到达是可接受的；
                // - 并行段内不含 _create 类工具（其为 Serial），只需用之前串行段
                //   已捕获的 created_file_ids 做只读修正；
                // - CancellationToken 照常传播到每个工具执行。
                // ============================================================
                use futures::stream::StreamExt;

                let batch = &ordered_tool_calls[range.clone()];
                if batch.len() > 1 {
                    let names: Vec<&str> = batch.iter().map(|c| c.name.as_str()).collect();
                    log::info!(
                        "[ChatV2::pipeline] ⚡ Executing {} parallel-safe tools concurrently (limit={}): {:?}",
                        batch.len(),
                        PARALLEL_TOOL_CONCURRENCY,
                        names
                    );
                }

                let futs = batch.iter().cloned().map(|tc| {
                    let fixed_tc = self.fixup_document_tool_resource_id(&tc, &created_file_ids);
                    let tool_to_execute = fixed_tc.unwrap_or(tc);
                    // 仅 ReadOnly 工具允许瞬时失败自动重试；SafeParallel 不重试
                    let allow_retry = self
                        .executor_registry
                        .get_concurrency_class(&tool_to_execute.name)
                        == crate::chat_v2::tools::executor::ToolConcurrency::ReadOnly;
                    async move {
                        self.execute_single_tool_with_transient_retry(
                            &tool_to_execute,
                            allow_retry,
                            emitter,
                            session_id,
                            message_id,
                            variant_id,
                            skill_state_version,
                            round_id,
                            canvas_note_id,
                            skill_contents,
                            skill_embedded_tools,
                            skill_admission_errors,
                            skill_package_roots,
                            _active_skill_ids,
                            execution_allowed_tools,
                            cancellation_token,
                            rag_top_k,
                            rag_enable_reranking,
                            memory_enabled,
                            rag_enabled,
                            web_search_enabled,
                        )
                        .await
                    }
                });
                let mut batch_results: Vec<ToolResultInfo> = futures::stream::iter(futs)
                    .buffered(PARALLEL_TOOL_CONCURRENCY)
                    .collect()
                    .await;
                tool_results.append(&mut batch_results);
                continue;
            }

            // ============================================================
            // 串行段：顺序执行（Serial 工具、需审批工具、截断标记调用）
            // 保留截断检测、file_id 修正与 _create 捕获逻辑
            // ============================================================
            for tc in ordered_tool_calls[range.clone()].iter() {
                // 检测截断标记：LLM 输出被 max_tokens 截断导致工具调用 JSON 不完整
                // 此时不执行工具，直接返回错误 tool_result 让 LLM 缩小输出重试
                if tc
                    .arguments
                    .get("_truncation_error")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                {
                    let error_msg = tc
                        .arguments
                        .get("_error_message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("工具调用参数被截断");
                    let args_len = tc
                        .arguments
                        .get("_args_len")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);

                    log::warn!(
                    "[ChatV2::pipeline] 工具调用 JSON 被截断，跳过执行并反馈 LLM 重试: tool={}, args_len={}",
                    tc.name,
                    args_len
                );

                    // 🆕 P1 修复：生成 block_id 并发射前端事件，让用户看到截断错误
                    let block_id = MessageBlock::generate_id();
                    let truncation_display_msg = format!(
                    "工具调用 {} 的参数因输出长度超限被截断（已生成 {} 字符），工具未执行，正在自动重试。",
                    tc.name, args_len
                );

                    // 发射 tool_call start 事件（创建前端块）
                    emitter.emit_start_with_meta(
                        event_types::TOOL_CALL,
                        message_id,
                        Some(&block_id),
                        Some(json!({
                            "toolName": tc.name,
                            "toolInput": { "_truncated": true, "_args_len": args_len },
                            "toolCallId": tc.id,
                        })),
                        variant_id,
                        skill_state_version,
                        round_id,
                    );

                    // 发射 tool_call error 事件（标记块为错误状态）
                    emitter.emit_error_with_meta(
                        event_types::TOOL_CALL,
                        &block_id,
                        &truncation_display_msg,
                        variant_id,
                        skill_state_version,
                        round_id,
                    );

                    let retry_hint = format!(
                    "CRITICAL ERROR: Tool call '{}' FAILED — your output was truncated at {} characters because it exceeded the max_tokens limit. The JSON arguments were incomplete and the tool was NOT executed.\n\n\
                    YOU MUST retry with significantly smaller arguments. Mandatory rules:\n\
                    1. Reduce the total argument size to under 50% of the previous attempt.\n\
                    2. For mindmap_create: create only the skeleton (top-level branches + minimal children), then use edit_nodes to add details incrementally.\n\
                    3. For any tool: remove verbose text, avoid deeply nested structures, keep JSON compact.\n\
                    4. If the content is inherently large, split it into multiple smaller tool calls.\n\n\
                    Do NOT repeat the same call with the same size — it will fail again.",
                    tc.name, args_len
                );

                    tool_results.push(ToolResultInfo {
                        tool_call_id: Some(tc.id.clone()),
                        block_id: Some(block_id),
                        tool_name: tc.name.clone(),
                        input: tc.arguments.clone(),
                        output: json!({ "error": error_msg }),
                        success: false,
                        error: Some(retry_hint),
                        duration_ms: None,
                        reasoning_content: None,
                        thought_signature: None,
                    });
                    continue;
                }

                // 🔧 2026-02-16: 修正依赖工具的 resource_id
                // 当 LLM 在同一批次生成 create + 依赖工具时，依赖工具的 resource_id
                // 是 LLM 捏造的（因为 create 还没返回真实 ID）。
                // 这里检测并替换为本批次 create 返回的实际 file_id。
                let tc_to_execute = self.fixup_document_tool_resource_id(tc, &created_file_ids);
                let tc_ref = tc_to_execute.as_ref().unwrap_or(tc);

                // 串行段绝不自动重试（写类工具重复执行有副作用；需审批工具重试会绕过审批语义）
                let info = self
                    .execute_single_tool_with_transient_retry(
                        tc_ref,
                        false,
                        emitter,
                        session_id,
                        message_id,
                        variant_id,
                        skill_state_version,
                        round_id,
                        canvas_note_id,
                        skill_contents,
                        skill_embedded_tools,
                        skill_admission_errors,
                        skill_package_roots,
                        _active_skill_ids,
                        execution_allowed_tools,
                        cancellation_token,
                        rag_top_k,
                        rag_enable_reranking,
                        memory_enabled,
                        rag_enabled,
                        web_search_enabled,
                    )
                    .await;

                // 🔧 捕获 _create 工具返回的 file_id，供后续依赖工具使用
                if info.success {
                    self.capture_created_file_id(&tc_ref.name, &info.output, &mut created_file_ids);
                }
                tool_results.push(info);
            }
        }

        Ok(tool_results)
    }

    /// 🆕 2026-07: 判断单个工具调用是否可进入并行段
    ///
    /// 全部满足才可并行：
    /// 1. 未带 `_truncation_error` 标记（截断调用走串行路径的专门处理逻辑）；
    /// 2. executor 声明的并发等级为 ReadOnly 或 SafeParallel；
    /// 3. 不会进入审批流程（需审批的工具一律走 Serial 路径，避免并发弹出审批卡片）。
    fn is_parallel_eligible_tool_call(&self, tc: &ToolCall) -> bool {
        if tc
            .arguments
            .get("_truncation_error")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            return false;
        }

        let class = self.executor_registry.get_concurrency_class(&tc.name);
        if class == crate::chat_v2::tools::executor::ToolConcurrency::Serial {
            return false;
        }

        !self.tool_may_require_approval(&tc.name, &tc.arguments)
    }

    /// 🆕 2026-07: 带瞬时失败自动重试的单工具执行封装
    ///
    /// - `allow_transient_retry=true` 仅用于 ReadOnly 工具：错误信息匹配瞬时失败
    ///   特征（timeout/connection/429/5xx 等启发式，见 `is_transient_tool_error`）
    ///   时自动重试，最多 2 次，指数退避 500ms → 2s。
    /// - 写类/串行/需审批工具必须传 `false`，绝不自动重试。
    /// - 每次尝试都走完整的 `execute_single_tool`，但整个逻辑调用固定复用一个 block id；
    ///   start/end/error 事件和防闪退 UPSERT 都更新同一块，刷新后不会出现失败尝试 ghost。
    ///   最终结果通过 `_auto_retry_attempts` 字段与错误信息后缀注明重试情况。
    /// - 退避等待期间监听 CancellationToken，取消时立即返回当前失败结果。
    /// - `Err`（执行器内部异常）与 `Ok(success=false)` 统一归一化为失败的
    ///   `ToolResultInfo`，与旧顺序路径行为一致。
    async fn execute_single_tool_with_transient_retry(
        &self,
        tool_call: &ToolCall,
        allow_transient_retry: bool,
        emitter: &Arc<ChatV2EventEmitter>,
        session_id: &str,
        message_id: &str,
        variant_id: Option<&str>,
        skill_state_version: Option<u64>,
        round_id: Option<&str>,
        canvas_note_id: &Option<String>,
        skill_contents: &Option<std::collections::HashMap<String, String>>,
        skill_embedded_tools: &Option<
            std::collections::HashMap<String, Vec<super::super::types::McpToolSchema>>,
        >,
        skill_admission_errors: &Option<std::collections::HashMap<String, String>>,
        skill_package_roots: &Option<std::collections::HashMap<String, String>>,
        active_skill_ids: &Option<Vec<String>>,
        execution_allowed_tools: &Option<Vec<String>>,
        cancellation_token: Option<&CancellationToken>,
        rag_top_k: Option<u32>,
        rag_enable_reranking: Option<bool>,
        memory_enabled: bool,
        rag_enabled: bool,
        web_search_enabled: bool,
    ) -> ToolResultInfo {
        let mut retries_done: usize = 0;
        let retry_block_id = MessageBlock::generate_id();

        loop {
            let outcome = self
                .execute_single_tool(
                    tool_call,
                    &retry_block_id,
                    emitter,
                    session_id,
                    message_id,
                    variant_id,
                    skill_state_version,
                    round_id,
                    canvas_note_id,
                    skill_contents,
                    skill_embedded_tools,
                    skill_admission_errors,
                    skill_package_roots,
                    active_skill_ids,
                    execution_allowed_tools,
                    cancellation_token.cloned(),
                    rag_top_k,
                    rag_enable_reranking,
                    memory_enabled,
                    rag_enabled,
                    web_search_enabled,
                )
                .await;

            // 归一化：Err（执行器内部异常）→ 失败 ToolResultInfo
            let info = match outcome {
                Ok(info) => pin_tool_result_to_block(info, &retry_block_id),
                Err(e) => {
                    log::error!(
                        "[ChatV2::pipeline] Unexpected tool call error for {}: {}",
                        tool_call.name,
                        e
                    );
                    ToolResultInfo {
                        tool_call_id: Some(tool_call.id.clone()),
                        block_id: Some(retry_block_id.clone()),
                        tool_name: tool_call.name.clone(),
                        input: tool_call.arguments.clone(),
                        output: json!(null),
                        success: false,
                        error: Some(e.to_string()),
                        duration_ms: None,
                        reasoning_content: None,
                        thought_signature: None,
                    }
                }
            };

            if info.success {
                return annotate_auto_retry(info, retries_done);
            }
            if !allow_transient_retry || retries_done >= TOOL_TRANSIENT_RETRY_BACKOFF_MS.len() {
                return annotate_auto_retry(info, retries_done);
            }
            let error_text = info.error.clone().unwrap_or_default();
            if !is_transient_tool_error(&error_text) {
                return annotate_auto_retry(info, retries_done);
            }
            if cancellation_token
                .map(|t| t.is_cancelled())
                .unwrap_or(false)
            {
                return annotate_auto_retry(info, retries_done);
            }

            let backoff_ms = TOOL_TRANSIENT_RETRY_BACKOFF_MS[retries_done];
            retries_done += 1;
            log::info!(
                "[ChatV2::pipeline] 🔁 Read-only tool {} hit transient failure, auto-retrying ({}/{}) after {}ms: {}",
                tool_call.name,
                retries_done,
                TOOL_TRANSIENT_RETRY_BACKOFF_MS.len(),
                backoff_ms,
                error_text
            );

            // 退避等待（可被取消打断；取消时返回当前失败结果，不再重试）
            if let Some(token) = cancellation_token {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(backoff_ms)) => {}
                    _ = token.cancelled() => {
                        log::info!(
                            "[ChatV2::pipeline] Auto-retry aborted by cancellation: {}",
                            tool_call.name
                        );
                        return annotate_auto_retry(info, retries_done - 1);
                    }
                }
            } else {
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
            }
        }
    }

    /// 🔧 2026-02-16: 修正依赖工具的 resource_id
    ///
    /// 当 LLM 在同一批次同时生成 `_create` 和 `_read/_edit` 等依赖工具时，
    /// 依赖工具的 `resource_id` 是 LLM 凭空捏造的（因为 create 尚未返回真实 ID）。
    /// 此方法检测这种情况并替换为本批次 _create 工具返回的实际 file_id。
    ///
    /// 替换条件（全部满足才替换）：
    /// 1. 工具是文档类型的非 _create 工具（如 xlsx_read_structured）
    /// 2. 参数中有 resource_id
    /// 3. 本批次有对应文档类型的 _create 结果
    /// 4. 当前 resource_id 与 _create 返回的不同
    /// 5. 当前 resource_id 在 VFS 中不存在（确认是捏造的）
    fn fixup_document_tool_resource_id(
        &self,
        tc: &ToolCall,
        created_file_ids: &std::collections::HashMap<String, String>,
    ) -> Option<ToolCall> {
        if created_file_ids.is_empty() {
            return None;
        }

        // 剥离前缀
        let short_name = tc
            .name
            .strip_prefix(super::super::tools::builtin_retrieval_executor::BUILTIN_NAMESPACE)
            .or_else(|| tc.name.strip_prefix("mcp_"))
            .unwrap_or(&tc.name);

        // 检测文档工具族
        let doc_type = if short_name.starts_with("pptx_") {
            "pptx"
        } else if short_name.starts_with("xlsx_") {
            "xlsx"
        } else if short_name.starts_with("docx_") {
            "docx"
        } else {
            return None;
        };

        // _create 工具本身不需要 fixup
        let action = &short_name[doc_type.len() + 1..]; // skip "xlsx_"
        if action == "create" {
            return None;
        }

        // 获取参数中的 resource_id
        let resource_id = tc.arguments.get("resource_id").and_then(|v| v.as_str())?;

        // 获取本批次 _create 返回的实际 file_id
        let actual_id = created_file_ids.get(doc_type)?;

        // 如果已经一致，无需替换
        if resource_id == actual_id.as_str() {
            return None;
        }

        // 检查原始 resource_id 是否在 VFS 中存在
        // 如果存在，说明 LLM 引用的是之前的文件，不应替换
        if let Some(ref vfs_db) = self.vfs_db {
            use crate::vfs::repos::VfsFileRepo;
            if let Ok(conn) = vfs_db.get_conn_safe() {
                if VfsFileRepo::get_file_with_conn(&conn, resource_id)
                    .ok()
                    .flatten()
                    .is_some()
                {
                    return None; // 原始 ID 有效，不替换
                }
            }
        }

        // 替换 resource_id
        let mut fixed_tc = tc.clone();
        if let Some(obj) = fixed_tc.arguments.as_object_mut() {
            obj.insert(
                "resource_id".to_string(),
                serde_json::Value::String(actual_id.clone()),
            );
        }

        log::info!(
            "[ChatV2::pipeline] 🔧 资源ID修正: {} 的 resource_id '{}' → '{}' (同批次 {}_create 返回)",
            tc.name, resource_id, actual_id, doc_type
        );

        Some(fixed_tc)
    }

    /// 🔧 2026-02-16: 捕获 _create 工具返回的 file_id
    fn capture_created_file_id(
        &self,
        tool_name: &str,
        output: &serde_json::Value,
        created_file_ids: &mut std::collections::HashMap<String, String>,
    ) {
        let short_name = tool_name
            .strip_prefix(super::super::tools::builtin_retrieval_executor::BUILTIN_NAMESPACE)
            .or_else(|| tool_name.strip_prefix("mcp_"))
            .unwrap_or(tool_name);

        let doc_type = if short_name.starts_with("pptx_") {
            "pptx"
        } else if short_name.starts_with("xlsx_") {
            "xlsx"
        } else if short_name.starts_with("docx_") {
            "docx"
        } else {
            return;
        };

        let action = &short_name[doc_type.len() + 1..];
        if action != "create" {
            return;
        }

        // 从输出中提取 file_id（可能嵌套在 result 内）
        let file_id = output.get("file_id").and_then(|v| v.as_str()).or_else(|| {
            output
                .get("result")
                .and_then(|r| r.get("file_id"))
                .and_then(|v| v.as_str())
        });

        if let Some(id) = file_id {
            log::info!(
                "[ChatV2::pipeline] 📦 捕获 {}_create 返回的 file_id: {}",
                doc_type,
                id
            );
            created_file_ids.insert(doc_type.to_string(), id.to_string());
        }
    }

    /// 执行单个工具调用
    ///
    /// 🆕 文档 29 P0-1: 委托给 ToolExecutorRegistry 执行
    ///
    /// ## 参数
    /// - `tool_call`: 工具调用
    /// - `emitter`: 事件发射器
    /// - `session_id`: 会话 ID（用于工具状态隔离，如 TodoList）
    /// - `message_id`: 消息 ID
    /// - `canvas_note_id`: Canvas 笔记 ID，用于 Canvas 工具默认值
    /// - `cancellation_token`: 🆕 取消令牌，用于工具执行取消
    ///
    /// ## 返回
    /// 工具调用结果
    async fn execute_single_tool(
        &self,
        tool_call: &ToolCall,
        block_id: &str,
        emitter: &Arc<ChatV2EventEmitter>,
        session_id: &str,
        message_id: &str,
        variant_id: Option<&str>,
        skill_state_version: Option<u64>,
        round_id: Option<&str>,
        canvas_note_id: &Option<String>,
        skill_contents: &Option<std::collections::HashMap<String, String>>,
        skill_embedded_tools: &Option<
            std::collections::HashMap<String, Vec<super::super::types::McpToolSchema>>,
        >,
        skill_admission_errors: &Option<std::collections::HashMap<String, String>>,
        skill_package_roots: &Option<std::collections::HashMap<String, String>>,
        _active_skill_ids: &Option<Vec<String>>,
        execution_allowed_tools: &Option<Vec<String>>,
        cancellation_token: Option<CancellationToken>,
        rag_top_k: Option<u32>,
        rag_enable_reranking: Option<bool>,
        memory_enabled: bool,
        rag_enabled: bool,
        web_search_enabled: bool,
    ) -> ChatV2Result<ToolResultInfo> {
        log::debug!(
            "[ChatV2::pipeline] Executing tool via ExecutorRegistry: name={}, id={}",
            tool_call.name,
            tool_call.id
        );

        // WI-13: 审批/授权准入与审计标记已迁至内置 PipelineHook（pipeline/hooks.rs）。
        // 默认注册 ApprovalGateHook（准入，可拦截）+ TaskAuditHook（审计注记），
        // 行为与迁移前的内联实现等价；hook 链拦截时直接返回被拦截结果。
        let hook_ctx = ToolHookContext {
            tool_call,
            block_id,
            emitter,
            session_id,
            message_id,
            variant_id,
            skill_state_version,
            round_id,
            skill_package_roots,
            execution_allowed_tools,
            cancellation_token: cancellation_token.as_ref(),
            memory_enabled,
            rag_enabled,
            web_search_enabled,
        };
        let mut admission = ToolAdmission::new(&tool_call.arguments);
        for hook in self.hooks.iter() {
            match hook.before_tool(self, &hook_ctx, &mut admission).await {
                ToolGateOutcome::Proceed => {}
                ToolGateOutcome::Block(result) => return Ok(*result),
            }
        }

        // 🆕 构建执行上下文（文档 29 P0-1）
        // Windowless emitters (integration tests) pass None; pure side-effect
        // executors ignore the window, while bridge tools fail clearly via window_ref().
        let mut ctx = ExecutionContext::new(
            session_id.to_string(),
            message_id.to_string(),
            block_id.to_string(),
            emitter.clone(),
            self.tool_registry.clone(),
            emitter.try_window(),
        )
        // ACR R2-01：runId = toolCallId，贯穿桥/presence/账本
        .with_tool_call_id(tool_call.id.clone())
        .with_canvas(canvas_note_id.clone(), self.notes_manager.clone())
        .with_main_db(self.main_db.clone())
        .with_anki_db(self.anki_db.clone())
        .with_vfs_db(self.vfs_db.clone()) // 🆕 学习资源工具需要访问 VFS 数据库
        // 托管 VfsLanceStore 单例注入：Memory-as-VFS 搜索 / 资源删除时的向量清理依赖它。
        // 启动初始化失败或 headless 测试时为 None，工具侧按各自策略降级。
        .with_vfs_lance_store(self.vfs_db.as_ref().and_then(managed_vfs_lance_store_for))
        .with_llm_manager(Some(self.llm_manager.clone())) // 🆕 VFS RAG 工具需要 LLM 管理器
        .with_chat_v2_db(Some(self.db.clone())) // 🆕 工具块防闪退保存
        .with_question_bank_service(self.question_bank_service.clone()) // 🆕 智能题目集工具
        .with_pdf_processing_service(self.pdf_processing_service.clone()) // 🆕 论文保存触发 Pipeline
        .with_rag_config(rag_top_k, rag_enable_reranking)
        .with_variant_id(variant_id.map(|s| s.to_string()))
        .with_event_meta(skill_state_version, round_id.map(|s| s.to_string()))
        .with_execution_allowed_tools(execution_allowed_tools.clone())
        .with_skill_package_roots(skill_package_roots.clone())
        .with_shell_guard_approved(admission.shell_guard_admitted())
        .with_feature_flags(memory_enabled, rag_enabled, web_search_enabled);
        if let Some((authority_mode, permission_preset)) = admission.authority_admission() {
            ctx = ctx.with_shell_authority_admission(authority_mode, permission_preset);
        }

        ctx.emitter.register_block_event_meta(
            &ctx.block_id,
            ctx.variant_id.as_deref(),
            ctx.skill_state_version,
            ctx.round_id.as_deref(),
        );

        // 🆕 渐进披露：传递 skill_contents
        ctx.skill_contents = skill_contents.clone();
        ctx.skill_embedded_tools = skill_embedded_tools.clone();
        ctx.skill_admission_errors = skill_admission_errors.clone();

        // 🆕 取消支持：传递取消令牌
        if let Some(token) = cancellation_token.as_ref() {
            ctx = ctx.with_cancellation_token(token.clone());
        }

        // Final admission point: Plan consumption/context construction above
        // must not leave a window where emergency stop can still start effects.
        if let Some(kill_switch) = &self.kill_switch {
            if let Err(message) = kill_switch.ensure_allowed() {
                return Ok(preflight_blocked_result(&hook_ctx, message));
            }
        }
        if cancellation_token
            .as_ref()
            .is_some_and(|token| token.is_cancelled())
        {
            return Ok(preflight_blocked_result(
                &hook_ctx,
                "流已取消，工具执行中止".to_string(),
            ));
        }

        // 🆕 委托给 ExecutorRegistry 执行
        match self.executor_registry.execute(tool_call, &ctx).await {
            // WI-13: 审计记录（external MCP 安全边界注记 + trusted automation
            // 预授权标记）已迁至 TaskAuditHook::after_tool（pipeline/hooks.rs）。
            Ok(mut result) => {
                for hook in self.hooks.iter() {
                    hook.after_tool(self, &hook_ctx, &admission, &mut result)
                        .await;
                }
                Ok(result)
            }
            Err(error_msg) => {
                ctx.emitter.emit_error_with_meta(
                    event_types::TOOL_CALL,
                    &ctx.block_id,
                    &error_msg,
                    variant_id,
                    skill_state_version,
                    round_id,
                );
                // 执行器内部错误，构造失败结果
                log::error!(
                    "[ChatV2::pipeline] Executor error for tool {}: {}",
                    tool_call.name,
                    error_msg
                );
                Ok(ToolResultInfo {
                    tool_call_id: Some(tool_call.id.clone()),
                    block_id: Some(block_id.to_string()),
                    tool_name: tool_call.name.clone(),
                    input: crate::chat_v2::approval_scope::redact_tool_arguments_for_display(
                        &tool_call.name,
                        &tool_call.arguments,
                    ),
                    output: json!(null),
                    success: false,
                    error: Some(error_msg),
                    duration_ms: None,
                    reasoning_content: None,
                    thought_signature: None,
                })
            }
        }
    }
}

fn order_tool_calls_for_execution(tool_calls: &[ToolCall]) -> Vec<ToolCall> {
    fn strip_tool_prefix(tool_name: &str) -> &str {
        tool_name
            .strip_prefix(BUILTIN_NAMESPACE)
            .or_else(|| tool_name.strip_prefix("mcp_"))
            .or_else(|| tool_name.strip_prefix("mcp.tools."))
            .unwrap_or(tool_name)
    }

    fn chatanki_priority(short_name: &str) -> Option<u8> {
        if !short_name.starts_with("chatanki_") {
            return None;
        }
        Some(match short_name {
            "chatanki_run" | "chatanki_start" => 0,
            "chatanki_control" => 1,
            "chatanki_status"
            | "chatanki_list_templates"
            | "chatanki_analyze"
            | "chatanki_check_anki_connect" => 2,
            "chatanki_wait" => 3,
            "chatanki_get_cards"
            | "chatanki_update_card"
            | "chatanki_delete_card"
            | "chatanki_add_cards"
            | "chatanki_retemplate" => 4,
            "chatanki_enqueue_review" => 5,
            "chatanki_export" | "chatanki_sync" => 6,
            _ => 2,
        })
    }

    fn document_tool_priority(short_name: &str) -> Option<u8> {
        let prefixes = ["pptx_", "xlsx_", "docx_"];
        let prefix = *prefixes.iter().find(|p| short_name.starts_with(**p))?;
        Some(match &short_name[prefix.len()..] {
            "create" => 0,
            "read_structured" | "get_metadata" | "extract_tables" => 1,
            "edit_cells" | "replace_text" => 2,
            "to_spec" => 3,
            _ => 1,
        })
    }

    fn tool_priority(tool_name: &str) -> (u8, u8) {
        let short = strip_tool_prefix(tool_name);
        if let Some(priority) = chatanki_priority(short) {
            return (0, priority);
        }
        if let Some(priority) = document_tool_priority(short) {
            return (1, priority);
        }
        (99, 0)
    }

    let needs_sort = tool_calls.iter().any(|call| {
        let short = strip_tool_prefix(&call.name);
        chatanki_priority(short).is_some() || document_tool_priority(short).is_some()
    });
    if !needs_sort {
        return tool_calls.to_vec();
    }

    let mut indexed_calls: Vec<(usize, ToolCall)> =
        tool_calls.iter().cloned().enumerate().collect();
    indexed_calls.sort_by_key(|(index, call)| {
        let (group, action) = tool_priority(&call.name);
        (group, action, *index)
    });
    let reordered: Vec<ToolCall> = indexed_calls.into_iter().map(|(_, call)| call).collect();

    if reordered
        .iter()
        .zip(tool_calls.iter())
        .any(|(left, right)| left.id != right.id)
    {
        let names: Vec<&str> = reordered.iter().map(|call| call.name.as_str()).collect();
        log::info!(
            "[ChatV2::pipeline] Tool calls reordered for dependency safety: {:?}",
            names
        );
    }

    reordered
}

// ============================================================================
// 🆕 2026-07 并行工具调用：分段计划 / 瞬时错误判定 / 重试标注（纯函数，可单测）
// ============================================================================

/// 并行段内的最大并发度（有界并发，避免同时打爆下游 API / 本地 IO）
pub(crate) const PARALLEL_TOOL_CONCURRENCY: usize = 4;

/// ReadOnly 工具瞬时失败自动重试的退避序列（最多重试 2 次：500ms → 2s）
pub(crate) const TOOL_TRANSIENT_RETRY_BACKOFF_MS: [u64; 2] = [500, 2000];

/// 把按依赖感知排序后的调用列表切成连续分段
///
/// 输入：每个调用是否可并行（与调用列表等长、同序）。
/// 输出：`(is_parallel, index_range)` 列表，range 相互衔接、按原顺序覆盖全部下标。
/// 连续的可并行调用合并为一个并行段；其余每段为一个串行段（串行段同样合并连续项，
/// 段内仍逐个顺序执行）。
pub(crate) fn plan_parallel_segments(
    parallel_flags: &[bool],
) -> Vec<(bool, std::ops::Range<usize>)> {
    let mut segments: Vec<(bool, std::ops::Range<usize>)> = Vec::new();
    let mut start = 0usize;
    for i in 1..=parallel_flags.len() {
        if i == parallel_flags.len() || parallel_flags[i] != parallel_flags[start] {
            segments.push((parallel_flags[start], start..i));
            start = i;
        }
    }
    segments
}

/// 启发式判定工具错误是否为「瞬时失败」（可安全重试只读工具）
///
/// 匹配 timeout / 连接类 / 429 限流 / 5xx 网关类关键字；
/// 显式排除取消（cancel）——用户取消绝不重试。
/// 仅用于 ReadOnly 工具，写类工具的调用方绝不进入此判定。
pub(crate) fn is_transient_tool_error(error: &str) -> bool {
    let lower = error.to_lowercase();
    // 取消 / ACR 闸门与冲突 / partial 回执：绝不自动重试（避免双写）
    if lower.contains("cancel")
        || lower.contains("partial")
        || lower.contains("workbench_disabled")
        || lower.contains("workbench_unavailable")
        || lower.contains("window_busy")
        || lower.contains("strict_mode")
        || lower.contains("todo_conflict")
        || lower.contains("qbank_conflict")
        || lower.contains("\"retryable\":false")
        || lower.contains("\"retryable\": false")
    {
        return false;
    }

    const TRANSIENT_PATTERNS: &[&str] = &[
        // 超时类
        "timeout",
        "timed out",
        // 连接/网络类
        "connection",
        "connect error",
        "network",
        "reset by peer",
        "broken pipe",
        "dns error",
        "temporarily unavailable",
        // 限流
        "429",
        "too many requests",
        "rate limit",
        // 5xx 网关/服务端瞬时错误
        "500 internal",
        "internal server error",
        "502",
        "bad gateway",
        "503",
        "service unavailable",
        "504",
        "gateway timeout",
    ];
    TRANSIENT_PATTERNS.iter().any(|p| lower.contains(p))
}

/// 在工具结果中注明自动重试情况
///
/// - 发生过重试且输出为 JSON 对象时插入 `_auto_retry_attempts` 字段
///   （重试后成功/失败均注明，回喂 LLM 与前端均可见）；
/// - 重试后仍失败时在错误信息末尾追加重试说明。
pub(crate) fn annotate_auto_retry(mut info: ToolResultInfo, retries: usize) -> ToolResultInfo {
    if retries == 0 {
        return info;
    }
    if let Some(obj) = info.output.as_object_mut() {
        obj.insert("_auto_retry_attempts".to_string(), json!(retries));
    }
    if !info.success {
        let base = info.error.take().unwrap_or_default();
        info.error = Some(format!(
            "{} (瞬时失败已自动重试 {} 次，仍未成功)",
            base, retries
        ));
    }
    info
}

/// Force every physical retry attempt to represent the same logical UI/persistence block.
///
/// Executors receive the same block ID through `ExecutionContext`; this normalization is a final
/// defense for executors that return a missing or inconsistent ID.
pub(crate) fn pin_tool_result_to_block(
    mut info: ToolResultInfo,
    logical_block_id: &str,
) -> ToolResultInfo {
    info.block_id = Some(logical_block_id.to_string());
    info
}

/// 🆕 2026-07: 有界并发、按输入顺序回填结果的执行辅助
///
/// `buffered(limit)` 同时最多驱动 `limit` 个 future，并按输入顺序产出结果。
/// 独立成函数以便单元测试覆盖「顺序回填」语义（execute_tool_calls 的并行段
/// 使用相同的 `futures::stream::iter(..).buffered(..)` 组合子）。
#[allow(dead_code)]
pub(crate) async fn run_bounded_ordered<F, T>(futures_in_order: Vec<F>, limit: usize) -> Vec<T>
where
    F: std::future::Future<Output = T>,
{
    use futures::stream::StreamExt;
    futures::stream::iter(futures_in_order)
        .buffered(limit.max(1))
        .collect()
        .await
}

// ============================================================================
// 🆕 2026-07 Doom loop 检测辅助（纯函数，可单测）
// ============================================================================

/// 心跳白名单工具豁免 doom loop 拦截（重复同参轮询是其合法行为）
///
/// 与 execute_with_tools 内的 HEARTBEAT_TOOLS 白名单保持一致。
pub(crate) fn is_doom_loop_exempt_tool(tool_name: &str) -> bool {
    matches!(tool_name, "coordinator_sleep" | "builtin-coordinator_sleep")
}

/// 把「已执行结果 + doom loop 合成失败结果」按原始 tool_calls 顺序归并
///
/// 归并规则：
/// - 按原始 tool_calls 顺序逐个用 tool_call_id 匹配结果（重复 id 按先到先得）；
/// - 保证每个 tool_call 都有对应结果回喂（协议完整性）且顺序确定
///   （参考 内部审查报告「确定性状态管理防缓存 miss」教训）；
/// - 防御：任何未匹配上的结果（不应发生）按执行顺序补到末尾，避免结果丢失。
pub(crate) fn merge_round_results_in_call_order(
    original_calls: &[ToolCall],
    executed: Vec<ToolResultInfo>,
    synthetic: Vec<ToolResultInfo>,
) -> Vec<ToolResultInfo> {
    let mut pool: Vec<Option<ToolResultInfo>> =
        executed.into_iter().chain(synthetic).map(Some).collect();
    let mut merged: Vec<ToolResultInfo> = Vec::with_capacity(pool.len());

    for tc in original_calls {
        if let Some(slot) = pool.iter_mut().find(|slot| {
            slot.as_ref()
                .map(|info| info.tool_call_id.as_deref() == Some(tc.id.as_str()))
                .unwrap_or(false)
        }) {
            if let Some(info) = slot.take() {
                merged.push(info);
            }
        }
    }

    for slot in pool.into_iter().flatten() {
        merged.push(slot);
    }

    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool_call(id: &str, name: &str) -> ToolCall {
        ToolCall::new(id.to_string(), name.to_string(), json!({}))
    }

    #[test]
    fn tool_schema_sort_key_reads_function_name_and_falls_back_to_top_level() {
        let openai_format = json!({
            "type": "function",
            "function": { "name": "builtin-web_search" }
        });
        assert_eq!(tool_schema_sort_key(&openai_format), "builtin-web_search");

        let top_level = json!({ "name": "legacy_tool" });
        assert_eq!(tool_schema_sort_key(&top_level), "legacy_tool");

        let nameless = json!({ "type": "function" });
        assert_eq!(tool_schema_sort_key(&nameless), "");
    }

    #[test]
    fn tool_schema_sort_orders_openai_function_schemas_deterministically() {
        // G6 回归：此前排序键只读顶层 name，OpenAI function 格式下恒为 ""，
        // 排序退化为 no-op，跨轮顺序漂移会打爆 provider 的 prompt cache 前缀。
        let mut tools = vec![
            json!({ "type": "function", "function": { "name": "zeta" } }),
            json!({ "name": "mid_legacy" }),
            json!({ "type": "function", "function": { "name": "alpha" } }),
        ];
        sort_tool_schemas_for_prompt_cache(&mut tools);
        let names: Vec<&str> = tools.iter().map(tool_schema_sort_key).collect();
        assert_eq!(names, vec!["alpha", "mid_legacy", "zeta"]);

        // 幂等：再次排序不改变顺序（缓存前缀跨轮稳定）
        let before = tools.clone();
        sort_tool_schemas_for_prompt_cache(&mut tools);
        assert_eq!(tools, before);
    }

    #[test]
    fn frozen_tool_order_appends_new_tools_without_touching_sent_prefix() {
        // P0 回归（DESIGN「tools 会话内冻结」）：先发 tools A,B；环内
        // load_skills 追加 C（字母序落在 A、B 之间）后，A,B 前缀字节
        // 必须逐字节不变，C 只能追加到末尾 —— 字母序插入中段不得发生。
        let mut frozen: Vec<String> = Vec::new();
        let mut tools = vec![
            json!({ "type": "function", "function": { "name": "zeta_tool", "description": "B" } }),
            json!({ "type": "function", "function": { "name": "alpha_tool", "description": "A" } }),
        ];
        freeze_tool_schema_order_for_prompt_cache(&mut tools, &mut frozen);
        let names: Vec<&str> = tools.iter().map(tool_schema_sort_key).collect();
        assert_eq!(names, vec!["alpha_tool", "zeta_tool"]);
        let sent_prefix_bytes: Vec<Vec<u8>> = tools
            .iter()
            .map(|tool| serde_json::to_vec(tool).expect("serialize tool schema"))
            .collect();

        // 环内渐进披露追加 beta_tool（字母序在 alpha 与 zeta 之间）
        tools.push(json!({ "type": "function", "function": { "name": "beta_tool" } }));
        freeze_tool_schema_order_for_prompt_cache(&mut tools, &mut frozen);
        let names: Vec<&str> = tools.iter().map(tool_schema_sort_key).collect();
        assert_eq!(
            names,
            vec!["alpha_tool", "zeta_tool", "beta_tool"],
            "新技能工具必须追加末尾，禁止字母序插入中段"
        );
        for (index, expected) in sent_prefix_bytes.iter().enumerate() {
            let actual = serde_json::to_vec(&tools[index]).expect("serialize tool schema");
            assert_eq!(
                &actual, expected,
                "已发出的 tools 前缀第 {} 项字节漂移",
                index
            );
        }
    }

    #[test]
    fn frozen_tool_order_survives_full_rebuild_and_stays_idempotent() {
        // 多变体 refreshed_tools 场景：环内从 mcp_tool_schemas 全量重建
        // （源顺序可能与已发出顺序不同），冻结基线必须还原已发出顺序，
        // 同轮多个新工具按名字排序后一并追加到末尾。
        let mut frozen: Vec<String> = Vec::new();
        let mut tools = vec![
            json!({ "type": "function", "function": { "name": "zeta_tool" } }),
            json!({ "type": "function", "function": { "name": "mid_tool" } }),
        ];
        freeze_tool_schema_order_for_prompt_cache(&mut tools, &mut frozen);
        assert_eq!(frozen, vec!["mid_tool", "zeta_tool"]);

        let mut rebuilt = vec![
            json!({ "type": "function", "function": { "name": "delta_tool" } }),
            json!({ "type": "function", "function": { "name": "zeta_tool" } }),
            json!({ "type": "function", "function": { "name": "aardvark_tool" } }),
            json!({ "type": "function", "function": { "name": "mid_tool" } }),
        ];
        freeze_tool_schema_order_for_prompt_cache(&mut rebuilt, &mut frozen);
        let names: Vec<&str> = rebuilt.iter().map(tool_schema_sort_key).collect();
        // aardvark 字母序在最前，但只能追加末尾（同轮新增按名字排序）
        assert_eq!(
            names,
            vec!["mid_tool", "zeta_tool", "aardvark_tool", "delta_tool"]
        );
        assert_eq!(
            frozen,
            vec!["mid_tool", "zeta_tool", "aardvark_tool", "delta_tool"]
        );

        // 幂等：再次冻结不改变顺序（后续轮次前缀字节稳定）
        let before = rebuilt.clone();
        freeze_tool_schema_order_for_prompt_cache(&mut rebuilt, &mut frozen);
        assert_eq!(rebuilt, before);
        assert_eq!(
            frozen,
            vec!["mid_tool", "zeta_tool", "aardvark_tool", "delta_tool"]
        );
    }

    #[test]
    fn frozen_tool_order_persists_across_turns_via_session_baseline() {
        // P0 回归（跨轮会话冻结）：第一轮结束后基线写回会话级状态；
        // 第二轮（下一稳定窗口）从会话级状态载入，即便来源顺序不同、
        // 且新增了字母序落在中段的工具，已发出 tools 的序列化字节必须
        // 逐字节不变，新工具只追加末尾 —— 禁止跨轮重建字母序。
        let mut session_baseline: Vec<String> = Vec::new();

        // ===== 第一轮：空基线，首次 freeze 按字母序建立 =====
        let mut turn1_local = merge_load(&session_baseline);
        let mut turn1_tools = vec![
            json!({ "type": "function", "function": { "name": "zeta_tool", "description": "Z" } }),
            json!({ "type": "function", "function": { "name": "alpha_tool", "description": "A" } }),
        ];
        freeze_tool_schema_order_for_prompt_cache(&mut turn1_tools, &mut turn1_local);
        merge_frozen_tool_schema_order_baseline(&mut session_baseline, &turn1_local);
        let sent_bytes: Vec<Vec<u8>> = turn1_tools
            .iter()
            .map(|tool| serde_json::to_vec(tool).expect("serialize tool schema"))
            .collect();
        assert_eq!(session_baseline, vec!["alpha_tool", "zeta_tool"]);

        // ===== 第二轮：全量重建（来源顺序打乱 + 新工具 beta 字母序在中段）=====
        let mut turn2_local = merge_load(&session_baseline);
        let mut turn2_tools = vec![
            json!({ "type": "function", "function": { "name": "beta_tool", "description": "B" } }),
            json!({ "type": "function", "function": { "name": "zeta_tool", "description": "Z" } }),
            json!({ "type": "function", "function": { "name": "alpha_tool", "description": "A" } }),
        ];
        freeze_tool_schema_order_for_prompt_cache(&mut turn2_tools, &mut turn2_local);
        merge_frozen_tool_schema_order_baseline(&mut session_baseline, &turn2_local);

        let names: Vec<&str> = turn2_tools.iter().map(tool_schema_sort_key).collect();
        assert_eq!(
            names,
            vec!["alpha_tool", "zeta_tool", "beta_tool"],
            "跨轮基线必须还原已发出顺序，新工具只追加末尾"
        );
        for (index, expected) in sent_bytes.iter().enumerate() {
            let actual = serde_json::to_vec(&turn2_tools[index]).expect("serialize tool schema");
            assert_eq!(
                &actual, expected,
                "两轮请求之间已发出 tools 的序列化字节必须逐字节不变"
            );
        }
        assert_eq!(
            session_baseline,
            vec!["alpha_tool", "zeta_tool", "beta_tool"]
        );

        // ===== 第三轮：某工具（zeta）被移除，剩余顺序仍按基线保持 =====
        let mut turn3_local = merge_load(&session_baseline);
        let mut turn3_tools = vec![
            json!({ "type": "function", "function": { "name": "beta_tool", "description": "B" } }),
            json!({ "type": "function", "function": { "name": "alpha_tool", "description": "A" } }),
        ];
        freeze_tool_schema_order_for_prompt_cache(&mut turn3_tools, &mut turn3_local);
        merge_frozen_tool_schema_order_baseline(&mut session_baseline, &turn3_local);
        let names: Vec<&str> = turn3_tools.iter().map(tool_schema_sort_key).collect();
        assert_eq!(names, vec!["alpha_tool", "beta_tool"]);
        // 基线不因工具消失而删除条目（append-only），后续恢复时顺序仍稳定
        assert_eq!(
            session_baseline,
            vec!["alpha_tool", "zeta_tool", "beta_tool"]
        );
    }

    #[test]
    fn session_baseline_merge_is_append_only_across_parallel_variants() {
        // 并行变体各自推进局部基线后写回：合并只追加缺失名，绝不删除
        // 或重排共享基线已有条目。
        let mut shared: Vec<String> = vec!["alpha_tool".into(), "zeta_tool".into()];
        // 变体 A 环内追加了 beta_tool
        merge_frozen_tool_schema_order_baseline(
            &mut shared,
            &["alpha_tool".into(), "zeta_tool".into(), "beta_tool".into()],
        );
        assert_eq!(shared, vec!["alpha_tool", "zeta_tool", "beta_tool"]);
        // 变体 B 写回时还没见过 beta_tool：不得把它从共享基线抹掉
        merge_frozen_tool_schema_order_baseline(
            &mut shared,
            &["alpha_tool".into(), "zeta_tool".into()],
        );
        assert_eq!(shared, vec!["alpha_tool", "zeta_tool", "beta_tool"]);
    }

    /// 模拟 load_session_frozen_tool_schema_order：会话级基线的克隆载入。
    fn merge_load(session_baseline: &[String]) -> Vec<String> {
        session_baseline.to_vec()
    }

    #[test]
    fn frozen_tool_schema_bytes_survive_append_and_same_name_change() {
        // P0 字节级冻结回归：A,B 发出后环内追加 C（字母序落在中段），
        // A,B 的序列化字节必须逐字节不变；同名 schema 变更（zeta 描述被
        // MCP 刷新改写为 v2）不得改动已发出前缀 —— 本窗口继续发送冻结
        // 字节，变更延迟到下一稳定窗口。
        let mut frozen_names: Vec<String> = Vec::new();
        let mut frozen_schemas: HashMap<String, Value> = HashMap::new();
        let mut tools = vec![
            json!({ "type": "function", "function": {
                "name": "zeta_tool", "description": "Z v1",
                "parameters": { "type": "object", "properties": {} }
            } }),
            json!({ "type": "function", "function": {
                "name": "alpha_tool", "description": "A v1"
            } }),
        ];
        freeze_tool_schemas_for_prompt_cache(&mut tools, &mut frozen_names, &mut frozen_schemas);
        let names: Vec<&str> = tools.iter().map(tool_schema_sort_key).collect();
        assert_eq!(names, vec!["alpha_tool", "zeta_tool"]);
        let sent_bytes: Vec<Vec<u8>> = tools
            .iter()
            .map(|tool| serde_json::to_vec(tool).expect("serialize tool schema"))
            .collect();

        // 环内全量重建：zeta 同名 schema 变更（v2）+ 新工具 beta 追加
        let mut rebuilt = vec![
            json!({ "type": "function", "function": {
                "name": "zeta_tool", "description": "Z v2 CHANGED",
                "parameters": { "type": "object", "properties": {} }
            } }),
            json!({ "type": "function", "function": {
                "name": "beta_tool", "description": "B v1"
            } }),
            json!({ "type": "function", "function": {
                "name": "alpha_tool", "description": "A v1"
            } }),
        ];
        freeze_tool_schemas_for_prompt_cache(&mut rebuilt, &mut frozen_names, &mut frozen_schemas);
        let names: Vec<&str> = rebuilt.iter().map(tool_schema_sort_key).collect();
        assert_eq!(
            names,
            vec!["alpha_tool", "zeta_tool", "beta_tool"],
            "新工具只能追加末尾"
        );
        for (index, expected) in sent_bytes.iter().enumerate() {
            let actual = serde_json::to_vec(&rebuilt[index]).expect("serialize tool schema");
            assert_eq!(
                &actual, expected,
                "已发出的 tools 前缀第 {} 项字节漂移",
                index
            );
        }
        assert_eq!(
            rebuilt[1]["function"]["description"],
            json!("Z v1"),
            "同名 schema 变更必须延迟到下一稳定窗口，本窗口发送冻结字节"
        );

        // 追加的 C（beta）自首见轮起字节同样冻结
        let beta_bytes = serde_json::to_vec(&rebuilt[2]).expect("serialize tool schema");
        let mut third_round = vec![
            json!({ "type": "function", "function": {
                "name": "beta_tool", "description": "B v2 CHANGED"
            } }),
            json!({ "type": "function", "function": {
                "name": "alpha_tool", "description": "A v1"
            } }),
            json!({ "type": "function", "function": {
                "name": "zeta_tool", "description": "Z v2 CHANGED",
                "parameters": { "type": "object", "properties": {} }
            } }),
        ];
        freeze_tool_schemas_for_prompt_cache(
            &mut third_round,
            &mut frozen_names,
            &mut frozen_schemas,
        );
        assert_eq!(
            serde_json::to_vec(&third_round[2]).expect("serialize tool schema"),
            beta_bytes,
            "环内追加的新工具在后续轮次同样按首见字节冻结"
        );
    }

    #[test]
    fn same_name_schema_change_applies_at_next_stable_window() {
        // 稳定窗口边界回归：窗口 1 冻结 v1 字节，窗口内出现 v2 仍发 v1；
        // 下一稳定窗口（新的 execute_with_tools，字节映射重建）采纳 v2
        // 并随即冻结。名字序基线跨窗口保留（会话级），字节映射窗口级。
        let v1 = json!({ "type": "function", "function": {
            "name": "alpha_tool", "description": "A v1"
        } });
        let v2 = json!({ "type": "function", "function": {
            "name": "alpha_tool", "description": "A v2"
        } });
        let mut session_names: Vec<String> = Vec::new();

        // ===== 窗口 1 =====
        let mut w1_schemas: HashMap<String, Value> = HashMap::new();
        let mut w1_round1 = vec![v1.clone()];
        freeze_tool_schemas_for_prompt_cache(&mut w1_round1, &mut session_names, &mut w1_schemas);
        let mut w1_round2 = vec![v2.clone()];
        freeze_tool_schemas_for_prompt_cache(&mut w1_round2, &mut session_names, &mut w1_schemas);
        assert_eq!(w1_round2[0], v1, "窗口内同名 schema 变更必须延迟");

        // ===== 窗口 2：字节映射重建，名字序沿用会话级基线 =====
        let mut w2_schemas: HashMap<String, Value> = HashMap::new();
        let mut w2_round1 = vec![v2.clone()];
        freeze_tool_schemas_for_prompt_cache(&mut w2_round1, &mut session_names, &mut w2_schemas);
        assert_eq!(w2_round1[0], v2, "变更应在下一稳定窗口生效");
        assert_eq!(session_names, vec!["alpha_tool"]);

        // 窗口 2 内 v2 字节随即冻结（旧 v1 再次出现也不得回退）
        let mut w2_round2 = vec![v1];
        freeze_tool_schemas_for_prompt_cache(&mut w2_round2, &mut session_names, &mut w2_schemas);
        assert_eq!(w2_round2[0], v2, "新窗口首见字节冻结后不得再回退");
    }

    #[test]
    fn frozen_tool_schema_bytes_normalize_key_order_permutation() {
        // preserve_order 下键序不同的 Value `==` 相等但序列化字节不同：
        // 同一 schema 以不同键序重建时必须回写冻结副本，仅在 `!=` 时回写
        // 会漏掉这类字节漂移。
        let mut frozen_names: Vec<String> = Vec::new();
        let mut frozen_schemas: HashMap<String, Value> = HashMap::new();
        let mut tools = vec![json!({ "type": "function", "function": {
            "name": "alpha_tool", "description": "A"
        } })];
        freeze_tool_schemas_for_prompt_cache(&mut tools, &mut frozen_names, &mut frozen_schemas);
        let sent = serde_json::to_vec(&tools[0]).expect("serialize tool schema");

        // 键序扰动：function 前置 / description 与 name 互换
        let mut permuted = vec![json!({ "function": {
            "description": "A", "name": "alpha_tool"
        }, "type": "function" })];
        assert_eq!(permuted[0], tools[0], "前置条件：语义相等（仅键序不同）");
        assert_ne!(
            serde_json::to_vec(&permuted[0]).expect("serialize tool schema"),
            sent,
            "前置条件：键序不同导致序列化字节不同"
        );
        freeze_tool_schemas_for_prompt_cache(&mut permuted, &mut frozen_names, &mut frozen_schemas);
        assert_eq!(
            serde_json::to_vec(&permuted[0]).expect("serialize tool schema"),
            sent,
            "冻结回写后必须恢复已发出字节"
        );
    }

    #[test]
    fn in_loop_load_skills_keeps_memory_prefix_byte_stable_within_turn() {
        // 同轮回归（P1-8 + 内存前缀连续）：轮 N 消息 = history.clone()
        // + 冻结的轮首技能注入 + 当前 user + 全量工具结果 + 环内
        // load_skills 批次（锚到对应 tool result 之后）。
        // 断言 1：环内 load_skills 不改当前 user 之前的任何字节；
        // 断言 2：每一轮的消息序列都是上一轮的严格字节前缀延伸。
        let history = vec![
            make_empty_message("user", "turn 0 user".to_string()),
            make_empty_message("assistant", "turn 0 reply".to_string()),
        ];
        let turn_skills = vec![make_transient_skill_message(
            "skill-turn",
            "turn skill body",
        )];
        let current_user = make_empty_message("user", "turn 1 user".to_string());

        // 模拟 execute_with_tools 每轮的消息组装
        let build_round = |tool_msgs: &[LegacyChatMessage],
                           in_loop_batches: &[(String, Vec<LegacyChatMessage>)]|
         -> Vec<LegacyChatMessage> {
            let mut messages = history.clone();
            let insertion_index = messages.len();
            insert_transient_skill_messages(&mut messages, insertion_index, turn_skills.clone());
            messages.push(current_user.clone());
            messages.extend(tool_msgs.to_vec());
            for (anchor_call_id, batch) in in_loop_batches {
                insert_skill_messages_after_tool_result(
                    &mut messages,
                    anchor_call_id,
                    batch.clone(),
                );
            }
            messages
        };
        let serialize = |messages: &[LegacyChatMessage]| -> Vec<Vec<u8>> {
            messages
                .iter()
                .map(|m| serde_json::to_vec(m).expect("serialize message"))
                .collect()
        };

        // ===== 轮 0：无工具结果 =====
        let round0 = build_round(&[], &[]);
        let round0_bytes = serialize(&round0);
        let user_index = round0.len() - 1;
        assert_eq!(round0[user_index].content, "turn 1 user");

        // ===== 轮 1：load_skills 完成，新技能批次锚到其 tool result 之后 =====
        let mut load_call = make_empty_message("assistant", String::new());
        load_call.tool_call = Some(crate::models::ToolCall {
            id: "call-load".to_string(),
            tool_name: "builtin-load_skills".to_string(),
            args_json: json!({ "skill_ids": ["skill-lazy"] }),
        });
        let mut load_result = make_empty_message("tool", "loaded".to_string());
        load_result.tool_result = Some(crate::models::ToolResult {
            call_id: "call-load".to_string(),
            ok: true,
            error: None,
            error_details: None,
            data_json: Some(json!({ "loaded_skill_ids": ["skill-lazy"] })),
            usage: None,
            citations: None,
        });
        let tool_round1 = vec![load_call.clone(), load_result.clone()];
        let batches = vec![(
            "call-load".to_string(),
            vec![make_transient_skill_message(
                "skill-lazy",
                "lazy skill body",
            )],
        )];

        let round1 = build_round(&tool_round1, &batches);
        let round1_bytes = serialize(&round1);

        // 断言 1：当前 user 及其之前的前缀逐字节不变
        for index in 0..=user_index {
            assert_eq!(
                round1_bytes[index], round0_bytes[index],
                "同轮 load_skills 改写了当前 user 之前的第 {} 条消息",
                index
            );
        }
        // 断言 2：轮 0 全量是轮 1 的严格字节前缀
        assert_eq!(&round1_bytes[..round0_bytes.len()], &round0_bytes[..]);
        // 新技能批次必须落在 load_skills tool result 之后（当前 user 之后）
        assert!(is_transient_skill_message(
            round1.last().expect("non-empty")
        ));

        // ===== 轮 2：追加下一批工具结果，环内批次位置不得漂移 =====
        let mut next_call = make_empty_message("assistant", String::new());
        next_call.tool_call = Some(crate::models::ToolCall {
            id: "call-next".to_string(),
            tool_name: "builtin-web_search".to_string(),
            args_json: json!({ "q": "x" }),
        });
        let mut next_result = make_empty_message("tool", "ok".to_string());
        next_result.tool_result = Some(crate::models::ToolResult {
            call_id: "call-next".to_string(),
            ok: true,
            error: None,
            error_details: None,
            data_json: Some(json!({ "ok": true })),
            usage: None,
            citations: None,
        });
        let tool_round2 = vec![load_call, load_result, next_call, next_result];
        let round2 = build_round(&tool_round2, &batches);
        let round2_bytes = serialize(&round2);
        assert_eq!(
            &round2_bytes[..round1_bytes.len()],
            &round1_bytes[..],
            "同轮内存前缀连续性被破坏：轮 1 全量必须是轮 2 的字节前缀"
        );
        assert_eq!(round2.len(), round1.len() + 2);
    }

    #[test]
    fn tool_round_reasoning_items_pair_by_tool_call_id() {
        // 双 tool_call：两条已配对条目各写各的 tool_call_id，
        // 禁止全部绑到本批第一个 tool id。
        let mut dest: HashMap<String, Value> = HashMap::new();
        assign_tool_round_reasoning_items(
            &mut dest,
            vec![
                (Some("call_1".to_string()), json!({ "id": "rs_1" })),
                (Some("call_2".to_string()), json!({ "id": "rs_2" })),
            ],
            Some("call_1"),
        );
        assert_eq!(dest.len(), 2);
        assert_eq!(dest["call_1"], json!({ "id": "rs_1" }));
        assert_eq!(dest["call_2"], json!({ "id": "rs_2" }));
    }

    #[test]
    fn tool_round_unpaired_fallback_never_overwrites_paired_item() {
        // 未配对残留兜底挂 fallback；fallback id 已有配对条目时不得覆盖。
        let mut dest: HashMap<String, Value> = HashMap::new();
        assign_tool_round_reasoning_items(
            &mut dest,
            vec![
                (Some("call_1".to_string()), json!({ "id": "rs_paired" })),
                (None, json!({ "id": "rs_orphan" })),
            ],
            Some("call_1"),
        );
        assert_eq!(dest.len(), 1);
        assert_eq!(
            dest["call_1"],
            json!({ "id": "rs_paired" }),
            "or_insert 不得覆盖已配对条目"
        );

        // fallback 尚无条目时，残留条目挂上去
        let mut dest2: HashMap<String, Value> = HashMap::new();
        assign_tool_round_reasoning_items(
            &mut dest2,
            vec![(None, json!({ "id": "rs_orphan" }))],
            Some("call_9"),
        );
        assert_eq!(dest2["call_9"], json!({ "id": "rs_orphan" }));

        // 无 fallback（本批无有效 tool_call_id）：未配对条目安全丢弃
        let mut dest3: HashMap<String, Value> = HashMap::new();
        assign_tool_round_reasoning_items(&mut dest3, vec![(None, json!({ "id": "x" }))], None);
        assert!(dest3.is_empty());
    }

    #[test]
    fn final_round_reasoning_unpaired_items_use_sentinel_key_last_wins() {
        // 纯文本哨兵：未配对条目挂哨兵键；多条时后到覆盖
        // （最贴近最终正文的 item 生效）；已配对条目仍按 tool_call_id 写入。
        let mut dest: HashMap<String, Value> = HashMap::new();
        assign_final_round_reasoning_items(
            &mut dest,
            vec![
                (Some("call_1".to_string()), json!({ "id": "rs_tool" })),
                (None, json!({ "id": "rs_first" })),
                (None, json!({ "id": "rs_last" })),
            ],
        );
        assert_eq!(dest.len(), 2);
        assert_eq!(dest["call_1"], json!({ "id": "rs_tool" }));
        assert_eq!(
            dest[crate::chat_v2::types::RESPONSES_FINAL_REASONING_KEY],
            json!({ "id": "rs_last" }),
            "多条未配对时哨兵键后到覆盖"
        );
    }

    #[test]
    fn failed_round_retains_and_accumulates_reported_partial_usage() {
        let mut accumulated = TokenUsage::from_api_with_cache(100, 10, Some(2), Some(4));
        let partial = TokenUsage::from_api_with_cache(20, 5, Some(3), Some(7));

        let retained = retain_failed_round_usage(&mut accumulated, Some(partial.clone()))
            .expect("non-zero API usage must be retained on failure");

        assert_eq!(retained.prompt_tokens, 20);
        assert_eq!(retained.completion_tokens, 5);
        assert_eq!(accumulated.prompt_tokens, 120);
        assert_eq!(accumulated.completion_tokens, 15);
        assert_eq!(accumulated.total_tokens, 135);
        assert_eq!(accumulated.reasoning_tokens, Some(5));
        assert_eq!(accumulated.cached_tokens, Some(11));
        assert_eq!(accumulated.last_round_prompt_tokens, Some(25));
    }

    #[test]
    fn failed_round_without_reported_usage_does_not_change_totals() {
        let mut accumulated = TokenUsage::from_api(8, 3, None);
        let before = accumulated.clone();

        assert!(retain_failed_round_usage(&mut accumulated, None).is_none());
        assert_eq!(accumulated.prompt_tokens, before.prompt_tokens);
        assert_eq!(accumulated.completion_tokens, before.completion_tokens);
        assert_eq!(accumulated.total_tokens, before.total_tokens);
    }

    #[test]
    fn chatanki_card_mutations_keep_explicit_read_write_read_order() {
        let calls = vec![
            tool_call("get-before", "builtin-chatanki_get_cards"),
            tool_call("update", "builtin-chatanki_update_card"),
            tool_call("get-after", "builtin-chatanki_get_cards"),
        ];

        let ordered = order_tool_calls_for_execution(&calls);
        let ids: Vec<&str> = ordered.iter().map(|call| call.id.as_str()).collect();
        assert_eq!(ids, vec!["get-before", "update", "get-after"]);
    }

    #[test]
    fn chatanki_export_still_runs_after_card_mutations() {
        let calls = vec![
            tool_call("export", "builtin-chatanki_export"),
            tool_call("delete", "builtin-chatanki_delete_card"),
            tool_call("add", "builtin-chatanki_add_cards"),
        ];

        let ordered = order_tool_calls_for_execution(&calls);
        let ids: Vec<&str> = ordered.iter().map(|call| call.id.as_str()).collect();
        assert_eq!(ids, vec!["delete", "add", "export"]);
    }

    #[test]
    fn chatanki_enqueue_runs_after_card_work_and_before_external_outputs() {
        let calls = vec![
            tool_call("sync", "builtin-chatanki_sync"),
            tool_call("enqueue", "builtin-chatanki_enqueue_review"),
            tool_call("delete", "builtin-chatanki_delete_card"),
            tool_call("export", "builtin-chatanki_export"),
            tool_call("get", "builtin-chatanki_get_cards"),
            tool_call("add", "builtin-chatanki_add_cards"),
            tool_call("update", "builtin-chatanki_update_card"),
        ];

        let ordered = order_tool_calls_for_execution(&calls);
        let ids: Vec<&str> = ordered.iter().map(|call| call.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["delete", "get", "add", "update", "enqueue", "sync", "export"]
        );
    }

    #[test]
    fn chatanki_retemplate_keeps_get_write_get_before_enqueue_and_export() {
        let calls = vec![
            tool_call("export", "builtin-chatanki_export"),
            tool_call("get-before", "builtin-chatanki_get_cards"),
            tool_call("retemplate", "builtin-chatanki_retemplate"),
            tool_call("enqueue", "builtin-chatanki_enqueue_review"),
            tool_call("get-after", "builtin-chatanki_get_cards"),
        ];

        let ordered = order_tool_calls_for_execution(&calls);
        let ids: Vec<&str> = ordered.iter().map(|call| call.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["get-before", "retemplate", "get-after", "enqueue", "export"]
        );
    }

    // -------------------------------------------------------------------------
    // AuthorityGate behaviour tests (Ask / Plan) through execute_single_tool
    // -------------------------------------------------------------------------

    struct CountingWriteExecutor {
        calls: Arc<std::sync::atomic::AtomicUsize>,
    }

    #[async_trait::async_trait]
    impl crate::chat_v2::tools::ToolExecutor for CountingWriteExecutor {
        fn can_handle(&self, tool_name: &str) -> bool {
            crate::chat_v2::pipeline::authority_mode::canonical_tool_name(tool_name)
                == "authority_probe_write"
        }

        async fn execute(
            &self,
            call: &ToolCall,
            _ctx: &crate::chat_v2::tools::ExecutionContext,
        ) -> Result<crate::chat_v2::types::ToolResultInfo, String> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(crate::chat_v2::types::ToolResultInfo {
                tool_call_id: Some(call.id.clone()),
                block_id: None,
                tool_name: call.name.clone(),
                input: call.arguments.clone(),
                output: json!({"ok": true}),
                success: true,
                error: None,
                duration_ms: Some(1),
                reasoning_content: None,
                thought_signature: None,
            })
        }

        fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
            ToolSensitivity::Medium
        }

        fn name(&self) -> &'static str {
            "CountingWriteExecutor"
        }
    }

    fn authority_test_harness(
        mode: crate::chat_v2::types::AuthorityMode,
    ) -> (
        tempfile::TempDir,
        ChatV2Pipeline,
        Arc<ChatV2EventEmitter>,
        Arc<std::sync::atomic::AtomicUsize>,
        String,
    ) {
        use crate::chat_v2::database::ChatV2Database;
        use crate::chat_v2::types::ChatSession;
        use crate::data_governance::migration::coordinator::MigrationCoordinator;
        use crate::data_governance::schema_registry::DatabaseId;
        use crate::database::Database;
        use crate::file_manager::FileManager;
        use crate::llm_manager::LLMManager;
        use crate::tools::ToolRegistry;

        let chat_dir = tempfile::TempDir::new().expect("chat temp");
        let mut coordinator =
            MigrationCoordinator::new(chat_dir.path().to_path_buf()).with_audit_db(None);
        coordinator
            .migrate_single(DatabaseId::ChatV2)
            .expect("chat_v2 migrate");
        let chat_db = Arc::new(ChatV2Database::new(chat_dir.path()).expect("chat db"));

        let main_dir = tempfile::TempDir::new().expect("main temp");
        let mut main_coordinator =
            MigrationCoordinator::new(main_dir.path().to_path_buf()).with_audit_db(None);
        main_coordinator
            .migrate_single(DatabaseId::Mistakes)
            .expect("main migrate");
        let main_db =
            Arc::new(Database::new(&main_dir.path().join("mistakes.db")).expect("main db"));
        let file_manager =
            Arc::new(FileManager::new(main_dir.path().join("app-data")).expect("file manager"));
        let llm_manager =
            Arc::new(LLMManager::new(main_db.clone(), file_manager).expect("llm manager"));

        let session_id = ChatSession::generate_id();
        let mut session = ChatSession::new(session_id.clone(), "chat".to_string());
        let authority = crate::chat_v2::types::SessionAuthorityState {
            authority_mode: mode,
            permission_preset: Default::default(),
            plan: None,
        };
        session.metadata = Some(authority.apply_to_metadata(None));
        ChatV2Repo::create_session_v2(&chat_db, &session).expect("create session");

        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let registry =
            Arc::new(ToolExecutorRegistry::from_vec(vec![
                Arc::new(CountingWriteExecutor {
                    calls: calls.clone(),
                }) as Arc<dyn crate::chat_v2::tools::ToolExecutor>,
            ]));

        let mut pipeline = ChatV2Pipeline::new(
            chat_db,
            Some(main_db),
            None,
            None,
            llm_manager,
            Arc::new(ToolRegistry::new()),
            None,
        )
        .with_approval_manager(Arc::new(ApprovalManager::new().with_timeout(2)));
        pipeline.executor_registry = registry;

        let emitter = Arc::new(ChatV2EventEmitter::new_windowless_for_test(
            session_id.clone(),
        ));
        // Keep main temp dir alive for the duration of the test.
        std::mem::forget(main_dir);
        (chat_dir, pipeline, emitter, calls, session_id)
    }

    #[tokio::test]
    async fn ask_mode_blocks_medium_write_without_calling_executor() {
        let (_dir, pipeline, emitter, calls, session_id) =
            authority_test_harness(crate::chat_v2::types::AuthorityMode::Ask);

        let tool = ToolCall {
            id: "call_ask_1".to_string(),
            name: "builtin-authority_probe_write".to_string(),
            arguments: json!({"path": "/tmp/x"}),
        };

        let result = pipeline
            .execute_single_tool(
                &tool,
                "blk_ask_1",
                &emitter,
                &session_id,
                "msg_ask_1",
                None,
                None,
                None,
                &None,
                &None,
                &None,
                &None,
                &None,
                &None,
                &None,
                None,
                None,
                None,
                true,
                true,
                true,
            )
            .await
            .expect("execute_single_tool");

        assert_eq!(
            calls.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "executor must not run in Ask mode"
        );
        assert!(!result.success);
        let err = result.error.as_deref().unwrap_or("");
        assert!(
            err.contains("AUTHORITY_BLOCKED") || err.contains("Ask"),
            "rejection semantics missing: {err}"
        );
        assert_eq!(
            result
                .output
                .get("authorityBlocked")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            result.output.get("suggestedMode").and_then(|v| v.as_str()),
            Some("plan")
        );
    }

    /// Behaviour-level Plan-mode state lifecycle test driven through the real
    /// persisted session authority state + AuthorityGate. The full
    /// `execute_single_tool` wiring is locked by the C4 regression test below.
    #[tokio::test]
    async fn plan_mode_suspends_then_allows_once_then_reblocks_after_expiry() {
        use crate::chat_v2::pipeline::authority_mode::{
            evaluate_authority_gate, AuthorityGateDecision,
        };
        use crate::chat_v2::types::{AuthorityMode, PlanAuthorityState, PlanStatus};

        let (_dir, pipeline, _emitter, _calls, session_id) =
            authority_test_harness(AuthorityMode::Plan);
        let db = pipeline.db.clone();
        let write_tool = "builtin-authority_probe_write";
        let binding = crate::chat_v2::pipeline::authority_mode::plan_call_binding_key(
            write_tool,
            &json!({"path": "/tmp/probe"}),
            Some("round-1"),
        );

        // 1) Plan mode with no plan → a write must suspend at the plan gate.
        let state =
            ChatV2Repo::get_session_authority_state(&db, &session_id).expect("load authority");
        assert_eq!(state.authority_mode, AuthorityMode::Plan);
        assert!(matches!(
            evaluate_authority_gate(
                &state,
                write_tool,
                Some(ToolSensitivity::Medium),
                Some(&binding),
                chrono::Utc::now()
            ),
            AuthorityGateDecision::WaitPlanGate { .. }
        ));

        // 2) Persist an approved, unexpired plan batch → gate allows the write.
        let mut approved = PlanAuthorityState::new_pending("write probe batch");
        approved.bind_to_call(binding.clone());
        approved.mark_approved(600);
        ChatV2Repo::set_session_plan_state(&db, &session_id, Some(approved))
            .expect("persist approved plan");
        let state =
            ChatV2Repo::get_session_authority_state(&db, &session_id).expect("reload authority");
        assert_eq!(
            evaluate_authority_gate(
                &state,
                write_tool,
                Some(ToolSensitivity::Medium),
                Some(&binding),
                chrono::Utc::now()
            ),
            AuthorityGateDecision::Allow,
            "approved unexpired plan must allow the write batch"
        );

        // 3) Expire the plan batch → the next write must re-enter the plan gate.
        let mut state = state;
        if let Some(plan) = state.plan.as_mut() {
            plan.approved_until =
                Some((chrono::Utc::now() - chrono::Duration::seconds(5)).to_rfc3339());
            plan.status = PlanStatus::Expired;
        }
        ChatV2Repo::set_session_plan_state(&db, &session_id, state.plan)
            .expect("persist expired plan");
        let state = ChatV2Repo::get_session_authority_state(&db, &session_id)
            .expect("reload expired authority");
        assert!(
            matches!(
                evaluate_authority_gate(
                    &state,
                    write_tool,
                    Some(ToolSensitivity::Medium),
                    Some(&binding),
                    chrono::Utc::now()
                ),
                AuthorityGateDecision::WaitPlanGate { .. }
            ),
            "expired plan batch must re-block subsequent writes"
        );
    }

    #[test]
    fn plan_binding_is_consumed_exactly_once_under_concurrency() {
        use crate::chat_v2::types::{AuthorityMode, PlanAuthorityState};
        use std::sync::{Arc, Barrier};

        let (_dir, pipeline, _emitter, _calls, session_id) =
            authority_test_harness(AuthorityMode::Plan);
        let binding = crate::chat_v2::pipeline::authority_mode::plan_call_binding_key(
            "builtin-authority_probe_write",
            &json!({"path": "/tmp/once"}),
            Some("round-once"),
        );
        let mut plan = PlanAuthorityState::new_pending("once");
        plan.bind_to_call(binding.clone());
        plan.mark_approved(600);
        ChatV2Repo::set_session_plan_state(&pipeline.db, &session_id, Some(plan)).unwrap();

        let barrier = Arc::new(Barrier::new(2));
        let mut workers = Vec::new();
        for _ in 0..2 {
            let db = pipeline.db.clone();
            let session_id = session_id.clone();
            let binding = binding.clone();
            let barrier = barrier.clone();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                ChatV2Repo::consume_session_plan_binding(
                    &db,
                    &session_id,
                    &binding,
                    chrono::Utc::now(),
                )
                .unwrap()
            }));
        }
        let consumed = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .filter(|consumed| *consumed)
            .count();
        assert_eq!(consumed, 1);
    }

    // -------------------------------------------------------------------------
    // C4: 会话三档权限 × 一键断电 × headless 白名单 — 跨模块真实集成
    // -------------------------------------------------------------------------

    struct C4Harness {
        _chat_dir: tempfile::TempDir,
        pipeline: ChatV2Pipeline,
        emitter: Arc<ChatV2EventEmitter>,
        calls: Arc<std::sync::atomic::AtomicUsize>,
        session_id: String,
        chat_state: Arc<crate::chat_v2::state::ChatV2State>,
        approval: Arc<ApprovalManager>,
    }

    /// Real ChatV2 SQLite + CountingWriteExecutor + shared KillSwitch (A8/A3 scaffolding).
    fn c4_integration_harness(mode: crate::chat_v2::types::AuthorityMode) -> C4Harness {
        use crate::chat_v2::database::ChatV2Database;
        use crate::chat_v2::types::ChatSession;
        use crate::data_governance::migration::coordinator::MigrationCoordinator;
        use crate::data_governance::schema_registry::DatabaseId;
        use crate::database::Database;
        use crate::file_manager::FileManager;
        use crate::llm_manager::LLMManager;
        use crate::tools::ToolRegistry;

        let chat_dir = tempfile::TempDir::new().expect("chat temp");
        let mut coordinator =
            MigrationCoordinator::new(chat_dir.path().to_path_buf()).with_audit_db(None);
        coordinator
            .migrate_single(DatabaseId::ChatV2)
            .expect("chat_v2 migrate");
        let chat_db = Arc::new(ChatV2Database::new(chat_dir.path()).expect("chat db"));

        let main_dir = tempfile::TempDir::new().expect("main temp");
        let mut main_coordinator =
            MigrationCoordinator::new(main_dir.path().to_path_buf()).with_audit_db(None);
        main_coordinator
            .migrate_single(DatabaseId::Mistakes)
            .expect("main migrate");
        let main_db =
            Arc::new(Database::new(&main_dir.path().join("mistakes.db")).expect("main db"));
        let file_manager =
            Arc::new(FileManager::new(main_dir.path().join("app-data")).expect("file manager"));
        let llm_manager =
            Arc::new(LLMManager::new(main_db.clone(), file_manager).expect("llm manager"));

        let session_id = ChatSession::generate_id();
        let mut session = ChatSession::new(session_id.clone(), "chat".to_string());
        let authority = crate::chat_v2::types::SessionAuthorityState {
            authority_mode: mode,
            permission_preset: Default::default(),
            plan: None,
        };
        session.metadata = Some(authority.apply_to_metadata(None));
        ChatV2Repo::create_session_v2(&chat_db, &session).expect("create session");

        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let registry =
            Arc::new(ToolExecutorRegistry::from_vec(vec![
                Arc::new(CountingWriteExecutor {
                    calls: calls.clone(),
                }) as Arc<dyn crate::chat_v2::tools::ToolExecutor>,
            ]));

        let chat_state = Arc::new(crate::chat_v2::state::ChatV2State::new());
        let approval = Arc::new(ApprovalManager::new().with_timeout(2));

        let mut pipeline = ChatV2Pipeline::new(
            chat_db,
            Some(main_db),
            None,
            None,
            llm_manager,
            Arc::new(ToolRegistry::new()),
            None,
        )
        .with_approval_manager(approval.clone())
        .with_kill_switch(chat_state.kill_switch.clone());
        pipeline.executor_registry = registry;

        let emitter = Arc::new(ChatV2EventEmitter::new_windowless_for_test(
            session_id.clone(),
        ));
        std::mem::forget(main_dir);
        C4Harness {
            _chat_dir: chat_dir,
            pipeline,
            emitter,
            calls,
            session_id,
            chat_state,
            approval,
        }
    }

    async fn c4_run_probe_write(
        pipeline: &ChatV2Pipeline,
        emitter: &Arc<ChatV2EventEmitter>,
        session_id: &str,
        call_id: &str,
        block_id: &str,
        execution_allowed_tools: Option<Vec<String>>,
    ) -> ToolResultInfo {
        let tool = ToolCall {
            id: call_id.to_string(),
            name: "builtin-authority_probe_write".to_string(),
            arguments: json!({"path": "/tmp/c4-probe"}),
        };
        pipeline
            .execute_single_tool(
                &tool,
                block_id,
                emitter,
                session_id,
                "msg_c4",
                None,
                None,
                None,
                &None,
                &None,
                &None,
                &None,
                &None,
                &None,
                &execution_allowed_tools,
                None,
                None,
                None,
                true,
                true,
                true,
            )
            .await
            .expect("execute_single_tool")
    }

    #[tokio::test]
    async fn approved_plan_binding_reaches_executor_without_secondary_approval() {
        use crate::chat_v2::types::PlanAuthorityState;

        let harness = c4_integration_harness(crate::chat_v2::types::AuthorityMode::Plan);
        let binding = crate::chat_v2::pipeline::authority_mode::plan_call_binding_key(
            "builtin-authority_probe_write",
            &json!({"path": "/tmp/c4-probe"}),
            None,
        );
        let mut plan = PlanAuthorityState::new_pending("execute approved probe");
        plan.bind_to_call(binding);
        plan.mark_approved(600);
        ChatV2Repo::set_session_plan_state(&harness.pipeline.db, &harness.session_id, Some(plan))
            .expect("persist approved plan");

        let result = c4_run_probe_write(
            &harness.pipeline,
            &harness.emitter,
            &harness.session_id,
            "call_plan_approved",
            "blk_plan_approved",
            None,
        )
        .await;

        assert!(result.success, "approved Plan call was blocked: {result:?}");
        assert_eq!(
            harness.calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "approved Plan call must reach the executor exactly once"
        );
        let state =
            ChatV2Repo::get_session_authority_state(&harness.pipeline.db, &harness.session_id)
                .expect("reload consumed plan");
        assert!(
            state.plan.is_none(),
            "the approved Plan binding must be consumed before execution"
        );
    }

    #[tokio::test]
    async fn missing_approval_manager_blocks_required_tool_before_executor() {
        let mut harness = c4_integration_harness(crate::chat_v2::types::AuthorityMode::Craft);
        ChatV2Repo::set_session_permission_preset(
            &harness.pipeline.db,
            &harness.session_id,
            crate::chat_v2::types::PermissionPreset::Cautious,
        )
        .expect("set cautious preset");
        harness.pipeline.approval_manager = None;

        let result = c4_run_probe_write(
            &harness.pipeline,
            &harness.emitter,
            &harness.session_id,
            "call_missing_approval",
            "blk_missing_approval",
            None,
        )
        .await;

        assert!(!result.success);
        assert_eq!(
            harness.calls.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "executor must not run when required approval service is absent"
        );
        assert!(
            result
                .error
                .as_deref()
                .is_some_and(|error| error.contains("审批服务不可用")),
            "missing approval service must return the fail-closed reason: {result:?}"
        );
    }

    async fn c4_seed_remembered_allow(
        approval: &ApprovalManager,
        tool_name: &str,
        args: &serde_json::Value,
    ) {
        let _rx = approval.register_with_scope("seed_sess", "seed_call", tool_name, args);
        let mut resp = crate::chat_v2::approval_manager::ApprovalResponse::approved(
            "seed_sess".to_string(),
            "seed_call".to_string(),
            tool_name.to_string(),
        );
        resp.remember = true;
        assert!(
            approval.respond(resp),
            "seed remembered allow must deliver to pending waiter"
        );
        assert_eq!(
            approval.check_remembered(tool_name, args),
            Some(true),
            "remembered allow must be visible to tool_loop"
        );
    }

    /// C4-1: Ask 模式 + 写工具 → 执行器 0 调用 + 结构化拒绝（真实 tool_loop）。
    #[tokio::test]
    async fn c4_ask_mode_write_tool_zero_executor_structured_reject() {
        let harness = c4_integration_harness(crate::chat_v2::types::AuthorityMode::Ask);

        let result = c4_run_probe_write(
            &harness.pipeline,
            &harness.emitter,
            &harness.session_id,
            "c4_ask_1",
            "blk_c4_ask_1",
            None,
        )
        .await;

        assert_eq!(
            harness.calls.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "Ask mode must not invoke write executor"
        );
        assert!(!result.success);
        let err = result.error.as_deref().unwrap_or("");
        assert!(
            err.contains("AUTHORITY_BLOCKED") || err.contains("Ask"),
            "structured Ask rejection missing: {err}"
        );
        assert_eq!(
            result
                .output
                .get("authorityBlocked")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            result.output.get("suggestedMode").and_then(|v| v.as_str()),
            Some("plan")
        );
        // DB still Ask after rejection
        let persisted =
            ChatV2Repo::get_session_authority_state(&harness.pipeline.db, &harness.session_id)
                .expect("authority from db");
        assert_eq!(
            persisted.authority_mode,
            crate::chat_v2::types::AuthorityMode::Ask
        );
    }

    /// C4-2: Craft + KillSwitch trip → 新工具执行全局拒绝（断电优先于会话档位）。
    #[tokio::test]
    async fn c4_craft_kill_switch_blocks_write_despite_craft_mode() {
        use crate::chat_v2::kill_switch::KILL_SWITCH_BLOCKED_MESSAGE;

        let harness = c4_integration_harness(crate::chat_v2::types::AuthorityMode::Craft);
        let args = json!({"path": "/tmp/c4-probe"});
        c4_seed_remembered_allow(&harness.approval, "builtin-authority_probe_write", &args).await;

        // Baseline: Craft + remembered allow would execute (side-effect counter).
        let ok = c4_run_probe_write(
            &harness.pipeline,
            &harness.emitter,
            &harness.session_id,
            "c4_craft_baseline",
            "blk_c4_craft_baseline",
            None,
        )
        .await;
        assert!(
            ok.success,
            "baseline Craft write must succeed: {:?}",
            ok.error
        );
        assert_eq!(
            harness.calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "baseline executor must run once"
        );

        assert!(harness.chat_state.kill_switch.trip("c4_craft_trip"));
        assert!(
            harness
                .chat_state
                .try_register_stream("c4_new_stream")
                .is_err(),
            "stream admission must fail while tripped"
        );

        let blocked = c4_run_probe_write(
            &harness.pipeline,
            &harness.emitter,
            &harness.session_id,
            "c4_craft_blocked",
            "blk_c4_craft_blocked",
            None,
        )
        .await;

        assert_eq!(
            harness.calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "KillSwitch must block further executor calls (still 1 from baseline)"
        );
        assert!(!blocked.success);
        assert_eq!(blocked.error.as_deref(), Some(KILL_SWITCH_BLOCKED_MESSAGE));
        assert_eq!(
            blocked
                .output
                .get("killSwitchBlocked")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        // Session authority remains Craft — rejection is kill-switch, not Ask.
        let persisted =
            ChatV2Repo::get_session_authority_state(&harness.pipeline.db, &harness.session_id)
                .expect("authority");
        assert_eq!(
            persisted.authority_mode,
            crate::chat_v2::types::AuthorityMode::Craft
        );

        harness.chat_state.kill_switch.reset();
    }

    /// C4-3: Plan 批准后 KillSwitch trip → 后续写操作仍被断电拦截。
    #[tokio::test]
    async fn c4_plan_approved_then_kill_switch_still_blocks_writes() {
        use crate::chat_v2::kill_switch::KILL_SWITCH_BLOCKED_MESSAGE;
        use crate::chat_v2::types::{AuthorityMode, PlanAuthorityState};

        let harness = c4_integration_harness(AuthorityMode::Plan);
        let args = json!({"path": "/tmp/c4-probe"});
        c4_seed_remembered_allow(&harness.approval, "builtin-authority_probe_write", &args).await;

        let mut approved = PlanAuthorityState::new_pending("c4 plan batch");
        approved.bind_to_call(
            crate::chat_v2::pipeline::authority_mode::plan_call_binding_key(
                "builtin-authority_probe_write",
                &args,
                None,
            ),
        );
        approved.mark_approved(600);
        ChatV2Repo::set_session_plan_state(
            &harness.pipeline.db,
            &harness.session_id,
            Some(approved),
        )
        .expect("persist approved plan");

        let authority =
            ChatV2Repo::get_session_authority_state(&harness.pipeline.db, &harness.session_id)
                .expect("load plan authority");
        assert_eq!(authority.authority_mode, AuthorityMode::Plan);
        assert!(
            authority
                .plan
                .as_ref()
                .is_some_and(|p| p.is_batch_active(chrono::Utc::now())),
            "plan batch must be active in DB before kill switch"
        );

        assert!(harness.chat_state.kill_switch.trip("c4_plan_trip"));

        let blocked = c4_run_probe_write(
            &harness.pipeline,
            &harness.emitter,
            &harness.session_id,
            "c4_plan_ks",
            "blk_c4_plan_ks",
            None,
        )
        .await;

        assert_eq!(
            harness.calls.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "approved Plan must not execute writes while KillSwitch is tripped"
        );
        assert!(!blocked.success);
        assert_eq!(blocked.error.as_deref(), Some(KILL_SWITCH_BLOCKED_MESSAGE));
        assert_eq!(
            blocked
                .output
                .get("killSwitchBlocked")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        // Plan approval still persisted — kill switch did not clear it.
        let after =
            ChatV2Repo::get_session_authority_state(&harness.pipeline.db, &harness.session_id)
                .expect("reload");
        assert!(after
            .plan
            .as_ref()
            .is_some_and(|p| p.is_batch_active(chrono::Utc::now())));

        harness.chat_state.kill_switch.reset();
    }

    /// C4-4: headless 路径 + Ask 档位持久化 → 写工具被拒（白名单放行也挡不住 Ask）。
    #[tokio::test]
    async fn c4_headless_ask_persisted_blocks_write_on_tool_loop() {
        use crate::chat_v2::headless::{create_headless_session, headless_allowed_tools};
        use crate::chat_v2::types::{AuthorityMode, SessionAuthorityState};

        let harness = c4_integration_harness(AuthorityMode::Craft);
        // Replace session with a real headless session that persists Ask.
        let headless_id = create_headless_session(
            &harness.pipeline.db,
            "automation",
            "c4-headless-ask",
            json!({
                "automation_run": true,
                "source": "c4_integration",
            }),
        )
        .expect("create headless session");
        let ask_state = SessionAuthorityState {
            authority_mode: AuthorityMode::Ask,
            permission_preset: Default::default(),
            plan: None,
        };
        ChatV2Repo::set_session_authority_mode(
            &harness.pipeline.db,
            &headless_id,
            AuthorityMode::Ask,
        )
        .expect("persist Ask on headless session");
        // Ensure metadata round-trip keeps Ask (apply_to_metadata path).
        if let Some(mut session) =
            ChatV2Repo::get_session_v2(&harness.pipeline.db, &headless_id).expect("get session")
        {
            session.metadata = Some(ask_state.apply_to_metadata(session.metadata.take()));
            ChatV2Repo::update_session_v2(&harness.pipeline.db, &session)
                .expect("update headless metadata");
        }

        let loaded = ChatV2Repo::get_session_authority_state(&harness.pipeline.db, &headless_id)
            .expect("reload headless authority");
        assert_eq!(loaded.authority_mode, AuthorityMode::Ask);
        let session = ChatV2Repo::get_session_v2(&harness.pipeline.db, &headless_id)
            .expect("session")
            .expect("exists");
        assert_eq!(
            session
                .metadata
                .as_ref()
                .and_then(|m| m.get("headless"))
                .and_then(|v| v.as_bool()),
            Some(true),
            "headless marker must persist"
        );

        // Headless execution policy allowlist, plus probe write (models can still
        // invent out-of-schema names; Ask must refuse even if allowlisted).
        let mut allowed = headless_allowed_tools();
        allowed.push("builtin-authority_probe_write".to_string());

        let result = c4_run_probe_write(
            &harness.pipeline,
            &harness.emitter,
            &headless_id,
            "c4_headless_ask",
            "blk_c4_headless_ask",
            Some(allowed),
        )
        .await;

        assert_eq!(
            harness.calls.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "headless Ask turn must not invoke write executor"
        );
        assert!(!result.success);
        assert_eq!(
            result
                .output
                .get("authorityBlocked")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        let err = result.error.as_deref().unwrap_or("");
        assert!(
            err.contains("AUTHORITY_BLOCKED"),
            "headless Ask must surface AUTHORITY_BLOCKED, got: {err}"
        );
    }

    /// C4-5: KillSwitch trip → reject_all_pending 生效；resume 后可正常执行。
    #[tokio::test]
    async fn c4_kill_switch_reject_all_pending_then_resume_allows_write() {
        use crate::chat_v2::kill_switch::KILL_SWITCH_BLOCKED_MESSAGE;
        use crate::chat_v2::types::AuthorityMode;

        let harness = c4_integration_harness(AuthorityMode::Craft);
        let args = json!({"path": "/tmp/c4-probe"});

        // Pending approval waiter (simulates in-flight Medium tool).
        let pending_rx = harness.approval.register_with_scope(
            &harness.session_id,
            "pending_c4",
            "builtin-authority_probe_write",
            &args,
        );
        assert_eq!(harness.approval.pending_count(), 1);

        assert!(harness.chat_state.kill_switch.trip("c4_emergency"));
        // Mirror emergency_stop: drain approvals + cancel streams.
        let rejected = harness.approval.reject_all_pending("c4_emergency");
        assert_eq!(rejected, 1);
        assert_eq!(harness.approval.pending_count(), 0);
        let resp = pending_rx.await.expect("pending waiter must unblock");
        assert!(!resp.approved);
        assert_eq!(resp.reason.as_deref(), Some("c4_emergency"));

        // While tripped, even remembered allow cannot execute.
        c4_seed_remembered_allow(&harness.approval, "builtin-authority_probe_write", &args).await;
        let blocked = c4_run_probe_write(
            &harness.pipeline,
            &harness.emitter,
            &harness.session_id,
            "c4_while_tripped",
            "blk_c4_while_tripped",
            None,
        )
        .await;
        assert_eq!(harness.calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(blocked.error.as_deref(), Some(KILL_SWITCH_BLOCKED_MESSAGE));

        // resume_agents equivalent
        harness.chat_state.kill_switch.reset();
        assert!(harness.chat_state.kill_switch.ensure_allowed().is_ok());
        assert!(harness
            .chat_state
            .try_register_stream("c4_resume_stream")
            .is_ok());
        harness.chat_state.remove_stream("c4_resume_stream");

        let ok = c4_run_probe_write(
            &harness.pipeline,
            &harness.emitter,
            &harness.session_id,
            "c4_after_resume",
            "blk_c4_after_resume",
            None,
        )
        .await;
        assert!(
            ok.success,
            "after resume Craft write must execute: {:?}",
            ok.error
        );
        assert_eq!(
            harness.calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "executor must run exactly once after resume"
        );
        assert_eq!(ok.output.get("ok").and_then(|v| v.as_bool()), Some(true));
    }
}
