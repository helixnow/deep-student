# 0824 Wave2-C R9 · 真机留白清单

- 时点：2026-08-26（UTC），分支 `cursor/0824-wave2-mobile-uiux-a875`，HEAD `7e3302a1`
- 性质：**本文只登记「静态/jsdom 证据止步于哪里、真机还欠哪一步」**。本轮未跑真机、未跑浏览器、未跑 computerUse，下列 6 项全部处于**未验证**状态。文中「已有证据」一律指静态读码、source 契约或 jsdom vitest（R8 实测记录），**没有任何一条等价于真机通过**。
- 口径提醒：source 契约测试锁的是源码文本形态，jsdom 测试锁的是合成事件下的 React 行为；两者都不覆盖真实渲染引擎的命中测试、visualViewport 行为、原生桥、读屏引擎。真机步骤执行前，本清单每一项的真机置信度都是 0。

---

## 1. 键盘 inset：Android adjustResize vs iOS overlay（useKeyboardHeight 双端）

**静态已有证据**

- 单例实现 `src/hooks/useKeyboardHeight.ts`：双端走同一 visualViewport 公式——`keyboardInset = max(0, layoutHeight - vv.height - vv.offsetTop)`（:110-113），设计意图是 Android adjustResize 下布局视口已收缩 → inset≈0（不双重抬升），iOS overlay 下布局视口不变 → inset≈键盘高度；阈值 150（:33）、宽度变化重置基线（:76-86）、`resize`+`scroll` 双监听（:128-130）、平台门 `!isAndroid() && !isIOSLike()`（:124）、`--keyboard-inset` CSS 变量写入（:48-51）。
- 消费方：InputBarUI 键盘抬升门控 `isMobile && composerEditableFocused`（`InputBarUI.tsx:1128-1129`）；ComposerInlinePanel 面板高度 `calc(85vh - var(--keyboard-inset,0px) - 180px)` 二段 clamp（`ComposerInlinePanel.tsx:70-75`）。
- 测试：`src/hooks/__tests__/useKeyboardHeight.contract.source.test.ts` 18 条**源码文本契约**（锁阈值/公式/平台门/JSDoc 语义，R8 实测绿，见 `wave2-C-r8-vitest-mobile.md` #2）。**这是文本锁，不是行为测试**——jsdom 没有会因键盘缩小的 visualViewport，hook 的运行时行为从未被执行验证。

**缺的真机步骤**

1. Android 真机（adjustResize）：聚焦 Composer → 目测输入栏**不双重抬升**（容器已避让 + inset 应≈0）；读 `document.documentElement.style` 确认 `--keyboard-inset` 实际值。
2. iOS 真机（overlay 键盘）：聚焦 → docked 输入栏浮在键盘上方，`--keyboard-inset` ≈ 键盘高度；面板打开态键盘弹出，面板不被顶出屏幕（二段 clamp 极端场景：短横屏 + 键盘）。
3. 键盘开着旋转屏幕 / 进分屏：基线重置生效，状态不卡在「键盘弹出」。
4. 外接键盘 / 悬浮键盘（高度差 < 150 阈值）：确认不误判也不漏判。
5. iPad 桌面 UA（MacIntel + maxTouchPoints）检测分支真机验证。
6. 冷启动先聚焦输入框再挂 App 壳的基线时序（`ensureKeyboardTracking` 注释描述的场景）真机复现。

---

## 2. 厂商 WebView（小米/华为/Samsung 手势条、visualViewport）

**静态已有证据**

- **仓内零厂商特判**：rg `miui|harmony|samsung|xiaomi|huawei` 在 `src/` 的命中全部是模型供应商名（provider 图标/能力表），没有任何针对厂商 WebView 的分支——即当前实现 100% 依赖标准行为：`visualViewport`（17 个消费文件）+ `env(safe-area-inset-bottom)`（`src/styles/ios-safe-area.css`、`responsive-utilities.css` 等，`tests/vitest/mobile-uiux/safeAreaInvariant.source.test.ts` 锁不变量）。
- AppMenu 定位边界已改用 visualViewport 尺寸并监听其变化（`AppMenu.tsx:389-391/:448-450`，共享 `src/components/ui/visualViewport.ts`）。
- Android 10+ 手势热区抢占（屏幕边缘返回手势 vs 应用内边缘交互）在台账壳⑤登记为**已知局限**，无代码缓解。
- Android 侧宿主是 Tauri WebView（`src-tauri/mobile/android/MainActivity.kt`），即**系统 WebView，厂商定制版**——这正是风险面。

**缺的真机步骤**

1. 小米（MIUI/HyperOS WebView）、华为、Samsung 各至少一台：手势导航开启时，docked 输入栏 / 底部面板是否被手势条遮挡（Android WebView 的 `env(safe-area-inset-bottom)` 常年返回 0，仓内无兜底，需实测确认）。
2. 各厂商键盘（搜狗/百度/三星键盘）弹出时 visualViewport 的 resize/scroll 事件时序是否与 Pixel 原生一致——第 1 项的全部键盘步骤在厂商机上重跑一遍。
3. 键盘弹出时打开 AppMenu：菜单是否随 visualViewport 重定位、不被键盘盖住（`AppMenu.tsx` 软键盘感知定位从未在任何真实 WebView 跑过）。
4. 厂商侧边返回手势与应用内边缘手势（抽屉滑出等）的冲突实测；三键导航 vs 手势导航两种模式都过一遍。
5. 深色模式 + 厂商强制夜间模式（MIUI 会改写 WebView 配色）下浮层可读性抽查（顺手项，非本清单主责）。

---

## 3. VoiceOver / TalkBack（inert、水位环语义、Skills region）

**静态已有证据**

- ComposerInlinePanel 收起态（closing/closed）：内容容器经 DOM property 设 `inert` + `aria-hidden`（`ComposerInlinePanel.tsx:61-65/:93-96`），注释明确 grid 0fr 只裁视觉不裁焦点/读屏树。
- 水位环不再 `role="img"`：改为真实 `<button>` 触发器，`aria-label` + AppMenuTrigger 合并 `aria-haspopup/aria-expanded`（`ContextUsagePopover.tsx:87-96`）；内环 span 不再带 tabIndex 与命中伪元素（`ComposerToolbar.tsx:206-209`）。
- Skills/MCP region 标签走 t()：`inlineAriaLabel = t('skills:title')` / `t('analysis:input_bar.mcp.title')` 等五面板全部词条化（`InputBarUI.tsx:2179-2211`），传入 `role="region"` 容器（`ComposerInlinePanel.tsx:100-101/:112-113`）。
- 测试：`tests/vitest/mobile-uiux/inlinePanelScreenReader.sequence.source.test.ts`（R8 实测随 mobile-uiux 族 140 绿）——**source 契约，锁 DOM 序与属性存在性，不模拟读屏**。

**缺的真机步骤**

1. TalkBack（Android）：面板开启态线性滑动遍历顺序应为 面板内容 → 输入框 → 工具栏；面板收起后其内容**完全不可达**（inert 生效）；注意 `inert` 需 Chromium 102+，老 WebView 上是否静默降级需实测。
2. VoiceOver（iOS）：同上遍历；转子（rotor）landmark 列表中五个面板 region 是否以当前 locale 的 t() 文案播报（中英各验一次）。
3. 水位环：读屏聚焦时播报为「按钮 + 弹出菜单」而非图片；双击激活能打开弹层；弹层关闭后焦点回落位置合理。
4. 面板 200ms 收起动画期间（closing 态）读屏焦点若在面板内，是否被正确逐出而非落进 inert 子树后失焦静默。
5. 附件「更多」菜单（第 5 项同款路径）在读屏开启下逐项播报与激活。

---

## 4. 44px 实际命中（实体盒 vs 伪元素逃生舱、相邻控件）

**静态已有证据**

- 主策略实体盒：coarse 下 `min-h/min-w-[var(--touch-target-size)]`（`ComposerToolbar.tsx:51-59` 常量、`buttonPrimitiveContract` coarse 下沉、`TouchTarget` 组件）；输入栏右簇已放弃 `after:-inset` 伪元素外扩，注释写明理由是「伪元素会越过 gap 与相邻控件命中区互相重叠」（:51-53）。
- 逃生舱收敛：`src/components/ui/coarseHit.ts` 五档共享出口，文件头登记已知风险「相邻扩区互相覆盖，后渲染者盖前者，需 z-index 显式仲裁（先例 TabBar z-[1]）」（:10-12）。
- 门禁：lint 规则 `ds-components/coarse-touch-target` 在 `input-bar/**` 已升 error 且 R8 实测 **0 error**（`wave2-C-r8-redlight.md`）；全库其余目录仍 warn。
- 测试：`ComposerToolbar.hitTarget.r7.source.test.ts`（字面量扫描口径）绿；`touchTargetOwnership.contract.test.ts` 改 token 所有权断言后绿（R8 记录）。**全部是类名文本断言——类名在 ≠ 命中区真的在。**

**缺的真机步骤**

1. 命中区实测工具化：Android 开发者选项「指针位置」或 Chrome remote debugging + `document.elementFromPoint` 探针，对输入栏右簇（水位环/推理/语音/发送）每个控件的 44px 盒**四条边界**逐点点按，确认边界点不被相邻控件抢走。
2. 伪元素逃生舱实测（`coarseHitClassFor36` 等消费点，如 FinderQuickLook 关闭钮、TabBar）：伪元素命中依赖父层 overflow / stacking context——真机确认扩区未被 `overflow-hidden` 祖先裁掉、z-index 仲裁在相邻密排处真实生效。
3. `--touch-target-size` 变量在真机 coarse 媒体查询下的实际解析值（桌面 DevTools 模拟 coarse ≠ 真机）。
4. Accessibility Scanner（Android）/ Xcode Accessibility Inspector 跑一遍触控目标尺寸审计，作为第三方口径交叉验证。
5. 手指实测「胖手指」场景：连续快速点击相邻两控件不误触；键盘弹出后布局压缩态重测一遍。

---

## 5. AppMenu portal 外点 + 附件更多菜单 click 是否真达（P1）

**静态已有证据**

- 判定谓词 `isWithinComposerTerritory` 四条件：三 ref contains + `isOwnedOverlayTarget(ownerId)` + `closest('[data-app-menu-id]')` fail-open 兜底（`InputBarUI.tsx:1089-1098`）；面板打开期间 `registerOwnedOverlay` 登记（:1073-1080）；外点关闭（:1436）与焦点门控（:1111）共用同一谓词。
- 附件「更多」菜单本体：`AttachmentPanelBody.tsx:122-163`，AppMenu portal 到 body，含 资源库/拍照/清除全部 三项，动作在 click 阶段执行。
- jsdom 功能测试：`InputBarUI.appMenuOutsideClick.pointer.test.tsx` 中「合成 pointerdown 落在 `[data-app-menu-id]` body portal 上 → 不触发 closeAllPanels」**绿**；同文件一条字面量锚点契约红（#6，谓词收敛成常量后锚点漂移，R8 记录判定为测试未随机制更新，非产品回归）。另有 `overlayPointerSequence.matrix.source.test.ts` 锁事件序矩阵。

**缺的真机步骤**

1. **核心留白：jsdom 的合成 pointerdown ≠ 真机 tap 的完整事件链**（touchstart→touchend→pointer 系→兼容 mouse 系→click，中间还有 touch slop / 滚动取消 / 焦点转移引发的重渲染窗口）。真机步骤：打开附件面板 → ⋯更多 → 逐项点按，**验证动作真的执行**——资源库选择器真的弹出、相机真的打开、附件真的清空——而不是只看到菜单收起（P1 原始症状就是「点了等于关面板、动作丢失」）。
2. 键盘弹出态重复第 1 步（visualViewport 变化会触发菜单重定位，pointerdown→click 之间菜单若移动，click 落点可能脱靶）。
3. 外点关闭反向验证：点菜单**外**的空白处，面板/菜单按预期关闭——fail-open 的 `closest('[data-app-menu-id]')` 不会因残留节点过度保护导致「关不掉」。
4. 快速连点 / 双指误触下动作不重复执行、面板不闪烁。
5. Popover 内嵌 AppMenu 的同构点（`shad/Popover.tsx` 路径，台账 P1 扩散面）抽一处真机复验。

---

## 6. Android back：菜单 → 面板 → 页 顺序

**静态已有证据**

- 协调器语义：同 overlay 档（100）按注册 seq 降序栈语义，Radix 兜底探测插在 view/navigation 之前（`androidBackCoordinator.ts:30-48/:162-178`）；BACK_PRIORITY 注释显式登记「面板开→再开菜单→back 先关菜单→再 back 关面板，由注册时序天然保证」。
- 注册点：AppMenu 打开时注册（含触发器离屏让行守卫，`AppMenu.tsx:136-147`）；InputBarUI 面板打开时注册（含 `hasOpenRadixOverlayBesides` 让行，`InputBarUI.tsx:1462-1470`）。
- jsdom 测试：`src/app/navigation/__tests__/` 三文件（menuThenPanel / fullScenes / order.source）R8 实测 **29 条全绿**；`InputBarUI.androidBack.sequence.test.tsx` 层级顺序断言绿、2 条红是 DOM 探针没算 220ms deferred unmount 退场动画（R8 记录判定为探针缺陷，非产品回归）。

**缺的真机步骤**

1. **原生桥从未被执行验证**：`MainActivity.OnBackPressedCallback → evaluateJavascript('window.__DEEP_STUDENT_HANDLE_BACK__()')`（`src-tauri/mobile/android/MainActivity.kt:54` → `androidBackCoordinator.ts:206`）——jsdom 测的是 `handleAndroidBack()` 纯函数，Kotlin 侧、evaluateJavascript 返回值解析、`moveTaskToBack` 全在测试外。真机步骤：抽屉→面板→菜单叠开后连按返回键，肉眼确认顺序 菜单→面板→抽屉→页→应用退后台（不杀进程）。
2. 手势返回 vs 三键返回各走一遍（OnBackPressedCallback 在两种模式下的分发是否一致；Android 14+ predictive back 动画开启时是否提前吞事件）。
3. 键盘弹出态按返回：IME 先收键盘（系统消费）还是直达 handler——链路顺序真机确认。
4. keep-alive 隐藏 PDF 场景：后台保活实例开着划词面板时，前台页按返回不被吞（`registerVisibilityGuardedBackHandler` 的守卫真机复现，P7 V1 修复的实际验收）。
5. 面板 220ms 退场动画期间快速连按返回：不重复消费、不跳层。

---

## 附：PR「未验证」栏可直接粘贴段

```markdown
### 未验证（真机留白，详见 docs/dev/wave2-C-r9-device-blank.md）

以下 6 项仅有静态读码 / source 契约 / jsdom vitest 证据，**均未经任何真机、真实浏览器或读屏验证**：

1. 键盘 inset：useKeyboardHeight 双端公式（Android adjustResize inset≈0 / iOS overlay inset≈键盘高）只有 18 条源码文本契约，运行时行为零验证；旋转/分屏/外接键盘/冷启动基线时序未测。
2. 厂商 WebView：仓内零厂商特判，全部依赖标准 visualViewport 与 env(safe-area-inset-bottom)；小米/华为/Samsung 手势条遮挡、厂商键盘事件时序、键盘态 AppMenu 重定位未在任何真实 WebView 跑过（Android WebView 的 safe-area-inset-bottom 常返回 0，无兜底）。
3. VoiceOver/TalkBack：ComposerInlinePanel 收起态 inert+aria-hidden、水位环 role=img→button、Skills/MCP region t() 标签均为 DOM 属性/文本断言；读屏遍历顺序、inert 在老 WebView 的降级、locale 播报零实测。
4. 44px 命中：实体盒 token 与 coarseHit 逃生舱只有类名文本断言 + lint 0 error；真机边界点按、伪元素扩区是否被 overflow/stacking 裁掉、相邻控件抢点未测。
5. AppMenu portal 外点豁免 + 附件「更多」菜单动作送达（P1）：jsdom 合成 pointerdown 用例绿，但真机 tap 完整事件链（touch→pointer→click 及其间重渲染窗口）下「动作真的执行而非只关菜单」未复现验证。
6. Android back 顺序（菜单→面板→页）：coordinator 纯函数 29 条 jsdom 全绿，但 MainActivity→evaluateJavascript 原生桥、moveTaskToBack、手势/三键/predictive back、键盘态与 keep-alive PDF 吞 back 场景零真机验证。
```

---

- 本轮改动仅新增本文档；未跑真机/浏览器/computerUse，未改产品代码与测试，未 commit（按任务约束留给父代理统一处理）。
- 不标 Goal complete：上列 6 项在真机步骤执行完之前，任何一项都不能视为闭环。
