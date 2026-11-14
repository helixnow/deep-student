/**
 * Rust `format!("{:.N}", x)`（`f64`）的逐字节对应。可移植叶子：不得导入 Node 模块。
 *
 * 与 `Number.prototype.toFixed` 的差别：
 * - 恰好落在中点时四舍六入五成双（`core::num::flt2dec::strategy::dragon::format_exact`，Rust 1.67 起），
 *   `toFixed` 取较大者：`0.125` → Rust `0.12`、`toFixed` `0.13`。中点按二进制值的精确十进制展开判断，
 *   `2.675`（实际是 2.67499999…）两边都是 `2.67`。
 * - 负数按绝对值舍入再加 `-`，结果为零也保留：`-0.125` → `-0.12`，`-0.0` → `-0.00`，`-1e-7` 保留 3 位 → `-0.000`。
 * - 不切换到指数形式，精度不设上限：`1e21` → `1000000000000000000000.00`。
 * - `NaN` → `NaN`，`±Infinity` → `inf` / `-inf`（精度不起作用）。
 *
 * `f32` 的值先过 `Math.fround`：它的精确值也能用 `f64` 表示，展开结果相同。
 */
export function formatRustFixed(value: number, precision: number): string {
  if (!Number.isSafeInteger(precision) || precision < 0) {
    throw new RangeError(`precision must be a non-negative safe integer, got ${precision}`);
  }
  if (Number.isNaN(value)) return 'NaN';
  const sign = value < 0 || Object.is(value, -0) ? '-' : '';
  if (!Number.isFinite(value)) return `${sign}inf`;
  const { digits, scale } = exactDecimal(Math.abs(value));
  let units: bigint;
  if (scale <= precision) {
    units = digits * 10n ** BigInt(precision - scale);
  } else {
    const divisor = 10n ** BigInt(scale - precision);
    units = digits / divisor;
    const twice = (digits % divisor) * 2n;
    if (twice > divisor || (twice === divisor && (units & 1n) === 1n)) units += 1n;
  }
  const text = units.toString().padStart(precision + 1, '0');
  if (precision === 0) return sign + text;
  return `${sign}${text.slice(0, -precision)}.${text.slice(-precision)}`;
}

/** 非负有限 `f64` 的精确值 `digits / 10^scale`。 */
function exactDecimal(value: number): { digits: bigint; scale: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const mantissa = biased === 0 ? fraction : fraction | (1n << 52n);
  const exponent = (biased === 0 ? 1 : biased) - 1075;
  if (exponent >= 0) return { digits: mantissa << BigInt(exponent), scale: 0 };
  return { digits: mantissa * 5n ** BigInt(-exponent), scale: -exponent };
}
