# X2 验证记录（2026-11-04）

## 工具定向测试

`node --test scripts/electron-migration/frontend-audit/audit.test.ts`

```text
tests 26
pass 26
fail 0
duration_ms 22438.347215
```

`node node_modules/typescript/bin/tsc --noEmit --skipLibCheck --target ESNext --module ESNext --moduleResolution bundler --allowImportingTsExtensions --esModuleInterop --strict scripts/electron-migration/frontend-audit/audit.ts scripts/electron-migration/frontend-audit/audit.test.ts`

退出 0，无输出。只检查审计工具及其测试，不混入其他 lane 的 WIP。

## 实际加载探针

`node scripts/electron-migration/frontend-audit/registry.ts --probe-kernel host/kernel/runtime.ts`

```text
kernel.builtins: plugin:host|call, plugin:host|status, plugin:ui|manifest
basis: kernel-registration
```

`node scripts/electron-migration/frontend-audit/registry.ts --probe electron/index.ts`

成功读取 `dstu.shell / F2-shell` 的 23 条命令；不执行 apply。
当前官方 profile 未列此模块，不能计为已加载的 Host 命令覆盖。

## 恢复检查

按协调者要求运行 `git log --oneline -20`、`git status`，确认自动检查点仍在。
本 lane 无既有 Rust TESTMAP；新增工具测试映射见同目录 `TESTMAP.md`。

`npm run migration:ledger -- --check --no-write` 退出 1：

```text
ledger: commands 1058 (A 88.8% B 1.8% C 0%), tests 8036 (A 70.3% B 0.4%);
problems: commands 0, tests 250, orphan registrations 0;
checkCoverage（host/kernel/coverage.ts）
```

该命令用于了解迁移全局状态；未据此修改任何其他 lane。

## 全量对账与门禁

最新调用点、命令、事件、按 lane 的问题以 `result.json` 和
`docs/dev/electron-migration/audits/X2-frontend-contracts.md` 为准。

`node scripts/electron-migration/frontend-audit/audit.ts` 退出 0：

```text
totalSites 1673; productionSites 1663; testSites 10
invokeSites 1447; listenSites 180; emitSites 36
frontendCommands 980; contractCommands 1058; hostCommands 756
frontendCommandsInContract 918; frontendCommandsInHostMeta 656
frontendCommandsWithShellRoute 2; frontendCommandsMissingHostMeta 322
hostCommandsMissingContract 0 (kernel extensions listed separately)
frontendEventNames 132; contractEventNames 112 (127 contract records)
matchedEventNames 76; eventNamesWithoutContract 52; unresolved event-name forms 4
errors 509; review 296; info 5
```

34 个 profile 模块全部导入成功；另从真实空 HostRuntime 注册表取得 3 个内核命令。
6 个计算型命令表达式已穷举；未解析动态命令 0 个。

检查累计改动清单，仅含允许的脚本目录和指定审计 Markdown，未改动 src/、host/ 或 electron/。

普通模式写这两份报告；`--check` 重新扫描但不写报告，现有 error/review 应使其退出 1。

实际执行 `node scripts/electron-migration/frontend-audit/audit.ts --check`：退出 1，
统计与普通模式完全一致（509 error / 296 review / 5 info），不是工具故障的退出 2。
用 Node spawnSync 执行并断言退出码，同时比较执行前后两份报告的 mtimeMs 与 size，
验证结果：

```text
check-smoke: expected exit=1; JSON and Markdown mtime/size unchanged
```
