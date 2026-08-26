# Wave2-E 第 1 轮 · 锚定审阅 04：critic 修订 × gold mining 污染分析

- 角色：锚定员-critic/gold（0824 Wave2-E R1）
- 审阅方式：纯静态（未编译/未测试）
- 核心文件：`src-tauri/src/anki_critic.rs`、`src-tauri/src/anki_gold_set.rs`、
  `src-tauri/src/streaming_anki_service.rs`、`src-tauri/src/apkg_exporter_service.rs`
- 交叉提交：`7077075a`（"Gate Anki critic QA flag persistence on enable_qa_pass"，
  cherry-pick 自 `b36b8356`，即 `sanitize_plan_for_disabled_qa_pass` 及其测试）

## 结论先行

**污染成立（P0）。** `enable_critic_pass=true` 且 `enable_qa_pass=false` 时，critic 的
revise 内容照常写回 DB，但其唯一来源标记 `llm_critic_revised`（住在 `_qa_flags` 里）
被 7077075a 引入的 `sanitize_plan_for_disabled_qa_pass` 剥离后才落盘。该卡随后满足
gold mining 的全部准入条件（有 `_original_generation`、内容 ≠ 快照、无 marker），
在后续兄弟任务收尾时会被 `gold_references_from_cards` 当成**用户修正对**注入
grounded critic prompt——模型自改回灌为金标，闭环自证。

次级问题：`_original_generation` 与 `_qa_flags` 均会泄漏进 APKG 导出的 note 字段。

---

## 1. gold mining 准入条件（什么卡能进 grounded reference）

生产收尾链：`streaming_anki_service.rs:681` → `collect_gold_references`
（`anki_critic.rs:827-850`，查 `get_cards_for_document` 全量同文档卡）→
`gold_references_from_cards`（`anki_critic.rs:777-822`）→
`mine_gold_set`/`classify_candidate`（`anki_gold_set.rs:389-527`）→
`select_grounded_reference_pairs`（`anki_gold_set.rs:656-688`）。

### 准入表（逐层过滤）

| # | 层 | 条件 | 位置 |
|---|-----|------|------|
| 1 | 收集器 | `task_id != 当前任务`（不能既当裁判又当被告） | anki_critic.rs:786 |
| 2 | 收集器 | `!is_error_card` | anki_critic.rs:786 |
| 3 | 收集器 | `_qa_flags` 中**无** `code=llm_critic_revised` 结构化条目 | anki_critic.rs:787 → anki_gold_set.rs:315-325 |
| 4 | 收集器 | `extra_fields` 中可解析出 `_original_generation` 快照 | anki_critic.rs:789 → anki_gold_set.rs:302-309 |
| 5 | 标注 | `critic_revised=false`（此路径在 :805 硬编码 false，依赖第 3 条兜底） | anki_gold_set.rs:397-404 |
| 6 | 标注 | 未删除、非错误卡、非"曾为错误卡"（此路径均为默认值） | anki_gold_set.rs:407-460 |
| 7 | 标注 | `original != current` → 按编辑距离比分 `EditedMinor`(<0.25) / `EditedMajor`(≥0.25)，产出 `RepairPair` | anki_gold_set.rs:462-497 |
| 8 | 选取 | label ∈ {EditedMinor, EditedMajor, ErrorCardRepaired} 且带 pair | anki_gold_set.rs:667-675 |
| 9 | 选取 | 金标端（edited）非空 | anki_gold_set.rs:676-678 |
| 10 | 选取 | 金标端经 `gold_lint_config()` Warn+ 零命中（脏金标不注入；刻意**不要求** original 被 lint 命中——盲区对是 LLM critic 的增量价值） | anki_gold_set.rs:679-681 |
| 11 | 选取 | 按 `edited.front` 去重，保持输入顺序，上限 `max_reference_pairs`（默认 6） | anki_gold_set.rs:682-687 |

之后 `ReferenceCard::from_repair_pair`（anki_critic.rs:198-209）把 edited 映射为金标面、
original 映射为劣化面，prompt 侧再受对数上限与 `max_prompt_chars/3` 字符预算钳制
（anki_critic.rs:387-427）。

**关键观察**：整条链对"这次编辑是谁做的"没有任何直接证据，第 7 条的"用户编辑"
完全是**推断**（内容 ≠ 生成快照），唯一的反向排除是第 3 条的 `_qa_flags` marker。

## 2. EditedMinor/Major 有无编辑者概念？llm_critic_revised 会否被当成用户编辑？

**没有编辑者概念。** `GoldCandidate`（anki_gold_set.rs:127-150）仅有一个布尔
`critic_revised`，且它不是独立埋点，而是从 `_qa_flags` 的 `llm_critic_revised`
条目**派生**（`has_critic_revision_marker`）。`classify_candidate` 第 5 通道
（anki_gold_set.rs:462-497）判 EditedMinor/Major 的条件只有
`original != current`——用户、critic、导入合并、同步合并、未来任何 agent 写入
在此不可区分。`AnkiLibraryScope::agent()`（database/mod.rs:99-103）是零字段能力
token，不落任何 actor 记录；`update_anki_card` 命令（cmd/enhanced_anki.rs:267）
也不记录写入者。

**llm_critic_revised 会被当成用户编辑，在以下路径下必然发生**：

### 污染路径 A（主路径，与 7077075a 直接相关）

1. 任务 T1 生成卡 C，入库时固化 `_original_generation`（streaming_anki_service.rs:2053-2067）；
2. `enable_critic_pass=true`、`enable_qa_pass=false`：critic 判 C 为 revise，
   `plan_updates` 写入新内容 + `llm_critic_revised` 审计条目（anki_critic.rs:656-661）；
3. `run_critic_pass` 中 `qa_pass_enabled=false` 触发
   `sanitize_plan_for_disabled_qa_pass`（anki_critic.rs:949-955 → 692-709）：
   **剥掉整个 `_qa_flags`**（含 marker），revise 内容因有实质 diff 保留写回（960-983）；
4. 落库后的 C：内容 = critic 改写，`_original_generation` = 模型原文，**无任何 marker**；
5. 同文档任务 T2 收尾，`gold_references_from_cards` 对 C 的过滤：
   任务不同 ✓、非错误卡 ✓、`has_critic_revision_marker` = **false**（marker 已被剥）、
   有快照 ✓ → `classify_candidate` → `original != current` → EditedMinor/Major →
   `RepairPair` → 金标端只要过 lint（critic 改写通常恰好是 lint-clean 的）即注入 prompt。

模块头注释（anki_critic.rs:24-27）明确承认了这个组合是公开契约：
"revise 的内容修订仍写回"。即门控本身按设计工作，但它把 provenance 标记和
QA 留痕**捆绑在同一个字段**里一起剥掉了——这是污染的根因。

### 污染路径 B（marker 脆弱性，qa_pass 开启时也存在）

marker 住在 `_qa_flags`——一个前端可见、可被整体重建的普通 extra 字段：

- `src/utils/chatApi.ts:229-259`（`updateAnkiCard`）以调用方传入的 `fields`
  **整体重建** `extra_fields`，调用方若不带 `_qa_flags`，marker（连同
  `_original_generation`）即被冲掉；
- `tauri://update_anki_card` → `enhanced_anki_service.rs:730-743` →
  `update_anki_card_rows`：无版本 CAS、无字段保护，前端给什么存什么。

marker 丢失但 `_original_generation` 侥幸保留（如 chatApi.ts:180-218 的另一条
编辑路径会展开保留旧 `extra_fields`）时，critic 修订卡同样洗白为"用户编辑"。

### 非污染但相关的保守性

带 marker 的卡即使后来被用户真实编辑过，也被第 3 条**整卡排除**（过度排除，
可接受：宁可少挖，不可污染）。`classify_candidate` 第 1 通道对 `critic_revised`
的 Unlabeled 处理（anki_gold_set.rs:397-404）语义正确，但生产收集器路径
:805 硬编码 `critic_revised: false`，该防线实际只由 :787 的 marker 过滤承担——
单点防御，marker 一丢即溃。

## 3. `_original_generation` 全链

| 环节 | 位置 | 行为 |
|------|------|------|
| **写入** | streaming_anki_service.rs:2053-2067（`parse_and_save_card` 尾部）→ `insert_original_generation_once`（anki_gold_set.rs:252-278） | 首次入库时固化清理后的 front/back/text；幂等（键已存在逐字节保留）；16 KiB 上限，超限只丢快照不阻断入库。注意：写入发生在 lint/`_qa_flags` 收口**之后**，是唯一写入点；critic revise 不会二次写入 |
| **读取** | anki_critic.rs:789（收集器，内存态 `extract_original_from_extras`）；anki_gold_set.rs:285-297（`extract_original_generation`，离线挖掘用 JSON 原文形态）；测试 anki_new_wiring_tests.rs | 仅 gold mining 消费。缺失时编辑通道退化为 Unlabeled（anki_gold_set.rs:491-497） |
| **保护** | 无版本 CAS 的 `update_anki_card` 全量覆盖 `extra_fields_json`，前端重建路径（chatApi.ts:254-257）可无声抹掉快照 | 抹掉的后果是"少挖一对"，方向安全（不进 gold），但损失信号 |
| **泄漏到 APKG：是** | apkg_exporter_service.rs:1309-1315（单模板）与 :1612-1618（多模板）把全部 `extra_fields` 键追加进 model 字段表，过滤名单仅 13 个 `Anki*` 保留字段（:42-62），**不过滤下划线前缀**；`resolve_card_field_value` 通用分支（:436-449）将快照 JSON 字符串原样写入 `notes.flds` | `_original_generation`（含模型原始输出全文）与 `_qa_flags`（含 critic 理由文本）都会出现在导出的 APKG note 字段中，随分享外泄。另：id 缺失时 guid 内容哈希（:99, :125-133）也混入这些键值 |

APKG 导入侧（apkg_importer_service.rs）不注入 `_original_generation`——外部卡
无快照、进不了修正对挖掘，导入方向目前是安全的。

## 4. critic 修订后是否再走 QA lint？是否受 enable_qa_pass 门控？

- **relint：走。** `plan_updates` 对 revise 后内容重跑确定性
  `anki_qa_lint::lint_card`（anki_critic.rs:662-673），结果 merge 进 `_qa_flags`；
  有单测 `plan_revised_content_is_relinted` 锁定。注意 relint 只留痕、不拦截写回，
  也不含文档级重复指纹（`observe_document_card` 不重跑）。
- **LLM critic 复审：不走。** `MAX_REVISION_ROUNDS_HARD_CAP=1`（:66-67），
  revise 后的卡不再送审。
- **enable_qa_pass 门控（= 7077075a）**：裁决、统计、revise **内容写回**均
  不受 `enable_qa_pass` 影响（critic 由 `enable_critic_pass` 单独开关）；被门控的
  只是 `_qa_flags` 落盘——flag 留痕、`llm_critic_revised` 审计、relint 条目在
  `sanitize_plan_for_disabled_qa_pass`（:692-709，门控点 :949-955）一律剥离，
  flag-only 更新整体丢弃以避免空 CAS。**交叉结论：7077075a 的门控语义（"不要 QA
  留痕"契约对齐 `parse_and_save_card`）自身正确，但它同时剥掉了承担 provenance
  职责的 marker，直接制造了第 2 节路径 A。relint 结果被剥离还意味着 revise 若引入
  占位符等劣化，落库后无任何痕迹。**

## 5. 第 2 轮 P0-2 最小加法方案

原则：纯加法、不动 wire 契约、不动 `AnkiGenerationOptions`、旧数据零迁移。

### 5.1 字段放哪：`_content_provenance`（extra_fields 新键，与 `_qa_flags` 解耦）

在 `anki_gold_set.rs` 增加常量与读写 helper（与 `ORIGINAL_GENERATION_FIELD` 并列）：

```rust
pub const CONTENT_PROVENANCE_FIELD: &str = "_content_provenance";
// 值为二次编码 JSON：{"actor":"llm_critic","code":"llm_critic_revised","at":"<rfc3339>"}
// actor 枚举（wire 小写）："user" | "llm_critic" | "import" | "sync"
```

写入点（均为纯加法）：

1. `anki_critic::plan_updates` 的 Revise 分支（anki_critic.rs:656 附近）：写
   `actor=llm_critic`。**关键约束：`sanitize_plan_for_disabled_qa_pass` 只移除
   `QA_FLAGS_FIELD`（:694），新字段天然存活**——provenance 是事实记录不是 QA 留痕，
   不受 `enable_qa_pass` 门控，这正是与 7077075a 语义切分的边界。需同步更新该函数
   文档注释，声明 provenance 不在剥离范围。
2. 用户编辑路径：`cmd::update_anki_card`（cmd/enhanced_anki.rs:281 前）在**后端**
   盖 `actor=user` 戳（不信任前端 payload 自带的 provenance，后端覆写），可放在
   `enhanced_anki_service::update_anki_card` 入口，一处覆盖 ReviewSession /
   ankiCardsBlock / chatApi 三个前端调用点。
3. （可选 P1）anki_connect 保存路径 `update_anki_card_rows_for_document` 同理。

`GoldCandidate` 增加 `#[serde(default)] pub edit_actor: Option<EditActor>` ——
serde default 保证旧 fixture/离线脚本零改动。

### 5.2 收集器如何排除非用户编辑

两道闸，缺一不可：

1. **收集器过滤点**：`anki_critic.rs::gold_references_from_cards`，在现有
   :787（marker 过滤，保留作为历史数据兜底）之后新增一条 filter：解析
   `_content_provenance`，`actor` 存在且 ≠ `user` → 剔除；同时把解析结果传入
   :805 处的候选（替换硬编码 `critic_revised: false` 为按 provenance/marker
   计算），让 `classify_candidate` 第 1 通道恢复第二道防线。
2. **标注层闸门**：`classify_candidate` 编辑通道（anki_gold_set.rs:462-497 入口处）
   要求 `edit_actor == Some(User)` 才产出 EditedMinor/Major；
   `None` → `Unlabeled("内容有变但缺编辑者证明")`。`KeptUnedited` 通道不受影响
   （original == current 无归因问题）。

### 5.3 旧卡兼容策略（默认保守：无证明不进 gold）

| 存量卡状态 | 处置 |
|-----------|------|
| 带 `llm_critic_revised` marker（qa_pass 开启期间的 critic 修订卡） | 维持现状排除（:787 兜底 + critic_revised 通道） |
| 无 marker、无 provenance、内容 ≠ 快照（含路径 A 已污染卡与真实用户旧编辑，**不可区分**） | **一律 Unlabeled 不进 gold**。代价：新字段上线前的全部历史用户修正对失效；收益：污染卡被彻底清出。挖掘量随新编辑自然回升，方向与"宁可漏报不可误改"的 critic 哲学一致 |
| 有 provenance 且 actor=user | 正常进入编辑通道 |
| 有 provenance 且 actor≠user | 排除；若同卡后续再有 user 编辑（provenance 被 user 戳覆盖），仍保守排除——因 `_original_generation` 与 current 的 diff 中混有 critic 手笔，修正对不纯。如需回收此类卡，须升级为 append-only 修订历史（超出 P0-2 范围，不做） |

### 5.4 配套（同轮或 P1）

- APKG 导出泄漏收口：apkg_exporter_service.rs:1314 与 :1616 的键过滤增加
  `!key.starts_with('_')`（或显式名单 `_original_generation` / `_qa_flags` /
  `_content_provenance`），guid 内容哈希 :125 同步排除，避免加字段后改变存量卡 guid。
- 前端 `chatApi.ts:229-259` 重建 `extra_fields` 时透传下划线字段（防 marker/快照/
  provenance 被编辑冲掉）；后端 provenance 覆写已兜底 actor 正确性。

### 5.5 测试反例清单（第 2 轮验收红线：critic 修订卡不得进 grounded reference）

1. **路径 A 复现**（当前红/修后绿的核心反例）：`enable_qa_pass=false` 下构造
   critic revise 落库形态（内容≠快照、无 `_qa_flags`、有 `_content_provenance`
   actor=llm_critic）→ `gold_references_from_cards` 必须返回空。
2. provenance 存在但 marker 缺失（模拟 `_qa_flags` 被前端重建冲掉）→ 排除。
3. 旧卡：无 marker、无 provenance、内容 ≠ 快照 → `classify_candidate` 为
   Unlabeled 且 reason 含"缺编辑者证明"；`gold_references_from_cards` 不产对。
4. actor=user + 小幅编辑 → EditedMinor 正常入选（新闸门不误伤真用户）。
5. critic 修订后用户再编辑（provenance 最终 actor=user 但历史含 llm_critic，
   或 marker 仍在）→ 保守排除。
6. `sanitize_plan_for_disabled_qa_pass` 剥 `_qa_flags` 但**保留**
   `_content_provenance`（7077075a 语义切分回归）。
7. `GoldCandidate` 旧 JSON（无 `edit_actor` 字段）反序列化成功且默认 None。
8. APKG 导出：含 `_original_generation`/`_qa_flags`/`_content_provenance` 的卡，
   导出 model 字段表与 `notes.flds` 中均不出现这些键值（若本轮做泄漏收口）。
9. 既有测试保持绿：`gold_references_exclude_critic_revised_cards`、
   `critic_revised_content_is_never_mined_as_user_gold`、
   `gold_references_exclude_current_task_and_error_cards`。
