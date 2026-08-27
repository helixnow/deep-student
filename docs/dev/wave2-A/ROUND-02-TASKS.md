# Wave2-A 第 2 轮任务卡（缓存代际统一——本会话最重落地）

基线枝：`cursor/0824-wave2-agent-cache-a875` @ `167eb104`（第 1 轮收口）。
官方基座仍是 `061b4815`。Draft PR #345。
模型：**全部子代理 `claude-fable-5-thinking-high`**。禁止 sol / GPT / xhigh。
禁止任何 npm / cargo / rustc / rustfmt / tsc / vite / 测试执行 / CI / computerUse。
允许：读、改产品代码、写测试源码（不跑）、grep、commit 由父代理收轮。

**裁定（第 1 轮已定，不许再二选一）**：方案 A——fan-out 统一代际。
必读：`docs/dev/wave2-A/r1-multi-variant-design.md`、`docs/dev/wave2-A/r1-tool-loop-anchor.md`、
`docs/dev/wave2-A/r1-prompt-chain-anchor.md`、`docs/dev/wave2-A-ledger.md` 第 4 节。

## 红线 / 禁改区

- 不碰 `coordinator.rs`、hooks.rs 准入序列 / TOCTOU / `ApprovalGateHook` 首位
- 不碰 Composer 移动热区 / 桌面行为 / Anki 算法 / executors
- 不 merge 其他枝；不修 #122
- 新 metadata 键**不推 `updated_at`**，单键/双键 merge，不覆盖其他键
- 同文件同轮单人（见下方独占表）
- 过滤器负例测试一条不许删（本轮不应碰到）

## API 合同（所有人必须用这些名字，禁止各写一套）

```rust
// types.rs
pub const TOOL_FACE_PREFIX_GENERATION_METADATA_KEY: &str = "toolFacePrefixGeneration";
pub const TOOL_SCHEMA_DIGEST_METADATA_KEY: &str = "toolSchemaDigest";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ToolFacePrefixSnapshot {
    pub generation: u64,
    pub order: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_digest: Option<String>,
}

// repo.rs —— IMMEDIATE 事务；generation + frozenToolSchemaOrder（+ 可选 digest）同事务；
// 无变更跳过写库；不推 updated_at
pub fn get_session_tool_face_prefix(...) -> ChatV2Result<Option<ToolFacePrefixSnapshot>>
pub fn get_session_tool_face_prefix_with_conn(...)
pub fn advance_session_tool_face_prefix(db, session_id, snapshot: &ToolFacePrefixSnapshot) -> ChatV2Result<()>
pub fn advance_session_tool_face_prefix_with_conn(...)

// helpers.rs
pub struct ToolFaceBaseline {
    pub generation: u64,
    pub order: Vec<String>,
    pub schema_digest: Option<String>,
}
pub(crate) fn load_session_tool_face_prefix(...) -> ToolFaceBaseline
pub(crate) fn converge_session_tool_face_prefix(...) -> ToolFaceBaseline
// 保留现有 load/store_session_frozen_tool_schema_order，内部改走新结构或薄封装，勿拆调用方语义
```

切代规则：纯前缀扩展（只 append 新名、无互异尾部）**不 bump generation**；
≥2 变体产生互异不可 append-only 对齐的尾部 → `generation += 1`，新基线按**变体索引序**
（不是完成竞态序）确定性合并。单变体路径永不因扩展而切代。

---

### 独占文件表

| # | 角色 | 独占可写 |
|---|---|---|
| 4 | 元数据层（先跑） | `types.rs` + `repo.rs` |
| 5 | 反例-分叉（可与 4 并行，新文件） | `src-tauri/src/chat_v2/pipeline/prefix_generation_fork_tests.rs`（新建） |
| 6 | 反例-恢复（可与 4 并行，新文件） | `src-tauri/src/chat_v2/pipeline/prefix_generation_restore_tests.rs`（新建）+ 如需 `repo.rs` 测试则等 4 完成后再补，本席只写新文件 |
| 1 | 代际实现-1（等 4） | `helpers.rs` + `multi_variant.rs` |
| 2 | 代际实现-2（等 4） | `tool_loop.rs` |
| 3 | 统一冻结原语（等 1+2） | 可小补 `helpers.rs`/`tool_loop.rs` 仅收敛缺口；优先把统一入口放 helpers |
| 7 | 审阅员-并发（等 1–4） | 只写 `docs/dev/wave2-A/r2-review-concurrency.md` |
| 8 | 审阅员-语义（等 1–4） | 只写 `docs/dev/wave2-A/r2-review-semantics.md` |
| 9 | 文档员（等 1–2） | 只改 `tool_loop.rs`/`helpers.rs` **文件头注释**（矩阵）；可写 `docs/dev/wave2-A/r2-freeze-matrix.md` |
| 10 | 提交员 | `docs/dev/wave2-A-ledger.md` 追加第 2 轮段；不 commit |

---

### #4 元数据层

沿用 `microcompactAnchor` 五件套模板（`repo.rs:2816-2886`）：常量、from_metadata、
get/_with_conn、advance/_with_conn（IMMEDIATE、无变更跳过、不推 updated_at）。
`frozenToolSchemaOrder` 键保留并继续由 advance 同步写入（双键同事务），避免旧读路径丢序。
缺代际键时 generation 视为 0，order 回退现有 `frozenToolSchemaOrder`。
`VariantMeta` 若存在则加 `tool_face_prefix: Option<ToolFacePrefixSnapshot>`（skip empty）。
禁止改分支复制 SQL 语义；新字段随 metadata JSON 走则免费继承。
产出附记：`docs/dev/wave2-A/r2-repo-prefix-gen.md`。

### #5 反例测试-分叉（只写不跑）

新文件测试：「变体 A 追加 X、变体 B 追加 Y，后轮同现 X、Y」——
断言若走旧 append-only 竞态则序不确定；走 `converge` 后 generation==1 且 order 由变体索引序决定（例如 A 先于 B 则 `[…,X,Y]`）。
再写：单变体只 append 不 bump generation。
测试可先调用将由 #1/#4 提供的函数；函数未齐时用清晰的 `// expected API` 与可编译的纯逻辑单元（合并函数可先在测试文件内用 `#[cfg(test)]` 对照副本，产品实现落地后改为调用生产函数）。**不要执行测试。**

### #6 反例测试-恢复（只写不跑）

新文件：「清内存 HashMap 后代际从 metadata 恢复同一 generation+order」；
「并发首建：两个调用同时 miss 必须收敛同一 generation=0 基线，禁止双写各建各的」。
同上，只写不跑。

### #1 代际实现-1

按设计稿改 helpers + multi_variant：
- fan-out **入口**统一 load 一次快照，传入各变体，删 `:1270-1275` 变体内独立 load
- 删变体中途 store（`:1320` / `:1683` 一带）
- `join_all` 之后按变体索引序 `converge_session_tool_face_prefix`
- retry 批同步接入
- 锁序：锁内合并克隆、放锁再写库，不倒置
- 不改 hooks 调用

### #2 代际实现-2

tool_loop.rs：
- 单变体 load 改 `ToolFaceBaseline`，取 order；store 纯扩展不切代
- `freeze_tool_schemas_for_prompt_cache` 冻结副本带 schema digest
- digest 变化时记录代际切换意图（单变体：记录日志 + 写入 snapshot.schema_digest；**不要**因单变体 schema 变就盲目 +1，除非 digest 与已持久化值冲突且无法视为同一窗口）
- 多变体字节冻结：至少把 digest 纳入 snapshot，供 #3 收敛统一原语

### #3 统一冻结原语

把「名字序冻结」与「字节冻结」收成同一入口（建议 `freeze_tool_face_for_prompt_cache`），
单变体与多变体都走它。多变体从此不再只有 freeze_order。不要改变 append-only 语义。

### #7 / #8 / #9 / #10

见上表。#7 逐行审锁序与 IMMEDIATE。#8 确认 hooks 十五段与 TOCTOU 未动。
#9 文件头写清「冻结什么/不冻什么/代际何时切」。#10 追加台账，不标 Goal complete。
