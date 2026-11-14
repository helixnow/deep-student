/**
 * serde_json 1.0.149 `Number::from_f32` with `arbitrary_precision` calls
 * zmij 1.0.21 `format_finite(f32)`, rather than widening the binary f32 to f64.
 * Only the resulting JS numeric value is needed here, not zmij's JSON spelling.
 */

// Every f32 and its rounding midpoints are integers in units of 2^-150.
function units(bits: number): bigint {
  const exponent = bits >>> 23;
  const fraction = BigInt(bits & 0x7fffff);
  return exponent === 0 ? fraction << 1n : (0x800000n + fraction) << BigInt(exponent);
}

interface DecimalCandidate {
  coefficient: bigint;
  exponent: number;
  distance: bigint;
  denominator: bigint;
}

/**
 * 出站字段快照：先取 f32，再取最短 roundtrip 十进制并投影成 JS number。
 * 最短有效数字优先，其次距原二进制值最近，等距取偶数尾数（zmij/Schubfach）。
 * 保留 -0；NaN、Infinity 或窄化为 Infinity 的输入返回 null。
 * 不用于内部 f32 运算、f64 字段或未经批准的全局 JSON 替换。
 */
export function f32ToJsonNumber(value: number): number | null {
  const f32 = Math.fround(value);
  if (!Number.isFinite(f32)) return null;
  if (f32 === 0) return f32;

  const magnitude = Math.abs(f32);
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, magnitude);
  const bits = view.getUint32(0);
  const exact = units(bits);
  const lower = (exact + units(bits - 1)) / 2n;
  // For f32::MAX the hypothetical next value is 2^128 (units(0x7f800000)).
  const upper = (exact + units(bits + 1)) / 2n;
  const inclusive = (bits & 1) === 0; // IEEE nearest-even interval endpoints.
  const decade = Number(magnitude.toExponential().split('e')[1]);

  // Nine significant decimal digits always roundtrip an f32. Search exact
  // rational intervals, not toPrecision(): powers of two have asymmetric bounds.
  for (let digits = 1; digits <= 9; digits++) {
    let best: DecimalCandidate | undefined;
    const minCoefficient = 10n ** BigInt(digits - 1);
    const maxCoefficient = minCoefficient * 10n - 1n;
    // A rounding interval may cross a power of ten (notably subnormals).
    for (let exponent = decade - digits; exponent <= decade - digits + 2; exponent++) {
      const numerator = exponent >= 0 ? (10n ** BigInt(exponent)) << 150n : 1n << 150n;
      const denominator = exponent >= 0 ? 1n : 10n ** BigInt(-exponent);
      const lo = lower * denominator;
      const hi = upper * denominator;
      let first = inclusive ? (lo + numerator - 1n) / numerator : lo / numerator + 1n;
      let last = inclusive ? hi / numerator : (hi - 1n) / numerator;
      if (first < minCoefficient) first = minCoefficient;
      if (last > maxCoefficient) last = maxCoefficient;
      if (first > last) continue;

      const target = exact * denominator;
      let coefficient = target / numerator;
      const remainder = target % numerator;
      if (remainder * 2n > numerator || (remainder * 2n === numerator && coefficient % 2n !== 0n)) coefficient++;
      if (coefficient < first) coefficient = first;
      if (coefficient > last) coefficient = last;
      const delta = coefficient * numerator - target;
      const candidate = { coefficient, exponent, denominator, distance: delta < 0n ? -delta : delta };
      const difference = best === undefined ? -1n : candidate.distance * best.denominator - best.distance * candidate.denominator;
      if (difference < 0n || (difference === 0n && coefficient % 2n === 0n)) best = candidate;
    }
    if (best !== undefined) return (f32 < 0 ? -1 : 1) * Number(`${best.coefficient}e${best.exponent}`);
  }
  throw new Error('f32 shortest decimal not found'); // Unreachable for finite IEEE binary32.
}
