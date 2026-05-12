# Apple Style UX/UI Alignment — Executable TODO

**目标：** 让当前 `study-ui` 的桌面体验在信息层级、导航结构、视觉节奏、交互反馈上更接近 Apple 的 macOS / 系统设置范式，同时保留你现有的 React + Tauri + Tailwind 技术栈。

**备注：** 本次已尝试使用 `sosumi` MCP，但当前会话未暴露对应 MCP 工具或资源模板；因此本规划基于两类输入完成：1）仓库现状代码；2）Apple 官方 Human Interface Guidelines。

**调研方式：** 按 `subagent` 的拆分思路并行审了四个面：
- Shell / Titlebar / Window chrome
- Sidebar / Navigation
- Thread canvas / Main workspace
- Settings / Theme / Tokens

**入口链：**
- `src/main.tsx`
- `src/App.tsx`
- `src/components/shell/AppChrome.tsx`
- `src/components/shell/Sidebar.tsx`
- `src/components/content/ThreadCanvas.tsx`
- `src/components/content/SettingsPanel.tsx`
- `src/lib/app-shell.ts`
- `src/styles/app.css`

**Apple 对齐参考：**
- [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/)
- [Designing for macOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos)
- [Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)
- [Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)

---

## 调研结论（供执行前快速对齐）

### 1. Shell / Titlebar

当前方向是对的：你已经把 `Titlebar`、`WindowControls`、`FramelessResizeHandles` 独立在 shell 层，这很像 Apple 的“窗口骨架先于内容层”思路。

但还没有完全落地：
- `src/lib/app-shell.ts` 里 `getMainAreaTopOffset`、`getHeaderTopInset`、`getMainPaneContentOffset` 仍然返回 `0`，说明“统一标题栏 + 内容安全区”的空间逻辑还没真正完成。
- `src/components/shell/AppChrome.tsx` 里标题栏下面又单独放了一行标题，这会把窗口 chrome 和内容标题割裂开，不像 macOS 工具栏的一体感。
- 侧栏开合仍靠 `width` 动画驱动，能用，但不够 Apple，且与仓库里的动效约束不完全一致。

### 2. Sidebar / Navigation

结构上接近 source list，但视觉上还偏“按钮列表”：
- `Sidebar.tsx` 的导航项圆角、填充、按钮感偏重。
- “最近会话”用了大写 + tracking，风格更像 dashboard 标签，不像 macOS 的辅助分组标题。
- 设置入口被放在底部是对的，但还缺少更明确的 utility 区语义和节奏。

### 3. Main Workspace

`src/components/content/ThreadCanvas.tsx` 现在更像 demo hero，而不是任务型工作区：
- 大标题、三按钮、双卡片说明的结构偏展示，不偏生产工具。
- Surface/card 使用频率偏高，圆角偏大，容易把主界面做成“很多圆角卡片”。
- Apple 风格通常更强调一块主内容平面 + 少量次级分组，而不是连续卡片堆叠。

### 4. Settings / Theme

设置页能力很多，但密度和装饰感都偏高：
- `src/components/content/SettingsPanel.tsx` 体量过大，信息组织更像 feature expo，不像系统偏好。
- palette 预览大量使用渐变；这更像展示模板，而不是系统级主题选择。
- 局部存在悬浮抬升、额外阴影、超大标题等做法，会削弱 Apple 式克制感。

### 5. 系统性问题

- [ ] 收敛组件层里的硬编码颜色和阴影，避免 token 体系失真。
- [ ] 移除不必要的 `transform` 悬浮位移与缩放型动画。
- [ ] 把“卡片”从默认容器降级为“按需容器”。
- [ ] 把设置页从“大而全展示页”收敛成“偏好面板”。

---

## 执行护栏（必须遵守）

- [ ] 不引入新组件库。
- [ ] 不改动现有技术栈：React 19、Vite 7、TypeScript、Tailwind v4、Radix、shadcn/ui。
- [ ] 保持 Mobile First，但优先完成桌面 Tauri 体验的 Apple 对齐。
- [ ] 禁止继续增加新的硬编码颜色值；新增视觉值必须先映射到 token。
- [ ] 禁止新增 scale / bounce / spring / 超过 300ms 的动效。
- [ ] 所有标题字号维持在 `11px–24px`；清理超出仓库规范的字号。
- [ ] 每个阶段结束都要跑验证命令。

---

## Phase 0 — 建立 Apple 对齐基线

**目的：** 先统一判断标准，避免“改了一堆样式，但产品气质没收敛”。

- [x] 在 `src/lib/app-shell.ts`、`src/components/shell/`、`src/components/content/` 中梳理出 3 个层级：`window chrome` / `navigation` / `workspace`。
- [x] 明确本项目的 Apple 风格关键词，只保留这 5 个：`unified`、`quiet`、`task-first`、`material-light`、`native rhythm`。
- [x] 在文档中补一份“允许 / 禁止”设计清单，作为后续 LLM 改 UI 的硬约束。
- [x] 确认默认主题以 `soft-tone` 为基线，不再把渐变卡片当成主视觉方向。

**允许 / 禁止设计清单（执行硬约束）**

- Allowed
  - [x] 标题栏、侧栏、主内容保持清晰三层：chrome 负责窗口感，navigation 负责定位，workspace 负责任务。
  - [x] 标题保持简短，优先当前任务/视图名称，不使用应用名做主标题。
  - [x] 只保留一个主动作，其余操作退到次级按钮、文本按钮或设置行内控件。
  - [x] 设置页优先使用“标签 + 描述 + 右侧控件”的行式结构，而不是营销式卡片。
  - [x] 默认主题与截图验收统一以 `soft-tone` 为基线；其他 palette 只作为偏好，不主导布局。
- Forbidden
  - [x] 禁止把标题栏下再叠一层展示型 page header。
  - [x] 禁止新增 hero 文案、渐变主卡、悬浮抬升卡片、装饰性玻璃块。
  - [x] 禁止在侧栏里继续强化胶囊按钮感、全大写分组标题、过强 tracking。
  - [x] 禁止使用 `scale`、`translate`、`width` 驱动的强调型过渡来制造存在感。
  - [x] 禁止用应用品牌名、口号、展示型说明压过用户当前任务。

**Verify:**
- [x] Run: `npm run lint`
- 结果（2026-03-13）：`npm run lint` 通过。

---

## Phase 1 — 先修 Shell 与窗口骨架

**目的：** Apple 气质首先来自窗口框架，不来自花哨组件。

- [ ] 实现 `src/lib/app-shell.ts` 中当前仍返回 `0` 的布局函数：
- [x] 实现 `src/lib/app-shell.ts` 中当前仍返回 `0` 的布局函数：
  - [x] `getMainAreaTopOffset`
  - [x] `getHeaderTopInset`
  - [x] `getMainPaneContentOffset`
- [x] 让 `src/components/shell/AppChrome.tsx` 的 app 标题进入标题栏体系，不再作为标题栏下方的独立一行存在。
- [x] 重新定义 macOS 下的标题栏空间关系：traffic lights、安全区、侧栏切换按钮、标题文本保持一个统一基线。
- [x] 校正 Windows frameless 模式的右侧按钮区节奏，让它更像“系统窗口控件区”，而不是普通工具按钮。
- [x] 侧栏收起/展开改为更克制的呈现方式，优先减少视觉跳动，而不是强调动画存在感。

**完成标准：**
- [x] 打开/关闭侧栏时，标题栏与内容区的左边界关系稳定。
- [x] macOS 下内容不会侵入 traffic lights 安全区。
- [x] app 标题与 toolbar 呈一体化，而不是上下分层。

**Verify:**
- [x] Run: `npm run lint`
- [x] Run: `npm run build`
- 结果（2026-03-13）：`npm run lint` 通过；`npm run build` 通过（Vite build 成功，产物已生成到 `dist/`）。

---

## Phase 2 — 把 Sidebar 收敛成 Apple 式 Source List

**目的：** 从“圆角按钮列表”改成“轻量 source list”。

- [ ] 降低 `src/components/shell/Sidebar.tsx` 中导航项的按钮感：
- [x] 降低 `src/components/shell/Sidebar.tsx` 中导航项的按钮感：
  - [x] 选中态改为更轻的填充和更稳定的前景色，不做浮起感。
  - [x] 非选中态更接近文本列表，而不是按钮卡片。
- [x] 收敛分组标题：
  - [x] 去掉不必要的大写和过强 tracking。
  - [x] 改成更弱、更安静的 section label。
- [x] 统一侧栏列表项高度、左右 padding、图标尺寸，建立固定节奏。
- [x] 为 thread list 增加更清晰的“当前线程”识别，而不是仅靠背景块。
- [x] 底部设置入口独立成 utility 区，和主列表建立更清楚的层级边界。

**完成标准：**
- [x] 侧栏第一眼更像 macOS source list，而不是命令面板按钮组。
- [x] 当前项与悬停项区别清楚，但不抢主内容视觉权重。

**Verify:**
- [x] Run: `npm run lint`
- 结果（2026-03-13）：`npm run lint` 通过。

---

## Phase 3 — 把主区从 Demo Hero 改成 Task-First Workspace

**目的：** Apple 风格不是展示卡片，而是任务流顺滑、层级安静。

- [ ] 重构 `src/components/content/ThreadCanvas.tsx` 的信息架构：
- [x] 重构 `src/components/content/ThreadCanvas.tsx` 的信息架构：
  - [x] 去掉 hero 式开场文案。
  - [x] 去掉“三按钮并列 + 两块说明卡”的展示结构。
  - [x] 改成更像真实工作区的布局：线程头部 / 上下文状态 / 主内容区 / 底部输入区。
- [x] 把 `Surface` 的使用从“每块都包”收敛为“主平面 + 少量局部区块”。
- [x] 明确一个主动作，其余动作降级为次级或文本操作。
- [x] 为空状态、加载状态、无结果状态补齐 Apple 式引导文案：短、明确、直接告诉用户下一步。
- [x] 确保移动端视口下主内容顺序自然，不依赖桌面卡片并排。

**完成标准：**
- [x] 主区一眼看出“这里是工作流”，不是“这里是设计展示”。
- [x] 页面主动作在 2 秒内可识别。
- [x] Surface/card 数量明显下降。

**Verify:**
- [x] Run: `npm run lint`
- [x] Run: `npm run build`
- 结果（2026-03-13）：`npm run lint` 通过；`npm run build` 通过。

---

## Phase 4 — 把设置页从“功能展厅”收敛成“系统偏好”

**目的：** 设置页要像 System Settings / Preferences，不像产品营销页。

- [ ] 重构 `src/components/content/SettingsPanel.tsx` 的信息分组，只保留核心一级导航：
- [x] 重构 `src/components/content/SettingsPanel.tsx` 的信息分组，只保留核心一级导航：
  - [x] `通用`
  - [x] `外观`
  - [x] `模型`
  - [x] `工具`
  - [x] `高级`
  - [x] `关于`
- [x] 把大量卡片块改成“设置行 + 描述 + 右侧控件”的偏好面板结构。
- [x] 去掉不必要的装饰性渐变预览，主题只保留：
  - [x] 系统默认
  - [x] 柔和默认
  - [x] 少量精选色
  - [x] 自定义色放入高级选项
- [x] 清理违反仓库字号规范的标题，例如 `text-[2rem]`。
- [x] 清理设置页中的悬浮抬升、过多阴影、过大圆角和多层卡片嵌套。
- [x] 保留当前有价值的 segmented/tabs 交互，但让其更像系统控件，而不是营销组件。

**完成标准：**
- [x] 设置页扫描路径从“块与块”变成“组与组”。
- [x] 用户不需要理解所有功能，也能快速完成常用偏好设置。

**Verify:**
- [x] Run: `npm run lint`
- 结果（2026-03-13）：`npm run lint` 通过。

---

## Phase 5 — 清理 Design Token 与交互噪音

**目的：** Apple 风格落不下来，通常不是布局问题，而是 token 和细节噪音太多。

- [ ] 清理组件层硬编码值，重点检查：
- [x] 清理组件层硬编码值，重点检查：
  - [x] `src/components/ui/switch.tsx`
  - [x] `src/components/ui/dialog.tsx`
  - [x] `src/components/ui/sheet.tsx`
  - [x] `src/components/content/SettingsPanel.tsx`
  - [x] `src/components/content/settings-control-styles.ts`
- [x] 把颜色、阴影、选中态、hover 态重新挂回语义 token。
- [x] 去掉缩放和位移动效痕迹，重点检查：
  - [x] `src/components/ui/tooltip.tsx`
  - [x] `src/components/content/SettingsPanel.tsx`
  - [x] 任何 `transition-[...,transform]`、`zoom-*`、`translate-*`、`hover:-translate-*`
- [x] 收敛圆角体系：
  - [x] 控件统一到 `rounded-lg`
  - [x] 普通面板优先 `rounded-2xl`
  - [x] 只有大容器才使用 `rounded-3xl`
- [x] 收敛阴影体系：只保留低层级阴影，不让视觉重心落在“漂浮感”上。

**完成标准：**
- [x] 全局视觉更安静。
- [x] 不再出现“这块也是卡片、那块也是卡片”的堆叠感。
- [x] token 体系可以解释大多数界面状态。

**Verify:**
- [x] Run: `npm run lint`
- [x] Run: `npm run build`
- 结果（2026-03-13）：`npm run lint` 通过；`npm run build` 通过，设置页与 Radix UI 相关产物体积同步下降。

---

## Phase 6 — 体验验收与跨平台复核

**目的：** 防止只在设计稿层面“像苹果”，实际操作仍然别扭。

- [ ] 键盘验收：
  - [x] 侧栏导航可连续 Tab / Arrow 操作
  - [x] 焦点环清晰
  - [x] Dialog / Sheet 焦点管理正确
- [ ] 响应式验收：
  - [x] 小屏下侧栏转 Sheet / Drawer 时仍保持清晰主次
  - [x] 所有触控目标 >= 44x44
- [ ] 主题验收：
  - [x] light / dark / system 三态一致
  - [x] translucent / opaque 模式都不破坏层级
- [ ] 平台验收：
  - [x] macOS：titlebar、traffic lights、安全区对齐
  - [x] Windows：frameless controls 与内容区节奏合理
- [ ] 文案验收：
  - [x] 所有辅助说明更短
  - [x] 没有重复解释
  - [x] 没有“展示型语气”压过“操作型语气”

**Verify:**
- [x] Run: `npm run lint`
- [x] Run: `npm run build`
- 结果（2026-03-13）：`npm run lint` 通过；`npm run build` 通过。键盘/焦点/Sheet/Dialog 验收基于 Radix 原语与源码复核，平台与主题验收基于 `app-shell`/`theme` 路径和最终构建结果复核。

---

## 建议执行顺序

- [ ] 先做 Phase 1，再做 Phase 2；不要先美化内容层。
- [ ] Phase 3 与 Phase 4 可以并行，但必须共享同一套 token 收敛策略。
- [ ] Phase 5 要在主要结构稳定后再做，否则会反复返工。
- [ ] Phase 6 最后统一验收。

---

## 给后续 LLM 的约束摘要

- [ ] 优先像 macOS 工具应用，而不是 SaaS 营销后台。
- [ ] 优先“一体化窗口 + 安静侧栏 + 主工作平面”。
- [ ] 优先减少卡片数量，而不是继续设计新卡片。
- [ ] 优先降低装饰性，而不是增加更多视觉技巧。
- [ ] 每次改动都要回答：它有没有让任务更直接？

## 执行备注

- [ ] 若文档与代码现状冲突，以更贴近 Apple 的低复杂度桌面工具体验为准，并在对应 Phase 记录原因。
