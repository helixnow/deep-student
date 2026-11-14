# U1-ui-boot 当前状态

更新：2026-11-04。规格 `docs/plugins/FRONTEND-F1.md`；完整证据与历次门禁在
`docs/dev/electron-migration/audits/U1-ui-boot.md`。前端 lane 无 TESTMAP，等价性证据为 boot golden。

## 状态：已完成（U1 范围内无剩余工作；一项待架构师裁定）

- 主窗口 normal/web-preview 与两个 demo 入口经 `createAppUiKernel` + `UiKernelProvider` 装配；轻量窗按 §6.1 保持原实现。
- 官方 glob 安装器传 `origin: 'builtin'`，`UiPluginLoader` 传 `community`，默认 `community`；
  `SlotEntry.origin`、`useOptionalSlot`、SDK 导出已发布，U2/U3/U4 已接入（R6-10 已关闭）。
- 16 组冻结 boot golden 与固定旧源回放 `legacy-boot-evidence.test.ts`；R6 已接受五处 golden 补救。
- 已在 main：`73f2e9462 merge ds-mig/U1-ui-boot`。

## v2 自查（2026-11-04）

- 1.7 清理：`UiPluginLoader.sync` 一次失败（如畸形清单）会让内部队列永久处于 rejected，
  之后的清单不再对账，`dispose()` 也不再卸载已装插件。已修复：失败只回给本次调用方，队列继续。
  回归测试 `src/ui-kernel/__tests__/loader.test.ts` "keeps reconciling and still disposes after one manifest sync rejects"：
  修复前作业 `20261104122346-df7a98` 退出码 1（1 failed / 7 passed），修复后受影响目录作业
  `20261104123216-10c24a` 退出码 0（10 文件 47 passed）。
- 1.2 / 1.3：U1 不写任何表；清单来自本仓 Host 内核 `host/kernel/runtime.ts:156` 的类型化输出，
  加载器对模块导出与 id 一致性做运行时校验，畸形整体清单由上述修复保证不阻塞后续。

## 待裁定（不属于 U1 可自行完成的事项）

- R6-03 / §6.1 首帧：Cordis `Fiber._reload()` 先等待一个 microtask，官方注册无法同步完成。
  当前实现为“原 BootShell → await 官方装配完成 → 首个正常 App/Provider 树”，未宣称同步，未改 Cordis。
  已由 C1 上报 `081915453`，等待架构师裁定后再做针对性变更。
