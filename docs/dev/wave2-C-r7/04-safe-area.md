# 0824 Wave2-C 第 7 轮 · 测试员-safe-area 报告

- 工作目录：`/tmp/0824-wave2-c-r7-safe-area`（分支 `cursor/0824-wave2-mobile-uiux-a875`，HEAD `0f5435a7`）
- 交付物：新增 `tests/vitest/mobile-uiux/safeAreaInvariant.source.test.ts`（纯加法，源码级契约测试）
- 约束遵守：**未执行任何测试**（任务禁止）；**未改任何产品代码**（`git status` 仅一条 `??` 新测试文件）；**未 commit**。

## 1. 测试锁定内容（四组，全部有实文件锚点）

### 1.1 G 44px token
- `src/styles/shadcn-variables.css` L41-42：`--control-height-touch: 44px` + `--touch-target-size: var(--control-height-touch)`（G 分支落地的 44px 触控 token 及其别名）。
- `src/styles/responsive-utilities.css` L18/L30-33：`@media (pointer: coarse)` 下 `.touch-target { min-height/min-width: 44px !important }`。断言先切出 coarse 块再切 `.touch-target` 规则，避免误匹配 L134 抽屉行的同名声明。
- L159 `.touch-row` 锚定 `var(--control-height-touch, 44px)`，防 token 与工具类脱钩。

### 1.2 env(safe-area-inset) 映射链
- `src/styles/ios-safe-area.css` L27-30：`:root` 四向 `--mobile-safe-area-* → var(--android-safe-area-*, env(safe-area-inset-*, 0px))` 全局兜底（壳外恢复页也消费）；L21-24 原始 `--safe-area-inset-*` env 别名，逐向 `it.each` 锁全链。
- `src/styles/responsive-utilities.css` L44/L48：`.safe-area-top/.safe-area-bottom` 工具类消费同一条 android→env→0px 兜底链。
- `src/utils/platform.ts` L135-138：Android 侧 `setProperty('--android-safe-area-{top,bottom,left,right}')` 注入真实值（edge-to-edge 下 env() 不可靠的补偿），四向逐一断言。

### 1.3 mobileShell 变量
- `src/app/shell/mobileShell.ts` L4-8：四向 `var(--android-safe-area-*, env(safe-area-inset-*, 0px))` 常量（shell 侧唯一真源）。
- L13-18：`MOBILE_SHELL` 六个变量名逐个锁：`--mobile-safe-area-top/bottom/left/right`、`--mobile-header-height`、`--mobile-header-total-height`。
- L37-45：`getMobileShellCssVars()` 存在，且 `--mobile-header-total-height` 由 `calc(${MOBILE_SHELL.headerHeight}px + ${getMobileSafeAreaTopValue()})` 合成（锁精确模板串，token 改组合方式必翻红）。
- `src/App.tsx` L132/L923：从 `./app/shell/mobileShell` 导入并 `...getMobileShellCssVars()` 展开到壳树——锁「定义了且真的在消费」。

### 1.4 不变量 18 相关路径存在（对齐 `docs/dev/wave2-C-r1/08-keyboard-back.md` §4 静态自证）
- `legal/THIRD_PARTY_NOTICES.txt` 存在（NOTICES 条）。
- Composer 拆分七件全锁（`it.each` 存在性）：`ComposerInlinePanel.tsx`、`ComposerPanelOverlay.tsx`、`ComposerPlusMenu.tsx`、`ComposerTextarea.tsx`、`ComposerToolbar.tsx`、`ComposerPanel/ComposerPanel.tsx`、`composerDraftStorage.ts`（均在 `src/features/chat/components/input-bar/`）。
- Android back：`src/app/navigation/androidBackCoordinator.ts` 存在 + `App.tsx` L91 导入、L1567 `installAndroidBackBridge()` 调用。
- safe-area 五个样式/底座锚点文件存在性兜底：`ios-safe-area.css`、`responsive-utilities.css`、`shadcn-variables.css`、`mobileShell.ts`、`platform.ts`。

## 2. 设计取舍
- 只做字符串包含 + 文件存在性断言，不数数量、不锁行号——与本仓既有契约测试风格一致（参照 `tests/vitest/mobileShellContract.test.ts`、`touchTargetOwnership.contract.test.ts` 的「假保护」告诫）：无关重构不误报，真回归（token 改值、env 兜底被删、拆分文件被合并回去、back 桥卸载）必然翻红。
- 与既有 `mobileShellContract.test.ts` 互补不重复：该测试只锁 top/bottom/total-height 三个变量名与消费方；本测试补上 left/right 横向安全区、env() 兜底链精确串、44px token、`:root` 全局映射与不变量 18 路径。
- coarse 块内 `.touch-target` 断言用两级 `slice` 定位，规避文件内另外两处 `min-height: 44px !important` 的假绿风险。

## 3. 可运行性说明（未运行，静态核对）
- `vitest.config.ts` L13 include `tests/vitest/**/*.{test,spec}.{ts,tsx}` 覆盖新文件，命令应为 `npx vitest run tests/vitest/mobile-uiux/safeAreaInvariant.source.test.ts`。
- 所有断言串均从当前源码逐字复核（见上文 file:line），基线预期全绿；本轮禁止执行测试，绿灯留给下一轮/CI 确认。

## 4. 遗留与建议
- `--safe-area-inset-*-fallback`（platform.ts L142-143）未纳入锁：属 Android 注入的次级别名，消费面待查证，避免过锁。
- 建议后续轮把 `UnifiedMobileHeader.tsx` 对 `--mobile-header-total-height` 的消费也并入本文件（现由 `mobileShellContract.test.ts` 覆盖，暂不重复）。
