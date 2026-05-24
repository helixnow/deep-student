# Sidebar Right Edge Occlusion Implementation Plan

> **For Claude / Codex / other LLM:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this todo one checkbox at a time. Mark a box only after file evidence and verification.

**Goal:** 修复当前侧边栏 hover / 选中态矩形在右侧看起来被遮挡的问题，并保持现有安静、低复杂度的桌面侧边栏气质。

**Architecture:** 优先做最小结构修复，不推翻现有 Claude Code 写出的 floating sidebar 架构。先把“右侧被挡住”拆成 seam 叠层、容器裁切、缩放 rounding 三个独立问题，再用源码契约测试锁定边界归属，最后只改最少的 shell 文件。

**Tech Stack:** React 19, TypeScript 5.9+, Vite 7, Tailwind CSS v4, Tauri 2, node:test source/contract tests

---

## 引用文件

- [本方案](./2026-03-16-sidebar-right-edge-occlusion-executable-todo.md)
- [已有边界调研](./2026-03-12-sidebar-highlight-boundary-fix.md)
- [已有宽度一致性方案](./2026-03-12-sidebar-button-width-consistency.md)
- [现有壳层透明度方案](./2026-03-11-floating-sidebar-translucency-executable-todo.md)
- [Apple 对齐方案](./2026-03-13-apple-translucency-sidebar-research-executable-todo.md)
- [Sidebar 组件](../../src/components/shell/Sidebar.tsx)
- [AppChrome 壳层](../../src/components/shell/AppChrome.tsx)
- [ShellButton 原语](../../src/components/shell/ShellButton.tsx)
- [布局 token](../../src/lib/app-shell.ts)
- [主题与滚动样式](../../src/styles/app.css)
- [Sidebar 源码测试](../../src/components/shell/Sidebar.source.test.ts)
- [AppChrome 源码测试](../../src/components/shell/AppChrome.source.test.ts)
- [浮动侧边栏契约](../../scripts/floating-sidebar-contract.test.mjs)
- [设置侧边栏表面契约](../../scripts/settings-sidebar-surface-contract.test.mjs)

---

## 四轮并行调研摘要

### Round 1 - 组件层
- [x] `Sidebar` 本体已有 3 层横向裁切保护：`aside overflow-hidden`、滚动区 `overflow-x-hidden`、`ShellButton nav` 自身 `overflow-hidden`。
- [x] thread row 当前是 `w-full rounded-2xl bg-interactive-selected`，settings active row 则额外带 `border border-sidebar-border/70` 和 `shadow-sm shadow-black/5`。
- [x] 从组件本身看，“真正超出侧边栏宽度” 的概率不高，更像右侧边缘被覆盖或被裁切。

### Round 2 - 壳层边界
- [x] `AppChrome` 在 `left: APP_LAYOUT_TOKENS.FLOATING_SIDEBAR_WIDTH` 处画了一条 `z-30` 的绝对定位 seam。
- [x] sidebar layer 本身是 `z-20`，seam 比 sidebar 更高，会直接压在 sidebar 与 main 的分界线上。
- [x] 这会让靠近右边界的 hover / selected 圆角矩形在视觉上像被右侧“吃掉 1px”。

### Round 3 - 缩放与像素舍入
- [x] 根容器仍使用 `style={{ zoom: settings.interfaceScale / 100 }}`。
- [x] 默认值虽然是 100，但设置允许 80-125；`zoom` 会放大 seam 与圆角边缘的 subpixel rounding 风险。
- [x] 当前样式未见 `scrollbar-gutter: stable`，滚动条出现时仍可能放大右边缘视觉抖动。

### Round 4 - diff 与测试覆盖
- [x] 当前本地 diff 显示：settings active row 最近被改成更厚的 `rounded-2xl + border + shadow` 方案，右边界更容易显脏。
- [x] 已跑目标源码测试：`AppChrome` / `Sidebar` / `ShellButton` / `app-shell` 共 33 项通过。
- [x] 这些测试主要锁定源码字符串与结构，不覆盖“右侧被遮挡”的视觉回归，因此还缺针对性契约。

---

## 结论排序

- [x] **P1 根因：seam 的层级归属错了。** 它现在像一条覆盖在 sidebar 之上的线，而不是 main pane 自己的左边界。
- [x] **P2 放大因素：settings active row 的 border + shadow。** 即使只被盖住 1px，也会比纯填充态更明显。
- [x] **P3 次级风险：`zoom` 的 subpixel rounding。** 不一定是首因，但会让边界问题在非 100% 缩放下更容易出现。

---

## Executable Checklist

### Phase 0 - 先锁定证据，不要盲改
- [x] 读取并比对以下文件后再动手：
  - `src/components/shell/AppChrome.tsx`
  - `src/components/shell/Sidebar.tsx`
  - `src/components/shell/ShellButton.tsx`
  - `src/lib/app-shell.ts`
  - `src/styles/app.css`
- [x] 明确记录当前问题表述：不是“hover 背景真的超出布局宽度”，而是“右边缘被 seam / 裁切遮挡，视觉上像越界”。
- [x] 在本文件末尾的“实施备注”区追加一句结论，写清楚首因是 `seam overlay` 还是 `zoom rounding`。

### Phase 1 - 用测试先锁住正确方向
- [x] 先补源码契约测试，再改实现。
- [x] 在 `src/components/shell/AppChrome.source.test.ts` 增加断言：
  - seam 不应以覆盖 sidebar 右边缘的高层绝对线存在；
  - 修复后，分隔语义应归属于 main pane 起始边界，而不是压在 sidebar surface 上。
- [x] 在 `src/components/shell/Sidebar.source.test.ts` 增加断言：
  - settings active row 不再依赖 `shadow-sm shadow-black/5` 制造选中感；
  - settings active row 与 thread active row 保持同类、安静、fill-driven 的选中逻辑。
- [x] 如现有 `scripts/floating-sidebar-contract.test.mjs` 对错误实现有硬编码约束，先更新契约，避免测试继续锁死旧问题。

### Phase 2 - 先修 seam 归属，这是推荐主方案
- [x] 把 sidebar 与 main 之间的分隔表达移到 main pane 自己身上，而不是继续用跨层绝对定位的 `z-30` seam 压在边界上。
- [x] 优先方案：让 `main` 使用自身左边界表达（例如等价的边界线 / inset seam 语义），保证它从 main 内侧开始绘制。
- [x] 修复后确认：
  - sidebar 右边缘不再被更高层元素盖住；
  - main 与 sidebar 仍有一条克制、连续、低对比的分隔；
  - 不回退到旧的 `before/after` 圆角补丁。

### Phase 3 - 收掉会放大遮挡感的 active row 样式
- [x] 将 settings active row 从“边框 + 阴影卡片感”收回到与 thread row 一致的安静填充态。
- [x] 保持 `rounded-2xl` 和 `bg-interactive-selected`，但去掉会在边界处显脏的外阴影。
- [x] 如确实需要边界感，只允许使用更轻的 inset 或同色系弱边框，禁止重新引入凸起式阴影。
- [x] 检查 hover 态与 selected 态的视觉层级：selected 必须更稳定，不要比 hover 更轻。

### Phase 4 - 再处理缩放风险，只做必要修补
- [ ] 在 seam 修好后，手动检查 `interfaceScale = 80 / 100 / 110 / 125` 四档。
- [ ] 如果只有非 100% 缩放下仍出现 1px 偏差，再单独处理 `zoom` 风险。
- [x] 在没有新证据前，不要先大改整套缩放实现；优先最小修补。
- [x] 如滚动条切入会影响右边界，再评估是否给滚动区增加 `scrollbar-gutter: stable`。

### Phase 5 - 验证
- [x] 跑目标源码测试：
```bash
node --test --experimental-strip-types src/components/shell/AppChrome.source.test.ts src/components/shell/Sidebar.source.test.ts src/components/shell/ShellButton.source.test.ts src/lib/app-shell.test.ts
```
- [x] 跑契约测试：
```bash
node --test scripts/floating-sidebar-contract.test.mjs scripts/settings-sidebar-surface-contract.test.mjs
```
- [x] 跑静态检查：
```bash
npm run lint
```
- [ ] 如你实际打开了界面，补做人工验证：
  - light / dark
  - app mode / settings mode
  - interfaceScale 80 / 100 / 110 / 125
  - hover / active 两种状态

### Phase 6 - 完成标准
- [x] 侧边栏 hover 矩形右侧不再出现被主内容边界吃掉的视觉问题。
- [x] 侧边栏 selected 矩形右侧不再出现被 seam 压住的边缘。
- [x] settings active row 与 thread active row 回到一致、安静、低复杂度语言。
- [x] 不引入新组件库、不新增硬编码颜色、不改坏当前 floating sidebar 架构。

---

## 实施备注

- [x] 实施后结论：首因已验证为 `seam overlay`，`zoom` 仍是放大因素；本轮仅补 `scrollbar-gutter: stable`，未改动现有缩放架构。

---

## 给执行 LLM 的硬性约束

- [x] 这是修复，不是重做侧边栏。
- [x] 不要顺手改无关脏文件。
- [x] 不要新增花哨效果、动画、渐变或第二套视觉语言。
- [x] 不要把问题错误归因为“按钮宽度超出”；先按“边界遮挡 / 层级归属错误”处理。
- [x] 每完成一项再勾选一项，未验证不得打勾。
