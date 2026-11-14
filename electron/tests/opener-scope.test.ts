import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { deriveScopes, openerApplicationMatches } from '../shell/capabilities.ts';

const roots: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'f2-opener-'));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function capability(dir: string, name: string, permissions: unknown[]): void {
  writeFileSync(join(dir, name), JSON.stringify({ identifier: name.replace(/\.json$/, ''), permissions }));
}

it('opener capability entries carry path, url and app constraints', () => {
  const dir = temp();
  capability(dir, 'default.json', [
    'opener:default',
    { identifier: 'opener:allow-open-path', allow: [{ path: '$APPDATA/**' }, { path: '$DOWNLOAD/**', app: true }, { path: '$TEMP/**', app: 'Preview' }] },
    { identifier: 'opener:allow-open-url', allow: [{ url: 'https://example.com/*', app: 'Firefox' }, { url: 'https://*/*', app: false }] },
  ]);
  const scopes = deriveScopes(dir, 'darwin');
  expect(scopes.openerPathAllow).toEqual([
    { path: '$APPDATA/**', app: null },
    { path: '$DOWNLOAD/**', app: true },
    { path: '$TEMP/**', app: 'Preview' },
  ]);
  expect(scopes.openerUrlAllow).toContainEqual({ url: 'https://example.com/*', app: 'Firefox' });
  expect(scopes.openerUrlAllow).toContainEqual({ url: 'https://*/*', app: false });
  expect(scopes.openerUrlAllow).toContainEqual({ url: 'mailto:*', app: null });
});

it('opener app constraints follow tauri-plugin-opener Application::matches', () => {
  expect(openerApplicationMatches(null, null)).toBe(true);
  expect(openerApplicationMatches(null, 'Firefox')).toBe(false);
  expect(openerApplicationMatches(true, null)).toBe(true);
  expect(openerApplicationMatches(true, 'Firefox')).toBe(true);
  expect(openerApplicationMatches(false, null)).toBe(false);
  expect(openerApplicationMatches(false, 'Firefox')).toBe(false);
  expect(openerApplicationMatches('Firefox', 'Firefox')).toBe(true);
  expect(openerApplicationMatches('Firefox', 'firefox')).toBe(false);
  expect(openerApplicationMatches('Firefox', null)).toBe(false);
});

it('default capability grants path entries to the default application only', () => {
  const scopes = deriveScopes(join(import.meta.dirname, '..', '..', 'resources/app', 'capabilities'), 'darwin');
  expect(scopes.openerPathAllow.length).toBeGreaterThan(0);
  expect(scopes.openerPathAllow.every((entry) => entry.app === null)).toBe(true);
  expect(scopes.openerUrlAllow).toEqual([
    { url: 'mailto:*', app: null },
    { url: 'tel:*', app: null },
    { url: 'http://*', app: null },
    { url: 'https://*', app: null },
  ]);
});

it('capability files decode like tauri-utils CapabilityFile and fail closed on bad input', () => {
  const dir = temp();
  writeFileSync(join(dir, 'a.json'), JSON.stringify([{ identifier: 'list-cap', permissions: ['fs:allow-download-read'], extra: 1 }]));
  writeFileSync(join(dir, 'b.json'), JSON.stringify({ capabilities: [{ identifier: 'named', permissions: ['fs:allow-temp-write'], platforms: ['linux'] }] }));
  writeFileSync(join(dir, 'c.json'), JSON.stringify({ identifier: 'ios-only', permissions: ['fs:allow-home-read'], platforms: ['iOS'] }));
  expect(deriveScopes(dir, 'linux').fsAllow).toEqual(['$DOWNLOAD', '$DOWNLOAD/*', '$TEMP', '$TEMP/*']);

  const bad = (content: unknown, message: string) => {
    const d = temp();
    writeFileSync(join(d, 'x.json'), JSON.stringify(content));
    expect(() => deriveScopes(d, 'linux')).toThrow(message);
  };
  bad({ identifier: 'x' }, 'missing field `permissions`');
  bad({ identifier: 'x', permissions: ['fs:allow-home-read'], platforms: ['Linux'] }, 'unknown variant `Linux`');
  bad({ identifier: 'x', permissions: ['Bad::id'] }, "invalid plugin or permission identifier 'Bad::id'");
  bad({ identifier: 'x', permissions: [{ identifier: 'fs:default', allow: {} }] }, 'invalid type: map, expected a sequence');
  bad({ identifier: 'x', permissions: [], windows: null }, 'invalid type: null, expected a sequence');
  bad([{ identifier: 'x', permissions: [] }, { identifier: 'x', permissions: [] }], 'capability with identifier `x` already exists');
});

it('the shipped src-tauri capabilities decode on every desktop platform', () => {
  const dir = new URL('../../resources/app/capabilities/', import.meta.url).pathname;
  for (const platform of ['linux', 'darwin', 'win32'] as const) expect(deriveScopes(dir, platform).fsAllow.length).toBeGreaterThan(0);
});

it('the file loader keeps its prefix and file checks around the shared kernel decoder', () => {
  const dir = temp();
  const file = join(dir, 'a.json');
  writeFileSync(file, JSON.stringify({ identifier: 'shared', permissions: ['fs:allow-temp-read'], platforms: [{ linux: null }] }));
  expect(deriveScopes(dir, 'linux').fsAllow).toEqual(['$TEMP', '$TEMP/*']);
  writeFileSync(file, JSON.stringify({ identifier: 'shared', permissions: ['Bad::id'] }));
  expect(() => deriveScopes(dir, 'linux')).toThrow(
    `failed to parse capability file ${file}: invalid plugin or permission identifier 'Bad::id': identifiers can only include a single separator '58'`,
  );
  writeFileSync(file, Buffer.from([0x7b, 0xff, 0x7d]));
  expect(() => deriveScopes(dir, 'linux')).toThrow(`failed to parse capability file ${file}:`);
  writeFileSync(file, '\ufeff{"identifier":"shared","permissions":[]}');
  expect(() => deriveScopes(dir, 'linux')).toThrow(`failed to parse capability file ${file}:`);
  writeFileSync(file, '{"identifier":"shared","permissions":[]}');
  writeFileSync(join(dir, 'b.json'), '{"identifier":"shared","permissions":[]}');
  expect(() => deriveScopes(dir, 'linux')).toThrow('capability with identifier `shared` already exists');
});
