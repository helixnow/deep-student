#!/usr/bin/env node
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { stringifyExact } from './json.mjs';

const documents = new Map();
for (const file of (await readdir('contracts/ipc')).filter(f => f.endsWith('.json')).sort()) {
  documents.set(file, JSON.parse(await readFile(`contracts/ipc/${file}`, 'utf8')));
}

// Candidate INPUTS only; never use a schema-generated value as a Rust expected output.
function withVariant(schema, variant) {
  const { anyOf, oneOf, allOf, ...base } = schema;
  return { ...base, ...variant,
    ...((base.properties || variant.properties) && { properties: { ...base.properties, ...variant.properties } }),
    ...((base.required || variant.required) && { required: [...new Set([...(base.required ?? []), ...(variant.required ?? [])])] }),
  };
}

function deref(schema, file, trail = []) {
  if (!schema || schema === true) return { schema: {}, file, trail };
  if (schema === false || schema['x-unresolved']) throw new Error(schema['x-unresolved'] ?? 'false schema');
  if (!schema.$ref) return { schema, file, trail };
  const [target, fragment] = schema.$ref.split('#');
  const next = target || file;
  const id = `${next}#${fragment}`;
  if (trail.includes(id)) throw new Error(`recursive required ref ${id}`);
  let value = documents.get(next);
  for (const key of (fragment ?? '').split('/').slice(1)) value = value?.[key.replaceAll('~1', '/').replaceAll('~0', '~')];
  if (!value) throw new Error(`unresolved ${id}`);
  return deref(value, next, [...trail, id]);
}

function sample(input, file, trail = []) {
  const resolved = deref(input, file, trail);
  const s = resolved.schema;
  file = resolved.file;
  trail = resolved.trail;
  if (Object.hasOwn(s, 'const')) return s.const;
  if (s.enum) return s.enum[0];
  if (s.anyOf || s.oneOf) {
    const failures = [];
    for (const variant of s.anyOf ?? s.oneOf) {
      try { return sample(withVariant(s, variant), file, trail); } catch (error) { failures.push(String(error)); }
    }
    throw new Error(failures.join('; '));
  }
  if (s.allOf) return Object.assign({}, ...s.allOf.map(part => sample(withVariant(s, part), file, trail)));
  switch (s.type) {
    case 'object': return Object.fromEntries((s.required ?? []).map(key => [key, sample(s.properties?.[key] ?? s.additionalProperties, file, trail)]));
    case 'array': return Array.isArray(s.items) ? s.items.map(item => sample(item, file, trail)) : [];
    case 'string': return s.format === 'date-time' ? '2026-11-04T00:00:00Z' : '';
    case 'integer': return s.minimum ?? 0;
    case 'number': return s.minimum ?? 0;
    case 'boolean': return false;
    case 'null': return null;
    default:
      if (s['x-rust'] === 'serde_json::Value' || Object.keys(s).length === 0) return null;
      throw new Error(`unsupported shape ${JSON.stringify(s)}`);
  }
}

const inventory = [];
for (const [file, document] of documents) for (const [name, schema] of Object.entries(document.$defs ?? {})) {
  const entry = { file, name, rust: schema['x-rust'] ?? null, status: 'inputs-only; dynamic-pending', cases: [] };
  inventory.push(entry);
  try {
    const base = sample(schema, file);
    entry.cases.push({ axis: 'baseline', input: base });
    if (base && typeof base === 'object' && !Array.isArray(base)) {
      entry.cases.push({ axis: 'unknown-field', input: { ...base, __differential_unknown: true } });
      for (const key of Object.keys(base)) {
        const omitted = { ...base }; delete omitted[key];
        entry.cases.push({ axis: `omit:${key}`, input: omitted });
        entry.cases.push({ axis: `null:${key}`, input: { ...base, [key]: null } });
        const property = deref(schema.properties?.[key] ?? {}, file).schema;
        if (['i64', 'u64', 'usize', 'isize'].includes(property['x-int'])) {
          for (const integer of [-9223372036854775809n, -9223372036854775808n, 9007199254740993n, 9223372036854775807n, 18446744073709551615n, 18446744073709551616n]) {
            entry.cases.push({ axis: `integer:${key}:${integer}`, input: { ...base, [key]: integer } });
          }
        }
      }
    }
    for (const variant of schema.enum ?? []) entry.cases.push({ axis: `enum:${variant}`, input: variant });
    for (const [index, variant] of (schema.oneOf ?? schema.anyOf ?? []).entries()) {
      entry.cases.push({ axis: `variant:${index}`, input: sample(withVariant(schema, variant), file) });
    }
  } catch (error) { entry.unresolved = String(error); }
}
await writeFile('fixtures/differential/serde-inputs.json', stringifyExact({ kind: 'candidate-inputs-not-golden', inventory }, 2) + '\n');
console.log(`serde input coverage: ${inventory.length} types, ${inventory.reduce((n, e) => n + e.cases.length, 0)} inputs, ${inventory.filter(e => e.unresolved).length} unresolved`);
