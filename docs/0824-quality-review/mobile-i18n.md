# 移动端 / i18n / InputBar 拆分与热区质量评审

## 结论

审查对象为 `origin/cursor/0824-cde6 @ 2d41ea8b`，对照 `v0.9.44`。

**总体判定：WARN。F 拆分叠加 G 热区是净改善，但还不能据现有源码契约判为完整 PASS。**

真正变好的不是行数本身，而是渲染所有权：v0.9.44 的 `InputBarUI.tsx` 是 3919 行单体；0824 将 textarea/IME、工具栏、附件面板和发送判定拆到独立文件，移动端热区也大多落到这些新所有者，而不是为了套 G 再把单体复活。移动端加号菜单改成单层列表、组合面板改成输入壳内联、发送/停止及附件头部采用实体 44px 控件，方向都正确。

但终态仍有一条可从事件顺序直接推导的高风险接缝：**内联附件面板中的 `AppMenu` 内容 portal 到面板外，InputBar 的全局 `pointerdown` 会先把组合面板关闭，菜单项的后续 `click` 可能来不及执行。** 此外，附件生命周期仍有两个所有者，伪元素热区存在重叠和混合设备漏判，i18n 契约也漏掉了当前真实存在的硬编码与动态键。现有测试更擅长证明“类名/文件还在”，不足以证明“手指能正确点中并完成动作”。

## F×G 确实改善的部分

`InputBarUI.tsx` 当前约 2661 行，并在 `:54-69` 引入拆出的 `ComposerTextarea`、`ComposerToolbar`、`AttachmentPanelBody` 与 helper；附件面板、textarea、工具栏的组装点分别位于 `:2110-2126`、`:2442-2466`、`:2482-2547`。`ChatContainer` 的活跃入口仍是 `InputBarV2`，legacy `InputBar` 没有复活。

这次拆分至少建立了三项有意义的边界：

1. IME、Enter/队列路由归 `ComposerTextarea.tsx`，移动端 Enter 只换行及 WebKit composition 时序不再与附件上传代码混在一起。
2. 发送/停止、模型/推理、水位环归 `ComposerToolbar.tsx`；附件头、列表及注入模式归 `AttachmentPanelBody.tsx`。G 的修改因此能落到实际 DOM 所有者。
3. 移动附件面板与桌面 overlay 复用同一 `AttachmentPanelBody`，而布局容器分别使用 `ComposerInlinePanel` 与 `ComposerPanelOverlay`，避免维护两份附件操作 UI。

热区实现也不是全靠透明扩区。发送/停止按钮、加号、附件面板的添加/更多/关闭，以及移动菜单行均使用实体 `44px` 或 `h-11`，这些控件比 v0.9.44 的小按钮更可靠。`AttachmentPanelBody.tsx:158` 将“更多”的读屏名称收敛为已有双语键 `common:more`，也修掉了拆分过程中曾出现的缺键方向。

需避免过度归功：Android native back、safe-area 注入及 `mobileShell.ts` 的核心链路与 v0.9.44 基本相同；0824 的价值主要是补消费面、面板注册和触控目标，不是重新建立了整套底座。`pointer:coarse` 出现次数大增同样只能证明规则增多，不能证明命中质量。

## 主要缺陷与风险

### 1. 高：附件“更多”菜单与 InputBar 外点关闭逻辑冲突

`InputBarUI.tsx:1387-1420` 在任一组合面板打开时给 `document` 注册 `pointerdown`。目标不在 `panelContainerRef`、`composerPanelOverlayRef` 或 `inputContainerRef` 内就立即 `closeAllPanels()`。

`AppMenuContent` 却在 `AppMenu.tsx:491-544` 默认 portal 到 `document.body`，菜单项动作直到 `click` 才在 `:597-600` 执行。移动附件面板内点击“更多”后，资源库、拍照、全部清除都位于这个 portal 中：

1. 手指按下菜单项，先触发 document `pointerdown`；
2. InputBar 将附件面板状态同步置为 false（`useInputBarV2.ts:484-489`）；
3. 内联面板及其 `AppMenu` 被卸载；
4. 后续 `click` 可能失去目标，业务回调不执行。

焦点门控已经知道 portal 的存在，`InputBarUI.tsx:1064-1067` 专门识别 `[data-app-menu-id]`；外点关闭却没有同一所有权判断，说明这不是臆测出的设备差异，而是两套逻辑没有接齐。桌面附件面板内若再打开 AppMenu，也有同类风险。

现有 `InputBarUI.mobileInlinePanel.test.tsx:88-92` 只断言“更多”按钮存在，没有打开菜单并走 `pointerdown → pointerup → click`。单独的 `ComposerPlusMenu` 测试直接 `fireEvent.click`，也绕开了 document pointerdown。

此项应在发布前修复。短期至少排除属于当前 Composer 的 menu portal；长期应由 overlay coordinator 提供“本面板拥有的浮层”关系，不能简单把全局所有 `[data-app-menu-id]` 都视为 InputBar 内部。

### 2. 中：拆分的是 DOM，附件生命周期仍然分叉

`AttachmentPanelBody` 文件头称自己是“纯展示组件”，实际在 `:91-128` 直接取消 PDF 处理、写日志、释放 Blob URL，再调用父级删除。与此同时：

- 主输入区的 `AttachmentPreviewChips.tsx:352-357` 直接调用 `onRemove`，不会取消后端处理；
- store 的 `sessionActions.ts:204-245` 又负责移除 ContextRef、处理状态和释放同一个 Blob URL；
- 清空路径也同时存在面板预处理与 store 清理（`AttachmentPanelBody.tsx:91-107`、`sessionActions.ts:247-306`）。

结果是同一附件从面板删除与从 chip 删除语义不同：前者取消处理，后者可能让已不可见的任务继续；前者还会与 store 重复 revoke。F 把视图搬出了单体，却没有把“删除附件”收敛成一个领域动作。

应把取消处理、ContextRef 清理、状态清理和 Blob 回收统一下沉到一个 remove/clear action，所有 UI 只传 attachment id。否则继续拆 UI 只会扩大行为分叉。

### 3. 中：部分 44px 只是源码上成立，实际命中区可能重叠

实体 44px 控件质量较好，工具栏的小控件则大量依赖 `after:-inset-*`。`ComposerToolbar.tsx:54-57` 将 28px/24px 控件向外扩 8px/10px，右侧工具栏的兄弟间距仅 8px（`:574-575`）。相邻伪元素因此会交叠，后绘制元素可截走前一元素的部分区域；水位环还在自身与外层 trigger 各扩一次（`ComposerToolbar.tsx:203-212`、`ContextUsagePopover.tsx:87-95`）。

所以“每个伪元素几何包围盒达到 44px”不等于“每个控件拥有独立、稳定的 44px 点击区域”。当前源码测试只查 `after:-inset-2` 字符串和出现次数，没有验证 `elementFromPoint` 最终落到哪个按钮。

更稳妥的实现是 coarse 布局下给每个交互项一个实体 44×44 flex box，视觉图标仍保持 24/28/36px；不要让相邻控件靠重叠伪元素争夺命中。

### 4. 中：`pointer: coarse` 不是“存在触摸能力”，更不是“存在相机”

`InputBarUI.tsx:804-808` 用 `(pointer: coarse)` 生成 `isMobileEnv`，并把它解释为设备能力；同一口径还决定大量 44px 和 16px 规则。仓内没有使用 `(any-pointer: coarse)`。

CSS `pointer` 描述主指针。触屏笔记本以鼠标/触控板为主指针时可能是 `pointer:fine`、`any-pointer:coarse`，此时触摸仍可用，但热区与拍照入口均不会出现。反过来，coarse 指针也不能证明设备有可用相机。当前“宽屏触摸设备会保留相机”的注释因此强于实现。

布局继续由宽度决定是正确的；触摸目标应按 `any-pointer: coarse` 或明确的输入模式决定，相机入口则应按平台/捕获能力与产品支持范围判断，不能共用一个 `isMobileEnv` 布尔值。

### 5. 中低：移动内联面板的无障碍与键盘边界未闭合

- `ComposerInlinePanel.tsx:50-96` 在 `closing` 时只把 grid 收到 0、opacity 设为 0，没有同步 `inert`/`aria-hidden`；220ms 保留期内隐藏控件仍可能进入 Tab 顺序或被读屏读取。
- skill 面板的 region 名称硬编码为英文 `Skills`（`InputBarUI.tsx:2167-2172`），绕过了已经存在并在加号菜单使用的 `skills:title`。
- 水位环是可点击、可展开菜单的控件，却在 `ComposerToolbar.tsx:203-212` 标成 `role="img"`；真正带 `aria-haspopup` 的外层 span 不是焦点元素。它可能可操作，但读屏语义不是按钮。
- `ComposerInlinePanel` 的高度以最小 160px clamp（`:51-54`）。短横屏叠加 iOS 键盘时，可用空间低于 160px 仍会强撑；“不会被顶出屏幕”的注释并非所有视口成立。
- `AppMenu.tsx:319-395` 的定位只看 `window.innerHeight`，也不监听 `visualViewport`；而同仓 `ComposerPanelOverlay.tsx:75-79,150-175` 已正确处理 iOS overlay 键盘。运行时模型搜索框聚焦后，InputBar 会抬升，固定菜单却可能不重定位或仍被键盘遮挡。

这些问题不会推翻 inline 优于 fixed overlay 的总体方向，但说明“键盘、焦点、读屏已统一”目前只能算静态部分成立。

### 6. i18n：当前字面量大体完整，守卫仍有明确盲区

正面事实是：拆分文件中被契约提取的 100 余个显式命名空间字面量键，在 zh-CN/en-US 都可解析；`common:more` 的消费方向也正确。

但 `inputBarSplitI18nKeys.contract.test.ts` 不能作为全量证明：

- 正则明确不扫描模板字符串。`ComposerPlusMenu.tsx:385-388,548-554` 的 permission preset 动态键、`AttachmentPanelBody.tsx:333` 的 upload stage 动态键都不在守卫内。当前两种 locale 恰好完整，不代表后续枚举扩展会被测试拦住。
- `resolveKey` 在叶子为 object 时也判成功（测试 `:58-68`），而 `t()` 的 UI 文案通常应要求非空字符串。
- 硬编码的 `Skills` 不包含 `t()`，自然不会被扫描。
- locale 中 `common:actions.more` 已无产品消费者，却被测试要求继续存在；这更像合并痕迹而非清晰的兼容策略。若无外部持久协议，应删除死别名；若确需兼容，应集中声明 alias，而不是让两个测试锁住相反方向。
- 移动抽屉仍引用缺失的 `sidebar:mobile_drawer.section_study/section_manage`（`MobileSidebarNavigation.tsx:132-133`），en-US 最终回落为中文“学习/管理”。这是 v0.9.44 既有欠账，不是 0824 回归，但在终态质量评审中仍是用户可见缺陷。

## 建议的收口顺序

1. 先修 Composer 面板与 AppMenu portal 的所有权，增加真实 pointer 序列测试，覆盖资源库、拍照、清空以及 Android back 先关菜单再关面板。
2. 将附件 remove/clear 收敛为单一领域动作，补“从 chip 删除也取消处理”的回归。
3. 用统一 `TouchTarget`/语义 token 替代散落的 `h-11`、`44px` 和伪元素计数；浏览器级验证相邻控件的最终 hit-test，不再以源码出现次数验收。
4. 分开 layout、touch capability、camera capability；补 `any-pointer` 混合设备场景。
5. closing 面板立即 inert，修复 skill region 与水位环语义，并让 AppMenu 复用 visualViewport 定位基础设施。
6. i18n 守卫改为 AST/类型化 key 提取；动态枚举逐值展开，叶子必须为非空字符串。补移动抽屉两键，并清理或正式声明 `actions.more` alias。
7. 后续继续拆分时优先抽出附件 controller、面板状态机和 toolbar view-model，而不是只继续切 JSX。`InputBarUI` 仍直接订阅 store、调用 VFS/API，`ComposerToolbar` 仍有 50 余项 props；当前是更可维护的视觉分区，还不是稳定的业务边界。

最终判断：**0824 的 F×G 合成方向正确，实体热区和移动内联布局带来真实收益；但 portal 交互、附件动作所有权和伪元素命中仍有产品级风险。修复首项并补交互级证据前，应维持 WARN，而不是用字符串契约宣布 PASS。**
