/**
 * fsrs =6.6.2 训练器（`compute_parameters` / `FSRS::evaluate`），由 F7 `nativeFsrs`
 * 在 WASI 引擎中运行 crate 本身。本模块只做类型收窄与错误分类，不实现任何训练算法。
 */
import { FsrsError, type FsrsItem, type NativeFsrs } from '../../../platform/native/fsrs/api.ts';

/** fsrs-rs `FSRSItem`：一条样本 = 截至某次跨日复习的全部复习（`delta_t` 为逻辑日）。 */
export type FsrsTrainingItem = FsrsItem;

/** 服务所需的训练器能力（生产为 F7 `ctx.nativeFsrs`：桌面 WASI loader，移动端 `fsrs/web.ts`）。 */
export type FsrsTrainer = Pick<NativeFsrs, 'optimize' | 'evaluate'>;

/**
 * fsrs-rs `Result::Err(FSRSError)`：F7 抛 `FsrsError`，`message` 即 `{:?}`（变体名）。
 * 其余拒绝（引擎 trap / worker 故障）对应 Rust `spawn_blocking` 里的 panic。
 */
export function isFsrsEngineError(error: unknown): error is FsrsError {
  return error instanceof FsrsError;
}

// ---- f32 输出（Rust `Vec<f32>` / `f32` 字段） ----

/** 与 f32 值 round-trip 的最短十进制有效数字（ryu f2s 语义：最短，同长取最近）。 */
function shortestF32Digits(value: number): { digits: string; exponent: number } {
  for (let precision = 1; precision <= 9; precision++) {
    const [mantissa, exp] = value.toExponential(precision - 1).split('e') as [string, string];
    const base = BigInt(mantissa.replace('.', ''));
    const e = Number(exp) - (precision - 1); // value ≈ base × 10^e
    let best: { digits: bigint; distance: number } | null = null;
    for (const candidate of [base - 1n, base, base + 1n]) {
      if (candidate <= 0n) continue;
      const decimal = Number(`${candidate}e${e}`);
      if (Math.fround(decimal) !== value) continue;
      const distance = Math.abs(decimal - value);
      if (best === null || distance < best.distance) best = { digits: candidate, distance };
    }
    if (best !== null) {
      let digits = best.digits.toString();
      let exponent = e;
      while (digits.length > 1 && digits.endsWith('0')) { digits = digits.slice(0, -1); exponent += 1; }
      return { digits, exponent };
    }
  }
  throw new Error(`no shortest f32 representation for ${value}`);
}

/** serde_json(arbitrary_precision) 写 f32：`ryu::Buffer::format_finite(f32)` 文本。 */
export function ryuF32Text(input: number): string {
  const value = Math.fround(input);
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0';
  const sign = value < 0 ? '-' : '';
  const { digits, exponent: k } = shortestF32Digits(Math.abs(value));
  const length = digits.length;
  const kk = length + k; // 10^(kk-1) <= v < 10^kk
  let out: string;
  if (k >= 0 && kk <= 13) out = `${digits}${'0'.repeat(k)}.0`;
  else if (kk > 0 && kk <= 13) out = `${digits.slice(0, kk)}.${digits.slice(kk)}`;
  else if (kk > -6 && kk <= 0) out = `0.${'0'.repeat(-kk)}${digits}`;
  else if (length === 1) out = `${digits}e${kk - 1}`;
  else out = `${digits[0]}.${digits.slice(1)}e${kk - 1}`;
  return sign + out;
}

/** Rust f32 字段经 serde_json 到 wire 的 JS 数字：最短 round-trip 十进制。 */
export function f32Wire(input: number): number {
  return Number(ryuF32Text(input));
}

const rawJSON = (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON;

/** `serde_json::json!(f32)` 写入 config_json 的原样数字文本。 */
export function f32Json(input: number): unknown {
  return rawJSON(ryuF32Text(input));
}
