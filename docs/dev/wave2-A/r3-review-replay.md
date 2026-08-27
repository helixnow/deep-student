# r3 #8 审查:重放正确性(#1 persistence 前移 / #3 history 门禁)

轮次:Wave2-A 第 3 轮 #8(只写本文档,不改产品代码、不跑测试、不 commit)。
审查对象为工作区未提交改动(基线 `f94f88d1`)。审查期间 #3 由并行代理落地
(`history.rs` +53/-6),故本审按「已落地实现」逐行审,而非仅 types 合同。

审查文件:`pipeline.rs`(阶段 4.6)、`persistence.rs`(`persist_user_llm_content_early`)、
`types.rs`(#2 digest 合同)、`history.rs`(`rebuild_anchored_skill_messages_gated` 与
三个消费点)。交叉参考:`tool_loop.rs`(锚点写入侧、首个 provider 请求)、
`context_compiler.rs`、`repo.rs`、`r3-llm-content-forward.md`、`r3-skill-digest-types.md`。

## 总结论

| 项 | 结论 |
|---|---|
| #1 前移时机(核心问题:是否真在首个网络请求前) | **确认**,证据链完整(见 §1.1);「首个网络请求」措辞需按 §1.2 收窄为「首个主对话 provider 请求」 |
| #1 实现(幂等、失败语义、边界路径) | **确认**,无翻案;两个既有怪癖记录在 §1.3(非回归) |
| #2 types 合同(digest 算法、序列化兼容) | **确认**,钉死向量独立验算通过(§2) |
| #3 门禁三个消费点 + 重建路径一致性 | **确认**,作用域与字节一致性均成立(§3) |
| #3 合同偏差:缺「需开新 prefix generation」信号 | **缺口 A**,需补(§4.1) |
| digest 写入侧缺失 → 门禁对一切真实数据空转 | **缺口 B**,需下一轮接线(§4.2) |
| 兼容入口潜在 dead_code 告警 | 小问题 C(§4.3) |

---

## 1. #1 persistence 前移逐行审

### 1.1 时机链:确认「编译后、首个 provider 请求前」

逐条核实了实现文档(`r3-llm-content-forward.md`)声称的四步时序,全部属实:

1. **用户块行已 INSERT**:`save_user_message_immediately` 在 `execute()` 中、
   `execute_internal` 之前调用(pipeline.rs:731-732 → 749-751),普通发送路径
   到达阶段 4.6 时行必然存在;编辑重发(`skip_user_message_save=true`)的行由
   handler 侧编辑事务保证(send_message.rs:1500 前的更新事务)。
2. **编译已完成**:阶段 4.5 `compile_frozen_context`(pipeline.rs:984-987)结束时
   `ctx.compiled_current_user_message` 必为 Some(context_compiler.rs:529-533,
   `messages.pop()` 带 `unwrap_or_else` 兜底),`live_user_llm_content()`
   (context.rs:1314-1319)从此返回 Some(空串被 filter 掉)。
3. **新调用点**:阶段 4.6(pipeline.rs:993),且是**全仓唯一调用点**
   (grep 确认 `persist_user_llm_content_early` 仅 persistence.rs 定义 +
   pipeline.rs:993 一处调用),满足任务卡「pipeline.rs 只加一处调用」。
4. **首个 provider 请求在其后**:阶段 4.6 与阶段 5 之间只有一个
   `cancel_token.is_cancelled()` 检查(pipeline.rs:1002-1004),无任何网络 I/O;
   主请求在 `execute_with_tools` → tool_loop.rs:1188
   `call_unified_model_2_stream` 才发起。tool_loop 首轮在该调用前只做
   技能状态加载(DB)、消息拼装、adapter 构建,无网络。

写路径本身也核实无误:`existing_user_content_block_id`(persistence.rs:201-210)
按 `block_type == CONTENT` 找块;`update_block_replay_with_conn`(repo.rs:1903-1935)
单条 UPDATE、SQLite 隐式单语句事务、V20260806 列未迁移时静默跳过——与既有
`persist_replay_sidecar`(persistence.rs:220-229)对 user 块的写法**完全同参**
(`llm_content: Some(...)` + 其余 `Default`),后续保存点幂等重写同值,最终态不变,
前移只收窄崩溃窗口。失败语义(Err → 调用方 warn 不阻断,pipeline.rs:993-999)
与「查不到块 → debug + 交给 save_results 兜底」均符合任务卡。

### 1.2 「首个网络请求」措辞需收窄(不构成翻案)

任务问「llm_content 前移是否真在首个网络请求前」——严格字面上**不是**,且
**不可能是**:

- 阶段 3 `execute_retrievals`(RAG/web search)可能有网络 I/O,早于 4.6;
- 阶段 4.5 编译自身可能触发辅助 MM/OCR 网络调用(pipeline.rs:981-983 注释明示);
- 阶段 2 之前的 compaction 摘要也可能调 LLM。

但这些请求**不消费也不产出本轮 user 的 llm_content**——OCR/编译产物正是
llm_content 的输入,逻辑上不存在更早的持久化点。任务口径的崩溃窗口是
「**主对话 provider 请求**已发、sidecar 未存」,对这个窗口,阶段 4.6 是满足
两个前置条件(行已 INSERT、编译完成)的最早可行位置。实现文档 §时机链的
「注」已作此澄清,**确认其口径正确**;建议后续文档统一用「首个主对话
provider 请求前」的说法,避免再被字面追问。

### 1.3 边界路径盘点(均确认,含两个既有怪癖)

| 路径 | 行为 | 判定 |
|---|---|---|
| 普通发送 | 行已在,写入新包装 | 确认 |
| 编辑重发(`skip_user_message_save`) | 编辑事务已 `clear_block_llm_content`,4.6 写回本轮新包装;比原来(等到中间/末尾保存)更早消除「编辑后裸文本回退」窗口 | 确认,是本改动的额外收益 |
| wake / retry 新 id 无行 | 查不到块 → skip;save_results 同样查不到 → 也不写。非回归 | 确认 |
| 即时保存失败 | 4.6 查不到块 → skip,save_results 兜底(其 INSERT OR REPLACE 会建行再写) | 确认 |
| **怪癖 1:is_continue 轮** | `compiled_current_user_message` 照常为 Some,但 tool_loop:740 该轮不把它发给 provider;4.6 会把「未发送的包装」写进 llm_content。**与 save_results 既有行为逐字节相同**(persist_replay_sidecar 同条件同值),非回归,但属于既有语义瑕疵,记录备查 | 记录,不翻案 |
| **怪癖 2:multi_variant 扇出** | `execute_multi_variant` 不走 `execute_internal`,阶段 4.6 对变体路径不生效;变体的 sidecar 仍在 multi_variant.rs 自己的保存点(:3654/:3728)落库,**崩溃窗口在多变体模式下依然存在** | 记录;任务卡 #1 独占表只给了 persistence.rs + pipeline.rs 一处调用,变体路径前移属后续轮次 |

`persist_user_llm_content_early` 为 async fn 内做同步 rusqlite 调用,与
`save_user_message_immediately` 等既有写法一致,不另立问题。

## 2. #2 types 合同(作为 #3 的依赖顺带核验)

- **钉死向量独立验算通过**:`printf 'manual-a\x1fbody text\x1e' | sha256sum` =
  `316f875d29c27e04369ccd63e8a575827d71bee69a44c074b322a472f82bd3dc`,与
  types.rs 测试及 `r3-skill-digest-types.md` 一致(本轮测试不跑,该值是唯一
  能提前证伪的硬事实,已证实)。
- `sha2 = "0.10.8"` 已在 Cargo.toml:55,未引新 crate;`0x1f`/`0x1e` 分隔骨架与
  `tool_schema_digest` / `DoomLoopGuard::fingerprint` 同族,拼接歧义有测试钉死。
- 序列化兼容:两字段均 `serde(default)` + 空值跳过,旧 JSON 可解析、无 digest 的
  新锚点序列化字节与 r3 前一致(双向兼容,测试覆盖)。
- `is_empty()` 不纳入 digest/rev:正确——digest 是锚点附属校验数据,无技能 id 时
  无意义;若纳入会改变 persistence.rs:1198 `.filter(|anchors| !anchors.is_empty())`
  的落库判定,反而引入行为漂移。
- 隐私红线:anchors 只存不可逆 hash,roundtrip 测试断言 JSON 不含正文。确认。

## 3. #3 history 门禁逐行审(已落地)

### 3.1 三个消费点全部过门禁,作用域一致

任务卡指出的三处(约 :158/:324/:353,落地后为 :159/:327/:358)均已改为
`rebuild_anchored_skill_messages_gated`:

- **turn 级(:159)**:传 `Some(anchors)`,anchors 即当前 assistant 消息
  `meta.skill_injection_anchors`(history.rs:146-153,逐消息克隆)。
- **tool 级匹配路径(:327)与兜底追加路径(:358)**:传 `skill_anchors.as_ref()`。
  核实作用域:`pending_tool_anchored` 在同一 `for message in messages_to_load`
  迭代内从**同一条消息**的 `anchors.tool_anchored` 派生(history.rs:289-293),
  兜底 drain 也在同一消息作用域内——digest 与锚点严格同源同轮,不存在
  「用 A 轮 digest 校验 B 轮锚点」的错配。

turn 级与 tool 级共用同一 `skill_content_digests` map(按 skill_id 键)正确:
同一轮内两级注入的正文取自同一 `replay_skill_contents`/`skill_contents`,
不可能同 id 异体。跨轮同 id 异体(技能在第 N 轮后被编辑)也正确处理:
每条 assistant 消息各带自己锚定时刻的 digest,旧轮 skip、新轮重建,互不污染。

### 3.2 门禁函数语义(history.rs:844-873)

逐分支核对,与 #2 合同的「给 #3 的接线要点」一致:

- 正文缺失 → warn + `continue`(旧行为原样保留,warn 文案未变);
- 有 digest 且不一致 → warn(含 anchored/current 两个 hex,不含正文,无 PII)+
  skip,**绝不用新正文伪装旧历史**——负例测试
  `gate_skips_mismatch_and_rebuilds_match_in_anchor_order` 钉死;
- 无 digest(旧锚点 / `anchors=None`)→ 有正文就重建(向后兼容),
  `legacy_anchor_without_digest_keeps_old_rebuild_behavior` 钉死;
- skip 不阻塞、不换序;命中走 live 同一渲染函数 `make_transient_skill_message`,
  重建字节与 live 恒等(与 `skill_replay_digest_tests.rs` 的契约副本对齐表吻合)。

二参兼容入口 `rebuild_anchored_skill_messages` 委托 gated 版传 `None`,保住了
helpers.rs 与 #5 测试文件的既有断言(含 #5 里「无门禁生产函数按 id 盲取会返回
v2 字节」的反例记录——该反例注释已声明门禁落地后应改为对门禁版断言 skip,
属 #5 文件的后续跟进,不算 #3 的债)。

与 history 重建主路径的一致性也核过:门禁只影响瞬态技能消息的重建;user 块
`llm_content` 覆写(history.rs:246-258,空串过滤)、工具块 `tool_call_id`/
`round_text` 回放均不经过该函数,#1 与 #3 互不干扰。`insert_at` 与
`last_user_message_index` 的右移逻辑未被触碰。

### 3.3 红线核查

不碰 coordinator/hooks/ApprovalGateHook:确认(diff 仅 history.rs)。
技能正文不落库:确认(digest 只读,gated 函数无任何写库)。
过滤器负例测试未删:确认(#5 文件为新增,helpers 既有测试未动)。

## 4. 缺口与补丁建议

### 4.1 缺口 A(合同偏差):digest 冲突未返回「需开新 prefix generation」信号

API 合同(ROUND-03-TASKS.md)明文:「不一致 → warn + 跳过该技能消息,**并返回
『需开新 prefix generation』信号(bool 或 enum)**」。任务卡 #3 补充允许两种
落法:热路径直接调 `converge`/`advance`,或「返回信号让调用方记录」。

当前实现**两者都没做**:`rebuild_anchored_skill_messages_gated` 仍只返回
`Vec<LegacyChatMessage>`,冲突只留下一条 warn。后果:技能消息从历史前缀里
消失(前缀漂移),但 r2 落的 `toolFacePrefixGeneration` 代际层对此不知情——
prompt cache 前缀已实质失效却不切代,与第 2 轮「前缀变更必须显式换代」的
纪律矛盾。

**补丁建议**(改动面小,三个调用点都在 history.rs 内):

```rust
pub(super) struct GatedRebuild {
    pub messages: Vec<LegacyChatMessage>,
    /// 任一锚点 digest 不一致(不含「正文缺失」旧档)时为 true,
    /// 调用方应记录并触发 prefix generation 切代
    pub digest_conflict: bool,
}
```

gated 版返回 `GatedRebuild`;二参兼容入口继续只返回 `Vec`(丢弃信号,测试不动)。
`load_chat_history` 把三处的 `digest_conflict` OR 起来,先落到
`ctx`(如 `ctx.skill_digest_conflict = true`)并 `log::warn!` 一条会话级汇总;
是否在同轮调 `converge_session_tool_face_prefix` 切代交由下一轮评估——按任务卡
「不要为了切代大改 tool_loop」,本轮先把信号打通到 ctx 即可。

### 4.2 缺口 B(门禁空转):digest 无生产者

全仓 grep 确认 `skill_content_digests` 只有 types 定义、history 消费、测试构造
三类出现;**live 写入侧两处锚点构造均未填**:

- turn 级:tool_loop.rs:708-714(只填 `turn_skill_ids` / `before_turn_user`);
- tool 级:tool_loop.rs:1954-1963(只 push `ToolAnchoredSkills`)。

即:r3 之后新产生的锚点依旧无 digest,门禁对**所有真实数据**(旧的和新的)都
走「无 digest → 旧行为」分支,只有测试构造的锚点能触发。这与 #2 文档
「写入侧本轮不属于 #2 范围」的自我declared范围一致,且 tool_loop 本轮无人独占
(红线:不为切代大改 tool_loop),**不算落地事故,但必须进下一轮任务卡**,
否则 #3 是死代码。建议补丁(两处各 3-5 行,注入正文此刻就在手边):

```rust
// tool_loop.rs:714 后(turn 级,skill_contents 即渲染用的同一 map):
for id in &anchors.turn_skill_ids.clone() {
    if let Some(body) = skill_contents.get(id) {
        anchors.skill_content_digests
            .insert(id.clone(), skill_body_digest(id, body));
    }
}
// tool_loop.rs:1963 后(tool 级)同理,对 batch.audit.injected_skill_ids 循环。
```

`skill_content_rev` 本轮无人赋值,保持 `None` 即可(合同允许可选)。

### 4.3 小问题 C:兼容入口潜在 dead_code 告警

`rebuild_anchored_skill_messages`(二参版)现仅被 `#[cfg(test)]` 代码引用
(helpers.rs 测试模块、history.rs `skill_replay_gate_tests`、待挂载的 #5 文件)。
非 test 构建下 `pub(super)` 未使用函数会触发 dead_code 告警。本轮不跑编译无法
证实,建议父代理挂 mod 时顺手加 `#[cfg_attr(not(test), allow(dead_code))]`
或直接 `#[cfg(test)]`(若确认无生产调用)。

### 4.4 备查(不要求本轮动作)

- multi_variant 扇出路径无 #1 前移(§1.3 怪癖 2),变体崩溃窗口留待后续;
- is_continue 轮 llm_content 写入「未发送的包装」是既有语义(§1.3 怪癖 1);
- #4/#5 测试文件尚未在 pipeline.rs 挂 `mod`(任务卡明确由父代理加),
  挂载前 `llm_content_crash_tests.rs` / `skill_replay_digest_tests.rs` 不参与编译。

## 5. 结论

#1 **确认通过**:前移点是满足「行已 INSERT + 编译完成」的最早位置,严格早于
本轮首个主对话 provider 请求(tool_loop.rs:1188),写入与既有保存点同参幂等,
失败不阻断。#2 **确认通过**:算法、兼容性、隐私、钉死向量全部核实。
#3 **实现正确但合同未收全**:门禁语义、三消费点、作用域、字节一致性均确认;
缺「切代信号」(缺口 A)与 digest 生产者(缺口 B),两者不补则门禁在生产数据上
恒空转——建议列入第 4 轮任务卡,补丁草案见 §4.1/§4.2。无需翻案项。
