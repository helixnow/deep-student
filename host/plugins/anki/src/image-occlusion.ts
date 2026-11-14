/** Pure transformations from dstu-anki/src/anki_image_occlusion.rs. */
import { rustTrim } from '../../../platform/util/portable.ts';
export const OCCLUSION_FIELD = '_occlusion';
export const OCCLUSION_TAG = 'image-occlusion';
export const OCCLUSION_DRAFT_PREFIX = '[ANKI_OCCLUSION_DRAFT:';
export const OCCLUSION_BOXES_OPEN = '[OCCLUSION_BOXES]';
export const OCCLUSION_BOXES_CLOSE = '[/OCCLUSION_BOXES]';
const f = Math.fround;
const EPS = f(1e-6);
export interface OcclusionConfig { maxBoxes: number; minBoxSize: number; maxPairwiseIou: number; maxLabelChars: number }
export interface OcclusionBox { x: number; y: number; w: number; h: number; label: string; clozeIndex?: number | null }
export interface OcclusionSpec { imageRef: string; boxes: OcclusionBox[] }
export interface ValidatedOcclusionSpec extends OcclusionSpec {}
export interface OcclusionIssue { code: string; box_index?: number; message: string }
export interface PixelBox { x: number; y: number; w: number; h: number; label: string; clozeIndex: number }
export interface OcclusionCardFields { text: string; extraFields: Record<string, string>; tags: string[] }
export const defaultOcclusionConfig = (): OcclusionConfig => ({ maxBoxes: 12, minBoxSize: f(.01), maxPairwiseIou: f(.35), maxLabelChars: 48 });

// Rust's f32 Display / serde_json emits the shortest decimal that round-trips to f32.
function f32Decimal(value: number): string {
  value = f(value);
  if (!Number.isFinite(value)) return 'null';
  if (Object.is(value, -0)) return '-0.0';
  for (let digits = 1; digits <= 9; digits++) {
    const decimal = Number(value.toPrecision(digits));
    if (f(decimal) === value) return String(decimal);
  }
  return String(value);
}
const f32Display = (value: number) => f32Decimal(value).replace(/\.0$/, '');
function fixedEven(value: number, places: number): string {
  const scale = 10 ** places, scaled = value * scale, floor = Math.floor(scaled);
  const rounded = scaled - floor === .5 ? floor + floor % 2 : Math.round(scaled);
  return (rounded / scale).toFixed(places);
}
const floatBox = (b: OcclusionBox): OcclusionBox => ({ x: f(b.x), y: f(b.y), w: f(b.w), h: f(b.h), label: b.label, ...(b.clozeIndex == null ? {} : { clozeIndex: b.clozeIndex }) });

export function validateSpec(spec: OcclusionSpec, cfg = defaultOcclusionConfig()): { ok: true; value: ValidatedOcclusionSpec } | { ok: false; issues: OcclusionIssue[] } {
  const issues: OcclusionIssue[] = [];
  const specIssue = (code: string, message: string) => issues.push({ code, message });
  const boxed = (code: string, box_index: number, message: string) => issues.push({ code, box_index, message });
  if (!rustTrim(spec.imageRef)) specIssue('empty_image_ref', '图片引用为空：遮挡卡必须绑定一张图片');
  if (!spec.boxes.length) {
    specIssue('empty_boxes', '遮挡盒列表为空：至少需要 1 个遮挡区域');
    return { ok: false, issues };
  }
  if (spec.boxes.length > cfg.maxBoxes) specIssue('too_many_boxes', `遮挡盒数量 ${spec.boxes.length} 超过上限 ${cfg.maxBoxes}：请拆分为多张卡`);
  const boxes = spec.boxes.map(floatBox);
  for (const [i, b] of boxes.entries()) {
    if (![b.x, b.y, b.w, b.h].every(Number.isFinite)) { boxed('box_not_finite', i, `盒 #${i} 坐标含 NaN/Inf`); continue; }
    if (b.x < -EPS || b.y < -EPS || b.w <= 0 || b.h <= 0 || f(b.x + b.w) > f(1 + EPS) || f(b.y + b.h) > f(1 + EPS)) {
      boxed('box_out_of_bounds', i, `盒 #${i} 越界：x=${f32Display(b.x)} y=${f32Display(b.y)} w=${f32Display(b.w)} h=${f32Display(b.h)}（要求归一化 0-1 且 x+w/y+h ≤ 1）`);
    } else if (b.w < f(cfg.minBoxSize) || b.h < f(cfg.minBoxSize)) {
      boxed('box_too_small', i, `盒 #${i} 过小（w=${f32Display(b.w)} h=${f32Display(b.h)}，最小边长 ${f32Display(cfg.minBoxSize)}）：疑似空盒`);
    }
    if (b.clozeIndex === 0) boxed('cloze_index_zero', i, `盒 #${i} cloze 序号为 0：Anki cloze 序号从 1 开始`);
  }
  const geometryOk = boxes.map((_, i) => i).filter(i => !issues.some(iss => iss.box_index === i && (iss.code === 'box_out_of_bounds' || iss.code === 'box_not_finite')));
  for (let pos = 0; pos < geometryOk.length; pos++) {
    const a = geometryOk[pos]!;
    for (const b of geometryOk.slice(pos + 1)) {
      const iou = pairwiseIou(boxes[a]!, boxes[b]!);
      if (iou > f(cfg.maxPairwiseIou)) boxed('excessive_overlap', b, `盒 #${a} 与盒 #${b} 重叠过多（IoU=${fixedEven(iou, 2)} > ${f32Display(cfg.maxPairwiseIou)}）：遮挡区域应互不覆盖`);
    }
  }
  if (issues.length) return { ok: false, issues };
  let nextIndex = boxes.reduce((max, b) => Math.max(max, b.clozeIndex ?? 0), 0);
  return { ok: true, value: { imageRef: rustTrim(spec.imageRef), boxes: boxes.map(b => {
    const clozeIndex = b.clozeIndex ?? ++nextIndex;
    const trimmed = rustTrim(b.label);
    return { ...b, label: trimmed ? [...trimmed].slice(0, cfg.maxLabelChars).join('') : `区域 ${clozeIndex}`, clozeIndex };
  }) } };
}

export function pairwiseIou(a: OcclusionBox, b: OcclusionBox): number {
  a = floatBox(a); b = floatBox(b);
  if (a.w <= 0 || a.h <= 0 || b.w <= 0 || b.h <= 0) return 0;
  const ix = f(Math.min(f(a.x + a.w), f(b.x + b.w)) - Math.max(a.x, b.x));
  const iy = f(Math.min(f(a.y + a.h), f(b.y + b.h)) - Math.max(a.y, b.y));
  if (ix <= 0 || iy <= 0) return 0;
  const inter = f(ix * iy);
  const union = f(f(f(a.w * a.h) + f(b.w * b.h)) - inter);
  return union <= 0 ? 0 : f(inter / union);
}

export function toPixelBoxes(spec: ValidatedOcclusionSpec, imgW: number, imgH: number): PixelBox[] {
  if (!imgW || !imgH) return [];
  return spec.boxes.map(b => {
    const x = Math.min(imgW - 1, Math.max(0, Math.round(f(f(b.x) * f(imgW)))));
    const y = Math.min(imgH - 1, Math.max(0, Math.round(f(f(b.y) * f(imgH)))));
    const w = Math.min(imgW - x, Math.max(1, Math.round(f(f(b.w) * f(imgW)))));
    const h = Math.min(imgH - y, Math.max(1, Math.round(f(f(b.h) * f(imgH)))));
    return { x, y, w, h, label: b.label, clozeIndex: b.clozeIndex ?? 1 };
  });
}

export function serializeOcclusionSpec(spec: OcclusionSpec): string {
  const boxes = spec.boxes.map(b => {
    const coords = (['x', 'y', 'w', 'h'] as const).map(key => {
      const value = f32Decimal(b[key]);
      return `"${key}":${/^-?\d+$/.test(value) ? `${value}.0` : value}`;
    });
    coords.push(`"label":${JSON.stringify(b.label)}`);
    if (b.clozeIndex != null) coords.push(`"clozeIndex":${b.clozeIndex}`);
    return `{${coords.join(',')}}`;
  });
  return `{"imageRef":${JSON.stringify(spec.imageRef)},"boxes":[${boxes.join(',')}]}`;
}

export function buildCardFields(spec: ValidatedOcclusionSpec, imageFileName: string | null = null, extraNote: string | null = null): OcclusionCardFields {
  const clozeText = spec.boxes.map(b => `{{c${b.clozeIndex ?? 1}::${b.label.replaceAll('}}', '} }').replaceAll('::', '：：')}}}`).join(' ');
  const image = imageFileName === null ? undefined : rustTrim(imageFileName);
  const text = image ? `<img src="${image.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"><br>${clozeText}` : clozeText;
  const extraFields: Record<string, string> = { [OCCLUSION_FIELD]: serializeOcclusionSpec(spec) };
  const note = extraNote === null ? '' : rustTrim(extraNote);
  if (note) extraFields.Extra = note;
  return { text, extraFields, tags: [OCCLUSION_TAG] };
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function decodeBox(value: unknown): OcclusionBox | null {
  if (!object(value) || !(['x', 'y', 'w', 'h'] as const).every(key => typeof value[key] === 'number' && Number.isFinite(value[key]))) return null;
  if (value.label !== undefined && typeof value.label !== 'string') return null;
  if (value.clozeIndex != null && (typeof value.clozeIndex !== 'number' || !Number.isInteger(value.clozeIndex) || value.clozeIndex < 0 || value.clozeIndex > 0xffff_ffff)) return null;
  return floatBox({ x: value.x as number, y: value.y as number, w: value.w as number, h: value.h as number,
    label: value.label as string ?? '', ...(value.clozeIndex == null ? {} : { clozeIndex: value.clozeIndex as number }) });
}
function parseJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch (error) { if (error instanceof SyntaxError) return null; throw error; }
}
function decodeSpec(value: unknown): OcclusionSpec | null {
  if (!object(value) || typeof value.imageRef !== 'string' || !Array.isArray(value.boxes)) return null;
  const boxes = value.boxes.map(decodeBox);
  return boxes.some(b => b === null) ? null : { imageRef: value.imageRef, boxes: boxes as OcclusionBox[] };
}
export function parseOcclusionField(extra: Record<string, string>): OcclusionSpec | null {
  return extra[OCCLUSION_FIELD] === undefined ? null : decodeSpec(parseJson(extra[OCCLUSION_FIELD]));
}
export function occlusionImageRefFromFields(extra: Record<string, string>): string | null {
  const value = parseJson(extra[OCCLUSION_FIELD] ?? '');
  if (!object(value)) return null;
  const ref = Object.hasOwn(value, 'imageRef') ? value.imageRef : value.image_ref;
  if (typeof ref !== 'string') return null;
  const trimmed = rustTrim(ref);
  return trimmed && !trimmed.startsWith('vlm://') ? trimmed : null;
}

export function formatAnkiIoCloze(spec: ValidatedOcclusionSpec): string {
  const coord = (v: number) => fixedEven(Math.min(1, Math.max(0, f(v))), 4).replace(/0+$/, '').replace(/\.$/, '').replace(/^0\./, '.');
  return spec.boxes.map(b => `{{c${b.clozeIndex ?? 1}::image-occlusion:rect:left=${coord(b.x)}:top=${coord(b.y)}:width=${coord(b.w)}:height=${coord(b.h)}}}`).join('');
}

export function stripOcclusionBoxesBlocks(text: string): string {
  if (!text.includes(OCCLUSION_BOXES_OPEN)) return text;
  let out = '', remaining = text;
  while (remaining.includes(OCCLUSION_BOXES_OPEN)) {
    const open = remaining.indexOf(OCCLUSION_BOXES_OPEN);
    out += remaining.slice(0, open);
    const after = remaining.slice(open + OCCLUSION_BOXES_OPEN.length);
    const close = after.indexOf(OCCLUSION_BOXES_CLOSE);
    if (close < 0) { remaining = ''; break; }
    remaining = after.slice(close + OCCLUSION_BOXES_CLOSE.length);
  }
  return (out + remaining).trim();
}

function extractFirstJsonArray(text: string): string | null {
  let start = -1, depth = 0, inString = false, escaped = false;
  for (let idx = 0; idx < text.length; idx++) {
    const ch = text[idx];
    if (start < 0) { if (ch === '[') { start = idx; depth = 1; } continue; }
    if (inString) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue; }
    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']') { if (--depth === 0) return text.slice(start, idx + 1); }
  }
  return null;
}
function stripJsonTrailingCommas(json: string): string {
  let out = '', inString = false, escaped = false;
  for (let idx = 0; idx < json.length; idx++) {
    const ch = json[idx]!;
    if (inString) { out += ch; if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue; }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === ',' && /^[\s]*[\]}]/u.test(json.slice(idx + 1))) continue;
    out += ch;
  }
  return out;
}
export function parseOcclusionBoxesFromVlm(text: string): OcclusionSpec | null {
  let remaining = text;
  while (remaining.includes(OCCLUSION_BOXES_OPEN)) {
    const after = remaining.slice(remaining.indexOf(OCCLUSION_BOXES_OPEN) + OCCLUSION_BOXES_OPEN.length);
    const close = after.indexOf(OCCLUSION_BOXES_CLOSE);
    if (close < 0) break;
    const block = after.slice(0, close);
    remaining = after.slice(close + OCCLUSION_BOXES_CLOSE.length);
    const json = extractFirstJsonArray(block);
    if (!json) continue;
    const values = parseJson(stripJsonTrailingCommas(json));
    if (!Array.isArray(values)) continue;
    const boxes = values.map(decodeBox);
    if (boxes.some(b => b === null)) continue;
    const result = validateSpec({ imageRef: 'vlm://pending-image', boxes: boxes as OcclusionBox[] });
    if (result.ok) return result.value;
  }
  return null;
}

export function proposeBoxesFromImageDesc(desc: string, maxBoxes: number): OcclusionBox[] {
  if (maxBoxes === 0) return [];
  const segments: string[] = [];
  let searchFrom = 0;
  while (true) {
    const rel = desc.indexOf('[IMAGE_DESC:', searchFrom);
    if (rel < 0) break;
    const start = rel + '[IMAGE_DESC:'.length;
    const found = desc.indexOf(']', start), end = found < 0 ? desc.length : found;
    segments.push(desc.slice(start, end)); searchFrom = end;
    if (searchFrom >= desc.length) break;
  }
  if (!segments.length) segments.push(desc);
  const labels: string[] = [], seen = new Set<string>();
  outer: for (const segment of segments) for (const item of segment.split(/\n|;|；|、|：|→|->/u)) {
    let s = item.trim();
    for (const prefix of ['-', '*', '•', '·']) if (s.startsWith(prefix)) s = s.slice(prefix.length).trimStart();
    const chars = [...s]; let idx = 0;
    while (idx < chars.length && /[0-9().、 ]/u.test(chars[idx]!)) idx++;
    const stripped = idx > 0 && idx <= 4 && idx < chars.length ? chars.slice(idx).join('') : s;
    const cleaned = stripped.trim().replace(/[。\.，,]+$/u, '').trim();
    if ([...cleaned].length < 2 || seen.has(cleaned.toLowerCase())) continue;
    seen.add(cleaned.toLowerCase()); labels.push(cleaned);
    if (labels.length >= maxBoxes) break outer;
  }
  if (!labels.length) return [];
  const cols = Math.ceil(f(Math.sqrt(f(labels.length)))), rows = Math.ceil(labels.length / cols);
  const cellW = f(1 / f(cols)), cellH = f(1 / f(rows));
  const w = f(cellW * f(.72)), h = f(cellH * f(.72));
  return labels.map((label, i) => ({ x: f(f(f(i % cols) * cellW) + f(f(cellW - w) / 2)),
    y: f(f(f(Math.floor(i / cols)) * cellH) + f(f(cellH - h) / 2)), w, h, label, clozeIndex: i + 1 }));
}

export function buildOcclusionDraftMarker(imageRef: string, imageDesc: string, cfg = defaultOcclusionConfig()): string | null {
  const boxes = proposeBoxesFromImageDesc(imageDesc, cfg.maxBoxes);
  return boxes.length ? buildOcclusionDraftMarkerFromSpec({ imageRef, boxes }, cfg) : null;
}
export function buildOcclusionDraftMarkerFromSpec(spec: OcclusionSpec, cfg = defaultOcclusionConfig()): string | null {
  const result = validateSpec(spec, cfg);
  return result.ok ? `${OCCLUSION_DRAFT_PREFIX}${serializeOcclusionSpec(result.value)}]` : null;
}
function lines(content: string): string[] {
  if (!content) return [];
  const parts = content.split('\n');
  if (parts.at(-1) === '') parts.pop();
  return parts.map((line, i) => line.endsWith('\r') && (i < parts.length - 1 || content.endsWith('\n')) ? line.slice(0, -1) : line);
}
export function extractOcclusionDraftFields(content: string): OcclusionCardFields | null {
  const marker = lines(content).map(line => line.trim()).find(line => line.startsWith(OCCLUSION_DRAFT_PREFIX) && line.endsWith(']'));
  if (!marker) return null;
  const spec = decodeSpec(parseJson(marker.slice(OCCLUSION_DRAFT_PREFIX.length, -1)));
  if (!spec) return null;
  const result = validateSpec(spec);
  if (!result.ok) return null;
  const basename = result.value.imageRef.split(/[/\\]/u).at(-1)!.trim();
  return buildCardFields(result.value, basename || null);
}
export function stripOcclusionDraftMarkers(content: string): string {
  return lines(content).filter(line => !(line.trim().startsWith(OCCLUSION_DRAFT_PREFIX) && line.trim().endsWith(']'))).join('\n');
}
