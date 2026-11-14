# X6-gate-checks

## 状态：已完成（当前已授权执行项）

五项机械检测器、单项账本 A 否决、裁定数据与已要求的报告刷新已完成。2026-11-05 本轮自动续派先合并 main `fb463060d`，新合并提交 `b3b79f302` 的 lane-gate（typecheck、boundaries，经作业队列）全部通过。相较上次已绿提交 `e9a6abb9d`，X6 检测器、账本授权规则及共享 gate 列表没有代码变动；本轮没有新增待修的 X6 集成失败反馈。

本目录是 X6 允许路径；业务 lane 的 pending 测试/命令并非 X6 待实现项，不跨 lane 修改，不唤醒 parked owner。

## 已完成与证据

- prod-reachable 逐 case body、标识符边界和跨 api 生产可达归因保留；obsolete/pending 排除。账本只否决精确 unreachable 行，unknown 不降级、commands 不变。固定 main `8d7b05d14` 差分作业 `20261104143146-dcf5d8` exit 0：仅 25 行 A→非 A，3631 unknown 与 1058 commands 不变；报告/原 Rust ID 已交 C1/C2。
- AP0425 保留原 Rust cfg/ignore，不把 Docker 未执行记 pass；定点回归 `20261104145222-d45277` 5/5、exit 0。AP/LP 继续 report-only，计数不代替逐断言/逐日志语义签收。
- C2 的陈旧 records.ts 批准已按授权删除，五条 C1 例外未动；`20261104150112-99e803` exit 0：例外测试 7/7、账本 11/11，旧断言重引入会检出。
- temp_sessions 单表 owner 已从 chat 改为 integration/L22（`6002c7fbd`），其余裁定/命名空间不变。映射作业 `20261104151702-78a880` exit 0：L22 候选真实写入 0 foreign，相同 chat/media 写入各 1 blocking foreign。
- 仅 single-writer 按追加授权刷新一次（`1c8239f67`，作业 `20261104153042-ad53c2` exit 0）：固定源码 main `4525e11ac`、规则 `6002c7fbd`，114 blocking foreign、50 report-only foreign、111 duplicate info、unknown 6。精确 SHA 与按 lane 计数在同一 `reports/single-writer.json`；旧 202 不代表新存量，历史编号基准 `011914371` 不重排。PR/AP 仍固定 `8d7b05d14`，不因本轮合并重扫。

## v2 §1 八类自查（本轮源码审读，未新增全仓扫描）

1. **生产接线：** 审读 `prod-reachable.mjs`、`reachability-graph.mjs`、`ledger.mjs` 调用链；不是用重导出或测试 harness 充当生产入口，非整文件 testIds 归因。L10 mfjs 原 test-only 登记仍待架构师裁定，不自豁免。
2. **单一所有者：** 审读 `owner-rulings.json` 与现有 single-writer 裁定优先级；temp_sessions 纠偏只影响该表，F3 schema 不倒推业务 owner，无新增全局豁免。
3. **数据边界：** 审读精确例外加载/应用逻辑，仍绑定 path/function/rule/expression/sites；不借工具配置批准声称业务 decoder 与 serde 全等价。
4. **日志与错误：** 审读 ledger reachNote 与 CLI 错误路径：分析失败明确报告且不否决；log-parity 仍仅报告，不冒充业务日志已补齐。
5. **测试真实性：** 对照既有逐 case、同前缀标题、精确例外重引入回归及账本差分证据；未弱化断言、未给 Docker 测试伪记 pass，未把静态 expect 数当语义验收。
6. **完整性：** 审读 AP 的 Rust 函数定位、attributes 与 unknown 分支；cfg/ignore 证据保留，无法解析/匹配不借相邻测试补证。
7. **运行时语义：** 检测器为离线 CLI，不在 Host 注册同步扫描；重命令走 jobs。未新增业务数据库写入、生产进程操作、后台常驻任务或依赖。
8. **闭环：** 修正提交、作业、固定基线与协调回执均有记录；“已完成”限 X6 当前授权任务，不代表存量 findings 清零、业务 owner 已签收或所有改动已进入 main。

本轮审读未发现需要修复的新增 X6 代码缺陷，故不为续派制造算法改动或重复已绿测试/全仓扫描。

2026-11-05 续派按上述八类做增量复核：结合 X6 代码无变动的差异检查，重核 L24 四个原 ID 仍 ported、共享 gate 尚无 SW/UD 接入，均未形成已解除的本 lane 阻塞。既有定点回归证据继续沿用“已完成与证据”各作业，不将旧固定报告计数称为新 main 存量；不修改评分规则、业务 TESTMAP 或历史报告，不补假接线，不新增或重跑全量测试。已完成全部当前授权工作，未新增需修复问题。

## 外部事项（非 X6 可执行剩余工作）

- SW/UD changed-only 的共享 `scripts/electron-migration/lib/gate-checks.mjs` 接入仍待有权 infra 应用 `gate-checks-integration.patch`；X6 未获该文件写权限，不称已上线。
- 原报告发现由 C1/C2 按原 ID 分发；真实业务接线/pending、语义断言补齐和 L10 原 test-only 的裁定由对应 owner/架构师处理。
- 报告只在新的明确刷新要求或有证据的误报修正下更新，不循环重扫，不把 parked owner 唤醒。

### L24 四条真实可达性缺口：生成来源已核，待授权维护方回写

C1 新交接与 L24 `734023866` 自查按原 ID 记录；固定 main `d51544ecf3099b1d894fecfc22457ae8bf9176d5`（本分支已正常合并）的四行仍为 `ported:host/plugins/chatanki/tests/executor-helpers.test.ts`。只读符号检索确认当前 helper 引用仅在定义与该测试；前端 `blockEvents.ts` 的同名 `isChatAnkiTool` 是局部布尔变量，不是对 L24 helper 的消费。此次未重跑可达性/账本/AP，不声称新的 A 变化数。

| 历史 AP ID | 原 Rust ID（不改名、不重排） | helper | 当前 TESTMAP 行 |
|---|---|---|---:|
| AP0198 | `src/chat_v2/tools/chatanki_executor.rs::tests::test_can_handle` | `tool-metadata.ts::isChatAnkiTool` | 98 |
| AP0204 | `src/chat_v2/tools/chatanki_executor.rs::tests::test_decide_wait_timeout_status_variants` | `block-timing.ts::decideWaitTimeoutStatus` | 116 |
| AP0211 | `src/chat_v2/tools/chatanki_executor.rs::tests::test_decide_pipeline_timeout_idle_semantics` | `block-timing.ts::decidePipelineTimeout` | 181 |
| AP0207 | `src/chat_v2/tools/chatanki_executor.rs::tests::test_vlm_full_prompt_requests_optional_normalized_occlusion_boxes` | `prompts.ts::buildImportPrompt` | 123 |

**生成来源/状态权威链：**
- `lib/rust-analysis.mjs:548-568` 的 `testId/testRows` 由 Rust 文件、内联模块、测试名产生原 ID；`scaffold.mjs:289-297` 写出业务插件 TESTMAP。
- `scaffold.mjs:225-250` 先从旧 TESTMAP 调用 `parseTestmapStatuses`，再传给 `testmapTable`；`lib/docs-model.mjs:19-36` 按原 ID 保存/恢复状态。没有独立的 pending 状态注册表；对这四行单独执行 refresh 仍会保留旧 ported，不能替代经授权的纠偏。
- `ledger.mjs:54-59` 直接读取该 TESTMAP 的状态；X6 `testmap.mjs`/prod-reachable 亦读取同一文件。更改审计、AP 候选或旧 ledger 快照都不会回写权威状态。

**下一步只等待：** 架构师裁定 GENERATED 修改权限，由获授权维护方只回写这四个原 ID 的 pending 状态、缺口说明及对应汇总。回写后 X6 按四个原 ID 定点核对，确认非目标行不变；当前不改业务 TESTMAP、生成器或评分规则，不全文件降级、不复活 obsolete、不补假 export/空 call。组合/循环断言等价与生产执行路径缺失分开记录，四条不因此重新归类为“少 expect”。
