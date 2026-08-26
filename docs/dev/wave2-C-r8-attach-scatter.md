# Wave2-C 第 8 轮：附件散点收敛

## 变更

- `AttachmentPanelBody.tsx`：7 处 coarse pointer 最小高度收敛到 `min-h-[var(--touch-target-size)]`，移除强制覆盖。
- `ComposerPlusMenu.tsx`：加号入口 1 处做同样收敛，移除最小高度的 `!important`。
- `InputBarUI.mobileSplitContract.source.test.ts`：改为校验 touch-target token，不再要求旧的强制最小高度类。

## 验证

- `git diff --check`：通过。
- `node_modules/.bin/vitest run src/features/chat/components/input-bar/__tests__/InputBarUI.mobileSplitContract.source.test.ts`：6 项测试全部通过。
- 未执行依赖安装。
