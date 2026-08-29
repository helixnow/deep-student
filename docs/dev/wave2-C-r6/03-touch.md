# 0824 Wave2-C R6 — 触控复核（R5 F3 关闭钮扩区收编共享出口）

- 轮次：第 6 轮复核-触控；模型 claude-fable-5-thinking-high
- 基线：b35038a8（/tmp/0824-wave2-c-r6-touch）
- 独占文件：src/features/learning-hub/components/finder/FinderQuickLook.tsx
- 约束遵守：未执行任何测试/编译；未 git commit；未使用 `!min-h-11`；视觉零变化
- 补丁：/tmp/0824-wave2-c-r6/03-touch.patch（工作区未提交改动同此）

## 结论

R5 F3 在 QuickLook 关闭钮上内联手写的 `after:-inset-1` 伪元素扩区串，已收编为
`@/components/ui/coarseHit` 共享出口的 `coarseHitClassFor36`。该常量字面量与被
替换的内联段**逐字符相同**（`relative` + coarse 门控 `after:absolute` /
`after:-inset-1` / `after:content-['']`），最终 class 集合不变，CSS 输出零差异，
命中区维持 40px + 两侧各 4px = 48px ≥ 44px。

## 方案取舍：coarseHit 共享出口，而非 TouchTarget

- coarseHit.ts 头注释规定：默认用实体盒（DsButton 下沉 / TouchTarget），仅当
  实体撑高会破坏硬布局约束时才允许伪元素扩区。本处正属后者——关闭钮在 coarse
  下视觉刻意压在 40px（`!h-10`）防 QuickLook 那条 `py-2` 标题栏撑高；换成
  TouchTarget 的实体 `min-h-[var(--touch-target-size)]`（44px）会把标题栏撑高
  4px，违反本轮「视觉不变」硬约束。
- 档位说明：`coarseHitClassFor36` 命名按「36px 视觉 → 44」标定，但其字面量就是
  `-inset-1` 档；本处 coarse 视觉 40px 用同档得 48px，与 FinderToolbar:280（同为
  `!h-10` + `-inset-1`）先例一致。已在代码注释写明换算，防后人按档名误判。

## 改动明细（单文件，1 处 import + 1 处 className）

1. 新增 `import { coarseHitClassFor36 } from '@/components/ui/coarseHit';`
   （紧邻既有 `cn` import）。
2. 关闭钮 className 由单一内联串改为
   `cn('!h-6 !w-6 !p-1 [@media(pointer:coarse)]:!h-10 [@media(pointer:coarse)]:!w-10', coarseHitClassFor36)`：
   保留细指针 24px / coarse 40px 的视觉尺寸段，伪元素扩区段整体替换为共享常量。
   `cn`（clsx + tailwind-merge）下两段无同组冲突类（尺寸带 `!` 且 modifier 不同、
   常量只含 relative/after 段），合并结果与原字符串 token 集合一致。
3. 注释同步改写：说明为何不用 TouchTarget（标题栏硬布局约束）及 -inset-1 档换算。

## 等价性核对

- 替换前内联段 vs `coarseHitClassFor36`（coarseHit.ts:24-25）逐 token 对照：
  `relative` / `[@media(pointer:coarse)]:after:absolute` /
  `[@media(pointer:coarse)]:after:-inset-1` /
  `[@media(pointer:coarse)]:after:content-['']` —— 完全一致，无增删。
- Tailwind JIT：常量为完整静态字面量（coarseHit.ts 头注释明令禁止模板拼接），
  且该组类已被 FinderToolbar / FinderQuickAccess 等处静态引用，产物 CSS 无新增。
- 文件内 `after:-inset` 与 `!min-h-11` grep 均为 0（底部「打开」钮既有的
  `[@media(pointer:coarse)]:min-h-11` 是无 `!` 的正常实体盒写法，非本轮禁项，
  不在本次任务范围）。

## 关联守卫与后续

- 这是 coarseHit.ts（R3 建出口）的**首个调用点迁移**，符合其头注释「本轮只建
  出口，调用点迁移另行进行」的批次节奏。
- `TouchTarget.source.test.ts` 只约束 TouchTarget.tsx 与 coarseHit.ts 本体，
  `ComposerToolbar.hitTarget.source.test.ts` 只扫 chat 输入条文件，均无
  FinderQuickLook allowlist，本改动不触发任何 source 契约调整。
- 建议后续轮把 FinderToolbar / FinderQuickAccess / TabPanelContainer /
  NoteContentView 等同款内联 `after:-inset` 一并迁到 coarseHit 档位常量，并考虑
  加 source 守卫禁止 learning-hub 下新增内联扩区串（本轮独占范围外，未动）。
