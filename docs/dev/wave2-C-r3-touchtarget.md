# Wave2-C R3 — TouchTarget：非 button 热区的 coarse 触控出口

- 日期：2026-08-26 / 基线 e90fb360
- 落地：`src/components/ui/TouchTarget.tsx`、`src/components/ui/coarseHit.ts`、
  `src/components/ui/__tests__/TouchTarget.source.test.ts`（只写不跑）
- 设计定稿全文：/tmp/0824-wave2-c-r3/01-touchtarget-design.md（本文件是库内速查版）

## 一句话规则

coarse 触控保证只有三个出口，按优先级：

1. 渲染 `<button>` → **DsButton**（coarse 保证由 buttonPrimitiveContract 下沉，批 2 进行）；
2. 非 button 热区（span trigger / 链接 / 第三方外壳）→ **TouchTarget**（实体盒，默认）；
3. 实体撑高破坏硬布局约束（标题栏 40px、微控件密排行）→ **coarseHit.ts** 共享档位（伪元素逃生舱）。

不允许的写法：调用点手写 `[@media(pointer:coarse)]` 任意变体、私有 COARSE_HIT 拷贝、散点 `!min-h-11`。

## TouchTarget 用法

机制：coarse 指针下 `min-h/min-w = var(--touch-target-size)`（44px）撑出真实命中盒；
min-* 天然赢过 h-*/w-*，无需 `!important`；细指针下不生效，视觉不变。
图标视觉尺寸（24/28/36）由 children 控制，组件不干预。

```tsx
import { TouchTarget } from '@/components/ui/TouchTarget';

// 形态 A：asChild —— 子元素自己是交互元素时优先（真实盒长在事件目标上）
<TouchTarget asChild>
  <a className="inline-flex h-7 items-center gap-1" href="...">…</a>
</TouchTarget>

// 形态 B：span 包裹盒 —— children 只做视觉，事件/aria 放 TouchTarget 上
<AppMenuTrigger asChild>
  <TouchTarget role="button" aria-label="上下文用量">
    <ContextWindowUsageRing />  {/* 视觉 28px；coarse 下外层 44×44 flex 居中 */}
  </TouchTarget>
</AppMenuTrigger>
```

纯 className 场景可直接用导出常量：

- `touchTargetClassName`：完整盒（`inline-flex shrink-0 items-center justify-center` + coarse min 尺寸）；
- `touchTargetCoarseClassName`：仅 coarse min 尺寸，叠加到已自带 flex 布局的元素上。

### 陷阱与反例

- **形态 B 别包可交互 children**：span 撑到 44 但内部 28px 按钮才接事件 → 假命中区。改用形态 A。
- **别用 TouchTarget 包 DsButton**：DsButton 的 coarse 缺口（lg 视口 + coarse 设备拿到 32px）由批 2 的
  contract 下沉修，调用点套 TouchTarget 是双机制，之后要回收。
- 密排 flex 行默认 `shrink-0` 防压缩；确需参与收缩的调用点用 className 覆盖。

## coarseHit.ts 档位速查（逃生舱）

按控件**视觉尺寸**查档，全部 coarse 门控、全字面量（Tailwind JIT 依赖静态提取，禁止模板串拼档位）：

| 视觉 | 导出 | 外扩 |
|---|---|---|
| 36px (h-9) | `coarseHitClassFor36` | -inset-1 |
| 32px (h-8) | `coarseHitClassFor32` | -inset-1.5 |
| 28px (h-7) | `coarseHitClassFor28` | -inset-2 |
| 24px (h-6) | `coarseHitClassFor24` | -inset-2.5 |
| 16px 角标（自身 absolute） | `coarseHitClassForBadge16` | -inset-3.5 |

伪元素扩区不占布局空间，**相邻扩区会互相覆盖**：间距小于两侧外扩量之和时必须用
z-index 显式仲裁（先例 `TabBar.tsx` `z-[1]`）。这正是它只当逃生舱的原因。

## 本轮边界

- 只建出口与最小组件，**未做全库替换**：私有 COARSE_HIT 上收（translation / essay-grading /
  ComposerToolbar 三档）属批 1；contract 下沉属批 2；lint 规则 `coarse-touch-target` 属批 3。
- 有意折衷（wave2-C-r1/09-touch-44.md §6：MiniCalendar/TabBar 宽 28、FinderToolbar 40+48、
  `.touch-row` 48 基线等）不受影响、勿当新洞。
