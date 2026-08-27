# Wave2 会话 C · 第 8 轮 · 红灯归因（input-bar lint 存量 + 硬门禁 1）

- 分支：`cursor/0824-wave2-mobile-uiux-a875`
- 范围：`src/features/chat/components/input-bar/**/*.{ts,tsx}`
- 本轮命令：`npx eslint … --max-warnings 999`、`npm run version:generate && npm run typecheck`
- 未跑（按任务约定留给后续轮/父代理）：vite build、cargo、check-migrations
- 本轮未改任何源码；唯一新增文件即本报告。

## 1. Lint 结果（input-bar 目录）

ESLint 退出码 **0**：**0 error / 84 warning**（`--max-warnings 999` 下不触发红灯）。

### 按规则计数

| 规则 | error | warning |
| --- | --- | --- |
| `ds-components/coarse-touch-target` | **0** | **0** |
| `ds-components/no-arbitrary-font-size` | 0 | 38 |
| `ds-components/no-native-button` | 0 | 20 |
| `no-restricted-syntax`（裸 window/document.addEventListener） | 0 | 19 |
| `no-console` | 0 | 5 |
| `react-hooks/exhaustive-deps` | 0 | 2 |
| 合计 | **0** | **84** |

`coarse-touch-target` 在 input-bar 目录已完全清零（leftover 替换生效），无需手贴 `!min-h-11`，也没有散点需要登记给下一批机制。

### 剩余 warning 按文件分布（供后续机制批参考，本轮不改）

| 文件 | 规则与条数 |
| --- | --- |
| `AttachmentPanelBody.tsx` | no-arbitrary-font-size ×3 |
| `AttachmentPreviewChips.tsx` | no-native-button ×2 |
| `BlockingApprovalBar.tsx` | no-arbitrary-font-size ×5、exhaustive-deps ×1 |
| `BlockingAskUserBar.tsx` | no-native-button ×2、no-arbitrary-font-size ×1 |
| `ComposerPanel/ComposerPanel.tsx` | no-arbitrary-font-size ×5 |
| `ComposerPanelOverlay.tsx` | no-restricted-syntax ×2 |
| `ComposerPlusMenu.tsx` | no-arbitrary-font-size ×9、no-native-button ×3 |
| `ComposerTextarea.tsx` | no-arbitrary-font-size ×2 |
| `ComposerToolbar.tsx` | no-arbitrary-font-size ×4、no-native-button ×5 |
| `ContextUsagePopover.tsx` | no-native-button ×1、no-arbitrary-font-size ×1 |
| `InputBarUI.tsx` | no-restricted-syntax ×10、exhaustive-deps ×1 |
| `ModelPicker.tsx` | no-arbitrary-font-size ×9、no-native-button ×3、no-restricted-syntax ×2 |
| `QueueErrorBar.tsx` | no-native-button ×3 |
| `QueuedMessageBubble.tsx` | no-native-button ×2 |
| `RuntimeModelMenu.tsx` | no-restricted-syntax ×2 |
| `SkillSlashPopover.tsx` | no-restricted-syntax ×1 |
| `__tests__/InputBarUI.appMenuOutsideClick.pointer.test.tsx` | no-restricted-syntax ×1 |
| `__tests__/ModelPicker.mobileSearchCompact.source.test.ts` | no-arbitrary-font-size ×1 |
| `useInputBarV2.ts` | no-console ×5 |
| `usePdfPageRefs.ts` | no-restricted-syntax ×1 |

## 2. 硬门禁 1：version:generate + typecheck

- `src/version.ts` 本轮开始时已存在（且被 gitignore，重新生成不脏工作区）。
- `npm run version:generate`：成功（App version 0.9.44，Build 16416，git hash 900e7a33）。
- `npm run typecheck`（`tsc --noEmit -p tsconfig.json`）：**退出码 0，绿**，无任何错误输出（首个错误：不存在）。一次跑通，未重跑。

## 3. 归因

| 项 | 状态 | 归因 |
| --- | --- | --- |
| coarse-touch-target error | 0（全清） | 本波 leftover 机制替换已生效，无本波回归 |
| 84 条 lint warning | 非红灯（均为 warning，不触发 max-warnings） | **既有债**：字号 token / DsButton / 事件封装迁移的存量，非本波引入，留给机制下一批 |
| typecheck | 绿 | 无红灯；不存在 version.ts 缺失问题（本轮开始时已生成） |
| 环境 | 正常 | node_modules 完整，eslint/tsc 均一次跑通，无环境阻塞 |

结论：本轮范围内**没有红灯**。input-bar 的 lint 全部是既有债 warning；两项硬门禁的第一项（version:generate + typecheck）绿。vite build / cargo / check-migrations 未验证，红灯与否留待后续轮判定。

## 4. 声明

- **不为变绿改 workflow**：本轮未改任何 CI workflow 文件，后续也不通过放宽 CI 配置的方式消红。
- 本轮未改任何产品源码、未改禁改区；工作区中 `docs/dev/wave2-C-ledger.md` 与 `tests/vitest/mobile-uiux/touchTargetOwnership.contract.test.ts` 的未提交改动来自并行会话，非本轮产生。
- 未 commit / 未 push（按任务约定）。
