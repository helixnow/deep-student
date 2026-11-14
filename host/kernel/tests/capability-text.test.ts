import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CapabilityDecodeError, parseCapabilityFile } from '../api.ts';
import { CapabilityAcl } from '../acl.ts';

function failure(text: string): CapabilityDecodeError {
  try { parseCapabilityFile(text, 'cap.json'); throw new Error('accepted invalid capability'); }
  catch (error) { expect(error).toBeInstanceOf(CapabilityDecodeError); return error as CapabilityDecodeError; }
}

it('F1-DECODE-01 CapabilityFile map reads a complete Value before positionless domain decoding', () => {
  expect(failure('{"local":"yes"} trailing').detail).toMatch(/^trailing characters at line 1 column /);
  expect(failure('{"local":"yes"}').detail).toBe('invalid type: string "yes", expected a boolean');
  expect(parseCapabilityFile('{"identifier":"old","identifier":"new","permissions":[]}')[0]!.identifier).toBe('new');
  expect(parseCapabilityFile('{"capabilities":[{"identifier":"x","permissions":[]}]}')).toHaveLength(1);
});

it('F1-DECODE-01 typed list field and duplicate errors precede later malformed syntax', () => {
  expect(failure('[{"local":"x", ???}]').detail).toBe('invalid type: string "x", expected a boolean at line 1 column 13');
  const prefix = '[{"identifier":"first","identifier"';
  expect(failure(`${prefix}: ?}] trailing`).detail).toBe(`duplicate field \`identifier\` at line 1 column ${prefix.length}`);
  expect(failure('[{"identifier":"x"}]').detail).toBe('missing field `permissions` at line 1 column 19');
});

it('F1-DECODE-01 typed Target uses the real enum key/colon/closing reader seam', () => {
  const prefix = '[{"identifier":"本机","permissions":[],"platforms":[';
  const offset = Buffer.byteLength(prefix);
  expect(failure(`${prefix}{"linux":null , "windows":null}]}]`).detail).toBe(`expected value at line 1 column ${offset + 14}`);
  expect(failure(`${prefix}{"linux" null}]}]`).detail).toBe(`expected \`:\` at line 1 column ${offset + 10}`);
  expect(failure(`${prefix}{"linux":1}]}]`).detail).toBe(`invalid type: integer \`1\`, expected unit at line 1 column ${offset + 10}`);
  expect(parseCapabilityFile(`${prefix}"linux",{"windows":null}]}]`)[0]!.platforms).toEqual(['linux', 'windows']);
});

it('F1-DECODE-01 typed permission flatten buffers scopes without losing duplicate fields', () => {
  const prefix = '[{"identifier":"x","permissions":[{"allow":[],"allow":[],"identifier":"allow-app"}';
  expect(failure(`${prefix}]}]`).detail).toBe(`duplicate field \`allow\` at line 1 column ${prefix.length}`);
  const decoded = parseCapabilityFile('[{"identifier":"x","permissions":[{"identifier":"allow-app","allow":[9007199254740993,null],"deny":null}],"unknown":{"nested":[]}}]');
  expect(decoded[0]!.permissions).toEqual([{ identifier: 'allow-app', allow: [
    { kind: 'number', value: { kind: 'u64', value: 9007199254740993n, raw: '9007199254740993' } },
    { kind: 'null' },
  ], deny: null }]);
});

it('F1-DECODE-01 preserves arbitrary Value tokens and uses exact IgnoredAny for typed unknown fields', () => {
  // Opaque scope values remain F4 Value nodes, not JS Infinity or an IPC numeric class.
  const [cap] = parseCapabilityFile('{"identifier":"x","permissions":[{"identifier":"allow-app","allow":[1e400]}],"extension":1e400}');
  expect(cap!.permissions).toEqual([{ identifier: 'allow-app', allow: [
    { kind: 'number', value: { kind: 'arbitrary', raw: '1e400' } },
  ], deny: null }]);
  expect(parseCapabilityFile('[{"identifier":"x","permissions":[],"extension":1e400}]')[0]!.identifier).toBe('x');
});

it('F1-DECODE-01 fromDirectory consumes raw typed capabilities before real permission evaluation', () => {
  const root = mkdtempSync(join(tmpdir(), 'dstu-capability-text-'));
  mkdirSync(join(root, 'capabilities')); mkdirSync(join(root, 'permissions'));
  writeFileSync(join(root, 'permissions', 'app.toml'), '[[permission]]\nidentifier = "allow-app"\ncommands.allow = ["example"]\n');
  const file = join(root, 'capabilities', 'test.json');
  try {
    writeFileSync(file, '[{"identifier":"x","permissions":["allow-app"],"windows":["main"],"platforms":[{"linux":null}]}]');
    const acl = CapabilityAcl.fromDirectory('linux', root);
    expect(acl.denial('example', { window: 'main', webview: 'main' }, true)).toBeNull();
    expect(acl.denial('example', { window: 'main', webview: 'main', origin: 'https://remote.test' }, false)).toBe('Command example not allowed by ACL');
    writeFileSync(file, '[{"local":"x", ???}]');
    expect(() => CapabilityAcl.fromDirectory('linux', root)).toThrow('invalid type: string "x", expected a boolean at line 1 column 13');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
