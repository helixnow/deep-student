import { Buffer } from 'node:buffer';

export const POSITION_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function integerLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 97 + 2;
  if (head >= 'A' && head <= 'Z') return 90 - head.charCodeAt(0) + 2;
  throw new Error('Invalid position integer head');
}

function integerPart(key: string): string {
  const length = integerLength(key[0] ?? '');
  if (key.length < length) throw new Error('Truncated position integer');
  return key.slice(0, length);
}

function validate(key: string): void {
  const integer = integerPart(key);
  if (!/^[0-9A-Za-z]+$/.test(key) || key === `A${'0'.repeat(26)}` || (key.length > integer.length && key.endsWith('0'))) {
    throw new Error('Invalid position key');
  }
}

function stepInteger(integer: string, direction: 1 | -1): string | null {
  const head = integer[0]!;
  const digits = integer.slice(1).split('');
  for (let i = digits.length - 1; i >= 0; i--) {
    const next = POSITION_DIGITS.indexOf(digits[i]!) + direction;
    if (next >= 0 && next < 62) {
      digits[i] = POSITION_DIGITS[next]!;
      return head + digits.join('');
    }
    digits[i] = direction === 1 ? '0' : 'z';
  }
  if ((direction === 1 && head === 'z') || (direction === -1 && head === 'A')) return null;
  if (direction === 1 && head === 'Z') return 'a0';
  if (direction === -1 && head === 'a') return 'Zz';
  const nextHead = String.fromCharCode(head.charCodeAt(0) + direction);
  return nextHead + (direction === 1 ? '0' : 'z').repeat(integerLength(nextHead) - 1);
}

/** Midpoint of fractional tails, where an absent lower digit is zero. */
function midpoint(left: string, right: string | null): string {
  if (right !== null && left >= right) throw new Error('Position bounds must increase');
  if (left.endsWith('0') || right?.endsWith('0')) throw new Error('Fraction has trailing zero');
  if (right !== null) {
    let shared = 0;
    while ((left[shared] ?? '0') === right[shared]) shared++;
    if (shared > 0) return right.slice(0, shared) + midpoint(left.slice(shared), right.slice(shared));
  }
  const lo = left.length ? POSITION_DIGITS.indexOf(left[0]!) : 0;
  const hi = right === null ? 62 : POSITION_DIGITS.indexOf(right[0]!);
  if (hi - lo > 1) return POSITION_DIGITS[Math.round((lo + hi) / 2)]!;
  if (right !== null && right.length > 1) return right[0]!;
  return POSITION_DIGITS[lo]! + midpoint(left.slice(1), null);
}

export function generatePositionKeyBetween(left: string | null, right: string | null): string {
  if (left !== null) validate(left);
  if (right !== null) validate(right);
  if (left !== null && right !== null && left >= right) throw new Error('Position bounds must increase');
  if (left === null) {
    if (right === null) return 'a0';
    const integer = integerPart(right);
    if (integer === `A${'0'.repeat(26)}`) return integer + midpoint('', right.slice(integer.length));
    if (integer < right) return integer;
    const previous = stepInteger(integer, -1);
    if (previous === null) throw new RangeError('Position integer underflow');
    return previous;
  }
  const leftInteger = integerPart(left);
  if (right === null) {
    return stepInteger(leftInteger, 1) ?? leftInteger + midpoint(left.slice(leftInteger.length), null);
  }
  const rightInteger = integerPart(right);
  if (leftInteger === rightInteger) return leftInteger + midpoint(left.slice(leftInteger.length), right.slice(rightInteger.length));
  const incremented = stepInteger(leftInteger, 1);
  if (incremented !== null && incremented < right) return incremented;
  return leftInteger + midpoint(left.slice(leftInteger.length), null);
}

export function comparePositionRecords(
  a: { positionKey: string; deviceId: string; id: string },
  b: { positionKey: string; deviceId: string; id: string },
): number {
  for (const key of ['positionKey', 'deviceId', 'id'] as const) {
    const result = Buffer.compare(Buffer.from(a[key], 'utf8'), Buffer.from(b[key], 'utf8'));
    if (result !== 0) return result;
  }
  return 0;
}

/** Caller applies both assignments atomically in its local transaction. */
export function splitTieGroupForInsertion(
  leftTieItem: { positionKey: string }, rightTieItem: { positionKey: string }, nextDistinctKey: string | null,
): { advancedRightKey: string; insertedMidKey: string } {
  if (leftTieItem.positionKey !== rightTieItem.positionKey) throw new Error('Items are not in the same tie group');
  const advancedRightKey = generatePositionKeyBetween(rightTieItem.positionKey, nextDistinctKey);
  return { advancedRightKey, insertedMidKey: generatePositionKeyBetween(leftTieItem.positionKey, advancedRightKey) };
}
