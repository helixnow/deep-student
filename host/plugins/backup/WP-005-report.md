结论：部分完成，已用原 X1 日志和真实生产命令定位超时主体为完整 Slot C/D worker 迁移；Node/Electron 均未达到原5秒预算，提交 C2 裁定，未宣称性能修复完成。

## 提交与范围

- `1a9f505d1`：协调者自动保存新增 `tests/migration-diagnostic.test.ts`。
- `fe7cf8f13`：协调者自动保存 SPEC/LANE/BLOCKERS/TESTMAP 的阶段证据与过时说明纠正。
- `5aac8d890`：Electron 阶段结果与归属结论（含 Co-Authored-By）。
- `35f4ed9e0`：协调者自动保存本报告初稿。
- `13c3497c7`：中断恢复后 `git merge --no-edit main`（main `b55af5d85`），无冲突，未触及本包文件。
- 分支 `ds-mig/L21-backup-governance`；开工/提交前已 `git merge --no-edit main`。
- 只新增生产入口回归和本 lane 文档；生产实现、DTO/wire、原日志、失败顺序、诊断内容、X1 85秒/5秒与既有测试预算均未改。

## 原 X1 证据与源码

原 job `20261105112439-a10c89` exit1（X1完整命令探针非本包重跑）：

- `/tmp/opencode/x1-smoke-m6EYCy/node/result.json:17806-17815`：本命令 timeout，5001ms。
- 同次 `node/local/data/logs/deep-student.log:55-204`：19:25:55开始 Slot C，19:26:05完成，
  coordinator 自报 **10316ms**。`:59-129` 逐项应用71条VFS迁移；`:134-141` 8条LLM；
  `:146-174` 29条Chat；`:179-201` 23条Mistakes。VFS约5秒仅为秒精度日志范围，不能当精确计时。
- 原日志接着开始第二次Slot C，未见本诊断Slot D完成；不能从原超时凭空推完整诊断耗时。
- Rust `src-tauri/src/data_governance/commands.rs:1067-1068` 先刷新状态；`:1088-1196` 状态/错误/审计；
  **`:1199-1217` 串行执行完整Slot C/D**；`:1219-1275` 历史/磁盘/目录。
  `:237-239` 空库完整run_all，`:283-340` SQLite在线克隆后完整run_all；`:264-266,375-376` 清槽。
- F3 Rust `crates/dstu-storage/src/migration/coordinator.rs:282-428` 执行磁盘检查、恢复重试、核心库备份保护、
  依赖顺序迁移/验证、失败恢复与日志；没有“仅返回状态”捷径。
- 当前TS接线 `host/plugins/backup/index.ts:235` → `src/governance.ts:536-628` →
  `runSlotCTest/runSlotDTest` → `runMigrations:61-65` → 正式 F3 `migration-worker.ts:33-59` →
  `migration/worker-tasks.ts:11-24` → `migration/coordinator.ts:96-159,180-234`。
  主体已在worker，不是缺worker接口。未运行Rust，不声称Rust在该机器实测也超过5秒。

## 当前树阶段耗时（毫秒）

| 阶段 | Node | Electron |
|---|---:|---:|
| 整条kernel invoke | 13191.20 | 8231.39 |
| Slot C完整生命周期 | 10917.84 | 6258.62 |
| C worker等待，含冷启动/构造/IPC | 10909.17 | 6255.01 |
| C实际coordinator.runAll | 9662 | 5085 |
| C VFS / LLM / Chat / Mistakes | 5924 / 593 / 1850 / 1279 | 3212 / 181 / 935 / 701 |
| Slot D完整生命周期 | 2200.49 | 1934.19 |
| D worker等待 | 2035.88 | 1832.33 |
| D实际coordinator.runAll | 2027 | 1823 |
| D VFS / LLM / Chat / Mistakes | 1282 / 49 / 292 / 343 | 1186 / 32 / 330 / 222 |
| worker等待以外全部编排/读库/复制/清理/格式化 | 246.14 | 144.05 |
| 实际迁移日志出现后Host心跳数 | 1905 | 1247 |
| 最大5ms定时器实际间隔 | 138.96 | 53.53 |

四库顺序VFS→LLM→Chat→Mistakes；C应用数71/8/29/23，D全部0。两次真实worker报告均success，threadId=2。
上述心跳证明迁移期间事件循环能推进，不等于所有同步读库/清理绝无阻塞；未用它替代5秒要求。
worker等待减runAll的差额含加载/构造/IPC/调度，未再细分，不把差额全归因CPU或模块加载。

## 验证

所有命令均经全局 jobs，从本工作树执行；新测试设 `TMPDIR=/tmp/opencode`，实际数据根为独立
`/tmp/opencode/dstu-test-host-*`，生命周期结束清理。初始活动库由独立真实F3 runner完整迁移，
诊断runner保持冷启动；未预跑C/D、缓存结果、复用schema或移动生产诊断到hook。

| 检查 | job | exit | 结果 / Errors |
|---|---|---:|---|
| 起点typecheck | `20261105140228-a4f859` | 0 | 无Errors |
| 新回归typecheck | `20261105141128-d216ef` | 0 | 无Errors |
| 既有slot-tests仅诊断响应性 | `20261105140250-ad79ef` | 0 | passed1 / failed0 / 过滤4；无Errors；invoke21231ms，仅证明响应性，不证明5秒达标 |
| 新诊断原预算Node | `20261105140602-fba35c` | 1 | passed0 / failed1 / skipped0；无额外Errors |
| 新诊断原预算Electron | `20261105140951-bf8c05` | 1 | passed0 / failed1 / skipped0；无额外Errors |

两次新回归均已先通过完整报告8段/状态/持久错误/审计/迁移历史/磁盘/目录、C/D每库结果、串行顺序、清槽及日志断言；
**最终5秒断言失败**，未改成skip/todo/fails，未删弱断言。完整阶段JSON保存在上述job日志及Vitest task.meta。

### 自检（合并 main 后，HEAD `13c3497c7`）

自检：lane-gate job `20261105144850-10d900` exit 2（更早一次 `20261105141850-2c0443` 同样 exit 2）。原文：
`有未提交的改动，先提交再自检（自检结果按提交记录）： M migration/LEDGER.md  M migration/ledger.json`。
这两个文件是他人生成物，按 WORKER.md 不提交；工作树中除此之外无未提交改动。因此按 `lib/gate-checks.mjs`
对本分支相对 main 的同一检查列表逐项经 job 执行：

| 检查 | job | exit | 结果 |
|---|---|---:|---|
| typecheck（`tsc -p tsconfig.host.json --incremental`） | `20261105144851-091927` | 0 | 无Errors |
| boundaries（非strict全量） | `20261105144851-3e1f96` | 0 | 3042文件，0 violation，221 boundary-allow |
| boundaries-strict(changed) | `20261105144852-8e7120` | 0 | 1文件（新测试），0 violation |
| importable `host/plugins/backup/index.ts` | `20261105144853-0f705f` | 0 | importable: ok |
| tests `vitest run -c vitest.host.config.ts host/plugins/backup/` | `20261105150749-4d236e` | 1 | Test Files 1 failed / 30 passed；Tests 1 failed / 466 passed；无Errors行。唯一失败为本包新回归最终断言 `expected 10306.49 to be less than or equal to 5000`（本次Slot C/D 仍串行完成，1548心跳，最大间隔59.47ms） |
| wiring `--lane backup` | `20261105143015-314899` | 0 | ported 319，未从 index.ts 接入 0 |
| ledger `--check --no-write` | `20261105143015-0d30a5` | 0 | `ledger: commands 1058 (A 100% B 0% C 0%), tests 8109 (A 89.6% B 1.9%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）; prod-reachable unreachable 14 (unknown 3661, not vetoed)` |

上一 tests job `20261105150015-fec504` exit -1 是作业执行器重启导致的中断，已重新提交，不计入结论。
tests 一项的失败是本包有意保留的 5 秒验收断言，归属见下文 C2 裁定请求，不是其他用例回归。

## TESTMAP

逐行：319 ported / 1 merged / **pending前3 → 后3**；本包更改去向条目：无。
新用例没有对应原Rust测试ID，不伪报ported；语义依据是commands.rs:1061-1275生产入口。
旧GENERATED头311/12未手改，在生成区外注明实际统计。
剩余3条为原地回滚obsolete审批、Registry poison裁定、feature-off审批，证据在TESTMAP文末，本包未扩展处理。

## 未完成与C2裁定请求

- **未完成5秒验收**。当前测量中L21 worker外总耗时不足0.25秒；即使移除这些全部开销，
  Node/Electron仍分别有12.945/8.087秒worker等待。不存在由当前证据支持的L21局部删减即可达标方案。
- 请C2决定完整诊断的性能处置与下一工作包归属：F3现有`MigrationWorker.runAll(options): Promise<MigrationWorkerReport>`
  已发布且真实消费；需评估owner内部迁移/验证执行性能，或裁定该完整诊断的验收口径。L21不越界优化F3、
  不并发重排C/D，不跳迁移/校验，不改SQLite持久性参数，不把结果改成异步job回执，也不自行放宽X1预算。
- 本包证据是TS生产入口+Rust源码审读；机器负载/单条SQL/磁盘同步的更细归因尚未测量。
  没有Rust运行时差分，也未重跑X1全量，不能据此签全部lane或原全量绿。
- L11 `vfsMaintenance.resetRebuildableIndex(targetDir)` main已在`types/services.ts:175`与`src/maintenance-service.ts:75`，
  已git show核实；与本命令慢阶段无关，不能继续作为未发布阻塞。

## 供抽检

1. 原X1应用日志`:55-204`的Slot C 10316ms，与`commands.rs:1199-1217`必须串行生成C/D文本的对应关系。
2. `tests/migration-diagnostic.test.ts:48-119`：计时包装始终调用原方法，真实报告threadId/四库结果、清槽、日志均断言；
   Node/Electron失败都落在最后5000ms断言，不能把“完整诊断成功返回”写成“预算通过”。
