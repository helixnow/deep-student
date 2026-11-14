import { expect, it } from 'vitest';
import { ShellRuntime } from '../shell/runtime.ts';

// Without an explicit raw-source text field, these are ordinary typed numbers.
// Never infer raw provenance from Infinity, -0, or a property named rawJSON.
it('encodeBody keeps ordinary numeric normalization and rawJSON-shaped objects unchanged', () => {
  const projected: unknown = structuredClone(JSON.parse('{"values":[1e400,-1e400,-1e-400,-0,0,1.5],"ordinary":{"rawJSON":"1e400"},"__proto__":7}'));
  const body = ShellRuntime.encodeBody(projected);
  expect(body.kind).toBe('json');
  if (body.kind !== 'json') throw new Error('expected a JSON body');
  const result = JSON.parse(body.data);
  expect(result.values).toEqual([null, null, 0, 0, 0, 1.5]);
  expect(result.ordinary).toEqual({ rawJSON: '1e400' });
  expect(Object.hasOwn(result, '__proto__')).toBe(true);
  expect(result.__proto__).toBe(7);
  expect(Object.hasOwn(projected as object, '__proto__')).toBe(true);
});

it('encodeBody keeps ordinary root number and binary serialization semantics', () => {
  for (const [value, expected] of [[Infinity, null], [-Infinity, null], [-0, 0]] as const) {
    const body = ShellRuntime.encodeBody(value);
    if (body.kind !== 'json') throw new Error('expected a JSON body');
    expect(Object.is(JSON.parse(body.data), expected)).toBe(true);
  }
  expect(ShellRuntime.encodeBody(undefined)).toEqual({ kind: 'json', data: 'null' });
  expect(ShellRuntime.encodeBody({ value: NaN, missing: undefined })).toEqual({ kind: 'json', data: '{"value":null}' });
  const bytes = new Uint8Array([0, 255]);
  expect(ShellRuntime.encodeBody(bytes)).toEqual({ kind: 'raw', data: bytes });
  expect(ShellRuntime.encodeBody(bytes.buffer)).toEqual({ kind: 'raw', data: bytes });
});
