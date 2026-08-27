# r3 #9 评审：分支复制三列 SQL 与技能锚点 digest 的配合（repo.rs `copy_block_replay_with_conn`）

轮次：Wave2-A 第 3 轮 #9（评审岗）。只写本文档，不改产品代码，不跑测试。
评审对象：`src-tauri/src/chat_v2/repo.rs::copy_block_replay_with_conn`（repo.rs:1983-2003）
与 r3 #2 新增的技能锚点 digest 字段（`SkillInjectionAnchors.skill_content_digests` /
`skill_content_rev`，types.rs:1163-1168，合同见 `r3-skill-digest-types.md`）的交互。

## 结论：确认，不翻案

**digest 随消息 `meta_json` 整体 clone 免费继承，`copy_block_replay_with_conn` 的三列
SQL 不需要、也不应该为 digest 扩展。** 两者处在不同的存储层级，互不重叠：

| | 存储位置 | 分支复制的携带方式 |
|---|---|---|
| 重放三列（llm_content / tool_call_id / round_text） | `chat_v2_blocks` 三个**物理列**（V20260806 迁移新增） | `MessageBlock` 结构体不携带 → 结构体深拷贝静默丢列 → 必须 `copy_block_replay_with_conn` SQL 级补拷 |
| 技能锚点 digest（skillContentDigests / skillContentRev） | `chat_v2_messages.meta_json` 整列 JSON 内部（`MessageMeta.skill_injection_anchors`，types.rs:1858） | `MessageMeta` 是**类型化字段**，`msg.meta.clone()` 完整携带 → `create_message_with_conn` 整体序列化落新行，零额外代码 |

三列 SQL 存在的唯一理由是「结构体不携带、深拷贝会丢」（repo.rs:1981-1982 及
manage_session.rs:1642-1644 的注释都写明了这一点）。digest 不满足这个前提——它就在
结构体里，clone 不丢，因此没有资格进这条 SQL。

## 证据链

### 1. digest 是消息级数据，不是块级数据

r3 #2 把两个新字段加在 `SkillInjectionAnchors`（types.rs:1163-1168），该结构体唯一的
持久化挂点是 `MessageMeta.skill_injection_anchors`（types.rs:1855-1858），由
save_results 写入助手消息（persistence.rs:1194-1198，源头是 `ChatV2Options`
的 `#[serde(skip)]` 运行时字段，types.rs:2714-2718）。`chat_v2_blocks` 表及
`MessageBlock` 结构体与 digest 无任何交集。

### 2. 分支复制对消息 meta 是整体 clone

`branch_session`（manage_session.rs）消息复制处：

```1578:1594:src-tauri/src/chat_v2/handlers/manage_session.rs
        let new_message = crate::chat_v2::types::ChatMessage {
            id: new_msg_id,
            session_id: new_session_id.clone(),
            role: msg.role.clone(),
            block_ids: new_block_ids,
            timestamp: msg.timestamp,
            persistent_stable_id: msg.persistent_stable_id.clone(),
            parent_id: new_parent_id,
            supersedes: new_supersedes,
            meta: msg.meta.clone(),
            attachments: msg.attachments.clone(),
            active_variant_id: new_active_variant_id,
            variants: new_variants,
            shared_context: new_shared_context,
        };

        ChatV2Repo::create_message_with_conn(&tx, &new_message)?;
```

`meta: msg.meta.clone()` 是 typed struct 的完整克隆，`skill_injection_anchors` 连同
digest map / rev 一并进入新消息行。ID 重映射（`remap_ids_in_value`）只作用于块的
`tool_input` / `tool_output`（manage_session.rs:1614-1623），不触 meta——正确：锚点
内部没有任何 `msg_` / `blk_` 内部 id 需要重映射（见下文第 4 点）。

写入侧唯一的清洗是 `without_skill_runtime_contents()`（repo.rs:1226），它只清
`skill_runtime_before/after.skill_contents` 正文（types.rs:1876-1885），**不碰**
`skill_injection_anchors`——digest 本来就是「正文不落库」纪律下的替代品，清洗函数
与它的隐私目标一致而非冲突。

读回侧（repo.rs:1588-1595）`meta_json` 反序列化为 typed `MessageMeta`；digest 两字段
带 `#[serde(default)]` + `skip_serializing_if`（r3 #2 合同），读→clone→写 roundtrip
无损，旧 JSON（无新键）也照常 parse 为空 map / None。

compaction summary 的克隆路径（manage_session.rs:1675-1681，`new_summary = source_summary`
整结构体接管后仅改 id/session_id/block_ids/parent/supersedes）同理，meta 原样继承。

### 3. 三列 SQL 审读：范围恰好、不多不少

```1988:1997:src-tauri/src/chat_v2/repo.rs
        let result = conn.execute(
            r#"
            UPDATE chat_v2_blocks
            SET llm_content = (SELECT s.llm_content FROM chat_v2_blocks s WHERE s.id = ?1),
                tool_call_id = (SELECT s.tool_call_id FROM chat_v2_blocks s WHERE s.id = ?1),
                round_text = (SELECT s.round_text FROM chat_v2_blocks s WHERE s.id = ?1)
            WHERE id = ?2
            "#,
            params![source_block_id, target_block_id],
        );
```

- 三个关联子查询对源块逐列取值，源块不存在时三列置 NULL（等价于「源本来就没有旁路
  数据」，语义无害）；列不存在（未迁移旧库）经 `is_missing_replay_column_error` 降级
  no-op（repo.rs:2000）。
- 调用点两处（manage_session.rs:1645 主消息块、:1685 compaction summary 块），都紧跟
  `create_block_with_conn` 之后、同一事务内。
- 测试覆盖（只写不跑轮次的既有资产）：repo.rs:5710-5728 钉死「结构体深拷贝丢三列 →
  SQL 补拷后与源一致」，repo.rs:5899-5903 钉死无列 no-op。
- **不应加第四列**：digest 若下沉为块级物理列，既违反「锚点是消息级轮语义」的建模
  （一轮的技能注入锚点属于助手消息，不属于任何单块），又白白引入第四列的迁移 +
  丢列 + 补拷三件套。r1 文档（r1-prompt-chain-anchor.md:190）警告过「若未来把重放
  数据搬进块结构体之外的新列就必须扩这条 SQL」——digest 走了 meta JSON 路线，正是
  避开该警告的正确选择。

### 4. 关键交叉点：锚点与三列在分支后仍互相咬合

digest 校验链在重放侧要走两步定位：`ToolAnchoredSkills.tool_call_id`（provider 级
调用 id）找锚定位置 → `skill_content_digests[skill_id]` 校验正文。分支复制后这条链
不断，恰恰因为**两端都是逐字复制**：

- meta 侧：锚点里的 `tool_call_id` / `skill_id` 随 `msg.meta.clone()` 原样继承；
- 块侧：三列 SQL 把 `tool_call_id` 列逐字复制（repo.rs:1992），且
  `remap_ids_in_value` 只重映射内部 `msg_` / `blk_` id、不碰 provider tool_call_id。

若有人「顺手」把分支复制改成对 tool_call_id 也做重映射，锚点定位链就会断——这是
本评审确认的一条不变量：**provider tool_call_id 在分支复制全链路（meta 锚点、块
tool_input/tool_output 之外的三列）必须逐字保持**。现状满足。

### 5. 免费继承不依赖 V20260806 迁移

在未应用三列迁移的旧库上分支：三列补拷 no-op（丢的是本来就不存在的数据），而
`meta_json` 列始终存在，锚点 + digest 照常继承。两条通道的降级路径互不牵连。

## 记录在案的非阻塞事项（不构成翻案）

1. **digest 目前无生产写入方**。全仓搜索 `skill_content_digests` 只命中 types.rs 定义
   与测试；persistence.rs 持久化的是 tool_loop 未来写进 `ctx.options` 的锚点。这不
   影响本评审结论——分支路径 clone 的是整个 struct，写入方（tool_loop 冻结时调
   `skill_body_digest` 填 map）落地当天，分支继承零改动即生效。
2. **旧 build 写回会丢新键**（typed roundtrip 丢未知 JSON 键）：r3 之前的客户端打开
   新库会话并触发任何 meta 重写（含分支）时，digest 字段会被剥掉。这不是分支复制
   特有的问题，且降级语义就是合同规定的「旧锚点 / 无 digest / 保持 warn 行为」，
   故障安全，无需处置。
3. 会话级 metadata 里另有一个同名概念 `toolSchemaDigest`（tools schema 冻结摘要，
   repo.rs:100），分支路径同样靠整体 clone 源会话 metadata 继承
   （manage_session.rs:1420-1427），也不经过任何逐键 SQL。两个 digest 都验证了同一
   条设计纪律：**JSON 容器整体继承，物理列才需要逐列 SQL**。
