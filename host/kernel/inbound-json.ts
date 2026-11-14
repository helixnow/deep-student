/** JSON-body Value → contract decoding. Lexing and arbitrary precision atoms are
 * owned by F4; this module only adapts JSON Schema and the typed handler values.
 */
import { jsonNumberToRawJSON, objectLastWins, parseJsonDocument, type JsonNode } from '../platform/util/portable.ts';
import type { JsonSchema } from './contract.ts';
import { isJsonNumberAtom, serdeCheck, type SchemaRefResolver } from './serde.ts';

export function parseInvokeJson(text: string): unknown {
  return valueOf(parseJsonDocument(text));
}

function valueOf(node: JsonNode): unknown {
  switch (node.kind) {
    case 'null': return null;
    case 'bool': case 'string': return node.value;
    case 'number': return jsonNumberToRawJSON(node.value);
    case 'array': return node.items.map(valueOf);
    case 'object': return Object.fromEntries([...objectLastWins(node)].map(([key, value]) => [key, valueOf(value)]));
  }
}

/** Compare decimal JSON tokens without rounding or expanding large exponents. */
function decimal(text: string): { sign: number; digits: string; order: bigint } {
  const [mantissa = '', exponent = '0'] = text.toLowerCase().split('e');
  const negative = mantissa.startsWith('-');
  const unsigned = negative ? mantissa.slice(1) : mantissa;
  const [whole = '', fraction = ''] = unsigned.split('.');
  const digits = (whole + fraction).replace(/^0+/, '').replace(/0+$/, '');
  if (!digits) return { sign: 0, digits: '', order: 0n };
  const significant = (whole + fraction).replace(/^0+/, '');
  return { sign: negative ? -1 : 1, digits, order: BigInt(exponent) - BigInt(fraction.length) + BigInt(significant.length) };
}
function compare(a: string, b: string): number {
  const x = decimal(a), y = decimal(b);
  if (x.sign !== y.sign) return Math.sign(x.sign - y.sign);
  if (!x.sign) return 0;
  if (x.order !== y.order) return (x.order < y.order ? -1 : 1) * x.sign;
  const length = Math.max(x.digits.length, y.digits.length);
  const xd = x.digits.padEnd(length, '0'), yd = y.digits.padEnd(length, '0');
  return (xd === yd ? 0 : xd < yd ? -1 : 1) * x.sign;
}

export function exactJsonType(type: string | string[], value: unknown): boolean {
  if (Array.isArray(type)) return type.some(t => exactJsonType(t, value));
  const numeric = typeof value === 'number' || isJsonNumberAtom(value);
  if (type === 'number') return numeric;
  if (type === 'integer') {
    if (isJsonNumberAtom(value)) {
      const n = decimal(value.rawJSON);
      return n.sign === 0 || n.order >= BigInt(n.digits.length);
    }
    return typeof value === 'number' && Number.isInteger(value);
  }
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value) && !numeric;
  if (type === 'array') return Array.isArray(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

export function exactNumberRules(schema: JsonSchema, value: unknown): boolean {
  if (!isJsonNumberAtom(value) && typeof value !== 'number') return true;
  if (schema['x-int'] && serdeCheck(schema, value, '', { resolve: () => undefined }).ok !== true) return false;
  const raw = isJsonNumberAtom(value) ? value.rawJSON : String(value);
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as const) {
    const bound = schema[key];
    if (typeof bound !== 'number') continue;
    const c = compare(raw, String(bound));
    if ((key === 'minimum' && c < 0) || (key === 'maximum' && c > 0)
      || (key === 'exclusiveMinimum' && c <= 0) || (key === 'exclusiveMaximum' && c >= 0)) return false;
  }
  return true;
}

/** Only schema-bearing keywords are traversed: defaults/enum/const are data. */
export function exactSchema(schema: JsonSchema | boolean): JsonSchema | boolean {
  if (typeof schema === 'boolean') return schema;
  const out: JsonSchema = { ...schema };
  if (schema.type !== undefined) { out['x-host-json-type'] = schema.type; delete out.type; }
  const numberRules: JsonSchema = {};
  for (const key of ['x-int', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
    if (schema[key] !== undefined) { numberRules[key] = schema[key]; delete out[key]; }
  }
  if (Object.keys(numberRules).length) out['x-host-number-rules'] = numberRules;
  for (const key of ['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas']) {
    if (schema[key] && typeof schema[key] === 'object') out[key] = Object.fromEntries(
      Object.entries(schema[key]).map(([name, sub]) => [name, exactSchema(sub as JsonSchema | boolean)]));
  }
  for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
    if (Array.isArray(schema[key])) out[key] = (schema[key] as (JsonSchema | boolean)[]).map(exactSchema);
  }
  for (const key of ['items', 'additionalProperties', 'unevaluatedProperties', 'contains', 'not', 'if', 'then', 'else', 'propertyNames']) {
    const sub = schema[key];
    if (typeof sub === 'boolean' || (sub !== null && typeof sub === 'object')) out[key] = exactSchema(sub as JsonSchema | boolean);
  }
  return out;
}

/**
 * Default view of untyped JSON (`serde_json::Value`, `{}`, `true` positions and `CallContext.payload`): exactly what
 * `JSON.parse` returns, every number a plain JS number. Lossless for invoke arguments: the frontend builds them with
 * `JSON.stringify`, so every number token is the shortest round-trip spelling of a double and re-serializes to the
 * same text. Plain values survive `structuredClone`, `postMessage`, `Number()` and spreading; atoms do not (V08-01).
 */
export function plainJsonValue(value: unknown): unknown {
  if (isJsonNumberAtom(value)) return Number(value.rawJSON);
  if (Array.isArray(value)) return value.map(plainJsonValue);
  if (value !== null && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, plainJsonValue(item)]));
  return value;
}

/** Opt-in exact view (`CallContext.exactPayload()`). Safe integral tokens become numbers;
 * other tokens remain F4 native numeric atoms, including 1.0 and 1e400. */
export function internalJsonValue(value: unknown): unknown {
  if (isJsonNumberAtom(value)) {
    if (/^-?\d+$/.test(value.rawJSON)) {
      const big = BigInt(value.rawJSON);
      if (big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(big);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(internalJsonValue);
  if (value !== null && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, internalJsonValue(item)]));
  return value;
}

/** Called only after the exact-aware validator succeeds. */
export function decodeContractValue(schema: JsonSchema | boolean, value: unknown, base: string,
  resolver: SchemaRefResolver, valid: (schema: JsonSchema | boolean, value: unknown, base: string) => boolean): unknown {
  if (typeof schema === 'boolean') return plainJsonValue(value);
  if (typeof schema.$ref === 'string') {
    const target = resolver.resolve(schema.$ref, base);
    if (target) return decodeContractValue(target.schema, value, target.base, resolver, valid);
  }
  const alternatives = (schema.anyOf ?? schema.oneOf) as (JsonSchema | boolean)[] | undefined;
  if (alternatives) {
    const branch = alternatives.find(branch => valid(branch, value, base));
    if (branch !== undefined) return decodeContractValue(branch, value, base, resolver, valid);
  }
  if (isJsonNumberAtom(value)) {
    if (schema['x-int']) {
      const big = BigInt(value.rawJSON);
      return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
    }
    if (schema['x-float']) {
      const number = Number(value.rawJSON);
      return schema['x-float'] === 'f32' ? Math.fround(number) : number;
    }
    return plainJsonValue(value);
  }
  if (Array.isArray(schema.allOf)) {
    // Decode in place structurally: a later flatten branch must not overwrite a
    // typed bigint from an earlier branch with its own unconstrained Value view.
    for (const branch of schema.allOf) value = decodeContractValue(branch as JsonSchema, value, base, resolver, valid);
  }
  if (Array.isArray(value)) {
    const tuple = schema.prefixItems as JsonSchema[] | undefined;
    return value.map((item, i) => decodeContractValue(tuple?.[i] ?? schema.items as JsonSchema | boolean ?? true, item, base, resolver, valid));
  }
  if (value !== null && typeof value === 'object') {
    const properties = schema.properties as Record<string, JsonSchema> | undefined;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      decodeContractValue(properties?.[key] ?? schema.additionalProperties as JsonSchema | boolean ?? true, item, base, resolver, valid)]));
  }
  return value;
}
