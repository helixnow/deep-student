# X1 旧 inflight：只读覆盖核对（2026-11-07）

基点 `891d75ed`。输入为工作区根 `.transfer/inflight/X1-e2e-smoke.code.patch`，没有应用补丁。
`scripts/electron-migration/absorb-check.mjs --json --target 891d75ed --patch <绝对补丁路径>` 使用临时索引检查：
**13 absorbed / 46 open / 1 diverged；openCode 恰35文件**。原始结果在根
`.reports/takeover/desktop-x1-inflight-absorb.json`。open 是文本可正向应用，不是35个业务功能丢失。
下述为源码覆盖对账，不是重新执行旧测试，也不将存在测试等同于最新门通过。

## 35文件逐组裁定

文件均相对 `host/e2e/smoke/`；每文件只计一次。

| 旧文件组 | 数 | 当前覆盖 / 裁定 |
|---|---:|---|
| `b-driver.mjs`、`__fixtures__/scenario-v0.ts`、`scenario-v0.test.ts`、`__fixtures__/b-recording.test.mjs`、`b-recording.test.ts`、`__fixtures__/b-provider.test.mjs`、`b-provider.test.ts`、`triage.mjs` | 8 | 旧CLI录制器及其输入/错误/引用/sidecar清理测试、归因报告工具。现行 `scripts/electron-migration/record/{scenario-v0,g3-services,g3-run-b}.mjs` 与 `host/e2e/differential/{scenario-v0,g3-services}.test.mjs` 接管语料执行和引用；W12真窗口黄金路径另有 fake LLM。**不是逐项完全等价**：现行G3 B没有Electron main，不接受旧rawBody/waitFor扩展；旧驱动自身预算/输出格式的测试无现行消费者，不恢复第二套runner。生产链缺口只列下节。 |
| `check-source-fidelity.mjs`、`check-source-fidelity-args-json.mjs`、`scenarios/source-fidelity.v0.json`、`scenarios/shell-readonly.v0.json`、`restart-smoke.mjs` | 5 | `electron/tests/inbound-json-renderer.test.ts:59-121` 已在生产preload→Shell→Host→真实review handler检查993/992、null/缺失、ACL、headers、bytes；`raw-json-renderer.test.ts` 覆盖出站原始JSON。`shell-real-host.test.ts:16-106` 真实官方Host覆盖version/restart_app/PDF/file访问与restart hook；W12⑤是真dist恢复/重启后读回。因此不重放旧源码精度/重启驱动。注意不是证明系统真实重新拉起进程，旧restart脚本本身同样只记录process hook。 |
| `__fixtures__/b-database.mjs`、`__fixtures__/b-database.test.mjs`、`b-database.test.ts`、`check-seed-capture.mjs`、`run-seed-capture.mjs`、`scenarios/seed-capture.v0.json` | 6 | 当前X3 seed/全库快照能力仍在 `host/e2e/data-compat/__fixtures__/{scenario-seeds,database-state}.ts`，现行 `scenario-v0.mjs` 准备副本，`g3-run-b.mjs:155-160` 等Host exit0后取finalDatabases；W12③/⑧覆盖真窗口笔记重启与历史布局升级。**未逐项等价**：旧“官方Electron关所有writer→/proc句柄证明→全库raw snapshot→源/未使用副本不变”的组合证据未在W12黄金路径重建。它是取证能力差异，不是新增已知产品故障；G2需要该链时定向接现行X3能力，不回装整套B驱动。 |
| `__fixtures__/job-barrier.mjs`、`__fixtures__/job-barrier.test.mjs`、`job-barrier.test.ts`、`check-barrier-deadline.mjs`、`check-job-barrier.mjs`、`scenarios/backup-job-terminal.v0.json` | 6 | W12⑤经真实UI导出/导入/恢复，按真实job ID轮询到completed；现行G3 `g3-wait.mjs` 有显式事件终态。旧listen→invoke→wait→unlisten共享10s/迟到cleanup是**旧B驱动算法本身**，当前无消费者，不因它缺失新增产品实现任务。当前⑤不是事件屏障迟到清理的等价证明，也不宣称覆盖真实进行中cancelled（旧脚本亦未做到）；保留边界，不恢复旧waitFor扩展。 |
| `__fixtures__/raw-body.heic.base64`、`prepare-raw-body.mjs`、`check-raw-body.mjs`、`scenarios/raw-body.v0.json` | 4 | `electron/tests/inbound-json-renderer.test.ts:69,118` 有真实bytes链；`host/plugins/media/tests/heic.test.ts:12-36` 有HEIC空体/JSON伪二进制/非空桌面拒绝。**组件覆盖，不等价于同一个生产HEIC命令贯穿renderer/preload/Host的三组字节与headers原件**；仅保留下节一个定向E2E覆盖缺口。 |
| `check-provider.mjs`、`check-http500-state.mjs` | 2 | `host/e2e/streaming/wave0/qbank-provider.test.ts` 覆盖L14 sidecar真实HTTP与正确判分命令；`host/plugins/qbank/tests/grading-command-errors.test.ts:14-105` 覆盖HTTP500/落库失败的原错误、终态先于settlement、正式成绩/统计不变及草稿。**没有据此宣称完整桌面renderer链等价**；W12黄金路径没有qbank_ai_grade成功→同submission再评分→HTTP500的真窗口组合。仅保留下节一个E2E缺口，不重派Host判分实现。 |
| `minimal.test.ts`、`probe.test.ts`、`production.test.ts`、`selection.test.ts` | 4 | 实现 `__fixtures__/{minimal,probe,selection,worker,run}.ts/mjs` 与CLI `run.mjs` 已吸收（按实际扩展名），四个旧测试入口未吸收。W12①只以 `DS_SMOKE_STARTUP_ONLY=1` 验插件装配，不代替Node×2/Electron×2全部注册命令探针与shard并集证明。这是**自动门禁入口/覆盖缺口**，不是35文件都缺业务。若继续要求该独立Host门，窄恢复/重写这组测试入口即可；本轮不跑全量。 |

合计 **8+5+6+6+4+2+4=35**。另一个 diverged 是 `__fixtures__/window-main.mjs`：当前W12已加入自身诊断/计时器等观察钩子，保留当前版本，不整文件覆盖。

## 真正保留的最小缺口

1. **HEIC实际命令的renderer二进制/headers E2E证据**：目前是通用bytes真链+HEIC Host侧分段覆盖；如补，只写小型定向规格，复用现有window-driver，不恢复旧录制器。
2. **qbank评分的桌面端完整IPC/事件/DB闭环**：成功、同submission再次评分、HTTP500正式数据不变；已有Host业务测试保留，不派重复产品实现。
3. **全部注册命令Host自动门的入口与shard完备性**：CLI存在，W12冷启动只跑startup-only。是否纳入本轮发布门由主代理决定，不能以G1路由数代替命令覆盖率。

历史seed原件/全库闭包与A1/A2/B比较的正式取证要求仍归原G2缺口；不因旧文件可应用就扩成第二套录制框架。
本核对没有运行G3、SSH、全量Host或前端测试，也没有把旧失败回执升级为通过。
