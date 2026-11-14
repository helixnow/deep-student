// G3 normalization (g3-normalize.mjs): exactly parsed JSON values addressed by JSON pointer, and
// the (db, table) key, shared by the A1/A2 projection and the N-014 clock projection.
// Integers parse as bigint, other numbers as JSON.rawJSON (json.mjs parseExact).

export const MISSING = Symbol('missing');
export const isNumber = v => typeof v === 'bigint' || (v !== null && typeof v === 'object' && JSON.isRawJSON(v));
export const numberSource = v => typeof v === 'bigint' ? v.toString() : v.rawJSON;
export const kindOf = v => typeof v === 'string' ? 's' : isNumber(v) ? 'n' : v === null ? 'null' : typeof v;
export const escapeKey = key => String(key).replaceAll('~', '~0').replaceAll('/', '~1');
export const unescapeKey = key => key.replaceAll('~1', '/').replaceAll('~0', '~');

/** Leaves by JSON pointer, object keys sorted (key order is not a volatility source). */
export function leaves(value, pointer = '', out = new Map()) {
  if (value !== null && typeof value === 'object' && !JSON.isRawJSON(value)) {
    if (Array.isArray(value)) value.forEach((item, index) => leaves(item, `${pointer}/${index}`, out));
    else for (const key of Object.keys(value).sort()) leaves(value[key], `${pointer}/${escapeKey(key)}`, out);
  } else out.set(pointer, value);
  return out;
}

export function getAt(value, pointer) {
  for (const raw of pointer.split('/').slice(1)) {
    const key = unescapeKey(raw);
    if (value === null || typeof value !== 'object' || JSON.isRawJSON(value) || !Object.hasOwn(value, key)) return MISSING;
    value = value[key];
  }
  return value;
}

export function setAt(value, pointer, next) {
  if (pointer === '') return next;
  const [head, ...rest] = pointer.split('/').slice(1);
  const key = unescapeKey(head);
  const copy = Array.isArray(value) ? [...value] : { ...value };
  copy[key] = setAt(value[key], rest.length ? `/${rest.join('/')}` : '', next);
  return copy;
}

export const tableKey = (db, table) => `${db}\u0000${table}`;
