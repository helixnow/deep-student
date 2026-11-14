import type { FailoverPolicy } from '../api.ts';
import { JsonReader } from '../../../platform/util/portable.ts';

/** FailoverPolicy with the original u64 fields kept exact until each consumer's clamp/narrowing. */
export type FailoverPolicyExact = Omit<FailoverPolicy, 'keyCooldownSecs' | 'rateLimitBackoffMs'>
  & { keyCooldownSecs: bigint; rateLimitBackoffMs: bigint };

const U64_MAX = (1n << 64n) - 1n;
/** routing.rs:55-76 declaration order (serde derive field and seq order). */
const FIELDS = ['enabled', 'autoDegradeChat', 'defaultFallbacks', 'taskFallbacks', 'purposeModels', 'keyCooldownSecs', 'rateLimitBackoffMs'] as const;

/** routing.rs:78-90. A new value is returned for every deserialization. */
export function defaultFailoverPolicy(): FailoverPolicy {
  return projectFailoverPolicy(defaultFailoverPolicyExact());
}

export function defaultFailoverPolicyExact(): FailoverPolicyExact {
  return {
    enabled: true, autoDegradeChat: false, defaultFallbacks: [], taskFallbacks: {},
    purposeModels: {}, keyCooldownSecs: 60n, rateLimitBackoffMs: 1500n,
  };
}

/** D3: u64 leaves the Host as a JSON number, the same projection the frontend applies to serde output. */
export function projectFailoverPolicy(policy: FailoverPolicyExact): FailoverPolicy {
  return { ...policy, keyCooldownSecs: Number(policy.keyCooldownSecs), rateLimitBackoffMs: Number(policy.rateLimitBackoffMs) };
}

function readStrings(r: JsonReader): string[] {
  r.beginArray();
  const out: string[] = [];
  while (r.nextItem()) out.push(r.readString());
  return out;
}

/** HashMap<String, V>: later duplicate keys replace earlier ones; keys are data properties. */
function readMap<V>(r: JsonReader, value: (r: JsonReader) => V): Record<string, V> {
  r.beginObject();
  const out = new Map<string, V>();
  for (let key = r.nextKey(); key !== null; key = r.nextKey()) out.set(key, value(r));
  return Object.fromEntries(out);
}

function readField(r: JsonReader, result: FailoverPolicyExact, field: typeof FIELDS[number]): void {
  switch (field) {
    case 'enabled': result.enabled = r.readBool(); break;
    case 'autoDegradeChat': result.autoDegradeChat = r.readBool(); break;
    case 'defaultFallbacks': result.defaultFallbacks = readStrings(r); break;
    case 'taskFallbacks': result.taskFallbacks = readMap(r, readStrings); break;
    case 'purposeModels': result.purposeModels = readMap(r, x => x.readString()); break;
    case 'keyCooldownSecs': result.keyCooldownSecs = r.readUnsigned('u64', U64_MAX); break;
    case 'rateLimitBackoffMs': result.rateLimitBackoffMs = r.readUnsigned('u64', U64_MAX); break;
  }
}

/**
 * serde_json::from_str::<FailoverPolicy> (routing.rs:53-76, `#[serde(default, rename_all = "camelCase")]`):
 * map or positional seq; missing fields from Default; unknown fields IgnoredAny; duplicate fields rejected.
 * Invalid stored policies are discarded by getFailoverPolicy, as in Rust.
 */
export function decodeFailoverPolicyExact(raw: string): FailoverPolicyExact {
  const r = new JsonReader(raw);
  const result = defaultFailoverPolicyExact();
  if (r.peekKind() === 'array') {
    r.beginArray();
    let closed = false;
    for (const field of FIELDS) {
      if (!r.nextItem()) { closed = true; break; }
      readField(r, result, field);
    }
    if (!closed) r.endArray();
  } else {
    r.beginObject('struct FailoverPolicy');
    const seen = new Set<string>();
    for (let key = r.nextKey(); key !== null; key = r.nextKey()) {
      const field = FIELDS.find(name => name === key);
      if (field === undefined) { r.skipIgnoredValue(); continue; }
      if (seen.has(field)) throw r.fieldError(`duplicate field \`${field}\``);
      seen.add(field);
      readField(r, result, field);
    }
  }
  r.end();
  return result;
}

export function decodeFailoverPolicy(raw: string): FailoverPolicy {
  return projectFailoverPolicy(decodeFailoverPolicyExact(raw));
}
