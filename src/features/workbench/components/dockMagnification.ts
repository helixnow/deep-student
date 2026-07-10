/**
 * Dock 邻近放大纯函数（指针连续锚定）
 *
 * 离散「最近邻图标不动点」会在跨图标中点时让 anchorMid 跳变半个 extra，
 * 表现为扫过 Dock 时图标突然横跳。这里按指针在 rest 布局中的位置，
 * 连续累计其左侧扩张量，使 dx 随指针平滑变化。
 */

/**
 * 指针左侧的总扩张量（rest 坐标）。
 * - 整颗图标在指针左侧 → 计入全部 extra
 * - 指针落在图标 rest 宽度内 → 按穿过比例线性计入
 * - 整颗在右侧 → 0
 *
 * 指针恰在某图标中心时，结果 = prefix + extra/2，与旧离散公式在锚点处一致。
 */
export function dockMagLeftExpansion(
  pointerX: number,
  centers: ArrayLike<number>,
  widths: ArrayLike<number>,
  extras: ArrayLike<number>,
): number {
  const n = centers.length;
  let left = 0;
  for (let i = 0; i < n; i++) {
    const w = widths[i];
    const e = extras[i];
    if (!(w > 0) || !(e > 0)) {
      if (e > 0 && pointerX >= centers[i]) left += e;
      continue;
    }
    const half = w * 0.5;
    const leftEdge = centers[i] - half;
    const rightEdge = centers[i] + half;
    if (pointerX >= rightEdge) left += e;
    else if (pointerX > leftEdge) left += e * ((pointerX - leftEdge) / w);
  }
  return left;
}
