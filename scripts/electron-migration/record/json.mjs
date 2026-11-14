import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

/** Evidence file: sha256 is always over the stored bytes; gzip (by magic) is decoded for reading. */
export function readEvidence(file) {
  const bytes = readFileSync(file);
  const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  return { bytes, text: (gzip ? gunzipSync(bytes) : bytes).toString('utf8'), gzip };
}

/** Bytes to store for an evidence file; `.gz` names are gzip-compressed (deterministic header). */
export function evidenceBytes(file, text) {
  return file.endsWith('.gz') ? gzipSync(Buffer.from(text, 'utf8'), { level: 6 }) : Buffer.from(text, 'utf8');
}

// Preserve every JSON number token before JS Number can round it. Rust's
// serde_json::Value also accepts arbitrary-precision decimals/exponents.
export function parseExact(text) {
  return JSON.parse(text, (_key, value, context) => {
    if (typeof value === 'number') {
      if (/^-?\d+$/.test(context.source) && context.source !== '-0') return BigInt(context.source);
      return JSON.rawJSON(context.source);
    }
    return value;
  });
}

export function stringifyExact(value, space) {
  return JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? JSON.rawJSON(v.toString()) : v, space);
}

const pointer = (path, key) => `${path}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;

// Compare decimal value, not spelling (1 == 1.0 == 10e-1). Keep the exponent
// symbolic so even large exponents never allocate an expanded decimal string.
function numericKey(value) {
  const source = JSON.isRawJSON(value) ? value.rawJSON
    : typeof value === 'bigint' ? value.toString()
      : typeof value === 'number' && Number.isFinite(value) ? (Object.is(value, -0) ? '-0' : value.toString()) : null;
  if (source === null) return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match) return null;
  const fraction = match[3] ?? '';
  const digits = (match[2] + fraction).replace(/^0+/, '');
  if (digits === '') return match[1] + '0';
  const coefficient = digits.replace(/0+$/, '');
  const exponent = BigInt(match[4] ?? '0') - BigInt(fraction.length) + BigInt(digits.length - coefficient.length);
  return `${match[1]}${coefficient}e${exponent}`;
}

// Object order is not evidence (HashMap); array/event order and missing vs null are.
export function firstDifference(expected, actual, path = '') {
  if (Object.is(expected, actual)) return null;
  const expectedNumber = numericKey(expected), actualNumber = numericKey(actual);
  if (expectedNumber !== null || actualNumber !== null) {
    return expectedNumber === actualNumber ? null : { path, expected, actual };
  }
  if (expected === null || actual === null || typeof expected !== 'object' || typeof actual !== 'object') {
    return { path, expected, actual };
  }
  if (Array.isArray(expected) !== Array.isArray(actual)) return { path, expected, actual };
  if (Array.isArray(expected) && expected.length !== actual.length) {
    return { path: `${path}/length`, expected: expected.length, actual: actual.length };
  }
  if (Array.isArray(expected)) {
    for (let i = 0; i < expected.length; i++) {
      const difference = firstDifference(expected[i], actual[i], pointer(path, i));
      if (difference) return difference;
    }
    return null;
  }
  for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
    if (!Object.hasOwn(expected, key) || !Object.hasOwn(actual, key)) {
      return { path: pointer(path, key), expected: expected[key], actual: actual[key], missing: Object.hasOwn(expected, key) ? 'actual' : 'expected' };
    }
    const difference = firstDifference(expected[key], actual[key], pointer(path, key));
    if (difference) return difference;
  }
  return null;
}

// Only exact contract-declared JSON pointers may be masked. No guessed timestamp/ID keys.
export function normalize(value, volatile = []) {
  const result = parseExact(stringifyExact(value));
  for (const path of volatile) {
    if (!path.startsWith('/')) throw new Error(`volatile path must be a JSON pointer: ${path}`);
    const keys = path.slice(1).split('/').map(key => key.replaceAll('~1', '/').replaceAll('~0', '~'));
    let parent = result;
    for (const key of keys.slice(0, -1)) parent = parent?.[key];
    const last = keys.at(-1);
    if (parent && Object.hasOwn(parent, last)) parent[last] = '<volatile>';
  }
  return result;
}
