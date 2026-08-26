# Wave2 C R8 — input-bar chips 簇残留内联伪元素扩区收敛

机制吃散点：input-bar chips 簇里最后 5 处手写 `[@media(pointer:coarse)]:after:-inset-*`
内联字面量，全部换成体系逃生舱 `@/components/ui/coarseHit` 的导出常量。
视觉尺寸（`h-6`/`!h-4`、图标 12/10）与 onRemove/取消处理语义一律不动。

## 每处旧类 → 新导入

| 文件（行号为改后） | 控件 | 旧内联档位 | 新导入常量 |
| --- | --- | --- | --- |
| `AttachmentPreviewChips.tsx` ~428 | h-6 错误/部分态重试钮（原生 `<button>`） | 内联 `-inset-2.5` 三件套 | `coarseHitClassFor24`（自带 `relative`，字面量里的前导 `relative` 一并删除） |
| `ContextRefChips.tsx` ~190 | `!h-4` 删除钮（DsButton） | 内联 `-inset-3.5` 三件套 | `coarseHitClassForBadge16`（常量不含 `relative`，字面量保留 `relative`） |
| `PageRefChips.tsx` ~106 | `!h-4` 清空钮（DsButton） | 同上 | `coarseHitClassForBadge16` |
| `ActiveFeatureChips.tsx` ~79 | `!h-4` 关闭钮（DsButton） | 同上 | `coarseHitClassForBadge16` |
| `ModelMentionChip.tsx` ~126 | `!h-4` 删除钮（DsButton） | 同上 | `coarseHitClassForBadge16` |

拼接方式统一 `cn('<视觉类字面量>', coarseHitClassXxx)`，常量保持完整字符串字面量
（Tailwind JIT 静态提取），无模板串拼档位。原为纯字符串 className 的四处 DsButton
改为 `cn()` 调用（各文件本就导入 `cn`）。

## 验收

- 上述 5 文件 grep 内联伪元素扩区字面量：产品源 0 残留（含注释也为 0）。
- 视觉类 `h-6 w-6`、`!h-4 !w-4`、`!w-4 !h-4` 全部原位保留。
- eslint（R8 允许对本文件静态扫）：对 5 个文件跑 `node_modules/.bin/eslint`，
  0 errors；2 个 warning 均为 `AttachmentPreviewChips.tsx` 既有的
  `ds-components/no-native-button`（353/419 行原生 `<button>`），本轮规则明确
  「不把 `<button>` 改成 DsButton」，属预期保留、非本轮引入。
- 未跑 vitest / typecheck / vite / cargo / CI（按轮次约束）。

模型降级：否（保持 claude-fable-5-thinking-xhigh）。
