# L23-P08：唯一 S108 + cleanup 阶段诊断回执

## 判读边界

作业 **`20261105025729-64ec28` 原 exit 0**，1 passed / 19 标题过滤；S108
**65592ms**，文件 hooks + case **80820ms**，Vitest 总 **96.29s**。无 Failed Suites、
Errors、阶段 error、hook 或 onTaskUpdate 超时。保留10设备×10条、最终100条断言、
原180000ms case / 10000ms cleanup，以及真实F3/L20/notes所有者链和清理顺序。
19是 `-t` 过滤的其他标题，不是新增skip，也不计为执行通过。

**只说明该次未复现历史失败，不是生产修复或旧根因已定位。**
本次D0–D9真实迁移累计 **63251.231ms**（约占case的96.4%），10次applyPending累计
**1697.181ms**，其中实际applyDownloadedChanges累计 **1529.424ms**（嵌套、不能相加）。
host.dispose到rm结束跨度 **282.916ms**：host14.154ms，12个storage合计233.534ms，
rm32.288ms。58个start均有对应end，无error事件。A/B是原beforeAll的辅助设备，
未当成S108的数据设备；其迁移6872.995/7190.091ms独立于case内10设备。

明确观察到的耗时边界是 `StorageService.migrations.runAll`，实现链为
`host/platform/storage/service.ts:344-346` → `coordinator():318-320` →
`migration/coordinator.ts:96-159`；没有进一步profile其内部SQL/备份/驱动。
不能由这个成功样本推断184280/183077ms失败也必然停在同阶段，不能定CPU/算法根因。
原cleanup/RPC故障仍由infra保留定位，W69仍等有权限写者；本轮不动parked生产代码。

## 固定版本、命令与原始材料

- 受测HEAD `e077e3f6a1a219f7f54b58a4d325a0b6cb24dc08`，tree
  `5e6a6e58d833114e3feb994fb10b5dc9eaf61e97`；诊断代码已由 `fdd901192` 保存。
  前后无受测三文件未提交差异，原外部ledger dirty原样保留。
- 基线 `f28f29cf9` / main `dd564e12f`。相对原main `a9683a43b`，harness/stress、
  L20、F3、Vitest配置无业务差异，但notes api/index及notes/resource-deps/revisions
  生产仓储有增量，sync-support是文档变化。本次还加了test-only日志/reporter，
  并只选一个case，**不是原R4整套执行环境或固定失败tree复现**。
- cwd `/home/dsdev/dev/ds-mig/L23-sync-providers`；submitted `02:57:29.181Z`，
  started `03:01:09.261Z`，ended `03:02:50.070Z`（均2026-11-05）。
- 开工及提交前queue/running均未发现同目标活跃作业，故仅submit一次。
- 原metadata/log：`/home/dsdev/.oc-jobs/done/20261105025729-64ec28.{json,log}`。
  log:4执行器配置、:5/:203队列快照、:7实际worker、:10-199完整阶段事件、:201-208结果。

```sh
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- npx vitest run -c vitest.host.config.ts host/plugins/sync-providers/tests/realistic_scenarios_stress_sync.test.ts -t s108_10_devices_each_creating_10_records --reporter=default --reporter=./host/plugins/sync-providers/tests/diagnostics/s108-reporter.ts
```

本诊断只加观察，不改原断言/输入/缓存时点/yield/cleanup顺序或预算；异常原样抛回。
原Rust `sync_realistic_scenarios.rs:3768-3801` 10×10 / `assert_eq!(c,100)` 未弱化。
本轮不另排typecheck、目录、930或1938全套，不为此成功回执重测。

## 有效 worker 与并发快照（非核数推算）

Vitest3.2.7、Nodev26.5.0，实际父PID3925508、worker PID3925782/PPID3925508，
threadId0、poolId1、workerId1；本次单文件阶段日志均来自该worker。
`vitest.host.config.ts` 有效pool=forks、fileParallelism=true、maxConcurrency=5；
runner实际环境 `VITEST_MAX_FORKS=3` / `VITEST_MAX_THREADS=3`，resolved poolOptions
的forks/vmForks.maxForks=3、threads/vmThreads.maxThreads=3。顶层min/maxWorkers
未出现在resolved JSON中，不凭此补造值，也不把cap3说成此次实际运行3个worker。
全局默认testTimeout30000；S108源码显式180000未改，resolved hookTimeout10000。
worker execArgv为 `--conditions node --conditions development`。

队列状态快照：start03:01:13.268Z为8个test作业运行，end03:02:48.561Z为5个；
两时点queued0、integrating=true、paused=false，CPU pressure分别2.18/2.77，
limits为typecheck8/test8/build2/other6。这是两时点观察，不是区间连续监测，
也不含未通过此队列的外部进程，不能还原旧R4实际worker数。

| 作业 | 实际命令目标 | start快照 | end快照 |
| --- | --- | --- | --- |
| 20261105024553-778fdd | ds-fulltest shard2/8，JSON reporter | running | running |
| 20261105024553-ae01f3 | ds-fulltest shard1/8，JSON reporter | running | 不在快照 |
| 20261105024615-755ca4 | R4 backup/sync-providers/sync-support/sync | running | running |
| 20261105024831-7c5d18 | L12 vfs-index，--maxWorkers=1 | running | 不在快照 |
| 20261105025225-f7172a | _arch-fix-misc media/qbank/integration | running | running |
| 20261105025308-642255 | R5 chatanki | running | 不在快照 |
| 20261105025541-cc9008 | L24 chatanki | running | running |
| 20261105025729-64ec28 | 本次单个S108 | running | running |

## 单调阶段起止（ms，保留至0.001；全部end，无error）

同一worker的performance.now坐标；真实root为`/tmp/l23-realistic-extended-X0iPxD`，
各设备create的base为root下`device-<name>`。rm是原有一次递归root清理，未改成逐设备rm。
applyDownloadedChanges目标均D0/vfs、各10条；按外层applyPending来源标明嵌套对应。

| 阶段 | 设备/来源 | start | end | elapsed |
| --- | --- | ---: | ---: | ---: |
| createStorageService | A | 14909.292 | 14909.909 | 0.617 |
| migrations.runAll | A | 14910.154 | 21783.149 | 6872.995 |
| createStorageService | B | 22611.236 | 22611.565 | 0.329 |
| migrations.runAll | B | 22611.704 | 29801.796 | 7190.091 |
| createStorageService | D0 | 29955.444 | 29956.061 | 0.617 |
| migrations.runAll | D0 | 29956.192 | 37523.825 | 7567.633 |
| createStorageService | D1 | 37610.944 | 37611.193 | 0.249 |
| migrations.runAll | D1 | 37611.255 | 45087.432 | 7476.177 |
| createStorageService | D2 | 45135.122 | 45135.403 | 0.281 |
| migrations.runAll | D2 | 45135.477 | 52339.588 | 7204.111 |
| createStorageService | D3 | 52393.516 | 52393.765 | 0.249 |
| migrations.runAll | D3 | 52393.842 | 59708.327 | 7314.484 |
| createStorageService | D4 | 59749.145 | 59749.376 | 0.231 |
| migrations.runAll | D4 | 59749.433 | 67050.248 | 7300.815 |
| createStorageService | D5 | 67102.394 | 67102.641 | 0.247 |
| migrations.runAll | D5 | 67102.711 | 73680.777 | 6578.067 |
| createStorageService | D6 | 73741.540 | 73743.053 | 1.513 |
| migrations.runAll | D6 | 73743.179 | 79199.767 | 5456.587 |
| createStorageService | D7 | 79229.616 | 79229.991 | 0.375 |
| migrations.runAll | D7 | 79230.098 | 84464.823 | 5234.725 |
| createStorageService | D8 | 84497.732 | 84498.081 | 0.349 |
| migrations.runAll | D8 | 84498.123 | 88893.452 | 4395.329 |
| createStorageService | D9 | 88922.810 | 88923.024 | 0.214 |
| migrations.runAll | D9 | 88923.070 | 93646.374 | 4723.304 |
| applyDownloadedChanges | D0→D0 | 93695.933 | 93885.683 | 189.749 |
| applyPending | D0→D0 | 93681.008 | 93887.829 | 206.821 |
| applyDownloadedChanges | D1→D0 | 93949.477 | 94144.024 | 194.547 |
| applyPending | D1→D0 | 93891.015 | 94144.894 | 253.879 |
| applyDownloadedChanges | D2→D0 | 94150.654 | 94273.503 | 122.850 |
| applyPending | D2→D0 | 94146.496 | 94274.393 | 127.896 |
| applyDownloadedChanges | D3→D0 | 94279.629 | 94455.400 | 175.771 |
| applyPending | D3→D0 | 94274.882 | 94456.313 | 181.431 |
| applyDownloadedChanges | D4→D0 | 94461.123 | 94578.346 | 117.223 |
| applyPending | D4→D0 | 94456.787 | 94579.366 | 122.579 |
| applyDownloadedChanges | D5→D0 | 94586.243 | 94759.296 | 173.054 |
| applyPending | D5→D0 | 94582.056 | 94760.131 | 178.075 |
| applyDownloadedChanges | D6→D0 | 94766.113 | 94884.016 | 117.903 |
| applyPending | D6→D0 | 94761.810 | 94884.791 | 122.981 |
| applyDownloadedChanges | D7→D0 | 94939.595 | 95057.543 | 117.948 |
| applyPending | D7→D0 | 94886.446 | 95058.437 | 171.991 |
| applyDownloadedChanges | D8→D0 | 95064.376 | 95180.412 | 116.037 |
| applyPending | D8→D0 | 95058.979 | 95181.389 | 122.410 |
| applyDownloadedChanges | D9→D0 | 95185.567 | 95389.909 | 204.342 |
| applyPending | D9→D0 | 95181.916 | 95391.033 | 209.118 |
| host.dispose | host | 95440.970 | 95455.124 | 14.154 |
| storage.dispose | A | 95455.508 | 95495.472 | 39.963 |
| storage.dispose | B | 95495.664 | 95506.127 | 10.462 |
| storage.dispose | D0 | 95506.305 | 95519.286 | 12.981 |
| storage.dispose | D1 | 95519.465 | 95527.166 | 7.701 |
| storage.dispose | D2 | 95527.351 | 95533.269 | 5.918 |
| storage.dispose | D3 | 95533.429 | 95541.878 | 8.449 |
| storage.dispose | D4 | 95542.057 | 95556.175 | 14.119 |
| storage.dispose | D5 | 95556.615 | 95570.692 | 14.076 |
| storage.dispose | D6 | 95570.846 | 95594.607 | 23.760 |
| storage.dispose | D7 | 95594.816 | 95639.692 | 44.876 |
| storage.dispose | D8 | 95639.921 | 95665.844 | 25.923 |
| storage.dispose | D9 | 95666.050 | 95691.355 | 25.305 |
| rm | root | 95691.598 | 95723.886 | 32.288 |

## 历史样本不覆盖

| 原job | 原结果 | S108 / cleanup / Errors |
| --- | --- | --- |
| 20261105004819-87e02a | exit1，1916passed/2failed/20Docker skip | 184280ms>180s；afterAll10s超时；Failed Suites1/Errors1/onTaskUpdate |
| 20261105011308-be9c71 | exit1，1917passed/1W69failed/20Docker skip | 42730ms通过；无cleanup/RPC/Errors |
| 20261105013305-65a692 | exit1，1916passed/2failed/20Docker skip | 183077ms>180s；无hook/RPC/Errors |
| 20261105020220-6dc310 | 后继main628依赖组合，exit1，1930passed/1W69failed/22skip | 37894ms通过；无Errors；22=20Docker+当时2禁用Value，不代表后继恢复候选 |

原失败首栈仍在87e02a.log:797-827、:838-856及65a692.log:849-880，不擦除。
本次没有新失败首栈可报，不能用成功样本反推或替换那些栈。诊断额度已使用，收尾后结束。
