/** runtime_roots.rs:148–200: persisted serde records (not IPC input schemas). */
import type { AuthorizedRootRecord, RuntimeRootIdentity, SkillTrustRecord, WorkspaceRootRecord } from './runtime-roots.ts';

/** Node 24 raw JSON numbers retain Rust u64 settings/digest bytes above 2^53. */
export function encodeRuntimeRootRecord(value: object): string {
  const json = JSON as typeof JSON & { rawJSON(text: string): unknown };
  return JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? json.rawJSON(item.toString()) : item);
}

type Node = { start: number; end: number; value: null | boolean | string | number | Node[] | Entry[]; kind: 'null' | 'boolean' | 'string' | 'number' | 'seq' | 'map'; raw?: string };
type Entry = { key: string; keyEnd: number; value: Node };
interface ReadVisitor {
  container?(node: Node): void;
  key?(key: string, end: number): (() => Node) | undefined;
  item?(index: number): Node;
}

/** Retain token positions and duplicate keys, which JSON.parse alone discards. */
class RecordReader {
  private offset = 0;
  constructor(readonlyText: string) { this.text = readonlyText; }
  readonly text: string;

  error(message: string, offset: number): never {
    const prefix = this.text.slice(0, offset);
    const line = prefix.split('\n').length;
    const column = Buffer.byteLength(prefix.slice(prefix.lastIndexOf('\n') + 1));
    throw new Error(`${message} at line ${line} column ${column}`);
  }

  private whitespace(): void {
    while (/[ \n\r\t]/.test(this.text[this.offset] ?? '\0')) this.offset++;
  }

  private string(): string {
    const start = this.offset++;
    while (this.offset < this.text.length) {
      const c = this.text[this.offset++]!;
      if (c === '"') return JSON.parse(this.text.slice(start, this.offset)) as string;
      if (c.charCodeAt(0) < 32) this.error('control character (\\u0000-\\u001F) found while parsing a string', this.offset);
      if (c !== '\\') continue;
      const escape = this.text[this.offset++];
      if (escape === undefined) this.error('EOF while parsing a string', this.text.length);
      if (escape === 'u') {
        for (let i = 0; i < 4; i++) {
          const hex = this.text[this.offset++];
          if (hex === undefined) this.error('EOF while parsing a string', this.text.length);
          if (!/[0-9a-fA-F]/.test(hex)) this.error('invalid escape', this.offset);
        }
        const code = Number.parseInt(this.text.slice(this.offset - 4, this.offset), 16);
        if (code >= 0xdc00 && code <= 0xdfff) this.error('lone leading surrogate in hex escape', this.offset);
        if (code >= 0xd800 && code <= 0xdbff) {
          if (this.text.slice(this.offset, this.offset + 2) !== '\\u') this.error('unexpected end of hex escape', this.offset + 1);
          this.offset += 2;
          for (let i = 0; i < 4; i++) {
            const hex = this.text[this.offset++];
            if (hex === undefined) this.error('EOF while parsing a string', this.text.length);
            if (!/[0-9a-fA-F]/.test(hex)) this.error('invalid escape', this.offset);
          }
          const low = Number.parseInt(this.text.slice(this.offset - 4, this.offset), 16);
          if (low < 0xdc00 || low > 0xdfff) this.error('lone leading surrogate in hex escape', this.offset);
        }
      } else if (!'"\\/bfnrt'.includes(escape)) this.error('invalid escape', this.offset);
    }
    return this.error('EOF while parsing a string', this.offset);
  }

  read(visitor?: ReadVisitor): Node {
    this.whitespace();
    const start = this.offset;
    const c = this.text[this.offset];
    if (c === undefined) this.error('EOF while parsing a value', this.offset);
    if (c === '"') return { kind: 'string', start, value: this.string(), end: this.offset };
    if (c === '[' || c === '{') {
      visitor?.container?.({ start, end: start, kind: c === '[' ? 'seq' : 'map', value: [] });
      this.offset++;
      const close = c === '[' ? ']' : '}';
      const values: Node[] = [];
      const entries: Entry[] = [];
      this.whitespace();
      if (this.text[this.offset] !== close) {
        while (true) {
          if (c === '{') {
            if (this.text[this.offset] === undefined) this.error('EOF while parsing an object', this.offset);
            if (this.text[this.offset] !== '"') this.error('key must be a string', this.offset + 1);
            const key = this.string();
            const keyEnd = this.offset;
            const readValue = visitor?.key?.(key, keyEnd);
            this.whitespace();
            if (this.text[this.offset] !== ':') this.error(this.offset === this.text.length ? 'EOF while parsing an object' : "expected `:`", Math.min(this.offset + 1, this.text.length));
            this.offset++;
            entries.push({ key, keyEnd, value: readValue ? readValue() : this.read() });
          } else values.push(visitor?.item ? visitor.item(values.length) : this.read());
          this.whitespace();
          const next = this.text[this.offset];
          if (next === close) break;
          if (next === undefined) this.error(c === '[' ? 'EOF while parsing a list' : 'EOF while parsing an object', this.offset);
          if (next !== ',') this.error(c === '[' ? 'expected `,` or `]`' : 'expected `,` or `}`', this.offset + 1);
          this.offset++;
          this.whitespace();
          if (this.text[this.offset] === close) this.error('trailing comma', this.offset + 1);
        }
      }
      this.offset++;
      return { start, end: this.offset, kind: c === '[' ? 'seq' : 'map', value: c === '[' ? values : entries };
    }
    for (const [literal, value] of [['null', null], ['true', true], ['false', false]] as const) {
      if (c !== literal[0]) continue;
      for (const expected of literal) {
        const actual = this.text[this.offset++];
        if (actual === undefined) this.error('EOF while parsing a value', this.text.length);
        if (actual !== expected) this.error('expected ident', this.offset);
      }
      return { start, end: this.offset, kind: value === null ? 'null' : 'boolean', value };
    }
    if (c === '-' || /[0-9]/.test(c)) {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.text.slice(start));
      if (!match) this.error('invalid number', Math.min(start + 2, this.text.length));
      const raw = match[0];
      this.offset += raw.length;
      if (/[.eE0-9]/.test(this.text[this.offset] ?? '\0')) this.error('invalid number', this.offset + 1);
      return { start, end: this.offset, kind: 'number', value: Number(raw), raw };
    }
    return this.error('expected value', this.offset + 1);
  }

  finish(): void {
    this.whitespace();
    if (this.offset !== this.text.length) this.error('trailing characters', this.offset + 1);
  }

  invalid(node: Node, expected: string, position?: number): never {
    const value = node.kind === 'seq' ? 'sequence' : node.kind === 'map' ? 'map'
      : node.kind === 'string' ? `string ${JSON.stringify(node.value)}`
        : node.kind === 'number' ? `${/[.eE]/.test(node.raw!) ? 'floating point' : 'integer'} \`${node.raw}\``
          : node.kind === 'boolean' ? `boolean \`${node.value}\`` : 'null';
    return this.error(`invalid type: ${value}, expected ${expected}`, position ?? (node.kind === 'map' || node.kind === 'seq' ? node.start : node.end));
  }
}

type Field = { name: string; decode: (node: Node) => unknown; read?: () => Node; default?: () => unknown };

/** serde's visitor validates each field before requesting the next key/value. */
function readRecord(reader: RecordReader, name: string, fields: Field[]): Node {
  const seen = new Set<string>();
  const readField = (field: Field | undefined): Node => {
    const node = field?.read ? field.read() : reader.read();
    field?.decode(node);
    return node;
  };
  const node = reader.read({
    key(key, end) {
      const field = fields.find(value => value.name === key);
      if (!field) return undefined;
      if (seen.has(key)) reader.error(`duplicate field \`${key}\``, end);
      seen.add(key);
      return () => readField(field);
    },
    item: index => readField(fields[index]),
  });
  record(reader, node, name, fields);
  return node;
}

function record(reader: RecordReader, node: Node, name: string, fields: Field[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (node.kind === 'seq') {
    const values = node.value as Node[];
    for (const [index, field] of fields.entries()) {
      if (values[index]) result[field.name] = field.decode(values[index]!);
      else if (field.default) result[field.name] = field.default();
      else reader.error(`invalid length ${values.length}, expected struct ${name} with ${fields.length} elements`, node.end);
    }
    if (values.length > fields.length) reader.error('trailing characters', values[fields.length]!.start + 1);
  } else if (node.kind === 'map') {
    for (const entry of node.value as Entry[]) {
      const field = fields.find(value => value.name === entry.key);
      if (!field) continue;
      if (Object.hasOwn(result, field.name)) reader.error(`duplicate field \`${field.name}\``, entry.keyEnd);
      result[field.name] = field.decode(entry.value);
    }
    for (const field of fields) {
      if (Object.hasOwn(result, field.name)) continue;
      if (!field.default) reader.error(`missing field \`${field.name}\``, node.end);
      result[field.name] = field.default();
    }
  } else reader.invalid(node, `struct ${name}`);
  return Object.fromEntries(fields.map(field => [field.name, result[field.name]]));
}

function string(reader: RecordReader, node: Node, expected = 'a string'): string {
  if (node.kind !== 'string') reader.invalid(node, expected);
  return node.value as string;
}

function identity(reader: RecordReader, node: Node): RuntimeRootIdentity {
  if (node.kind !== 'map') reader.invalid(node, 'internally tagged enum RuntimeRootIdentity');
  const entries = node.value as Entry[];
  const tags = entries.filter(entry => entry.key === 'kind');
  if (tags.length === 0) reader.error('missing field `kind`', node.end);
  if (tags.length > 1) reader.error('duplicate field `kind`', tags[1]!.keyEnd);
  const kind = string(reader, tags[0]!.value);
  const uint = (bits: number) => (value: Node): number | bigint => {
    if (value.kind !== 'number') reader.invalid(value, `u${bits}`, node.end);
    if (!/^-?\d+$/.test(value.raw!)) reader.invalid(value, `u${bits}`, node.end);
    const parsed = BigInt(value.raw!);
    if (parsed < 0n || parsed >= 1n << BigInt(bits)) reader.error(`invalid value: integer \`${value.raw}\`, expected u${bits}`, node.end);
    return parsed > BigInt(Number.MAX_SAFE_INTEGER) ? parsed : Number(parsed);
  };
  const fields: Field[] = kind === 'unix' ? [{ name: 'device', decode: uint(64) }, { name: 'inode', decode: uint(64) }]
    : kind === 'windows' ? [{ name: 'volume_serial_number', decode: uint(32) }, { name: 'file_index', decode: uint(64) }]
      : kind === 'canonical_path' ? [{ name: 'path', decode: value => string(reader, value, 'path string') }]
        : reader.error(`unknown variant \`${kind}\`, expected one of \`unix\`, \`windows\`, \`canonical_path\``, tags[0]!.value.end);
  // serde buffers internally tagged content before decoding the variant fields.
  const value = record(reader, { ...node, value: entries.filter(entry => entry.key !== 'kind').map(entry => ({ ...entry, keyEnd: node.end, value: { ...entry.value, start: node.end, end: node.end } })) }, `RuntimeRootIdentity::${kind}`, fields);
  return { kind, ...value } as RuntimeRootIdentity;
}

function access(reader: RecordReader, node: Node): WorkspaceRootRecord['access'] {
  let variant = node;
  if (node.kind === 'map') {
    const entries = node.value as Entry[];
    if (entries.length === 0) reader.error('invalid value: map, expected map with a single key', node.end);
    const first = entries[0]!;
    variant = { kind: 'string', value: first.key, start: node.start + 1, end: first.keyEnd };
    const result = access(reader, variant);
    if (first.value.kind !== 'null') reader.invalid(first.value, 'unit');
    if (entries.length > 1) reader.error('expected value', first.value.end + 1);
    return result;
  }
  if (node.kind !== 'string') reader.invalid(node, 'string or map');
  const value = node.value as string;
  if (value !== 'read_only' && value !== 'read_write') reader.error(`unknown variant \`${value}\`, expected \`read_only\` or \`read_write\``, node.end);
  return value;
}

function fields(reader: RecordReader, kind: 'workspace' | 'authorized' | 'trust'): Field[] {
  const text = (name: string, expected = 'a string'): Field => ({
    name, decode: node => string(reader, node, expected),
    read: () => reader.read({ container: node => { reader.invalid(node, expected); } }),
  });
  const optionalIdentity: Field = { name: 'identity', decode: node => node.kind === 'null' ? null : identity(reader, node), default: () => null };
  if (kind === 'trust') return [text('skill_id'), text('canonical_path', 'path string'), { name: 'identity', decode: node => identity(reader, node) }, text('package_sha256'), text('trusted_at')];
  const common = [text('path', 'path string'), text('label')];
  return kind === 'workspace'
    ? [...common, { name: 'access', decode: node => access(reader, node), default: () => 'read_only' }, optionalIdentity]
    : [text('id'), ...common, optionalIdentity];
}

export function decodeWorkspaceRootRecord(raw: string): WorkspaceRootRecord {
  const reader = new RecordReader(raw);
  const schema = fields(reader, 'workspace');
  const value = record(reader, readRecord(reader, 'WorkspaceRootRecord', schema), 'WorkspaceRootRecord', schema);
  reader.finish();
  return value as unknown as WorkspaceRootRecord;
}

export function decodeAuthorizedRootRecords(raw: string): AuthorizedRootRecord[] {
  const reader = new RecordReader(raw);
  const schema = fields(reader, 'authorized');
  const node = reader.read({
    container: value => { if (value.kind !== 'seq') reader.invalid(value, 'a sequence'); },
    item: () => readRecord(reader, 'AuthorizedRootRecord', schema),
  });
  if (node.kind !== 'seq') reader.invalid(node, 'a sequence');
  const value = (node.value as Node[]).map(item => record(reader, item, 'AuthorizedRootRecord', schema) as unknown as AuthorizedRootRecord);
  reader.finish();
  return value;
}

export function decodeSkillTrustRecord(raw: string): SkillTrustRecord {
  const reader = new RecordReader(raw);
  const schema = fields(reader, 'trust');
  const value = record(reader, readRecord(reader, 'SkillTrustRecord', schema), 'SkillTrustRecord', schema);
  reader.finish();
  return value as unknown as SkillTrustRecord;
}
