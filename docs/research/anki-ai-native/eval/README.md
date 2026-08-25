# 制卡质量 eval harness 使用说明

坏输出回放基线：用固化 fixture（33 坏 + 11 好 + 5 金标修正对）回放流式制卡
解析管线的真实风格失败样本，度量解析成功率、错误卡率与 lint 命中率，并作为
Structured Output / lint 规则变更 / 金标挖掘的回归护栏。

Round 4 #10 起，eval lint 码**复用 Rust 生产 lint 模块
`src-tauri/src/anki_qa_lint.rs` 的 code 字符串契约**（见下方对照表），
金标修正对回归（改前=劣化、改后=金标）同时由 JS 与 Rust 两侧消费。

Round 5 #10 起，Rust 侧全部稳定 code 以具名常量导出于
`anki_qa_lint::codes`（含 `codes::ALL` 枚举出口），JS 侧
`cardLint.mjs` 的 `RUST_ALIGNED_CODES` / `RUST_ONLY_CODES` 两张分区表与之满足
**「键名 == Rust 常量名、值 == Rust 常量值」的双重逐字节对齐**，且二者并集
恰好等于 `codes::ALL`（无交集、无遗漏）——Rust 新增 lint 码而未在 JS 侧归类
（复刻或声明为 Rust-only）时，`lintContract.test.ts` 即红。同轮还对齐了两处
实现级边界：answer_leak 最小长度按 Unicode 码点计（对齐 Rust
`chars().count()`）、cloze 序号超出 u32 范围判 `cloze_bad_index`（对齐
`digits.parse::<u32>()` 溢出语义）。

## 怎么跑

### 方式一：vitest（CI 路径，已接入默认测试集）

```bash
npx vitest run tests/vitest/anki/eval/                       # 全部三个套件
npx vitest run tests/vitest/anki/eval/evalHarness.test.ts    # 回放基线
npx vitest run tests/vitest/anki/eval/lintContract.test.ts   # 跨语言 lint 契约锁
npx vitest run tests/vitest/anki/eval/goldPairs.test.ts      # 金标修正对回归
```

测试文件匹配 `vitest.config.ts` 的 `tests/vitest/**/*.test.ts` 通配，
`npm test` / CI 分片会自动带上，无需额外注册。

### 方式二：CLI 指标报告（本地分析 / CI 工件）

```bash
node scripts/anki-eval/run-eval.mjs          # 人读表格（含金标修正对段）
node scripts/anki-eval/run-eval.mjs --json   # JSON（供归档与趋势对比）
```

退出码 `0` = 全部 fixture 与修正对符合预期；`1` = 存在偏离。

### 方式三：Rust 侧（金标挖掘纯函数 + 契约守护 + 修正对复检）

```bash
cd src-tauri && cargo test --lib anki_gold_set
cd src-tauri && cargo test --lib anki_qa_lint::tests::codes_module
```

其中 `repo_repair_pair_fixtures_satisfy_lint_contract` 用**生产 lint 引擎**
（`anki_qa_lint::lint_card`）复检 `gold/repair-pairs/*.json`，与 vitest 的
goldPairs 套件互为校验；`lint_contract_codes_match_anki_qa_lint_source`
守护契约清单与 lint 源码不漂移；`anki_qa_lint` 的三个 `codes_module_*`
测试守护 `codes` 常量模块与实际产出字面量、契约清单三方相等且
`codes::ALL` 无重复无遗漏。

## 目录结构

```
tests/fixtures/anki-eval/
  manifest.json          # fixture 清单 + 每个样本的预期结局（回归基线的唯一事实来源）
  cases/*.txt            # 33 个坏输出样本（模型原始流文本，含 lint/critic 边界样本）
  good/*.txt             # 11 个好卡对照样本（防 lint 误伤）
  gold/repair-pairs/*.json  # 金标修正对（改前=劣化、改后=金标，JS/Rust 双侧消费）
scripts/anki-eval/
  lib/replayParser.mjs   # 生产切卡器/清洗器的测试侧最小复刻（标注 drift 风险）
  lib/cardLint.mjs       # 确定性 lint（Rust anki_qa_lint 契约对齐版 + 三张分区表）
  lib/harness.mjs        # 加载/回放/比对/指标/金标修正对（vitest 与 CLI 共用）
  run-eval.mjs           # CLI 入口
tests/vitest/anki/eval/
  evalHarness.test.ts    # 回放基线回归 + lint 边界单测
  lintContract.test.ts   # 跨语言 lint 码契约锁（含本 README 对照表防漂移）
  goldPairs.test.ts      # 金标修正对回归
src-tauri/src/
  anki_qa_lint.rs        # 生产 lint 引擎 + codes 稳定常量导出（code 的定义方）
  anki_gold_set.rs       # 金标挖掘纯函数 + LINT_CONTRACT_CODES 契约清单
```

## 结局分类（outcome）

| outcome | 含义 | 生产对应 |
|---|---|---|
| `parse_ok` | 切出的片段本身就是合法 JSON 对象 | `parse_and_save_card` 一次成功 |
| `repair_ok` | 原文解析失败，经 `clean_json_string`（剥围栏/BOM/截取对象）修复后成功 | 清洗层挽救 |
| `error_card` | 清洗后仍解析失败，降级为错误卡（`is_error_card=1`）入库 | 错误卡链路 |
| （dropped_prose） | 收尾纯自然语言残留，直接丢弃不产生错误卡 | E1 收尾逻辑 |

## 指标草表口径

- `parse_success_rate` = (parse_ok + repair_ok) / 卡片段总数
- `error_card_rate` = error_card / 卡片段总数
- `lint_flag_rate` = 命中 ≥1 个 lint 码的解析成功卡 / 解析成功卡总数

当前基线（2026-08-24，manifest 固化，Round 5 #10 扩容后）：

| 集合 | 段数 | parse_success_rate | error_card_rate | lint_flag_rate |
|---|---|---|---|---|
| bad（33 例） | 39 | 82.1% | 17.9% | 50.0% |
| good（11 例） | 13 | 100% | 0% | 0% |

## lint 码对照表（eval ↔ Rust anki_qa_lint 契约）

Rust 侧锚点为 `anki_qa_lint::codes` 具名常量模块（Round 5 #10），契约清单
固化于 `src-tauri/src/anki_gold_set.rs` 的 `LINT_CONTRACT_CODES`。一致性由
`lintContract.test.ts`（JS 侧：常量↔契约↔产出三方相等、分区表键名+值双对齐、
分区并集 == `codes::ALL`）与 Rust 侧的 `codes_module_*` /
`lint_contract_codes_match_anki_qa_lint_source` 测试双向锁定，
**本对照表由测试断言防漂移**（每个码必须以反引号形式出现在本文件中）。

### 双侧实现（eval 复刻 Rust 规则，常量名与 code 值均逐字节一致）

| code | 语义 | Rust 严重度 |
|---|---|---|
| `empty_front` | front 为空或纯空白（cloze 卡豁免） | Error |
| `empty_back` | back 为空或纯空白（cloze 卡豁免） | Error |
| `front_back_identical` | 正反面归一化后完全相同 | Error |
| `cloze_unclosed` | cloze 挖空缺少配对的 `}}` | Error |
| `cloze_empty_answer` | 空挖空 `{{c1::}}` | Error |
| `cloze_bad_index` | cloze 序号非法（必须 c1 起） | Error |
| `cloze_missing` | Text 字段存在但无任何挖空 | Warn |
| `answer_leak` | front 含 back 完整答案（归一化 ≥4 字符） | Warn |
| `multi_concept` | 一卡多问启发式（双问号/分别+并列/英文双疑问词） | Warn |
| `front_too_long` | front 可见字符 >220（最小信息原则） | Warn |
| `placeholder_residue` | `{{UPPER_SNAKE}}` 模板占位符残留 | Error |
| `todo_residue` | TODO / FIXME 标记残留 | Warn |
| `xxx_residue` | 独立占位 token "xxx" | Warn |
| `empty_brackets` | 空括号对 `【】` `（）` `()` | Warn |

### Rust-only（依赖模板/文档/DB 上下文，回放单卡 JSON 无法复刻）

以下码在 JS 侧以 `RUST_ONLY_CODES` 显式声明（含逐条原因注释）而不实现——
Rust 新增码必须先在 ALIGNED / RUST_ONLY 两表之一归类，契约测试才会放行。

| code | 语义 | 不复刻原因 |
|---|---|---|
| `tags_empty` | 无标签（Info） | 回放夹具不约定 tags，全量误报 |
| `duplicate_in_document` | 同文档归一化 front 精确重复 | 需跨卡 FingerprintTracker 状态 |
| `near_duplicate` | 同文档近重复（bigram Jaccard） | 同上 |
| `mixed_language` | 中英大量混杂（Info，低置信） | Info 级提示，不参与基线断言 |
| `mcq_too_few_options` | 选择题非空选项 <2 | 需选择题模板上下文 |
| `mcq_answer_not_in_options` | 答案不在选项中 | 同上 |
| `mcq_missing_answer` | 缺答案字段 | 同上 |
| `field_rule_min_length` | 字段最小长度规则 | 需模板 FieldExtractionRule |
| `field_rule_max_length` | 字段最大长度规则 | 同上 |
| `field_rule_allowed_values` | 字段允许值规则 | 同上 |
| `field_rule_pattern` | 字段正则规则 | 同上 |
| `legacy_flags_unparsed` | 既有 `_qa_flags` 值非法时的包装条目 | merge_flags 内部机制 |

### eval-only（Rust 无对应规则；snake_case 命名且不得与契约撞名）

| code | 语义 |
|---|---|
| `filler_phrase` | 模型客套话泄漏进字段正文 |
| `fence_in_field` | 字段值内混入 markdown 代码围栏 |
| `placeholder_text` | 字段值整体为占位符（TODO/待补充/略…） |

好卡对照集要求全部规则零误报，任何 lint 规则改动必须保持 good 集全绿。

## 金标修正对（gold/repair-pairs）

`gold-set-plan.md` §5.2 的落地：每个 `*.json` 携带
`{original, edited, expected}`，契约为 **original 至少命中 1 个 lint 码
（改前=劣化）、edited 零命中（改后=金标）**。两端都不命中 = lint 盲区，
测试按失败暴露（新规则的第一素材来源）。

新增修正对的方式：

1. 从真实编辑记录挖掘（`anki_gold_set::classify_candidate` 产出
   `EditedMinor` / `EditedMajor` / `ErrorCardRepaired` 样本后经
   `to_fixture_json` 导出，内置 PII 脱敏）；入仓前须做风格等价改写 + 人审
   （plan §4 隐私硬约束）；
2. 手工构造已知失败模式（当前 5 对即此来源，`source:
   "synthetic-style-rewrite"`）。

## 与生产代码的关系（drift 风险）

生产解析器是 Rust 私有函数（`streaming_anki_service.rs` 的
`extract_card_from_buffer_impl` / `clean_json_string`），测试侧按行为逐条复刻于
`replayParser.mjs`。生产侧同场景已有内联 Rust 单测锚定；**修改任一侧时必须
检查另一侧**。

lint 侧的 drift 已由契约锁自动化：改 `anki_qa_lint.rs` 的码而不同步
`codes` 常量模块或 `LINT_CONTRACT_CODES` → Rust 测试红；不同步
`cardLint.mjs` 的分区表或本对照表 → vitest 红。实现级阈值语义
（answer_leak 码点计数、cloze 序号 u32 界、front_too_long 严格大于阈值）
由 g09/g11/33 号等边界 fixture 与 evalHarness 单测双重锚定。

## 后续模块如何把 fixture 当回归

1. **Structured Output 落地时**：约束解码理论上消灭全部 JSON 语法级失败。
   将新输出路径接入 harness（新增 `entry: "structured"` 或直接替换切卡层），
   预期翻转方向只允许 `error_card → parse_ok`（在 manifest 中更新预期并在
   PR 中列出翻转清单）；任何 `parse_ok → error_card` 翻转即回归，CI 拒绝。
2. **lint 规则变更时**：新增码需同步 `anki_qa_lint::codes` 常量 +
   `LINT_CONTRACT_CODES` + `cardLint.mjs` 分区表（复刻进
   `RUST_ALIGNED_CODES` 或声明进 `RUST_ONLY_CODES`）+ 本对照表；
   若 eval 侧可复刻则实现规则并补 bad/good 边界 fixture 对
   （参考 31↔g10、32、33、g09、g11）。
3. **新失败样本入库**：线上遇到新的坏输出时，脱敏后追加
   `cases/NN-<category>.txt` + manifest 条目（预期按当前管线实际行为固化），
   基线即自动扩展。
4. **critic/lint 边界**：确定性 lint 测不出的卡（如事实性错误）用
   `lint_blind_spot` 类别固化（见 `cases/30-lint-blind-spot.txt`），
   显式标记其归属 `anki_critic`（`llm_critic`）裁决域。
