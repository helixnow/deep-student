# 代理 8（round 2）—— 移动端 UI/UX 体验（全局横切）

> 先读 `docs/6.13/README.md`，再通读 `docs/6.12/status/agent-8-status.md`（G1–G7、F1–F14、10 批优化）。

## 已完成（第一轮，勿重做）
断点邻界归一（768→767.98 等 22 文件）、useIsMobile/useIsTablet 精确取反、SA-1 Android 真实安全区注入、KaTeX 长公式横滚、手势豁免选择器修复、SA-2 安全区口径统一、命令面板触屏适配、**全库 hover-only 触屏可达性审计 + 16 组件修复**。

## 本轮任务（按优先级）

### P1 — 真机验证（第一轮 SA-1 的悬挂项）
- [ ] **SA-1 真机验证**：`MainActivity.kt` 的 WindowInsets 注入（systemBars + displayCutout）在真机三形态——旋转 / 手势导航 / 三键导航——下验证安全区正确。`MainActivity.kt` 是受控副本，`tauri android init` 后需同步到 `gen/android` 工程。**本机无 Android 构建环境则无法验证，需在有环境时跑 `npm run tauri android dev`**。
- [ ] **#11** 横屏手机（高 <768、宽 ≥768）按桌面双栏渲染，触控目标偏小。真机体验后裁决是否加横屏手机专门布局。

### P2 — 收口 / 包体
- [ ] **#5** `tailwind.config.js` 的 `screens.xs=480px` 未收录进 `config/breakpoints.ts`（注释称两者一致，实则不一致）。收录或在注释中说明差异（与本组断点单一来源原则对齐）。
- [ ] **#10** 全库 framer-motion 直接 `import { motion }` 未用 `LazyMotion`/`domAnimation` 按需加载。重页面已整体懒加载，增量收益有限；评估是否值得（协商级）。
- [ ] **#13** `FolderTreeItem.tsx` 三点菜单：hover-only 但有长按 contextmenu 兜底，行高 h-7(28px) 触屏偏密。评估整行触屏加高（结构性）。
- [ ] **#14** `MessageItem.tsx` 历史消息 footer 操作 `md:opacity-0 md:group-hover`：<768 常显 ✓，但 ≥768 触屏平板 hover-only。平板适配专项。

## 验证
`npm run typecheck`；`npx stylelint "src/**/*.css"`（注意收尾会话已修 `lint:css` 脚本 glob，可直接 `npm run lint:css`）；移动视口浏览器冒烟（390×844）；SA-1 须真机。

## 备注
本组改动权限分级：移动端基础设施 + 纯样式响应式可直接改；特性组件结构性适配登记跨组；业务逻辑/后端/`components/ui` 只报告。第一轮覆盖充分，本轮以**真机验证 + 收口**为主。
