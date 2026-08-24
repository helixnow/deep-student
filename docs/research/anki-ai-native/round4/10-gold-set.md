# Round 4 #10：金标挖掘实现 + eval harness 升级到复用 Rust lint 契约

> 交付日期：2026-08-24。前置：Round 3 #3（anki_qa_lint）、Round 3 #9
> （eval harness）、`eval/gold-set-plan.md`（方案设计）。
> chatanki 管线主路径零改动。

## 交付物

### 1. 金标挖掘纯函数：`src-tauri/src/anki_gold_set.rs`（新建，已注册 lib.rs）

gold-set-plan §3 label/export 步骤的实现，「改前=劣化、改后=金标」抽取：

| API | 作用 |
|---|---|
| `extract_original_generation` | 从 `extra_fields_json` 解出 `_original_generation` 快照（兼容对象/二次编码字符串两种落库形态） |
| `classify_candidate` / `mine_gold_set` | 六标签决策树：kept_unedited（强正例）/ edited_minor（弱正例+修正对）/ edited_major（强负例+修正对）/ deleted_early（负例）/ error_card_repaired（解析失败样本+人工修复答案）/ unlabeled（附原因） |
| `edit_distance` / `edit_ratio` | 字符级 Levenshtein（滚动数组，Unicode 标量计数），距离比阈值 0.25 分小改/重写 |
| `lint_repair_pair` | 用**生产 lint 引擎**（`anki_qa_lint::lint_card`）校验修正对契约：original 命中（Warn+）、edited 零命中、两端全净=lint 盲区（新规则素材） |
| `scrub_pii` / `to_fixture_json` | plan §4 脱敏（邮箱/手机号/证件号样式）+ fixture 导出整形 |
| `fixture_export_bucket` | 标签 → `gold/positive` / `gold/repair-pairs` / `gold/negative` 目录路由 |
| `LINT_CONTRACT_CODES` | anki_qa_lint 全部 26 个稳定 code 的跨语言契约清单（唯一事实来源） |

刻意不做：不读 SQLite、不写文件、不接管线。数据拼装（`anki_cards` +
FSRS 日志 → `GoldCandidate`）与 `_original_generation` 写入埋点留给后续轮
（plan §6 P0 剩余项）。

Rust 测试 21 个，含两类跨边界守护：

- `lint_contract_codes_match_anki_qa_lint_source`：正则扫描 anki_qa_lint.rs
  源码提取实际产出的 code 集合，断言与契约清单**集合相等**（本轮开发期间
  已实际拦截到并行代理把 `duplicate_card` 改名为
  `duplicate_in_document`/`near_duplicate` 的漂移）；
- `repo_repair_pair_fixtures_satisfy_lint_contract`：直接消费
  `tests/fixtures/anki-eval/gold/repair-pairs/*.json`，用生产 lint 复检
  每对 original 命中 / edited 零命中。

### 2. eval harness 升级：lint 码复用 Rust 契约

`scripts/anki-eval/lib/cardLint.mjs` 重写：

- 废弃自造 UPPER_SNAKE 原型码（EMPTY_FIELD / EMPTY_CLOZE / ANSWER_LEAK…），
  改为与 Rust `LintIssue.code` **逐字节一致**的 snake_case 码；
- 移植 Rust 内容级规则 14 条（含 `strip_html` / `normalize_for_compare` /
  `scan_cloze` 的逐条移植，阈值同 `LintConfig::default()`：answer_leak
  最小 4 字符、front 上限 220 字符）；
- 三类码显式分层：Rust-aligned（14）/ Rust-only（12，依赖模板/文档/DB
  上下文不复刻）/ eval-only（3，流式回放特有）；
- 新增 `lintCardIssues` 返回 `{code, field}` 结构化条目（形状对齐
  Rust `LintIssue`），`lintCard` 保持排序码数组的既有断言口径。

三方一致性锁（`tests/vitest/anki/eval/lintContract.test.ts` ×5 断言 +
Rust 侧测试）：

```
anki_qa_lint.rs 实际产出 == LINT_CONTRACT_CODES ⊇ JS RUST_ALIGNED_CODES
JS EVAL_ONLY_CODES ∩ LINT_CONTRACT_CODES == ∅
eval/README.md 对照表覆盖全部 26+3 个码（文档漂移即测试红）
```

### 3. 金标修正对回归（plan §5.2 落地）

`tests/fixtures/anki-eval/gold/repair-pairs/`：5 对
（answer_leak / empty_cloze / todo_placeholder / front_back_identical /
error_card_repaired），每对 `{original, edited, expected}`。

消费方三个：`goldPairs.test.ts`（vitest，盲区按失败暴露）、
`run-eval.mjs`（CLI 新增修正对段与 JSON 输出）、Rust fixture 复检测试。

### 4. fixture 扩容（+10，含 critic/lint 边界）

坏样本 22→30、好卡 6→8：

| id | 类别 | 边界点 |
|---|---|---|
| 23-front-back-identical | front_back_identical | answer_leak 在 f==b 时让位不双报 |
| 24-unclosed-cloze | cloze_broken | 含 `{{c` 的 text 同时豁免空字段规则 |
| 25-cloze-bad-index | cloze_broken | c0 非法序号 |
| 26-multi-concept | multi_concept | **critic/lint 边界**：双问号归确定性 lint，隐蔽一卡多事实归 llm_critic |
| 27-front-too-long | front_too_long | 238 字 > 220 阈值 |
| 28-placeholder-residue | placeholder_residue | 大写占位符命中但不误伤 `{{cN::}}` |
| 29-cloze-missing-text | cloze_broken | cloze 卡 Text 无挖空 |
| 30-lint-blind-spot | lint_blind_spot | **critic/lint 边界**：事实性错误 lint 必然零命中，固化 lint 能力上限（归 anki_critic 裁决域） |
| g07-cloze-syntax-in-qa-front | good_control | 讲 cloze 语法的卡不被 cloze_*/placeholder 误伤 |
| g08-english-and-single-question | good_control | 英文单问句 "TCP and UDP" 不触发 multi_concept |

新基线（manifest 固化）：bad 30 例 36 段，parse 80.6% / error 19.4% /
lint 44.8%；good 8 例 10 段全绿零误伤。

### 5. 文档

- `eval/README.md`：三种跑法（vitest / CLI / cargo）、26+3 码完整对照表
  （测试防漂移）、修正对新增流程；
- `eval/gold-set-plan.md`：状态更新为部分已实现，逐条标注 ✅/⬜。

## 与并行子代理的边界

- 依赖 `anki_qa_lint.rs`（Round 3 #3，本轮 #3 续作改动过 duplicate 码）——
  只读消费，契约测试自动跟踪其漂移；
- `cases/30` 与 `26` 的 description 引用 `anki_critic`（Round 4 #2）的
  `llm_critic` 裁决域，仅文档层引用无代码耦合；
- chatanki 管线主路径（chatanki_executor / streaming_anki_service 等）
  未动一行。

## 已知残留

- `_original_generation` 写入埋点未接：挖掘函数可用但生产数据源还没有
  编辑前原文（plan §6 P0 剩余项，需改生成管线，超出本任务禁改范围）；
- 分层抽样器（plan §3 sample 步骤）与离线挖掘 CLI 未实现；
- eval 侧 `placeholder_text`（整字段占位）与 Rust `todo_residue` 语义部分
  重叠（fixture 22 / rp03 两码并报），若 Rust 侧未来吸收整字段占位规则，
  应并码并更新契约清单。
