/**
 * Payloads shaped by the generated IPC contracts (`contracts/ipc/*.json`, derived from the Rust command signatures).
 *
 * `rustResult(cmd, overrides)` builds a complete result for `cmd`: every required field the Rust struct always
 * serializes, with `overrides` merged in (array items are completed the same way). `checkInvoke(cmd, args)` lists
 * argument keys the command does not declare, required arguments that are missing, and values of the wrong type.
 */
import fs from 'node:fs';
import path from 'node:path';

type Schema = Record<string, any>;
interface Arg { key: string; schema: Schema; optional: boolean }
interface Command { name: string; args: Arg[]; result: Schema }

const DIR = path.join(process.cwd(), 'contracts/ipc');
const files = new Map<string, { defs: Record<string, Schema>; commands: Command[] }>();
for (const name of fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()) {
  const json = JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
  files.set(name, { defs: json.$defs ?? {}, commands: json.commands ?? [] });
}
const commands = new Map<string, { file: string; command: Command }>();
for (const [file, { commands: list }] of files) {
  for (const command of list) {
    const seen = commands.get(command.name);
    if (seen) throw new Error(`${command.name} is declared in both contracts/ipc/${seen.file} and contracts/ipc/${file}`);
    commands.set(command.name, { file, command });
  }
}

function command(name: string) {
  const found = commands.get(name);
  if (!found) throw new Error(`${name} is not in contracts/ipc`);
  return found;
}

/** Follows `$ref` (same file or `_shared.json`) and returns the schema with the file its own refs resolve against. */
function resolve(schema: Schema, file: string): [Schema, string] {
  let current = schema;
  let at = file;
  while (current.$ref) {
    const [target, pointer] = String(current.$ref).split('#');
    if (target) at = target;
    const name = pointer.replace(/^\/\$defs\//, '');
    const def = files.get(at)?.defs[name];
    if (!def) throw new Error(`unresolved ${current.$ref} in ${file}`);
    current = def;
  }
  return [current, at];
}

const nullable = (schema: Schema) =>
  schema.type === 'null' || (Array.isArray(schema.type) && schema.type.includes('null'));

function example(raw: Schema, file: string): unknown {
  const [schema, at] = resolve(raw, file);
  if ('const' in schema) return schema.const;
  if (schema.enum) return schema.enum[0];
  const branches = schema.anyOf ?? schema.oneOf;
  if (branches) return branches.some(nullable) ? null : example(branches[0], at);
  const type = Array.isArray(schema.type) ? (schema.type.includes('null') ? 'null' : schema.type[0]) : schema.type;
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const key of schema.required ?? []) out[key] = example(schema.properties[key], at);
      return out;
    }
    case 'array': return [];
    case 'string': return '';
    case 'integer':
    case 'number': return 0;
    case 'boolean': return false;
    default: return null;
  }
}

function merge(raw: Schema, file: string, base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (override === null || typeof override !== 'object') return override;
  const [schema, at] = resolve(raw, file);
  const branches: Schema[] | undefined = schema.anyOf ?? schema.oneOf;
  if (branches) {
    const branch = branches.find((b) => !nullable(b)) ?? branches[0];
    return merge(branch, at, base ?? example(branch, at), override);
  }
  if (Array.isArray(override)) {
    return override.map((item) => (schema.items ? merge(schema.items, at, example(schema.items, at), item) : item));
  }
  const out: Record<string, unknown> = { ...((base as Record<string, unknown>) ?? {}) };
  for (const [key, value] of Object.entries(override)) {
    const prop = schema.properties?.[key] ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined);
    out[key] = prop ? merge(prop, at, out[key] ?? example(prop, at), value) : value;
  }
  return out;
}

const typeOf = (value: unknown) =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;

/** Problems with `value` against `raw`; empty when it conforms. Undeclared object keys count as problems. */
export function conform(raw: Schema, file: string, value: unknown, at = '$'): string[] {
  const [schema, sf] = resolve(raw, file);
  if ('const' in schema) return value === schema.const ? [] : [`${at}: expected ${JSON.stringify(schema.const)}`];
  if (schema.enum) return schema.enum.includes(value) ? [] : [`${at}: ${JSON.stringify(value)} not in enum`];
  const branches: Schema[] | undefined = schema.anyOf ?? schema.oneOf;
  if (branches) {
    const results = branches.map((b) => conform(b, sf, value, at));
    return results.some((r) => r.length === 0) ? [] : results.flat();
  }
  if (!schema.type) return [];
  const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = typeOf(value);
  if (!types.includes(actual) && !(actual === 'integer' && types.includes('number'))) {
    return [`${at}: expected ${types.join('|')}, got ${actual}`];
  }
  if (actual === 'array') return (value as unknown[]).flatMap((item, i) => (schema.items ? conform(schema.items, sf, item, `${at}[${i}]`) : []));
  if (actual !== 'object') return [];
  const record = value as Record<string, unknown>;
  const problems = (schema.required ?? [])
    .filter((key: string) => !(key in record))
    .map((key: string) => `${at}.${key}: required`);
  for (const [key, item] of Object.entries(record)) {
    const prop = schema.properties?.[key] ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined);
    if (prop) problems.push(...conform(prop, sf, item, `${at}.${key}`));
    else if (schema.properties || schema.additionalProperties === false) problems.push(`${at}.${key}: not declared`);
  }
  return problems;
}

/** A complete result of `cmd` as the Rust command serializes it, with `overrides` merged in. */
export function rustResult(cmd: string, overrides?: unknown): unknown {
  const { file, command: c } = command(cmd);
  const value = merge(c.result, file, example(c.result, file), overrides);
  const problems = conform(c.result, file, value);
  if (problems.length) throw new Error(`${cmd} fixture does not match the contract: ${problems.join('; ')}`);
  return value;
}

/** Argument problems for `invoke(cmd, args)`: undeclared keys, missing required ones, wrong value types. */
export function checkInvoke(cmd: string, args: Record<string, unknown> = {}): string[] {
  const found = commands.get(cmd);
  if (!found) return [`${cmd}: not in contracts/ipc`];
  const { file, command: c } = found;
  const declared = new Map(c.args.map((arg) => [arg.key, arg]));
  const problems = Object.keys(args).filter((key) => !declared.has(key)).map((key) => `${cmd}.${key}: not declared`);
  for (const arg of c.args) {
    if (!(arg.key in args)) {
      if (!arg.optional) problems.push(`${cmd}.${arg.key}: required`);
      continue;
    }
    problems.push(...conform(arg.schema, file, args[arg.key], `${cmd}.${arg.key}`));
  }
  return problems;
}
