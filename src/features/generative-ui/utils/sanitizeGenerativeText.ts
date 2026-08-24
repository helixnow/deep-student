/**
 * 块文本 props 控制字符剥离。
 *
 * 模型偶发夹带 C0/C1（NUL、BS、DEL 等），会污染 DOM / 无障碍树。
 * 在 validateBlockProps 入口统一清洗字符串叶子，不改 schema 形状。
 * 保留 TAB / LF / CR，避免破坏正文换行与缩进。
 */

/** NUL–BS, VT, FF, SO–US, DEL, C1。用 fromCharCode 避免源码控制字符字面量。 */
const CONTROL_CHARS_RE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(0x0b)}${String.fromCharCode(0x0c)}${String.fromCharCode(0x0e)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}]`,
  'g',
);

export function sanitizeGenerativeText(value: string): string {
  if (typeof value !== 'string' || value.length === 0) return value;
  return value.replace(CONTROL_CHARS_RE, '');
}

/** 递归清洗 JSON 风格对象 / 数组的字符串叶子，其它类型原样返回。 */
export function sanitizeGenerativeTextLeaves<T>(value: T): T {
  return walkLeaves(value) as T;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function walkLeaves(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeGenerativeText(value);
  if (Array.isArray(value)) return value.map(walkLeaves);
  if (value !== null && typeof value === 'object' && isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = walkLeaves(child);
    }
    return out;
  }
  return value;
}
