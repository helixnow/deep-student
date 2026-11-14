# W69 main-red：生产查询候选（待 L20 授权/应用，不是已修复声明）

原测试 `tests/sync_weird_tests.rs::w69_ten_thousand_tiny_records` 的 10000 条、
计数与 `<30s` 断言保留。L23 已恢复原内存 fixture / 单调时钟，仍有性能失败。

## 最新：07:33Z main2a8聚合回执（依C2后发裁定只保存、不重跑）

C2已亲核，且本轮只读latest.json核到head
`2a8df31411e8dbd0822d0270836c51dcc63e4e55` / at`2026-11-05T07:33:46.683Z`：
W69 apply **40532.18936800001ms>30000**，case40669.18004399999ms，原首栈如下。
这是既有同源阻塞，不是新Retry-After三红/S108超时；原始shard job/exit/Errors
本轮未另行取回，不补造其值、不把聚合状态冒充本lane新作业。

```text
AssertionError: expected 40532.18936800001 to be less than 30000
    at /home/dsdev/dev/ds-fulltest/host/plugins/sync-providers/tests/weird_batch_sync.test.ts:412:21
    at file:///home/dsdev/dev/deep-student/node_modules/@vitest/runner/dist/chunk-hooks.js:155:11
    at file:///home/dsdev/dev/deep-student/node_modules/@vitest/runner/dist/chunk-hooks.js:752:26
    at file:///home/dsdev/dev/deep-student/node_modules/@vitest/runner/dist/chunk-hooks.js:1897:20
    at new Promise (<anonymous>)
    at runWithTimeout (file:///home/dsdev/dev/deep-student/node_modules/@vitest/runner/dist/chunk-hooks.js:1863:10)
    at runTest (file:///home/dsdev/dev/deep-student/node_modules/@vitest/runner/dist/chunk-hooks.js:1574:12)
    at processTicksAndRejections (node:internal/process/task_queues:104:5)
    at runSuite (file:///home/dsdev/dev/deep-student/node_modules/@vitest/runner/dist/chunk-hooks.js:1729:8)
    at runSuite (file:///home/dsdev/dev/deep-student/node_modules/@vitest/runner/dist/chunk-hooks.js:1729:8)
```

后发C2 07:37明确不新增W69/S108/目录重跑、不改阈值/输入、不跨界复制SQL。
实际获权L20写者仍未确认；本轮只完成FTP自有日期最小单元的35例/类型/边界检查，
保存其冻结树/原job后交健康会话。此前所有原W69失败、候选与请求保持，不重发同一
停放lane执行消息，不将等待owner写成已修复。

## 最新：2026-11-05 05:18Z main 全量（仍未修，缺实际获权写者）

- 固定main `eaa17bc7e27ea6e522d3b51e093a7d2e05b2c290`，latest at
  `05:18:27.688Z`。shard6 **`20261105050414-f9d810` 原exit1**，cwd
  `/home/dsdev/dev/ds-fulltest`，start05:11:54.902Z/end05:18:26.576Z。
  命令同下段shard6，原metadata/log位于 `.oc-jobs/done/<job-id>.{json,log}`。
- 原apply计时 **39579.047571999996ms>30000**，case39618.081204999995ms；前面
  success10000/failure0/applied_keys10000/表count10000四项断言均过。shard6仅
  1416passed/1failed/2pending，不外推全仓统计；原log未检到Errors/onTaskUpdate/
  Unhandled/Hook timed文本，JSON无独立Errors字段，不宣称全仓Errors0。

```text
AssertionError: expected 39579.047571999996 to be less than 30000
    at /home/dsdev/dev/ds-fulltest/host/plugins/sync-providers/tests/weird_batch_sync.test.ts:412:21
    at file:///home/dsdev/dev/deep-student/node_modules/@vitest/runner/dist/chunk-hooks.js:155:11
    at file:///home/dsdev/dev/deep-student/node_modules/@vitest/runner/dist/chunk-hooks.js:752:26
    at file:///home/dsdev/dev/deep-student/node_modules/@vitest/runner/dist/chunk-hooks.js:1897:20
    at new Promise (<anonymous>)
    at runWithTimeout (file:///home/dsdev/dev/deep-student/node_modules/@vitest/runner/dist/chunk-hooks.js:1863:10)
    at runTest (file:///home/dsdev/dev/deep-student/node_modules/@vitest/runner/dist/chunk-hooks.js:1574:12)
    at processTicksAndRejections (node:internal/process/task_queues:104:5)
    at runSuite (file:///home/dsdev/dev/deep-student/node_modules/@vitest/runner/dist/chunk-hooks.js:1729:8)
    at runSuite (file:///home/dsdev/dev/deep-student/node_modules/@vitest/runner/dist/chunk-hooks.js:1729:8)
```

- dd564→eaa17的L20/F3整目录无diff；weird_batch只新增W55及注释，W69 body/
  newDb/context/afterEach未变。W55 readonly仅属其独立连接，原afterEach关闭清理，
  未改共享profile；新增行使W69报错390→412，不是阈值或计时口径变更。
  eaa17→本轮已合main的本test/L20/F3亦无diff。旧dd564早已有同性能失败，未发现
  新接口不匹配证据；静态diff仍不能排尽运行环境影响，不据此定CPU/完整算法根因。
- 当前生产仍table-first，下面record-first候选未实施。新架构上报
  **`2026-11-05T052208691Z-L23-sync-providers.md`** 要求实际L20获权写者或只授
  L23该一行窄授权；原03:08上报与两个原失败均保留。获权真实生产修复才写
  `fix(main-red)`，再保原指标验证W69/DELETE/LWW及gate。本轮仅复用新原结果，
  没有新测试/profile、owner已接手或生产已修声明，不处理外部ledger dirty。

## 2026-11-05 03:04Z main 全量再确认（未修，已上报实际写者/窄授权）

- 固定main `dd564e12f9ced043381b3b61410a01aba38a1a1b`，latest回执
  `03:04:10.623Z`。实际来源shard6 job **`20261105024553-95d982` 原exit1**，
  cwd `/home/dsdev/dev/ds-fulltest`，start02:45:54.291Z/end02:57:46.975Z。
  命令 `npx vitest run -c vitest.host.config.ts --shard=6/8 --reporter=json --outputFile=/home/dsdev/dev/deep-student/.oc-runs/fulltest/shard-6.json`。
- W69 case42745.878074ms；原apply计时 **42705.341065ms > 30000**。前面
  success10000/failure0/applied_keys10000/表count10000四项断言均通过。不是数据断言
  失败或新的caseTimeout。shard6为1437passed/1failed/2pending，不冒充全仓统计。
- 原栈保存在上述shard-6.json及同目录latest.json的该case.failureMessages：

```text
AssertionError: expected 42705.341065 to be less than 30000
    at /home/dsdev/dev/ds-fulltest/host/plugins/sync-providers/tests/weird_batch_sync.test.ts:390:21
    at file:///home/dsdev/dev/deep-student/node_modules/@vitest/runner/dist/chunk-hooks.js:155:11
    at file:///home/dsdev/dev/deep-student/node_modules/@vitest/runner/dist/chunk-hooks.js:752:26
    at file:///home/dsdev/dev/deep-student/node_modules/@vitest/runner/dist/chunk-hooks.js:1897:20
    at new Promise (<anonymous>)
    at runWithTimeout (file:///home/dsdev/dev/deep-student/node_modules/@vitest/runner/dist/chunk-hooks.js:1863:10)
    at runTest (file:///home/dsdev/dev/deep-student/node_modules/@vitest/runner/dist/chunk-hooks.js:1574:12)
    at processTicksAndRejections (node:internal/process/task_queues:104:5)
    at runSuite (file:///home/dsdev/dev/deep-student/node_modules/@vitest/runner/dist/chunk-hooks.js:1729:8)
    at runSuite (file:///home/dsdev/dev/deep-student/node_modules/@vitest/runner/dist/chunk-hooks.js:1729:8)
```

- `.oc-jobs/done/20261105024553-95d982.log`保留WASI ExperimentalWarning，未检到
  Errors/onTaskUpdate/Hook timed文本；JSON没有独立Errors字段，不据此宣称全仓Errors0。
- `6e56f9a3a..dd564e12f` 的本测试、L20 apply-record、F3 connection无diff；
  `a9683a43b..dd564e12f` 的本测试、apply-record、F3目录也无diff；dd564至本分支
  对本测试/L20/F3无diff。weird_batch不导入新的S108 observer，且该fulltest版本
  本就不含observer。未发现新接口不匹配，属于既有W69性能失败持续；静态diff不证明
  历史profile已排尽所有耗时来源，也不确定本次CPU/算法根因。
- 当前 `sync/repository/apply-record.ts:137-140`仍table-first，下面候选没有应用。
  架构上报 **`2026-11-05T030837111Z-L23-sync-providers.md`** 请求明确有L20写权限
  的实施者，或仅授L23此一行窄授权。获权者才以`fix(main-red)`提交真实生产改动，
  保原断言跑W69及DELETE/LWW，再lane-gate；不把本次文档提交伪装生产修复。
- 本轮复用完整原结果，未重跑同红树、改测试索引/预算/输入/断言，未碰外部ledger。

## 已测热点

- 原生产查询：`host/plugins/sync/repository/apply-record.ts::currentDeleteVersion`。
- Profile job `20261104172145-2fa67b` exit 1：apply 约 30.23s，
  currentDeleteVersion 约 16.24s，F3 get 自耗约 13.15s；无 Errors。
- 原查询按表名、记录 ID、DELETE 过滤，并取 id 最大的一条；W69 的表名相同，
  没有匹配的旧记录，表名过滤在扫描中几乎总是真。

## 唯一 SQL 差异候选

```diff
 SELECT changed_at FROM __change_log
-WHERE table_name=?1 AND record_id=?2 AND upper(operation)='DELETE'
+WHERE record_id=?2 AND table_name=?1 AND upper(operation)='DELETE'
 ORDER BY id DESC LIMIT 1
```

参数仍为 `[tableName, recordId]`，不改变占位符编号、不增索引、不缓存状态、不省略
任何查询、不改排序或大小写处理。只改变两个等值筛选的先后。

## 真实 F3 驱动诊断（不是模拟引擎，也不计入 TESTMAP）

脚本：`tests/diagnostics/w69-query.ts`。
Job `20261104194043-6655ea` exit 0，无 Errors；使用真实公开 F3 内存连接，
10000 条同表 INSERT 日志，2000 次旧 DELETE 缺失查询：

| SQL | 耗时 | 计划 |
| --- | --- | --- |
| 原 table-first | 7103.67ms | SCAN __change_log |
| record-first 候选 | 4383.61ms | SCAN __change_log |
| upper(operation)-first 对照 | 10210.89ms | SCAN __change_log |

record-first 在该输入约快 38%；这不证明整批一定达到 30s。
脚本还验证大小写混合 DELETE、其他表/记录、多个 DELETE 以及最后 UPDATE 共存时，
三个查询都返回同一最新 DELETE；`ordered-result-check: passed`。

L20 应先评估并应用该候选，再跑原 W69 和 DELETE/LWW 回归、全套门禁；若仍未达标，
继续优化真实生产路径，不放宽原性能断言。本 lane 白名单不含该生产文件，
不会把本任务说明或诊断脚本当成生产修复。
