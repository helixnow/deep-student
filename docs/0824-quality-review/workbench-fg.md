# Workbench / 子应用 F × 移动端 G 合成质量评审

## 结论

对照 `v0.9.44` 与 `origin/cursor/0824-cde6@2d41ea8b`，这次合成在“代码怎么叠”上质量较高，在“运行中如何从一套壳切到另一套壳”上仍不合格。

**总判定：FAIL。**

这不是因为 F 与 G 互相覆盖得一塌糊涂。相反，最终树成功避开了预演中已经出现过的三类坏结果：没有复活旧 InputBar 单体，没有把已删除的 legacy notes 再带回来，也没有让隐藏子应用继续抢 Android back。终态的职责边界基本清楚：

- 桌面平台、稳定宽屏使用 Workbench，多窗口、Dock、快照和生命周期由 F 管；
- 移动平台始终使用 G 的经典单视图滑动壳，宽屏 iPad / Android 平板也不会误进 Workbench；
- PDF、EPUB、题库、翻译、作文、笔记等业务视图尽量复用，宿主只下发 `isActive`、窗口尺寸和导航能力，不复制第二套业务实现；
- 44px、coarse pointer、safe-area、Android back 属能力层，能够落到 F 拆分后的真实组件所有者。

真正阻断发布质量的是两条状态安全缝：

1. **Workbench 因模式开关或桌面窗口持续缩到 768px 以下而卸载时，不经过任何子窗口 `canClose` / 脏数据确认。** 250ms 迟滞只防瞬时抖动，不能保护持续窄窗。桌面快照只保存窗口壳，不保存编辑草稿。
2. **Workbench 的内存调度器会把被遮挡或最小化的后台窗口直接冻结并卸载应用子树，也不检查脏状态。** 翻译、作文、笔记、题目集的 dirty checker 随组件卸载注销；再次唤醒只能从已持久化数据重建，未保存编辑存在静默丢失路径。

这两项不是视觉瑕疵，而是 F 的窗口生命周期与共享子应用编辑生命周期没有形成同一个事务。G 没制造该缺陷，但 F/G 的双壳切换扩大了触发面，所以不能以“静态合成 PASS”代替产品质量验收。

## 这次合成做对了什么

### 1. 没有把“移动适配”误做成第二套移动 Workbench

当前 `workbenchActive` 同时受模式、稳定断点和原生移动平台约束；移动平台即使宽于 768px 也继续走经典壳（`src/App.tsx:796-858`）。渲染层也明确二选一：Workbench 激活时整个替换 legacy `CurrentView` 层，否则继续渲染 G 的单视图集合（`src/App.tsx:2810-2868`）。

这是合理的边界。WorkBench 的自由窗口、平铺、Exposé、Dock 和菜单栏并不适合直接缩成手机 UI；G 的统一顶栏、抽屉、safe-area 和系统返回键也不应再在窗口内部复制一次。`docs/dev/sota-subapp-polish/ROUND-02.md:99-105` 原本就把 G 限定为经典移动壳、明确“不做移动端 workbench”，终态与这个设计一致。

相对 `v0.9.44`，G 在本交叉面上的主要价值不是重写 native 桥：既有对照记录显示 native back / safe-area 注入主干基本未变；0824 的有效增量是把返回处理、可见性守卫和 coarse 热区补到更多真实子应用表面。这个归因是准确的，不应把全部移动底座都算成本轮新造。

### 2. 子应用复用的是业务视图，不是复制粘贴页面

Workbench 的 `WindowBody` 把窗口生命周期统一翻译成 `isActive` / `isVisible` / `isSuspended` 再下传（`src/features/workbench/components/WindowBody.tsx:174-249`）。内容应用继续通过 `UnifiedAppPanel` 打开 Learning Hub 的真实视图；题目集、作文和翻译只在外面增加单实例资源工作区，而不是再实现一遍编辑器（`src/features/workbench/apps/content/ContentAppWindow.tsx:53-145`）。

这使 G 的修复能落在同一业务组件上：

- EPUB 窄窗侧栏只在当前 tab 活跃时注册返回键，隐藏保活 tab 不会吞掉当前页面的 back（`src/features/learning-hub/apps/views/EpubPreview.tsx:144-156`）；
- Workbench 内容工作区把窗口焦点继续传给 `UnifiedAppPanel`（`src/features/workbench/apps/content/ResourceAppWorkspace.tsx:531-544`）；
- 翻译、作文和 Notes Workspace 的全局快捷键都按 `isActive` 收口，避免多个保活实例同时响应；
- Finder 工具栏用容器宽度决定 compact，而触控目标用 `(pointer: coarse)` 决定，触屏桌面可获得至少 44px 命中区，又不会把 38px 标题栏视觉高度硬撑坏（`src/features/learning-hub/components/finder/FinderToolbar.tsx:237-280`）。

这里的“窗口尺寸”“设备能力”“当前所有权”是三个独立信号，分层比 v0.9.44 的页面级假设更适合多宿主。

### 3. 冲突裁决体现了真实的所有权，而不是按整文件选边

F 与 G 的最大危险不是普通文本冲突，而是 G 的热区补丁最初落在 F 已拆掉的旧结构上。最终树保留 `InputBarUI` 编排壳，把发送/停止、水位环、模型搜索和附件操作分别落到 `ComposerToolbar`、`ComposerPlusMenu`、`AttachmentPanelBody`；现有契约也直接审计这些新所有者，而不是继续在旧壳里找字符串。

同样，G 删除的 `NotesTabsBar`、旧 preview panel、reference selector、DndFileTree 等 legacy notes 没有因 F 曾修改它们而复活；Workbench 继续使用新的单实例 `NotesWorkspaceApp`。这类 modify/delete 裁决方向正确。

这说明 52 个冲突不是简单“主体取 F、样式取 G”的口号式处理，而是至少在高风险文件上做到了按职责迁移。最终结果明显优于三个预演树中的任意一个。

### 4. 两套壳之间已有基本降级通道

`AgentBridge` 以实际 `workbenchActive` 同步启停 `workbenchBus`（`src/features/workbench/agent/AgentBridge.tsx:18-31`）。Workbench 不可用时，launch / activate 会通过 `legacyNavigationMap` 转成经典壳的 `CurrentView` 和资源打开事件；资源类回 Learning Hub，设置、待办、技能、模板和制卡任务回对应页面，桌面独占应用给出明确提示（`src/features/workbench/core/legacyNavigationMap.ts:30-143`）。

因此共享业务代码可以继续调用同一总线，不必到处判断手机、平板和桌面。这个方向是对的；问题在于它只解决“下一次打开去哪里”，没有解决“正在编辑的窗口如何安全退出和交接”。

## 接缝一：壳切换绕过脏数据协议

`App.tsx` 已经在注释里识别到风险：断点即时翻转会卸载整个 Workbench、绕过未保存确认，因此增加 250ms 稳定等待（`src/App.tsx:842-857`）。但等待结束后仍直接令 `workbenchActive=false`，随后渲染分支卸载 `LazyWorkbenchDesktop`；没有调用逐窗关闭，也没有 dirty preflight。

设置页关闭“学习桌面”同样是：

1. 保存 `desktop.workbenchMode=false`；
2. 只额外关闭原生 browser；
3. 直接关闭 bus 并派发模式变化事件。

实现见 `src/features/settings/components/WorkbenchSettingsSection.tsx:292-308`。它没有询问 Notes、essay、translation 或 exam 的 `canClose`。

Workbench 卸载清理只执行窗口快照 flush、投射清理和调度器停止（`src/features/workbench/components/WorkbenchDesktop.tsx:417-475`）。而快照契约明确只保存窗口、几何、平铺和 Dock 等壳状态，`launchPayload` 与运行期状态不进入快照（`src/features/workbench/core/snapshot.ts:1-18,118-130`）。

具体后果是：

- 多实例 note/textbook/file 至少还能凭 `instanceKey` 找回资源，但未保存正文仍不在壳快照中；
- exam / essay / translation 是 `instanceKey=null` 的单实例工作区，当前选中资源主要存在 `ResourceAppWorkspace` 本地状态；若最初从 launcher 打开，甚至没有可用于重建选中项的 launch payload；
- 模式切换后经典壳展示的是此前独立维护的 `currentView`，不会自动映射当前焦点 Workbench 窗口；用户可能从正在编辑的作文瞬间回到 Chat，既无确认也无明确“已切换到哪里”的反馈。

250ms 迟滞是渲染防抖，不是状态迁移协议。把它当成防丢数据措施属于错误安全感。

## 接缝二：内存冻结也绕过同一协议

更隐蔽的风险发生在用户根本没有切壳时。

调度器在预算超限后，从 background 窗口按 LRU 选择冻结对象；默认预算 12，macOS 9，宽限仅 2500ms。候选条件只看 lifecycle、权重和预取豁免，没有 dirty / `canClose` 检查（`src/features/workbench/core/scheduler.ts:44-53,117-123,542-575`）。

`WindowBody` 遇到 `frozen` 会直接停止渲染应用组件，只留下唤醒占位（`src/features/workbench/components/WindowBody.tsx:184-193`）。而 dirty registry 的设计是 React 视图挂载时注册、卸载时注销（`src/features/workbench/apps/content/contentDirtyRegistry.ts:24-43,62-81`）。真实消费者正是这种模式：

- Translation 注册 dirty checker 与 save handler（`src/components/TranslateWorkbench.tsx:386-429`）；
- Essay 只注册 dirty checker（`src/components/EssayGradingWorkbench.tsx:233-239`）；
- Notes / Exam 也在各自视图生命周期内注册 checker。

所以“关窗会询问”并不能推出“冻结安全”：冻结不是关窗，不走 `canClose`，组件一卸载，checker 和保存挂点也随之消失。再次唤醒时只能重建已落库状态。

这条风险比 Exposé 活体 DOM 的性能欠账更优先。Exposé 仍用真实窗口 DOM 做 transform，并仅对非焦点重窗关闭部分视觉效果（`src/features/workbench/components/ExposeOverlay.tsx:1-19`）；它会造成内存压力，而当前减压手段恰好可能把后台脏编辑器冻掉。性能保护不能以未保存内容为代价。

## 接缝三：桌面与移动连续性是“隔离”，不是“交接”

Finder 的 `files`、`page`、`page-mobile`、`canvas`、`canvas-mobile` 分桶能防止多宿主互相污染，这是正确的并发隔离。代价是跨断点、跨壳没有连续导航：

- Workbench Files 与移动 Learning Hub 使用不同 bucket；
- `currentView` 与 Workbench 焦点窗口是两套状态；
- legacy fallback 只处理新的 launch / activate，不迁移已打开窗口的资源、内部 tab、搜索和返回栈；
- 移动端“每个 CurrentView 可达”测试证明能进能出，但不证明能从焦点 Workbench 上下文无损接续。

因此当前产品承诺最多是“资源共用、宿主隔离”，不能表述成“桌面缩窄后原地续用”。这不是必须合并 bucket；更合理的是保留偏好隔离，只增加一个显式、可校验的 handoff descriptor，例如 `{ appType, resourceId, innerRoute }`。

## G 侧仍需保留的边界

G 的 44px、safe-area 和 Android back 静态链完整，但现有证据以源码规则和字符串契约为主。`mobileHeaderViewRegistryContract`、`mobileReachabilityContract` 能防 view 漏登记，却不能验证：

- Workbench 切经典壳时 dirty 窗是否阻止切换；
- 隐藏或冻结的窗口是否残留返回键 handler；
- iPad / Android 宽屏平台护栏与桌面浏览器窄窗是否产生不同且符合预期的交接；
- 伪元素扩出的 44px 区域在最终 CSS 层叠中的实际 hit-test；
- VoiceOver / TalkBack 下窗口内 compact drawer 与经典移动抽屉的焦点顺序。

另有一项 v0.9.44 既有欠账应继续单列：移动抽屉使用 `section_study` / `section_manage`，双语 locale 缺键，英文环境会显示中文 defaultValue。它不是 0824 合成回归，但也不应因“非回归”被误写成终态无缺陷。

## 优化顺序

1. **先做统一的 Workbench deactivation transaction。** 模式关闭、断点切壳、应用退出都必须先枚举窗口并执行 `canClose` / save checkpoint；任何窗口取消或保存失败，就保持 Workbench 激活并回滚模式 UI。
2. **桌面平台不要仅因宽度小于 768px自动换壳。** F 的子应用已经按容器宽度支持 compact；更稳妥的是桌面平台继续保留 Workbench 紧凑形态，只有 `isMobilePlatform()` 才固定进入 G 经典壳。若产品坚持按宽度换壳，也必须走第 1 条事务。
3. **给冻结增加 `prepareSuspend` / `canSuspend` 契约。** dirty 窗应保持 background，或在可验证保存成功后才 frozen；不能用通用 `keepAliveWhenOccluded` 手工白名单代替数据安全策略。
4. **建立双向 handoff。** Workbench → 经典壳至少传焦点 app、resourceId、内部路由；经典壳 → Workbench 则复用 `workbenchBus` 打开同一资源。Finder 视图偏好可以继续分桶，不必为了连续性重新共桶。
5. **补真正跨壳的行为测试。** 最低集合应覆盖：dirty essay/translation 在模式关闭时取消；dirty background 窗在预算超限时不冻结；桌面宽度跨 768px 后焦点资源仍可恢复；移动平台宽屏不启 Workbench；隐藏 EPUB/PDF tab 不消费 Android back。
6. **Exposé 后续改快照缩略图。** 当前降级只关视觉特效，没有消除活体 DOM 同屏缩放的根因；但修性能前必须先保证冻结不会丢草稿。

## 发布判断

F 与 G 的静态合并方法值得保留：按组件所有权重放移动增量、按平台拆宿主、按 `isActive` 收口副作用，方向都正确。若只检查“功能是否还在、44px 类是否还在、测试字符串是否还在”，它会得到 PASS。

但 Workbench 是默认桌面身份，模式切换和内存冻结都是正常产品路径。当前两条路径都可以绕开已经实现的未保存确认，并卸载可编辑子应用。修复 deactivation / suspend 事务并补跨壳行为测试之前，不建议把 `2d41ea8b` 描述为 F 与 G 已完成无损合成。
