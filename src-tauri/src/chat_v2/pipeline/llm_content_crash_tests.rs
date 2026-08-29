//! llm_content sidecar 崩溃窗口模拟测试（Wave2-A 第 3 轮 #4，2026-08）
//!
//! ## 崩溃窗口
//!
//! `persist_replay_sidecar` 原本挂在 save_results（流程末）。存在窗口：
//! 请求已发给 provider（模型已看到完整包装字节），但进程在 save_results
//! 之前崩溃 → 用户 CONTENT 块的 `llm_content` 列仍为 NULL。
//!
//! ## 预期（本文件断言的合同）
//!
//! 1. **无前移**（sidecar 只在 save_results 写）：崩溃后下一轮
//!    `load_chat_history` 走 history.rs 的回退分支，只能看到裸
//!    user_content——不含 `<user_query>` 包装、不含 `<injected_context>`；
//!    与 live 实际发送字节**不相等**，即跨轮字节漂移（prompt cache 必 miss，
//!    且模型上一轮与本轮看到的"同一条"用户消息字节不同）。
//! 2. **有前移**（#1 任务：在 `save_user_message_immediately` 的行 INSERT
//!    之后、首个网络请求之前，轻量事务只写 user 块 `llm_content`）：
//!    崩溃后 sidecar 已在，下一轮重放用完整包装，与 live 发送字节**相等**。
//! 3. 边界：`llm_content` 为空字符串视同缺失（对齐 history.rs 的
//!    `.filter(|text| !text.is_empty())`），回退裸文本，不得回放空包装。
//!
//! ## 第 7 轮 #5 补强（2026-08，只写不跑）
//!
//! 在第 3 轮三个场景之上追加（依据 r3-llm-content-forward.md 与
//! r6-llm-content.md 二检的静态证据）：
//!
//! - **崩溃点细分**：早写之前崩溃（未发 provider，无跨轮漂移，无害）；
//!   早写之后、发送之前崩溃（sidecar 成为下一轮的确定性锚点）。
//! - **保存点重建不抹早写**：复刻 repo.rs `create_block_with_conn` 的
//!   `ON CONFLICT(id) DO UPDATE SET` 列清单语义（SET 清单不含
//!   `llm_content` 等三旁路列，r6 §2.4）——工具轮间/流程末重建用户块行
//!   不得清掉早写字节；随后 `persist_replay_sidecar` 以同值幂等重写。
//! - **编辑重发**：编辑事务失效旧 sidecar 后早写补新编译包装，
//!   任何崩溃点都不得复活编辑前的旧包装字节。
//! - **旧库兼容**：V20260806 列未迁移时早写静默跳过（repo 层
//!   `no such column` → Ok），关键合同是**不阻断发送**。
//! - **legacy 多 CONTENT 块**（A1 前孤儿）：写侧取首个 CONTENT 块、
//!   读侧 find_map 同序首个 Some —— 写读同行；并钉死「首块空串遮蔽
//!   后块非空值」的现状角落（filter 挂在 find_map 之后）。
//! - **边界补强**：空白串不视同缺失（读侧只过滤 `is_empty`）；
//!   多字节 UTF-8 逐字节保真（sidecar 是字节权威，不得规范化）。
//! - **已知缺口记录**：multi_variant 扇出不经 execute_internal 阶段 4.6，
//!   无早写，崩溃窗口仍在（r6 §3.2，记录非修复）。
//!
//! retry 轮包装无处落库的既有缺口（r6 §3.3）由
//! `llm_content_retry_gap_tests.rs`（第 7 轮 #6）单独覆盖，本文件不重复。
//!
//! ## 实现说明
//!
//! 只写不跑（第 3 轮纪律：禁止编译/测试执行）。不连真实 DB：用假结构体
//! `FakeUserBlockRow` 模拟 DB 行，`FakeTurnTimeline` 按事件顺序模拟
//! pipeline 时序（INSERT → compile → [前移写 sidecar] → 发 provider →
//! 崩溃），`replay_user_content` 复刻 history.rs 的 llm_content override
//! 语义（Some 且非空 → 用包装；否则回退裸文本）。
//!
//! 本模块由 `pipeline.rs` 的 `#[cfg(test)] mod llm_content_crash_tests;`
//! 声明（mod 声明由父代理添加），仅在测试构建时编译。

// ============================================================================
// 假结构体：模拟 DB 行与 pipeline 时序，不触真实 repo/rusqlite
// ============================================================================

/// 模拟用户消息 CONTENT 块在 DB 中的一行。
///
/// - `content`：`save_user_message_immediately` INSERT 的裸用户输入；
/// - `llm_content`：V20260806 sidecar 列，live 实际发送的完整包装
///   （`<user_query>` + `<injected_context>`/`<runtime_facts>`），
///   NULL = 未写入（老数据 / 崩溃窗口内）。
#[derive(Debug, Clone)]
struct FakeUserBlockRow {
    content: String,
    llm_content: Option<String>,
}

/// 一轮发送的时序模拟。字段即事件发生的证据：
/// 按 pipeline 真实顺序推进，崩溃点固定在「已发 provider、
/// save_results 未执行」。
struct FakeTurnTimeline {
    /// save_user_message_immediately 之后的 DB 行（裸文本已 INSERT）
    row: FakeUserBlockRow,
    /// compile 完成后 ctx.live_user_llm_content() 的值（完整包装）
    live_user_llm_content: String,
    /// 首个网络请求实际发出的用户消息字节
    sent_to_provider: Option<String>,
}

impl FakeTurnTimeline {
    /// 事件 1：用户块行 INSERT（裸文本）+ 事件 2：当前 user 编译完成。
    fn after_compile(bare_content: &str, wrapped: &str) -> Self {
        Self {
            row: FakeUserBlockRow {
                content: bare_content.to_string(),
                llm_content: None,
            },
            live_user_llm_content: wrapped.to_string(),
            sent_to_provider: None,
        }
    }

    /// 事件 2.5（#1 前移）：行 INSERT 之后、首个网络请求之前，
    /// 轻量事务只写 user 块 llm_content。模拟 persist_replay_sidecar
    /// 的 user 块分支（targeted UPDATE，需要行已存在）。
    fn early_persist_user_llm_content(&mut self) {
        assert!(
            self.sent_to_provider.is_none(),
            "前移必须发生在首个网络请求之前"
        );
        self.row.llm_content = Some(self.live_user_llm_content.clone());
    }

    /// 事件 2.5'（旧库变体，第 7 轮补强）：V20260806 迁移未跑，
    /// `llm_content` 列不存在。repo 层按 `no such column` 静默跳过并
    /// 返回 Ok（repo.rs `update_block_replay_with_conn` 既有行为）——
    /// 早写等价 no-op。方法正常返回本身即模拟「Ok、不阻断发送」：
    /// 时序得以推进到 send_to_provider。
    fn early_persist_on_unmigrated_db(&mut self) {
        assert!(
            self.sent_to_provider.is_none(),
            "前移必须发生在首个网络请求之前"
        );
        // 列不存在：什么都不写。llm_content 保持 NULL。
    }

    /// 事件 3：首个网络请求——provider 看到的就是完整包装字节。
    fn send_to_provider(&mut self) {
        self.sent_to_provider = Some(self.live_user_llm_content.clone());
    }

    /// 事件 3.5（第 7 轮补强）：工具轮间/流程末保存点重建用户块行。
    /// 复刻 repo.rs `create_block_with_conn` 的
    /// `ON CONFLICT(id) DO UPDATE SET` **列清单式**更新（r6 §2.4）：
    /// SET 清单不含 `llm_content` / `tool_call_id` / `round_text`
    /// 三旁路列——重建业务列时**保留**行上既有 sidecar。
    /// 若未来退化为 `INSERT OR REPLACE`（整行重建、sidecar 归 NULL），
    /// 场景 5 的断言应当红。
    fn rebuild_row_at_save_point(&mut self) {
        self.row = FakeUserBlockRow {
            // 业务列（content 等）按 DO UPDATE 语义同值重写
            content: self.row.content.clone(),
            // SET 清单不含此列 → 行上原值原样保留
            llm_content: self.row.llm_content.clone(),
        };
    }

    /// 事件 3.6（第 7 轮补强）：同一保存点内 `persist_replay_sidecar`
    /// 以同一 `live_user_llm_content()` 幂等重写 user 块 sidecar
    /// （与早写同源同值，无冲突，r3 文档「明确不做」节）。
    fn save_point_persist_replay_sidecar(&mut self) {
        self.row.llm_content = Some(self.live_user_llm_content.clone());
    }

    /// 事件 4：进程崩溃。save_results（含旧位置的 persist_replay_sidecar）
    /// 永远不会执行——返回崩溃时刻的 DB 行快照，供下一轮重放读取。
    fn crash_before_save_results(self) -> FakeUserBlockRow {
        assert!(
            self.sent_to_provider.is_some(),
            "本测试模拟的崩溃窗口以「已发 provider」为前提"
        );
        self.row
    }

    /// 事件 4'（第 7 轮补强）：更早的崩溃点——首个网络请求尚未发出。
    /// 模型从未看到本轮任何字节，因此不存在「模型已见 vs 重放」的
    /// 跨轮漂移问题；返回崩溃时刻行快照供断言。
    fn crash_before_first_send(self) -> FakeUserBlockRow {
        assert!(
            self.sent_to_provider.is_none(),
            "本崩溃点以「尚未发 provider」为前提"
        );
        self.row
    }
}

/// 复刻 history.rs 用户消息重放的 llm_content override 语义：
/// sidecar 列有值且非空 → 字节权威（完整包装）；否则回退裸文本重建。
fn replay_user_content(row: &FakeUserBlockRow) -> String {
    row.llm_content
        .clone()
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| row.content.clone())
}

/// 第 7 轮补强：复刻 history.rs 多 CONTENT 块的读侧算子顺序
/// （history.rs `llm_content_override`，blocks 已按 block_index ASC）：
///
/// ```text
/// blocks.iter().find_map(|b| replay_map[b.id].llm_content.clone())
///       .filter(|text| !text.is_empty())
/// ```
///
/// 关键在算子顺序：`find_map` 停在**首个 Some**（含 Some("")），
/// `.filter(!is_empty)` 作用于 find_map 的整体结果而非逐块——
/// 首块空串会遮蔽后块的非空包装，整体判空后回退裸文本。
/// 本 helper 逐算子对齐源码，供 legacy 多块场景钉死该语义。
fn replay_user_content_from_blocks(bare_fallback: &str, blocks: &[FakeUserBlockRow]) -> String {
    blocks
        .iter()
        .find_map(|block| block.llm_content.clone())
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| bare_fallback.to_string())
}

const BARE: &str = "帮我总结这份周报";
const WRAPPED: &str = "<user_query>\n帮我总结这份周报\n</user_query>\n\n\
<injected_context>\n<runtime_facts>\n当前日期: 2026-08-26\n</runtime_facts>\n\
</injected_context>";

// 编辑重发：新裸文本 + 编辑轮新编译的包装（runtime_facts 日期亦变，
// 模拟编辑发生在次日——旧包装与新包装逐字节不同）
const BARE_EDITED: &str = "帮我总结这份周报，并单独列出风险项";
const WRAPPED_EDITED: &str = "<user_query>\n帮我总结这份周报，并单独列出风险项\n</user_query>\n\n\
<injected_context>\n<runtime_facts>\n当前日期: 2026-08-27\n</runtime_facts>\n\
</injected_context>";

// 多字节保真：CJK + emoji + 拉丁重音 + 零宽空格，任何规范化/转码都会改变字节
const WRAPPED_MULTIBYTE: &str = "<user_query>\n总结📝 café 週報\u{200b}résumé\n</user_query>\n\n\
<injected_context>\n<runtime_facts>\n当前日期: 2026-08-26\n</runtime_facts>\n\
</injected_context>";

// ============================================================================
// 场景 1：无前移——崩溃后下一轮只能看到裸 user_content（记录现状缺陷）
// ============================================================================

/// 无前移：已发 provider、save_results 未跑时崩溃，
/// 下一轮 history 重放只剩裸 user_content，与 live 发送字节漂移。
#[test]
fn crash_after_send_without_early_persist_replays_bare_user_content() {
    let mut turn = FakeTurnTimeline::after_compile(BARE, WRAPPED);
    // 无前移：直接发 provider，然后崩溃
    turn.send_to_provider();
    let live_sent = turn.sent_to_provider.clone().unwrap();
    let row_after_crash = turn.crash_before_save_results();

    // sidecar 从未写入
    assert!(
        row_after_crash.llm_content.is_none(),
        "崩溃窗口内 save_results 未执行，llm_content 列必须仍为 NULL"
    );

    // 下一轮重放：只能回退裸文本
    let replayed = replay_user_content(&row_after_crash);
    assert_eq!(replayed, BARE, "无 sidecar 时下一轮只能看到裸 user_content");
    assert!(
        !replayed.contains("<user_query>"),
        "裸文本回退不含 <user_query> 包装"
    );
    assert!(
        !replayed.contains("<injected_context>"),
        "裸文本回退不含注入上下文"
    );

    // 跨轮字节漂移：重放字节 ≠ live 发送字节（prompt cache 必 miss）
    assert_ne!(
        replayed, live_sent,
        "无前移时崩溃导致重放与 live 发送字节不相等（跨轮漂移）"
    );
}

// ============================================================================
// 场景 2：有前移——sidecar 已在，重放用完整包装，与 live 字节相等
// ============================================================================

/// 有前移（#1）：INSERT 后、首个网络请求前写入 llm_content，
/// 同一崩溃点下一轮重放用完整包装，与 live 发送字节相等。
#[test]
fn crash_after_send_with_early_persist_replays_live_wrapped_bytes() {
    let mut turn = FakeTurnTimeline::after_compile(BARE, WRAPPED);
    // #1 前移：compile 完成且行已 INSERT 之后、发 provider 之前
    turn.early_persist_user_llm_content();
    turn.send_to_provider();
    let live_sent = turn.sent_to_provider.clone().unwrap();
    let row_after_crash = turn.crash_before_save_results();

    // 同一崩溃点，但 sidecar 已在
    assert_eq!(
        row_after_crash.llm_content.as_deref(),
        Some(WRAPPED),
        "前移后崩溃窗口内 llm_content 已持久化为 live 完整包装"
    );

    // 下一轮重放：字节权威 = 完整包装
    let replayed = replay_user_content(&row_after_crash);
    assert_eq!(
        replayed, live_sent,
        "有前移时重放字节与 live 发送字节相等（无跨轮漂移）"
    );
    assert!(
        replayed.contains("<user_query>") && replayed.contains("<injected_context>"),
        "重放必须使用完整包装而非裸文本"
    );
}

// ============================================================================
// 边界：空字符串 sidecar 视同缺失，回退裸文本
// ============================================================================

/// 对齐 history.rs `.filter(|text| !text.is_empty())`：
/// llm_content 为空串时不得回放空包装，必须回退裸文本。
#[test]
fn empty_llm_content_sidecar_falls_back_to_bare_content() {
    let row = FakeUserBlockRow {
        content: BARE.to_string(),
        llm_content: Some(String::new()),
    };
    assert_eq!(
        replay_user_content(&row),
        BARE,
        "空串 sidecar 视同缺失，回退裸 user_content"
    );
}

/// 现状记录（第 7 轮补强，非背书）：读侧只过滤 `is_empty`，
/// **空白串不视同缺失**——会被原样当作字节权威回放。写侧从不写
/// 空白包装，此为理论角落；若未来把判空改成 trim 后判空
/// （语义变更），本测试应当红提醒同步更新回退合同。
#[test]
fn whitespace_only_llm_content_sidecar_is_replayed_verbatim() {
    let row = FakeUserBlockRow {
        content: BARE.to_string(),
        llm_content: Some(" \n\t".to_string()),
    };
    assert_eq!(
        replay_user_content(&row),
        " \n\t",
        "空白串非空串：现行语义原样回放，不回退裸文本"
    );
}

// ============================================================================
// 场景 3（第 7 轮补强）：发送前崩溃——无害崩溃点，不构成跨轮漂移
// ============================================================================

/// 崩溃发生在行 INSERT / 编译完成之后、早写与首个网络请求之前：
/// 模型从未看到本轮任何字节。下一轮回退裸文本重建是**首次**发送，
/// 不存在「模型已见 vs 重放」的字节漂移——钉死早写窗口的下界：
/// 早写只需覆盖「已发未存」窗口，发送前崩溃本来就无害。
#[test]
fn crash_before_first_send_is_harmless_no_cross_turn_drift() {
    let turn = FakeTurnTimeline::after_compile(BARE, WRAPPED);
    // 早写与发送都未发生，直接崩溃
    let row_after_crash = turn.crash_before_first_send();

    assert!(
        row_after_crash.llm_content.is_none(),
        "早写未执行，llm_content 仍为 NULL"
    );
    // 下一轮回退裸文本——因为 live 从未发送，这不是漂移而是首发
    assert_eq!(
        replay_user_content(&row_after_crash),
        BARE,
        "发送前崩溃：下一轮以裸文本重建首发，无「已见字节」可漂移"
    );
}

// ============================================================================
// 场景 4（第 7 轮补强）：早写后、发送前崩溃——sidecar 成为确定性锚点
// ============================================================================

/// 崩溃发生在早写之后、首个网络请求之前：模型仍未见任何字节，
/// 但 sidecar 已持久化编译包装。下一轮重放该包装作为首发字节——
/// 确定性锚点：之后每轮重放同一包装，字节恒定（prompt cache 前缀稳定），
/// 不会因回退重建（runtime_facts 随日期变化）产生轮间抖动。
#[test]
fn crash_after_early_persist_before_send_replays_persisted_wrapper() {
    let mut turn = FakeTurnTimeline::after_compile(BARE, WRAPPED);
    turn.early_persist_user_llm_content();
    // 尚未发 provider 即崩溃
    let row_after_crash = turn.crash_before_first_send();

    assert_eq!(
        row_after_crash.llm_content.as_deref(),
        Some(WRAPPED),
        "早写已落库：崩溃不丢编译包装"
    );
    let replayed = replay_user_content(&row_after_crash);
    assert_eq!(
        replayed, WRAPPED,
        "下一轮以持久化包装为字节权威——首发即锚定，后续轮字节恒定"
    );
    assert_ne!(
        replayed, BARE,
        "有 sidecar 时不得回退裸文本重建（重建会随 runtime_facts 漂移）"
    );
}

// ============================================================================
// 场景 5（第 7 轮补强）：保存点重建行不抹早写 + 幂等重写（正常流全链）
// ============================================================================

/// 无崩溃的完整时序：早写 → 发送 → 保存点重建用户块行（DO UPDATE
/// 列清单，r6 §2.4）→ persist_replay_sidecar 同值幂等重写。
/// 两个合同：重建**不得**清掉早写字节（防 INSERT OR REPLACE 回归）；
/// 幂等重写后与 live 发送字节仍逐字节相等。
#[test]
fn save_point_rebuild_preserves_early_sidecar_and_rewrites_idempotently() {
    let mut turn = FakeTurnTimeline::after_compile(BARE, WRAPPED);
    turn.early_persist_user_llm_content();
    turn.send_to_provider();
    let live_sent = turn.sent_to_provider.clone().unwrap();

    // 工具轮间保存点：重建用户块行（列清单式 DO UPDATE）
    turn.rebuild_row_at_save_point();
    assert_eq!(
        turn.row.llm_content.as_deref(),
        Some(WRAPPED),
        "DO UPDATE 的 SET 清单不含 llm_content：重建不得抹掉早写字节"
    );

    // 同保存点随后的 persist_replay_sidecar：同源同值幂等重写
    turn.save_point_persist_replay_sidecar();
    assert_eq!(
        turn.row.llm_content.as_deref(),
        Some(WRAPPED),
        "幂等重写与早写同值：无冲突、无字节变化"
    );

    // 此后任意崩溃点（如 save_results 前）重放恒等于 live 字节
    let row_after_crash = turn.crash_before_save_results();
    assert_eq!(
        replay_user_content(&row_after_crash),
        live_sent,
        "全链之后重放字节与 live 发送字节逐字节相等"
    );
}

// ============================================================================
// 场景 6（第 7 轮补强）：编辑重发——失效旧 sidecar，早写补新包装
// ============================================================================

/// 编辑重发（skip_user_message_save 路径，V20260806 P0）：
/// 编辑事务改写 content 并失效旧 `llm_content`；编辑轮早写经
/// `existing_user_content_block_id` 找回**既有行**补写新编译包装。
/// 合同：任何崩溃点都不得复活编辑前的旧包装字节。
#[test]
fn edit_resend_invalidates_stale_sidecar_then_early_persist_backfills() {
    // 首发轮已完整落库的行
    let mut row = FakeUserBlockRow {
        content: BARE.to_string(),
        llm_content: Some(WRAPPED.to_string()),
    };

    // 编辑事务：新裸文本 + 失效旧 sidecar（send_message.rs 编辑路径）
    row.content = BARE_EDITED.to_string();
    row.llm_content = None;

    // 若编辑轮在早写之前崩溃：回退**新**裸文本，绝不回放编辑前旧包装
    let replayed_pre_early = replay_user_content(&row);
    assert_eq!(
        replayed_pre_early, BARE_EDITED,
        "失效后崩溃：回退编辑后的裸文本"
    );
    assert_ne!(replayed_pre_early, WRAPPED, "编辑前旧包装已失效，不得复活");

    // 编辑轮早写：行已由编辑事务保证存在，补写编辑轮新编译包装
    row.llm_content = Some(WRAPPED_EDITED.to_string());

    // 已发 provider 后、save_results 前崩溃：重放 == 编辑轮 live 字节
    let replayed = replay_user_content(&row);
    assert_eq!(
        replayed, WRAPPED_EDITED,
        "编辑轮早写后崩溃：重放与编辑轮 live 发送字节相等"
    );
    assert_ne!(
        replayed, WRAPPED,
        "重放的是编辑轮新包装，而非编辑前旧包装（含旧日期 runtime_facts）"
    );
}

// ============================================================================
// 场景 7（第 7 轮补强）：旧库（V20260806 未迁移）——静默跳过且不阻断发送
// ============================================================================

/// V20260806 列未迁移：repo 层 `no such column` 静默跳过并返回 Ok。
/// 双合同：其一，发送流程不因早写失败被阻断（时序照常推进到发 provider）；
/// 其二，崩溃后行为退回场景 1 的裸回退——旧库用户不受早写引入影响。
#[test]
fn unmigrated_db_early_persist_silently_skips_and_never_blocks_send() {
    let mut turn = FakeTurnTimeline::after_compile(BARE, WRAPPED);
    // 列缺失：早写等价 no-op，正常返回（Ok 语义）
    turn.early_persist_on_unmigrated_db();
    assert!(
        turn.row.llm_content.is_none(),
        "列不存在：sidecar 不写入，保持 NULL"
    );

    // 关键合同：发送照常发生（早写失败/跳过永不阻断发送）
    turn.send_to_provider();
    let live_sent = turn.sent_to_provider.clone().unwrap();
    assert_eq!(live_sent, WRAPPED, "旧库不影响 live 发送的完整包装字节");

    // 崩溃后退回旧行为：裸回退（与场景 1 一致，非回归）
    let row_after_crash = turn.crash_before_save_results();
    assert_eq!(
        replay_user_content(&row_after_crash),
        BARE,
        "旧库崩溃窗口行为与迁移前完全一致：裸文本回退"
    );
}

// ============================================================================
// 场景 8（第 7 轮补强）：legacy 多 CONTENT 块——写读同行 + 首块空串遮蔽角落
// ============================================================================

/// A1 前孤儿数据：同一 user 消息存在多个 CONTENT 块。写侧
/// `existing_user_content_block_id` 取 block_index ASC 首个 CONTENT 块，
/// 读侧 find_map 同序首个 Some——被写入的行正是被读中的行（r6 §2.6）。
#[test]
fn legacy_multi_content_blocks_write_and_read_hit_same_first_row() {
    // 早写命中首块；次块为孤儿，sidecar 恒 NULL
    let blocks = [
        FakeUserBlockRow {
            content: BARE.to_string(),
            llm_content: Some(WRAPPED.to_string()),
        },
        FakeUserBlockRow {
            content: "孤儿块残留".to_string(),
            llm_content: None,
        },
    ];
    assert_eq!(
        replay_user_content_from_blocks(BARE, &blocks),
        WRAPPED,
        "读侧 find_map 首个 Some 即写侧写入的首个 CONTENT 块——写读同行"
    );
}

/// 现状记录（第 7 轮补强，非背书）：history.rs 的 `.filter(!is_empty)`
/// 挂在 find_map **之后**——首块 Some("") 终结 find_map，整体被 filter
/// 判空后回退裸文本，即使后块持有非空包装。写侧从不写空串，此为
/// 理论角落；钉死现行算子顺序，若未来改为「逐块跳过空串」（语义变更），
/// 本测试应当红。
#[test]
fn legacy_multi_content_blocks_empty_first_sidecar_masks_later_wrapper() {
    let blocks = [
        FakeUserBlockRow {
            content: BARE.to_string(),
            llm_content: Some(String::new()),
        },
        FakeUserBlockRow {
            content: "孤儿块残留".to_string(),
            llm_content: Some(WRAPPED.to_string()),
        },
    ];
    assert_eq!(
        replay_user_content_from_blocks(BARE, &blocks),
        BARE,
        "首块空串遮蔽后块非空包装：整体判空 → 回退裸文本（现行算子顺序）"
    );
}

// ============================================================================
// 场景 9（第 7 轮补强）：多字节字节保真——sidecar 是字节权威，不得规范化
// ============================================================================

/// CJK / emoji / 拉丁重音 / 零宽空格：早写 → 崩溃 → 重放，
/// 逐字节（as_bytes）与 live 发送相等。任何 Unicode 规范化、
/// 转码或 trim 都会破坏「字节权威」合同（prompt cache 按字节比对前缀）。
#[test]
fn early_persist_preserves_multibyte_bytes_exactly() {
    let mut turn = FakeTurnTimeline::after_compile(BARE, WRAPPED_MULTIBYTE);
    turn.early_persist_user_llm_content();
    turn.send_to_provider();
    let live_sent = turn.sent_to_provider.clone().unwrap();
    let row_after_crash = turn.crash_before_save_results();

    let replayed = replay_user_content(&row_after_crash);
    assert_eq!(
        replayed.as_bytes(),
        live_sent.as_bytes(),
        "多字节内容逐字节相等——不得有任何规范化/转码/trim"
    );
    assert_eq!(
        replayed.len(),
        WRAPPED_MULTIBYTE.len(),
        "UTF-8 字节长度保真（零宽空格等不可见字符不得丢失）"
    );
}

// ============================================================================
// 场景 10（第 7 轮补强）：multi_variant 扇出无早写——已知缺口记录（非修复）
// ============================================================================

/// 已知覆盖缺口（r6-llm-content.md §3.2，记录在案）：变体扇出不经
/// `execute_internal` 阶段 4.6，无早写调用点——变体轮的崩溃窗口仍在，
/// 行为等同场景 1。本测试把缺口钉成红线基准：若后续轮为 multi_variant
/// 补上早写，应把本测试的漂移断言改为相等断言（届时本测试当红提醒）。
#[test]
fn multi_variant_fanout_without_early_persist_crash_window_remains() {
    // 变体轮时序：编译 → （无阶段 4.6 早写）→ 发 provider → 崩溃
    let mut variant_turn = FakeTurnTimeline::after_compile(BARE, WRAPPED);
    variant_turn.send_to_provider();
    let live_sent = variant_turn.sent_to_provider.clone().unwrap();
    let row_after_crash = variant_turn.crash_before_save_results();

    assert!(
        row_after_crash.llm_content.is_none(),
        "变体路径无早写：崩溃窗口内 sidecar 仍为 NULL（已知缺口）"
    );
    assert_ne!(
        replay_user_content(&row_after_crash),
        live_sent,
        "变体轮崩溃后重放与 live 字节漂移——缺口修复后本断言应改为相等"
    );
}
