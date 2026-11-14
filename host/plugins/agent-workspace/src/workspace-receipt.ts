/** workspace_change_set.rs:18–48; serde_json::from_value (desktop arbitrary_precision). */
import { unexpectedOf } from '../../../kernel/api.ts';
import type { ChangeSet, MutationKind, MutationReceipt } from './workspace-change-set.ts';

type Receipt = MutationReceipt<number | bigint>;
const FIELDS = ['change_id', 'root_id', 'op', 'relative_path', 'destination_path', 'before_hash', 'after_hash', 'backup_ref', 'bytes'] as const;
const U64_MAX = 18_446_744_073_709_551_615n;

function invalid(value: unknown, expected: string): never {
  throw new Error(`invalid type: ${unexpectedOf(value)}, expected ${expected}`);
}
function string(value: unknown): string {
  return typeof value === 'string' ? value : invalid(value, 'a string');
}
function optionalString(value: unknown): string | undefined {
  return value == null ? undefined : string(value);
}
function required<T>(value: T | undefined, key: string): T {
  if (value === undefined) throw new Error(`missing field \`${key}\``);
  return value;
}

function unsigned(value: unknown): number | bigint {
  if (typeof value !== 'number' && typeof value !== 'bigint') return invalid(value, 'u64');
  // IPC numbers have the same decimal representation as JSON.stringify at the
  // frontend. Internal D3 bigint inputs never pass through Number.
  const text = typeof value === 'bigint' ? value.toString() : JSON.stringify(value);
  if (!/^\d+$/.test(text)) throw new Error('invalid number');
  const exact = BigInt(text);
  if (exact > U64_MAX) throw new Error('invalid number');
  return exact <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(exact) : exact;
}

function kind(value: unknown): MutationKind {
  let name: string;
  let payload: unknown = null;
  if (typeof value === 'string') name = value;
  else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length !== 1) throw new Error('invalid value: map, expected map with a single key');
    [name, payload] = entries[0]!;
  } else return invalid(value, 'string or map');
  if (name !== 'created' && name !== 'modified' && name !== 'moved' && name !== 'deleted') {
    throw new Error(`unknown variant \`${name}\`, expected one of \`created\`, \`modified\`, \`moved\`, \`deleted\``);
  }
  if (payload !== null) return invalid(payload, 'unit');
  return name;
}

/** serde derive visits present map values before checking missing fields. */
function visitStruct(raw: unknown, name: string, fields: readonly string[], field: (key: string, value: unknown) => void): void {
  if (Array.isArray(raw)) {
    for (let index = 0; index < fields.length; index++) {
      if (index === raw.length) throw new Error(`invalid length ${index}, expected struct ${name} with ${fields.length} elements`);
      field(fields[index]!, raw[index]);
    }
    if (raw.length > fields.length) throw new Error(`invalid length ${raw.length}, expected fewer elements in array`);
  } else if (raw !== null && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      // undefined object properties are omitted by the JSON wire boundary.
      if (value !== undefined) field(key, value);
    }
  } else invalid(raw, `struct ${name}`);
}

function receiptValue(raw: unknown): Receipt {
  let changeId: string | undefined, rootId: string | undefined, op: MutationKind | undefined;
  let relativePath: string | undefined, destinationPath: string | undefined;
  let beforeHash: string | undefined, afterHash: string | undefined, backupRef: string | undefined;
  let bytes: number | bigint | undefined;
  visitStruct(raw, 'MutationReceipt', FIELDS, (key, value) => {
    switch (key) {
      case 'change_id': changeId = string(value); break;
      case 'root_id': rootId = string(value); break;
      case 'op': op = kind(value); break;
      case 'relative_path': relativePath = string(value); break;
      case 'destination_path': destinationPath = optionalString(value); break;
      case 'before_hash': beforeHash = optionalString(value); break;
      case 'after_hash': afterHash = optionalString(value); break;
      case 'backup_ref': backupRef = optionalString(value); break;
      case 'bytes': bytes = unsigned(value); break;
    }
  });
  return {
    change_id: required(changeId, 'change_id'), root_id: required(rootId, 'root_id'),
    op: required(op, 'op'), relative_path: required(relativePath, 'relative_path'),
    ...(destinationPath === undefined ? {} : { destination_path: destinationPath }),
    ...(beforeHash === undefined ? {} : { before_hash: beforeHash }),
    ...(afterHash === undefined ? {} : { after_hash: afterHash }),
    ...(backupRef === undefined ? {} : { backup_ref: backupRef }),
    bytes: required(bytes, 'bytes'),
  };
}

export function parseMutationReceipt(raw: unknown): Receipt {
  try { return receiptValue(raw); }
  catch (error) { throw new Error(`Invalid workspace mutation receipt: ${error instanceof Error ? error.message : String(error)}`); }
}

export function parseChangeSet(raw: unknown): ChangeSet<number | bigint> {
  try {
    let id: string | undefined;
    let changes: Receipt[] | undefined;
    visitStruct(raw, 'ChangeSet', ['id', 'changes'], (key, value) => {
      if (key === 'id') id = string(value);
      else if (key === 'changes') {
        if (!Array.isArray(value)) return invalid(value, 'a sequence');
        changes = value.map(receiptValue);
      }
    });
    return { id: required(id, 'id'), changes: required(changes, 'changes') };
  } catch (error) { throw new Error(`Invalid workspace change set: ${error instanceof Error ? error.message : String(error)}`); }
}
