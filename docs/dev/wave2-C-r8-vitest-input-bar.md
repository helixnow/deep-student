# Wave2-C R8 input-bar 契约族 Vitest 记录

日期：2026-08-26（UTC）

## 前置

- 分支：`cursor/0824-wave2-mobile-uiux-a875`，HEAD `900e7a33`。
- `src/version.ts` 已存在，跳过 `version:generate`；未执行 `npm ci`。
- 未拆批：整个 `__tests__` 目录一次跑完（约 18s）。

## 命令与总量

```
npx vitest run src/features/chat/components/input-bar/__tests__ --reporter=dot
```

- 退出码：`1`
- Test Files：**5 failed | 26 passed (31)**
- Tests：**7 failed | 238 passed (245)**；skipped：0
-（为取完整断言输出用 `--reporter=verbose` 复跑一次，结果一致：同样 7 failed / 238 passed，退出码 `1`。）

## 失败清单（7 条）

### 1–2. `AttachmentPreviewChips.removeCancels.source.test.ts`（2 条）

- 用例：`store layer cancels backend processing on remove (RED until card 1 lands)` 下的
  `removeAttachment source contains cancelPdfProcessing` 与 `clearAttachments source contains cancelPdfProcessing`。
- 断言摘要：对 `sessionActions.ts` 的 `removeAttachment` / `clearAttachments` 切片做 `toContain('cancelPdfProcessing')`，切片中无该字面量。
- 根因判断：**测试未随机制更新**。卡 1 的「删除即取消后端处理」行为实际已落地：两个 action 均调用包装函数 `cancelAttachmentProcessing(attachmentId, sourceId)`（`sessionActions.ts:81`，内部 `void cancelPdfProcessing(sourceId).catch(...)` 并带失败日志）。包装函数定义在切片锚点之外，字面量扫描漏检。产品行为正确，是断言锁了落地前设想的内联调用形态。同组的 regression-guard 用例（processing store 清 key + blob 释放）为绿。

### 3. `ComposerToolbar.hitTarget.source.test.ts`

- 用例：`keeps a single hit-area owner for the context usage ring (no double after:-inset)`。
- 断言摘要：`countOccurrences(ringFnSlice) + countOccurrences(popoverTriggerSlice)` 对 `after:-inset` 原始子串计数，期望 ≤ 1，实得 2。
- 根因判断：**测试未随机制更新（注释误伤）**。两处命中全是注释：`ComposerToolbar.tsx:206-208`（内环「不再自带 after:-inset」说明）与 `ContextUsagePopover.tsx:89-90`（「不再用透明 after:-inset 外扩」说明），均由落地机制的同一提交 752b592c 引入。真实类名中已无 `after:-inset`——同目录 R7 补遗测试 `ComposerToolbar.hitTarget.r7.source.test.ts` 只扫字符串字面量（其文件头明确指出「注释里合法提到 after:-inset，全文 not.toContain 必然误红」），整文件扫描为绿。R3 这条是子串计数没做同样的注释豁免。非产品回归。

### 4–5. `InputBarUI.androidBack.sequence.test.tsx`（2 条）

- 用例：`菜单开→back→面板仍开→back→面板关→back 交还 native`（第二次 back 后断言）与 `只开面板不开菜单：一次 back 直接关面板`。
- 断言摘要：`handleAndroidBack()` 返回 `consumed === true`（通过）后，`isAttachmentPanelOpen()` 期望 `false` 实得 `true`。探针实现是查 DOM：`root.querySelector('[data-composer-panel-inline="attachment"]') !== null`。
- 根因判断：**测试未随机制更新（探针未考虑收起动画的 deferred unmount），非产品回归**。返回键链路本身工作正常：back handler 消费事件并 `closeAllPanels()` → `onSetPanelState('attachment', false)`，harness 状态确实翻转（第一次 back 只关菜单、留面板的层级断言全部通过）。但 `InputBarUI` 的 `useDeferredOpen`（220ms 收起兜底）在关闭后仍保留面板节点做退场动画（`data-panel-motion="closing"`，`shouldRender` 220ms 后才翻 false），DOM 存在性探针在 `act()` 返回的瞬间必然还能查到节点。该测试文件由 d56f93ea 以「只写不跑」方式提交（文件头自述「本轮只写不跑」），本轮是首次执行，探针从未被校验过；修法应是探针改看 `data-panel-motion`（open/opening）或 fake timers 推 220ms，不在本轮允许改动范围。

### 6. `InputBarUI.appMenuOutsideClick.pointer.test.tsx`

- 用例：`InputBarUI outside-click source contract (卡1) > exempts [data-app-menu-id] portal targets inside handleClickOutside`。
- 断言摘要：对 `isWithinComposerTerritory` 谓词切片要求匹配内联字面量 `/closest\(\s*['"`]\[data-app-menu-id\]['"`]\s*\)/`，未命中。
- 根因判断：**测试未随机制更新**。豁免行为仍在，但字面量收敛成常量 + 注册表：`COMPOSER_OWNED_OVERLAY_SELECTOR = '[data-app-menu-id]'`（`InputBarUI.tsx:116`），谓词改走 `isOwnedOverlayTarget(COMPOSER_OVERLAY_OWNER_ID, node)` 与 `node.closest(COMPOSER_OWNED_OVERLAY_SELECTOR)`。同文件的功能测试（合成 `[data-app-menu-id]` body portal 上 pointerdown 不关面板）为绿，证明行为保留。另注：切片正则 `\},\s*\[\]\);` 也已漂移（谓词 deps 现为 `[isOwnedOverlayTarget]`），实际抓到的是数百行外的 `scrollCaretIntoView`，锚点契约同样过期。

### 7. `inputBarCapabilities.test.ts`

- 用例：`能力模块不使用 enumerateDevices（避免权限弹窗）也不使用指针媒体查询判相机`。
- 断言摘要：`expect(capabilitiesSource).not.toContain('enumerateDevices')`，命中源文件。
- 根因判断：**测试未随机制/注释更新（注释误伤），非产品回归**。`inputBarCapabilities.ts` 代码中无任何 `enumerateDevices` 调用；命中的是文件头 doc 注释「刻意不用 enumerateDevices()（部分平台会触发权限弹窗）」——解释为什么不用它的文字本身触发了朴素子串扫描。模块与该注释、以及测试的最后修订同为提交 752b592c，属同波自伤，与 R7 补遗针对 `after:-inset` 记录的坑一模一样（那边已改用字符串字面量扫描规避）。

## 失败归类汇总

| 类别 | 条数 | 条目 |
|---|---:|---|
| 测试未随机制更新（字面量/锚点锁旧形态） | 3 | #1、#2、#6 |
| 测试未随机制更新（子串扫描误伤注释） | 2 | #3、#7 |
| 测试未随机制更新（探针未考虑 220ms deferred unmount；首跑的「只写不跑」用例） | 2 | #4、#5 |
| 本波产品回归 | 0 | — |
| 环境问题 | 0 | — |

## 改动边界

- 改了测试：**否**。7 条失败均非「断言锁旧 `!min-h-11` / `!h-11` 字面量」情形，不在本轮允许修改范围，全部只记录。
- 未修改产品逻辑、workflow/CI、`coordinator.rs`、`tool_loop`、anki 域、sessionActions 发送/流式。
- 未 commit，未 push。
