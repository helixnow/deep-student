# UI 优化方案

> 基于四轮并行调研结果生成  
> 调研时间：2026-03-21  
> 项目：study-ui (React 19 + Vite 7 + Tailwind CSS v4)

---

## 📋 调研摘要

| 维度 | 合规率 | 主要问题 |
|------|--------|---------|
| 可访问性 | 75% | 缺少 skip link、触摸目标过小、键盘支持不足 |
| 响应式设计 | 85% | 移动优先原则执行不一致 |
| 代码质量 | 90% | 硬编码颜色、冗余参数、魔法数字 |
| 设计系统 | 92% | 字号超限、非标准 Tailwind 类 |
| 性能 | 95% | 重复计算、字符串拼接 |

---

## 🔴 P0 - 必须立即修复（阻塞发布）

### 可访问性

- [ ] **添加 Skip Link（跳过链接）**
  - 位置：`src/components/shell/AppChrome.tsx`
  - 问题：键盘用户无法快速跳过导航到主要内容
  - 修复：在 `<main>` 之前添加跳过链接
  - 参考：[WCAG 2.4.1 - Bypass Blocks](https://www.w3.org/WAI/WCAG21/Understanding/bypass-blocks.html)

- [ ] **WindowControls 按钮触摸目标过小**
  - 位置：`src/components/shell/WindowControls.tsx:29-30`
  - 问题：高度 28px，低于 WCAG 要求的 44×44px
  - 修复：`h-7 w-10` → `h-11 w-11`
  - 参考：[WCAG 2.5.8 - Target Size](https://www.w3.org/WAI/WCAG21/Understanding/target-size.html)

- [ ] **FramelessResizeHandles 无键盘支持**
  - 位置：`src/components/shell/FramelessResizeHandles.tsx:47-58`
  - 问题：调整手柄只有鼠标事件，键盘用户无法调整窗口
  - 修复：添加 `role="separator"`、`aria-orientation`、`tabIndex={0}` 和键盘事件
  - 参考：[WAI-ARIA - separator](https://www.w3.org/TR/wai-aria-1.2/#separator)

### 代码质量

- [ ] **修复硬编码 rgba 颜色**
  - 位置：`src/components/content/SettingsPanel.tsx:1144`
  - 问题：`shadow-[inset_0_0_0_1px_rgba(15,23,42,0.035)]` 硬编码颜色
  - 修复：在 `app.css` 中定义 CSS 变量，使用语义化 token
  - 参考：[项目规范 - 色彩系统](src/styles/app.css)

---

## 🟡 P1 - 本冲刺修复（高影响）

### 可访问性

- [ ] **Switch 高度调整**
  - 位置：`src/components/ui/switch.tsx:14`
  - 问题：高度 32px，低于 44px 触摸目标要求
  - 修复：`h-8` → `h-11`
  - 参考：[WCAG 2.5.8 - Target Size](https://www.w3.org/WAI/WCAG21/Understanding/target-size.html)

- [ ] **补充缺失的 aria-label**
  - 位置：`src/components/content/ThreadCanvas.tsx:68-72`
  - 问题：GPT-5.4、高强度等按钮缺少 `aria-label`
  - 修复：为每个交互按钮添加明确的 `aria-label`

### 响应式设计

- [ ] **Input 组件移动优先修复**
  - 位置：`src/components/ui/input.tsx:12`
  - 问题：`h-11 md:h-10` 违反移动优先原则（默认大，md后变小）
  - 修复：评估设计意图，如需修改为 `h-10 md:h-11`
  - 参考：[Mobile First 设计原则](AGENTS.md#UI/UX设计规范)

- [ ] **Button default size 评估**
  - 位置：`src/components/ui/button.tsx:24`
  - 问题：`h-11 md:h-[var(--button-height)]` 移动端更大
  - 修复：确认设计意图（可能是刻意的触摸目标优化）
  - 参考：[AGENTS.md - 交互状态](AGENTS.md#交互状态)

### 代码质量

- [ ] **清理 app-shell.ts 冗余参数**
  - 位置：`src/lib/app-shell.ts:79,98-100,141-147,201-202`
  - 问题：`void isSidebarOpen;` 等无意义语句，冗余参数
  - 修复：删除 `void` 语句，移除未使用参数
  - 参考：[TypeScript 最佳实践](https://www.typescriptlang.org/docs/handbook/declaration-files/do-s-and-don-ts.html)

- [ ] **修复 useMemo 依赖遗漏**
  - 位置：`src/components/settings/AppSettingsProvider.tsx:79-121`
  - 问题：`useMemo` 依赖数组遗漏回调函数
  - 修复：使用 `useCallback` 包装回调函数，或确认依赖关系
  - 参考：[React Hooks 最佳实践](https://react.dev/reference/react/useMemo)

### 设计系统

- [ ] **修复 Typography 违规**
  - 位置：`src/components/content/settings-demo-sections.tsx:60`
  - 问题：`text-[2rem]` = 32px，超过规范上限 24px
  - 修复：改为 `text-2xl`（24px）或调整设计
  - 参考：[AGENTS.md - 字号规范](AGENTS.md#字号规范)

- [ ] **统Button 字号**
  - 位置：`src/components/ui/button.tsx:8`
  - 问题：`text-[13px]` 非标准 Tailwind 类
  - 修复：改为 `text-xs`（12px）或 `text-sm`（14px）
  - 参考：[AGENTS.md - 字号规范](AGENTS.md#字号规范)

---

## 🟢 P2 - 下一冲刺（质量改进）

### 性能优化

- [ ] **Sidebar 重复计算缓存**
  - 位置：`src/components/shell/Sidebar.tsx:63-96`
  - 问题：每次渲染都创建新的 Set 和 Map
  - 修复：使用 `useMemo` 包裹 `folderLabelById` 和 `recentFolders`
  - 参考：[React 性能优化](https://react.dev/reference/react/useMemo)

- [ ] **优化字符串 key 拼接**
  - 位置：`src/components/content/SettingsPanel.tsx:539`
  - 问题：`key={${keys.join("-")}-${key}}` 每次渲染重新拼接
  - 修复：使用稳定的索引或 hash
  - 参考：[React 列表和 key](https://react.dev/learn/rendering-lists#why-does-react-need-key)

### 代码可维护性

- [ ] **提取魔法数字为常量**
  - 位置：`src/components/shell/AppChrome.tsx:100,101,113`
  - 问题：`46`、`6`、`28` 等数字无语义
  - 修复：提取到 `APP_LAYOUT_TOKENS` 或定义命名常量
  - 参考：[Clean Code - 命名常量](https://github.com/ryanmcdermott/clean-code-javascript#constants)

- [ ] **内联样式重构**
  - 位置：`src/components/shell/Sidebar.tsx:126`、`Titlebar.tsx:67-70`
  - 问题：`style={{ height: 0 }}` 等内联样式
  - 修复：使用 className 或 CSS 变量
  - 参考：[Tailwind CSS - 最佳实践](https://tailwindcss.com/docs/reusing-styles)

### 设计系统

- [ ] **统一语义化 Token 使用**
  - 位置：多处（SettingsPanel.tsx、settings-demo-sections.tsx）
  - 问题：部分硬编码颜色值
  - 修复：统一使用 `bg-primary`、`text-foreground` 等语义化 token
  - 参考：[AGENTS.md - 色彩系统](AGENTS.md#色彩系统)

- [ ] **统一字体大小类名**
  - 位置：`src/components/shell/Sidebar.tsx:63,203,290`
  - 问题：`text-[11px]` 硬编码
  - 修复：使用 `text-xs`（12px）或在 `app.css` 中定义 `--font-step-11`
  - 参考：[AGENTS.md - 字号规范](AGENTS.md#字号规范)

---

## 📊 修复验证清单

完成修复后，运行以下验证：

### 自动化测试

- [ ] `npm run lint` - ESLint 规则检查
- [ ] `npm run build` - 生产构建验证
- [ ] `npm run tauri:dev` - 桌面应用开发验证（如果适用）

### 可访问性测试

- [ ] 使用 [axe DevTools](https://www.deque.com/axe/) 扫描
- [ ] 使用 [Lighthouse](https://developer.chrome.com/docs/lighthouse/) 可访问性审计
- [ ] 键盘导航测试：Tab、Shift+Tab、Enter、Space、Escape
- [ ] 屏幕阅读器测试：VoiceOver (macOS) 或 NVDA (Windows)

### 响应式测试

- [ ] 移动端视口（375px、414px）
- [ ] 平板视口（768px、1024px）
- [ ] 桌面视口（1280px、1440px）
- [ ] 触摸目标尺寸验证（至少 44×44px）

### 视觉回归测试

- [ ] Light/Dark 主题对比
- [ ] 不同字体大小缩放（90%–120%）
- [ ] 不同窗口背景模式（translucent/opaque）

---

## 🔗 相关资源

- [WCAG 2.2 快速参考](https://www.w3.org/WAI/WCAG21/quickref/)
- [React 可访问性指南](https://react.dev/reference/react-dom/components/common#applying-a11y)
- [Tailwind CSS 响应式设计](https://tailwindcss.com/docs/responsive-design)
- [Mobile First 设计原则](https://www.smashingmagobile-first-responsive-web-design/)
- [项目设计规范 (AGENTS.md)](AGENTS.md)

---

## 💬 聊天框 Prompt

**使用方法**：复制以下 prompt，粘贴到聊天框中，让 AI 逐步执行修复任务。

### 快速修复 Prompt

```
请按照 UI 优化方案修复以下 P0 问题：

1. 在 AppChrome.tsx 添加 Skip Link（跳过链接）
2. 将 WindowControls.tsx 按钮尺寸从 h-7 w-10 改为 h-11 w-11
3. 为 FramelessResizeHandles.tsx 添加键盘支持（role="separator"、aria-orientation、tabIndex、键盘事件）
4. 将 SettingsPanel.tsx:1144 的硬编码 rgba 颜色改为 CSS 变量

修复后运行 npm run lint 验证。
```

### 完整优化 Prompt

```
请按照 UI 优化方案执行以下任务：

**P0 - 必须立即修复**：
- [ ] 添加 Skip Link
- [ ] 修复 WindowControls 触摸目标
- [ ] 添加 FramelessResizeHandles 键盘支持
- [ ] 修复硬编码 rgba 颜色

**P1 - 本冲刺修复**：
- [ ] 调整 Switch 高度为 h-11
- [ ] 补充 ThreadCanvas 按钮 aria-label
- [ ] 评估 Input/Button 移动优先写法
- [ ] 清理 app-shell.ts 冗余参数
- [ ] 修复 useMemo 依赖遗漏
- [ ] 修复 Typography 违规（text-[2rem] → text-2xl）
- [ ] 统一 Button 字号（text-[13px] → text-xs 或 text-sm）

**验证**：
- [ ] npm run lint
- [ ] npm run build
- [ ] npm run tauri:dev（如果适用）
- [ ] 可访问性测试（axe、Lighthouse）
- [ ] 响应式测试（移动端、平板、桌面）

请逐步执行，每完成一项后运行验证。
```

### 分类修复 Prompt

**可访问性修复**：
```
请专注于修复可访问性问题：

1. 添加全局 Skip Link（跳过链接）
2. 将 WindowControls 按钮尺寸调整为 44×44px
3. 为 FramelessResizeHandles 添加键盘支持
4. 将 Switch 高度调整为 h-11
5. 为 ThreadCanvas 交互按钮补充 aria-label

修复后使用 axe DevTools 扫描验证。
```

**响应式设计修复**：
```
请专注于修复响应式设计问题：

1. 评估 Input 组件 h-11 md:h-10 写法是否符合设计意图
2. 评估 Button default size 移动端更大是否合理
3. 检查所有组件是否遵循移动优先原则
4. 验证触摸目标尺寸（至少 44×44px）

修复后在不同视口尺寸下测试（375px、768px、1280px）。
```

**代码质量修复**：
```
请专注于修复代码质量问题：

1. 将 SettingsPanel.tsx:1144 硬编码 rgba 颜色改为 CSS 变量
2. 清理 app-shell.ts 中的 void 语句和冗余参数
3. 修复 AppSettingsProvider.tsx 的 useMemo 依赖遗漏
4. 提取 AppChrome.tsx 中的魔法数字为命名常量
5. 将 Sidebar.tsx 的 text-[11px] 改为 text-xs
6. 将 settings-demo-sections.tsx:60 的 text-[2rem] 改为 text-2xl

修复后运行 npm run lint 验证。
```

---

*本方案基于 2026-03-21 四轮并行调研结果生成，涵盖可访问性、响应式设计、代码质量、设计系统、性能五个维度。*
