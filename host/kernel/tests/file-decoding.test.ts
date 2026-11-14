import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CapabilityAcl } from '../acl.ts';
import { ContractError, ContractSet } from '../contracts.ts';

it('capability_file_de accepts Rust single/list/named-list formats and validates nested fields', () => {
  // tauri-utils 2.9.3 acl/capability.rs::capability_file_de and Capability serde fields.
  const root = mkdtempSync(join(tmpdir(), 'dstu-acl-de-'));
  mkdirSync(join(root, 'capabilities'));
  mkdirSync(join(root, 'permissions'));
  writeFileSync(join(root, 'permissions', 'app.toml'), '[[permission]]\nidentifier = "allow-app"\ncommands.allow = ["example"]\n');
  const file = join(root, 'capabilities', 'test.json');
  const cap = { identifier: 'test', windows: ['main'], permissions: ['allow-app'], remote: null, platforms: null };
  try {
    for (const input of [cap, [cap], { capabilities: [cap] }]) {
      writeFileSync(file, JSON.stringify(input));
      expect(CapabilityAcl.fromDirectory('linux', root).denial('example', { window: 'main', webview: 'main' }, true)).toBeNull();
    }
    for (const patch of [
      { local: 'false' }, { windows: null }, { webviews: [1] }, { platforms: ['typo'] },
      { permissions: [{}] }, { remote: { urls: [false] } }, { description: null },
      { permissions: [{ identifier: 'allow-app', allow: {} }] },
    ]) {
      writeFileSync(file, JSON.stringify({ ...cap, ...patch }));
      expect(() => CapabilityAcl.fromDirectory('linux', root)).toThrow('invalid capability');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('contract files reject malformed command arguments before dispatch', () => {
  const root = mkdtempSync(join(tmpdir(), 'dstu-contract-de-'));
  try {
    writeFileSync(join(root, 'bad.json'), JSON.stringify({ lane: 'bad', generator: 'fixture', events: [], $defs: {},
      commands: [{ name: 'example', args: [{ key: 1, optional: 'false', schema: {} }], result: {} }] }));
    expect(() => ContractSet.fromDirectory(root)).toThrow('invalid contract');
    expect(ContractSet.fromDirectory().get('plugin_list')?.name).toBe('plugin_list');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each([
  [{ commands: {} }, '/commands'],
  [{ commands: [{ name: 'example', args: {}, result: {} }] }, '/commands/0/args'],
  [{ commands: [{ name: 'example', args: [{ key: 'input', optional: false, schema: { type: 'object', properties: [] } }], result: {} }] }, '/commands/0/args/0/schema/properties'],
  [{ commands: [{ name: 'example', args: [], result: { required: 'wrong' } }] }, '/commands/0/result/required'],
  [{ $defs: { Broken: { items: 1 } } }, '/$defs/Broken/items'],
])('F1-DECODE-02 rejects malformed consumed structure at %s', (patch, pointer) => {
  const root = mkdtempSync(join(tmpdir(), 'dstu-contract-shape-'));
  try {
    const file = join(root, 'bad.json');
    writeFileSync(file, JSON.stringify({ lane: 'bad', generator: 'fixture', events: [], $defs: {}, commands: [], ...patch }));
    try { ContractSet.fromDirectory(root); throw new Error('accepted malformed contract'); }
    catch (error) {
      expect(error).toBeInstanceOf(ContractError);
      expect(error).not.toBeInstanceOf(TypeError);
      expect((error as Error).message).toContain(file);
      expect((error as Error).message).toContain(pointer);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('F1-DECODE-02 keeps valid x-annotations and checks args through the loaded contract', () => {
  const root = mkdtempSync(join(tmpdir(), 'dstu-contract-valid-'));
  try {
    writeFileSync(join(root, 'valid.json'), JSON.stringify({ lane: 'valid', generator: 'fixture', events: [], $defs: {}, commands: [{
      name: 'example', args: [{ key: 'input', optional: false, schema: { type: 'string', 'x-rust': 'String', 'x-extra': { note: 'kept' } } }], result: true,
    }] }));
    const contracts = ContractSet.fromDirectory(root), command = contracts.get('example')!;
    expect(contracts.checkArgs(command, { input: 'text' })).toEqual({ ok: true, args: { input: 'text' } });
    expect(contracts.checkArgs(command, { input: 7 })).toEqual({ ok: false, error: 'invalid args `input` for command `example`: invalid type: number, expected a string' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
