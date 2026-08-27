# Wave2-C R9 input-bar 过期测试修绿记录

日期：2026-08-26（UTC）

## 前置

- 分支：`cursor/0824-wave2-mobile-uiux-a875`，HEAD `7e3302a1`。
- 输入：R8 记录（`docs/dev/wave2-C-r8-vitest-input-bar.md`）判定的 7 条失败，
  根因全部为「测试未随机制更新」，产品行为已正确。
- 本轮只改 5 个测试文件，未改任何产品 ts/tsx、未改 `sessionActions.ts`、
  未碰 coordinator.rs / tool_loop / anki 域 / CI，未手贴 `!min-h-11`。

## 逐条：旧红 → 新绿

### 1–2. `AttachmentPreviewChips.removeCancels.source.test.ts`（R8 #1、#2）

- 旧红：对 `sessionActions.ts` 的 `removeAttachment` / `clearAttachments` 切片
  `toContain('cancelPdfProcessing')`。机制落地形态是模块级包装函数
  `cancelAttachmentProcessing(attachmentId, sourceId)`（`sessionActions.ts:81`，
  fire-and-forget + 失败日志），两个 action 只调包装、切片里无旧字面量。
- 新绿：契约改为两段——
  a) 两个 action 切片 `toContain('cancelAttachmentProcessing(')`；
  b) 新增包装函数切片（锚点 `function cancelAttachmentProcessing(` →
  `export function createSessionActions(`，并入防空断言），断言其体内
  `toContain('cancelPdfProcessing(')`，防止包装名还在、后端取消被挖空。
  describe 名从 "RED until card 1 lands" 改为 "card 1 landed, R9 updated"，
  文件头【第二组】说明同步改写。regression-guard 用例未动。

### 3. `ComposerToolbar.hitTarget.source.test.ts`（R8 #3）

- 旧红：`keeps a single hit-area owner…` 对 ring 函数切片 + popover 触发器
  切片做 `after:-inset` 原始子串计数（≤1），机制落地提交在两处切片内留下
  「不再用 after:-inset」的说明注释，计数 2 全是注释。
- 新绿：引入与 R7 补遗（`ComposerToolbar.hitTarget.r7.source.test.ts`）同款
  `extractStringLiterals` 字面量提取，计数改为「含 needle 的字符串字面量数」
  （`countLiteralOccurrences`），注释天然不参与。断言仍是两切片合计 ≤ 1，
  契约语义不变。原 `countOccurrences` 助手随之删除，其余用例未动。

### 4–5. `InputBarUI.androidBack.sequence.test.tsx`（R8 #4、#5）

- 旧红：`isAttachmentPanelOpen()` 探针用「`[data-composer-panel-inline="attachment"]`
  节点还在 DOM」当开。`useDeferredOpen` 在关闭后保留节点 220ms 做退场动画
  （`data-panel-motion="closing"`），back 关面板后的 `act()` 瞬间节点必然还在。
- 新绿：探针改看 `data-panel-motion`——`open` / `opening` 为开，
  `closing` / `closed` / 节点已卸载为关（与 `ComposerInlinePanel.focusOrder.test.tsx`
  的展开态判定一致）。未用 fake timers（两方案任选其一，motion 探针改动更小）。
  pointerdown→back 全链保持：两条用例仍走真实组件挂载 + `handleAndroidBack()`
  出栈序列 + `consumed` 布尔断言，无「按钮存在」式弱化。文件头补 R9 探针
  说明并移除「本轮只写不跑」字样（本轮已实跑）。

### 6. `InputBarUI.appMenuOutsideClick.pointer.test.tsx`（R8 #6）

- 旧红：source 契约要求谓词切片匹配内联
  `closest('[data-app-menu-id]')` 字面量；且谓词切片锚点 `\},\s*\[\]\);` 已随
  deps 变为 `[isOwnedOverlayTarget]` 而漂移（实际抓到数百行外的
  `scrollCaretIntoView`）。
- 新绿：契约改认落地形态——
  a) handler 段不变：`handleClickOutside` 必须走 `isWithinComposerTerritory(e.target as Node)`；
  b) 谓词切片锚点放宽为 `\},\s*\[[^\]]*\]\);`（deps 内容不锁死），切片内断言
  `isOwnedOverlayTarget(COMPOSER_OVERLAY_OWNER_ID, node)` 与
  `node.closest(COMPOSER_OWNED_OVERLAY_SELECTOR)` 同时保留；
  c) 兜底断言常量 `COMPOSER_OWNED_OVERLAY_SELECTOR = '[data-app-menu-id]'`
  仍指向原字面量。5 条功能 pointer 用例（真实菜单三项 + 合成 portal + 外点
  sanity）一字未动，R8 时即为绿。

### 7. `inputBarCapabilities.test.ts`（R8 #7）

- 旧红：`expect(capabilitiesSource).not.toContain('enumerateDevices')` 误伤
  模块头 JSDoc 的散文「刻意不用 enumerateDevices()」。代码中本无任何调用。
- 新绿：扫描前先剥离块注释与行注释（该文件无含 `//` / `/*` 的字符串字面量，
  朴素正则剥离安全），对剥离后的 `capabilitiesCodeOnly` 做 `not.toContain`；
  `'(pointer: coarse)'` 检查一并迁到剥离后文本。另加一条自证用例：原文仍
  含 `enumerateDevices` 散文，证明剥离注释的扫描是必要的（照 R7 补遗
  "load-bearing" 模式）。其余运行时用例未动。

## 命令与结果

```
npx vitest run \
  src/features/chat/components/input-bar/__tests__/AttachmentPreviewChips.removeCancels.source.test.ts \
  src/features/chat/components/input-bar/__tests__/ComposerToolbar.hitTarget.source.test.ts \
  src/features/chat/components/input-bar/__tests__/InputBarUI.androidBack.sequence.test.tsx \
  src/features/chat/components/input-bar/__tests__/InputBarUI.appMenuOutsideClick.pointer.test.tsx \
  src/features/chat/components/input-bar/__tests__/inputBarCapabilities.test.ts \
  --reporter=verbose
```

- 退出码：`0`
- Test Files：**5 passed (5)**
- Tests：**35 passed (35)**（R8 时这 5 个文件合计 33 条、7 failed；本轮
  新增 2 条契约用例：包装函数体断言、enumerateDevices 注释自证；selector
  常量兜底与谓词断言并入原有用例，不另立条目）
- R8 的 7 条旧红全部转绿，无新增红。

## 改动边界

- 仅改 5 个测试文件 + 本记录文档。
- 未改产品逻辑 / workflow / CI / coordinator.rs / tool_loop / anki 域。
- 未 commit，未 push（按本轮指令）。
