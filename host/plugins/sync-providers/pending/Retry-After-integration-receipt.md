# L23：Retry-After 集成反馈与固定树复核

## 旧候选拒绝不等于当前实现回归

只读 `.oc-runs/gate-fail.json` 的L23记录为
`76bb271be61f03755d63791d4b88f570be260810`，at `2026-11-05T06:38:30.152Z`。
`integrate-auto-2026-11-05T063501611Z.log` / `063958165Z.log` 的摘要列出三条
`retry_after_seconds_*`新增失败，另有既有W69失败不计入新失败。

76bb于06:35:01仅提交 `tests/webdav.test.ts` 17行，源码仍为
`Number(trimmed)*1000` / `Math.min(parsed,MAX_RETRY_WAIT_MS)`；生产修复
`c14818ab5`于06:39:33提交，不是76bb的祖先。该修复保留u64精度、拒绝越界并
接受原Rust整数+前缀，断言未改。原集成实际merge/root及完整stdout未在该摘要中
取得，不能重标旧回执为新树，也未改外部gate-fail/selfgate文件。

## 按最新集成反馈要求，执行一次固定当前树的同类检查

受测HEAD **`9b5f4210f5e811790a08c3a0cb9149f6bf192abd`**，tree
**`e8d2b4e01287e76607f2b394a285974a2f971f0e`**，包含c148完整修复及W21–W23用例。
cwd `/home/dsdev/dev/ds-mig/L23-sync-providers`。提交前查无该工作树活跃同目标作业。
全部回执取回前不merge、不编辑源码/用例/配置；结束核HEAD/tree未变，相关diff空，
只有原两个外部ledger dirty。以下是原exit，不使用baseline豁免改写：

| 检查 / 命令 | Job | 原结果 |
| --- | --- | --- |
| `npm run typecheck:host` | `20261105065253-5c3a54` | exit0，无Errors |
| `npm run migration:boundaries` | `20261105065254-8da6b4` | exit0，2979files/0违规，无Errors |
| `npx vitest run -c vitest.host.config.ts host/plugins/sync-providers` | `20261105065254-247c2d` | **exit1，950passed/1failed/20Docker未执行，无Errors** |

目录job start `06:52:54.226Z` / end `06:57:27.212Z`（2026-11-05），65文件：
1failed/63passed/1skipped，Vitest270.01s。WebDAV **44/44**（log:597）、weird_sync
**46/46**（:687）通过，三个Retry-After新回归不再失败。唯一失败仍原W69
**33073.86823ms>30000**，四项10000/0/10000/10000计数断言已过。

原输出 `/home/dsdev/.oc-jobs/done/20261105065254-247c2d.log:846-854` 首栈完整保留：

```text
 FAIL  host/plugins/sync-providers/tests/weird_batch_sync.test.ts > sync weird W.69-W.70 and force-exact: large batches > w69_ten_thousand_tiny_records
AssertionError: expected 33073.86823 to be less than 30000
 ❯ host/plugins/sync-providers/tests/weird_batch_sync.test.ts:412:21
    410|     expect(result.applied_keys.size).toBe(10_000);
    411|     expect(Number(db.pluck('SELECT COUNT(*) FROM test_items') ?? 0)).t…
    412|     expect(elapsed).toBeLessThan(30_000);
       |                     ^
    413|   }, 120_000);
    414|
```

这是后继集成反馈明确要求的一次目录复核，确实覆盖P36/S108/W69等已存在用例，
不是声称“仅跑三例”或又排一个S108最小阶段诊断。该次S10836183ms通过、无hook/
RPC错误；只说明此运行未复现，不消除87e02a/65a692原失败或旧Errors1。stress日志
观测worker PID510083/poolId3/workerId3、env maxForks/maxThreads=3；cap不是实际
全程并发数，未凭该信息定CPU/旧根因。原job metadata/log保存在 `.oc-jobs/done/`。

W69生产查询仍待有权限的L20写者，未改阈值/减量/加索引。本轮不循环重测，
未宣布目录全绿/正式gate通过；外部ledger dirty仍只交infra，不隐藏/还原/混交。

## W21–W23先前独立小集的来源

源checkpoint同为9b5f4210f，唯一小集 **`20261105064400-04a877` 原exit0**，
3passed/43标题过滤、无Errors，start06:44:00.500Z/end06:44:12.431Z。
前后HEAD/tree与目标source/test/config均无变化，之后才处理新集成反馈并安排目录。
W21保初次Insert unwrap语义、再Update与真实title读取，观察v2而不要求v2；W22
updated_at仍数值1747000000000，W23两处空字符串未替换；三例均真实内存F3/已安装
sync公开apply，无catch/私造分类/时间coercion或额外成功、拒绝、落库政策断言。
各正常返回success1/failure0仅作观察。实际执行后TESTMAP仅这三行转ported，
859行最新659ported/199pending/1obsolete，生成头不动，不代替R4整lane签收。
