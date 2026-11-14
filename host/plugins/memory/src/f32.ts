/**
 * Rust `f32` wire formatting: values are rounded to f32, but serde_json (ryu) prints the
 * shortest decimal that round-trips to that f32, so `0.8f32` is `0.8` — not `0.800000011920929`.
 * Returning the shortest decimal as a JS number keeps JSON output identical to Rust.
 */
export function f32(value: number): number {
  if (!Number.isFinite(value)) return value;
  const rounded = Math.fround(value);
  if (rounded === 0) return 0;
  for (let precision = 1; precision <= 9; precision++) {
    const candidate = Number(rounded.toPrecision(precision));
    if (Math.fround(candidate) === rounded) return candidate;
  }
  return rounded;
}

/** Rust `i64 as f32`: one round-half-even step from the exact integer, never via an f64 rounding first. */
export function i64ToF32(value: bigint): number {
  const negative = value < 0n;
  let magnitude = negative ? -value : value;
  const bits = magnitude.toString(2).length;
  if (bits > 24) {
    const shift = BigInt(bits - 24);
    const kept = magnitude >> shift;
    const remainder = magnitude - (kept << shift);
    const half = 1n << (shift - 1n);
    magnitude = (remainder > half || (remainder === half && (kept & 1n) === 1n) ? kept + 1n : kept) << shift;
  }
  const result = Math.fround(Number(magnitude));
  return negative ? -result : result;
}
