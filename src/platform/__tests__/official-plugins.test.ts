import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  listOfficialPlugins,
  OfficialPluginTableError,
  readOfficialPluginDeclaration,
  renderOfficialPluginsModule,
  selectOfficialPlugins,
  targetPlatform,
  type OfficialPluginDeclaration,
} from '../official-plugins';
import { excludedOfficialUiPlugins, officialUiPlugins } from '@/ui-plugins/official/plugins';
import { normalizeUiPluginMeta } from '@/ui-kernel/meta';
import { UiKernel, type UiPlugin } from '@/ui-kernel/kernel';
import { installOfficialUiPlugins } from '@/ui-plugins/official/install';

const root = process.cwd();
const declarations = listOfficialPlugins(root);
const ids = (list: readonly { id: string }[]) => list.map((plugin) => plugin.id).sort();

describe('build-time official plugin table (virtual:ds-official-plugins, FE-A5)', () => {
  it('reads the same id, platforms, devOnly and slots from source as every plugin declares at runtime', () => {
    expect(ids(declarations)).toEqual(ids(officialUiPlugins.map((plugin) => plugin.meta)));
    expect(excludedOfficialUiPlugins).toEqual([]);
    for (const plugin of officialUiPlugins) {
      const meta = normalizeUiPluginMeta(plugin.meta);
      const declared = declarations.find((d) => d.id === meta.id)!;
      expect({ platforms: declared.platforms, devOnly: declared.devOnly, slots: declared.slots }, meta.id)
        .toStrictEqual({ platforms: meta.platforms, devOnly: meta.devOnly === true, slots: meta.slots });
    }
  });

  it('desktop development builds keep every plugin; production drops devOnly; mobile drops the desktop-only directories', () => {
    expect(ids(selectOfficialPlugins(declarations, { platform: 'desktop', production: false }).included)).toEqual(ids(declarations));
    const desktop = selectOfficialPlugins(declarations, { platform: 'desktop', production: true });
    expect(desktop.excluded.map(({ plugin, reason }) => [plugin.id, reason])).toEqual([['dstu.ui.debug', 'build'], ['dstu.ui.dev', 'build']]);
    const mobile = selectOfficialPlugins(declarations, { platform: 'mobile', production: true });
    expect(mobile.excluded.map(({ plugin, reason }) => [plugin.id, reason]).sort()).toEqual([['dstu.plugin-workshop', 'platform'], ['dstu.ui.debug', 'build'], ['dstu.ui.dev', 'build'], ['dstu.ui.workbench', 'platform']]);
  });

  it('renders static default imports of exactly the included plugin directories', () => {
    const { included } = selectOfficialPlugins(declarations, { platform: 'mobile', production: true });
    const source = renderOfficialPluginsModule(root, included);
    expect(source).not.toMatch(/official\/(workbench|dev)\//);
    expect(source.match(/^import plugin\d+ from /gm)).toHaveLength(included.length);
    expect(source).toContain(JSON.stringify(path.join(root, 'src/ui-plugins/official/shell/index.ts')));
    expect(source).toMatch(/export const officialUiPlugins = \[plugin0, .*\];/);
    expect(source).toMatch(/^export const excludedOfficialUiPlugins = \[\];$/m);
  });

  it('renders each excluded plugin as a meta-only stub the kernel skips for the same reason', async () => {
    const excluded: OfficialPluginDeclaration[] = [
      { file: 'src/ui-plugins/official/a/index.ts', id: 'dstu.ui.a', devOnly: true, slots: ['a.panels', 'a.tabs'] },
      { file: 'src/ui-plugins/official/b/index.ts', id: 'dstu.ui.b', platforms: ['mobile'], devOnly: false },
    ];
    const source = renderOfficialPluginsModule(root, [], excluded);
    expect(source).not.toMatch(/^import /m);
    expect(source).toContain('export const excludedOfficialUiPlugins = [{ name: "dstu.ui.a", meta: {"id":"dstu.ui.a","devOnly":true,"slots":["a.panels","a.tabs"]}, apply() {} }, '
      + '{ name: "dstu.ui.b", meta: {"id":"dstu.ui.b","platforms":["mobile"]}, apply() {} }];\n');
    const stubs = new Function(`${source.replaceAll('export const ', 'const ')}\nreturn excludedOfficialUiPlugins;`)() as UiPlugin[];
    const kernel = new UiKernel({}, { build: 'production' });
    for (const stub of stubs) await expect(kernel.install(stub, { origin: 'builtin' })).resolves.toBe(false);
    expect(kernel.skipped().map((s) => [s.id, s.reason])).toEqual([['dstu.ui.a', 'build'], ['dstu.ui.b', 'platform']]);
    await kernel.dispose();

    // A desktop production build's real exclusions: the kernel lists them as skipped, as in tests and the dev server.
    const desktop = selectOfficialPlugins(declarations, { platform: 'desktop', production: true });
    const real = renderOfficialPluginsModule(root, [], desktop.excluded.map(({ plugin }) => plugin));
    const prod = new UiKernel({}, { build: 'production' });
    await installOfficialUiPlugins(prod, [], new Function(`${real.replaceAll('export const ', 'const ')}\nreturn excludedOfficialUiPlugins;`)());
    expect(prod.skipped().map((s) => [s.id, s.reason])).toEqual([['dstu.ui.debug', 'build'], ['dstu.ui.dev', 'build']]);
    await prod.dispose();
  });

  it('VITE_DS_PLATFORM defaults to desktop and rejects anything else', () => {
    expect(targetPlatform(undefined)).toBe('desktop');
    expect(targetPlatform('')).toBe('desktop');
    expect(targetPlatform('mobile')).toBe('mobile');
    expect(() => targetPlatform('android')).toThrow(OfficialPluginTableError);
  });

  it('takes the default export\u2019s plugin, ignores halves defined in functions, and requires literals', () => {
    const read = (source: string) => readOfficialPluginDeclaration('x/index.ts', source);
    expect(read(`const half = defineUiPlugin({ meta: { id: 'dstu.h', host: true } });
      export default { ...defineUiPlugin({ meta: { id: 'dstu.ui.a', platforms: ['mobile'] as const }, apply(ctx) { ctx.ui.pair(defineUiPlugin({ meta: { id: 'dstu.i' } })); } }), order: 1 };`))
      .toEqual({ file: 'x/index.ts', id: 'dstu.ui.a', platforms: ['mobile'], devOnly: false });
    expect(read(`const p = Object.assign(defineUiPlugin({ meta: { id: 'dstu.ui.b', devOnly: true } }), { order: 2 }); export default p;`))
      .toMatchObject({ id: 'dstu.ui.b', devOnly: true, platforms: undefined });
    expect(() => read(`const p = ['desktop']; export default defineUiPlugin({ meta: { id: 'a', platforms: p } });`)).toThrow(/array of string literals/);
    expect(() => read(`export default defineUiPlugin({ meta: { id: 'a', platforms: ['tv'] } });`)).toThrow(/unknown platform "tv"/);
    expect(() => read(`export default defineUiPlugin({ meta: { id: 'a', devOnly: !0 } });`)).toThrow(/boolean literal/);
    expect(read(`export default defineUiPlugin({ meta: { id: 'dstu.ui.c', slots: ['c.panels', "c.tabs"] as const } });`).slots).toEqual(['c.panels', 'c.tabs']);
    expect(() => read(`const SLOTS = ['c.panels']; export default defineUiPlugin({ meta: { id: 'a', slots: SLOTS } });`))
      .toThrow(/meta\.slots of an official plugin must be an array of string literals\n {2}fix: slots: \['<plugin>\.<slot>'\]/);
    expect(() => read(`export default defineUiPlugin({ meta: { id: 'a' }, slots: ['a.panels'], apply() {} });`)).toThrow(/`slots` is written outside meta/);
    expect(() => read(`export default defineUiPlugin({ meta });`)).toThrow(/meta is not an inline object literal/);
    expect(() => read(`export const x = defineUiPlugin({ meta: { id: 'a' } });`)).toThrow(/no default export/);
    expect(() => read(`export default defineUiPlugin({ meta: { id: 'a' } }).withOrder(1).withOther(defineUiPlugin({ meta: { id: 'b' } }));`)).toThrow(/contains 2 defineUiPlugin/);
    expect(() => read(`export default { ...defineUiPlugin({ meta: { id: 'a' } }), meta: { id: 'b' } };`)).toThrow(/meta is set outside defineUiPlugin/);
  });

  it('rejects a meta field written outside meta (the kernel ignores it; a top-level devOnly ships in production) with the fix', () => {
    const read = (source: string) => readOfficialPluginDeclaration('x/index.ts', source);
    const misplacedDevOnly = /x\/index\.ts:\d+:\d+: `devOnly` is written outside meta; .* bundled and installed in production\)\n {2}fix: move it into meta: defineUiPlugin\(\{ meta: \{ id: '…', devOnly: … \}, apply \}\)\n {2}\(official UI plugin convention: src\/ui-sdk\/README\.md §8\)$/;
    expect(() => read(`export default defineUiPlugin({ meta: { id: 'dstu.ui.a' }, devOnly: true, apply() {} });`)).toThrow(misplacedDevOnly);
    expect(() => read(`export default Object.assign(defineUiPlugin({ meta: { id: 'dstu.ui.a' }, apply() {} }), { order: 1, devOnly: true });`)).toThrow(misplacedDevOnly);
    expect(() => read(`const devOnly = true; export default { ...defineUiPlugin({ meta: { id: 'dstu.ui.a' }, apply() {} }), devOnly };`)).toThrow(misplacedDevOnly);
    // The shape W19's debug plugin had before INT 6c491e6f.
    expect(() => read(`const p: UiPlugin & { devOnly: true } = { name: 'dstu.ui.e', meta: { id: 'dstu.ui.e' }, devOnly: true, apply() {} }; export default p;`))
      .toThrow(misplacedDevOnly);
    expect(() => read(`export default defineUiPlugin({ meta: { id: 'dstu.ui.a' }, platforms: ['mobile'], apply() {} });`))
      .toThrow(/`platforms` is written outside meta; the kernel and this table read only meta\.platforms, so it is ignored\n {2}fix: move it into meta/);
    expect(() => read(`export default defineUiPlugin({ meta: { id: 'dstu.ui.a' }, devOnly: true, apply() {} });`)).toThrow(/^x\/index\.ts:1:60: /);
  });

  it('rejects a meta that is not an inline literal of `name: value` members, and a bare plugin object, with the fix', () => {
    const read = (source: string) => readOfficialPluginDeclaration('x/index.ts', source);
    const notLiteral = /meta is not an inline object literal; .*\n {2}fix: write it inline: defineUiPlugin\(\{ meta: \{ id: 'dstu\.ui\.<name>'/;
    expect(() => read(`const META = { id: 'dstu.ui.a', devOnly: true }; export default defineUiPlugin({ meta: META, apply() {} });`)).toThrow(notLiteral);
    expect(() => read(`export default defineUiPlugin({ meta: makeMeta('dstu.ui.a'), apply() {} });`)).toThrow(notLiteral);
    expect(() => read(`const meta = { id: 'dstu.ui.a' }; export default defineUiPlugin({ meta, apply() {} });`)).toThrow(notLiteral);
    expect(() => read(`const base = { devOnly: true }; export default defineUiPlugin({ meta: { id: 'dstu.ui.a', ...base }, apply() {} });`))
      .toThrow(/meta contains a spread; every field must be written as `name: value`\n {2}fix: spell each field out/);
    expect(() => read(`const devOnly = true; export default defineUiPlugin({ meta: { id: 'dstu.ui.a', devOnly }, apply() {} });`))
      .toThrow(/meta contains the shorthand `devOnly`; every field must be written as `name: value`/);
    expect(() => read(`const definition = { meta: { id: 'dstu.ui.a' }, apply() {} }; export default defineUiPlugin(definition);`))
      .toThrow(/defineUiPlugin\(…\) is not called with an object literal\n {2}fix: export default defineUiPlugin\(\{ meta: \{ id: 'dstu\.ui\.<name>', … \}, apply\(ctx\) \{ … \} \}\)/);
    // A bare plugin object skips defineUiPlugin's excess-property check (how the misplaced devOnly above compiled).
    const bare = /the default export is a plain plugin object; official plugins are defined with defineUiPlugin\n {2}fix: wrap it: export default defineUiPlugin\(\{ meta: \{ … \}, order, apply\(ctx\) \{ … \} \}\)/;
    expect(() => read(`const p: UiPlugin = { name: 'dstu.ui.c', meta: { id: 'dstu.ui.c' }, order: 145, apply(ctx) {} }; export default p;`)).toThrow(bare);
    expect(() => read(`export default { name: 'dstu.ui.d', meta: { id: 'dstu.ui.d', devOnly: true } as const } satisfies UiPlugin;`)).toThrow(bare);
  });
});
