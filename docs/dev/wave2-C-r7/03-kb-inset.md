# 0824 Wave2-C R7 测试员报告 · 03 键盘 inset 源码契约

- 工作目录：`/tmp/0824-wave2-c-r7-kb-inset`
- 新增文件：`src/hooks/__tests__/useKeyboardHeight.contract.source.test.ts`（新建，此前 `src/hooks/__tests__/` 无键盘相关测试）
- 被锁对象：`src/hooks/useKeyboardHeight.ts`（未改动）＋ `src/styles/transitions-dev.css`（未改动，只读断言）
- 约束遵守：未执行测试；未改任何产品代码；未 commit。

## 测试形态

沿用仓内既有 `.source.test.ts` 惯例（参照
`ComposerInlinePanel.inertClamp.source.test.ts`）：`readFileSync` 读源码文本，
`toContain` / `toMatch` 锁关键字符串。不执行 hook——该模块是 visualViewport
模块级单例（`trackingStarted` / `baselineHeight` 等模块态 + document root 副作用），
行为测试需另做隔离，本轮只锁契约面。

## 契约覆盖（4 组 describe，24 条断言）

### 1. 键盘判定阈值（3 条）

| 锁点 | 断言 |
| --- | --- |
| 阈值常量 | `const KEYBOARD_THRESHOLD = 150;` 精确锁 150px |
| 比较语义 | `diff > KEYBOARD_THRESHOLD ? Math.round(diff) : 0`——严格大于（diff === 150 不算键盘）＋ Math.round |
| 基线来源 | `diff = baselineHeight - vv.height`，且全文件禁止出现 `window.innerHeight` |

### 2. Android adjustResize vs iOS overlay 分支（7 条）

核心是锁「单公式覆盖双平台」的设计，不许退化成 `if (isAndroid)` 式硬分叉：

- **inset 门控**：`nextHeight > 0 ? computeLayoutViewportObscuredHeight(vv) : 0`——键盘未判定弹出时 inset 归零，iOS 地址栏收缩噪声不得泄漏为输入栏抬升量。
- **inset 公式**：`Math.max(0, Math.round(layoutHeight - vv.height - vv.offsetTop))`，layoutHeight 取 `document.documentElement.clientHeight`。Android adjustResize 下 clientHeight 已收缩 → ≈0；iOS overlay 下不变 → ≈键盘高度。`offsetTop` 项是 iOS visualViewport 被顶下时的修正。
- **文档锁**：`useKeyboardInset` 的 JSDoc 两行平台语义（「Android adjustResize：…返回 0（避免双重抬升）」「iOS overlay 键盘：…（≈ 键盘高度）」）逐字锁定——这是调用方唯一的平台语义来源。
- **平台门**：`if (!vv || (!isAndroid() && !isIOSLike())) return;`（桌面不启用）＋ `isAndroid` 从 `@/utils/platform` 导入。
- **iPadOS 检测**：`MacIntel` + `maxTouchPoints > 1`（桌面 UA 的 iPad）。
- **双事件监听**：`resize` ＋ `scroll`（iOS 键盘可能只触发 scroll/offsetTop 变化）。
- **导航守卫 Android-only**：`shouldBlockMobileNavigation` 首行 `if (!isAndroid()) return false;`（#113 误导航拦截不波及 iOS）。
- **宽度重置分支**：宽度变化（旋转/分屏）→ height/inset 双归零 ＋ `writeInsetCssVar()` ＋ 提前 return，不判为键盘。

### 3. CSS 变量写入协议（5 条）

| 锁点 | 断言 |
| --- | --- |
| 变量名 | `export const KEYBOARD_INSET_CSS_VAR = '--keyboard-inset';` |
| 写入形态 | `document.documentElement.style.setProperty(KEYBOARD_INSET_CSS_VAR, \`${keyboardInset}px\`)`——写 root、带 px 单位 |
| SSR 守卫 | `writeInsetCssVar` 首行 `typeof document === 'undefined'` guard |
| 初始写入 | `ensureTracking` 里 `writeInsetCssVar()` 在移动端平台门**之前**——桌面也保证 var() 有定义 |
| 变更同步 | `nextInset !== keyboardInset` 分支内先赋值后 `writeInsetCssVar()` |

### 4. transitions-dev.css 只消费不声明（2 条）

- CSS 注释里保留指回 `src/hooks/useKeyboardHeight.ts` 的契约说明；
- 全文件禁止 `--keyboard-inset:` 静态声明（静态声明会遮蔽运行时实时值；消费方须 `var(--keyboard-inset, 0px)`）。

## 验证方式（未跑测试）

按「禁止执行测试」要求，改用静态核对：15 条 `toContain` 字面量逐条
`rg -F` 命中源文件；9 条 `toMatch` 正则与「不含」断言用 node 单行脚本对
源码/CSS 文本逐条求值，24/24 全部命中。测试文件本身仅依赖
`node:fs` / `node:path` / `vitest`，与既有同型测试的依赖面一致。

## 观察（不改产品代码，仅记录）

- `getLayoutViewportObscuredHeight()`（供 Dialog 补偿用的独立导出）公式为
  `layoutHeight - vv.height`，**不含** `vv.offsetTop` 项，与
  `computeLayoutViewportObscuredHeight` 不一致。iOS 键盘顶起 visualViewport
  （offsetTop > 0）时两者会给出不同值。可能是有意区分（Dialog vs docked
  输入栏），但缺注释说明；本轮未将其锁入契约，留待产品侧确认后再锁。
