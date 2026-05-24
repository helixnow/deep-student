# 侧边栏按钮宽度一致性修复方案

> **目标**：确保侧边栏内所有 nav 按钮的 hover/选中高亮宽度一致，严格限制在侧边栏 280px 范围内，不超出边界。

---

## 调研结论

### 根因分析

1. **tailwind-merge 不会凭空产生 `w-auto`**（[src/lib/utils.ts] `cn()` = `twMerge(clsx(...))`），但 `w-full` 在 active className 中被显式加回后问题已解决
2. **容器 padding 不一致**：App 模式 `px-2`（8px），Settings 模式额外嵌套 `px-1`（4px），导致两种模式下按钮宽度差 8px
3. **`<aside overflow-hidden>`**（[src/components/shell/Sidebar.tsx#L49]）会裁切边缘处的 `rounded-lg` 圆角，当前 8px margin 刚好不被裁切
4. **280px 全宽方案已回滚**（c7fa9c9）——圆角在无 margin 时被容器裁切，效果不佳

### 参考约束

- [AGENTS.md] 圆角规范：按钮使用 `rounded-lg`（8px）
- [AGENTS.md] 间距规范：组件内边距 `p-2`–`p-4`（8px–16px）
- [scripts/settings-sidebar-surface-contract.test.mjs#L26] 断言 settings 列表使用 `"px-1 py-1"`
- [scripts/interaction-states-contract.test.mjs] 断言填充驱动（fill-driven）的 hover/selected
- [scripts/dark-shell-language-contract.test.mjs#L24-L30] 断言 thread row 的 active/inactive className
- [src/components/shell/ShellButton.tsx#L23] nav 变体基类含 `w-full rounded-lg px-3`

---

## 可执行方案

### Phase 1：统一容器 padding

- [x] **1.1** 将 Settings 模式的内层容器从 `px-1 py-1` 改为 `py-1`（移除水平 padding），使其与 App 模式的按钮宽度一致
- [x] **1.2** 更新 [scripts/settings-sidebar-surface-contract.test.mjs] 的断言：`"px-1 py-1"` → `"py-1"`
- [x] **1.3** 验证构建通过 + 111 个测试全绿

### Phase 2：确保所有按钮宽度一致

- [x] **2.1** 确认 thread items active 状态已有 `w-full`（d5bd429 已提交）
- [x] **2.2** 确认 settings nav items active 状态已有 `w-full`（d5bd429 已提交）
- [ ] **2.3** 清理废弃常量 `SETTINGS_BACK_BUTTON_CLASS_NAME`（[src/components/shell/sidebar-settings.ts]）——已不被引用
- [x] **2.4** 验证底部「设置」按钮宽度与列表按钮一致（均在 `px-2` 容器内）

### Phase 3：视觉验证

- [ ] **3.1** 浅色模式：App 模式 thread hover/selected 高亮宽度一致，圆角不被裁切
- [ ] **3.2** 浅色模式：Settings 模式 nav hover/selected 高亮宽度与 App 模式 thread 一致
- [ ] **3.3** 深色模式：重复 3.1 和 3.2 的检查（hover=#262625, selected=#2A2A2A）
- [ ] **3.4** 确认按钮高亮两侧留有约 8px margin（`px-2` 容器提供），不贴紧侧边栏边缘

### Phase 4：提交

- [x] **4.1** `git add -A && git commit -m 'fix(shell): unify sidebar button width across app and settings modes'`
- [x] **4.2** 运行 `npm run lint` 确认无 lint 错误

---

## 预期结果

| 模式 | 高亮宽度 | 侧边栏宽度 | 两侧边距 |
|------|---------|-----------|---------|
| App（线程列表） | 264px | 280px | 8px × 2 |
| Settings（导航列表） | 264px（当前 256px → 修复后 264px） | 280px | 8px × 2 |
| 底部（设置按钮） | 264px | 280px | 8px × 2 |

> **关键**：所有高亮保持在侧边栏 280px 内部，两侧各有 8px 视觉间距，圆角 `rounded-lg`（8px）不被 `overflow-hidden` 裁切。
