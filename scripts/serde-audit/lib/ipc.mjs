// IPC result risk features from contracts/ipc (serialization-form schemas generated from Rust).
import fs from 'node:fs';
import path from 'node:path';

export function loadContracts(root) {
  const dir = path.join(root, 'contracts/ipc');
  const docs = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) docs[f] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  return docs;
}

function resolveRef(ref, base, docs) {
  const [file, pointer] = ref.split('#');
  const doc = file ? file.split('/').pop() : base;
  const name = pointer?.replace(/^\/\$defs\//, '');
  const schema = docs[doc]?.$defs?.[name];
  return schema ? { schema, base: doc, key: `${doc}#${name}` } : undefined;
}

/** Feature → example paths (max 6 each). */
export function contractFeatures(schema, base, docs) {
  const out = new Map();
  const add = (k, p) => { const l = out.get(k) ?? []; if (l.length < 6 && !l.includes(p || '$')) l.push(p || '$'); out.set(k, l); };
  const walk = (s, b, at, stack) => {
    if (!s || typeof s !== 'object') return;
    if (s.$ref) {
      const r = resolveRef(s.$ref, b, docs);
      if (r && !stack.includes(r.key) && stack.length < 12) walk(r.schema, r.base, at, [...stack, r.key]);
      return;
    }
    if (s['x-option'] === 'null') add('option-null', at);
    if (s['x-option'] === 'omit') add('option-omit', at);
    if (s['x-float'] === 'f32') add('f32', at);
    if (['u64', 'i64', 'usize', 'isize', 'u128', 'i128'].includes(s['x-int'])) add('bigint', at);
    if (s.format === 'date-time') add('chrono', at);
    if (s['x-key-order'] === 'unspecified') add('hashmap', at);
    for (const alt of [...(s.anyOf ?? []), ...(s.oneOf ?? []), ...(s.allOf ?? [])]) walk(alt, b, at, stack);
    if (s.items && typeof s.items === 'object') walk(s.items, b, `${at}[]`, stack);
    for (const [i, item] of (s.prefixItems ?? []).entries()) walk(item, b, `${at}[${i}]`, stack);
    for (const [k, p] of Object.entries(s.properties ?? {})) {
      if (!(s.required ?? []).includes(k) && p['x-option'] === undefined && p['x-skip-serializing-if']) add('option-omit', `${at}.${k}`);
      walk(p, b, `${at}.${k}`, stack);
    }
    if (s.additionalProperties && typeof s.additionalProperties === 'object') walk(s.additionalProperties, b, `${at}{}`, stack);
  };
  walk(schema, base, '', []);
  return out;
}

/** First host source location of each command name in quotes. */
export function hostRegistrations(names, sources) {
  const wanted = new Set(names);
  const found = new Map();
  const files = [...sources.keys()].sort();
  for (const file of files) {
    const text = typeof sources.get(file) === 'string' ? sources.get(file) : sources.get(file).text;
    const lines = text.split('\n');
    for (const [i, line] of lines.entries()) {
      for (const m of line.matchAll(/['"`]([a-z][a-z0-9_]+)['"`]/g)) {
        if (wanted.has(m[1]) && !found.has(m[1])) found.set(m[1], { file, line: i + 1 });
      }
    }
  }
  return found;
}

/** `[{command, lane, rust:{file,line}, features}]` for every command with a result schema. */
export function commandFeatures(docs) {
  const out = [];
  for (const [file, doc] of Object.entries(docs)) {
    for (const c of doc.commands ?? []) {
      if (!c.result) continue;
      out.push({ command: c.name, lane: c.lane ?? file.replace(/\.json$/, ''), contract: `contracts/ipc/${file}`, rust: c.rust, features: contractFeatures(c.result, file, docs) });
    }
  }
  return out;
}
