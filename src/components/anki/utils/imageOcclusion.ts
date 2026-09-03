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

/** 与后端默认 OcclusionConfig 一致，避免损坏数据一次挂载过多 DOM 节点。 */
export const MAX_OCCLUSION_BOXES = 12;
export const MAX_OCCLUSION_LABEL_CHARS = 48;

interface NormalizedBoxGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 单盒几何归一化：拒绝真正越界/非有限/退化值，并把浮点误差范围内的
 * -EPS / 1+EPS 收敛到严格 [0,1]，保证 CSS 层不会画出容器。
 */
function normalizeBoxGeometry(b: unknown): NormalizedBoxGeometry | null {
  if (typeof b !== 'object' || b === null) return null;
  const box = b as Record<string, unknown>;
  const nums = [box.x, box.y, box.w, box.h];
  if (!nums.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const { x, y, w, h } = box as { x: number; y: number; w: number; h: number };
  if (x < -EPS || y < -EPS || w <= 0 || h <= 0 || x + w > 1 + EPS || y + h > 1 + EPS) {
    return null;
  }
  const left = Math.max(0, Math.min(1, x));
  const top = Math.max(0, Math.min(1, y));
  const right = Math.max(0, Math.min(1, x + w));
  const bottom = Math.max(0, Math.min(1, y + h));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function truncateLabel(value: string): string {
  return Array.from(value).slice(0, MAX_OCCLUSION_LABEL_CHARS).join('');
}

function readExplicitClozeIndex(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
    ? value
    : null;
}

/**
 * 从弱类型对象归一化遮挡 spec。Overlay 也会调用此函数，避免调用方绕过
 * extra_fields JSON 解析后把越界/超量数据直接交给 DOM。
 */
function normalizeOcclusionSpecValue(raw: unknown): OcclusionSpec | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const candidate = raw as { imageRef?: unknown; boxes?: unknown };
  if (typeof candidate.imageRef !== 'string' || candidate.imageRef.trim() === '') return null;
  if (!Array.isArray(candidate.boxes)) return null;

  const accepted: Array<{
    geometry: NormalizedBoxGeometry;
    label: string;
    explicitIndex: number | null;
  }> = [];
  for (const item of candidate.boxes) {
    if (accepted.length >= MAX_OCCLUSION_BOXES) break;
    const geometry = normalizeBoxGeometry(item);
    if (!geometry) continue;
    const record = item as Record<string, unknown>;
    const hasExplicitIndex = record.clozeIndex !== undefined && record.clozeIndex !== null;
    const explicitIndex = readExplicitClozeIndex(record.clozeIndex);
    // 显式 0、非整数或超出安全整数范围与后端校验一样视为坏盒；仅缺失值才补号。
    if (hasExplicitIndex && explicitIndex === null) continue;
    accepted.push({
      geometry,
      label: typeof record.label === 'string' ? record.label.trim() : '',
      explicitIndex,
    });
  }
  if (accepted.length === 0) return null;

  const usedIndices = new Set(
    accepted.flatMap((box) => box.explicitIndex === null ? [] : [box.explicitIndex]),
  );
  const maxExplicitIndex = Math.max(0, ...usedIndices);
  let nextGeneratedIndex =
    maxExplicitIndex < Number.MAX_SAFE_INTEGER ? maxExplicitIndex + 1 : 1;
  const allocateIndex = (): number => {
    while (usedIndices.has(nextGeneratedIndex)) {
      nextGeneratedIndex =
        nextGeneratedIndex >= Number.MAX_SAFE_INTEGER ? 1 : nextGeneratedIndex + 1;
    }
    const allocated = nextGeneratedIndex;
    usedIndices.add(allocated);
    nextGeneratedIndex =
      allocated >= Number.MAX_SAFE_INTEGER ? 1 : allocated + 1;
    return allocated;
  };

  const boxes = accepted.map(({ geometry, label, explicitIndex }) => {
    const clozeIndex = explicitIndex ?? allocateIndex();
    return {
      ...geometry,
      label: label ? truncateLabel(label) : `区域 ${clozeIndex}`,
      clozeIndex,
    };
  });

  return { imageRef: candidate.imageRef.trim(), boxes };
}

export function normalizeOcclusionSpec(raw: unknown): OcclusionSpec | null {
  try {
    return normalizeOcclusionSpecValue(raw);
  } catch {
    // Overlay 是运行时边界；异常 getter / Proxy 等非 JSON 调用也必须安全降级。
    return null;
  }
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
  return normalizeOcclusionSpec(parsed);
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
  const geometry = normalizeBoxGeometry(box) ?? { x: 0, y: 0, w: 0, h: 0 };
  const pct = (v: number) => `${(v * 100).toFixed(4)}%`;
  return {
    left: pct(geometry.x),
    top: pct(geometry.y),
    width: pct(geometry.w),
    height: pct(geometry.h),
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
