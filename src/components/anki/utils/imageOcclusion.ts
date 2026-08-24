/**
 * 图像遮挡卡（Image Occlusion）最小渲染支持。
 *
 * 与 Rust 侧 `src-tauri/src/anki_image_occlusion.rs` 的 serde camelCase
 * 契约一一对应：`extra_fields["_occlusion"]` 存归一化 spec JSON
 * （`{imageRef, boxes:[{x,y,w,h,label,clozeIndex}]}`，坐标 0-1，原点左上角）。
 *
 * 本文件只做纯函数：解析 / 校验过滤 / 像素与百分比换算，
 * 供 `ImageOcclusionOverlay` 组件与后续导出预览复用。
 */

/** extra_fields 中遮挡协议字段的键名（与 Rust OCCLUSION_FIELD 常量一致）。 */
export const OCCLUSION_FIELD = '_occlusion';

/** 遮挡卡自动附带的 tag（与 Rust OCCLUSION_TAG 常量一致）。 */
export const OCCLUSION_TAG = 'image-occlusion';

export interface OcclusionBox {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  clozeIndex: number;
}

export interface OcclusionSpec {
  imageRef: string;
  boxes: OcclusionBox[];
}

/** 像素矩形（渲染边界产物，与 Rust to_pixel_boxes 语义一致）。 */
export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  clozeIndex: number;
}

const EPS = 1e-6;

/** 单盒几何合法性：归一化 0-1 且不越界、非退化。 */
function isBoxGeometryValid(b: unknown): b is Omit<OcclusionBox, 'label' | 'clozeIndex'> {
  if (typeof b !== 'object' || b === null) return false;
  const box = b as Record<string, unknown>;
  const nums = [box.x, box.y, box.w, box.h];
  if (!nums.every((v) => typeof v === 'number' && Number.isFinite(v))) return false;
  const { x, y, w, h } = box as { x: number; y: number; w: number; h: number };
  return x >= -EPS && y >= -EPS && w > 0 && h > 0 && x + w <= 1 + EPS && y + h <= 1 + EPS;
}

/**
 * 从卡片 extra_fields 解析遮挡 spec。
 *
 * 防御性解析：JSON 不合法 / 结构不对 → null；
 * 几何非法的盒被逐个过滤（渲染层永不画越界矩形），全部盒被过滤后返回 null。
 * 缺失 clozeIndex 的盒按顺序补 1-based 序号（与 Rust 校验器归一化一致）。
 */
export function parseOcclusionSpec(
  extraFields: Record<string, string> | undefined | null,
): OcclusionSpec | null {
  const raw = extraFields?.[OCCLUSION_FIELD];
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as { imageRef?: unknown; boxes?: unknown };
  if (typeof candidate.imageRef !== 'string' || candidate.imageRef.trim() === '') return null;
  if (!Array.isArray(candidate.boxes)) return null;

  let maxIndex = 0;
  for (const b of candidate.boxes) {
    const idx = (b as Record<string, unknown> | null)?.clozeIndex;
    if (typeof idx === 'number' && Number.isInteger(idx) && idx > maxIndex) maxIndex = idx;
  }

  const boxes: OcclusionBox[] = [];
  for (const b of candidate.boxes) {
    if (!isBoxGeometryValid(b)) continue;
    const rec = b as Record<string, unknown>;
    const explicit = rec.clozeIndex;
    const clozeIndex =
      typeof explicit === 'number' && Number.isInteger(explicit) && explicit >= 1
        ? explicit
        : ++maxIndex;
    const label =
      typeof rec.label === 'string' && rec.label.trim() !== ''
        ? rec.label.trim()
        : `区域 ${clozeIndex}`;
    boxes.push({ x: rec.x as number, y: rec.y as number, w: rec.w as number, h: rec.h as number, label, clozeIndex });
  }
  if (boxes.length === 0) return null;
  return { imageRef: candidate.imageRef, boxes };
}

/**
 * 归一化盒 → 像素矩形。与 Rust `to_pixel_boxes` 同一套保证：
 * 四舍五入、永不越界（右/下贴边收敛）、宽高最小 1px。
 * 图片尺寸为 0 时返回空数组。
 */
export function toPixelRects(spec: OcclusionSpec, imgW: number, imgH: number): PixelRect[] {
  if (!Number.isFinite(imgW) || !Number.isFinite(imgH) || imgW <= 0 || imgH <= 0) return [];
  const W = Math.floor(imgW);
  const H = Math.floor(imgH);
  if (W === 0 || H === 0) return [];
  return spec.boxes.map((b) => {
    const x = Math.min(Math.max(Math.round(b.x * W), 0), W - 1);
    const y = Math.min(Math.max(Math.round(b.y * H), 0), H - 1);
    const w = Math.min(Math.max(Math.round(b.w * W), 1), W - x);
    const h = Math.min(Math.max(Math.round(b.h * H), 1), H - y);
    return { x, y, w, h, label: b.label, clozeIndex: b.clozeIndex };
  });
}

/**
 * 归一化盒 → CSS 百分比定位样式（相对图片容器绝对定位）。
 * 百分比方案让遮挡层随图片响应式缩放，无需监听尺寸变化。
 */
export function occlusionBoxPercentStyle(box: OcclusionBox): {
  left: string;
  top: string;
  width: string;
  height: string;
} {
  const pct = (v: number) => `${(v * 100).toFixed(4)}%`;
  return {
    left: pct(box.x),
    top: pct(box.y),
    width: pct(box.w),
    height: pct(box.h),
  };
}

/** 卡片是否为遮挡卡（tag 或 _occlusion 字段任一命中）。 */
export function isOcclusionCard(
  tags: string[] | undefined | null,
  extraFields: Record<string, string> | undefined | null,
): boolean {
  if (tags?.includes(OCCLUSION_TAG)) return true;
  return Boolean(extraFields?.[OCCLUSION_FIELD]);
}
