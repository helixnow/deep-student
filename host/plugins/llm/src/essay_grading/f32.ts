import { f32Atom, isNumberAtom } from '../../../../platform/serde-compat/index.ts';
import type { JsonNumberAtom } from '../../../../platform/serde-compat/api.ts';

/**
 * Rust `f32` 评分值的 JS 表示：内部以 `Math.fround` 做单精度运算，
 * 对外输出 serde_json 对 f32 的最短往返十进制表示（85.3 而非 85.30000305175781）。
 * 返回值经 `Math.fround` 仍得到同一个 f32，可安全参与后续 f32 运算。
 * 也接受 {@link f32Wire} 产生的线上原子（取回其数值）。
 */
export function f32Json(value: number | JsonNumberAtom): number {
  const single = Math.fround(isNumberAtom(value) ? Number(value.rawJSON) : value as number);
  if (!Number.isFinite(single) || single === 0) return single;
  for (let digits = 1; digits <= 9; digits += 1) {
    const candidate = Number(single.toPrecision(digits));
    if (Math.fround(candidate) === single) return candidate;
  }
  return single;
}

/** IPC / 事件出口的 f32：serde_json 拼写（`52.0`），经 {@link f32Json} 可取回数值。 */
export function f32Wire(value: number): JsonNumberAtom {
  return f32Atom(value);
}

type WireScore<T extends { overall_score: number | null }> = Omit<T, 'overall_score'> & { overall_score: number | JsonNumberAtom | null };

/** 命令回复出口：`overall_score: Option<f32>` 按 serde_json 拼写（`52.0`）。 */
export function gradingScoreToWire<T extends { overall_score: number | null }>(value: T): WireScore<T>;
export function gradingScoreToWire<T extends { overall_score: number | null }>(value: T | null): WireScore<T> | null;
export function gradingScoreToWire<T extends { overall_score: number | null }>(value: T | null): WireScore<T> | null {
  if (value === null || value.overall_score === null) return value;
  return { ...value, overall_score: f32Wire(value.overall_score) };
}

/** Rust `iter().map(..).sum::<f32>()`：逐项单精度累加。 */
export function f32Sum(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) sum = Math.fround(sum + Math.fround(value));
  return sum;
}
