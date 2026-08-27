//! llm_content sidecar retry 路径缺口记录测试（Wave2-A 第 7 轮 #6，2026-08）
//!
//! 姊妹篇：`llm_content_crash_tests.rs`（第 3 轮 #4）记录「已发 provider、
//! save_results 未跑」的崩溃窗口；本文件记录 **retry 路径**
//! （`chat_v2_retry_message`，handlers/send_message.rs）的 sidecar 缺口。
//!
//! ## retry 路径时序（现状，2026-08 读码结论）
//!
//! 1. 只允许对 assistant 消息 retry；handler 通过
//!    `find_preceding_user_message_with_attachments` 取**前一条用户消息**
//!    的裸 content 作为本轮 `user_content`；
//! 2. 删除目标 assistant 消息及其后所有消息；前置用户消息行保留，
//!    其 `llm_content` sidecar **既不失效也不改写**（对比：编辑重发的
//!    编辑事务会 `clear_block_llm_content_with_conn` 显式失效）；
//! 3. 以 `user_message_id: None` + `skip_user_message_save = Some(true)`
//!    重跑管线：`PipelineContext::new`（context.rs）生成全新 `msg_{uuid}`。
//!
//! ## 缺口（本文件逐条断言的现状 + 修复合同）
//!
//! 1. **retry 轮 live 包装无处落库**：sidecar 写全部按 `ctx.user_message_id`
//!    定位既有 content 块——阶段 4.6 `persist_user_llm_content_early` 与
//!    save 点 skip_user 分支的 `existing_user_content_block_id`
//!    （persistence.rs）查的都是全新 uuid，DB 无行 → 双双跳过。前移
//!    失败日志声称 "save_results will backfill"，但 retry 下 save_results
//!    同样查不到行，**没有兜底**。
//! 2. **陈旧 sidecar 漂移**：前置用户行保留原始轮的旧包装（旧
//!    `runtime_facts` 日期等）；retry 轮 live 编译发送的是新包装。
//!    下一轮 history 重放只能看到旧包装——retry 轮实际发送的新包装
//!    字节从此在历史中消失，重放视图与产出存活回答的那次 live 请求
//!    不一致（prompt cache 自分叉点起 miss）。
//! 3. **错失 NULL 回填**：若原始轮死在崩溃窗口内（sidecar 为 NULL，
//!    见 crash tests 场景 1），retry 明明重新编译并发送了完整包装，
//!    却不回填——下一轮仍回退裸文本，崩溃缺口被 retry 白白放过。
//! 4. **retry 轮自身双重包含**：`load_chat_history_pass`（history.rs）的
//!    排除集只含 `{ctx.user_message_id(全新), ctx.assistant_message_id}`，
//!    前置用户消息 id 不在其中 → 按 sidecar 旧包装（字节权威）重放进
//!    历史；同时 retry 未设 `is_continue` → tool_loop 又追加本轮编译的
//!    新包装 → 同一问题以两种包装在 live 请求中出现两次。
//!
//! ## 预期修复合同（对齐编辑重发路径语义）
//!
//! retry 应复用前置用户消息 id（或显式携带其 content 块 id 交给
//! `persist_replay_sidecar`）：
//! - history 排除集自然吃掉历史重复（缺口 4）；
//! - `existing_user_content_block_id` 命中 → 前移与 save 点把 retry 轮
//!   live 新包装写回该块（缺口 1/2/3），字节权威跟随最后一次 live 发送
//!   （与编辑重发覆写语义一致）；
//! - 下一轮重放字节 == retry 轮 live 发送字节；
//! - 边界不变量：空串 live 内容不得落库（对齐 context.rs
//!   `live_user_llm_content()` 的 `.filter(|c| !c.is_empty())`），空串
//!   sidecar 读侧视同缺失（对齐 history.rs 的同名 filter）。
//!
//! ## 实现说明
//!
//! 只写不跑（第 7 轮纪律：禁止编译/测试执行）。不触真实 DB/管线：
//! `FakeSessionState` 模拟前置用户行，`FakeRetryTurn` 模拟 retry 轮 ctx
//! 关键字段，`persist_sidecar_by_ctx_user_id` 复刻「按 ctx.user_message_id
//! 查行、查不到即跳过」的共同查找语义，`replay_user_content` 复刻
//! history.rs 的 llm_content override，`assemble_live_request` 复刻
//! 「历史（含排除集过滤）+ 追加当前编译消息」的组装顺序。
//! 多变体 retry 恢复路径（multi_variant.rs `build_variant_user_message`
//! 的 attachments 回退）不在本文件范围。
//!
//! 本模块由 `pipeline.rs` 的 `#[cfg(test)] mod llm_content_retry_gap_tests;`
//! 声明（mod 声明由父代理添加），仅在测试构建时编译。

// ============================================================================
// 假结构体：模拟前置用户行与 retry 轮 ctx，不触真实 repo/rusqlite
// ============================================================================

/// 前置用户消息（retry 所回答的那条）的 CONTENT 块在 DB 中的一行。
///
/// - `content`：原始轮 `save_user_message_immediately` INSERT 的裸用户输入；
/// - `llm_content`：V20260806 sidecar 列。原始轮正常走完 save_results 时
///   为原始轮 live 包装；原始轮死在崩溃窗口内时为 NULL。
#[derive(Debug, Clone)]
struct FakeUserBlockRow {
    content: String,
    llm_content: Option<String>,
}

/// retry 发起时刻的会话 DB 快照：只保留与 sidecar 缺口相关的最小状态——
/// 前置用户消息 id 及其 CONTENT 块行（assistant 消息及其后已被 retry
/// handler 删除，不建模）。
struct FakeSessionState {
    preceding_user_message_id: &'static str,
    preceding_row: FakeUserBlockRow,
}

/// retry 轮 PipelineContext 的关键字段切片。
///
/// - `ctx_user_message_id`：现状 = `PipelineContext::new` 生成的全新
///   `msg_{uuid}`（request.user_message_id 为 None）；修复合同 = 复用
///   前置用户消息 id；
/// - `ctx_assistant_message_id`：复用被删 assistant 消息 id（handler
///   语义修正：使用原消息 ID）；
/// - `live_user_llm_content`：`compile_frozen_context` 冻结后
///   `ctx.live_user_llm_content()` 的值——retry 轮实际发送的新包装
///   （新 runtime_facts 日期等）。
struct FakeRetryTurn {
    ctx_user_message_id: String,
    ctx_assistant_message_id: String,
    live_user_llm_content: String,
}

/// 复刻 `existing_user_content_block_id` + 写入的共同语义：sidecar 写
/// （前移 `persist_user_llm_content_early` 与 save 点 skip_user 分支的
/// `persist_replay_sidecar` user 块写共用）只按 `ctx.user_message_id`
/// 定位既有 content 块；查不到行即静默跳过。
///
/// 返回是否真的写入了（false = 现状 retry 路径每个保存点都走的跳过分支）。
fn persist_sidecar_by_ctx_user_id(
    session: &mut FakeSessionState,
    ctx_user_message_id: &str,
    live_wrapped: &str,
) -> bool {
    if session.preceding_user_message_id == ctx_user_message_id {
        session.preceding_row.llm_content = Some(live_wrapped.to_string());
        true
    } else {
        // DB 中不存在 ctx.user_message_id 对应的行（全新 uuid 且
        // skip_user_message_save=true 从未 INSERT）→ 跳过
        false
    }
}

/// 复刻 context.rs `live_user_llm_content()` 的空串过滤：编译内容为空时
/// 返回 None，调用方（前移/保存点）据此跳过写入，不得落空包装。
fn live_user_llm_content(compiled_content: &str) -> Option<String> {
    Some(compiled_content.to_string()).filter(|content| !content.is_empty())
}

/// 复刻 history.rs 用户消息重放的 llm_content override 语义：
/// sidecar 列有值且非空 → 字节权威（完整包装）；否则回退裸文本重建。
fn replay_user_content(row: &FakeUserBlockRow) -> String {
    row.llm_content
        .clone()
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| row.content.clone())
}

/// 复刻 retry 轮 live 请求中用户消息部分的组装顺序：
///
/// 1. `load_chat_history_pass` 按排除集
///    `{ctx.user_message_id, ctx.assistant_message_id}` 过滤后，前置用户
///    消息（若未被排除）以 replay 语义进入历史；
/// 2. `chat_v2_retry_message` 不设 `is_continue` → tool_loop 的
///    `is_continue != Some(true)` 分支追加当前编译的用户消息。
fn assemble_live_request(session: &FakeSessionState, turn: &FakeRetryTurn) -> Vec<String> {
    let mut user_messages = Vec::new();
    let excluded = session.preceding_user_message_id == turn.ctx_user_message_id
        || session.preceding_user_message_id == turn.ctx_assistant_message_id;
    if !excluded {
        user_messages.push(replay_user_content(&session.preceding_row));
    }
    user_messages.push(turn.live_user_llm_content.clone());
    user_messages
}

const BARE: &str = "帮我总结这份周报";
/// 原始轮 live 包装（原始轮 runtime_facts：2026-08-20）
const ORIGINAL_WRAPPED: &str = "<user_query>\n帮我总结这份周报\n</user_query>\n\n\
<injected_context>\n<runtime_facts>\n当前日期: 2026-08-20\n</runtime_facts>\n\
</injected_context>";
/// retry 轮 live 包装（retry 当天 runtime_facts：2026-08-26 → 字节必然不同）
const RETRY_WRAPPED: &str = "<user_query>\n帮我总结这份周报\n</user_query>\n\n\
<injected_context>\n<runtime_facts>\n当前日期: 2026-08-26\n</runtime_facts>\n\
</injected_context>";

const PRECEDING_USER_ID: &str = "msg_user_orig";
const RETRIED_ASSISTANT_ID: &str = "msg_assistant_retried";
/// `PipelineContext::new` 为 retry 轮生成的全新 id（request.user_message_id=None）
const FRESH_CTX_USER_ID: &str = "msg_fresh_uuid_from_pipeline_context_new";

/// 原始轮正常走完（sidecar = 原始轮包装）的会话快照。
fn session_after_normal_original_turn() -> FakeSessionState {
    FakeSessionState {
        preceding_user_message_id: PRECEDING_USER_ID,
        preceding_row: FakeUserBlockRow {
            content: BARE.to_string(),
            llm_content: Some(ORIGINAL_WRAPPED.to_string()),
        },
    }
}

/// 现状 retry 轮 ctx（全新 uuid + 复用 assistant id）。
fn current_behavior_retry_turn() -> FakeRetryTurn {
    FakeRetryTurn {
        ctx_user_message_id: FRESH_CTX_USER_ID.to_string(),
        ctx_assistant_message_id: RETRIED_ASSISTANT_ID.to_string(),
        live_user_llm_content: RETRY_WRAPPED.to_string(),
    }
}

// ============================================================================
// 缺口 1：retry 轮 live 包装无处落库（前移与 save 点双双跳过，无兜底）
// ============================================================================

/// 现状：ctx.user_message_id 是全新 uuid，DB 无行——前移
/// `persist_user_llm_content_early` 与 save 点 skip_user 分支的查找
/// 全部落空，retry 轮的 live 新包装在**任何保存点**都不落库；
/// 前置用户行的 sidecar 原样保留旧包装。
#[test]
fn retry_fresh_user_message_id_skips_early_and_save_point_sidecar_writes() {
    let mut session = session_after_normal_original_turn();
    let turn = current_behavior_retry_turn();

    // 阶段 4.6 前移：查全新 uuid → 无行 → 跳过
    let early_wrote = persist_sidecar_by_ctx_user_id(
        &mut session,
        &turn.ctx_user_message_id,
        &turn.live_user_llm_content,
    );
    assert!(
        !early_wrote,
        "现状：前移按全新 uuid 查不到既有 content 块，必须跳过"
    );

    // save_intermediate_results / save_results（skip_user 分支）：同一查找
    // 语义、同一全新 uuid → 前移日志承诺的 backfill 并不存在
    let save_point_wrote = persist_sidecar_by_ctx_user_id(
        &mut session,
        &turn.ctx_user_message_id,
        &turn.live_user_llm_content,
    );
    assert!(
        !save_point_wrote,
        "现状：save 点与前移共用按 ctx.user_message_id 的查找，同样跳过——无兜底"
    );

    // 前置用户行 sidecar 未被触碰：仍是原始轮旧包装
    assert_eq!(
        session.preceding_row.llm_content.as_deref(),
        Some(ORIGINAL_WRAPPED),
        "现状：retry 全程不改写前置用户行的 sidecar（也不失效，对比编辑事务）"
    );
}

// ============================================================================
// 缺口 2：陈旧 sidecar——下一轮重放与 retry 轮 live 发送字节漂移
// ============================================================================

/// 现状：retry 轮 live 发送新包装（新 runtime_facts 日期），但 sidecar
/// 仍是原始轮旧包装。retry 成功后的下一轮重放前置用户消息时只能拿到
/// 旧包装——与产出存活回答的 retry 轮 live 字节不相等（跨轮漂移）。
#[test]
fn retry_leaves_stale_sidecar_next_turn_drifts_from_retry_live_bytes() {
    let mut session = session_after_normal_original_turn();
    let turn = current_behavior_retry_turn();

    // retry 轮所有保存点都不写（缺口 1 已单测，此处走完整时序）
    persist_sidecar_by_ctx_user_id(
        &mut session,
        &turn.ctx_user_message_id,
        &turn.live_user_llm_content,
    );

    // 下一轮重放：sidecar 字节权威 = 原始轮旧包装
    let replayed = replay_user_content(&session.preceding_row);
    assert_eq!(
        replayed, ORIGINAL_WRAPPED,
        "现状：下一轮重放只能看到原始轮旧包装"
    );
    assert_ne!(
        replayed, turn.live_user_llm_content,
        "现状缺陷：重放字节 ≠ retry 轮 live 发送字节（跨轮漂移，cache 自分叉点 miss）"
    );
    // 漂移的具体形态：旧 runtime_facts 日期复活，retry 当天日期消失
    assert!(
        replayed.contains("2026-08-20") && !replayed.contains("2026-08-26"),
        "现状缺陷：retry 轮实际发送的新 runtime_facts 从历史中消失"
    );
}

// ============================================================================
// 缺口 3：原始轮崩溃留下的 NULL sidecar，retry 不回填
// ============================================================================

/// 现状：原始轮死在崩溃窗口内（crash tests 场景 1，sidecar NULL），
/// retry 重新编译并发送了完整包装——本是天然的回填机会——却因全新
/// uuid 查不到行而放过；下一轮仍回退裸文本，与 retry 轮 live 字节漂移。
#[test]
fn retry_after_crash_window_null_sidecar_misses_backfill() {
    let mut session = FakeSessionState {
        preceding_user_message_id: PRECEDING_USER_ID,
        preceding_row: FakeUserBlockRow {
            content: BARE.to_string(),
            // 原始轮崩溃在首个保存点之前：sidecar 从未写入
            llm_content: None,
        },
    };
    let turn = current_behavior_retry_turn();

    let wrote = persist_sidecar_by_ctx_user_id(
        &mut session,
        &turn.ctx_user_message_id,
        &turn.live_user_llm_content,
    );
    assert!(!wrote, "现状：retry 不回填 NULL sidecar（错失修复机会）");
    assert!(
        session.preceding_row.llm_content.is_none(),
        "现状：retry 结束后 sidecar 仍为 NULL"
    );

    // 下一轮重放：只能回退裸文本，与 retry 轮 live 包装漂移
    let replayed = replay_user_content(&session.preceding_row);
    assert_eq!(replayed, BARE, "NULL sidecar 下一轮回退裸 user_content");
    assert_ne!(
        replayed, turn.live_user_llm_content,
        "现状缺陷：崩溃缺口经 retry 后依然存在（重放 ≠ retry live 字节）"
    );
}

// ============================================================================
// 缺口 4：retry 轮自身双重包含（历史旧包装 + 追加新包装）
// ============================================================================

/// 现状：history 排除集只含 {全新 uuid, assistant id}，前置用户消息
/// 不被排除 → 以 sidecar 旧包装重放进历史；retry 未设 is_continue →
/// tool_loop 又追加本轮编译的新包装。live 请求中同一问题出现两次、
/// 两种包装（旧日期 + 新日期）。
#[test]
fn retry_live_request_double_includes_preceding_user_message() {
    let session = session_after_normal_original_turn();
    let turn = current_behavior_retry_turn();

    let user_messages = assemble_live_request(&session, &turn);

    assert_eq!(
        user_messages.len(),
        2,
        "现状缺陷：retry live 请求含两条用户消息（历史重放 + 追加编译）"
    );
    let bare_occurrences = user_messages
        .iter()
        .filter(|message| message.contains(BARE))
        .count();
    assert_eq!(bare_occurrences, 2, "同一问题正文在 live 请求中出现两次");
    assert_eq!(
        user_messages[0], ORIGINAL_WRAPPED,
        "第一份来自历史重放：sidecar 旧包装（字节权威）"
    );
    assert_eq!(
        user_messages[1], RETRY_WRAPPED,
        "第二份来自 tool_loop 追加：本轮编译的新包装"
    );
    assert_ne!(
        user_messages[0], user_messages[1],
        "两份包装字节不同（runtime_facts 日期不同）——下游 merge 连接后模型看到问题两遍"
    );
}

// ============================================================================
// 修复合同：复用前置用户消息 id，四个缺口同时闭合
// ============================================================================

/// 预期修复（对齐编辑重发语义）：retry 以前置用户消息 id 作为
/// ctx.user_message_id →
/// (a) 排除集吃掉历史重复（缺口 4）；
/// (b) 前移即命中既有行，retry live 新包装覆写陈旧 sidecar（缺口 1/2，
///     字节权威跟随最后一次 live 发送）；
/// (c) 下一轮重放字节 == retry 轮 live 发送字节。
#[test]
fn retry_reusing_preceding_user_id_closes_sidecar_gaps() {
    let mut session = session_after_normal_original_turn();
    let turn = FakeRetryTurn {
        // 修复：不再生成全新 uuid
        ctx_user_message_id: PRECEDING_USER_ID.to_string(),
        ctx_assistant_message_id: RETRIED_ASSISTANT_ID.to_string(),
        live_user_llm_content: RETRY_WRAPPED.to_string(),
    };

    // (a) 双重包含消失：历史侧被排除，live 请求只剩追加的新包装
    let user_messages = assemble_live_request(&session, &turn);
    assert_eq!(
        user_messages,
        vec![RETRY_WRAPPED.to_string()],
        "修复合同：前置用户消息被排除集吃掉，问题只以新包装出现一次"
    );

    // (b) 前移命中既有行，覆写陈旧 sidecar
    let wrote = persist_sidecar_by_ctx_user_id(
        &mut session,
        &turn.ctx_user_message_id,
        &turn.live_user_llm_content,
    );
    assert!(wrote, "修复合同：复用 id 后前移必须命中既有 content 块");
    assert_eq!(
        session.preceding_row.llm_content.as_deref(),
        Some(RETRY_WRAPPED),
        "修复合同：sidecar 覆写为 retry 轮 live 新包装（旧包装不得残留）"
    );

    // (c) 下一轮重放 == retry live 字节（漂移闭合；NULL 场景同理被回填）
    let replayed = replay_user_content(&session.preceding_row);
    assert_eq!(
        replayed, turn.live_user_llm_content,
        "修复合同：下一轮重放字节与 retry 轮 live 发送字节相等"
    );
}

/// 修复合同边界：崩溃遗留的 NULL sidecar 在复用 id 后被 retry 自然回填
/// （crash tests 场景 1 的缺口经 retry 修复，而非继续放过）。
#[test]
fn retry_reusing_preceding_user_id_backfills_null_sidecar() {
    let mut session = FakeSessionState {
        preceding_user_message_id: PRECEDING_USER_ID,
        preceding_row: FakeUserBlockRow {
            content: BARE.to_string(),
            llm_content: None,
        },
    };

    let wrote = persist_sidecar_by_ctx_user_id(&mut session, PRECEDING_USER_ID, RETRY_WRAPPED);
    assert!(wrote, "修复合同：NULL sidecar 必须被 retry live 包装回填");
    assert_eq!(
        replay_user_content(&session.preceding_row),
        RETRY_WRAPPED,
        "回填后下一轮重放使用完整包装而非裸文本"
    );
}

// ============================================================================
// 边界不变量：空串永不落库、空串读侧视同缺失（修复不得破坏既有 filter）
// ============================================================================

/// 写侧：`live_user_llm_content()` 对空编译内容返回 None → 前移/保存点
/// 跳过写入；读侧：空串 sidecar 视同缺失回退裸文本（对齐 history.rs
/// `.filter(|text| !text.is_empty())`）。修复实现必须保持这两个 filter。
#[test]
fn empty_live_content_never_persists_and_empty_sidecar_falls_back_bare() {
    // 写侧过滤：空编译内容不产生可写值
    assert_eq!(
        live_user_llm_content(""),
        None,
        "空串 live 内容不得进入 sidecar 写路径"
    );
    assert_eq!(
        live_user_llm_content(RETRY_WRAPPED).as_deref(),
        Some(RETRY_WRAPPED),
        "非空 live 内容原样通过"
    );

    // 读侧过滤：空串 sidecar 视同缺失
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
