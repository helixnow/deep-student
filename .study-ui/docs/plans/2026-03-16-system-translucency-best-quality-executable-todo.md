# 系统半透明效果最优质实现执行清单

> **For LLM:** 按 Phase 顺序执行；每完成一项就在对应 checkbox 打勾；不要重写本文档结构；不要输出全文，只引用此文件路径；这次优化的是当前仓库里 Claude Code 已经写出的窗口半透明实现，目标是把它收敛到“更原生、更稳定、更低噪音”的系统级效果，而不是做更花的玻璃。

**目标**
让 `/Users/ba7mlv/Documents/ui/study-ui` 在 macOS / Windows / Tauri 场景下获得更高质量的系统半透明体验：
1. macOS 保持原生标题栏与导航层的安静材质感，不误用整窗伪玻璃
2. Windows 从 `Blur` 升级到更适合长期桌面窗口的系统材质策略
3. Web 层只承担轻量 tint 和分层，不叠加多层 blur 伪造系统效果
4. 为“减少透明度 / 低性能 / 不支持系统材质”建立明确回退路径

**非目标**
- 不新增营销页式玻璃、高饱和渐变、夸张阴影
- 不引入新组件库
- 不把 `main content` 也做成和导航层同等级的玻璃材质
- 不为了“更透明”牺牲可读性、边界稳定性和拖动/缩放性能

**四路并行调研结论摘要**
- **Track A / Apple 语义层级**：Apple 强调 material 应优先服务 navigation / controls；sidebar 属于单独的功能层，内容层不要同级玻璃化。新设计里 sidebar 是浮在内容之上的 pane，继续在里面叠老式 effect view 会干扰系统玻璃。来源：[Materials](https://developer.apple.com/design/human-interface-guidelines/materials/)、[Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars/)、[Build an AppKit app with the new design - WWDC25](https://developer.apple.com/videos/play/wwdc2025/310/)
- **Track B / Windows 系统材质**：Microsoft 将 Mica 定位为更适合长期桌面窗口背景的材质；Acrylic 更适合临时表面，并且不建议把多个 Acrylic 面并排堆叠。来源：[Apply Mica or Acrylic materials in desktop apps for Windows 11](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/ui/apply-mica-win32)、[Material design in WinUI 3](https://learn.microsoft.com/en-us/windows/apps/design/style/materials)
- **Track C / Tauri 实现边界**：Tauri 2 支持 `mica` / `tabbed` / `blur` / `acrylic` 等 effect；官方还明确提示：Windows 上 `transparent: true` + `decorations: false` + `effects: ["blur"]` 在某些版本拖动/缩放性能较差，`acrylic` 也存在版本相关性能问题。来源：[Tauri window config](https://v2.tauri.app/reference/config/#windowconfig)、[Tauri window customization guide](https://v2.tauri.app/learn/window-customization/)
- **Track D / Web/CSS 与可访问性**：`backdrop-filter` 只应在半透明元素上少量使用；若用户偏好减少透明度，应提供更实心、更稳定的回退。来源：[MDN backdrop-filter](https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter)、[MDN prefers-reduced-transparency](https://developer.mozilla.org/en-US/docs/Web/CSS/%40media/prefers-reduced-transparency)

**当前仓库问题定位**
- `/Users/ba7mlv/Documents/ui/study-ui/src/lib/native-window.ts`
  - 当前 Windows 半透明固定映射到 `windows-blur`，没有 `Mica -> fallback` 策略
  - macOS 虽定义了 `macos-window-background` / `macos-content-background` / `macos-sidebar` preset，但实际半透明路径全部清空 effect，说明当前实现还没有形成稳定的平台材质决策
- `/Users/ba7mlv/Documents/ui/study-ui/src-tauri/src/window_background.rs`
  - 启动期 Windows 仍默认 `WindowEffect::Blur`
  - macOS 当前 `transparent = false + titleBarStyle = Transparent` 的方向是对的，不应轻易退回整窗透明 + 整窗玻璃
- `/Users/ba7mlv/Documents/ui/study-ui/src/styles/app.css`
  - 当前 translucent 模式已把 `html/body/#root` 设为透明，这个思路正确
  - 但还缺少 `prefers-reduced-transparency` 回退，以及更明确的“导航层轻透、内容层更稳”的 token 策略
- `/Users/ba7mlv/Documents/ui/study-ui/src/components/content/SettingsPanel.tsx`
  - 目前只提供“使用不透明窗口背景”开关，语义够用，但还未明确承接系统减少透明度或平台 effect fallback 的状态

---

## Phase 0 - 锁定事实与边界

- [x] 通读以下文件，不要立刻改代码：
  - `/Users/ba7mlv/Documents/ui/study-ui/src/lib/native-window.ts`
  - `/Users/ba7mlv/Documents/ui/study-ui/src-tauri/src/window_background.rs`
  - `/Users/ba7mlv/Documents/ui/study-ui/src/lib/app-shell.ts`
  - `/Users/ba7mlv/Documents/ui/study-ui/src/styles/app.css`
  - `/Users/ba7mlv/Documents/ui/study-ui/src/components/shell/AppChrome.tsx`
  - `/Users/ba7mlv/Documents/ui/study-ui/src/components/content/SettingsPanel.tsx`
- [x] 先确认当前实现的真实架构：`native window effect` 只负责窗口级材质，React/Tailwind 只负责内部 tint 和分层，不存在真正的局部系统材质子视图
- [x] 在本文档“实施备注”区补一句：当前仓库是否具备“macOS sidebar 局部原生材质”能力；如果没有，就不要强行设计一个无法在现有 Tauri 架构里精确落地的方案

## Phase 1 - 先统一平台材质策略，不要先改样式

- [x] 在 `/Users/ba7mlv/Documents/ui/study-ui/src/lib/native-window.ts` 明确平台策略常量，禁止再把不同平台的半透明决策散落在分支里
- [x] 把目标策略写清楚：
  - macOS：保留 `transparent title bar + solid/native background color` 的稳态方案；不要把整个窗口切回 full transparent vibrancy
  - Windows：把长期主窗口的首选 effect 从 `Blur` 改为 `Mica`
  - 其他平台：默认不用系统 effect，只保留现有纯色/轻透 token
- [x] 明确一个单向原则：**系统材质只负责窗口级氛围；导航层和内容层的区分仍由 token 完成，不靠多层 blur 叠加**
- [x] 把这套策略同步到 `/Users/ba7mlv/Documents/ui/study-ui/src-tauri/src/window_background.rs` 与 `/Users/ba7mlv/Documents/ui/study-ui/src/lib/native-window.ts`，避免启动期和运行期不一致

## Phase 2 - Windows 从 Blur 升级为 Mica-first，并建立回退链

- [x] 在 `/Users/ba7mlv/Documents/ui/study-ui/src/lib/native-window.ts` 的 runtime `effectMap` 中加入 Windows `mica`（必要时预留 `tabbed`，但默认不要启用）
- [x] 将 translucent Windows 策略改成按顺序尝试：
  - `Mica`
  - 失败时回退到 `Blur`
  - 再失败则 `clearEffects()` 并使用更稳的纯色背景
- [x] 不要默认使用 `Tabbed`；只有当标题栏真正变成浏览器式 tabbed chrome 时再评估
- [x] `/Users/ba7mlv/Documents/ui/study-ui/src-tauri/src/window_background.rs` 启动期不要再写死 `WindowEffect::Blur`；要么改成与 runtime 一致的 Mica-first，要么在无法可靠判断时让启动期更保守、运行期再升级
- [x] 如果 Tauri/Rust 侧无法稳定判断 Windows 版本，就把“fallback 顺序”放在最小闭环内，确保 unsupported effect 不会把窗口卡在半透明坏状态
- [x] 补测试覆盖：
  - `/Users/ba7mlv/Documents/ui/study-ui/src/lib/native-window.test.ts`
  - `/Users/ba7mlv/Documents/ui/study-ui/scripts/window-background-system-effect-contract.test.mjs`
  - 断言 Windows translucent 不再默认锁死为 blur-only

## Phase 3 - macOS 继续走“克制原生感”，不要追求整窗玻璃

- [x] 保持 `/Users/ba7mlv/Documents/ui/study-ui/src-tauri/src/window_background.rs` 中 macOS 的 `transparent = false`、`decorations = true`、`titleBarStyle = Transparent` 基线，不要为了更像玻璃而改成整窗透明
- [x] `/Users/ba7mlv/Documents/ui/study-ui/src/lib/native-window.ts` 中 macOS translucent 继续以 `clearEffects()` 为默认，除非你能在现有架构里证明某个系统 effect 能稳定且只影响应影响的层
- [x] 不要给 macOS 新增 `backdrop-blur-*`、白色高光蒙层、伪玻璃边缘线来“补 Apple 味”
- [x] 视觉重点放在 `/Users/ba7mlv/Documents/ui/study-ui/src/lib/app-shell.ts` 与 `/Users/ba7mlv/Documents/ui/study-ui/src/styles/app.css` 的 token 收敛：
  - `navigation/chrome layer` 更轻、更安静
  - `content/workspace layer` 更稳、更实心
  - seam / divider 更薄、更连续
- [x] 如果评估后发现当前 macOS 路线已经比“整窗透明 + CSS 伪玻璃”更优，要在“实施备注”区明确写下来，避免后续 agent 又把它改坏

## Phase 4 - Web 层只保留单层 tint，不做多层 blur 叠加

- [x] `/Users/ba7mlv/Documents/ui/study-ui/src/styles/app.css` 继续保持 translucent 模式下 `html/body/#root` 透明，但不要引入新的全局 `backdrop-filter`
- [x] 统一 shell token 语义：
  - `--shell-backdrop`：窗口级背景承接色
  - `--shell-panel`：导航层表面
  - `--shell-panel-strong`：主工作区表面
- [x] 不让 sidebar、titlebar、main content 同时都带类似“玻璃感”的半透明强度；主内容必须更稳，不和导航层抢材质层级
- [x] 审查 `/Users/ba7mlv/Documents/ui/study-ui/src/components/shell/AppChrome.tsx`、`/Users/ba7mlv/Documents/ui/study-ui/src/components/shell/Sidebar.tsx`、`/Users/ba7mlv/Documents/ui/study-ui/src/components/content/SettingsPanel.tsx`：
  - 不新增 `backdrop-blur-*`
  - 不新增大面积 `bg-white/xx` 伪高光
  - 不新增多层 overlay/shadow 去伪造系统材质
- [x] 如果某个面板必须略微提升可读性，只能通过现有 token 提高不透明度，不要另开一套 blur 数值系统

## Phase 5 - 补上减少透明度与失败回退

- [x] 在 `/Users/ba7mlv/Documents/ui/study-ui/src/styles/app.css` 增加 `@media (prefers-reduced-transparency: reduce)` 回退，至少做到：
  - 提高 `--shell-backdrop`
  - 提高 `--shell-panel`
  - 提高 `--shell-panel-strong`
  - 提高 `--overlay`
- [x] reduced transparency 下不要再依赖根层透明来表达层次，优先改为更实的 token
- [x] 若浏览器环境不支持该 media query，也不要报错；保持渐进增强
- [x] 在 `/Users/ba7mlv/Documents/ui/study-ui/src/components/content/SettingsPanel.tsx` 检查文案是否需要补一句说明：系统减少透明度或 effect 不可用时，应用会自动回退到更实的外观
- [x] 若现有“使用不透明窗口背景”开关已足够，不要再新增第二个意义重叠的设置项

## Phase 6 - 收口到一个低复杂度、可维护的实现

- [x] 删除或重构任何会导致“平台 effect、CSS tint、组件局部 overlay”三套逻辑互相打架的分支
- [x] 优先让 `/Users/ba7mlv/Documents/ui/study-ui/src/lib/native-window.ts` 只回答两件事：
  - 当前平台该用什么 native effect
  - 失败时怎么回退
- [x] 优先让 `/Users/ba7mlv/Documents/ui/study-ui/src/lib/app-shell.ts` 与 `/Users/ba7mlv/Documents/ui/study-ui/src/styles/app.css` 只回答两件事：
  - 导航层和内容层的视觉层级
  - opaque / translucent 两种模式下 token 怎么变化
- [x] 不要把“更像系统”理解成“更多半透明”；真正的目标是：更安静、更稳定、更清晰

## Phase 7 - 测试、验证、记录

- [x] 先补/改测试，再改实现，至少覆盖：
  - Windows translucent 首选 `Mica` 而不是固定 `Blur`
  - Windows effect 失败时存在明确 fallback
  - macOS translucent 仍不走 full-window transparent vibrancy
  - reduced transparency 会把关键 shell token 拉回更实
- [x] 优先检查这些测试文件：
  - `/Users/ba7mlv/Documents/ui/study-ui/src/lib/native-window.test.ts`
  - `/Users/ba7mlv/Documents/ui/study-ui/src/lib/app-shell.test.ts`
  - `/Users/ba7mlv/Documents/ui/study-ui/src/styles/app.source.test.ts`
  - `/Users/ba7mlv/Documents/ui/study-ui/scripts/window-background-system-effect-contract.test.mjs`
  - `/Users/ba7mlv/Documents/ui/study-ui/scripts/window-background-visual-contract.test.mjs`
- [x] 跑局部测试：
```bash
node --test --experimental-strip-types src/lib/native-window.test.ts src/lib/app-shell.test.ts src/styles/app.source.test.ts scripts/window-background-system-effect-contract.test.mjs scripts/window-background-visual-contract.test.mjs
```
- [x] 跑全量源码测试：
```bash
node --test --experimental-strip-types $(find src -type f \( -name '*.test.ts' -o -name '*.source.test.ts' \) | sort)
```
- [x] 跑基础校验：
```bash
npm run lint
npm run build
```
- [x] 把验证结果追加到本文档“验证记录”区，写明命令、结果、失败点和最终取舍

---

## 实施备注

- [x] 当前 Tauri 架构不具备“只给 macOS sidebar 应用原生系统材质而不影响整窗”的精确能力；现有实现只有窗口级 effect 与 Web 层 token 分层，因此保持 macOS 稳态原生标题栏路线，不做伪原生 sidebar 补丁；在该架构下，这条路线也比“整窗透明 + CSS 伪玻璃”更稳、更接近原生
- [x] Windows 采用 `Mica -> Blur -> Opaque` 回退链；理由是主窗口优先使用更适合长期驻留桌面窗口的 Mica，若当前系统/驱动不支持再退回 Blur，最后通过 `clearEffects()` + 纯色背景兜底，避免坏掉的半透明状态残留
- [x] reduced transparency 回退只通过 token 提高不透明度和根层背景回填完成，不额外新增用户设置；现有“使用不透明窗口背景”开关继续作为显式手动覆盖入口

## 验证记录

- [x] 2026-03-16：先按 TDD 改写 `/Users/ba7mlv/Documents/ui/study-ui/src/lib/native-window.test.ts`、`/Users/ba7mlv/Documents/ui/study-ui/src/styles/app.source.test.ts`、`/Users/ba7mlv/Documents/ui/study-ui/scripts/window-background-system-effect-contract.test.mjs`、`/Users/ba7mlv/Documents/ui/study-ui/scripts/window-background-visual-contract.test.mjs`，先验证失败，再实现。
- [x] `node --test --experimental-strip-types src/lib/native-window.test.ts src/styles/app.source.test.ts scripts/window-background-system-effect-contract.test.mjs scripts/window-background-visual-contract.test.mjs`：初次运行失败，确认缺口为 Windows 仍是 blur-only、缺少 reduced transparency 回退、设置文案未承接自动回退。
- [x] `node --test --experimental-strip-types src/lib/native-window.test.ts src/lib/app-shell.test.ts src/styles/app.source.test.ts scripts/window-background-system-effect-contract.test.mjs scripts/window-background-visual-contract.test.mjs`：通过，40 tests passed。
- [x] `node --test --experimental-strip-types $(find src -type f \( -name '*.test.ts' -o -name '*.source.test.ts' \) | sort)`：通过，113 tests passed。
- [x] `npm run lint`：通过，exit code 0。
- [x] `npm run build`：通过，Vite 生产构建完成。
- [x] 最终取舍：Windows 启动期与运行期都切到 Mica-first，但真正的 effect fallback 只放在运行期最小闭环里；macOS 继续保持非整窗透明；Web 层通过 token 和根层背景回退解决 reduced transparency，不新增 blur 体系

## 参考链接（仅引用，不要整段抄录）

- [Apple Materials](https://developer.apple.com/design/human-interface-guidelines/materials/)
- [Apple Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars/)
- [Apple Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars/)
- [Build an AppKit app with the new design - WWDC25](https://developer.apple.com/videos/play/wwdc2025/310/)
- [Apply Mica or Acrylic materials in desktop apps for Windows 11](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/ui/apply-mica-win32)
- [Material design in WinUI 3](https://learn.microsoft.com/en-us/windows/apps/design/style/materials)
- [Tauri window config](https://v2.tauri.app/reference/config/#windowconfig)
- [Tauri window customization guide](https://v2.tauri.app/learn/window-customization/)
- [MDN backdrop-filter](https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter)
- [MDN prefers-reduced-transparency](https://developer.mozilla.org/en-US/docs/Web/CSS/%40media/prefers-reduced-transparency)
