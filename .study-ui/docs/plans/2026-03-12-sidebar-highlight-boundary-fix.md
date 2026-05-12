# 侧边栏按钮高亮边界对齐修复方案

> **问题**：用户报告 hover/选中高亮未限制在侧边栏范围内  
> **目标**：确保高亮严格在侧边栏可见边界内  

---

## 调研结论（四轮并行调研）

### CSS 防溢出（3 层防护均正常）

1. `<aside overflow-hidden>` 280px 硬裁切 — [Sidebar.tsx#L49](../src/components/shell/Sidebar.tsx)
2. `.custom-scrollbar { overflow-x-hidden }` — [Sidebar.tsx#L92](../src/components/shell/Sidebar.tsx)
3. `ShellButton { overflow-hidden }` — [ShellButton.tsx#L23](../src/components/shell/ShellButton.tsx)

> CSS 结构上高亮**不可能**超过 280px 边界。

### 可能的渲染层面根因

| 嫌疑 | 位置 | 优先级 |
|------|------|--------|
| **A. zoom 缩放导致渲染偏移** | [AppChrome.tsx#L159](../src/components/shell/AppChrome.tsx) `zoom: interfaceScale/100` | 🔴 最可能 |
| **B. 滚动条未预留空间** | [app.css#L211-228](../src/styles/app.css) 5px 滚动条无 `scrollbar-gutter` | 🟡 次要 |
| **C. tailwind-merge 生成异常类名** | `cn()` 合并后类名顺序不同但功能等价 | 🟢 已排除 |

### 当前宽度规格

| 组件 | CSS 宽度 | 计算方式 |
|------|---------|---------|
| aside 容器 | 280px | `w-70` = 70 × 4px |
| 滚动区域内容 | 264px | 280 - `px-2`(8px) × 2 |
| 按钮高亮 | 264px | `w-full` 撑满滚动区域 |
| 圆角 | 8px | `rounded-lg` |
| 两侧间距 | 8px × 2 | `px-2` 提供 |

---

## 可执行方案

### Phase 0：定位问题（诊断）

- [ ] **0.1** 确认 dev server 正在运行最新代码（刷新页面，检查 `git log --oneline -1` 与页面渲染对应）
- [ ] **0.2** 用 DevTools 检查选中按钮的 `computed width` 和 `offsetLeft` — 确认是否真的超过 aside 边界
- [ ] **0.3** 检查当前 `interfaceScale` 设置值（AppChrome.tsx 的 zoom 值） — 尝试设为 100% 观察是否改善
- [ ] **0.4** 截图标注具体"超出范围"的位置 — 是右侧超出？左侧超出？整体偏移？

### Phase 1：修复 zoom 偏差（按嫌疑 A）

- [ ] **1.1** 将 `zoom` 替换为 `transform: scale()` + 容器尺寸补偿（zoom 是非标准属性，scale 更可控）
- [ ] **1.2** 或者：在 sidebar 上使用 `zoom: 1/parentZoom` 反向缩放以抵消父级 zoom
- [ ] **1.3** 验证 80%、100%、110%、125% 四个缩放级别下的对齐

### Phase 2：修复滚动条空间（按嫌疑 B）

- [ ] **2.1** 在 `.custom-scrollbar` 的 CSS 中添加 `scrollbar-gutter: stable` — [app.css](../src/styles/app.css)
- [ ] **2.2** 验证滚动条出现/消失时按钮宽度不变

### Phase 3：提交

- [ ] **3.1** 构建通过 + 111 测试全绿
- [ ] **3.2** `git commit -m 'fix(shell): resolve sidebar highlight boundary alignment'`

---

## 参考文档

- [AGENTS.md](../AGENTS.md) — 圆角规范：按钮 `rounded-lg`（8px）
- [ShellButton.tsx](../src/components/shell/ShellButton.tsx) — nav 变体基类
- [AppChrome.tsx](../src/components/shell/AppChrome.tsx) — 布局结构、zoom 属性
- [app.css](../src/styles/app.css) — CSS 变量、custom-scrollbar 定义
- [interaction-states-contract.test.mjs](../scripts/interaction-states-contract.test.mjs) — 交互状态断言
- [floating-sidebar-contract.test.mjs](../scripts/floating-sidebar-contract.test.mjs) — 浮动侧边栏断言
