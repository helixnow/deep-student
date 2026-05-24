# Button Tokens And Size Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将按钮默认尺寸再收小一档，并为 light/dark 主题补齐统一的按钮专用材质 token。

**Architecture:** 保持现有 `Button`、`ShellButton` API 不变，只把尺寸和视觉材质从类名硬编码迁移到 `src/styles/app.css` 语义 token。先补源码契约测试锁定 token 和尺寸，再最小化修改按钮 primitives 与共享设置按钮类名，最后做回归验证。

**Tech Stack:** React 19、TypeScript 5.9、Tailwind CSS v4、CVA、Node test runner

---

### Task 1: 写失败测试锁定按钮 token 与更小尺寸

**Files:**
- Modify: `src/styles/app.source.test.ts`
- Modify: `src/components/ui/button.source.test.ts`
- Modify: `src/components/shell/ShellButton.source.test.ts`

**Step 1: Write the failing test**
- 断言 `app.css` 定义 `--button-height`、`--button-prominent-bg`、`--button-outline-border` 等 token，且 dark theme 也有覆盖。
- 断言 `Button` 使用 `var(--button-...)`，默认高度收敛到 `h-[var(--button-height)]`。
- 断言 `ShellButton` 也复用按钮 token，而不是继续硬编码颜色值。

**Step 2: Run test to verify it fails**
Run: `node --test --experimental-strip-types src/styles/app.source.test.ts src/components/ui/button.source.test.ts src/components/shell/ShellButton.source.test.ts`
Expected: FAIL，提示按钮 token 尚未定义，尺寸仍为旧类名。

### Task 2: 实现按钮 token 与尺寸收敛

**Files:**
- Modify: `src/styles/app.css`
- Modify: `src/components/ui/button.tsx`
- Modify: `src/components/shell/ShellButton.tsx`
- Modify: `src/components/content/settings-actions.ts`

**Step 1: Write minimal implementation**
- 在 `app.css` 的 light / dark token 区定义按钮专用尺寸与材质变量。
- 让 `Button` 与 `ShellButton` 改用这些 token。
- 将默认按钮缩到更接近 32px 的桌面控件尺度。
- 更新设置页共享按钮类名，避免保留旧硬编码视觉。

**Step 2: Run test to verify it passes**
Run: `node --test --experimental-strip-types src/styles/app.source.test.ts src/components/ui/button.source.test.ts src/components/shell/ShellButton.source.test.ts src/components/content/settings-actions.test.ts`
Expected: PASS

### Task 3: 做按钮相关回归验证

**Files:**
- Verify only

**Step 1: Run targeted regression tests**
Run: `node --test --experimental-strip-types src/components/content/SettingsDemoPanel.source.test.ts src/components/content/settings-demo-sections.source.test.ts src/components/content/SettingsPanel.source.test.ts src/components/content/ThreadCanvas.source.test.ts`
Expected: PASS

**Step 2: Run lint**
Run: `npm run lint`
Expected: PASS
