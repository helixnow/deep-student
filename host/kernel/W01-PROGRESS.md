# W01 进度（kernel / platform errors / log / native / diagnostics / 根 eslint 配置）

只记还没做完的事项与它们在等什么；已完成的看 git log（`[W01]` 前缀）与 `.reports/agent-final/W01-*.md`。

## 本轮（审计高危清零，开工合入 INT 390f244b → 9f4323c3，中途合入 2be7ed80 → 3b0efb97）

| 项 | 状态 | 提交 / 位置 |
|---|---|---|
| V09-P1-2 backgroundTasks 归属与关停 | 已提交 | `65436d49`、`86b7268b`；交接 `.reports/W01-handoffs/backgroundTasks-interface.md`（根仓库未跟踪文件） |
| V08-01 Value 位置普通 JSON | 已提交 | `3d62ab9f`；`call.exactPayload()` 为 opt-in；现有插件无依赖入参原子的代码 |
| V08-02 TestHost.invoke 默认 argsJson | 已提交；**不能单独 revert**：`be871cb1` 的 `commands.test.ts:65,66,97` 用 `e02c72bd` 引入的 `host.invokeRaw`，`:68,69,98` 断言 argsJson 路径的 `invalid number`，回退须两条一起（A13 M4） | `e02c72bd`、`be871cb1`（commands.test 旧路径文本改走 invokeRaw）；E 趟影响面见 `.reports/W01-handoffs/E-train-fallout.md` |
| V09-P1-1 内核关停上限 + `host/exiting` | 已提交 | `dde2f603`；阶段上限合计 5500 ms，SIGTERM 兜底 6000 ms，外壳预算建议 7000 ms（交接 W06 `electron/shell/host.ts:315`）；`host/exiting` 交接 W02 |
| V05-02 + V08-04 错误文本 | 已提交 | `d3f33181`、`fd9f8cd2`（portable-entry 运行时值清单）；W04 `errorText` 改 `errorDisplay` 待交接 |
| V04-12 插件自启动时机 | 已提交 | `82725d53`、`2ea018ce` |
| S01-r3 M1 profile data: 模块 | 已提交 | `8958fd8f`、`2ae98093`；W27 SECURITY.md §6 待更新 |
| caller 默认翻转（SEC-E06 K2） | 已提交 | `412c9fef`；交接 `.reports/W01-handoffs/K2-caller-require.md`（W23/W06 residency caller、W14 mobile 单测、W27 examples 两条 INT 既有失败） |
| community-example | 前端配置下 3/3 通过 | `src/ui-kernel/__tests__/community-example.test.tsx`（`vitest.config.ts`） |
| V10-P3-6 模块来源盘符大小写 | 已提交 | `b73c013c`；符号链接不处理（可移植内核没有 realpath；方向只会把内置判成社区，更严） |
| V10-P3-5 sqlite-busy 预编译 | 无需改动 | 生产不调用 `setBusyHandler`（用 busy_timeout），预编译不进包（`electron-builder.config.cjs:68`） |
| V08-10 生产环境非 JSON 结果防线 | 已提交（下一轮） | `json.ts::plainWireOutput`：命令结果、`CommandError` 值、事件载荷三处出口；原型检查借 `toWireJson` 那趟遍历，命中时按 `toPlainJson` 投影并记 warn，不抛错；测试 `tests/non-json-projection.test.ts` |
| W27 指出的 API.md 过期行 | 已提交 | `256a36b5` |
| 交付前 | 门禁全过（tsc 0 错误，`77066919` 修了本轮测试夹具的类型） | 合并扫描 457 个文件，3 个失败：wave0 两个是端口 47110 被其他 lane 的进程占用；`chat/continue-command.test.ts:82` 是 V08-02 暴露的旧路径 f32 断言（生产代码没变，交接 W10） |

## E 趟轮（合入 INT 1d1fdb78 → d02eb3dc）

| 项 | 状态 | 提交 / 位置 |
|---|---|---|
| E 趟（`e02c72bd` + `412c9fef`）影响面 | 不建议推迟；需改语义的只有 W02 `skill-candidates-ipc.test.ts`、W10 `continue-command.test.ts` 两个文件，补丁已验证 | `.reports/W01-handoffs/E-train-fallout.md` |
| A13 必须修 M1–M4 | M1/M2 补丁写进交接并验证，M3 交接 §5 作废，M4 `3e15f62a` | `.reports/audit/reviews/W01-6e4d9c7f.md` |
| A13 建议 F6 | 已提交 | `daea7a10` |
| A13 建议 F1（storage / log 关停保底） | 已提交 | `runtime.ts::CORE_DISPOSE_RESERVE_MS`，测试 `tests/shutdown-bounds.test.ts` |
| A13 建议 F7 | V08-10、事件名两项已做；argsJson 与对象路径 f32 解码不一致、eslint 规则仍待跟进 | — |
| A13 建议 F2、F3 | 未做 | F2 要给根上下文拥有的 `plugin:host\|call` 在阶段 A 单独中止，需要设计；F3 是热重载边角情况 |
| A13 建议 F4、F5 | 不归 W01 改 | F4 是计时断言，不放宽；F5 归各提交方接入 signal |
| 插件事件名（Tauri 事件名规则） | 已提交 | `aa543450`；W17/W27 用法见 `.reports/W01-handoffs/event-name-rule.md`；社区插件 Host 半边没有发事件的入口（`backendEvents` 只给内核），待补带作用域的 emitter |
| S01 fd 3 就绪管道 | 已提交；Linux bwrap 用例本机未跑 | `ac206d92` |
| W31 LA-09 `acl-files.ts` 拆分、android/ios 平台 | 未做：拆分要动 lane 外 16 处调用；平台联合类型放宽后 tsc 45 个错误 | `.reports/W01-handoffs/LA-09-acl-platform.md` |

## 长期待办

| 事项 | 状态 | 等待 | 位置 |
|---|---|---|---|
| SEC-E06 K3–K7（同意记录、进程隔离、子进程运行时、移除同进程装载、安装期拒绝） | 未开工 | 见计划中的前置条件（W06 utilityProcess、W17 同意界面、W09 gate、安装器 P1） | `SEC-E06-HOST-ISOLATION-PLAN.md` |
| `host/platform/API.md` 按 W14 交接更正（`:107`、`:119-120`、`:274-275`、`:494` 后加 `openFile` 行、`:576-577`、`:702-703`） | 未改 | W14 `8442f1f4` 进入 INT | `host/platform/API.md` |
| SEC-E05 Host 侧消费 | Host 已按消息级 `native` 标记 `source.native` | W06 `electron/main.ts` 用 `nativeBrowserContentEvent`；之后 W05 `surface-host.ts:183-185` 只认 `source.native === true` | `events.ts::_deliverFrontend` |

## 已知的非 W01 失败（只记录）

- `host/platform/storage-mobile/tests/storage-entries.test.ts:28`：`profile-isolation.test.ts` 已不再从 storage 入口导入，这一行登记过期，待 W14 删除。
- INT 2be7ed80：`examples/plugins/community-word-of-day/__tests__/word-of-day.test.tsx:63`、`examples/scripts/__tests__/create-plugin.test.ts:63`
  在根上下文调 `kernel.ui().host`，被 `src/ui-kernel/kernel.ts:577` 拒绝（W17 `bdd76587` 之后）；默认 `'warn'` 下同样失败。归 W27。
