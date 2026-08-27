# Wave2-C R8 mobile 契约族 Vitest 记录

日期：2026-08-26（UTC）

## 前置

- 分支：`cursor/0824-wave2-mobile-uiux-a875`
- `src/version.ts` 缺失，已执行 `npm run version:generate`，退出码 `0`。
- 未执行 `npm ci`。
- 模型降级：否；本轮未触发到 `gpt-5.6-sol-high-fast` 的显式降级。Cloud run 元数据未暴露精确子档位（`originalModelName: null`），因此无法从运行内独立核验 `xhigh-fast` 标签。

## 结果

| # | 命令 | 退出码 | passed / failed | 结论与失败根因 |
|---|---|---:|---|---|
| 1 | `npx vitest run src/app/navigation/__tests__ --reporter=dot` | `0` | 3 files / 29 tests passed；0 failed | 通过 |
| 2 | `npx vitest run src/hooks/__tests__/useKeyboardHeight.contract.source.test.ts --reporter=dot` | `0` | 1 file / 18 tests passed；0 failed | 通过 |
| 3 | `npx vitest run src/components/shared/__tests__ --reporter=dot` | `0` | 5 files / 21 tests passed；0 failed | 通过 |
| 4 | `npx vitest run tests/vitest/mobile-uiux --reporter=dot` | 首轮 `1`；复跑 `0` | 首轮 10 files / 139 tests passed，1 file / 1 test failed；复跑 11 files / 140 tests passed | **断言过期**：`touchTargetOwnership.contract.test.ts` 对源码切片直接计数 `after:-inset`，把两处解释“为何不用 after:-inset”的注释误算成类名。生产实现已使用 `--touch-target-size` token。按本轮规则仅将该断言改为校验触发器的 coarse `min-h/min-w` token，并校验内环无 coarse 命中处理；复跑通过。 |
| 5 | `npx vitest run tests/vitest/coarseTouchTargetRule.test.ts --reporter=dot` | `1` | 0 passed；1 suite failed during collection（no tests） | **环境**：测试收集时导入 `eslint-rules/coarse-touch-target.js`，其中 `readFileSync(new URL(..., import.meta.url))` 收到的 URL 不是 `file:` scheme，抛出 `TypeError: The URL must be of scheme file`。未改产品逻辑或 CI。 |
| 6 | `npx vitest run tests/vitest/check-i18n.script.source.test.ts --reporter=dot` | `0` | 1 file / 10 tests passed；0 failed | 通过 |

## 改动边界

- 改了测试：是，仅 `tests/vitest/mobile-uiux/touchTargetOwnership.contract.test.ts` 的旧散点类名断言。
- 未修改产品逻辑、`input-bar/__tests__`、workflow/CI、`coordinator.rs`、`tool_loop` 或 anki 域。
- 未 commit，未 push。
