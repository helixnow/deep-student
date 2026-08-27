# Wave2 C R8 — input-bar 触控散点收敛

- `InputBarUI.tsx`：五个紧凑提示按钮保留桌面 `!h-6 !px-2 !text-xs`，coarse 最小高度改用 `--touch-target-size`。
- `ComposerToolbar.tsx`：发送、停止与运行时模型搜索框的 coarse 高宽改用 `--touch-target-size`，保留既有桌面和移动端视觉尺寸。
- `ComposerPlusMenu.tsx`：加号按钮的 coarse 最小宽度改用 `--touch-target-size`，保留已有 token 化最小高度。
- `ModelPicker.tsx`：20px 默认模型入口与 28px 关闭按钮改用共享 `coarseHit` 档位；分组行和对比开关改用触控尺寸 token。
- `BlockingAskUserBar.tsx`：24px 原因按钮改用 `coarseHitClassFor24`；选项行与单选实体按钮改用 token 化最小高度。
- `ComposerPanel/ComposerPanel.tsx`：关闭按钮高宽和列表行改用触控尺寸 token；20px 清除按钮改用共享 badge 命中档位。
- `QueuedMessageBubble.tsx`：气泡及其操作按钮的 coarse 最小高宽改用 `--touch-target-size`。
- `QueueErrorBar.tsx`：三个操作按钮的 coarse 最小高度改用 `--touch-target-size`。
- `__tests__/InputBarUI.mobileSplitContract.source.test.ts`：源码契约同步断言 token 化的工具栏、搜索框与五个紧凑提示按钮。

模型降级：否（保持 `gpt-5.6-sol-xhigh-fast`）。
