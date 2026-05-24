# Win / Tablet / Mobile UI Adaptation Implementation Plan

> **For Claude / Codex / other LLM:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to execute this todo one checkbox at a time. Mark a box only after file evidence and verification.
>
> **Assumption:** This plan assumes you want one shared React UI architecture for Windows desktop Tauri, tablet WebView, and mobile WebView. It does **not** assume three separate UIs.

**Goal:** 在当前 `App -> AppChrome -> Sidebar + Main` 骨架上，做出一套简单、可维护、可复用的三端适配方案：Windows 保持桌面壳，平板成为中间态，移动端成为真正的 mobile-first 结构。

**Architecture:** 保留现有信息架构与主题体系，不复制页面。新增一层 `Responsive Env` 识别环境，再新增一层 `App Layout Policy` 统一输出 `formFactor / shellMode / sidebarMode / density`，最后用少量 dataset + CSS token 驱动 `AppChrome`、`Titlebar`、`Sidebar`、`ThreadCanvas`、`SettingsPanel`。Windows 继续是 desktop-window 范式；tablet / mobile 切到 webview-safe-area 范式。

**Tech Stack:** React 19, TypeScript 5.9+, Vite 7, Tailwind CSS v4, Radix UI, shadcn/ui, Phosphor Icons, Tauri 2

---

## Markdown 引用链接

- [当前执行清单](./2026-03-19-win-tablet-mobile-ui-adaptation-executable-todo.md)
- [平板与移动端适配执行清单（历史）](./2026-03-17-mobile-tablet-adaptation-executable-todo.md)
- [跨平台 shell 实施方案（历史）](./2026-03-10-cross-platform-shell-implementation.md)
- [原生窗口背景设计（历史）](./2026-03-10-native-window-background-design.md)

---

## 四轮并行调研摘要

### Round 1 - 当前仓库基线

- `src/components/shell/AppChrome.tsx` 已经是正确的总编排入口，但当前只做了 `max-width: 767px` 的二元分流，平板被混进桌面。
- `src/lib/app-shell.ts` 已经承接平台和桌面壳层几何，但它更像 desktop helper，还不是完整的 layout policy。
- `src/styles/app.css` 已有主题、shell、safe-area、button、sidebar 等 token，说明“变量分层”基础是好的。
- `src/components/content/ThreadCanvas.tsx` 与 `src/components/content/SettingsPanel.tsx` 已有单列内容骨架，适合继续复用，不适合分叉成三套页面。

### Round 2 - 三端适配结论

- **Windows：** 应保留 frameless desktop shell、窗口控制区、拖拽区、最小窗口尺寸与桌面信息密度，不要被平板/移动逻辑反向污染。
- **Tablet：** 不能当小桌面。横屏宜用窄常驻导航，竖屏宜用抽屉导航；顶栏要弱化桌面 titlebar 语义。
- **Mobile：** 不能当窄桌面。要优先解决 safe area、底部 composer、虚拟键盘遮挡、次级操作收纳、设置页单列。

### Round 3 - 最省维护的架构切层

- 新增 `Responsive Env`：只负责识别 `platform / formFactor / inputMode / shellMode`。
- 新增 `App Layout Policy`：只负责输出 `sidebarMode / titlebarMode / density / content width / page gutter`。
- `AppChrome` 继续保留为总入口，但不再自己散落 `matchMedia`。
- 样式优先落到 `src/styles/app.css` token，组件只消费结果，不再新增组件内布局常量。

### Round 4 - 执行与验收原则

- 自动化重点锁“环境识别”和“布局策略”。
- 手工验收重点锁“真实窗口行为、真实安全区、真实触控、真实键盘遮挡”。
- 方案必须按 `环境状态 -> token -> 壳层结构 -> 内容密度 -> 验收` 顺序执行，不能倒过来。

---

## 最终推荐策略

- **只保留一套 UI 骨架**：不要复制 `Sidebar`、`Titlebar`、`ThreadCanvas`、`SettingsPanel`。
- **把适配拆成两层**：
  - 环境事实层：`platform / formFactor / shellMode / inputMode`
  - 布局决策层：`sidebarMode / titlebarMode / density / contentMaxWidth`
- **Windows 单独守住桌面范式**：桌面窗口控制区、拖拽区、最小窗口尺寸、桌面密度继续保留。
- **Tablet 做中间态，不做妥协态**：横屏偏 desktop，竖屏偏 mobile，但都通过同一 policy 输出。
- **Mobile 优先解决结构问题，不优先改视觉**：先解 safe area、bottom composer、keyboard、settings 单列。

---

## Guardrails

- [ ] 不新增组件库，不新增 CSS-in-JS，不新增响应式第三方库。
- [ ] 不复制页面为 `Desktop* / Tablet* / Mobile*` 三套组件。
- [ ] 不把 `platform`、`formFactor`、`shellMode` 混成同一个字段。
- [ ] 不继续在多个组件里扩散新的 `matchMedia`。
- [ ] 不把新增布局尺寸常量写死在组件内部；统一回收到 `src/styles/app.css` token。
- [ ] 不让 mobile 改造破坏 Windows 端 `WindowControls`、drag region、resize handles、桌面 titlebar 行为。
- [ ] 不把 `windowBackgroundPreference` 扩展成移动端总控语义；它仍只属于窗口材质层。
- [ ] 不通过复杂动画解决结构问题；所有适配优先走布局和密度收敛。

---

## Phase 0 - 锁定边界与基线

**目标：** 先明确这次是“收敛适配策略”，不是换一套 UI。

**涉及文件：**
- `src/App.tsx`
- `src/components/shell/AppChrome.tsx`
- `src/components/shell/Titlebar.tsx`
- `src/components/shell/Sidebar.tsx`
- `src/components/content/ThreadCanvas.tsx`
- `src/components/content/SettingsPanel.tsx`
- `src/lib/app-shell.ts`
- `src/styles/app.css`
- `src-tauri/tauri.conf.json`

- [ ] 通读上述文件，确认当前主链路仍是 `App -> AppChrome -> Sidebar + Main`。
- [ ] 记录当前断点现状：`AppChrome` 仍以 `max-width: 767px` 做紧凑视口分流。
- [ ] 记录当前 Windows 最小窗口基线：`src-tauri/tauri.conf.json` 仍为 `minWidth: 980`、`minHeight: 680`。
- [ ] 记录当前必须保留的桌面能力：Windows 自定义窗口控制、frameless resize、桌面标题栏拖拽区。
- [ ] 运行基线检查：`npm run lint && npm run build`。

---

## Phase 1 - 建立 Responsive Env 与 Layout Policy

**目标：** 先把环境识别与布局决策从组件里抽出来，这是整个方案的阻塞项。

**涉及文件：**
- Create: `src/lib/responsive-env.ts`
- Create: `src/lib/responsive-env.test.ts`
- Create: `src/lib/app-layout-policy.ts`
- Create: `src/lib/app-layout-policy.test.ts`
- Modify: `src/lib/app-shell.ts`
- Modify: `src/components/shell/AppChrome.tsx`

- [ ] 在 `src/lib/responsive-env.ts` 定义统一环境模型，至少输出：`platform`、`formFactor`、`inputMode`、`shellMode`。
- [ ] 将 `formFactor` 明确收敛为 `mobile | tablet | desktop`，不要再使用“手机 / 非手机”二元模型。
- [ ] 在 `src/lib/app-layout-policy.ts` 新增统一布局决策，至少输出：`sidebarMode`、`titlebarMode`、`density`、`contentMaxWidth`、`pageGutter`。
- [ ] 保留 `src/lib/app-shell.ts` 的桌面窗口几何职责，但不再让它独自承担全部 responsive 决策。
- [ ] 从 `src/components/shell/AppChrome.tsx` 移除零散 `matchMedia("(max-width: 767px)")` 逻辑，改为消费统一 policy。
- [ ] 为 `src/lib/responsive-env.test.ts` 覆盖边界宽度：`639 / 640 / 767 / 768 / 1023 / 1024`。
- [ ] 为 `src/lib/app-layout-policy.test.ts` 覆盖至少 6 组场景：Windows desktop、Windows narrow desktop、tablet landscape、tablet portrait、mobile touch、mobile keyboard pending。

**Verify:**
- [ ] `node --test src/lib/responsive-env.test.ts src/lib/app-layout-policy.test.ts src/lib/app-shell.test.ts`

---

## Phase 2 - 收口根状态与最小 token 集

**目标：** 让 CSS 只消费统一状态，不再由组件自己发明布局数值。

**涉及文件：**
- Modify: `src/styles/app.css`
- Modify: `src/App.tsx`
- Modify: `src/components/shell/AppChrome.tsx`
- Optional Create: `src/components/shell/ShellProvider.tsx`

- [ ] 在根节点或 shell 根容器补齐 dataset：`data-form-factor`、`data-shell-mode`、`data-input-mode`、`data-sidebar-mode`。
- [ ] 保留现有 `data-platform`、`data-theme`、`data-window-background`，不要重命名已有稳定入口。
- [ ] 在 `src/styles/app.css` 新增最小布局 token 集，至少包括：`--page-gutter`、`--content-max-width`、`--sidebar-width`、`--topbar-height`、`--composer-height`、`--composer-offset-bottom`、`--control-min-hit-size`、`--viewport-safe-height`。
- [ ] 用 dataset 覆盖 token，不新增 `--mobile-*`、`--tablet-*` 这类重复命名；同名 token 在不同形态下覆写即可。
- [ ] 把 safe-area、底部输入区、顶部留白、内容边距统一改为消费 token，不再散落写死 padding。
- [ ] 若需要 provider，新增 `src/components/shell/ShellProvider.tsx` 统一下发环境状态，但不要把业务状态塞进 provider。

**Verify:**
- [ ] `npm run lint`
- [ ] `node --test src/styles/app.source.test.ts`

---

## Phase 3 - 改造 AppChrome / Titlebar / Sidebar 三端壳层

**目标：** 先把结构改对，再谈细节。

**涉及文件：**
- Modify: `src/components/shell/AppChrome.tsx`
- Modify: `src/components/shell/Titlebar.tsx`
- Modify: `src/components/shell/Sidebar.tsx`
- Modify: `src/lib/app-shell.ts`
- Verify: `src/components/shell/WindowControls.tsx`
- Verify: `src/components/shell/FramelessResizeHandles.tsx`

- [ ] 在 `src/components/shell/AppChrome.tsx` 为 `desktop` 保留桌面壳层，为 `tablet` 建立中间态，为 `mobile` 建立真正的移动壳层。
- [ ] 在 `tablet landscape` 下使用窄常驻导航或 rail，不直接复用当前完整 `w-68` 侧边栏。
- [ ] 在 `tablet portrait` 与 `mobile` 下使用 `Sheet/Drawer` 侧边导航，不让侧栏常驻挤压主内容。
- [ ] 在 `src/components/shell/Titlebar.tsx` 为 `tablet/mobile` 增加轻量 topbar 模式，弱化桌面窗口控制语义；Windows desktop 仍走桌面标题栏逻辑。
- [ ] 收敛顶栏操作数量：平板与移动端只保留导航入口、标题、少量高频动作，其他动作折叠。
- [ ] 在 `src/components/shell/Sidebar.tsx` 调整平板与移动端导航密度，避免 `md` 一到就退回桌面紧凑高度。
- [ ] 验证 `src/components/shell/WindowControls.tsx` 与 `src/components/shell/FramelessResizeHandles.tsx` 无需大改，只要不被新布局回退。

**Verify:**
- [ ] `npm run lint`
- [ ] `node --test src/components/shell/AppChrome.source.test.ts src/components/shell/Sidebar.source.test.ts src/components/shell/Titlebar.source.test.ts src/lib/app-shell.test.ts`

---

## Phase 4 - 改造主内容与设置页的跨端可用性

**目标：** 让核心内容区在手机、平板、桌面都可读、可操作、低噪音。

**涉及文件：**
- Modify: `src/components/content/ThreadCanvas.tsx`
- Modify: `src/components/content/SettingsPanel.tsx`
- Modify: `src/components/shell/AppChrome.tsx`
- Modify: `src/styles/app.css`

- [ ] 在 `src/components/content/ThreadCanvas.tsx` 把内容边距和最大宽度改为消费 policy/token，而不是继续写死 `px-4 md:px-8` 一类断点策略。
- [ ] 将 `ThreadCanvas` 底部 composer 改成“输入优先”结构：主输入 + 发送主动作常驻，附件/模型/强度等次级操作收纳到次层入口。
- [ ] 在移动端和竖屏平板下，保证 composer 与滚动区在 safe area 下可见，不被底部安全区遮挡。
- [ ] 在移动端场景下，为虚拟键盘预留状态位，至少能让 composer 可见、消息区可滚动；不要继续把 `100dvh` 当成完整方案。
- [ ] 在 `src/components/content/SettingsPanel.tsx` 保持单列信息架构，平板与移动端优先通过外层容器和间距收敛密度，不新增第二套设置页。
- [ ] 在 `src/components/shell/AppChrome.tsx` 校准 settings scroll 容器的顶部和底部留白，让其跟随 token/safe-area，而不是继续偏桌面写法。

**Verify:**
- [ ] `npm run lint`
- [ ] `node --test src/components/content/ThreadCanvas.source.test.ts src/components/content/SettingsPanel.source.test.ts`

---

## Phase 5 - 统一触控尺寸并做最终验收

**目标：** 统一最后一层触控手感和回归检查。

**涉及文件：**
- Modify: `src/components/shell/ShellButton.tsx`
- Modify: `src/components/ui/button.tsx`
- Modify: `src/components/ui/input.tsx`
- Modify: `src/components/ui/textarea.tsx`
- Modify: `src/styles/app.css`

- [ ] 将 `src/components/shell/ShellButton.tsx` 的 `nav` 触控高度策略改为“mobile/tablet 默认触控优先，desktop 再收紧”。
- [ ] 调整 `src/components/ui/button.tsx` 的 `default / sm / icon` 尺寸，让平板与移动端点击目标不少于 `44x44`，桌面端再回到紧凑密度。
- [ ] 检查 `src/components/ui/input.tsx` 与 `src/components/ui/textarea.tsx` 的字号、内边距和高度，避免移动端输入体验过小。
- [ ] 只在必要时补少量 token，不要把 `app.css` 扩成第二套设计系统。
- [ ] 补一份 source/contract 测试，锁定 `AppChrome` 仍是唯一壳层入口、dataset 命名仍稳定、Windows 桌面逻辑未被移动端回退。
- [ ] 跑最终验证：`npm run lint && npm run build`。

---

## 验收矩阵（DoD）

### Windows Desktop

- [ ] 在 `980 x 680` 最小窗口下不破版。
- [ ] 标题栏可拖拽，右上角窗口控制区可点击且不与标题内容重叠。
- [ ] 最大化 / 还原后布局稳定，无异常裁切。
- [ ] 侧边栏在常规窗口下保持桌面常驻模式。
- [ ] 设置页与主内容区滚动关系清晰，无双滚动冲突。

### Tablet

- [ ] 横屏与竖屏都可用，且导航策略不同但一致可维护。
- [ ] 不再强行复用 Windows titlebar 范式。
- [ ] 触控目标不少于 `44x44`。
- [ ] 主内容区宽度、边距、表单宽度适中，不显挤也不显空。
- [ ] 设置页保持单列阅读，不做双栏表单。

### Mobile

- [ ] 无桌面标题栏残留。
- [ ] 侧边栏通过 `Sheet/Drawer` 打开关闭，主内容优先。
- [ ] 底部 composer 在 safe area 与键盘弹起后仍可见、可用。
- [ ] 首屏信息精简，无桌面状态条和多余常驻操作。
- [ ] 所有主路径支持单手触达。

---

## 必须手工验收的场景

- [ ] Windows Tauri 真机窗口行为：拖拽、最小化、最大化、还原、关闭、resize handles。
- [ ] 平板横屏 / 竖屏切换：导航模式、内容宽度、设置页滚动、顶栏密度。
- [ ] 移动端键盘弹出：composer 可见性、滚动容器高度、底部安全区遮挡。
- [ ] 透明材质组合：light / dark、opaque / translucent、Windows 分支视觉层级。
- [ ] 焦点与滚动：Drawer 打开时焦点管理、设置页长列表、主内容区滚动稳定性。

---

## 外部参考链接（只引用，不贴全文）

- [Tailwind CSS - Responsive Design](https://tailwindcss.com/docs/responsive-design)
- [MDN - `env()` and safe-area / titlebar variables](https://developer.mozilla.org/en-US/docs/Web/CSS/env)
- [Tauri v2 - Window Customization](https://v2.tauri.app/learn/window-customization/)
- [Microsoft Learn - Title bar customization](https://learn.microsoft.com/en-us/windows/apps/develop/title-bar)
- [Microsoft Learn - Windows title bar design basics](https://learn.microsoft.com/en-us/windows/apps/design/basics/titlebar-design)

---

## 给 LLM 的执行 Prompt

```text
请按 /Users/ba7mlv/Documents/ui/study-ui/docs/plans/2026-03-19-win-tablet-mobile-ui-adaptation-executable-todo.md 执行，不要重写产品，不要新增组件库，不要复制三套页面。

执行原则：
1. 先做环境状态层，再做 token，再做 AppChrome，再做内容页，最后做控件尺寸和验收。
2. 保留当前 App -> AppChrome -> Sidebar + Main 骨架。
3. 保留 Windows 桌面窗口控制、拖拽区、frameless resize、最小窗口尺寸逻辑。
4. 新增统一环境模型，至少覆盖：platform、formFactor、inputMode、shellMode。
5. 新增统一布局策略，至少覆盖：sidebarMode、titlebarMode、density、contentMaxWidth、pageGutter。
6. 把零散 matchMedia 从 AppChrome 内部移走，统一收敛到单一状态源。
7. 在根节点补齐 data-form-factor、data-shell-mode、data-input-mode、data-sidebar-mode，并保留 data-platform、data-theme、data-window-background。
8. 新增最小 token 集到 src/styles/app.css，不要在组件内部发明新的布局常量。
9. Tablet 横屏使用窄常驻导航，tablet 竖屏和 mobile 使用抽屉导航。
10. Mobile 优先解决 safe area、bottom composer、keyboard 遮挡、settings 单列，不优先做视觉花活。
11. ThreadCanvas 的 composer 改成输入优先，次级操作收纳，不要桌面按钮全部常驻。
12. SettingsPanel 保持单列信息架构，通过外层容器和间距适配，不复制第二套设置页。
13. 触控目标在 mobile/tablet 下不少于 44x44，desktop 再回到紧凑密度。
14. 每完成一个 phase，都只勾选对应 checkbox，并附带验证结果。
15. 最终输出只包含：变更文件、核心差异、验证结果、剩余风险。

禁止事项：
- 禁止新增组件库、CSS-in-JS、响应式第三方库。
- 禁止复制 Desktop/Tablet/Mobile 三套页面。
- 禁止继续在多个组件里扩散新的 matchMedia。
- 禁止让 mobile 改造破坏 Windows 桌面行为。
- 禁止用复杂动画掩盖结构问题。
```
