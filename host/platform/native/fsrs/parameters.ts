// fsrs-6.6.2/src/{model,inference,parameter_clipper}.rs.
// Scheduling (learning steps, fuzz, logical days) belongs to L15.
const f = Math.fround;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export const DEFAULT_PARAMETERS: readonly number[] = Object.freeze([
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001,
  1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014,
  1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
].map(f));

export function effectiveParameters(parameters: readonly number[]): number[] {
  const w = parameters.map(f);
  switch (w.length) {
    case 0: return [...DEFAULT_PARAMETERS];
    case 17:
      // f32 mul_add rounds once; multiplication by 2 or 3 fits exactly in f64.
      w[4] = f(w[5]! * 2 + w[4]!);
      w[5] = f(f(Math.log(f(w[5]! * 3 + 1))) / 3);
      w[6] = f(w[6]! + 0.5);
      w.push(0, 0, 0, 0.5);
      break;
    case 19: w.push(0, 0.5); break;
    case 21: break;
    default: return [...DEFAULT_PARAMETERS];
  }
  return w.every(Number.isFinite) ? w : [...DEFAULT_PARAMETERS];
}

export function forgettingCurveConstants(parameters: readonly number[]): [number, number] {
  const decay = -clamp(effectiveParameters(parameters)[20]!, f(0.1), f(0.8));
  return [decay, Math.pow(0.9, 1 / decay) - 1];
}
export function retrievability(elapsedDays: number, stability: number, decay: number, factor: number): number {
  if (stability <= 0 || !Number.isFinite(stability)) return 0;
  return Math.pow(1 + factor * Math.max(0, elapsedDays) / stability, decay);
}

