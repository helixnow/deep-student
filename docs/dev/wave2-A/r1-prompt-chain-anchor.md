# Wave2-A 第 1 轮 #8：prompt 链锚定（metadata 单键更新 / P2 / P4 / 第 2 轮键位建议）

- 基线：`cursor/0824-wave2-agent-cache-a875` @ `061b4815`（Step 23 tip + 开枝提交）。
- 范围：只读锚定，不改产品代码。行号均按本枝 tip 实测。
- 必读文件全部读毕：`prompt_builder.rs`（1353 行全量）、`context.rs`（1741 行全量）、
  `repo.rs`（grep + 关键段精读）、`types.rs:1040-1130`、`pipeline/history.rs:120-360, 806-824`、
  `TauriAdapter.ts:3713-3720, 5260-5341`（只读记录）、`progressiveDisclosure.ts:600-697`（只读记录）。

---

## 1. session.metadata 单键更新链（谁写、哪把键、是否 bump updated_at、调用方）

`chat_v2_sessions.metadata_json` 是一个多主键共存的 JSON 对象。所有写路径最终收敛到
`ChatV2Repo::update_session_with_conn`（`repo.rs:402-445`，整行 UPDATE，含 `updated_at = ?7`）；
"是否 bump updated_at" 完全取决于调用方在写前是否执行 `session.updated_at = Utc::now()`。

### 1.1 缓存类单键（读-合并-写，**故意不推 updated_at**）

| 键名 | 常量（types.rs） | 读函数 | 写函数 | 写语义 | bump updated_at | 生产调用方 |
|---|---|---|---|---|---|---|
| `frozenToolSchemaOrder` | `FROZEN_TOOL_SCHEMA_ORDER_METADATA_KEY`（:459） | `get_session_frozen_tool_schema_order[_with_conn]`（repo.rs:2658/2667，解析器 :32） | `merge_session_frozen_tool_schema_order[_with_conn]`（repo.rs:2686/2699） | IMMEDIATE 事务，append-only 合并，无新增跳过写库（:2712-2716） | **否**（:2731-2732 显式注释） | `helpers.rs:1026`（load）、`helpers.rs:1073`（store，经 `store_session_frozen_tool_schema_order` :1058） |
| `availableSkillsSnapshot` | `AVAILABLE_SKILLS_SNAPSHOT_METADATA_KEY`（:470） | `get_session_available_skills_snapshot[_with_conn]`（repo.rs:2742/2751，解析器 :50） | `freeze_session_available_skills_snapshot[_with_conn]`（repo.rs:2772/2786） | IMMEDIATE 事务，**first-write-wins**：已存在（含空串）绝不覆盖，返回持久化权威值（:2793-2796） | **否**（:2811） | 后端命令 `chat_v2_freeze_available_skills_snapshot`（manage_session.rs:386-407，:405 调 repo）；前端 `TauriAdapter.persistAvailableSkillsSnapshot`（TauriAdapter.ts:5323） |
| `microcompactAnchor` | `MICROCOMPACT_ANCHOR_METADATA_KEY`（:481） | `get_session_microcompact_anchor[_with_conn]`（repo.rs:2823/2832，解析器 :61） | `set_session_microcompact_anchor[_with_conn]`（repo.rs:2847/2860） | IMMEDIATE 事务，读-比-写，值相同跳过写库（:2867-2869） | **否**（:2884） | `helpers.rs:962`（恢复）、`helpers.rs:997`（`resolve_microcompact_eligible_turns` 内锚点变化时持久化） |

三个写函数共享同一 upsert 骨架：`get_session_with_conn` → 解析既有键 → 判断有无实际变化
（无变化早退）→ `metadata.as_object_mut().insert(唯一一个键)` → `update_session_with_conn`。
其他键（authority/plan/branchedFrom/workspace_id/…）原样保留，绝不覆盖——repo 测试
`frozen_tool_schema_order_merge_preserves_other_session_metadata`（repo.rs:4382）、
`available_skills_snapshot_freeze_preserves_other_session_metadata`（:4549）、
`microcompact_anchor_lineage_none_roundtrips_and_preserves_metadata`（:4652）逐一守住共存性。

### 1.2 对照组：会 bump updated_at 的 metadata 写路径（用户可见状态）

| 写函数（repo.rs） | 键 | bump |
|---|---|---|
| `set_session_authority_mode`（:2574，bump 在 :2587） | `authorityMode`（+snake 兼容键，types.rs:695-712 `apply_to_metadata`） | 是 |
| `set_session_permission_preset`（:2592，:2602） | `permissionPreset` | 是 |
| `set_session_plan_state`（:2608，:2618） | `plan` | 是 |
| `consume_session_plan_binding`（:2625，:2647，IMMEDIATE 事务） | `plan` 清除 | 是 |
| 归档/恢复路径（:745-873） | `manuallyArchivedBy` / `groupArchivedBy` | 是（直接 SQL 带 `updated_at = ?2`） |

### 1.3 metadata 现有键全景（本轮盘点）

`frozenToolSchemaOrder`、`availableSkillsSnapshot`、`microcompactAnchor`（三个缓存键，不推 updated_at）；
`authorityMode` / `authority_mode` / `permissionPreset` / `plan`（authority 组，推）；
`branchedFrom`（分支出生记录，manage_session.rs:1428-1438，随 create_session 一次性写入）;
`workspace_id`（会话过滤，repo.rs:1129 json_extract）；`manuallyArchivedBy` / `groupArchivedBy`（归档组）；
`chatV2Draft.hidden`（可见性过滤，repo.rs:138）。

---

## 2. 纪律：缓存键不推 updated_at；第 2 轮必须沿用

**纪律一句话**：凡属"prompt 前缀内部缓存状态"的 metadata 键（frozenToolSchemaOrder /
availableSkillsSnapshot / microcompactAnchor），写库时**故意不执行 `session.updated_at = Utc::now()`**，
因为它们在发送热路径高频写入、不代表用户可见的会话更新，推 updated_at 会扰动会话列表排序
（列表按 `ORDER BY updated_at DESC`，repo.rs:529/1130/1140/4034）。

三处显式注释即纪律锚点：repo.rs:2731-2732、:2811、:2884。

**第 2 轮的 prefix generation 键必须沿用此纪律**：generation 推进发生在 fan-out 分叉 /
compaction / 技能正文变更等发送热路径事件上，与三个既有缓存键同性质；若它推 updated_at，
每次代际切换都会把会话顶到列表首位，属用户不可见的排序抖动回归。

---

## 3. P2：技能正文不冻结——旧锚点被"当前正文"重写的精确路径

### 3.1 机制现状

- 落库侧（故意只存 id、不存正文）：
  - `SkillInjectionAnchors`（types.rs:1095-1122）只记录 `turn_skill_ids` / `before_turn_user` /
    `tool_anchored[{tool_call_id, skill_ids}]`（ToolAnchoredSkills，types.rs:1124-1130）。
  - `ReplaySkillPayloadSnapshot::without_skill_contents`（types.rs:1080-1083）在持久化前
    清空 `skill_contents`（隐私约束：技能正文是瞬态请求数据，不进消息 metadata）。
    调用点：types.rs:1354/1357/1794/1797、persistence.rs:15、multi_variant.rs:30；
    负例测试 `test_build_replay_skill_payload_snapshot_does_not_persist_skill_contents`
    （persistence.rs:105）。
- 重放侧（正文取当前请求）：
  - `rebuild_anchored_skill_messages`（history.rs:809-824）：按锚点 id 从
    `ctx.options.replay_skill_contents.or(ctx.options.skill_contents)` 取正文，调
    `make_transient_skill_message` 重建消息；**正文缺失时 warn + 跳过**（:817-820，
    注释明言"该技能位置的前缀会漂移，但不阻塞重放"）。
  - 三个消费点全部用当前请求正文：turn 锚点 history.rs:158-164；tool 锚点 :324-330；
    tool_call_id 未匹配兜底 :353-359。环内 live 路径同源：tool_loop.rs:584-590/1799-1805、
    multi_variant.rs:857-866/1353-1360/1703-1710。

### 3.2 被重写的精确路径（P2 缺口）

用户在第 N+1 轮前编辑了技能 SKILL 正文（或技能商店更新）→ 前端按 live registry 组装
`options.skill_contents`（新正文）→ 后端 `load_chat_history` 重放第 1..N 轮历史时，
history.rs:158 / :324 / :353 用**新正文**重建第 k 轮（k ≤ N）的瞬态技能消息 →
`[history][skills][userN]` 序列中位于历史**中部**的技能消息字节与 live 当时发出的不一致 →
从该消息起整段后缀 prompt cache 失效，且**无任何告警**（只有"正文缺失"才 warn，
"正文变了"完全静默）。技能被删除则走 :817 warn 分支：消息整体消失，前缀同样漂移。

根因：锚点只冻结了"哪些技能、锚在哪"，没有冻结"正文是哪个版本"——既不存正文
（隐私约束合理），也不存正文摘要（digest），因此无法检测漂移、更无法选择性换代。

---

## 4. P4：availableSkillsSnapshot 首发非原子 + 永久陈旧的精确路径

### 4.1 首发非原子（write-behind 竞态）

精确路径（本轮不改 TS，只锚定）：

1. 发送入口 `TauriAdapter.ts:5047`：`systemPromptOverride: this.buildSystemPromptWithSkills(...)`。
2. `buildSystemPromptWithSkills`（TauriAdapter.ts:5288-5314）：
   `hasSessionAvailableSkillsSnapshot`（progressiveDisclosure.ts:673-675）为 false 时，
   `getSessionAvailableSkillsPrompt`（:659-667）**当场按 live registry 生成目录并写进程内 Map**，
   然后 `persistAvailableSkillsSnapshot`（TauriAdapter.ts:5323-5341）以
   **`void invoke(...)` fire-and-forget** 异步冻结到后端。
3. 发送不等待冻结完成——**首条消息的 system 字节先于持久化生效**。窗口期内：
   - 应用崩溃/冻结失败：已发出的 system 字节从未落库，下次启动
     `loadSession`（TauriAdapter.ts:3717-3720）读不到键 → 按当时 live registry 重算 →
     若期间装/删过技能，system 从目录处变字节，历史缓存全断。
   - 双窗口竞争：两窗口都 `hadSnapshot=false`、各按自己的 live registry 生成（可能不同字节）
     并**各自已发送**；后端 first-write-wins（repo.rs:2793-2796）裁决出唯一权威，
     败方靠 :5330-5331 `hydrateSessionAvailableSkillsSnapshot` 回灌——但它那条已发出的
     消息字节已成事实，该窗口第 2 轮起 system 变字节、缓存断一次。

### 4.2 永久陈旧（by-design，但缺换代出口）

first-write-wins + 无失效机制 = 目录**终身冻结**：
- 会话中途 `skill_install` 的新技能永不进目录（设计意图：靠 load_skills tool result 表达）；
- 但技能**卸载**后目录仍列它（LLM 可能去加载已不存在的技能）；
- 即使发生了本来就会打碎缓存的事件（compaction 换代、编辑重发、模型切换），
  也没有任何路径允许"顺势"刷新目录——陈旧是永久的，没有代际出口。
  progressiveDisclosure.ts:630-646 的注释只论证了"冻结"的必要性，未提供换代机制。

---

## 5. 第 2 轮：prefix generation 持久化键的建议名与落点

### 5.1 建议键名（沿用 camelCase metadata 键风格）

| 建议键 | 形态 | 语义 |
|---|---|---|
| `prefixGeneration` | `{"generation": u64, "reason": string, "advancedAt": rfc3339}` | 会话级 prompt 前缀代际。generation 不变 ⇒ 三个缓存键 + 技能正文 + 目录快照全部按冻结值重放；generation 推进 ⇒ 允许整体重算（fan-out 分叉 / compaction / 技能正文变更择机换代，与 #7 的方案 A「fan-out 统一代际」对齐） |
| `skillContentDigest` | `{"<skill_id>": "sha256hex", ...}` | 每技能正文摘要（不存正文，兼容 without_skill_contents 隐私约束）。重放前比对当前请求正文 digest：一致 → 静默重放；不一致 → 记 telemetry 并（按策略）触发 generation 推进，而非今天的静默字节漂移 |

digest 算法建议直接复用 `DoomLoopGuard::fingerprint` 同款 sha256 骨架（context.rs:174-185）。

### 5.2 落点函数（与现有三键完全同构，五件套）

1. **键常量**：types.rs :459-481 三常量旁新增
   `PREFIX_GENERATION_METADATA_KEY = "prefixGeneration"`、
   `SKILL_CONTENT_DIGEST_METADATA_KEY = "skillContentDigest"`，带同风格文档注释。
2. **解析器**：repo.rs :32/:50/:61 三个 `*_from_metadata` 旁新增
   `prefix_generation_from_metadata` / `skill_content_digest_from_metadata`
   （缺键/类型不符容错降级，等同 generation=0 / 无 digest 的冷启动语义）。
3. **读写对**：repo.rs :2816-2886（microcompactAnchor 是最贴切的模板：IMMEDIATE 事务、
   读-比-写、值同跳过、单键 upsert、**不推 updated_at**）之后新增
   `get_session_prefix_generation[_with_conn]` / `advance_session_prefix_generation[_with_conn]`
   与 `get_session_skill_content_digest[_with_conn]` / `merge_session_skill_content_digest[_with_conn]`
   （digest 用 merge 语义：只 upsert 出现过的 skill_id，参照 frozenToolSchemaOrder 的合并哲学）。
4. **pipeline 内存缓存 + 恢复**：helpers.rs :946-1007（microcompact 锚点的
   "内存 miss → 读库回灌 → 变化时写回、失败降级打日志"三段式）为模板挂
   `resolve_prefix_generation`；digest 比对挂在 history.rs :158/:324/:353 调
   `rebuild_anchored_skill_messages` 之前。
5. **共存性测试**：repo.rs :4382/:4549/:4652 同款"新键写入不覆盖 authority/其他缓存键、
   反向 authority 写入不丢新键"测试各一。

**纪律**：两把新键写库一律不推 updated_at（见第 2 节）。

---

## 6. 第 3 轮预告：分支三列复制与新 digest 字段如何配合

分支复制现状（两层，行号实测）：

1. **会话 metadata 层**：`branch_session_in_db`（manage_session.rs:1354）在 :1424-1427
   **整体 clone 源会话 metadata**（不重建），再 :1428-1438 插入 `branchedFrom`。
   ⇒ `frozenToolSchemaOrder` / `availableSkillsSnapshot` / `microcompactAnchor` 随分支自然继承，
   分支会话的 tools 前缀 / 目录字节与源会话一致，provider cache 可跨分支复用（注释明言）。
   **新增的 `prefixGeneration` / `skillContentDigest` 走同一 clone 自动继承，零改动**——
   这是把两键放 session.metadata 而非新表/新列的决定性理由。
2. **块重放三列层**（V20260806 旁路：`llm_content` / `tool_call_id` / `round_text`，
   BlockReplayData 定义 repo.rs:108-129）：`MessageBlock` 结构体故意不携带三列，
   深拷贝会静默丢列，因此 create 后必须 SQL 级补拷
   `copy_block_replay_with_conn`（repo.rs:1948-1972），调用点 manage_session.rs:1645
   （普通消息块）与 :1685（compaction 摘要块）；失效入口
   `clear_block_llm_content_with_conn`（repo.rs:1979-1992）与
   `update_block_with_conn` 的 CASE WHEN 失效（repo.rs:2042-2052）。

第 3 轮配合方式（给设计稿的约束）：

- **digest 放会话级（metadata）而不放块级**：若第 3 轮想按块记录"该轮技能正文版本"，
  就必须扩 `copy_block_replay_with_conn` 的三列 SQL 为四列，并同步处理
  `is_missing_replay_column_error` 降级面——侵入大。会话级 digest 随 metadata clone
  免费继承，分支后源/支同 digest ⇒ 同代际重放，天然满足"分支复用源缓存"。
- **分叉后换代**：分支会话第一次出现"digest 与当前请求正文不一致"或 fan-out 分叉时，
  只推进**分支自己的** `prefixGeneration`（metadata 已按会话隔离），源会话代际不动——
  与 #7 方案 A 的"整扇出切代"在会话粒度对齐。
- **branchedFrom 可携带出生代际**：建议第 3 轮在 :1431-1436 的 branchedFrom 对象里
  加 `prefixGeneration` 出生值，供 telemetry 追踪"分支后第几轮换代"。
- 编辑重发路径已有失效先例（clear_block_llm_content / update_block CASE WHEN），
  digest 失配触发的换代应复用同一"显式失效、绝不静默漂移"哲学。

---

## 附：本轮验收点自查

1. ✅ 单键更新链表（§1.1，函数/键/updated_at/调用方四列齐）。
2. ✅ 不推 updated_at 纪律 + 第 2 轮沿用要求（§2）。
3. ✅ P2 精确路径（§3.2，history.rs:158/324/353 + types.rs:1080 + 静默漂移根因）。
4. ✅ P4 精确路径（§4，TauriAdapter.ts:5288/5323 fire-and-forget + repo.rs:2793 first-write-wins）。
5. ✅ 第 2 轮键名与落点（§5，prefixGeneration / skillContentDigest，五件套落点）。
6. ✅ 第 3 轮分支配合预告（§6，metadata clone 继承 vs 三列 SQL 扩列取舍）。
