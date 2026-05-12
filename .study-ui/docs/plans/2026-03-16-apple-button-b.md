# Apple Button B Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将通用按钮与 shell 按钮收敛为更接近 macOS AppKit 的紧致、克制、轻材质风格。

**Architecture:** 保持现有 `Button` / `ShellButton` API 基本不变，优先通过 variant 样式重构与少量语义 token 调整视觉气质，避免大面积调用方改造。先写源码契约测试锁定按钮尺寸、圆角、边界与状态，再最小化修改 primitives 和共享类名，最后跑相关测试与 lint。

**Tech Stack:** React 19、TypeScript 5.9、Tailwind CSS v4、CVA、Node test runner

---

### Task 1: 锁定按钮方案 B 契约

**Files:**
- Create: `docs/plans/2026-03-16-apple-button-b.md`
- Create: `src/components/ui/button.source.test.ts`
- Create: `src/components/shell/ShellButton.source.test.ts`
- Modify: `src/components/content/settings-actions.test.ts`

**Step 1: Write the failing test**
- 断言通用按钮默认高度收敛到 `h-9`、圆角为 `rounded-lg`。
- 断言 `outline` 变体具备真实边框，不再只是 ghost。
- 断言 `primary` 不再使用 `shadow-sm` / `rounded-xl`。
- 断言 shell 的 `icon` / `nav` 按钮使用同一套轻量 hover/active 背景。

**Step 2: Run test to verify it fails**
Run: `node --test --experimental-strip-types src/components/ui/button.source.test.ts src/components/shell/ShellButton.source.test.ts src/components/content/settings-actions.test.ts`
Expected: FAIL，提示现有按钮仍使用 `rounded-xl`、`h-10`、缺少 outline border。

### Task 2: 实现按钮方案 B

**Files:**
- Modify: `src/components/ui/button.tsx`
- Modify: `src/components/shell/ShellButton.tsx`
- Modify: `src/components/content/settings-actions.ts`

**Step 1: Write minimal implementation**
- 将 `Button` 重构为更紧致的 36px 控件，统一 `rounded-lg`。
- 让 `primary` / `secondary` / `outline` / `ghost` 分别对应 prominent / tonal / bordered / plain 的系统控件语气。
- 让 `ShellButton` 的 `icon` / `nav` 使用更克制的 toolbar 风格状态。
- 同步设置面板表面按钮的共享类名，避免覆盖回旧圆角。

**Step 2: Run test to verify it passes**
Run: `node --test --experimental-strip-types src/components/ui/button.source.test.ts src/components/shell/ShellButton.source.test.ts src/components/content/settings-actions.test.ts`
Expected: PASS

### Task 3: 回归验证

**Files:**
- Verify only

**Step 1: Run targeted regression tests**
Run: `node --test --experimental-strip-types src/components/content/SettingsDemoPanel.source.test.ts src/components/content/settings-demo-sections.source.test.ts src/components/content/SettingsPanel.source.test.ts src/components/content/ThreadCanvas.source.test.ts`
Expected: PASS

**Step 2: Run lint**
Run: `npm run lint`
Expected: PASS
