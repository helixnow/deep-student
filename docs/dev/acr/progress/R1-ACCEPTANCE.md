# R1 统一验收报告（协调者）

日期：2026-07-10  
分支：`nightly`（未提交；按 STANDARDS 不 commit）

## 结论

**R1 通过，进入 R2。** 前端契约与 agent 单测全绿；Rust lib 编译通过（仅既有 warning）。缺失进度报告已回填。

## 验收命令

| 命令 | 结果 |
|------|------|
| `npm run typecheck` | PASS |
| `cargo check -p deep-student --lib`（cwd=`src-tauri`） | PASS（101 既有 warning，无 ACR 相关 error） |
| `npx vitest run src/features/workbench/agent/__tests__` | **110 passed / 19 files** |

## 协调者修复（验收期）

1. `domainEvents.test.ts` / `todoFinderDriver.test.ts`：`vi.mock` 闭包 TDZ → `vi.hoisted`
2. `bridge.ts`：缓存 `emit`；`bridgeRouting` 进度双 corr 在 fake timers 下补微任务 flush

## 进度报告

| 卡 | 报告 | 状态 |
|----|------|------|
| R0.5, R1-01..05, 07, 08, 16, 17, 20 | 原有 | 已完成 |
| R1-06, 09–15, 18, 19 | 本次回填 | 代码已在，报告补齐 |

## 跨界 / 遗留汇总（喂给 R2）

| 项 | 归属 |
|----|------|
| runId vs toolCallId 权威来源 | R2-01 / R2-05 |
| 错误码表 ERRORS.md + 三端对齐；闸门 DISABLED vs UNAVAILABLE | R2-01 / R2-08 |
| qbank OCC；域事件 source 命名；用户侧 todo emit | R2-01 / R2-04 |
| mindmap dirty 建议模式升级；双窗防御 | R2-02 |
| 笔记打字机/建议/绑定全链 | R2-03 |
| ankiCardsBlock 收编；三守卫；focusQuestion | R2-04 |
| workbench_ops 恢复 / 审批聚焦 / 撤销失效 | R2-05 |
| disposeAllDrivers；仲裁一致性；输入误报 | R2-06 |
| 性能预算 / Channel 评估 | R2-07 |
| off/background/follow 定稿 + i18n | R2-08 |
| 生命周期 16 边界 | R2-09 |
| browser ControlMode；pomodoro；长尾跨界清算 | R2-10 |

## 未做（留给 R2/R3 运行时）

- 全量 `npm run lint` / `check:i18n` / 全仓 vitest（R2-08 / 协调者终验）
- SCENARIOS 冒烟（需 OS 模式运行时；R3）
- 不启动 tauri dev（纪律）

## 下一步

并行派发 **R2-01 ~ R2-10**（grok，禁 cargo），输入本报告 + ROUND2.md + 各 R1 进度「遗留/跨界」。
