# 0824 Wave2-C 第 10 轮交叉终审:a11y

- 席位:会话 C 第 10 轮交叉终审(a11y 专项)。禁止 computerUse;未 commit;除本文档外零文件改动。
- 取证基线:HEAD `fe8ff43c`(工作树另有并行席位在途改动:`docs/dev/wave2-C-ledger.md`、`tests/vitest/coarseTouchTargetRule.test.ts` 及 4 份 r10 文档,均非本席位产出,本审不计入)。
- 方法:静态逐行读码 + locale JSON 程序化核对 + **定向 vitest 实跑**(6 文件 40 用例,全绿,见 §7)。真机读屏(VoiceOver/TalkBack)本轮**未验证**,见 §8。

## 终审结论一览

| # | 审计项 | 裁定 | 一句话证据 |
|---|---|---|---|
| 1 | ComposerInlinePanel inert/aria-hidden | **通过** | effect 维护 `el.inert = !expanded`(DOM property)+ `aria-hidden={!expanded \|\| undefined}`,挂在两种 heightMode 共用的门控容器上 |
| 2 | 二段 clamp | **通过** | `minHeightFloor = max(0px, min(160px, availableSpace))`;无条件 `clamp(160px,` 已绝迹(含注释,R6 假红已修) |
| 3 | Skills/MCP t() | **通过** | 五个 inline case 全部非空翻译赋值;12 个词条 zh/en 双语程序化核对齐全 |
| 4 | 水位环非 role=img | **通过** | input-bar 目录 `role="img"` 零命中;语义单一所有者 = ContextUsagePopover 的真 `<button>` 触发器,内层 span/svg 双 `aria-hidden="true"` 且无 tabIndex |
| 5 | AppMenu visualViewport | **通过** | 主菜单+子菜单双处 `getVisualViewportSize()` 钳位 + `addVisualViewportChangeListener` 订阅/清理配对;`--app-menu-available-height` 活高度钳制落到 CSS |
| 6 | 读屏焦点顺序测试仍锁行为 | **通过(实跑绿)** | 6 文件 40/40 绿;锁定强度与 fail-closed 分析见 §7,残余脆弱点见 §9 |

---

## 1. ComposerInlinePanel inert/aria-hidden —— 通过

`ComposerInlinePanel.tsx`:

- 展开态判定单一来源:`const expanded = motionState === 'open' || motionState === 'opening';`(:56)——closing 一开始就算收起,收起动画期即从读屏树摘除,不等 closed。
- inert 经 DOM property 由 effect 维护(:61-65,`el.inert = !expanded`,依赖 `[expanded]`)。理由成立:React 18 JSX 属性表不识别 inert,`inert={false}` 会序列化成 truthy 的 `inert="false"`;与 InlineReveal 同一模式,inert 对整棵子树生效且不可被子级覆盖。
- `aria-hidden={!expanded || undefined}`(:95)与 inert 同门控、同容器——展开时显式撤属性(undefined)而非 `"false"`。
- 门控容器是 `min-h-0 overflow-hidden` 的共用内容容器(:93-96),`heightMode` 'content'(CustomScrollArea)与 'available'(普通 div)两条渲染分支的 children 都经过它,**region 地标位于门控容器内部**——收起后不残留空壳地标(ghost landmark)。
- 两条分支均为 `role="region"` + `aria-label={ariaLabel ?? panelKey}`(:100-101 / :112-113)。运行时测试证实 CustomScrollArea 正确把 role/aria-label 转发到真实 DOM(见 §7)。

反向核验:`ComposerPanelOverlay.tsx`(桌面)`inert` 与 `160px` 双零命中——移动侧修复未渗入桌面,与「桌面回归面归 B 组」的边界一致。

## 2. 二段 clamp —— 通过

`ComposerInlinePanel.tsx:70-75`:

```70:75:src/features/chat/components/input-bar/ComposerInlinePanel.tsx
  const availableSpace = `calc(85vh - var(--keyboard-inset, 0px) - 180px)`;
  // 二段式下限:可用空间 ≥160px 才保底 160px;不足(短横屏 + 键盘)时下限退化
  // 为可用空间本身并靠内部滚动消化,max(0px, ...) 兜底防止负值。
  // 禁止把 160px 写成无条件的 clamp 下限——那会在极端视口把面板撑出屏幕。
  const minHeightFloor = `max(0px, min(160px, ${availableSpace}))`;
  const heightValue = `clamp(${minHeightFloor}, ${availableSpace}, ${maxHeight}px)`;
```

- 语义正确:可用空间充足时保底 160px;短横屏+键盘等极端场景下限退化为可用空间本身,`max(0px, ...)` 防 calc 负值;内容靠内部滚动消化,不把输入区撑出屏幕。
- `heightValue` 同源喂给两种模式:available 定高(`height`)、content 限高(`maxHeight` 双写在 CustomScrollArea 外壳与 viewport 上)+ 内部滚动——单一高度真相,无分叉。
- 键盘感知走 document root 的 `--keyboard-inset`(useKeyboardInset 单例维护);注释明确记录了双端差异假设(Android adjustResize 布局视口随键盘缩小、inset≈0;iOS overlay 键盘布局视口不变、用 inset 扣除)——该假设**只有注释与静态测试背书,真机未验证**(§8)。
- R6 曾发现 inertClamp 测试假红(注释里含 `clamp(160px,` 字面量触发反向断言),已改写;本轮全文重扫确认 `clamp(160px,` 在产品源码与注释中均零命中,`not.toContain` 反向断言当前干净成立。

## 3. Skills/MCP aria-label t() —— 通过

`InputBarUI.tsx:2179-2226` 的 inline 面板 switch,五个 case 全部非空翻译赋值,经 `ariaLabel={inlineAriaLabel}` 接线进 region:

| case | 词条 | zh-CN | en-US |
|---|---|---|---|
| attachment | `analysis:input_bar.attachments.title` | 附件 | Attachments |
| model | `runtimeModelTitle`(= `chatV2:inputBar.runtimeModelTitle`,:1034) | 模型 | Model |
| mcp | `analysis:input_bar.mcp.title` | MCP工具 | MCP Tools |
| advanced | `common:chat_controls` | 对话控制 | Chat Controls |
| skill | `skills:title` | 技能 | Skills |

另核对水位环触发器 `chatV2:tokenUsage.contextWindow`(上下文窗口 / Context Window)。共 12 个词条(6 键 × 2 locale)经 python3 json 程序化取值,全部存在且非空字符串。R1 台账认定的硬编码 `'MCP'/'Skills'` 已彻底消失,`inlineAriaLabel` 除 switch 前的 `let inlineAriaLabel = '';` 初始化外无字面量赋值。

i18n 契约侧:`inputBarSplitI18nKeys.contract.test.ts` 扫描清单已含 AttachmentPreviewChips / ContextUsagePopover / ComposerInlinePanel / ComposerPanel 四文件(R5 升级),叶子必须非空字符串;实跑 7/7 绿。

## 4. 水位环非 role=img —— 通过

- `src/features/chat/components/input-bar/` 全目录 `role="img"` / `role='img'` **零命中**(rg 全扫)。
- 语义单一所有者:`ContextUsagePopover.tsx:88-101`,`AppMenuTrigger asChild` 把 `aria-haspopup`/`aria-expanded` 与点击、键盘处理合并到真 `<button type="button">` 上,带 `aria-label={t('chatV2:tokenUsage.contextWindow')}` + title;coarse 下按钮本体撑 `min-h/min-w-[var(--touch-target-size)]` 实体命中区(无 after:-inset 伪元素,P3 批 1 口径)。
- 纯视觉内层:`ComposerToolbar.tsx:209-220`,容器 span(`data-testid="context-window-usage-control"`)与 svg 环(`context-window-usage-ring`)均 `aria-hidden="true"`,环子树无任何 tabIndex——读屏序列里水位环恰好是一个有名字、可操作的按钮停靠点,不再是「念不出用途、Enter 按不动的可聚焦图片」。
- 双重扩区已消:内环不再自带命中区,44×44 由外层触发器独占(R1 P3 的「双层扩区嵌套」已闭环)。

## 5. AppMenu visualViewport —— 通过

`src/components/ui/app-menu/AppMenu.tsx` + `src/components/ui/visualViewport.ts`:

- 主菜单(:397)与子菜单(:968)定位钳位都改读 `getVisualViewportSize()`;定位计算中 `window.innerWidth/innerHeight` 直读零残留(契约断言 `not.toMatch(/window\.inner(Width|Height)/)` 成立)。
- 双处 `addVisualViewportChangeListener(updatePosition)` 订阅(:460 + 子菜单),与 `removeVisualViewportListener()` 清理一一配对;window resize/scroll 监听保留作兜底(passive,scroll capture 挂/卸标志一致)。
- R9 增补的活高度钳制在:`availableHeight = max(0, viewport.height - padding)`(:442/:982)经 `--app-menu-available-height` CSS 变量落到 `AppMenu.css` 的 `max-height: var(--app-menu-available-height, calc(100dvh - 16px))` + `overscroll-behavior: contain`——软键盘弹出时菜单不被顶出屏、不滚穿。
- 工具 fallback 正确:无 visualViewport 环境(桌面/旧 WebView)回退 `window.inner*`、监听返回 no-op,桌面行为等价——「改共享组件须通报 B 桌面回归面」的风险由此收敛为零行为差,且契约测试最后一组断言锁死 open/close、click 时机、portal 目标、Android back 注册未被顺手改动。

## 6. 读屏焦点顺序 —— 通过

DOM 序 = Tab 序 = 读屏序,三处锚点在 `InputBarUI.tsx` 实测为:输入壳 anchor(:2272)→ 内联面板槽 `{inlineComposerPanelNode}`(:2297)→ `<ComposerTextarea`(:2482)→ `<ComposerToolbar`(:2522)。面板在输入区上方「长出」,Tab 先进面板、再回输入区、最后到工具栏(发送按钮收尾),与视觉自上而下一致。InputBarUI 与 ComposerInlinePanel 均无正 tabindex(`tabIndex={1-9}` 零命中),无重排。

## 7. 测试是否仍锁行为 —— 仍锁,且本轮实跑全绿

定向 vitest(vitest 3.2.7,本轮实际运行,非引用历史报告):

| 测试文件 | 用例 | 结果 | 锁什么 |
|---|---|---|---|
| `ComposerInlinePanel.inertClamp.source.test.ts` | 8 | 绿 | inert 实现形态(ref+effect+依赖数组)、aria-hidden 条件化、二段 clamp 三行公式逐字、heightValue 双模式同源、桌面 overlay 反向断言 |
| `ComposerInlinePanel.focusOrder.source.test.ts` | 6 | 绿 | 双分支 region+label、五 case 非空标签计数、无条件 inert/aria-hidden 禁令、收起态 inert 门控、四锚点 DOM 序、正 tabindex 禁令 |
| `ComposerInlinePanel.focusOrder.test.tsx`(运行时) | 2 | 绿 | 真渲染 InputBarUI(mock isMobile):open 面板是有名非空 label 的 region、无 inert/aria-hidden 祖先、`compareDocumentPosition` 断言面板内真实可聚焦控件 → textarea → 发送按钮的文档序、全树无正 tabindex |
| `inlinePanelScreenReader.sequence.source.test.ts`(R7) | 11 | 绿 | 读屏序列三件套:门控完整性(含 ghost landmark:门控容器必须先于首个 region)、switch case 集合相等 drift 校验(新面板漏登记标签即红)、水位环 role=img 回潮禁令 + 装饰层 aria-hidden + 真按钮语义 |
| `AppMenu.visualViewport.source.test.ts` | 6 | 绿 | visualViewport 读取/订阅/清理配对、window 兜底监听、util fallback、活高度 CSS 钳制、「未顺手改行为」反向断言 |
| `inputBarSplitI18nKeys.contract.test.ts` | 7 | 绿 | 字面量+模板键双语可解析、叶子非空、四文件入清单、注册表 drift 校验 |
| **合计** | **40** | **40 绿 / 0 红 / 0 跳过** | |

锁定强度评估:**仍在锁,且方向 fail-closed**。关键回归路径各有守门:160px 回潮 → inertClamp 反向断言红;role=img 回潮 → sequence 测试三文件正则红;新面板 case 忘记赋标签 → case 集合相等 + 非空赋值断言红;无条件 inert/aria-hidden(把打开中的面板抠掉)→ focusOrder/sequence 双文件红;DOM 序被拆分/重排 → 四锚点断言显式红(锚点缺失也红,不会悄悄失效);AppMenu 被顺手改 open/close/portal/back → 反向断言红。source 契约(逐字断言)与运行时断言(真渲染 DOM)互为补充,单改源码绕不过运行时,单 mock 运行时绕不过 source。

## 8. 真机读屏 —— 未验证(明确留白)

以下全部**未验证**,静态与 jsdom 证据不能替代:

- **iOS VoiceOver:未验证。** 转子(rotor)里 region 地标可发现性、面板收起时 VoiceOver 焦点是否正确离开(见 §9 观察 2)、`aria-hidden` 撤除后内容重新可读的时序,均无真机证据。
- **Android TalkBack:未验证。** 线性导航序列(面板→输入→工具栏)、inert 子树在厂商 WebView(小米/华为等,R9 已登记 WebView 留白)上的支持度(inert 需 Chromium 102+,旧 WebView 下收起面板可能仍被 TalkBack 枚举——**代码无 tabindex/aria-hidden 之外的降级兜底,aria-hidden 可兜读屏树但兜不住 Tab 焦点**),均无真机证据。
- 键盘态二段 clamp 的实际布局(iOS overlay 键盘 + 短横屏)、AppMenu 软键盘弹出重定位的实机表现:未验证。
- jsdom 局限已在测试内诚实分工:运行时文件头注释言明「closing/closed 时 inert 的断言留在 source 测试里」,因 jsdom 无真实 inert 焦点语义——inert 的运行时行为**只有 source 级锁**,真机/真浏览器行为留白。

## 9. 残余观察(不派修,登记供后续轮)

1. **collectInertContexts 的多行 JSX 注释泄漏(测试脆弱性,非产品缺陷)**:注释行过滤只认 `//`、`*`、`/*` 行首;`ComposerInlinePanel.tsx:91` 的多行 JSX 注释续行(行首是中文)含 `inert` 字样,会泄进上下文集合。当前因该行同时含「closing/closed」而通过门控断言;若日后改写该注释、去掉这些词但保留 `inert`,focusOrder/sequence 两文件会**假红**。方向是 fail-closed(误报红而非漏报绿),可接受;修法是过滤器补多行注释状态机,或注释措辞保持含门控词。两份测试(focusOrder.source 与 sequence.source)各自拷贝了一份同名函数,修时须同步双份。
2. **收起时焦点去向无测试**:面板 closing 时若焦点在面板内,inert 化会把焦点弹到 body——没有断言「关闭后焦点回到触发器/textarea」。对读屏用户这是「焦点凭空消失」体验;且 aria-hidden 在 render 生效、inert 在 effect(paint 后)生效,存在理论上的一帧「aria-hidden 包含焦点元素」窗口。建议后续轮补焦点回归(focus return)行为与测试,归入读屏序列家族。
3. **`85vh - 180px` 双魔数**:输入区预留 180px 是注释约定,无共享常量或 source test 钉住,与输入区实际高度静默分叉的风险同 R1 的 V4(132px)同族——彼时 V4 已治,此处同模式未治。
4. **可跑性边界**:本轮只跑了上表 6 文件;R9 登记的 lint RuleTester(ESLint 9)问题、cargo 门禁(rustc 1.83 ≠ 1.98)不在本席位范围,状态以 R9 文档为准。

## 10. 已验证 / 未验证

- 已验证(静态):§1-§6 全部 file:line 逐行读码;`role="img"`、`clamp(160px,`、`window.inner*`(AppMenu 定位段)、正 tabindex 反向 grep;12 词条双语 python3 程序化取值非空。
- 已验证(运行):§7 定向 vitest 6 文件 40/40 绿(本轮实跑,含 1 个真渲染运行时文件)。
- 未验证:§8 全部(真机 VoiceOver / TalkBack / 厂商 WebView inert 支持度 / 键盘态布局)。本轮未跑全量 vitest、tsc、lint、build;未改任何产品源码与测试;未 commit。
