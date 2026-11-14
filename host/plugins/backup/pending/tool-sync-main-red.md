# main-red：治理工具sync入口30秒超时（2026-11-05）

## 原始全量失败（不可由定向通过覆盖）

- 来源：`/home/dsdev/dev/deep-student/.oc-runs/fulltest/latest.json`，读取时head=`3f794390c5f8b18d9cbc9c0fa54f8579cd186ff2`，at=`2026-11-05T10:01:01.691Z`。
- 文件：`host/plugins/backup/tests/governance-tool-execution.test.ts`。
- 原失败标题：`sync_status uses real L20 local status and sync_run rejects unconfigured SSOT before cloud execution`。
- duration=`30070.833742999996` ms。没有原进程exit数值或业务阶段证据；不从JSON状态推断这些信息。
- 同文件其余四例passed，duration分别为21896.653018、24803.901401、28375.234162、29450.369625ms。
- 原failureMessages内容：

```text
Error: STACK_TRACE_ERROR
    at task (file:///home/dsdev/dev/deep-student/node_modules/@vitest/runner/dist/chunk-hooks.js:638:27)
    at Object.<anonymous> (file:///home/dsdev/dev/deep-student/node_modules/@vitest/runner/dist/chunk-hooks.js:662:16)
    at Object.<anonymous> (file:///home/dsdev/dev/deep-student/node_modules/@vitest/runner/dist/chunk-hooks.js:458:28)
    at chain (file:///home/dsdev/dev/deep-student/node_modules/@vitest/runner/dist/chunk-hooks.js:369:14)
    at /home/dsdev/dev/ds-fulltest/host/plugins/backup/tests/governance-tool-execution.test.ts:125:1
    at processTicksAndRejections (node:internal/process/task_queues:104:5)
    at VitestExecutor.runModule (file:///home/dsdev/dev/deep-student/node_modules/vite-node/dist/client.mjs:397:4)
    at VitestExecutor.directRequest (file:///home/dsdev/dev/deep-student/node_modules/vite-node/dist/client.mjs:375:3)
    at VitestExecutor.cachedRequest (file:///home/dsdev/dev/deep-student/node_modules/vite-node/dist/client.mjs:189:11)
    at VitestExecutor.executeId (file:///home/dsdev/dev/deep-student/node_modules/vite-node/dist/client.mjs:166:10)
    at collectTests (file:///home/dsdev/dev/deep-student/node_modules/@vitest/runner/dist/chunk-hooks.js:1174:4)
    at startTests (file:///home/dsdev/dev/deep-student/node_modules/@vitest/runner/dist/chunk-hooks.js:1817:17)
    at file:///home/dsdev/dev/deep-student/node_modules/vitest/dist/chunks/runBaseTests.9Ij9_de-.js:117:26
    at withEnv (file:///home/dsdev/dev/deep-student/node_modules/vitest/dist/chunks/runBaseTests.9Ij9_de-.js:84:3)
    at run (file:///home/dsdev/dev/deep-student/node_modules/vitest/dist/chunks/runBaseTests.9Ij9_de-.js:109:2)
```

这与已核Vitest的30秒deadline占位栈一致，不是sync业务断言反例；但原记录没有阶段信息，不能据此断言CPU根因、F3迁移或L20接口必然导致原失败。

## 有效诊断与修改范围

- 本轮未发现本文件/治理执行器/L20 status在相关main历史中有新接口变化，不派无证据的跨owner接口返工。
- 仅加阶段元数据后的原单例：queued `20261105101043-6636d7`，Node1passed/4filtered/exit0，无Errors；6380ms，未复现原timeout。
  JSON：`/tmp/opencode/l21-main-red-sync-stages.json`。
- 同一用例内累计耗时：host0.54ms、migration开始784.38ms、runAll返回6069.99ms、worker关闭后6081.85ms、session/registry后6267.26ms、sync_status后6338.74ms、sync_run拒绝后6343.10ms。
  冷worker加载与完整迁移合计5285.60ms；本次两个sync工具路径合计约75.84ms。它只定位当前定向成本，不是原全量阶段重放或压力根因证据。
- 自有fixture原来每例创建并销毁F3 worker、重复冷载模块。现改为文件内懒建同一个**正式**F3 runner；每例仍针对独立新Host/四库在原用例预算内完整runAll并断言success，不复用数据库/报告/预制schema。
- 不增加30秒预算，不移迁移到beforeAll/hook，不改skip/fails/错误预期或旧业务断言；正常afterEach仅drain已提交任务后dispose Host，afterAll关闭worker并清理其独立临时根，不把业务迁移移到清理hook。
- 原红入口的task.meta保存`governance_stages`与实际迁移报告耗时/thread_id/逐库结果。之后fulltest应保留这些meta；若仍超时，据最后完成阶段再处理，不用成功子集消除原失败。
- 生命周期修改影响本文件全部五例，因此只验证这一个文件的Node/Electron，不跑全目录、压力或其它已签专项。具体提交与新作业/exit/Errors见LANE最新记录。

## 修后文件验证（非受控负载A/B）

- 实现由协调者自动检查点 `cf48db6ed` 保存；本文原失败由 `b1e43babb` 保存。解释性fix(main-red)提交关联这些实际代码，不重复覆写或改写检查点历史。
- Node `20261105101718-6d271e` / Electron `-9b73c3`：本文件各5 passed/0 skip/exit0，无Errors；原红项13484.39/13905.82ms。
- 修后原红项metadata：Node迁移阶段12305.66ms，实际F3报告12296ms；Electron迁移阶段12837.73ms，实际报告12657ms，均同一worker thread_id=1；vfs/llm_usage/chat_v2/mistakes的applied_count分别71/8/29/23且全部success，证明没有用缓存报告跳过实际迁移。
- 两工具实际阶段合计：Node28.23ms、Electron80.58ms；本次主要耗时仍是实际迁移，不能声称复用worker消除了所有潜在慢阶段或原全量根因全由cold-load解释。JSON分别保存在 `/tmp/opencode/l21-main-red-sync-reuse-node.json` 与 `...-electron.json`。
- strict `20261105101718-dfbaec` 一文件0违规/exit0，无Errors。首typecheck `-b54602` exit2，仅本次新增TaskMeta直接字段写的两条TS2339；改为等价Object.assign写公开meta，不加cast/改内核或依赖。修后typecheck `20261105102346-7b9357` exit0，无Errors；这两种等价元数据赋值不改变已验证的迁移/业务调用或断言，未再次循环测试求绿。

结论：自有重复冷启动已优化、原业务链保持；原fulltest失败保留，待下一正常主线全量复验，不能称全量根因已闭合。Value两真红、AP0137原30秒、issue1/W69/P36及跨owner未决不受此修改影响。
