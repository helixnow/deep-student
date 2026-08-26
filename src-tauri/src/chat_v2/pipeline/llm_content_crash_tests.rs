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

    /// 事件 3：首个网络请求——provider 看到的就是完整包装字节。
    fn send_to_provider(&mut self) {
        self.sent_to_provider = Some(self.live_user_llm_content.clone());
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
}

/// 复刻 history.rs 用户消息重放的 llm_content override 语义：
/// sidecar 列有值且非空 → 字节权威（完整包装）；否则回退裸文本重建。
fn replay_user_content(row: &FakeUserBlockRow) -> String {
    row.llm_content
        .clone()
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| row.content.clone())
}

const BARE: &str = "帮我总结这份周报";
const WRAPPED: &str = "<user_query>\n帮我总结这份周报\n</user_query>\n\n\
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
