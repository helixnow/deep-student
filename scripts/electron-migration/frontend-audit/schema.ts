import ts from 'typescript';

export type Schema = Record<string, any>;

/** JSON wire shape, not a TS pretty-print. Unknown/recursive types stay explicit. */
export function typeSchema(checker: ts.TypeChecker, type: ts.Type, at: ts.Node, depth = 0, seen = new Set<ts.Type>()): Schema {
  const label = checker.typeToString(type, at, ts.TypeFormatFlags.NoTruncation);
  const f = type.flags;
  if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) return { 'x-ts': label };
  if (f & ts.TypeFlags.Undefined) return { 'x-ts': 'undefined' };
  if (f & ts.TypeFlags.Null) return { type: 'null' };
  if (f & ts.TypeFlags.BooleanLike) return { type: 'boolean' };
  if (type.isUnion()) {
    const members = type.types.filter(t => !(t.flags & ts.TypeFlags.Undefined));
    const first = members[0];
    if (members.length === 1 && first) return typeSchema(checker, first, at, depth, seen);
    return { anyOf: members.map(t => typeSchema(checker, t, at, depth, seen)) };
  }
  if (f & ts.TypeFlags.StringLike) return { type: 'string', ...(type.isStringLiteral() ? { const: type.value } : {}) };
  if (f & ts.TypeFlags.NumberLike) return { type: 'number', ...(type.isNumberLiteral() ? { const: type.value } : {}) };
  if (depth >= 6 || seen.has(type)) return { 'x-ts': label, 'x-truncated': true };
  const next = new Set(seen).add(type);
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    const args = checker.getTypeArguments(type as ts.TypeReference);
    const first = args[0];
    return { type: 'array', items: args.length === 1 && first ? typeSchema(checker, first, at, depth + 1, next) : { anyOf: args.map(t => typeSchema(checker, t, at, depth + 1, next)) } };
  }
  if (f & ts.TypeFlags.Object || type.isIntersection()) {
    const properties: Record<string, Schema> = {};
    const required: string[] = [];
    for (const p of checker.getPropertiesOfType(type)) {
      if (p.flags & ts.SymbolFlags.Method) continue;
      const t = checker.getTypeOfSymbolAtLocation(p, at);
      properties[p.name] = typeSchema(checker, t, at, depth + 1, next);
      if (!(p.flags & ts.SymbolFlags.Optional) && !(t.flags & ts.TypeFlags.Undefined) && !(t.isUnion() && t.types.some(v => v.flags & ts.TypeFlags.Undefined))) required.push(p.name);
    }
    const index = checker.getIndexTypeOfType(type, ts.IndexKind.String);
    return { type: 'object', properties, required, ...(index ? { additionalProperties: typeSchema(checker, index, at, depth + 1, next), 'x-open': true } : {}) };
  }
  return { 'x-ts': label };
}

const schemaDocuments = new WeakMap<object, Schema>();

function rememberDocument(value: any, doc: Schema) {
  if (!value || typeof value !== 'object' || schemaDocuments.has(value)) return;
  schemaDocuments.set(value, doc);
  for (const child of Object.values(value)) rememberDocument(child, doc);
}

export function resolveSchema(schema: Schema, doc: Schema, documents: Map<string, Schema>, seen = new Set<Schema>()): Schema {
  if (!schema?.$ref) return schema ?? {};
  if (seen.has(schema)) return { 'x-unresolved': schema.$ref };
  seen.add(schema);
  doc = schemaDocuments.get(schema) ?? doc;
  const [file, fragment] = schema.$ref.split('#');
  const target = file ? documents.get(file.split('/').at(-1)) : doc;
  if (!target) return { 'x-unresolved': schema.$ref };
  let value: any = target;
  for (const part of (fragment ?? '').split('/').filter(Boolean)) value = value?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  if (!value) return { 'x-unresolved': schema.$ref };
  rememberDocument(value, target);
  return value.$ref ? resolveSchema(value, target, documents, seen) : value;
}

export interface ShapeProblem { path: string; reason: string }

/** Directional comparison: every value produced by source must fit target.
 * Unions are checked branch-by-branch; opaque schemas do not invent mismatches.
 */
export function compareShapes(source: Schema, target: Schema, path = '', deref: (s: Schema) => Schema = s => s, depth = 0): ShapeProblem[] {
  source = deref(source); target = deref(target);
  if (depth > 9 || !source || !target) return [];
  if (source.anyOf || source.oneOf) {
    // The contract is also a deserialization schema: Option accepts null on
    // input, but skip_serializing_if=None omits it on a Rust-produced event.
    // Apply x-option only on the producer side, never narrow accepted input.
    const branches = (source.anyOf ?? source.oneOf).filter((s: Schema) => !(source['x-option'] === 'omit' && s.type === 'null'));
    return branches.flatMap((s: Schema) => compareShapes(s, target, path, deref, depth + 1));
  }
  if (target.anyOf || target.oneOf) {
    const choices = (target.anyOf ?? target.oneOf).map((s: Schema) => compareShapes(source, s, path, deref, depth + 1));
    return choices.find((p: ShapeProblem[]) => !p.length) ?? choices.sort((a: any[], b: any[]) => a.length - b.length)[0] ?? [];
  }
  if (!source.type || !target.type) return [];
  const st = source.type === 'integer' ? 'number' : source.type;
  const tt = target.type === 'integer' ? 'number' : target.type;
  if (st !== tt) return [{ path, reason: `type ${source.type} -> ${target.type}` }];
  const out: ShapeProblem[] = [];
  if (st === 'object') {
    for (const key of target.required ?? []) {
      if (!Object.hasOwn(source.properties ?? {}, key) && !source['x-open'] && !source.additionalProperties) out.push({ path: `${path}.${key}`, reason: 'missing required field' });
      else if (Object.hasOwn(source.properties ?? {}, key) && !(source.required ?? []).includes(key)) out.push({ path: `${path}.${key}`, reason: 'field may be omitted by source' });
    }
    for (const [key, value] of Object.entries(source.properties ?? {})) {
      if (Object.hasOwn(target.properties ?? {}, key)) out.push(...compareShapes(value as Schema, target.properties[key], `${path}.${key}`, deref, depth + 1));
    }
  }
  if (st === 'array' && source.items && target.items) out.push(...compareShapes(source.items, target.items, `${path}[]`, deref, depth + 1));
  return out;
}
