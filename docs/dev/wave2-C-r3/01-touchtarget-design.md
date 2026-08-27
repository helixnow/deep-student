# 0824 Wave2-C R3 — TouchTarget 设计定稿（01-touchtarget-design）

- 角色：TouchTarget 设计（第 3 轮）/ 模型 claude-fable-5-thinking-high
- 基线：e90fb360
- 日期：2026-08-26
- 结论先行：**非 button 热区的 coarse 触控保证收敛为一个实体盒组件 `TouchTarget`（min-h/min-w = `--touch-target-size`，coarse 门控），伪元素 `after:-inset` 降级为逃生舱并收进唯一共享出口 `coarseHit.ts`。** 本轮已落地最小组件 + 共享出口 + source 测试（只写不跑），未做全库替换，未触碰 DsButton / contract / eslint-rules。

---

## 1. 落地物清单

| 文件 | 性质 | 内容 |
|---|---|---|
| `src/components/ui/TouchTarget.tsx` | 新建 | 最小组件：asChild（Radix Slot）或 span 包裹盒；导出 `touchTargetClassName` / `touchTargetCoarseClassName` 两个类常量 |
| `src/components/ui/coarseHit.ts` | 新建 | 伪元素扩区唯一共享出口：36/32/28/24 四档 + 16px 角标特例，全部 coarse 门控、全字面量 |
| `src/components/ui/__tests__/TouchTarget.source.test.ts` | 新建（只写不跑） | 锁定 min-h/min-w token、flex 盒、asChild、无伪元素/无 `!min-h-11`、coarseHit 全门控全字面量 |
| `docs/dev/wave2-C-r3-touchtarget.md` | 新建 | 库内使用文档（供后续迁移批次引用） |

禁改文件（DsButton.tsx、buttonPrimitiveContract.ts、eslint-rules/、InputBarUI.tsx、ComposerToolbar.tsx、AttachmentPanelBody.tsx）本轮零改动。

---

## 2. 核心决策（定稿）

### 2.1 实体盒是默认，伪元素是逃生舱

- coarse 指针下命中区由**真实盒**保证：`[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]` + 同款 `min-w`（`--touch-target-size` = `--control-height-touch` = 44px，`shadcn-variables.css:41-42`）。
- **不再以 `after:-inset` 伪元素扩区为默认**。r1 台账（09-touch-44.md §2）已证明伪元素流在密排行内互相覆盖（ComposerToolbar 右侧行 -inset-2×2 对 gap-2 完全重叠 8px、水位环双重扩区等），且不占布局空间导致重叠无从仲裁。实体盒挤占真实空间，命中区绝不重叠——这是 Apple HIG / Material 的标准做法，也是库内正确先例（`DsDialog.tsx:263-264` 关闭按钮、`TodoIconRail.tsx:55` 注释）的形态。
- 伪元素扩区仅在「实体撑高破坏硬布局约束」时允许（FinderToolbar 标题栏 40px、mindmap 微控件密排行），且必须走 `coarseHit.ts` 共享出口，不再私有拷贝。

### 2.2 min-* 而非 h-*/!important —— 视觉与命中分离的机制

- 用 `min-height`/`min-width` 而不是 `height`/`width` 或 `!h-11`：CSS 求值层面 **min-height 天然赢过 height，与 specificity 无关**。调用方的视觉尺寸类（`h-6`/`h-7`/`h-9`/`w-9` 等）原样保留，coarse 下真实盒被 min-* 抬到 44，细指针下 min-* 整组不生效、视觉完全不变。
- 因此**零 `!important`**：不需要 `!min-h-11` 去对抗谁。这同时是本轮最高红线——不建议任何散点 `!min-h-11`，机制上也让它失去存在必要。
- 尺寸只引用 token（`var(--touch-target-size)`），不写死 `44px`/`min-h-11`：将来 token 调整（如 48）一处生效。source 测试锁了这一条。
- 图标视觉尺寸 24/28/36 由 children 自己控制（svg/内层盒的 h-6/h-7/h-9），TouchTarget 只做 flex 居中，不干预 children 尺寸。

### 2.3 API 定稿（刻意最小）

```tsx
export interface TouchTargetProps extends React.HTMLAttributes<HTMLSpanElement> {
  asChild?: boolean;
}
```

两种形态，与 `shad/Button.tsx` 的 Slot 范式完全同款：

```tsx
// 形态 A：asChild —— 类合并到唯一子元素上，真实盒长在交互元素自己身上（优先）
<TouchTarget asChild>
  <a className="inline-flex h-7 items-center ..." href="...">...</a>
</TouchTarget>

// 形态 B：span 包裹盒 —— span 自身是命中面，事件/aria 放 TouchTarget 上，children 只做视觉
<AppMenuTrigger asChild>
  <TouchTarget role="button" aria-label="上下文用量">
    <ContextWindowUsageRing />  {/* 视觉 28px，coarse 下外层 span 44×44 flex 居中 */}
  </TouchTarget>
</AppMenuTrigger>
```

- 形态 B 的已知陷阱已写进组件 JSDoc：children 若自己是可交互元素，span 撑到 44 但内部 28px 按钮才接事件，会产生假命中区——这种场景必须改用 asChild。
- 另导出两个类常量供纯 className 消费：
  - `touchTargetClassName`：`inline-flex shrink-0 items-center justify-center` + coarse min 尺寸（完整盒）；
  - `touchTargetCoarseClassName`：仅 coarse min 尺寸，给已自带 inline-flex 布局的元素叠加。
- `shrink-0` 进默认类：密排 flex 行空间不足时防止命中区被压回 44 以下；个别需要参与收缩的调用点可用 className 覆盖（`cn` 后拼）。
- **不做的事**（刻意）：不加 size/axis/inset 等 props，不做非对称档位（整行列表项只缺 min-h，min-w-44 对整宽行恒满足、无害），不内置伪元素模式（那是 coarseHit 的职责，混进来会让「默认实体」的立场变模糊）。

### 2.4 coarseHit.ts —— 逃生舱共享出口

取代 8+ 份私有拷贝、4 种参数（r1 §1.3：translation 四文件 `-inset-1.5`、essay-grading `-inset-2`/`-inset-2.5`/`-inset-3.5`、ComposerToolbar 三档 `-inset-1`/`-inset-2`/`-inset-2.5`）。档位按**视觉尺寸**命名，迁移时按控件视觉边长直接查档：

| 导出 | 视觉 | 外扩 | 对应存量 |
|---|---|---|---|
| `coarseHitClassFor36` | 36px (h-9) | -inset-1（4px/侧） | ComposerToolbar `coarseHitAreaClass` |
| `coarseHitClassFor32` | 32px (h-8) | -inset-1.5（6px/侧） | translation 四文件 `COARSE_HIT` |
| `coarseHitClassFor28` | 28px (h-7) | -inset-2（8px/侧） | ComposerToolbar `Lg`、essay `COARSE_HIT` |
| `coarseHitClassFor24` | 24px (h-6) | -inset-2.5（10px/侧） | ComposerToolbar `Xl`、essay `COARSE_HIT_SM` |
| `coarseHitClassForBadge16` | 16px 角标（自身 absolute，不带 relative） | -inset-3.5（14px/侧） | essay `COARSE_HIT_BADGE` |

- 附 `coarseHitClassByVisualSize` 记录（36/32/28/24 → 类名）供迁移对照。
- 每档全部 `[@media(pointer:coarse)]` 门控——r1 抓到的 25 处裸 `-inset` 扩区（桌面鼠标也被放大）在出口层面不可能再现。
- **全字面量**，禁止模板串拼 `-inset` 档位（Tailwind JIT 静态提取会失效），文件头注释 + source 测试双重锁定。
- **本轮只建出口，不做全库替换**。调用点迁移属 Wave2-C 批 1（ComposerToolbar 簇首站），且 ComposerToolbar.tsx 本轮禁改。

---

## 3. 与 DsButton / buttonPrimitiveContract 的分工（定稿）

```
渲染 <button> ────────────→ DsButton（coarse 保证下沉进 buttonPrimitiveContract，批 2）
非 button 热区（span trigger／链接／第三方外壳）
  ├─ 实体撑高可接受（默认）──→ TouchTarget（本轮落地）
  └─ 硬布局约束不容撑高 ────→ coarseHit.ts 共享档位（逃生舱，注意重叠仲裁）
```

- **DsButton 走 contract**：批 2 将在 `buttonSizeClassNames` / `buttonIconSizeClassNames` 的 `lg:` 压缩后追加 `[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]`（iconOnly 加 `min-w`），一次覆盖 2165 个调用点，并同步契约测试。该文件是契约冻结区（PR #172 先例），本轮禁改、未改。
- **TouchTarget 与 contract 用同一个 token、同一种 min-* 机制**：两条线下沉完成后，全库 coarse 保证只有一种语义（coarse → min 44 实体），lint 规则（批 3 `ds-components/coarse-touch-target`）的白名单恰好就是 `src/components/ui/**` 里这两个出口 + coarseHit。
- **不要用 TouchTarget 包 DsButton**：批 2 落地前 DsButton 在 lg 视口 + coarse 设备（iPad 横屏）确有 32px 缺口，但正确修法是等 contract 下沉，而不是在调用点套 TouchTarget 造成双机制——这一条写进了库内文档的「反例」段。

---

## 4. 迁移路径（不在本轮执行，供批次排program）

1. **批 1（chat 输入条簇）**：ComposerToolbar 三档私有常量 → `coarseHit.ts` 对应档位（纯常量上收，行为不变）；水位环/ContextUsagePopover 双层扩区并一层，AppMenuTrigger 外壳 span 改 `TouchTarget` 形态 B；右侧行相邻扩区重叠改实体 min 尺寸。
2. **批 2（contract 下沉）**：见 §3，带 19 项契约测试更新。
3. **批 3（lint 冻结）**：`coarse-touch-target` warn + 白名单，message 指向 DsButton / TouchTarget / coarseHit 三出口。
4. **批 4（可选 codemod）**：删除下沉后冗余的 `[@media(pointer:coarse)]:!min-h-11`（同值无害，不阻塞）。
5. translation / essay-grading 的私有 COARSE_HIT：参与常量上收（同档位直换），**不改行为**（r1 §6 有意折衷清单第 3 条）。

---

## 5. 红线自查

- 未建议任何散点 `!min-h-11`；机制（min-* + token）让 `!important` 失去存在必要，source 测试显式断言组件源码不含 `!min-h-11` / `!min-w-11` / 写死 44px。
- 伪元素 `after:-inset` 未作为默认：TouchTarget 源码零伪元素（测试锁定）；coarseHit 明示逃生舱身份 + 重叠风险 + z-index 仲裁先例。
- 禁改文件零触碰；未跑任何 npm/node/vitest；未 git commit。
- 有意折衷清单（r1 §6：MiniCalendar/TabBar 宽 28、FinderToolbar 40+48、`.touch-row` 48 等）未当新洞，不受本组件影响。
