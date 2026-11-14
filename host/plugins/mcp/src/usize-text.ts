// Rust unsigned str::parse::<usize>(), base 10 (not JSON number syntax).
// std/core num: optional '+', ASCII digits, checked multiply/add; ParseIntError Display.
// Electron desktop architectures are 64-bit except ia32/arm (other Node 32-bit ports listed too).
const ARCH_32 = ['ia32', 'arm', 'mips', 'mipsel', 'ppc', 's390'];
export const USIZE_BITS = ARCH_32.includes(process.arch) ? 32 : 64;
export const USIZE_MAX = (1n << BigInt(USIZE_BITS)) - 1n;

type IntegerError = 'Empty' | 'InvalidDigit' | 'PosOverflow';
export type UsizeTextResult = { ok: true; value: bigint } | { ok: false; kind: IntegerError };
export function usizeErrorMessage(kind: IntegerError): string {
  switch (kind) {
    case 'Empty': return 'cannot parse integer from empty string';
    case 'InvalidDigit': return 'invalid digit found in string';
    case 'PosOverflow': return 'number too large to fit in target type';
  }
}

/** No trim here: the two framing callers each apply their original Rust trim at the right stage. */
export function parseUsizeText(text: string): UsizeTextResult {
  if (text === '') return { ok: false, kind: 'Empty' };
  let index = text.startsWith('+') ? 1 : 0;
  if (index === text.length) return { ok: false, kind: 'InvalidDigit' };
  let value = 0n;
  for (; index < text.length; index += 1) {
    const digit = text.charCodeAt(index) - 0x30;
    // Rust checks the current digit before reporting this step's arithmetic overflow.
    if (digit < 0 || digit > 9) return { ok: false, kind: 'InvalidDigit' };
    value = value * 10n + BigInt(digit);
    if (value > USIZE_MAX) return { ok: false, kind: 'PosOverflow' };
  }
  return { ok: true, value };
}
