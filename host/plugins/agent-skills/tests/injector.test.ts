import { describe, expect, it } from 'vitest';
import { InMemoryToolSchemaRegistry, injectToolSchemas } from '../src/tools/injector.ts';

describe('injector.rs', () => {
  it('test_inject_tool_schemas_none', () => {
    const context = new Map<string, unknown>();
    const count = injectToolSchemas(null, context, new InMemoryToolSchemaRegistry());
    expect(count).toBe(0);
    expect(context.has('custom_tools')).toBe(false);
  });

  it('test_inject_tool_schemas_empty', () => {
    const context = new Map<string, unknown>();
    const count = injectToolSchemas([], context, new InMemoryToolSchemaRegistry());
    expect(count).toBe(0);
    expect(context.has('custom_tools')).toBe(false);
  });

  it('test_inject_tool_schemas_invalid', () => {
    const context = new Map<string, unknown>();
    const count = injectToolSchemas(['invalid_tool'], context, new InMemoryToolSchemaRegistry());
    expect(count).toBe(0);
  });

  it('injects selected schemas in request order and skips unknown ids', () => {
    const registry = new InMemoryToolSchemaRegistry()
      .register('a', { type: 'function', function: { name: 'a' } })
      .register('b', { type: 'function', function: { name: 'b' } });
    const context = new Map<string, unknown>();
    expect(injectToolSchemas(['b', 'missing', 'a'], context, registry)).toBe(2);
    expect(context.get('custom_tools')).toEqual([
      { type: 'function', function: { name: 'b' } },
      { type: 'function', function: { name: 'a' } },
    ]);
  });
});
