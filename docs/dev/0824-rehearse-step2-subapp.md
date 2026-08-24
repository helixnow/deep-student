# 0824 Step2 预演：F subapp 合入

日期：2026-08-24  
预演分支：`cursor/0824-rehearse-step2-subapp-cde6`  
基线：`origin/cursor/0824-cde6` @ `eec20398`（已含 Step2 与 leftovers）  
被合入：`origin/cursor/0824-theme-subapp-cde6` @ `575fee7f`

结论：**可合**。合并、前后端编译门禁和冲突面定向回归均通过；本轮没有修改
`main` 或回推 `cursor/0824-cde6`。

## 合并结果

- 合并提交：`e1425528`（双亲为 `eec20398`、`575fee7f`）。
- 题库契约静默碰撞修复：`6ea10cb6`。
- Git 报告 4 个冲突路径：
  - `package-lock.json`：保留 Step2 基线侧。F 的 lock 仍带已由 optimization0824
    删除的 `@anthropic-ai/claude-code` 等依赖；最终 manifest、lock 与
    `legal/THIRD_PARTY_NOTICES.txt` 的优化结果保持一致。
  - `public/legal/THIRD_PARTY_NOTICES.txt`：保留基线删除结果。许可证清单的唯一
    权威路径继续是 `legal/THIRD_PARTY_NOTICES.txt`。
  - `src/features/chat/skills/builtin-tools/qbank-tools.ts`：保留 F 的每日练习
    `count <= 50`、可选 `daily_target` 和必填字段说明，与自动并入的 Rust
    executor、store 及 F 自带测试一致。
  - `src/features/workbench/components/WorkbenchDesktop.tsx`：取并集，保留 Step2
    的 `DesktopAiBriefingWidget` 与 F 的 `ImmersiveHint`；“显示桌面组件”开关同时
    控制日程和 AI 简报，避免窄工作区被任一组件占用。

## 静默契约碰撞

首次定向回归发现 `phase4QbankToolsContract.test.ts` 有 7 项失败。相关行没有形成
Git 文本冲突：Step2 侧压缩了工具描述，而 F 新增断言要求描述明确暴露
`fieldsTruncated`、不可复用授权、UI handoff 持久性等机器可读契约。

`6ea10cb6` 仅补回这些契约字符串，没有改变 schema 或执行逻辑；随后同一组测试
全部通过。

## 门禁

| 命令 | 结果 |
| --- | --- |
| `npm ci` | ✅ 依锁安装 1192 个包 |
| `npm run build` | ✅ `version:generate`、`licenses:check`、`typecheck`、Vite production build 全通过 |
| `cargo +stable check --manifest-path src-tauri/Cargo.toml --lib --locked` | ✅ Rust 1.98；24 条既有 warning，无 error |
| `npx vitest run src/features/chat/skills/__tests__/phase4QbankToolsContract.test.ts tests/vitest/workbench/workbench-shell-ux.test.tsx src/features/workbench/components/__tests__/DesktopAiBriefingWidget.test.tsx` | ✅ 3 files / 30 tests |

Vite 仍输出既有的 renderer chunk 环依赖、动态/静态 import 和大 chunk 警告，但不影响
构建成功。本机 Rust 验证前补装了 stable、Linux Tauri 开发包并下载 gitignored 的
PDFium 动态库；下载脚本改写的已跟踪 license 文本已还原，环境产物未进入提交。
