# macOS 轻度毛玻璃 Implementation Plan

> **For LLM:** 按 Phase 顺序执行；每完成一项就在对应 checkbox 打勾；不要重写本文档结构；不要输出全文，只引用此文件路径；目标是把 macOS 的 `translucent` 从“伪半透明”升级成“轻度系统毛玻璃”，不是引入更花的 Web 玻璃。

**Goal:** 让 `/Users/ba7mlv/Documents/ui/study-ui` 在 macOS 下的 `translucent` 模式使用克制的原生毛玻璃，同时保留原生标题栏、稳定的内容可读性，以及明确的回退路径。

**Architecture:** 继续沿用当前仓库的“原生窗口能力 + Web token 表面层”架构。macOS 只在窗口级启用单一 `WindowBackground` material；Web 层只负责 `titlebar/sidebar/workspace` 的近实色分层，不新增 `backdrop-blur-*` 或假玻璃。

**Tech Stack:** Tauri 2.7、Rust、React 19、TypeScript 5.9、Tailwind CSS v4、Node test runner、ESLint

---

## 结论先定

- 推荐 material：`WindowBackground`
- 推荐覆盖边界：`window shell / titlebar / sidebar`
- 主内容区策略：保持 `--shell-panel-strong` 近实色，不做玻璃
- 原生 effect state：`FollowsWindowActiveState`
- 回退规则：`Reduce Transparency`、native effect 失败、非 macOS、`opaque` 偏好时都回退到更实的外观
- 平台策略：macOS 增强；Windows 保持现有 `Mica -> Blur`；其他平台保持现状
- 分发前提：该方案默认按“非 Mac App Store 渠道”设计；若未来要走 MAS，需单独维护 `opaque` 变体

## 四轮并行调研结论摘要

- **Round 1 / 官方能力与平台约束**
  - Tauri 的 `windowEffects` 依赖 `transparent: true`
  - macOS 透明窗口依赖 `macOSPrivateApi`，并带来 App Store 接受风险
  - Tauri / AppKit 都提供语义化 material；对当前仓库最稳的是单一 `WindowBackground`
  - `window-vibrancy` 示例同样要求 Tauri 透明窗口、透明根层、macOS private API

- **Round 2 / 仓库现状与接入点**
  - 当前仓库并非“没做完毛玻璃”，而是明确把 macOS 真正毛玻璃关掉了
  - 关键关闭点在：
    - `/Users/ba7mlv/Documents/ui/study-ui/src-tauri/tauri.macos.conf.json`
    - `/Users/ba7mlv/Documents/ui/study-ui/src-tauri/src/window_background.rs`
    - `/Users/ba7mlv/Documents/ui/study-ui/src/lib/native-window.ts`
  - 对应测试也已把“macOS 不开 transparent-window vibrancy”固化为合约

- **Round 3 / 设计与实现策略**
  - 毛玻璃只该落在窗口壳层，不进入正文阅读层
  - 最稳方案是：`native WindowBackground + Web 侧近实色 token`
  - 不推荐在 React/Tailwind 里加 `backdrop-blur-*`
  - 主内容区、输入区、弹层、卡片主体都应继续保持近实色

- **Round 4 / 验证与发布风险**
  - 自动化测试只能证明“配置/同步/token”不回归，不能替代真实 macOS 手工验收
  - 最终验收必须覆盖：`lint + node/cargo tests + tauri:dev 手工验收 + tauri:build 打包验收`
  - 需要把“失败即回退 opaque”写成显式规则，而不是隐式依赖平台行为

## 当前仓库最小改动面

- 原生启动层
  - `/Users/ba7mlv/Documents/ui/study-ui/src-tauri/tauri.macos.conf.json`
  - `/Users/ba7mlv/Documents/ui/study-ui/src-tauri/src/window_background.rs`
- 运行时同步层
  - `/Users/ba7mlv/Documents/ui/study-ui/src/lib/native-window.ts`
  - `/Users/ba7mlv/Documents/ui/study-ui/src/components/theme/theme-provider.tsx`
  - `/Users/ba7mlv/Documents/ui/study-ui/src/lib/theme.ts`
- Web 表面层
  - `/Users/ba7mlv/Documents/ui/study-ui/src/styles/app.css`
  - `/Users/ba7mlv/Documents/ui/study-ui/src/components/content/SettingsPanel.tsx`
- 必改测试
  - `/Users/ba7mlv/Documents/ui/study-ui/src-tauri/tauri.macos.source.test.ts`
  - `/Users/ba7mlv/Documents/ui/study-ui/src-tauri/src/window_background.rs`
  - `/Users/ba7mlv/Documents/ui/study-ui/src/lib/native-window.test.ts`
  - `/Users/ba7mlv/Documents/ui/study-ui/src/lib/theme.test.ts`
  - `/Users/ba7mlv/Documents/ui/study-ui/scripts/window-background-bootstrap-contract.test.mjs`
  - `/Users/ba7mlv/Documents/ui/study-ui/scripts/window-background-system-effect-contract.test.mjs`
  - `/Users/ba7mlv/Documents/ui/study-ui/src/styles/app.source.test.ts`

---

## Phase 0 - 锁定边界与守护条件

- [x] 通读以下文件，不要立刻改 UI 结构：
  - `/Users/ba7mlv/Documents/ui/study-ui/src-tauri/tauri.macos.conf.json`
  - `/Users/ba7mlv/Documents/ui/study-ui/src-tauri/src/window_background.rs`
  - `/Users/ba7mlv/Documents/ui/study-ui/src/lib/native-window.ts`
  - `/Users/ba7mlv/Documents/ui/study-ui/src/components/theme/theme-provider.tsx`
  - `/Users/ba7mlv/Documents/ui/study-ui/src/lib/theme.ts`
  - `/Users/ba7mlv/Documents/ui/study-ui/src/styles/app.css`
  - `/Users/ba7mlv/Documents/ui/study-ui/src/components/content/SettingsPanel.tsx`
- [x] 先在本文档“实施备注”区补一句：本方案只服务于 macOS 非 App Store 渠道，不追求 MAS 兼容
- [x] 锁定 3 条硬规则：
  - 只在 `platform === macos` 时启用
  - 只在 `windowBackgroundPreference === "translucent"` 时启用
  - 只在系统未开启 `Reduce Transparency` 时启用；否则回退更实外观
- [x] 锁定 3 条禁止项：
  - 禁止新增 `backdrop-blur-*` / `backdrop-filter`
  - 禁止把主内容区改成玻璃
  - 禁止改成 `Overlay` 标题栏或自绘交通灯

## Phase 1 - 先翻转测试合约，再动实现

- [x] 先改 `/Users/ba7mlv/Documents/ui/study-ui/src-tauri/src/window_background.rs` 里的 Rust 单测，目标从“macOS translucent 禁止 effect”改成“允许单一 `WindowBackground` effect”
- [x] 更新 `/Users/ba7mlv/Documents/ui/study-ui/src/lib/native-window.test.ts`，把 `applies translucent macOS mode without transparent-window vibrancy` 这一类语义改成新的目标
- [x] 更新 `/Users/ba7mlv/Documents/ui/study-ui/src-tauri/tauri.macos.source.test.ts`，让 macOS translucent 允许 `transparent: true`
- [x] 更新 `/Users/ba7mlv/Documents/ui/study-ui/scripts/window-background-bootstrap-contract.test.mjs`
- [x] 更新 `/Users/ba7mlv/Documents/ui/study-ui/scripts/window-background-system-effect-contract.test.mjs`
- [x] 保留并强化以下合约，不要被新方案破坏：
  - 不新增 Web 层 blur
  - `opaque` 模式仍然是明确、稳定、近实色
  - 非 macOS 平台不尝试 macOS material
- [x] 若准备把 `Reduce Transparency` 接进运行时守护，同步补 `/Users/ba7mlv/Documents/ui/study-ui/src/lib/theme.test.ts` 或对应新 helper 的测试

## Phase 2 - 改 macOS 启动期窗口策略，避免首帧假状态

- [x] 在 `/Users/ba7mlv/Documents/ui/study-ui/src-tauri/tauri.macos.conf.json` 中把 macOS 主窗口的 `transparent` 改为 `true`
- [x] 保留以下配置，不要一起推翻：
  - `decorations: true`
  - `titleBarStyle: "Transparent"`
  - `hiddenTitle: true`
  - 原生阴影与圆角相关的默认路径
- [x] 在 `/Users/ba7mlv/Documents/ui/study-ui/src-tauri/src/window_background.rs` 中把 macOS `Translucent` 分支从“`transparent = false + window_effects = None`”改成“允许透明 + 单一 `WindowEffect::WindowBackground`”
- [x] 优先给 macOS effect 配置 `state = FollowsWindowActiveState`
- [x] `Opaque` 分支继续保证：
  - 不启用 effect
  - 背景回到稳定实色
  - 不把窗口留在半透明坏状态
- [x] 启动期与运行期策略保持一致，避免首帧毛玻璃和后续状态相互打架

## Phase 3 - 改运行期同步，让设置切换和主题切换都成立

- [x] 在 `/Users/ba7mlv/Documents/ui/study-ui/src/lib/native-window.ts` 中把 macOS `translucentEffects` 从空数组改成 `["macos-window-background"]`
- [x] 运行期 macOS translucent 不要再灌高 alpha 实色背景；优先让原生 material 发挥作用
- [x] 仅在 macOS 下给 effect 设置 `followsWindowActiveState`
- [x] 任一 native effect 设置失败时，执行：
  - `clearEffects()`
  - 恢复实色背景
  - 返回可预期的 `applied`/fallback 结果，不留中间态
- [x] 保持 Windows 现有策略，不要借这次改造重写 `Mica -> Blur`
- [x] 保持 other 平台现状，不新增透明窗口要求

## Phase 4 - 把 Reduce Transparency 做成显式守护，而不是只靠 CSS 运气

- [x] 评估是否通过 `matchMedia("(prefers-reduced-transparency: reduce)")` 接入运行时守护；优先复用 `/Users/ba7mlv/Documents/ui/study-ui/src/lib/theme.ts` 与 `/Users/ba7mlv/Documents/ui/study-ui/src/components/theme/theme-provider.tsx`
- [x] 若当前环境可稳定监听该 media query，则把 native effect 开关也接入：
  - `reduce` 时强制走更实外观
  - 解除 `reduce` 时再恢复 macOS translucent effect
- [x] 若当前环境无法稳定热切换 native effect，至少保证：
  - CSS token 回退立即成立
  - 重启后 native fallback 稳定成立
  - 已知限制写入“实施备注”
- [x] 无论是否支持热切换，都保留 `/Users/ba7mlv/Documents/ui/study-ui/src/styles/app.css` 里的 CSS 回退

## Phase 5 - 调整 Web 表面层，只收紧 token，不发明玻璃组件

- [x] 保持 `/Users/ba7mlv/Documents/ui/study-ui/src/styles/app.css` 中 translucent 下的 `html/body/#root { background: transparent; }`
- [x] 重新校准以下 token，让“轻玻璃 + 近实色内容”成立：
  - `--shell-backdrop`
  - `--shell-panel`
  - `--shell-panel-strong`
  - `--shell-titlebar`
  - `--shell-float`
- [x] 目标层级写死为：
  - titlebar = 轻透导航层
  - sidebar = 轻透导航层
  - workspace = 近实色内容层
  - dialog/popover/input = 实色层
- [x] dark 模式比 light 更克制，不追求明显玻璃感
- [x] 保留 `/Users/ba7mlv/Documents/ui/study-ui/src/styles/app.source.test.ts` 中“不要新增 Web blur”的约束
- [x] 不必大改 `/Users/ba7mlv/Documents/ui/study-ui/src/components/shell/AppChrome.tsx` 与 `/Users/ba7mlv/Documents/ui/study-ui/src/components/shell/Sidebar.tsx`，除非 token 映射本身已不足以表达层级

## Phase 6 - 更新设置文案与产品语义，避免误导用户

- [x] 更新 `/Users/ba7mlv/Documents/ui/study-ui/src/components/content/SettingsPanel.tsx` 中“使用不透明窗口背景”的说明文案
- [x] 把文案从“纯色 vs 半透明”收敛成更准确的语义：
  - macOS：原生轻度毛玻璃 vs 更实的纯色外观
  - Windows：原生系统材质 vs 更实的纯色外观
- [x] 文案里明确说明：系统减少透明度或平台 effect 不可用时，会自动回退到更实的外观
- [x] 不新增第二个意义重叠的设置项；继续复用当前 `opaque / translucent` 开关

## Phase 7 - 验证、打包、人工验收

- [x] 先跑局部自动化回归：
```bash
npm run lint
node --test --experimental-strip-types /Users/ba7mlv/Documents/ui/study-ui/src/lib/native-window.test.ts /Users/ba7mlv/Documents/ui/study-ui/src/lib/native-window-preference.test.ts /Users/ba7mlv/Documents/ui/study-ui/src/lib/theme.test.ts /Users/ba7mlv/Documents/ui/study-ui/src/lib/app-shell.test.ts /Users/ba7mlv/Documents/ui/study-ui/src-tauri/tauri.macos.source.test.ts
node --test /Users/ba7mlv/Documents/ui/study-ui/scripts/window-background-bootstrap-contract.test.mjs /Users/ba7mlv/Documents/ui/study-ui/scripts/window-background-system-effect-contract.test.mjs /Users/ba7mlv/Documents/ui/study-ui/scripts/window-background-visual-contract.test.mjs /Users/ba7mlv/Documents/ui/study-ui/scripts/native-window-theme-provider-contract.test.mjs
cargo test --manifest-path /Users/ba7mlv/Documents/ui/study-ui/src-tauri/Cargo.toml
```
  - 结果（2026-03-17）：`npm run lint` 通过；`node --test --experimental-strip-types ...` 48/48 通过；`node --test ...scripts...` 8/8 通过；`cargo test --manifest-path /Users/ba7mlv/Documents/ui/study-ui/src-tauri/Cargo.toml` 全绿（7 个 Rust 单测 + 0 个 main 单测 + 0 个 doc test）。
- [x] 再跑开发环境手工验收：
```bash
npm run tauri:dev
```
  - 结果（2026-03-17）：命令完整跑通，Rust dev binary 成功编译并运行到 `target/debug/app`；当前 CLI 会话无法直接观测 GUI 像素，因此下方视觉/状态项仍需在图形桌面会话里补做人工确认。
- [ ] 手工确认以下视觉点：
  - 原生圆角、阴影、交通灯仍自然
  - 只有窗口壳层有轻度毛玻璃
  - 主内容区不发灰、不发糊
  - `opaque` 与 `translucent` 切换边界明确
  - 不存在原生 vibrancy + Web blur 双重模糊
- [ ] 手工确认以下状态点：
  - light / dark / system
  - 聚焦 / 失焦
  - `Reduce Transparency`
  - 应用重启后的偏好持久化
- [x] 再跑打包验证：
```bash
npm run build
npm run tauri:build
```
  - 结果（2026-03-17）：`npm run build` 通过；`npm run tauri:build` 通过，生成 `/Users/ba7mlv/Documents/ui/study-ui/src-tauri/target/release/bundle/macos/Deep Student.app`。
- [x] 从生成的 `.app` 实际启动验证，不只看 dev 模式
  - 结果（2026-03-17）：已直接执行 `/Users/ba7mlv/Documents/ui/study-ui/src-tauri/target/release/bundle/macos/Deep Student.app/Contents/MacOS/app`，进程可启动并保持运行，后由本轮 CLI 手动中断；最终像素级目视验收仍建议在图形桌面会话里完成。

## Phase 8 - 收口与记录

- [x] 在本文档“实施备注”区补写最终取舍：为什么最终选择 `WindowBackground`，而不是 `Sidebar` / `ContentBackground`
- [x] 记录 `Reduce Transparency` 的最终实现方式：
  - 原生热切换
  - 或 CSS 即时回退 + 重启后原生生效
- [x] 记录分发结论：默认按非 Mac App Store 渠道维护；若未来要支持 MAS，则另开 `opaque` 变体
- [x] 记录最终 DoD：
  - macOS translucent = 原生轻度毛玻璃
  - Web 无额外 blur
  - 主内容区近实色
  - fallback 清晰可验证

---

## 实施备注

- 本方案只服务于 macOS 非 App Store 渠道，不追求 MAS 兼容。
- 硬规则：仅 `platform === macos` 时启用；仅 `windowBackgroundPreference === "translucent"` 时启用；仅在系统未开启 `Reduce Transparency` 时启用，否则回退更实外观。
- 禁止项：不新增 `backdrop-blur-*` / `backdrop-filter`；不把主内容区改成玻璃；不改成 `Overlay` 标题栏或自绘交通灯。
- 最终取舍：选择 `WindowBackground`，因为它对整窗壳层最中性，既不会像 `Sidebar` 那样把导航层做得过重，也不会像 `ContentBackground` 那样把正文阅读层一起拉进材质感；配合 `--shell-panel` / `--shell-panel-strong` 的近实色分层，更符合“壳层轻材质、内容层稳定”的目标。
- `Reduce Transparency` 最终实现：已接入运行时原生守护。`/Users/ba7mlv/Documents/ui/study-ui/src/lib/theme.ts` 暴露 `REDUCED_TRANSPARENCY_MEDIA_QUERY` 与快照 helper，`/Users/ba7mlv/Documents/ui/study-ui/src/components/theme/theme-provider.tsx` 通过 `matchMedia("(prefers-reduced-transparency: reduce)")` 热监听；命中 `reduce` 时会让 `/Users/ba7mlv/Documents/ui/study-ui/src/lib/native-window.ts` 清掉 macOS native effect 并回到更实外观，同时保留 `/Users/ba7mlv/Documents/ui/study-ui/src/styles/app.css` 的 CSS token 回退。
- 分发结论：当前实现明确按非 Mac App Store 渠道维护；原因是透明窗口 + `macOSPrivateApi` 仍然是前提。若未来要支持 MAS，应单独提供 `opaque` 变体并重新评估能力边界。
- Web 约束：已完全避免额外 Web `backdrop-blur-*` / `backdrop-filter`，没有例外位置。
- 验证记录（2026-03-17）：`npm run lint` 通过；计划内 Node/Rust 合约测试全绿；`npm run build` 与 `npm run tauri:build` 通过；生成 `.app` 路径为 `/Users/ba7mlv/Documents/ui/study-ui/src-tauri/target/release/bundle/macos/Deep Student.app`；开发态与打包态进程均可启动，但本 CLI 会话未直接完成 GUI 像素级目视验收。
- DoD 记录：当前代码与自动化合约已满足 `WindowBackground + followsWindowActiveState + 明确 fallback + Web 无 blur + 主内容区近实色`；剩余待补的是图形桌面会话中的最终目视验收。

## 参考链接（仅引用，不要整段抄录）

- [Tauri window config](https://v2.tauri.app/reference/config/#windowconfig)
- [Tauri window customization guide](https://v2.tauri.app/learn/window-customization/)
- [Tauri JavaScript window API](https://v2.tauri.app/reference/javascript/api/namespacewindow/)
- [window-vibrancy](https://github.com/tauri-apps/window-vibrancy)
- [NSVisualEffectView.Material](https://developer.apple.com/documentation/appkit/nsvisualeffectview/material)
- [NSVisualEffectView.State](https://developer.apple.com/documentation/appkit/nsvisualeffectview/state)
- [MDN prefers-reduced-transparency](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-transparency)
