# Round 3 #9：制卡质量 eval harness + 坏输出回放基线

> 2026-08-24 · 子代理 #9 · 只新增测试/夹具/脚本/文档，零生产逻辑改动

## 交付物

| 文件 | 内容 |
|---|---|
| `tests/fixtures/anki-eval/manifest.json` | 28 个 fixture 的清单 + 预期结局（基线唯一事实来源） |
| `tests/fixtures/anki-eval/cases/*.txt` | 22 个真实风格失败样本 |
| `tests/fixtures/anki-eval/good/*.txt` | 6 个好卡对照样本（防 lint 误伤） |
| `scripts/anki-eval/lib/replayParser.mjs` | 生产切卡器/清洗器测试侧复刻（drift 风险已标注） |
| `scripts/anki-eval/lib/cardLint.mjs` | 确定性 lint 原型（6 规则码） |
| `scripts/anki-eval/lib/harness.mjs` | 回放/比对/指标核心（vitest 与 CLI 共用） |
| `scripts/anki-eval/run-eval.mjs` | CLI 指标报告（`--json` 可归档） |
| `tests/vitest/anki/eval/evalHarness.test.ts` | CI 回归测试（12 用例，全绿） |
| `docs/research/anki-ai-native/eval/README.md` | 运行说明 + 回归接入方式 |
| `docs/research/anki-ai-native/eval/gold-set-plan.md` | 金标集从用户编辑记录挖掘的方案 |

## fixture 覆盖矩阵（22 坏 + 6 好）

| 类别 | fixture | 预期结局 |
|---|---|---|
| 缺分隔符 | 01 | 3× parse_ok（brace-depth 主信号兜住） |
| 粘连 JSON | 02 | 2× parse_ok |
| 尾逗号 | 03 | error_card |
| markdown fence（direct 入口） | 04 | repair_ok（clean_json_string 剥围栏） |
| markdown fence（流式） | 05 | parse_ok + **error_card**（闭合围栏残段成垃圾错误卡，见发现 2） |
| 损坏分隔符（空格注入） | 06 | 2× parse_ok |
| 损坏分隔符 + 括号不配平 | 07 | error_card |
| START/END 混用（幻觉标记） | 08 | 2× parse_ok（START 作前缀噪声丢弃） |
| 分隔符文本在字符串内 | 09 | parse_ok，文本原样保留（含内容断言） |
| 中英混杂客套话 | 10 | 2× parse_ok + 收尾客套话丢弃 |
| 流中截断（chunkSize=1 压测） | 11 | parse_ok + error_card |
| 单引号 JSON | 12 | error_card |
| 非法转义（Windows 路径） | 13 | error_card |
| 二次 JSON 编码 | 14 | error_card（解析为字符串非对象） |
| 空 cloze | 15 | parse_ok + `EMPTY_CLOZE` |
| 答案泄露 | 16 | parse_ok + `ANSWER_LEAK` |
| 空 back 字段 | 17 | parse_ok + `EMPTY_FIELD` |
| 客套话入字段 | 18 | parse_ok + `FILLER_PHRASE` |
| 纯拒答文本 | 19 | 0 卡、0 错误卡（不得误产错误卡） |
| 空分隔符连发 | 20 | 0 卡（空段静默消费） |
| 字段内混围栏 | 21 | parse_ok + `FENCE_IN_FIELD` |
| 占位符 TODO | 22 | parse_ok + `PLACEHOLDER_TEXT` |
| 好卡对照 ×6 | g01–g06 | 全部 parse_ok、零 lint（cloze/双语/短 token 重叠/内联代码防误伤） |

## 基线指标（2026-08-24 固化）

| 集合 | 段数 | parse_ok | repair_ok | error_card | parse_success_rate | error_card_rate | lint_flag_rate |
|---|---|---|---|---|---|---|---|
| bad | 28 | 20 | 1 | 7 | **75.0%** | **25.0%** | **28.6%** |
| good | 8 | 8 | 0 | 0 | 100% | 0% | 0% |
| all | 36 | 28 | 1 | 7 | 80.6% | 19.4% | 20.7% |

## 关键发现

1. **brace-depth 切卡器吸收了几乎全部"框架级"失败**：缺分隔符、粘连、
   START/END 混用、损坏分隔符、字符串内分隔符文本——这些历史高发故障在
   当前管线下全部 parse_ok。剩余的 7 张错误卡全部是 **JSON 语法级** 失败
   （尾逗号/单引号/非法转义/二次编码/截断），恰好是 Structured Output
   （约束解码）能在源头消灭的类别。这为路线图上 Structured Output 的
   预期收益给出量化锚点：坏样本集 error_card_rate 25% → 理论 ~0%。
2. **管线疣（fixture 05 固化）**：流式路径下卡片被 ```json 围栏包裹时，
   切卡器能切出纯 JSON（parse_ok），但闭合围栏 "```" 残留在缓冲中，被
   下一个分隔符切成垃圾段并降级为一张错误卡。用户会看到一张正常卡 +
   一张莫名的错误卡。修复方向：分隔符切分出的段在判定失败前先剥围栏
   噪声（或 Structured Output 后整体消失）。本轮不改生产逻辑，仅以
   fixture 固化现状，修复时该预期应翻转为 `parse_ok`（无第二段）。
3. **lint 空白**：6 类内容级劣质卡（空 cloze、答案泄露、空字段、客套话、
   围栏入字段、占位符）当前全部顺利入库且无任何标记——生产 `_qa_flags`
   只覆盖模板字段规则（长度/枚举/正则），不做内容语义检查。lint 原型的
   6 个规则码在 22 个坏样本上命中 6 张、在 6 张好卡上零误报，可作为
   生产 lint 模块的验收下限。

## 回归接入约定（对后续子代理/模块）

- **Structured Output**：新解码路径必须重放本 harness；manifest 预期只允许
  `error_card → parse_ok` 方向翻转，翻转清单须在 PR 描述中列出。
- **生产 lint 模块**：直接消费 `tests/fixtures/anki-eval/*.txt` 同一批夹具；
  坏样本命中不得少于现有码，好卡对照必须保持零命中。
- **解析器复刻的 drift 控制**：`replayParser.mjs` 头部列出了对应的 Rust
  函数与行为条目；生产切卡逻辑变更时，同 PR 内必须同步复刻并重放
  （CI 上 fixture 偏离会直接红）。
- **新样本回流**：线上新坏输出脱敏后追加 `cases/NN-<category>.txt` +
  manifest 条目即可扩展基线；金标集扩容路径见 `eval/gold-set-plan.md`。

## 运行方式

```bash
npx vitest run tests/vitest/anki/eval/evalHarness.test.ts   # CI 路径
node scripts/anki-eval/run-eval.mjs                          # 指标报告
```
