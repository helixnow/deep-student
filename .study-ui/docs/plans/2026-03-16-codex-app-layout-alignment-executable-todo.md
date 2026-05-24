# Codex App 布局对齐执行清单

> **For Claude / Codex / other LLM:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this todo one checkbox at a time. Mark a box only after file evidence and verification.
>
> **Context:** 这次不是重写产品，也不是继续扩 demo。目标是把当前仓库里 Claude Code 已写出的 UI，收敛到更接近 Codex App 的布局语言：更安静、更直接、更像桌面工作台。

**Goal:** 让当前壳层、侧边栏、主工作区、设置页与输入区在布局结构上更接近 Codex App，而不是继续维持“demo 面板 + 信息卡片”的表达。

**Architecture:** 保留现有 Tauri shell、透明度策略、sidebar 浮层架构与主题系统；优先通过信息架构、页面骨架、间距节奏、容器层级和共享原语收敛布局，不做推倒重写。

**Tech Stack:** React 19, Vite 7, TypeScript 5.9+, Tailwind CSS v4, Radix UI, shadcn/ui, Phosphor Icons, Tauri 2

---

## Markdown 引用链接

> [Apple 对齐调研](./2026-03-13-apple-translucency-sidebar-research-executable-todo.md)
>
> [统一 Demo 收敛方案](./2026-03-16-unified-ui-ux-demo-reduction-todo.md)
>
> [侧边栏右缘遮挡修复方案](./2026-03-16-sidebar-right-edge-occlusion-executable-todo.md)
>
> [系统半透明实现方案](./2026-03-16-system-translucency-best-quality-executable-todo.md)

---

## 四轮并行调研摘要

### Round 1 - 壳层与布局骨架

- `src/components/shell/AppChrome.tsx` 已经有“左侧 sidebar + 右侧 main workspace”的基本骨架，且主区顶部改成了共享 drag hotspot，这一点方向是对的。
- 但当前主工作区仍不是 Codex App 那种“空白工作台 + 底部输入器”结构，而是由页面内容自己再铺一层产品化卡片。
- `src/components/shell/Sidebar.tsx` 仍是简化版 source list，只包含线程列表和底部设置入口，缺少 Codex App 那种“顶部功能入口 + 分组列表 + 底部设置”的信息架构。

### Round 2 - 页面内容语法

- `src/components/content/ThreadCanvas.tsx` 现在是“最近变更 / 完成范围 / 下一步建议”式 dashboard，默认首屏与 Codex App 的居中空态差距最大。
- `src/components/content/SettingsDemoPanel.tsx` + `src/components/content/settings-demo-sections.tsx` 仍是组件陈列馆思路，这会反向污染真实页面布局判断。
- `src/components/content/SettingsPanel.tsx` 已经膨胀到 1578 行，内部有 24 处 `<SettingBlock>`，说明设置页在布局和内容组织上已经过重。

### Round 3 - 原语与 token

- `src/components/ui/button.tsx` 与 `src/components/shell/ShellButton.tsx` 仍各维护一套语法，shell 与内容层没有完全共用同一套节奏。
- 当前真实页面里还存在 `rounded-[24px]`、`rounded-[26px]` 这类偏展示型圆角，尤其集中在 `src/components/content/ThreadCanvas.tsx`，与 Codex App 更平直、克制的工作台气质不一致。
- `src/styles/app.css` 已有不错的 shell token 基础，但页面容器层级还没有被强约束成“工作台 / 分组列表 / 输入器”三类固定模式。

### Round 4 - 测试与回归边界

- 现有 source test 与 contract test 主要锁定“安静、低噪音、无玻璃滥用”的方向，这些应该保留。
- 但还没有直接锁定 Codex 式布局特征：例如空态居中、输入区底部锚定、sidebar 顶部分组、去 dashboard 化。
- 因此这次执行必须先补布局语义测试，再做结构收敛，避免改完后又被后续 agent 带回 demo 风格。

---

## 目标态

- **Sidebar：** 更像 Codex App 的左侧工作导航，分成顶部主入口、会话区、底部设置区，弱分隔、强层级，不做卡片堆叠。
- **Workspace：** 默认态以居中品牌/空态为主，内容极简；对话态保留大面积留白，不在首屏铺信息卡。
- **Composer：** 底部固定一块大输入器，内部整合模型、强度、附件、发送等操作，形态统一，不再碎片化。
- **Settings：** 保持同一 shell，但正文改成更接近桌面偏好设置的窄列分组，不再混入 demo 展示语言。
- **Demo：** 降级为“内部基线验证页”，不再主导真实产品的页面语法。

---

## Executable Checklist

### Phase 0 - 锁定边界，先别重写

- [ ] 只在以下范围内收敛，不扩散到无关模块：
  - `src/components/shell/AppChrome.tsx`
  - `src/components/shell/Sidebar.tsx`
  - `src/components/content/ThreadCanvas.tsx`
  - `src/components/content/SettingsPanel.tsx`
  - `src/components/content/SettingsDemoPanel.tsx`
  - `src/components/content/settings-demo-sections.tsx`
  - `src/components/ui/button.tsx`
  - `src/components/shell/ShellButton.tsx`
  - `src/styles/app.css`
- [ ] 明确这次是“对齐 Codex App 布局语法”，不是追求像官网、仪表盘或设计 showcase。
- [ ] 在实施备注中写明：优先保留现有 Claude Code 已完成的透明度与 shell 架构，只收敛页面布局和信息架构。

### Phase 1 - 先把 sidebar 信息架构改对

- [x] 把 `src/components/shell/Sidebar.tsx` 从“单一线程列表”改成三段结构：
  - 顶部主入口区：如新线程、自动化、技能
  - 中部会话区：置顶/最近线程分组
  - 底部固定区：设置
- [ ] 为 sidebar 数据增加显式分组模型，不再只靠一组平铺 `threadItems`。
  - 涉及：`src/lib/sidebar-data.tsx`
- [ ] 顶部主入口使用 icon + label 的安静导航行，不做厚胶囊按钮。
- [ ] 会话列表增加更接近 Codex 的元信息表达：时间、简短 diff、置顶态，但保持单行或双行以内，不做卡片。
- [ ] 移除会让 sidebar 看起来像“设置页左栏”的无关视觉语义，强化它是工作区导航而不是 demo 栏。

### Phase 2 - 把主工作区改成 Codex 式空态与对话态

- [x] 重写 `src/components/content/ThreadCanvas.tsx` 的默认空态结构。
- [ ] 删除默认首屏的“最近变更 / 完成范围 / 下一步建议”三类 dashboard 卡片。
- [ ] 改为居中空态：
  - 中心标识/图标
  - 单一主标题
  - 当前工作区或项目名
  - 一个明确下一步动作
- [ ] 保留底部输入器锚定，但把输入区内部工具条重排成更接近 Codex 的低噪音布局。
- [ ] 输入器只保留真正常用的控制项：附件、模型、强度/模式、发送；不要继续堆上下文标签 chips。
- [ ] 统一对话区最大宽度与空态宽度，让页面在无内容时更像“工作台”，有内容时更像“文档流”。

### Phase 3 - 收敛 composer 与共享原语

- [x] 让 `src/components/ui/button.tsx` 与 `src/components/shell/ShellButton.tsx` 共用同一套尺寸、圆角、焦点与 hover 逻辑。
- [ ] 保留 `ShellButton` 的布局职责，但去掉它独立维护的视觉语言。
- [ ] 收敛输入器相关控件高度与圆角，不再在 composer 区域出现额外一套尺寸。
- [ ] 移除 `ThreadCanvas` 中展示型任意圆角，优先回到仓库规范允许的圆角层级。
- [ ] 如果需要强调发送按钮，只允许通过主色和形状做最小区分，不新增悬浮光效、scale、渐变。

### Phase 4 - 设置页跟随同一页面语法

- [x] 把 `src/components/content/SettingsPanel.tsx` 的页面顶部和 section 节奏收敛到“桌面偏好设置”模式：窄列、连续分组、弱装饰。
- [ ] 不再让设置页沿用 demo/showcase 的大卡片组织方式。
- [ ] 将 `SettingsPanel.tsx` 按布局职责拆分，至少拆出：
  - 页面头部
  - 通用 row/block/meta section
  - 具体 setting groups
- [ ] 保留现有设置项，不先做功能删减；先改布局骨架与内容密度。
- [ ] 设置页正文宽度、间距、标题层级要与 `ThreadCanvas` 的正文语法对齐，形成同一产品体系。

### Phase 5 - 把 demo 页降级，不再主导真实布局

- [ ] 将 `src/components/content/SettingsDemoPanel.tsx` 重命名或改文案为“界面基线”而非“组件与状态预览”。
- [ ] 把 `src/components/content/settings-demo-sections.tsx` 从组件陈列馆改成 3-4 个真实场景块，不再逐个展示 Button/Input/Tabs/Tooltip。
- [ ] 删除顶部 stats 小卡和过强的“设计检视”语气，避免它看起来比真实页面更像成品。
- [ ] demo 页只保留真实页面会复用的布局样本，不再定义新的容器语言。

### Phase 6 - 用 token 锁住布局风格

- [x] 在 `src/styles/app.css` 明确三类页面级 token 或约束：
  - shell/navigation
  - workspace/content
  - composer/input
- [ ] 禁止新增不在规范内的页面圆角、阴影和字号。
- [ ] 审查并清理当前页面中的展示型 class：
  - `rounded-[24px]`
  - `rounded-[26px]`
  - 任何无必要的大卡片阴影
- [ ] 保持浅色主题下接近 Codex 的“白主区 + 浅灰 sidebar + 极轻分隔”关系；深色主题只做对应映射，不另做第二套版式。

### Phase 7 - 先补测试，再做验证

- [x] 在以下文件补源码测试，锁定 Codex 对齐后的结构语义：
  - `src/components/shell/Sidebar.source.test.ts`
  - `src/components/content/ThreadCanvas.source.test.ts`
  - `src/components/content/SettingsPanel.source.test.ts`
  - 如有必要新增 `src/components/content/SettingsDemoPanel.source.test.ts`
- [x] 测试至少断言以下事实：
  - sidebar 存在顶部主入口区与底部设置区
  - `ThreadCanvas` 默认首屏不再出现 dashboard 卡片文案
  - composer 仍为底部锚定输入器
  - settings 页不再出现 showcase 式页头或超大展示卡
- [x] 跑局部测试：

```bash
node --test --experimental-strip-types src/components/shell/Sidebar.source.test.ts src/components/content/ThreadCanvas.source.test.ts src/components/content/SettingsPanel.source.test.ts
```

- [x] 跑相关契约与基础校验：

```bash
npm run lint
npm run build
```

---

## 给执行 LLM 的硬性约束

- [ ] 这是对齐与收敛，不是视觉炫技。
- [ ] 不新增组件库，不新增第二套设计系统。
- [ ] 不为了“更像 Codex”而破坏现有 Tauri 壳层与窗口行为。
- [ ] 不新增 marketing 风格的大 hero、渐变、发光、scale 动画。
- [ ] 不把真实页面继续做成 demo 页，也不把 demo 页继续做成组件展厅。
- [ ] 每完成一项再勾选一项，未验证不得打勾。

---

## 实施备注

- [ ] 待填写：sidebar 最终采用“固定主入口 + 线程列表”还是“主入口可折叠分组”，选择理由是什么
- [ ] 待填写：空态是否保留工作区选择器，以及它在移动端如何降级
- [ ] 待填写：设置页拆分后保留哪些共享 section 原语

## 验证结果

- 2026-03-16 `node --test --experimental-strip-types src/components/shell/Sidebar.source.test.ts src/components/content/ThreadCanvas.source.test.ts src/components/content/SettingsPanel.source.test.ts`
  - 结果：15/15 通过
- 2026-03-16 `npm run lint`
  - 结果：通过
- 2026-03-16 `npm run build`
  - 结果：通过；产物包含 `dist/assets/ThreadCanvas-DxuYrt5O.js`、`dist/assets/SettingsPanel-DnZ3ubjo.js`
