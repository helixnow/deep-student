import { describe, expect, it } from 'vitest';
import type { McpToolSchema } from '../../chat/api.ts';
import { headlessToolSchemas } from '../api.ts';

describe('public headlessToolSchemas for L04 worker execution', () => {
  it('publishes 33 uniquely named tool schemas', () => {
    const schemas = headlessToolSchemas();
    expect(schemas).toHaveLength(33);
    expect(new Set(schemas.map(schema => schema.name)).size).toBe(33);
  });

  it('is assignable to L04 McpToolSchema, omits serverId and survives JSON transport unchanged', () => {
    const schemas: McpToolSchema[] = headlessToolSchemas();
    for (const schema of schemas) {
      expect(Object.keys(schema)).toEqual(['name', 'description', 'inputSchema']);
      expect(Object.hasOwn(schema, 'serverId')).toBe(false);
    }
    expect(JSON.parse(JSON.stringify(schemas))).toStrictEqual(schemas);
  });

  it('returns fresh lists and nested schemas on every call', () => {
    const first = headlessToolSchemas();
    const second = headlessToolSchemas();
    const reference = structuredClone(second);
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    expect(first[0]!.inputSchema).not.toBe(second[0]!.inputSchema);
    const properties = first[0]!.inputSchema.properties;
    if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
      throw new Error('unified_search must have object properties');
    }
    Reflect.set(properties, 'query', { type: 'boolean' });
    first[0]!.name = 'caller-modified';
    first.pop();
    expect(second).toStrictEqual(reference);
    expect(headlessToolSchemas()).toStrictEqual(reference);
  });
});
