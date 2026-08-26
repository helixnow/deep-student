# R2 #4 元数据层：tools 前缀代际的 repo 键位、事务与缺键回退

- 基线：`cursor/0824-wave2-agent-cache-a875`（第 2 轮，方案 A——fan-out 统一代际）。
- 作者：R2 子代理 #4（claude-fable-5-thinking-high）。
- 范围：只改 `types.rs` + `repo.rs`（本席独占）。**未触碰** helpers /
  multi_variant / tool_loop / hooks / coordinator / 前端 / 分支复制 SQL。
- 模板：完全沿用 `microcompactAnchor` 五件套（常量、`*_from_metadata`、
  get/`_with_conn`、advance/`_with_conn`，见 `repo.rs` microcompact 段）。

---

## 1. 键位设计（session.metadata 三键合成一个快照）

| 键 | 形态 | 语义 | 归属 |
| --- | --- | --- | --- |
| `toolFacePrefixGeneration`（新，`TOOL_FACE_PREFIX_GENERATION_METADATA_KEY`） | JSON number（u64） | 当前代号 `g`；仅 fan-out 收敛检出真分叉时 +1，单变体纯扩展永不切代 | 新增 |
| `frozenToolSchemaOrder`（现有，键与形状不变） | JSON string array | 权威基线 `B_g`（append-only 首见序）。**代际键不重复存序**，order 唯一权威仍是此键 | 保留 |
| `toolSchemaDigest`（新，`TOOL_SCHEMA_DIGEST_METADATA_KEY`） | JSON string | 可选的 tools schema 冻结字节摘要，供 #2/#3 检测"同名工具字节变了"的漂移 | 新增 |

统一形态 `ToolFacePrefixSnapshot { generation, order, schema_digest }`
（`types.rs`，serde camelCase、digest 为 None 时不序列化）。该结构同时挂到
`VariantMeta.tool_face_prefix: Option<ToolFacePrefixSnapshot>`
（`skip_serializing_if`，老数据缺字段解析为 None），供变体重放逐字节还原。

**为什么 order 不搬进新键**：`frozenToolSchemaOrder` 已有完整读写链
（`get/merge_session_frozen_tool_schema_order` + helpers 内存基线 + 4 条
repo 测试），把序留在原键、advance 同事务同步写入，旧读路径零改动、
零迁移；代际键只补"第几代"这一维。

## 2. 读路径与缺键回退（`tool_face_prefix_from_metadata`）

解析器与既有三个 `*_from_metadata` 同区、同容错哲学（缺键/类型不符一律
降级、绝不报错）：

- 缺 `toolFacePrefixGeneration`（或非 u64）→ **generation 视为 0**——
  升级前的旧会话等同第 0 代，缓存血统不因升级断裂；
- order 一律回退读现有 `frozenToolSchemaOrder`；
- 缺 `toolSchemaDigest`（或非字符串）→ None；
- 三个来源全缺（会话从未冻结过任何 tools 状态）→ 整体返回 None，
  即 `get_session_tool_face_prefix -> Ok(None)`，等同会话首轮语义。

## 3. 写路径与事务（`advance_session_tool_face_prefix[_with_conn]`）

外层 `transaction_with_behavior(Immediate)`，`_with_conn` 内读-合并-写：

1. 读 session → 解析持久化快照（含缺键回退）；
2. **order append-only 合并**：复用
   `tool_loop::merge_frozen_tool_schema_order_baseline`——只按快照顺序
   追加缺失名，绝不删除/重排已持久化条目（与
   `merge_session_frozen_tool_schema_order` 同原语）；
3. **generation 只前进不回退**：取 `max(persisted, snapshot)`，并发
   advance 竞争时更大代号胜出；
4. **digest 仅在快照携带时更新**：`snapshot.digest.or(persisted)`，
   快照无 digest 不抹掉已持久化值；
5. **无变更跳过写库**：generation/order/digest 三者皆同即早退（发送
   热路径高频调用，避免无意义行重写）；
6. **同事务双键（或三键）落库**：`toolFacePrefixGeneration` +
   `frozenToolSchemaOrder`（+ 有值时的 `toolSchemaDigest`）在同一个
   IMMEDIATE 事务内一起 upsert——绝无"代号新、序旧"的半提交窗口，
   旧读路径与新读路径永远一致；
7. **只 merge 这些键**：`as_object_mut().insert(...)` 逐键 upsert，
   authority/plan/branchedFrom/microcompactAnchor/availableSkillsSnapshot
   等其他键原样保留；
8. **不推 `updated_at`**：与三个既有缓存键同纪律（r1-prompt-chain-anchor
   §2），避免代际切换把会话顶到列表首位。

事务内不触碰任何进程内存锁（锁序纪律由调用方 helpers 遵守：锁内合并
克隆、放锁再调本函数），与 microcompact / availableSkills 的 IMMEDIATE
事务互为独立、不嵌套。

## 4. 分支复制：零改动（应为否，确认为否）

分支路径 `branch_session_in_db` 整体 clone 源会话 metadata，三键随
JSON 自然继承——分支会话出生即带源会话的 `(g, B_g, digest)`，provider
缓存可跨分支复用。**本轮未改任何分支复制 SQL**（`copy_block_replay_with_conn`
三列旁路与本层无关，新字段 `VariantMeta.tool_face_prefix` 随 variants
JSON 走，同样免费继承）。

## 5. 新增符号清单

`types.rs`：

- `TOOL_FACE_PREFIX_GENERATION_METADATA_KEY`
- `TOOL_SCHEMA_DIGEST_METADATA_KEY`
- `struct ToolFacePrefixSnapshot { generation: u64, order: Vec<String>, schema_digest: Option<String> }`
- `VariantMeta.tool_face_prefix: Option<ToolFacePrefixSnapshot>`（新字段）

`repo.rs`：

- `fn tool_face_prefix_from_metadata`（模块级解析器）
- `ChatV2Repo::get_session_tool_face_prefix` / `_with_conn`
- `ChatV2Repo::advance_session_tool_face_prefix` / `_with_conn`
- 测试（只写不跑）：
  `tool_face_prefix_missing_generation_key_falls_back_to_generation_zero`、
  `tool_face_prefix_advance_does_not_touch_updated_at`、
  `tool_face_prefix_advance_writes_generation_and_order_atomically`

## 6. 给 #1/#2/#3 的接口约定

- 内存 miss 恢复：`get_session_tool_face_prefix` 返回 None 时按
  `ToolFacePrefixSnapshot::default()`（generation=0、空 order）冷启动；
  返回 Some 时直接回填内存基线。
- 收敛写回：helpers 的 `converge_session_tool_face_prefix` 在锁外调
  `advance_session_tool_face_prefix`，失败仅 warn 降级（沿用
  `store_session_frozen_tool_schema_order` 的降级语义），不阻断发送。
- 单变体路径可继续走 `merge_session_frozen_tool_schema_order`（纯扩展
  不切代），也可改走 advance（generation 传当前值即等价）；两条写路径
  对 order 的合并原语相同，互不破坏。
