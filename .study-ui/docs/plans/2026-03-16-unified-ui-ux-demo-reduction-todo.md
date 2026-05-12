# Unified UI/UX Demo Reduction Todo

> **For Claude / Codex / other LLM:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this todo one checkbox at a time. Mark a box only after file evidence and verification. If that skill is unavailable, emulate the same controller + reviewer workflow.

**Goal:** 把当前并存的多套 UI/UX 语言收敛成 1 套统一方案，并且先完整体现在 demo 页，再反向约束真实页面。

**Architecture:** 保留现有 Tauri shell 与 cross-platform 窗口能力，不重写壳层；收掉 demo 的“组件陈列馆”倾向，让 demo 页只展示真实页面会复用的 4-6 个场景模块。所有新的视觉决策先在 demo 页定稿，再回流到 `SettingsPanel`、`ThreadCanvas` 与 shell。

**Tech Stack:** React 19, Vite 7, TypeScript 5.9+, Tailwind CSS v4, Radix UI, shadcn/ui, Tauri 2

---

## 引用文件

- [docs/plans/2026-03-16-unified-ui-ux-demo-reduction-todo.md](./2026-03-16-unified-ui-ux-demo-reduction-todo.md)
- [src/components/content/SettingsDemoPanel.tsx](../../src/components/content/SettingsDemoPanel.tsx)
- [src/components/content/settings-demo-sections.tsx](../../src/components/content/settings-demo-sections.tsx)
- [src/components/content/SettingsPanel.tsx](../../src/components/content/SettingsPanel.tsx)
- [src/components/content/ThreadCanvas.tsx](../../src/components/content/ThreadCanvas.tsx)
- [src/components/shell/AppChrome.tsx](../../src/components/shell/AppChrome.tsx)
- [src/components/shell/Sidebar.tsx](../../src/components/shell/Sidebar.tsx)
- [src/components/shell/ShellButton.tsx](../../src/components/shell/ShellButton.tsx)
- [src/components/ui/button.tsx](../../src/components/ui/button.tsx)
- [src/components/ui/card.tsx](../../src/components/ui/card.tsx)
- [src/styles/app.css](../../src/styles/app.css)

---

## 四轮并行调研摘要

### Round 1 - 信息架构过重
- `SettingsPanel.tsx` 已经变成 1607 行的超大文件，并在渲染层串联了 `general / model-service / model-assign / appearance / developer / memory / privacy / shortcuts / about / demo` 等多个分支。
- 实际统计：`<SettingBlock` 25 处，`<SettingsRow` 8 处，`Dialog` 预览与内嵌说明也很多。
- 结论：当前“设置页 + demo 页”承担了太多不同目标，应该拆成“真实设置模式”与“统一 demo 基线”两种职责，不再继续往 demo 堆组件。

### Round 2 - 容器语言分叉
- `settings-demo-sections.tsx` 859 行，独立 section 过多，且维护了多套近似外框：`stateRegressionFrameClassName`、`typographyFrameClassName`、`feedbackFrameClassName`、`showcaseFrameClassName`。
- 全仓统计显示：`rounded-2xl`、`rounded-xl`、`rounded-[24px]`、`rounded-[26px]`、`rounded-[28px]`、`rounded-[32px]``并存，视觉规则不够单一。
- 结论：要收敛成“页容器 / 区块容器 / 内嵌面板”三层，不再按 demo 小节各自发明材质。

### Round 3 - 原语与交互不统一
- `Button` 与 `ShellButton` 各自维护一套视觉变体；shell 虽然布局特殊，但不应该继续拥有独立的形态语言。
- demo 中 `Select` 仍是 `h-10`，低于仓库规范要求的移动端 44px 触控目标。
- demo 字体样例还保留了 `32px` 的 Display 档，和仓库“禁止使用 24px 以上字号”的规范冲突。
- 结论：按钮、输入、选择器、标题层级要回到统一 token，demo 不允许再做规范外示范。

### Round 4 - demo 页不像真实产品页
- `SettingsDemoPanel.tsx` 现在是“标题卡 + 统计胶囊 + 双列组件网格 + 多个控件样例”的结构，更像组件目录，不像真实产品页面。
- `ThreadCanvas.tsx` 与 demo 页的容器节奏、圆角和块级语法并不完全一致，导致“真实页面”和“demo 页面”看起来像两套系统。
- 结论：demo 页应该只保留真实页面会出现的场景组合，成为唯一的视觉验收基线。

---

## 统一目标

- 只保留 1 套页面语法：相同的页头、相同的 section 标题、相同的卡片边线与间距节奏。
- 只保留 1 套控件语法：`Button` / `ShellButton` / `Input` / `Select` / `Switch` 共享相同尺寸、圆角、focus 与 hover 逻辑。
- 只保留 1 套字号体系：11 / 12 / 14 / 16 / 18 / 20 / 24，不允许 demo 出现超规范字体。
- 只保留 1 套 demo 目标：验证真实页面模式，不做“原子组件样品册”。

---

## 建议目标态

### Demo 页只保留 4 个核心模块
1. `Shell Preview`：展示壳层、侧边栏、列表项与页面头部。
2. `Settings Form`：展示输入、选择、开关、按钮、辅助说明。
3. `Content List + Detail`：展示列表、详情块、状态标签、操作区。
4. `Feedback States`：展示空态、禁用态、骨架屏、Toast 或轻提示。

### 容器层级只保留 3 层
- `Page Surface`：页面主容器，统一宽度与上下留白。
- `Section Frame`：区块容器，统一边框、圆角、阴影。
- `Inset Panel`：区块内部的次级面板，统一弱底色与边线。

### 设置页只保留 3 种内容模式
- `Row`：左说明、右控件。
- `Block`：标题、说明、当前值、控件组。
- `Meta`：只读信息 + 操作。

---

## Executable Checklist

### Phase 0 - 冻结统一规则
- [x] 在 demo 页重构前，先声明“允许的圆角、字号、阴影、控件高度白名单”。
  - 完成标准：在 `src/styles/app.css` 和相关 source test 中锁定统一 token；禁止继续新增 `rounded-[24px|26px|28px|32px]` 一类 demo 专用尺寸。
- [ ] 明确 demo 页是“统一基线页”，不是组件目录页。
  - 完成标准：在 demo 页标题与说明中改成“界面基线 / 真实页面预演”语义，不再写“组件与状态预览”。
- [ ] 停止新增 demo-only frame class。
  - 完成标准：`src/components/content/settings-demo-sections.tsx` 不再继续扩展新的 `*FrameClassName` / `*PanelClassName` 家族。

### Phase 1 - 把 demo 从组件陈列馆改成真实页面
- [ ] 删除当前按原子控件拆分的大多数 demo section，只保留 4 个核心模块。
  - 涉及文件：`src/components/content/SettingsDemoPanel.tsx`、`src/components/content/settings-demo-sections.tsx`
  - 建议删除或并入的 section：`ButtonSection`、`InputSection`、`TextareaSection`、`TabsSection`、`TooltipSection`、`DropdownSection`
- [ ] 去掉 demo 页顶部“统计胶囊 + 组件说明卡”的目录化表达，改成一个简洁页头。
  - 完成标准：顶部只保留标题、简短说明、当前设计基线标签，不再用 3 个 stats 小卡做装饰。
- [ ] 限制 demo 页模块数量。
  - 完成标准：首屏可见模块不超过 6 个；默认阅读顺序从上到下清晰，不依赖双列碎片化浏览。

### Phase 2 - 收敛容器与材质
- [ ] 把 demo 中重复的 frame/panel/tile class 收敛为共享容器原语。
  - 涉及文件：`src/components/content/settings-demo-sections.tsx`、`src/components/ui/card.tsx`、`src/components/ui/surface.tsx`
  - 完成标准：`stateRegressionFrameClassName`、`typographyFrameClassName`、`feedbackFrameClassName`、`showcaseFrameClassName` 合并为统一模式。
- [ ] 统一圆角层级。
  - 完成标准：按钮/输入 `rounded-lg`；内嵌 panel `rounded-xl`；主要内容容器 `rounded-2xl` 或 `rounded-3xl`；移除规范外任意值。
- [ ] 统一阴影层级。
  - 完成标准：普通内容容器仅保留轻阴影；弹出层保留 popover 阴影；移除 demo 页零散的额外阴影调味。

### Phase 3 - 收敛控件语法
- [ ] 让 `Button` 与 `ShellButton` 共用同一套尺寸、圆角和状态 token。
  - 涉及文件：`src/components/ui/button.tsx`、`src/components/shell/ShellButton.tsx`、`src/styles/app.css`
  - 完成标准：shell 只保留布局差异，不再保留独立视觉语言。
- [ ] 统一所有表单控件高度到移动端可触控基线。
  - 涉及文件：`src/components/content/settings-demo-sections.tsx`、`src/components/ui/input.tsx`
  - 完成标准：demo 内 `Select` 不再使用 `h-10`，所有可触控控件至少 44px。
- [ ] 删掉超规范的 typography 示范。
  - 涉及文件：`src/components/content/settings-demo-sections.tsx`
  - 完成标准：移除 `32px` Display 样例，只保留仓库规范允许的字号。
- [ ] 减少“变体即组件”的展示方式。
  - 完成标准：按钮、输入、切换只在真实场景中出现，不再单独成卡堆放。

### Phase 4 - 让真实页面跟随 demo，而不是反过来
- [ ] 让 `ThreadCanvas` 和 demo 页共享同一套区块节奏。
  - 涉及文件：`src/components/content/ThreadCanvas.tsx`、`src/components/content/SettingsDemoPanel.tsx`
  - 完成标准：页宽、区块标题、边线密度、底部操作区语言一致。
- [ ] 让 `SettingsPanel` 只复用被 demo 认证过的块级模式。
  - 涉及文件：`src/components/content/SettingsPanel.tsx`
  - 完成标准：新老设置区块统一回到 `Row / Block / Meta` 三种模式，不再继续扩散新模板。
- [ ] 重新定义 demo tab 的命名与角色。
  - 完成标准：将“组件 Demo”改为更贴近产品语义的入口名，例如“界面基线”或“统一 Demo”。

### Phase 5 - 验证与回归
- [ ] 验证 Light / Dark / translucent / opaque 四种组合下的统一性。
  - 涉及文件：`src/styles/app.css`、`src/components/theme/theme-provider.tsx`
  - 完成标准：容器层级与对比关系一致，不出现某个主题下特别像另一套 UI 的情况。
- [ ] 验证移动端优先约束。
  - 完成标准：`<640px` 下模块顺序、触控尺寸、sheet/drawer 行为仍然成立。
- [ ] 跑最小回归检查。
  - 建议命令：`npm run lint`
  - 若涉及样式契约变更，补跑对应的 `source.test.ts` 与相关 Node test。

---

## LLM 执行时的硬性约束

- [ ] 不新增第二套容器语言；有现成 `Card` / `Surface` / shared section primitive 就复用。
- [ ] 不为了 demo 好看而创造真实页面不会使用的装饰。
- [ ] 不再新增任意圆角、任意阴影、任意字号。
- [ ] 不再把单个控件拆成独立“样品卡”；必须嵌入真实使用场景。
- [ ] 所有新样式必须先在 demo 页成立，再回流到真实页面。

---

## 这份 todo 的优先级顺序

1. 先改 demo 的结构，不先抠局部颜色。
2. 再改容器和控件 token，不先加新组件。
3. 再让 `ThreadCanvas` / `SettingsPanel` 跟随 demo。
4. 最后才做细节 polish。
