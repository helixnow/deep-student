# Wave2-C R10 · PR #347 中文描述定稿

## Summary

本 PR 是 0824 Wave2 会话 C（mobile-uiux-unify）的独立收敛枝：以 `origin/cursor/0824-cde6 @ 061b4815` 为基线，在 `cursor/0824-wave2-mobile-uiux-a875` 上围绕移动端五条规范完成静态扫描、机制修复与定向验证。本稿取证 HEAD 为 `fe8ff43c`。

本枝处理 Composer 浮层所有权、附件生命周期、44px 触控机制、面板可访问性、动态 i18n、PDF 可见性 back 守卫、键盘 inset，以及 Learning Hub / Settings / AppMenu 的移动 chrome 残项。input-bar 的 `coarse-touch-target` 已单目录升为 `error`；全库其他目录仍为 `warn`，不将单目录收敛写成全库完成。

## Changes

| 项 | 主要变更与边界 |
|---|---|
| P1 · AppMenu portal 外点 | InputBar 的焦点与外点判断共用 Composer territory；接入 owned-overlay 登记/查询，并保留 `[data-app-menu-id]` fail-open。AppMenu 跟随 live visual viewport 定位与限高，coarse 指针下子菜单改为 click。全库其他 document 外点监听未整体迁移。 |
| P2 · 附件生命周期 | PDF 取消、processing store 清理与 blob revoke 收敛到 store action；面板和 chip 只委托删除；`pdfProcessingStore.remove` 已提升到 `sourceId` 顶层，覆盖孤儿附件路径。 |
| P3 · 44px 触控 | 新增 `TouchTarget`、共享 `coarseHit`，并把 coarse 最小高宽下沉到 button primitive；input-bar 清理旧 `!min-h-11` / `!h-11` / 内联 `after:-inset` 散点。FolderPicker 树行和 Learning Hub 图标动作复用机制出口。全局 lint 尚未升为 `error`。 |
| P4 · 能力判定 | 布局继续走 `isMobile`，触摸能力走 `any-pointer: coarse`，拍照入口走平台 `canCapturePhoto`；未用 `enumerateDevices` 触发权限探测。 |
| P5 · 面板 a11y | ComposerInlinePanel closing/closed 内容使用 inert DOM property + `aria-hidden`；160px 硬下限改为可收缩二段 clamp；水位环统一为按钮语义；Skills/MCP region 名称改走 `t()`。 |
| P6 · i18n | 契约扩展到模板键枚举、非空字符串叶子与枚举漂移守卫；`check-i18n` 接入非零退出和 strict 命令；补齐既有缺键，并删除 chatV2 `inputBar.*` 下 31 个双语零引用叶子，保留 `actions.more` alias。 |
| P7 · PDF / EPUB back | `PdfSelectionActions` 与 `EnhancedPdfViewer` 共用 `registerVisibilityGuardedBackHandler`，避免 keep-alive 隐藏实例吞 Android back。V2 coarse 存量、V3 断点样板、V4 132 魔数仍不在本 PR 完成口径内。 |
| P8 · 键盘 / back | InputBar overlay handler 对裸 Radix 浮层让行；Settings 重复键盘 hook 收敛到全局 `useKeyboardHeight`；补 coordinator、键盘 inset、safe-area、读屏与交互顺序契约，未重写 back 排序与兜底底座。 |

R9 另完成：修复 Learning Hub「保存为笔记」子屏 hosted screen 不匹配导致的返回行丢失；将 Settings 数据治理剩余三张窄屏宽表改为 `<md` 卡片列表；移动顶栏、AppMenu、Composer 与 Settings / Learning Hub chrome 字号接入 token；更新 7 条过期 input-bar 测试探针；让 coarse allowlist 在非 `file:` URL 下可加载。

## 验证口径

| 已验证 | 未验证 |
|---|---|
| 1. `npm run version:generate && npm run typecheck`：退出码 0。<br>2. `CI=true npx vite build`：退出码 0。<br>3. `node scripts/check-migrations.mjs`：退出码 0，111 个迁移文件通过。<br>4. input-bar ESLint：退出码 0；`ds-components/coarse-touch-target` 为 **0 error / 0 warning**。同次检查仍有其他规则 warning。<br>5. R9 定向 Vitest：5 files passed，**35/35 tests passed**；R8 登记的 7 条过期探针已更新。<br>6. `coarseTouchTargetRule.test.ts`：R10 配好 ESLint 9 flat-config 后席位回报 **34/34**。 | **真机六项均未验证：**<br>1. Android adjustResize / iOS overlay 下的键盘 inset、旋转/分屏、外接或悬浮键盘与冷启动基线时序。<br>2. 小米 / 华为 / Samsung 厂商 WebView 的手势条、safe area、厂商键盘事件与 AppMenu visualViewport 重定位。<br>3. VoiceOver / TalkBack 的 inert 退场、region 本地化播报、水位环按钮语义与焦点顺序。<br>4. 44px 实际命中边界、相邻控件抢点，以及 `coarseHit` 扩区被 overflow / stacking 裁切的情况。<br>5. AppMenu portal 外点豁免和附件「更多」在真机 tap 完整事件链下的动作送达。<br>6. Android back 的菜单→面板→页顺序，以及 MainActivity 原生桥、手势/三键/predictive back、IME 与 keep-alive PDF 场景。<br><br>**工具链未验证：**<br>7. Cargo：环境为 `rustc 1.83.0`，`cargo check --manifest-path src-tauri/Cargo.toml --lib` 未得到有效通过结果。<br>8. 整仓 Vitest、完整 ESLint、Playwright 与 CI 未执行。 |

上述通过项仅代表列出的命令与定向范围，不能外推到未执行的整仓、原生工具链或真机验证。

## 风险与后续边界

- owned-overlay 双轨期仍保留过宽的 `[data-app-menu-id]` fail-open；在 AppMenu 全消费点登记和全库外点监听迁移前，不移除该兜底。
- `coarse-touch-target` 仅在 input-bar 为 `error`；其他目录仍为 `warn`，存量与回流风险继续按目录分批收敛。
- issue #122「聊天出现乱码」仍为 OPEN，本枝未触及流式解码或消息渲染纠错，不记作已修。
- Rust `coordinator.rs`、tool loop、后端 hooks / 缓存协议、anki/qbank 域逻辑、WebDAV / S3 / FTP 后端与 `.github/workflows` 未改。

## 与官方 0824 的关系

- [Draft PR #347](https://github.com/helixnow/deep-student/pull/347) 从官方 0824 基线独立展开，用于 Wave2-C 扫描、机制修复、定向验证与证据归档。
- 本枝保持独立，不 merge、rebase 或整枝回灌官方 0824，也不代表官方 0824 的验收结论。
- sidebar 缺键等 v0.9.44 既有债继续按既有债归因，不改写为 0824 回归。
- 当前状态保留上述未验证项，不标 Goal complete。
