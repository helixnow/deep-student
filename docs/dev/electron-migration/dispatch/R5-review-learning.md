# R5-review-learning：独立复核（B 级交叉审读）

你是**独立验收人**，全新上下文，不是实现者。目标：对下列已完成（或接近完成）的 lane 做 B 级静态验证，判断"TS 实现与 Rust 原实现是否严格等价、测试是否真实、架构是否干净"。规范见 `docs/dev/electron-migration/README.md` §5.3–§5.4 与 `quality.md`。

| 被验收 lane | 插件目录 | 结论写到 |
|---|---|---|
| L14-qbank | `host/plugins/qbank/` | `host/plugins/qbank/ACCEPTANCE.md` |
| L15-review-analytics | `host/plugins/review/` | `host/plugins/review/ACCEPTANCE.md` |
| L16-anki | `host/plugins/anki/` | `host/plugins/anki/ACCEPTANCE.md` |
| L24-chatanki | `host/plugins/chatanki/` | `host/plugins/chatanki/ACCEPTANCE.md` |

## 硬性规则
- **只读实现**：不得修改任何实现、测试、SPEC、TESTMAP。你唯一能写的是上表"结论写到"的文件和 `docs/dev/electron-migration/audits/R5-review-learning.md`。
- **只信证据**：依据是契约（`contracts/ipc/`）、Rust 源码（`src-tauri/`，只读，**不要编译或运行 Rust**）、TS 实现、TESTMAP 与你亲自跑的测试结果。不要采信实现者在 LANE/SPEC/报告里的自述——要自己核对。
- 被验收目录下若已有 `ACCEPTANCE.md`，那是实现者自写的，**不算数**：在其基础上重写为你的独立结论（保留其中你核实为正确的条目，标注"复核确认"）。

## 每个被验收 lane 的审读清单（逐项给结论：通过 / 问题 + 证据 文件:行）
1. **命令等价**：抽查不少于 15 条命令（优先复杂、有分支、有事务、有错误映射的），逐条对照 Rust `#[tauri::command]` 实现：参数默认值、校验顺序、错误类型与文案、事务边界、日志（warn!/error! 是否保留）、返回形状（含 null/undefined、数字精度、时间格式）。
2. **测试真实性**：抽查不少于 15 条 TESTMAP 标 ported 的测试：TS 测试是否真的断言了 Rust 测试的同一行为（不是改弱、不是只测替身）；被测模块是否从插件 `index.ts` 可达（`node scripts/electron-migration/wiring.mjs --lane <dir>`）。obsolete/merged 是否有协调者批准（`migration/approvals.json`）。
3. **亲自运行**：`npx vitest run -c vitest.host.config.ts host/plugins/<dir>` 与 `node scripts/electron-migration/importable.mjs host/plugins/<dir>/index.ts`，贴原始输出摘要。
4. **架构**：只经对方 `api.ts` 跨插件；表的写操作只在表所有者；服务命名符合 `docs/plugins/ARCHITECTURE.md`；没有静默吞错、没有 console、没有测试替身进生产；没有"相似替代"（换算法、换库语义、省略分支）。
5. **语义差异清单**：列出你发现的所有与 Rust 不一致之处，区分"缺陷（应修）"与"已登记的平台差异（SPEC/decisions 有记录）"。

## ACCEPTANCE.md 格式
```
# <lane> 独立验收（R5-review-learning，<日期>）
结论：通过 / 有条件通过 / 不通过
## 必须修复
- [ ] <问题>（证据：文件:行；Rust 对照：文件:行）
## 建议
- [ ] ...
## 已核实通过
- [x] <抽查项>（证据）
```
未勾选的"必须修复"会使该 lane 的 B 级不成立，协调者会把它们派回原 lane；修复后由你复核勾选。

## 完成协议
全部被验收 lane 写完后：在 `audits/R5-review-learning.md` 汇总（每个 lane 的结论、问题数、最严重的 3 个问题），提交（只提交你允许的文件），最后回复里贴出汇总表。发现**共性问题**（多个 lane 都犯的）单独列一节——协调者会把它写成规范回灌全部 lane。
