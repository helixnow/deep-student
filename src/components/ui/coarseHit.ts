/**
 * coarseHit —— coarse 指针伪元素扩区的唯一共享出口（0824 Wave2-C R3）
 *
 * 定位：逃生舱，不是默认手段。默认请用实体盒：
 * - 渲染 <button> → DsButton（coarse 保证在 buttonPrimitiveContract 下沉）；
 * - 非 button 热区 → TouchTarget（@/components/ui/TouchTarget）。
 * 仅当实体撑高会破坏硬布局约束（如 FinderToolbar 标题栏 40px、密排
 * 微控件行）时才允许伪元素扩区。
 *
 * 已知风险（wave2-C-r1/09-touch-44.md §2）：伪元素扩区不占布局空间，
 * 相邻扩区会互相覆盖，后渲染者盖前者；间距小于两侧外扩量之和时必须
 * 用 z-index 显式仲裁（先例：TabBar.tsx z-[1]）。
 *
 * 本文件取代各处私有 COARSE_HIT / coarseHitAreaClass 拷贝
 * （TranslationMain / SourcePanel / TargetPanel / ComparisonView /
 * essay-grading InputPanel / ComposerToolbar 三档），本轮只建出口，
 * 调用点迁移按 Wave2-C 批 1 节奏另行进行。
 *
 * 注意：类名必须保持完整字符串字面量（Tailwind JIT 静态提取），
 * 禁止用模板串拼 -inset 档位。
 */

/** 36px 视觉（h-9 图标钮）→ 44：两侧各外扩 4px */
export const coarseHitClassFor36 =
  "relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-1 [@media(pointer:coarse)]:after:content-['']";

/** 32px 视觉（h-8 图标钮）→ 44：两侧各外扩 6px */
export const coarseHitClassFor32 =
  "relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-1.5 [@media(pointer:coarse)]:after:content-['']";

/** 28px 视觉（h-7 推理触发器等）→ 44：两侧各外扩 8px */
export const coarseHitClassFor28 =
  "relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2 [@media(pointer:coarse)]:after:content-['']";

/** 24px 视觉（h-6 微控件）→ 44：两侧各外扩 10px */
export const coarseHitClassFor24 =
  "relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2.5 [@media(pointer:coarse)]:after:content-['']";

/**
 * 16px 角标钮（自身已 absolute 定位，故不带 relative）→ 44：
 * 两侧各外扩 14px。essay-grading COARSE_HIT_BADGE 同款。
 */
export const coarseHitClassForBadge16 =
  "[@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-3.5 [@media(pointer:coarse)]:after:content-['']";

/** 按视觉尺寸查档，供迁移时对照（键 = 控件视觉边长 px） */
export const coarseHitClassByVisualSize = {
  36: coarseHitClassFor36,
  32: coarseHitClassFor32,
  28: coarseHitClassFor28,
  24: coarseHitClassFor24,
} as const;

export type CoarseHitVisualSize = keyof typeof coarseHitClassByVisualSize;
