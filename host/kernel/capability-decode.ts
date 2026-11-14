/** tauri-utils 2.9.3 acl/{capability,identifier}.rs, acl::Scopes and platform::Target.
 * Shared value-level domain decoder for Host ACL and shell scopes. Lexical parsing belongs
 * to the caller; this does not invent from_str locations or recover duplicate JSON keys.
 */
import { oneOf, unexpectedOf } from './serde.ts';
import { JsonReader, JsonSyntaxError, jsonUnexpected, objectLastWins, parseJsonDocument, utf8ByteLength, type JsonNode } from '../platform/util/portable.ts';

export type CapabilityPlatform = 'macOS' | 'windows' | 'linux' | 'android' | 'iOS';
export type CapabilityPermission<Scope = unknown> = string | {
  identifier: string;
  /** Scopes are Option<Vec<Value>>; plugin-specific scope schemas belong to F2. */
  allow: Scope[] | null;
  deny: Scope[] | null;
};
export interface Capability<Scope = unknown> {
  identifier: string;
  description: string;
  remote: { urls: string[] } | null;
  local: boolean;
  windows: string[];
  webviews: string[];
  permissions: CapabilityPermission<Scope>[];
  platforms: CapabilityPlatform[] | null;
}
export class CapabilityDecodeError extends Error {
  readonly file: string;
  readonly path: string;
  readonly detail: string;
  constructor(file: string, path: string, detail: string) {
    super(`invalid capability ${file}${path ? ` at ${path}` : ''}: ${detail}`);
    this.name = 'CapabilityDecodeError';
    this.file = file; this.path = path; this.detail = detail;
  }
}

interface Site { file: string; path: string }
// Only an intermediate domain-error view. Successful capability fields are never numeric;
// opaque scopes keep F4 JsonNode values instead. This is not an IPC numeric representation.
class NumberValueView {
  readonly node: JsonNode & { kind: 'number' };
  constructor(node: JsonNode & { kind: 'number' }) { this.node = node; }
}
const at = (site: Site, key: string | number): Site => ({ file: site.file, path: `${site.path}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}` });
const fail = (site: Site, detail: string): never => { throw new CapabilityDecodeError(site.file, site.path, detail); };
const invalid = (site: Site, value: unknown, expected: string): never => fail(site, `invalid type: ${value instanceof NumberValueView || typeof value === 'bigint' ? 'number' : unexpectedOf(value)}, expected ${expected}`);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof NumberValueView);
const string = (value: unknown, site: Site): string => typeof value === 'string' ? value : invalid(site, value, 'a string');
function sequence(value: unknown, site: Site): unknown[] {
  return Array.isArray(value) ? value : invalid(site, value, 'a sequence');
}
function strings(value: unknown, site: Site): string[] {
  return sequence(value, site).map((item, index) => string(item, at(site, index)));
}

/** Derive's value visitor: present fields are decoded in input order; unknown fields ignored.
 * serde_json::Value also accepts the positional sequence form of a derived struct.
 */
function* fields(value: unknown, names: readonly string[], name: string, site: Site): Generator<[string, unknown, Site]> {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (i >= names.length) fail(site, `invalid length ${value.length}, expected fewer elements in array`);
      yield [names[i]!, value[i], at(site, i)];
    }
  } else if (object(value)) {
    for (const [key, item] of Object.entries(value)) yield [key, item, at(site, key)];
  } else invalid(site, value, `struct ${name}`);
}
function missing(value: unknown, field: string, name: string, count: number, site: Site): never {
  return fail(site, Array.isArray(value)
    ? `invalid length ${value.length}, expected struct ${name} with ${count} elements`
    : `missing field \`${field}\``);
}

const PLATFORMS: readonly CapabilityPlatform[] = ['macOS', 'windows', 'linux', 'android', 'iOS'];
function platform(value: unknown, site: Site): CapabilityPlatform {
  let variant: string;
  if (typeof value === 'string') variant = value;
  else if (object(value)) {
    const keys = Object.keys(value);
    if (keys.length !== 1) return fail(site, 'invalid value: map, expected map with a single key');
    variant = keys[0]!;
  } else return invalid(site, value, 'string or map');
  if (!PLATFORMS.some(p => p === variant)) return fail(site, `unknown variant \`${variant}\`, expected ${oneOf([...PLATFORMS])}`);
  if (object(value) && value[variant] !== null) return invalid(at(site, variant), value[variant], 'unit');
  return variant as CapabilityPlatform;
}

function identifier(value: unknown, site: Site): string {
  const raw = string(value, site);
  const bad = (reason: string): never => fail(site, `invalid plugin or permission identifier '${raw}': ${reason}`);
  if (raw.startsWith('tauri-plugin-')) return bad('identifiers cannot start with tauri-plugin-');
  if (!raw.length) return bad('identifiers cannot be empty');
  const bytes = utf8ByteLength(raw);
  if (bytes > 116) return bad(`identifiers cannot be longer than 116, found ${bytes}`);
  const format = () => bad('identifiers can only include lowercase ASCII, hyphens which are not leading or trailing, and a single colon if using a prefix');
  // Actual Rust uses is_ascii_alphanumeric (uppercase is valid despite its error wording).
  if (!/^[a-zA-Z0-9]/.test(raw)) return format();
  let separator = false;
  for (let i = 1; i < raw.length; i++) {
    const current = raw[i]!, previous = raw[i - 1]!;
    if (current === ':') {
      if (previous === '-') return format();
      // Preserve Rust's core-prefix special case and its u8 Display (':' == 58).
      if (separator && !raw.startsWith('core:')) return bad("identifiers can only include a single separator '58'");
      separator = true;
    } else if (!/^[a-zA-Z0-9-]$/.test(current) || (previous === ':' && current === '-')) return format();
  }
  if (raw.endsWith(':')) return bad('identifiers cannot have a prefix without a base');
  if (raw.endsWith('-')) return bad('identifiers cannot have a trailing hyphen');
  return raw;
}

function permission(value: unknown, site: Site): CapabilityPermission {
  if (typeof value === 'string') return identifier(value, site);
  if (!object(value)) return invalid(site, value, 'a string or map');
  let id: string | undefined;
  // #[serde(flatten)] buffers scope fields: decode identifier before replaying Scopes.
  for (const [key, item] of Object.entries(value)) if (key === 'identifier') id = identifier(item, at(site, key));
  if (id === undefined) return fail(site, 'missing field `identifier`');
  const result = { identifier: id, allow: null as unknown[] | null, deny: null as unknown[] | null };
  for (const [key, item] of Object.entries(value)) {
    if (key === 'allow' || key === 'deny') result[key] = item === null ? null : [...sequence(item, at(site, key))];
  }
  return result;
}
function remote(value: unknown, site: Site): Capability['remote'] {
  if (value === null) return null;
  let urls: string[] | undefined;
  for (const [key, item, child] of fields(value, ['urls'], 'CapabilityRemote', site)) {
    if (key === 'urls') urls = strings(item, child);
  }
  if (urls === undefined) return missing(value, 'urls', 'CapabilityRemote', 1, site);
  return { urls };
}

const CAPABILITY_FIELDS = ['identifier', 'description', 'remote', 'local', 'windows', 'webviews', 'permissions', 'platforms'];
function capability(value: unknown, site: Site): Capability {
  let id: string | undefined, permissions: CapabilityPermission[] | undefined;
  let description = '', local = true;
  let windows: string[] = [], webviews: string[] = [];
  let remoteValue: Capability['remote'] = null, platforms: CapabilityPlatform[] | null = null;
  for (const [key, item, child] of fields(value, CAPABILITY_FIELDS, 'Capability', site)) {
    switch (key) {
      case 'identifier': id = string(item, child); break;
      case 'description': description = string(item, child); break;
      case 'remote': remoteValue = remote(item, child); break;
      case 'local': local = typeof item === 'boolean' ? item : invalid(child, item, 'a boolean'); break;
      case 'windows': windows = strings(item, child); break;
      case 'webviews': webviews = strings(item, child); break;
      case 'permissions': permissions = sequence(item, child).map((entry, index) => permission(entry, at(child, index))); break;
      case 'platforms': platforms = item === null ? null : sequence(item, child).map((entry, index) => platform(entry, at(child, index))); break;
    }
  }
  if (id === undefined) return missing(value, 'identifier', 'Capability', 8, site);
  if (permissions === undefined) return missing(value, 'permissions', 'Capability', 8, site);
  // platforms is Option but has no #[serde(default)]: the positional sequence must include it.
  if (Array.isArray(value) && value.length < 8) return missing(value, 'platforms', 'Capability', 8, site);
  return { identifier: id, description, remote: remoteValue, local, windows, webviews, permissions, platforms };
}

/** CapabilityFile's map branch chooses NamedList when the capabilities key exists, even if
 * that value is invalid. Unknown fields are ignored, not used as fallback alternatives.
 */
export function decodeCapabilityFile(value: unknown, file = '<capability>'): Capability[] {
  const site = { file, path: '' };
  if (Array.isArray(value)) return value.map((entry, index) => capability(entry, at(site, index)));
  if (!object(value)) return invalid(site, value, 'an array or map');
  if (Object.hasOwn(value, 'capabilities')) {
    const child = at(site, 'capabilities');
    return sequence(value.capabilities, child).map((entry, index) => capability(entry, at(child, index)));
  }
  return [capability(value, site)];
}

function located<T>(site: Site, read: () => T): T {
  try { return read(); }
  catch (error) {
    if (error instanceof JsonSyntaxError) throw new CapabilityDecodeError(site.file, site.path, error.message);
    throw error;
  }
}

function valueView(node: JsonNode): unknown {
  switch (node.kind) {
    case 'null': return null;
    case 'bool': case 'string': return node.value;
    case 'number': return new NumberValueView(node);
    case 'array': return node.items.map(valueView);
    case 'object': return Object.fromEntries([...objectLastWins(node)].map(([key, child]) => [key, valueView(child)]));
  }
}

function permissionListView(node: JsonNode): unknown {
  if (node.kind !== 'array') return valueView(node);
  return node.items.map(entry => entry.kind !== 'object' ? valueView(entry)
    : Object.fromEntries([...objectLastWins(entry)].map(([key, child]) => [key,
      (key === 'allow' || key === 'deny') && child.kind === 'array' ? [...child.items] : valueView(child),
    ])));
}
function capabilityView(node: JsonNode): unknown {
  if (node.kind === 'array') return node.items.map((child, index) => index === 6 ? permissionListView(child) : valueView(child));
  if (node.kind !== 'object') return valueView(node);
  return Object.fromEntries([...objectLastWins(node)].map(([key, child]) => [key,
    key === 'permissions' ? permissionListView(child) : valueView(child),
  ]));
}
function fileView(node: JsonNode): unknown {
  if (node.kind !== 'object') return valueView(node);
  const members = objectLastWins(node);
  if (!members.has('capabilities')) return capabilityView(node);
  return Object.fromEntries([...members].map(([key, child]) => [key,
    key === 'capabilities' && child.kind === 'array' ? child.items.map(capabilityView) : valueView(child),
  ]));
}

function withPosition<T>(reader: JsonReader, decode: () => T): T {
  try { return decode(); }
  catch (error) {
    if (error instanceof CapabilityDecodeError) throw reader.error(error.detail);
    throw error;
  }
}

/** An enum's non-string/map token fails at peek position. JSON token starts are ASCII;
 * peekKind has already consumed whitespace/colon, and handles EOF/invalid starts itself.
 */
function expectedValue(reader: JsonReader): never {
  throw new JsonSyntaxError('expected value', reader.line, reader.column + 1);
}

function readTarget(reader: JsonReader, site: Site): CapabilityPlatform {
  const kind = reader.peekKind();
  if (kind === 'string') return withPosition(reader, () => platform(reader.readString('variant identifier'), site));
  if (kind !== 'object') return expectedValue(reader);
  reader.beginObject();
  const name = reader.readEnumVariant();
  const target = withPosition(reader, () => platform(name, site));
  reader.readNull('unit'); // de.rs VariantAccess::unit_variant delegates Deserialize<()>.
  reader.endEnumObject();
  return target;
}

function readArray<T>(reader: JsonReader, site: Site, read: (site: Site) => T): T[] {
  reader.beginArray();
  const values: T[] = [];
  while (reader.nextItem()) {
    const child = at(site, values.length);
    values.push(located(child, () => read(child)));
  }
  return values;
}

/** Returns positional length, or null for a map. The owner's callback reads each known
 * field immediately; duplicate checks happen before its value or later syntax is read.
 */
function readStruct(reader: JsonReader, names: readonly string[], name: string, site: Site, read: (key: string, site: Site) => void): number | null {
  if (reader.peekKind() === 'array') {
    reader.beginArray();
    for (let index = 0; index < names.length; index++) {
      if (!reader.nextItem()) return index;
      const child = at(site, index);
      located(child, () => read(names[index]!, child));
    }
    reader.endArray();
    return names.length;
  }
  reader.beginObject(`struct ${name}`);
  const seen = new Set<string>();
  for (let key = reader.nextKey(); key !== null; key = reader.nextKey()) {
    const child = at(site, key);
    // serde IgnoredAny, not Value: the public reader now supplies this exact path.
    if (!names.includes(key)) { located(child, () => reader.skipIgnoredValue()); continue; }
    if (seen.has(key)) throw reader.fieldError(`duplicate field \`${key}\``);
    seen.add(key);
    located(child, () => read(key, child));
  }
  return null;
}

function requiredRead(reader: JsonReader, length: number | null, key: string, name: string, fields: number): never {
  throw reader.error(length === null ? `missing field \`${key}\`` : `invalid length ${length}, expected struct ${name} with ${fields} elements`);
}

function readRemote(reader: JsonReader, site: Site): Capability['remote'] {
  if (reader.readOptionNone()) return null;
  let urls: string[] | undefined;
  const length = readStruct(reader, ['urls'], 'CapabilityRemote', site, (_key, child) => {
    urls = readArray(reader, child, () => reader.readString());
  });
  if (urls === undefined) return requiredRead(reader, length, 'urls', 'CapabilityRemote', 1);
  return { urls };
}

function readPermission(reader: JsonReader, site: Site): CapabilityPermission<JsonNode> {
  const kind = reader.peekKind();
  if (kind === 'string') return withPosition(reader, () => identifier(reader.readString(), site));
  if (kind !== 'object') throw reader.invalidType('a string or map');
  reader.beginObject();
  let id: string | undefined;
  const buffered: { key: string; value: JsonNode }[] = [];
  for (let key = reader.nextKey(); key !== null; key = reader.nextKey()) {
    if (key === 'identifier') {
      if (id !== undefined) throw reader.fieldError('duplicate field `identifier`');
      const child = at(site, key);
      id = located(child, () => withPosition(reader, () => identifier(reader.readString(), child)));
    } else {
      // ExtendedPermissionStruct uses flatten: buffer Content before decoding Scopes.
      buffered.push({ key, value: reader.readValue() });
    }
  }
  if (id === undefined) throw reader.error('missing field `identifier`');
  const result = { identifier: id, allow: null as JsonNode[] | null, deny: null as JsonNode[] | null };
  const seen = new Set<string>();
  for (const { key, value } of buffered) {
    if (key !== 'allow' && key !== 'deny') continue;
    if (seen.has(key)) throw reader.error(`duplicate field \`${key}\``);
    seen.add(key);
    if (value.kind === 'null') result[key] = null;
    else if (value.kind === 'array') result[key] = [...value.items];
    else throw reader.error(`invalid type: ${jsonUnexpected(value)}, expected a sequence`);
  }
  return result;
}

function readCapability(reader: JsonReader, site: Site): Capability<JsonNode> {
  let id: string | undefined, permissions: CapabilityPermission<JsonNode>[] | undefined;
  let description = '', local = true;
  let windows: string[] = [], webviews: string[] = [];
  let remoteValue: Capability['remote'] = null, platforms: CapabilityPlatform[] | null = null;
  const length = readStruct(reader, CAPABILITY_FIELDS, 'Capability', site, (key, child) => {
    switch (key) {
      case 'identifier': id = reader.readString(); break;
      case 'description': description = reader.readString(); break;
      case 'remote': remoteValue = readRemote(reader, child); break;
      case 'local': local = reader.readBool(); break;
      case 'windows': windows = readArray(reader, child, () => reader.readString()); break;
      case 'webviews': webviews = readArray(reader, child, () => reader.readString()); break;
      case 'permissions': permissions = readArray(reader, child, entry => readPermission(reader, entry)); break;
      case 'platforms': platforms = reader.readOptionNone() ? null : readArray(reader, child, entry => readTarget(reader, entry)); break;
    }
  });
  if (id === undefined) return requiredRead(reader, length, 'identifier', 'Capability', 8);
  if (permissions === undefined) return requiredRead(reader, length, 'permissions', 'Capability', 8);
  if (length !== null && length < 8) return requiredRead(reader, length, 'platforms', 'Capability', 8);
  return { identifier: id, description, remote: remoteValue, local, windows, webviews, permissions, platforms };
}

/** CapabilityFile's serde_untagged branches have different error priority: the top map
 * becomes a complete Value before from_value, while the top list reads typed capabilities.
 */
export function parseCapabilityFile(text: string, file = '<capability>'): Capability<JsonNode>[] {
  const site = { file, path: '' };
  return located(site, () => {
    const reader = new JsonReader(text);
    const kind = reader.peekKind();
    if (kind === 'object') {
      // permissionListView supplies actual JsonNode elements, and the validated domain
      // decoder preserves those opaque elements verbatim. No number becomes Infinity.
      return decodeCapabilityFile(fileView(parseJsonDocument(text)), file) as Capability<JsonNode>[];
    }
    if (kind !== 'array') {
      const node = reader.readValue();
      throw reader.error(`invalid type: ${jsonUnexpected(node)}, expected an array or map`);
    }
    const result = readArray(reader, site, child => readCapability(reader, child));
    reader.end();
    return result;
  });
}
