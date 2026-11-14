const TOO_SHORT = 'premature end of input';
const INVALID = 'input contains invalid characters';
const OUT_OF_RANGE = 'input is out of range';
const TOO_LONG = 'trailing input';

const MINUS_SIGN = [0xe2, 0x88, 0x92];

function isDigit(byte: number | undefined): byte is number {
  return byte !== undefined && byte >= 0x30 && byte <= 0x39;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * chrono 0.4.41 `DateTime::parse_from_rfc3339` 的 `ParseError` Display（datetime/mod.rs:1015-1022、
 * format/parse.rs:154-226、format/scan.rs、format/parsed.rs 的 set_* 与 to_datetime）；输入合法时返回 null。
 * 与 platform/time `parseRfc3339` 接受同一集合，扫描按 UTF-8 字节进行。
 */
export function chronoRfc3339Error(value: string): string | null {
  const bytes = new TextEncoder().encode(value);
  let at = 0;
  const fixed = (width: number): number | string => {
    if (bytes.length - at < width) return TOO_SHORT;
    let n = 0;
    for (let i = 0; i < width; i += 1) {
      const byte = bytes[at + i];
      if (!isDigit(byte)) return INVALID;
      n = n * 10 + byte - 0x30;
    }
    at += width;
    return n;
  };
  const char = (expected: number): string | null => {
    if (at >= bytes.length) return TOO_SHORT;
    if (bytes[at] !== expected) return INVALID;
    at += 1;
    return null;
  };
  const field = (width: number, min: number, max: number, separator: number | null): number | string => {
    if (separator !== null) {
      const error = char(separator);
      if (error !== null) return error;
    }
    const n = fixed(width);
    if (typeof n === 'string') return n;
    return n < min || n > max ? OUT_OF_RANGE : n;
  };

  const year = fixed(4);
  if (typeof year === 'string') return year;
  const month = field(2, 1, 12, 0x2d);
  if (typeof month === 'string') return month;
  const day = field(2, 1, 31, 0x2d);
  if (typeof day === 'string') return day;
  if (at >= bytes.length) return TOO_SHORT;
  if (bytes[at] !== 0x54 && bytes[at] !== 0x74 && bytes[at] !== 0x20) return INVALID;
  at += 1;
  for (const [separator, max] of [[null, 23], [0x3a, 59], [0x3a, 60]] as const) {
    const n = field(2, 0, max, separator);
    if (typeof n === 'string') return n;
  }
  if (bytes[at] === 0x2e) {
    at += 1;
    if (at >= bytes.length) return TOO_SHORT;
    if (!isDigit(bytes[at])) return INVALID;
    while (isDigit(bytes[at])) at += 1;
  }

  const zone = bytes[at];
  if (zone === 0x5a || zone === 0x7a) {
    at += 1;
  } else {
    if (zone === undefined) return TOO_SHORT;
    if (zone === 0x2b || zone === 0x2d) at += 1;
    else if (MINUS_SIGN.every((byte, i) => bytes[at + i] === byte)) at += MINUS_SIGN.length;
    else return INVALID;
    if (bytes.length - at < 2) return TOO_SHORT;
    if (!isDigit(bytes[at]) || !isDigit(bytes[at + 1])) return INVALID;
    const hours = (bytes[at]! - 0x30) * 10 + bytes[at + 1]! - 0x30;
    at += 2;
    const colon = char(0x3a);
    if (colon !== null) return colon;
    if (bytes.length - at < 2) return TOO_SHORT;
    const [m1, m2] = [bytes[at]!, bytes[at + 1]!];
    if (!isDigit(m1) || !isDigit(m2)) return INVALID;
    if (m1 >= 0x36) return OUT_OF_RANGE;
    at += 2;
    if (hours > 23) return OUT_OF_RANGE;
  }
  if (at < bytes.length) return TOO_LONG;
  return day > daysInMonth(year, month) ? OUT_OF_RANGE : null;
}
