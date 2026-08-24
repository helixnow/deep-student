# 制卡质量 eval harness 使用说明

坏输出回放基线：用 28 个固化 fixture（22 坏 + 6 好）回放流式制卡解析管线的
真实风格失败样本，度量解析成功率、错误卡率与 lint 命中率，并作为
Structured Output / 确定性 lint 模块落地时的回归护栏。

## 怎么跑

### 方式一：vitest（CI 路径，已接入默认测试集）

```bash
npx vitest run tests/vitest/anki/eval/evalHarness.test.ts
```

测试文件匹配 `vitest.config.ts` 的 `tests/vitest/**/*.test.ts` 通配，
`npm test` / CI 分片会自动带上，无需额外注册。

### 方式二：CLI 指标报告（本地分析 / CI 工件）

```bash
node scripts/anki-eval/run-eval.mjs          # 人读表格
node scripts/anki-eval/run-eval.mjs --json   # JSON（供归档与趋势对比）
```

退出码 `0` = 全部 fixture 符合 `manifest.json` 固化的预期；`1` = 存在偏离。

## 目录结构

```
tests/fixtures/anki-eval/
  manifest.json          # fixture 清单 + 每个样本的预期结局（回归基线的唯一事实来源）
  cases/*.txt            # 22 个坏输出样本（模型原始流文本）
  good/*.txt             # 6 个好卡对照样本（防 lint 误伤）
scripts/anki-eval/
  lib/replayParser.mjs   # 生产切卡器/清洗器的测试侧最小复刻（标注 drift 风险）
  lib/cardLint.mjs       # 确定性 lint 原型（6 个规则码）
  lib/harness.mjs        # 加载/回放/比对/指标（vitest 与 CLI 共用）
  run-eval.mjs           # CLI 入口
tests/vitest/anki/eval/
  evalHarness.test.ts    # CI 回归测试
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

当前基线（2026-08-24，manifest 固化）：

| 集合 | 段数 | parse_success_rate | error_card_rate | lint_flag_rate |
|---|---|---|---|---|
| bad（22 例） | 28 | 75.0% | 25.0% | 28.6% |
| good（6 例） | 8 | 100% | 0% | 0% |

## lint 规则码

`EMPTY_FIELD`、`EMPTY_CLOZE`、`ANSWER_LEAK`、`FILLER_PHRASE`、
`FENCE_IN_FIELD`、`PLACEHOLDER_TEXT`（定义见 `scripts/anki-eval/lib/cardLint.mjs`）。
好卡对照集要求全部规则零误报，任何 lint 规则改动必须保持 good 集全绿。

## 与生产代码的关系（drift 风险）

生产解析器是 Rust 私有函数（`streaming_anki_service.rs` 的
`extract_card_from_buffer_impl` / `clean_json_string`），测试侧按行为逐条复刻于
`replayParser.mjs`。生产侧同场景已有内联 Rust 单测锚定；**修改任一侧时必须
检查另一侧**。若未来把切卡器抽成可独立引用的 crate/npm 包或暴露 pub(crate)
测试入口，应删除复刻改为直调。

## 后续模块如何把 fixture 当回归

1. **Structured Output 落地时**：约束解码理论上消灭全部 JSON 语法级失败。
   将新输出路径接入 harness（新增 `entry: "structured"` 或直接替换切卡层），
   预期翻转方向只允许 `error_card → parse_ok`（在 manifest 中更新预期并在
   PR 中列出翻转清单）；任何 `parse_ok → error_card` 翻转即回归，CI 拒绝。
2. **生产 lint 模块落地时**：以 `cardLint.mjs` 的 6 个规则码为验收下限——
   对 22 个坏样本至少命中相同的码，对 6 个好样本零命中。生产实现（Rust 或 TS）
   应直接消费 `tests/fixtures/anki-eval/` 下的同一批 `.txt`，避免双份夹具。
3. **新失败样本入库**：线上遇到新的坏输出时，脱敏后追加
   `cases/NN-<category>.txt` + manifest 条目（预期按当前管线实际行为固化），
   基线即自动扩展。
