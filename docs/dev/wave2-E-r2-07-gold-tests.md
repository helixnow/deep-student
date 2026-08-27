# Wave2-E 第 2 轮 · 07：gold 溯源反例矩阵测试说明

- 角色：gold 测试员（0824 Wave2-E R2）
- 纪律：**只写不跑**——本轮未编译、未运行任何测试；红绿核对留给第 8 轮。
- 独占产出（仅新建，不改任何既有产品文件）：
  - `src-tauri/tests/gold_provenance_excludes_critic.rs`
  - `docs/dev/wave2-E-r2-07-gold-tests.md`（本文件）
- 预期执行命令（第 8 轮）：

```bash
cargo test --test gold_provenance_excludes_critic
```

## 验收红线（一句话）

**critic 修订卡必须 0 条 grounded reference**——无论 `_qa_flags` 里的
`llm_critic_revised` marker 是否还在（洗白路径 A：`enable_qa_pass=false` 时
`sanitize_plan_for_disabled_qa_pass` 会把 marker 连同整个 `_qa_flags` 剥掉），
只要 `_content_provenance.actor=llm_critic`，`gold_references_from_cards`
不得产出 `ReferenceCard`，`classify_candidate` 不得给出 `Edited*` 标签。

## 反例矩阵 ↔ 测试函数 ↔ 红绿预期

| # | 覆盖项（任务书） | 测试函数 | 层 | 落地前预期 | 落地后预期 |
| --- | --- | --- | --- | --- | --- |
| 1a | `_qa_flags` 带 `llm_critic_revised` → 不进 grounded pairs | `qa_marker_critic_revised_card_yields_zero_grounded_references` | 收集器 | 绿（既有 `anki_critic.rs:787` marker 过滤） | 绿 |
| 1b | 同上 → classify 不得 `Edited*` | `classify_critic_revised_candidate_never_gets_edited_label` | 标注 + 全链 | 绿（既有 classify 第 1 通道） | 绿 |
| 2 | 无 qa_flags 但 `_content_provenance.actor=llm_critic`（洗白路径 A） | `whitewashed_provenance_actor_llm_critic_yields_zero_references` | 收集器 | **红**（收集器尚不读 provenance） | 绿 |
| 3a | 仅 content≠original、无 provenance、无 marker → 旧卡保守排除 | `legacy_card_without_marker_or_provenance_is_conservatively_excluded` | 收集器 | **红**（现实现挖成 EditedMinor 对） | 绿 |
| 3b | 同上标注层 → `Unlabeled` | `classify_content_diff_without_actor_proof_is_unlabeled` | 标注 | **红**（现实现给 EditedMinor） | 绿 |
| 4a | actor=user + 小幅编辑 → 正常入选（阳性对照） | `user_actor_minor_edit_yields_grounded_reference_pair` | 收集器 | 绿 | 绿 |
| 4b | 同上标注层 → `EditedMinor` | `classify_user_actor_minor_edit_is_edited_minor` | 标注 | 绿 | 绿 |
| 5a | actor=import 不得当用户金标 | `import_actor_card_is_never_user_gold` | 收集器 | **红** | 绿 |
| 5b | 同上标注层 | `classify_import_actor_never_gets_edited_label` | 标注 + 全链 | **红** | 绿 |
| 6a | marker 与 provenance 任一命中即排除（marker-only / provenance-only / 双命中 / user 对照同批） | `marker_or_provenance_any_hit_excludes_only_tainted_cards` | 收集器 | **红**（provenance-only 变体漏网） | 绿 |
| 6b | marker 判定只认结构化稳定 code | `marker_helper_hits_only_structured_stable_code` | helper | 绿 | 绿 |

「落地前红」的六条正是 P0-2 三洞（洗白路径 A、无 actor、导入注入面）的可执行
证据；红转绿即 r1-04 §5 两道闸（收集器 provenance 过滤 + 标注层 actor 闸门）
生效的验收信号。gold/critic 模块内单测归落地员，本矩阵只走 pub API，两侧互不重叠。

## 只用了哪些 pub 符号（对照 crate 名 `deep_student_lib`）

- `anki_critic::{gold_references_from_cards, CriticConfig, ReferenceCard}`
- `anki_gold_set::{classify_candidate, mine_gold_set, select_grounded_reference_pairs,
  has_critic_revision_marker, gold_lint_config, GoldCandidate, GoldLabel,
  GoldMiningConfig, CRITIC_REVISED_QA_CODE, ORIGINAL_GENERATION_FIELD}`
- `anki_qa_lint::QA_FLAGS_FIELD`
- `models::AnkiCard`

以上全部在当前枝头已 pub（`lib.rs` 导出 `anki_critic` / `anki_gold_set`），
文件应可在**落地前后两个状态**下均编译通过（见下节兼容手法）。

## 未落地符号的处理（待第 8 轮与落地符号对齐）

`_content_provenance` 键名与 actor wire 值在编写时尚未落地（r1-04 §5.1 方案，
落地员本轮实现）。测试内用本地常量先行，逐字对齐方案约定：

- `CONTENT_PROVENANCE_FIELD = "_content_provenance"`
- actor 小写 wire 值：`"user"` / `"llm_critic"` / `"import"`；`"sync"` 以
  `#[allow(dead_code)]` 预留（本矩阵未单列 sync 反例，语义同 import）。
- provenance 值形状：`{"actor":..., "code":..., "at":"<rfc3339>"}` 二次编码字符串。

第 8 轮对齐清单（唯一预期改动点）：

1. 若落地员在 `anki_gold_set` 导出了 `CONTENT_PROVENANCE_FIELD` / actor 枚举
   常量，把测试头部本地常量替换为产品符号（值不变则测试语义不变）。
2. 若 actor wire 值与方案不同（如大小写），同步改 `provenance_value` 与
   `edited_candidate_json` 注入的 `"edit_actor"` 字面量。
3. 若 `EditedMinor` 标签被落地员改名，调整
   `classify_user_actor_minor_edit_is_edited_minor` 的断言（测试注释已标注）。

## 前向兼容手法（为什么落地员加字段不会打破本测试的编译）

- `AnkiCard` 与 `GoldCandidate` 一律经 `serde_json::from_value` 构造，
  不用结构体字面量：落地员按方案给 `GoldCandidate` 加
  `#[serde(default)] pub edit_actor: Option<EditActor>` 后，本测试零改动编译。
  这同时顺带覆盖了 r1-04 §5.5 反例 7 的语义（旧 JSON 无 `edit_actor`
  反序列化成功且默认 None——`classify_content_diff_without_actor_proof_is_unlabeled`
  的 fixture 正是无该字段的旧 JSON）。
- 标注层候选 JSON 里前置写入 `"edit_actor": "user" / "import"`：
  serde 默认忽略未知字段，落地前无副作用、落地后自动生效——同一份 fixture
  在两个状态下都合法，红绿差异只来自产品行为，不来自 fixture 形状。

## 刻意不覆盖（归属其他人/其他轮）

- `sanitize_plan_for_disabled_qa_pass` 保留 `_content_provenance` 的语义切分
  回归（跨人契约 #2）：需触达 `CriticPlan` 内部构造，归落地员模块内单测。
- APKG 导出/导入的 `_` 前缀字段剥离（r1-04 §5.5 反例 8）：归 apkg 负责人。
- FSRS 留存信号路径（`KeptUnedited`）与删除通道：与 provenance 无交集，
  既有模块单测已锁定。
