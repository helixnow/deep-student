# Wave2-E 第 7 轮 · 02：gold 反例矩阵扩展（qa_pass 洗白真管线 / update_anki_card user 戳 / import actor 产品符号）

- 角色：gold 反例测试员（0824 Wave2-E R7）
- 纪律：**只写不跑**——本轮未编译、未运行任何测试，未改任何产品代码；
  红绿核对留给第 8 轮统跑。
- 改动范围（仅扩展，第 2 轮既有测试一条未删）：
  - `src-tauri/tests/gold_provenance_excludes_critic.rs`（追加 3 个测试 + 头部表格追补）
  - `docs/dev/wave2-E-r7-02-gold-tests.md`（本文件）
- 预期执行命令（第 8 轮）：

```bash
cargo test --test gold_provenance_excludes_critic
```

## 与第 2 轮（r2-07）的衔接

r2-07 编写时 `_content_provenance` 尚未落地，测试用本地常量先行，并预告
「第 8 轮把本地常量替换为产品符号」。本轮编写时落地已合入主干：

- `anki_gold_set` 已导出 `CONTENT_PROVENANCE_FIELD` / `PROVENANCE_ACTOR_USER`
  / `_LLM_CRITIC` / `_IMPORT` / `_SYNC` / `ContentProvenance` /
  `insert_content_provenance` / `parse_content_provenance` /
  `is_user_proven_edit` / `is_llm_critic_actor`；
- `GoldCandidate` 已带 `#[serde(default)] edit_actor: Option<String>`；
- `anki_critic::plan_updates` revise 分支已落 `llm_critic_revision` 溯源戳，
  `sanitize_plan_for_disabled_qa_pass` 只剥 `QA_FLAGS_FIELD` 不剥溯源戳。

因此本轮追加的 3 个测试**直接引用产品符号**（不再有「落地前红」状态）；
既有测试与其本地常量按「已有不要删」纪律原样保留，本地常量 ↔ 产品符号的
逐字一致改由新增的对齐锁断言兜底（见下），r2 预告的「第 8 轮替换本地常量」
不再必要——漂移会直接红。

## 新增测试 ↔ 覆盖项

| # | 覆盖项（任务书） | 测试函数 | 层 | 预期 |
| --- | --- | --- | --- | --- |
| 7 | qa_pass 洗白路径（真管线版） | `qa_pass_whitewash_pipeline_sanitized_revise_yields_zero_references` | parse → plan → sanitize → 收集器全链 | 绿 |
| 8 | update_anki_card user 戳 | `update_anki_card_user_stamp_proves_user_edit_and_yields_reference` | provenance helper + 收集器 + 标注（pub classify，actor=user） | 绿 |
| 9 | import actor（产品符号版，附带 sync / 未知 actor + 对齐锁） | `import_actor_product_stamp_is_never_user_proof` | helper + 收集器 + 标注 | 绿 |

### 7：qa_pass 洗白路径真管线版

既有覆盖 2（`whitewashed_provenance_actor_llm_critic_yields_zero_references`）
只**模拟** sanitize 之后的落库形态（手写 extras）。新测试走完整 pub 管线：

1. 带围栏的模型 revise 响应 → `parse_critic_response`（含 id 白名单）；
2. `plan_updates`：断言 revise 写回带 `llm_critic_revised` marker；
3. `sanitize_plan_for_disabled_qa_pass`（enable_qa_pass=false 收口）：断言
   - 有实质内容差异的 revise **不被丢弃**（空写回丢弃逻辑不误伤）；
   - `_qa_flags` 整体被剥（marker 消失，洗白前提成立）；
   - `_content_provenance` 存活且 actor=llm_critic、code=llm_critic_revised
     （跨人契约 #2——r2-07 曾把该回归划归落地员模块内单测，本轮经 pub
     `CriticPlan.updates` 可直接触达，从集成侧再锁一道，两侧断言粒度不同不算重叠）；
4. 产物卡与 user 对照卡同批进 `gold_references_from_cards`：只有对照入选。

### 8：update_anki_card user 戳

`EnhancedAnkiService::update_anki_card`（enhanced_anki_service.rs）在写库前
统一覆盖写入 `ContentProvenance::user("update_anki_card")`。服务本体构造需
`Arc<Database>` + `Arc<LLMManager>`，集成测试无法实例化——按任务书回退：
「若只能测 pub classify 则测 actor=user」。测试锁定：

- 该 pub 构造子产出戳的 wire 形态（actor=user、code="update_anki_card"、带 at）；
- last-writer-wins：前端 payload 夹带的 llm_critic provenance 被后端统一戳
  覆盖后，`is_user_proven_edit` = true / `is_llm_critic_actor` = false
  （对应产品注释「不信任前端 payload 自带的 provenance」）；
- 卡片层：该戳的编辑卡入选修正对（1 条 reference）；
- 标注层：`classify_candidate` 对 `edit_actor` 取自同一戳 actor 值的候选给
  `EditedMinor` + 修正对。

真正 DB 落盘路径（UPDATE 同事务、NotFound 无戳）归 enhanced_anki_service
模块内单测，本矩阵不越界。

### 9：import actor 产品符号版

既有覆盖 5 用本地 fixture 常量。新测试：

- **对齐锁**：`ACTOR_*` 本地常量 / 本地 `CONTENT_PROVENANCE_FIELD` 与产品
  `PROVENANCE_ACTOR_*` / `anki_gold_set::CONTENT_PROVENANCE_FIELD` 逐字相等
  （既有测试继续用本地常量也不会与产品语义漂移）；
- import / sync / 未知 actor（`"future_agent"`）三种产品戳
  （`ContentProvenance` 结构体直接构造 + `insert_content_provenance`）：
  `is_user_proven_edit` 一律 false（fail-closed）、单卡 0 条 reference；
  补齐 r2 预留未单列的 sync 反例；
- 四卡混批（3 污染 + 1 user 对照）：只有对照入选；
- 标注层：sync / 未知 actor 候选 → `Unlabeled`、无修正对
  （import 变体已由既有 `classify_import_actor_never_gets_edited_label` 锁定）。

## 本轮新引用的 pub 符号（crate `deep_student_lib`）

- `anki_critic::{parse_critic_response, plan_updates, sanitize_plan_for_disabled_qa_pass}`
- `anki_gold_set::{insert_content_provenance, parse_content_provenance,
  is_user_proven_edit, is_llm_critic_actor, ContentProvenance,
  CONTENT_PROVENANCE_FIELD, PROVENANCE_ACTOR_USER, PROVENANCE_ACTOR_LLM_CRITIC,
  PROVENANCE_ACTOR_IMPORT, PROVENANCE_ACTOR_SYNC}`

以上均已在当前枝头 pub（本轮通读源码核对），但**未经编译验证**（只写不跑
纪律）；若第 8 轮编译报缺符号，优先核对落地枝合并顺序。

## 刻意不覆盖（归属他人）

- `update_anki_card` 的 DB 事务语义（NotFound / CAS / tombstone）：归
  enhanced_anki_service 模块内单测（已存在）。
- APKG 导入侧对外部包伪造 `_content_provenance` / `_original_generation` /
  `_qa_flags` 的剥离（`UNTRUSTED_IMPORT_PROTOCOL_FIELDS`）：`map_card` 为
  私有函数，归 apkg 负责人模块内单测（已存在 forged-field 剥离用例）。
- `chatanki_update_library_card` 的 user 戳：与 update_anki_card 同构
  （`ContentProvenance::user("chatanki_update_library_card")`），构造子形态
  已由覆盖 8 锁定，执行器接线归 chat_v2 侧。
