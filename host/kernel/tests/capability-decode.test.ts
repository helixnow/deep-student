import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { decodeCapabilityFile, CapabilityDecodeError, unexpectedOf } from '../api.ts';
import { CapabilityAcl } from '../acl.ts';

function withCapability(input: unknown, check: (acl: CapabilityAcl) => void, raw?: string | Uint8Array): void {
  const root = mkdtempSync(join(tmpdir(), 'dstu-capability-'));
  mkdirSync(join(root, 'capabilities'));
  mkdirSync(join(root, 'permissions'));
  writeFileSync(join(root, 'permissions', 'app.toml'), '[[permission]]\nidentifier = "allow-app"\ncommands.allow = ["example"]\n');
  try {
    writeFileSync(join(root, 'capabilities', 'test.json'), raw ?? JSON.stringify(input));
    check(CapabilityAcl.fromDirectory('linux', root));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

it('F1-DECODE-01 capability_file_de shares defaults and preserves opaque F2 scopes', () => {
  // tauri-utils acl/capability.rs::capability_file_de, permission_entry_de; Scopes=Option<Vec<Value>>.
  const minimal = { identifier: '', permissions: [] };
  const expected = { ...minimal, description: '', local: true, remote: null, platforms: null, windows: [], webviews: [] };
  for (const value of [minimal, [minimal], { capabilities: [minimal], ignored: true }]) {
    expect(decodeCapabilityFile(value, 'cap.json')).toEqual([expected]);
  }
  const allow = [{ path: '$HOME/**', app: true, extra: { arbitrary: [null, 7] } }, null, 'scope', false];
  const [cap] = decodeCapabilityFile({ identifier: 'x', permissions: [{ identifier: 'opener:allow-open-path', allow, deny: null, ignored: 'x' }], ignored: 1 });
  expect(cap!.permissions).toEqual([{ identifier: 'opener:allow-open-path', allow, deny: null }]);
  expect(cap).not.toHaveProperty('ignored');
});

it('F1-DECODE-01 Target map variants and remote/local boundaries go through fromDirectory', () => {
  // platform.rs Target is a serde unit enum; capability.rs local defaults true.
  const cap = { identifier: 'x', permissions: ['allow-app'], windows: ['main'], platforms: [{ linux: null }] };
  withCapability(cap, acl => {
    expect(acl.denial('example', { window: 'main', webview: 'main' }, true)).toBeNull();
    expect(acl.denial('example', { window: 'other', webview: 'other' }, false)).toBe('Command example not allowed by ACL');
    expect(acl.denial('example', { window: 'main', webview: 'main', origin: 'https://example.test' }, false)).toBe('Command example not allowed by ACL');
  });
  withCapability({ ...cap, local: false, remote: { urls: ['https://example.test'], ignored: true } }, acl => {
    expect(acl.denial('example', { window: 'main', webview: 'main' }, false)).toBe('Command example not allowed by ACL');
    expect(acl.denial('example', { window: 'main', webview: 'main', origin: 'https://example.test/path' }, true)).toBeNull();
    expect(acl.denial('example', { window: 'main', webview: 'main', origin: 'https://other.test/path' }, false)).toBe('Command example not allowed by ACL');
  });
});

it('F1-DECODE-01 visits present fields before missing fields and buffers flattened scopes', () => {
  const cases: [unknown, string, string][] = [
    [{ local: 'yes', windows: 1 }, '/local', 'invalid type: string "yes", expected a boolean'],
    [{ windows: 1, local: 'yes' }, '/windows', 'invalid type: number, expected a sequence'],
    [{ permissions: [] }, '', 'missing field `identifier`'],
    [{ identifier: 'x' }, '', 'missing field `permissions`'],
    [{ identifier: 'x', permissions: [{ allow: {}, identifier: 10 }] }, '/permissions/0/identifier', 'invalid type: number, expected a string'],
    [{ identifier: 'x', permissions: [{ allow: {} }] }, '/permissions/0', 'missing field `identifier`'],
    [{ identifier: 'x', permissions: [{ allow: {}, identifier: 'allow-app' }] }, '/permissions/0/allow', 'invalid type: map, expected a sequence'],
    [{ capabilities: null, identifier: 'x', permissions: [] }, '/capabilities', 'invalid type: null, expected a sequence'],
  ];
  for (const [input, path, detail] of cases) {
    try { decodeCapabilityFile(input, 'actual-cap.json'); throw new Error('accepted invalid input'); }
    catch (error) {
      expect(error).toBeInstanceOf(CapabilityDecodeError);
      expect(error).toMatchObject({ file: 'actual-cap.json', path, detail });
    }
  }
  expect(() => withCapability({ local: 'yes', windows: 1 }, () => {})).toThrow('invalid type: string "yes", expected a boolean');
});

it('F1-DECODE-01 Identifier format follows actual Rust, including uppercase and core prefixes', () => {
  // identifier.rs::format; do not tighten to lowercase merely because InvalidFormat says lowercase.
  for (const identifier of ['preFix:base', 'pre--fix:base--sep', 'core:window:allow-close', 'core::default']) {
    expect(decodeCapabilityFile({ identifier: 'cap', permissions: [identifier] })[0]!.permissions).toEqual([identifier]);
  }
  const cases = [
    ['', 'identifiers cannot be empty'],
    ['tauri-plugin-foo:bar', 'identifiers cannot start with tauri-plugin-'],
    ['prefix:', 'identifiers cannot have a prefix without a base'],
    ['prefix:base-', 'identifiers cannot have a trailing hyphen'],
    ['prefix::base', "identifiers can only include a single separator '58'"],
    ['a'.repeat(117), 'identifiers cannot be longer than 116, found 117'],
  ];
  for (const [identifier, reason] of cases) {
    expect(() => decodeCapabilityFile({ identifier: 'cap', permissions: [identifier] })).toThrow(`invalid plugin or permission identifier '${identifier}': ${reason}`);
  }
});

it('F1-DECODE-01 retains derived struct sequence forms and distinguishes Option from default Vec', () => {
  expect(decodeCapabilityFile([['cap', '', [['https://example.test']], false, ['main'], [], ['allow-app'], null]])).toEqual([{
    identifier: 'cap', description: '', remote: { urls: ['https://example.test'] }, local: false,
    windows: ['main'], webviews: [], permissions: ['allow-app'], platforms: null,
  }]);
  for (const key of ['windows', 'webviews', 'permissions']) {
    expect(() => decodeCapabilityFile({ identifier: 'cap', permissions: [], [key]: null })).toThrow('invalid type: null, expected a sequence');
  }
  expect(() => decodeCapabilityFile({ identifier: 'cap', permissions: [], platforms: [{ linux: 1 }] })).toThrow('invalid type: number, expected unit');
  expect(() => decodeCapabilityFile({ identifier: 'cap', permissions: [], platforms: ['Linux'] })).toThrow('unknown variant `Linux`, expected one of `macOS`, `windows`, `linux`, `android`, `iOS`');
});

it('F1-DECODE-01 fromDirectory keeps Rust UTF-8/BOM and duplicate-identifier behavior', () => {
  const cap = { identifier: 'same', permissions: [] };
  expect(() => withCapability([cap, cap], () => {})).toThrow('capability with identifier `same` already exists');
  expect(() => withCapability(null, () => {}, Buffer.from([0xff]))).toThrow('stream did not contain valid UTF-8');
  // read_to_string preserves the BOM; the JSON layer must see and reject it.
  expect(() => withCapability(null, () => {}, `\uFEFF${JSON.stringify(cap)}`)).toThrow(CapabilityDecodeError);
  expect(unexpectedOf(9007199254740993n)).toBe('number');
});
