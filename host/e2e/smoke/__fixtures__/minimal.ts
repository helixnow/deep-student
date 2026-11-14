import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandContract, JsonSchema } from '../../../kernel/contract.ts';

/** Generate only required fields. The caller MUST validate with ContractSet before invoking. */
export class MinimalArguments {
  private docs = new Map<string, any>();

  constructor(directory: string) {
    for (const file of readdirSync(directory).filter(file => file.endsWith('.json'))) {
      this.docs.set(file, JSON.parse(readFileSync(join(directory, file), 'utf8')));
    }
  }

  value(schema: JsonSchema | boolean, file: string, depth = 0): unknown {
    if (depth > 40) throw new Error(`recursive required schema in ${file}`);
    if (schema === false) throw new Error('unsatisfiable schema');
    if (schema === true) return null;
    if (schema['x-unresolved']) throw new Error(`unresolved schema: ${schema['x-unresolved']}`);
    if (typeof schema.$ref === 'string') {
      const [target, fragment = ''] = schema.$ref.split('#');
      const nextFile = target || file;
      let node = this.docs.get(nextFile);
      for (const key of fragment.split('/').slice(1)) node = node?.[key.replaceAll('~1', '/').replaceAll('~0', '~')];
      if (node === undefined) throw new Error(`unresolved $ref ${schema.$ref} in ${file}`);
      return this.value(node, nextFile, depth + 1);
    }
    if ('const' in schema) return schema.const;
    if (Array.isArray(schema.enum)) return schema.enum[0];
    const alternatives = schema.anyOf ?? schema.oneOf;
    if (Array.isArray(alternatives)) {
      const nullable = alternatives.find(s => s.type === 'null');
      return this.value(nullable ?? alternatives[0], file, depth + 1);
    }
    // Serde aliases use allOf/anyOf containing only required keys; property types
    // remain on the parent. Merge those requirements instead of sampling in isolation.
    if (Array.isArray(schema.allOf)) {
      const required = new Set((schema.required ?? []) as string[]);
      for (const clause of schema.allOf) {
        const branch = clause.anyOf?.[0] ?? clause;
        for (const key of branch.required ?? []) required.add(key);
      }
      return this.value({ ...schema, allOf: undefined, required: [...required] }, file, depth + 1);
    }
    const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
    switch (type) {
      case 'null': return null;
      case 'boolean': return false;
      case 'string': return ''.padEnd(Number(schema.minLength ?? 0), 'a');
      case 'integer':
      case 'number': {
        let value = Math.max(0, Number(schema.minimum ?? 0));
        if (typeof schema.exclusiveMinimum === 'number') value = Math.max(value, schema.exclusiveMinimum + 1);
        if (typeof schema.maximum === 'number') value = Math.min(value, schema.maximum);
        return type === 'integer' ? Math.ceil(value) : value;
      }
      case 'array': {
        const prefix = (schema.prefixItems ?? []) as JsonSchema[];
        return Array.from({ length: Number(schema.minItems ?? 0) }, (_, i) =>
          this.value(prefix[i] ?? (schema.items as JsonSchema | boolean) ?? true, file, depth + 1));
      }
      case 'object': {
        const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
        return Object.fromEntries(((schema.required ?? []) as string[]).map(key =>
          [key, this.value(properties[key] ?? true, file, depth + 1)]));
      }
      default: return null; // serde_json::Value / deliberately unconstrained schema
    }
  }

  args(command: CommandContract & { file: string }): Record<string, unknown> {
    return Object.fromEntries(command.args.filter(arg => !arg.optional).map(arg =>
      [arg.key, this.value(arg.schema, command.file)]));
  }
}
