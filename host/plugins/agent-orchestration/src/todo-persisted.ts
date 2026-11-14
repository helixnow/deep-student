import { JsonReader } from '../../../platform/util/portable.ts';
import type { TodoStatus, TodoStep, TodoTimestamp } from './todo.ts';

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const STATUSES: readonly TodoStatus[] = ['pending', 'running', 'completed', 'failed', 'skipped'];
const FIELDS = ['id', 'description', 'status', 'result', 'createdAt', 'updatedAt'] as const;

export function todoTimestamp(value: bigint): TodoTimestamp {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value) : value;
}

function readTimestamp(r: JsonReader): TodoTimestamp {
  return todoTimestamp(r.readSigned('i64', I64_MIN, I64_MAX));
}

/** TodoStatus is a serde unit enum, accepting string or externally tagged map. */
function readStatus(r: JsonReader): TodoStatus {
  let variant: string;
  const map = r.peekKind() === 'object';
  if (map) {
    r.beginObject();
    variant = r.readEnumVariant();
  } else {
    variant = r.readString('string or map');
  }
  const status = STATUSES.find((allowed) => allowed === variant);
  if (status === undefined) {
    const message = `unknown variant \`${variant}\`, expected one of ${STATUSES.map((s) => `\`${s}\``).join(', ')}`;
    throw r.error(message);
  }
  if (map) {
    r.readNull();
    r.endEnumObject();
  }
  return status;
}

/** todo_executor.rs:79–96: all non-Option fields required; unknown fields ignored. */
function readStep(r: JsonReader): TodoStep {
  let id: string | undefined;
  let description: string | undefined;
  let status: TodoStatus | undefined;
  let result: string | null = null;
  let createdAt: TodoTimestamp | undefined;
  let updatedAt: TodoTimestamp | null = null;
  const seen = new Set<string>();
  const readField = (field: typeof FIELDS[number]): void => {
    switch (field) {
      case 'id': id = r.readString(); break;
      case 'description': description = r.readString(); break;
      case 'status': status = readStatus(r); break;
      case 'result': result = r.readOptionNone() ? null : r.readString(); break;
      case 'createdAt': createdAt = readTimestamp(r); break;
      case 'updatedAt': updatedAt = r.readOptionNone() ? null : readTimestamp(r); break;
    }
  };
  if (r.peekKind() === 'array') {
    // serde derive also accepts positional struct sequences; Option fields still occupy a slot.
    r.beginArray();
    for (let i = 0; i < FIELDS.length; i++) {
      if (!r.nextItem()) throw r.error(`invalid length ${i}, expected struct TodoStep with 6 elements`);
      readField(FIELDS[i]!);
    }
    if (r.nextItem()) throw r.error('trailing characters');
  } else {
    r.beginObject('struct TodoStep');
    for (let key = r.nextKey(); key !== null; key = r.nextKey()) {
      const field = FIELDS.find((name) => name === key);
      if (field === undefined) { r.skipValue(); continue; }
      if (seen.has(field)) throw r.fieldError(`duplicate field \`${field}\``);
      seen.add(field);
      readField(field);
    }
  }
  // serde missing_field supplies None for Option, but never defaults TodoStatus from its Default impl.
  if (id === undefined) throw r.error('missing field `id`');
  if (description === undefined) throw r.error('missing field `description`');
  if (status === undefined) throw r.error('missing field `status`');
  if (createdAt === undefined) throw r.error('missing field `createdAt`');
  return { id, description, status, result, createdAt, updatedAt };
}

/** A Rust i64 field: exact integer in range; JS numbers are converted without rounding. */
export function todoTimestampI64(value: TodoTimestamp): bigint {
  const exact = typeof value === 'bigint' ? value : Number.isInteger(value) ? BigInt(value) : null;
  if (exact === null || exact < I64_MIN || exact > I64_MAX) throw new Error(`invalid value: \`${String(value)}\`, expected i64`);
  return exact;
}

/**
 * serde_json::to_string(&Vec<TodoStep>) (todo_executor.rs:79–96, 232–233): compact, declaration
 * order, camelCase, `result`/`updatedAt` skipped when None, i64 as exact digits (bigint included).
 */
export function encodePersistedTodoSteps(steps: readonly TodoStep[]): string {
  return `[${steps.map((step) => {
    if (!STATUSES.includes(step.status)) throw new Error(`unknown variant \`${String(step.status)}\``);
    let out = `{"id":${JSON.stringify(step.id)},"description":${JSON.stringify(step.description)}`
      + `,"status":"${step.status}"`;
    if (step.result !== null) out += `,"result":${JSON.stringify(step.result)}`;
    out += `,"createdAt":${todoTimestampI64(step.createdAt)}`;
    if (step.updatedAt !== null) out += `,"updatedAt":${todoTimestampI64(step.updatedAt)}`;
    return `${out}}`;
  }).join(',')}]`;
}

/** serde_json::from_str::<Vec<TodoStep>>, not JSON.parse followed by a type assertion. */
export function decodePersistedTodoSteps(text: string): TodoStep[] {
  const r = new JsonReader(text);
  r.beginArray();
  const steps: TodoStep[] = [];
  while (r.nextItem()) steps.push(readStep(r));
  r.end();
  return steps;
}
