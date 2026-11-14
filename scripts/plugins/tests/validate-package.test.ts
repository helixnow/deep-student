import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_PLATFORMS } from '../../../host/kernel/platforms';
import { pluginSchema, readPluginMeta, validatePackage } from '../validate-package.mjs';

const SCRIPT = path.resolve(__dirname, '../validate-package.mjs');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const HOST = (meta: string, inject = "['review', 'studyStats']") => `
import { definePlugin } from '@deepstudent/plugin-sdk/host';
export default definePlugin({
  meta: ${meta},
  inject: ${inject},
  apply(ctx) { ctx.provide('studyStats', { summary: () => ({}) }); },
});
`;
const UI = (meta: string) => `
import { defineUiPlugin } from '@deepstudent/ui';
export default defineUiPlugin({
  meta: ${meta},
  apply(ctx) { ctx.ui.nav.register({ id: 'stats', viewId: 'stats', labelKey: 'title' }); },
});
`;

const MANIFEST = {
  id: 'community.study-stats',
  version: '0.1.0',
  engines: { deepStudent: '^2.0' },
  platforms: ['desktop', 'mobile'],
  host: './host/index.ts',
  ui: './ui/index.tsx',
  permissions: ['service:review'],
  trust: 'sandboxed',
  contributes: { 'dashboard.widgets': [{ id: 'study-stats', titleKey: 'title', size: 'md' }] },
};
const HOST_META = "{ id: 'community.study-stats', platforms: PLATFORMS, provides: ['studyStats'], remote: { studyStats: ['summary'] } }";
const UI_META = "{ id: 'community.study-stats', apiVersion: 2, host: true }";

function pkg(files: { manifest?: unknown; host?: string | null; ui?: string | null; extra?: Record<string, string> } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'w17-plugin-pkg-'));
  dirs.push(dir);
  const write = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  };
  write('plugin.json', typeof files.manifest === 'string' ? files.manifest : JSON.stringify(files.manifest ?? MANIFEST, null, 2));
  if (files.host !== null) write('host/index.ts', `const PLATFORMS = ['desktop', 'mobile'] as const;\n${files.host ?? HOST(HOST_META)}`);
  if (files.ui !== null) write('ui/index.tsx', files.ui ?? UI(UI_META));
  for (const [rel, text] of Object.entries(files.extra ?? {})) write(rel, text);
  return dir;
}
const codes = (result: { errors: { code: string }[] }) => result.errors.map((e) => e.code);

describe('plugin.json schema', () => {
  it('uses the kernel platform vocabulary', () => {
    expect(pluginSchema.properties.platforms.items.enum).toEqual([...PLUGIN_PLATFORMS]);
  });

  it('accepts the §2.2 full-stack example and reads meta from both halves statically', () => {
    const result = validatePackage(pkg());
    expect(result).toMatchObject({ ok: true, errors: [], warnings: [] });
    expect(readPluginMeta(UI(UI_META), 'ui.tsx', 'defineUiPlugin')).toEqual({
      meta: { id: 'community.study-stats', apiVersion: 2, host: true },
      inject: undefined,
    });
  });

  it.each([
    ['missing platforms', { ...MANIFEST, platforms: undefined }, "must have required property 'platforms'"],
    ['unknown platform', { ...MANIFEST, platforms: ['desktop', 'web'] }, 'must be equal to one of the allowed values'],
    ['empty platforms', { ...MANIFEST, platforms: [] }, 'must NOT have fewer than 1 items'],
    ['bad id', { ...MANIFEST, id: 'StudyStats' }, 'must match pattern'],
    ['bad version', { ...MANIFEST, version: '1.0' }, 'must match pattern'],
    ['unknown key', { ...MANIFEST, main: './x.ts' }, 'must NOT have additional properties'],
    ['entry escaping the package', { ...MANIFEST, ui: './../outside/ui.tsx' }, 'must NOT be valid'],
    ['builtin trust', { ...MANIFEST, trust: 'builtin' }, 'must be equal to one of the allowed values'],
    ['neither half', { id: 'community.x', version: '1.0.0', platforms: ['desktop'] }, "must have required property 'host'"],
    ['bad permission', { ...MANIFEST, permissions: ['review'] }, 'must match pattern'],
  ])('rejects %s', (_label, manifest, message) => {
    const result = validatePackage(pkg({ manifest }));
    expect(result.ok).toBe(false);
    expect(codes(result).every((code) => code === 'schema')).toBe(true);
    expect(result.errors.map((e) => e.message).join('\n')).toContain(message);
  });

  it('rejects malformed JSON and a missing manifest', () => {
    expect(codes(validatePackage(pkg({ manifest: '{ "id": ' })))).toEqual(['manifest-json']);
    const empty = mkdtempSync(path.join(tmpdir(), 'w17-plugin-pkg-'));
    dirs.push(empty);
    expect(codes(validatePackage(empty))).toEqual(['manifest-missing']);
  });
});

describe('UI/Host pairing', () => {
  it('requires the UI half of a full-stack package to pair with its Host half', () => {
    expect(codes(validatePackage(pkg({ ui: UI("{ id: 'community.study-stats' }") })))).toEqual(['ui-not-paired']);
    expect(codes(validatePackage(pkg({ ui: UI("{ id: 'community.study-stats', host: 'dstu.review' }") })))).toEqual(['ui-not-paired']);
    expect(validatePackage(pkg({ ui: UI("{ id: 'community.study-stats', host: 'community.study-stats' }") })).ok).toBe(true);
  });

  it('rejects a UI half that pairs a Host half the package does not ship', () => {
    const { host: _host, permissions: _permissions, ...uiOnly } = MANIFEST;
    expect(codes(validatePackage(pkg({ manifest: uiOnly, host: null })))).toEqual(['ui-host-without-host-half']);
    expect(validatePackage(pkg({ manifest: uiOnly, host: null, ui: UI("{ id: 'community.study-stats' }") })).ok).toBe(true);
  });

  it('requires both halves to use the package id and a literal meta', () => {
    expect(codes(validatePackage(pkg({ host: HOST(HOST_META.replace("id: 'community.study-stats'", "id: 'community.other'")) })))).toEqual(['host-id-mismatch']);
    expect(codes(validatePackage(pkg({ ui: UI("{ id: 'community.other', host: true }") })))).toEqual(['ui-id-mismatch', 'ui-not-paired']);
    expect(codes(validatePackage(pkg({ ui: 'export default defineUiPlugin(makePlugin());' })))).toEqual(['ui-meta-unreadable']);
    expect(codes(validatePackage(pkg({ ui: 'export const x = 1;' })))).toEqual(['ui-meta-unreadable']);
  });

  it('reports missing entry files', () => {
    expect(codes(validatePackage(pkg({ ui: null })))).toEqual(['entry-missing']);
  });

  it('reserves the dstu. prefix for official packages', () => {
    const manifest = { ...MANIFEST, id: 'dstu.study-stats' };
    const host = HOST(HOST_META.replace('community.study-stats', 'dstu.study-stats'));
    const ui = UI(UI_META.replace('community.study-stats', 'dstu.study-stats'));
    expect(codes(validatePackage(pkg({ manifest, host, ui })))).toEqual(['id-reserved']);
    expect(validatePackage(pkg({ manifest, host, ui }), { allowOfficial: true }).ok).toBe(true);
  });
});

describe('platforms', () => {
  it('compares the Host meta.platforms (default desktop) with the package platforms', () => {
    const noPlatforms = HOST("{ id: 'community.study-stats', provides: ['studyStats'] }");
    const result = validatePackage(pkg({ host: noPlatforms }));
    expect(codes(result)).toEqual(['host-platforms-mismatch']);
    expect(result.errors[0]!.message).toContain('["desktop"] (default)');
    expect(validatePackage(pkg({ manifest: { ...MANIFEST, platforms: ['desktop'] }, host: noPlatforms })).ok).toBe(true);
  });

  it('allows the UI half to narrow, but not widen, the package platforms', () => {
    expect(validatePackage(pkg({ ui: UI("{ id: 'community.study-stats', host: true, platforms: ['desktop'] }") })).ok).toBe(true);
    const desktopOnly = { ...MANIFEST, platforms: ['desktop'] };
    const host = HOST(HOST_META.replace('platforms: PLATFORMS, ', ''));
    expect(codes(validatePackage(pkg({ manifest: desktopOnly, host, ui: UI("{ id: 'community.study-stats', host: true, platforms: ['desktop', 'mobile'] }") }))))
      .toEqual(['ui-platforms-outside']);
  });
});

describe('dependencies', () => {
  it('requires a permission for every injected official service and warns about unused ones', () => {
    expect(codes(validatePackage(pkg({ manifest: { ...MANIFEST, permissions: [] } })))).toEqual(['permission-missing']);
    const extra = validatePackage(pkg({ manifest: { ...MANIFEST, permissions: ['service:review', 'service:mastery'] } }));
    expect(extra.ok).toBe(true);
    expect(extra.warnings.map((w) => w.code)).toEqual(['permission-unused']);
    expect(validatePackage(pkg({ host: HOST(HOST_META, "{ review: { required: true }, studyStats: {} }") })).ok).toBe(true);
  });

  it('keeps the UI requiresHost / requires in sync with plugin.json', () => {
    const ui = UI("{ id: 'community.study-stats', host: true, requiresHost: ['dstu.review'], requires: ['community.charts'] }");
    expect(codes(validatePackage(pkg({ ui })))).toEqual(['ui-requiresHost-mismatch', 'ui-requires-mismatch']);
    expect(validatePackage(pkg({ ui, manifest: { ...MANIFEST, requiresHost: ['dstu.review'], requires: ['community.charts'] } })).ok).toBe(true);
  });

  it('rejects UI-only dependency fields on a Host-only package and permissions without a Host half', () => {
    const { ui: _ui, ...hostOnly } = MANIFEST;
    expect(codes(validatePackage(pkg({ manifest: { ...hostOnly, requiresHost: ['dstu.review'] }, ui: null })))).toEqual(['requires-without-ui']);
    const { host: _host, ...uiOnly } = MANIFEST;
    expect(codes(validatePackage(pkg({ manifest: uiOnly, host: null, ui: UI("{ id: 'community.study-stats' }") })))).toEqual(['permissions-without-host']);
  });
});

describe('CLI', () => {
  it('exits 0 for valid packages and 1 with readable errors otherwise', () => {
    const good = spawnSync(process.execPath, [SCRIPT, pkg()], { encoding: 'utf8' });
    expect(good.status).toBe(0);
    expect(good.stdout).toContain(': ok');
    const bad = spawnSync(process.execPath, [SCRIPT, pkg({ manifest: { ...MANIFEST, permissions: [] } })], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('error   [permission-missing] host injects service "review" without "service:review" in permissions');
    expect(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status).toBe(2);
  });
});
