# r2 冻结矩阵：工具面冻结「冻什么 / 不冻什么 / 代际何时切」（Wave2-A 第 2 轮 #9 文档员）

对照代码：本轮 #1–#3 落地后的工作树，行号为 **#9 注释落地后**的当前行号
（`tool_loop.rs` 因新增文件头模块 rustdoc 整体下移 39 行；`helpers.rs`
因三处 rustdoc 扩充下移 ≤13 行；其余文件零改动、行号未动）。
速查版已写入 `src-tauri/src/chat_v2/pipeline/tool_loop.rs:1-40` 文件头。

配套阅读：`r2-impl-generation.md`（#1 helpers/multi_variant）、
`r2-impl-tool-loop.md`（#2 单变体）、`r2-unified-freeze.md`（#3 统一入口）、
`r2-repo-prefix-gen.md`（#4 元数据层）、`ROUND-02-TASKS.md`（API 合同与切代规则原文）。

---

## 1. 总矩阵

| # | 对象 | 冻 / 不冻 | 粒度（生命周期） | 权威状态 | 持久化 | 代码锚点 |
|---|---|---|---|---|---|---|
| F1 | tools 名字序（已发出工具的相对顺序） | **冻** | **会话级**、append-only：跨轮、跨 `execute_with_tools` 调用、跨进程重启均不变；新工具只按首见轮次追加末尾 | `frozen_tool_schema_orders` 共享 map 的 `ToolFaceBaseline.order`（`helpers.rs:27`） | session.metadata `frozenToolSchemaOrder`（`types.rs:459`），经 `advance_session_tool_face_prefix`（`repo.rs:2964`，IMMEDIATE、无变更跳过、不推 updated_at） | 原语 `freeze_tool_schema_order_for_prompt_cache`（`tool_loop.rs:78`）、合并 `merge_frozen_tool_schema_order_baseline`（`tool_loop.rs:117`）；读 `load_session_tool_face_prefix`（`helpers.rs:1076`）、单写者写回 `store_session_frozen_tool_schema_order`（`helpers.rs:1213`） |
| F2 | 已发出 schema 的**序列化字节** | **冻** | **窗口级**：一次 `execute_with_tools` 工具环 = 一个稳定窗口（单变体）；一个变体的工具环 = 一个稳定窗口（多变体）。窗口内同名 schema 变化（MCP 刷新 / load_skills 重复披露不同版本）继续发送首见冻结字节，变更延迟到**下一稳定窗口**生效 | 局部 `frozen_tool_schemas: HashMap<String, Value>`（单变体 `tool_loop.rs:442`；变体环内各自持有，不写共享态） | **字节副本不持久化**（跨窗口允许采纳新字节）；仅摘要落库：`toolSchemaDigest`（`types.rs:502`），`None` 缺省不构成变更、不得抹掉已有值 | 原语 `freeze_tool_schemas_for_prompt_cache`（`tool_loop.rs:147`，无条件回写冻结副本——preserve_order 下 `==` 相等不等于字节相等）；摘要 `tool_schema_digest`（`tool_loop.rs:189`）；统一门面 `freeze_tool_face_for_prompt_cache`（`tool_loop.rs:220`） |
| F3 | generation 代号 `g` | **冻**（会话级单调，只升不降） | **会话级**：load 恢复取 `max`、永不归零回退；仅 fan-out join 收敛点真分叉时 +1（见第 3 节） | `ToolFaceBaseline.generation`（`helpers.rs:27`） | session.metadata `toolFacePrefixGeneration`（`types.rs:492`），与 `frozenToolSchemaOrder` 同一 IMMEDIATE 事务双键落库，避免「序新、代旧」漂移 | 唯一切代点 `converge_session_tool_face_prefix`（`helpers.rs:1140`，bump 于 `:1168-1169`）；快照形态 `ToolFacePrefixSnapshot`（`types.rs:515`）、`VariantMeta.tool_face_prefix`（`types.rs:1303`） |
| N1 | 技能正文（transient 注入消息体） | **不冻**（本轮豁免） | 轮内仅有**位置锚定**：P1-8 首轮构建后位置冻结（历史末尾、当前 user 之前），环内 load_skills 新技能按 tool_call_id 锚定到 tool result 之后（`tool_loop.rs:419` `frozen_turn_skill_injection`） | — | — | 正文字节冻结属 **P2，第 3 轮**处理；本轮任何人不得给技能正文加字节冻结 |
| N2 | available_skills 目录**换代** | **不冻**（超出本机制范围） | P0 已有会话级**首写冻结**快照（first-write-wins，`repo.rs:2803` `freeze_session_available_skills_snapshot`，键 `availableSkillsSnapshot`，`types.rs:470`），但目录**重生成 / 升级换代**策略属 **P4** | — | （P0 快照本身持久化，与本代际机制无耦合） | 换代不触发 F3 的 generation bump；两套机制各自独立 |
| N3 | system 前缀内 user_profile 等易变段 | **不冻**（有意易变） | 每轮可随记忆库 / 隐私模式变化（`pipeline/prompt.rs:23,85`，注入点 `prompt_builder.rs:620-628`，XML 转义） | — | — | prompt_builder 侧语义，工具面冻结机制不覆盖；缓存收益由 system 前缀自身的段序稳定策略负责，与 tools 三层冻结无关 |

---

## 2. 三层冻结的分工（为什么是「会话级序 + 窗口级字节 + 会话级代号」）

- **F1 名字序（会话级）**：Anthropic 等把 tools 数组纳入缓存前缀，顺序漂移
  = tools 第 0 字节起变化，整段前缀失效。所以已发出的相对顺序必须跨轮、
  跨进程存活 —— 持久化 + 内存 map 双权威，miss 时从 metadata 恢复
  （`load_session_tool_face_prefix`，`helpers.rs:1076`：放锁读库、加锁
  append-only 回填，防 TOCTOU 双建）。
- **F2 字节（窗口级）**：schema 内容变更（服务器刷新）不能永久压死 ——
  只需保证「一个稳定窗口内已发出前缀逐字节不变」。窗口结束后副本丢弃，
  下一窗口采纳新字节；digest 落库仅作跨窗口对账观测。
- **F3 代号（会话级）**：多变体真分叉后旧前缀已注定打不中缓存，切代是
  「承认分叉、以收敛序重建基线身份」的显式记号；一切非分叉路径沿用
  当前代号，避免无谓作废。

调用面（多变体，`multi_variant.rs` 本轮未再改、行号现势）：
fan-out 入口统一 load 一次快照（`:509`，retry 批 `:2777`、单变体退化路径
`:2990`）→ 变体环内统一门面冻结（`:1362` 初始 MCP 注入、`:1728`
load_skills 渐进披露）→ join 之后收敛（`:600` / `:2865` / `:3012`）。
变体中途**不再** store（#1 已删），只推本地 order。

---

## 3. 代际何时切（唯一切代点 + 完整不切代清单）

**唯一切代点**：`converge_session_tool_face_prefix`（`helpers.rs:1140`）。

**切（+1）** —— 多变体真分叉：
- 判定（`helpers.rs:1156-1158`）：按变体索引序（非完成竞态序）从空表
  append-only 合并出收敛序 `converged` 后，**存在某变体本地 order 不是
  `converged` 的前缀** → 真分叉。典型：变体 A 尾部追加 `X`、变体 B 尾部
  追加 `Y`，合并得 `B̂+[X,Y]`，B 的 `B̂+[Y]` 不是其前缀 → `generation += 1`
  （`helpers.rs:1168-1169`），新基线 = 索引序确定性合并结果。
- 契约测试：`prefix_generation_fork_tests.rs`（A/B 互异尾部 → g==1、
  order 由索引序决定）。

**不切（generation 保持不变）** —— 逐条：
| 场景 | 依据 |
|---|---|
| load / 跨进程恢复回填（含并发首建 miss 双方合并） | `helpers.rs:1076`：generation 只取 `max`、order 只补缺失名、digest 只填空位；「load 是恢复不是推进」 |
| 单变体纯前缀扩展（环内 load_skills 只追加新名） | `store_session_frozen_tool_schema_order`（`helpers.rs:1213`）：沿用当前代号——旧缓存仍是新请求前缀，切代反而有害 |
| 单变体窗口 digest 变化（schema 字节换代） | `tool_loop.rs:1101-1112`：只打 info 日志 + 更新本地对账值，**不 bump**；变更随下一稳定窗口 / 多变体 converge 评估 |
| 单变体输入 converge（收敛结果恒等于其本地 order，前缀检查恒真） | `helpers.rs:1156-1158`；单变体重试 = 纯扩展，永不切代 |
| 多变体全体纯扩展 / 完全相等（可 append-only 对齐） | 真分叉判定为假，仅合并 order |
| available_skills 目录换代、技能正文变化、user_profile 变化 | 不属于工具面三键，机制上无从触发 bump（见 N1–N3） |

---

## 4. 持久化与恢复要点（三键一致性）

- 三键：`toolFacePrefixGeneration` + `frozenToolSchemaOrder`（+ 可选
  `toolSchemaDigest`），`advance_session_tool_face_prefix`
  （`repo.rs:2964`，`_with_conn :2977`）单 IMMEDIATE 事务同步落库、
  无变更跳过写库、不推 `updated_at`、不覆盖 metadata 其他键。
- 读：`get_session_tool_face_prefix`（`repo.rs:2927`）；缺代际键时
  generation 视为 0、order 回退旧 `frozenToolSchemaOrder`（向后兼容）。
- 任何持久化失败只降级打 warn（内存基线仍权威），绝不阻断发送；
  下一进程退回持久化基线。
- 恢复契约测试：`prefix_generation_restore_tests.rs`（清内存后同代恢复、
  并发首建收敛 g=0）。

---

## 5. 三行摘要

1. **冻**：tools 名字序会话级 append-only 冻结（`frozenToolSchemaOrder`）、已发出 schema 字节窗口级冻结（一次工具环 = 一个稳定窗口，仅 digest 落库）、generation 会话级单调（`toolFacePrefixGeneration`，三键同 IMMEDIATE 事务）。
2. **不冻**：技能正文（P2 第 3 轮，本轮只有轮内位置锚定）、available_skills 目录换代（P0 首写快照之外的重生成属 P4）、system 内 user_profile 等易变段。
3. **切代**：唯一切代点是 fan-out join 的 `converge_session_tool_face_prefix`——≥2 变体本地 order 不是收敛结果前缀（真分叉）才 +1；load 回填、单变体纯扩展、digest 变化一律不切。
