// @vitest-environment node
import { build, type Plugin, type Rollup } from 'vite';
import { describe, expect, it } from 'vitest';
import { failOnCircularChunk, manualChunks } from '../../../vite.config';

type ManualChunks = (id: string, meta: Rollup.ManualChunkMeta) => string | undefined;

function virtualGraph(modules: Record<string, string>): Plugin {
  return {
    name: 'startup-chunks-fixture',
    enforce: 'pre',
    resolveId: (id) => (id in modules ? id : null),
    load: (id) => modules[id] ?? null,
  };
}

/** Chunks of an in-memory production build of `modules` with the app's manualChunks and onLog. */
async function chunksOf(modules: Record<string, string>, entry: string, chunks: ManualChunks = manualChunks) {
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [virtualGraph(modules)],
    build: {
      write: false,
      minify: false,
      modulePreload: false,
      rollupOptions: { input: entry, output: { manualChunks: chunks }, onLog: failOnCircularChunk },
    },
  }) as Rollup.RollupOutput;
  return Object.fromEntries(output.output.flatMap((item) => item.type === 'chunk'
    ? [[item.name, { modules: Object.keys(item.modules).map((id) => id.replace(/^\0/, '')).sort(), imports: item.imports }]]
    : []));
}

const nm = (pkg: string) => `/app/node_modules/${pkg}/index.js`;

/**
 * The startup chain in miniature: the entry lazily loads the UI kernel bootstrap, which lazily loads the official
 * plugin installer. `icons.ts` is shared by the boot chain and a lazy page. The installer and react-i18next
 * (vendor-i18n) both import void-elements, a package without a vendor group (W18 r2: white demo shell).
 */
const kernelGraph: Record<string, string> = {
  '/app/src/main.tsx': `import { createElement } from '${nm('react')}'; createElement(); import('/app/src/ui-kernel/bootstrap.ts'); import('/app/src/pages/Lazy.tsx');`,
  [nm('react')]: `export const createElement = () => 'react';`,
  [nm('react-i18next')]: `import voids from '${nm('void-elements')}'; import { createElement } from '${nm('react')}'; export const useT = () => [voids, createElement()];`,
  [nm('void-elements')]: `export default ['br', 'hr'];`,
  '/app/src/ui-kernel/bootstrap.ts': `import { icon } from '/app/src/ui-kernel/icons.ts'; icon(); import('/app/src/ui-plugins/official/install.ts');`,
  '/app/src/ui-kernel/icons.ts': `import { useT } from '${nm('react-i18next')}'; export const icon = () => useT();`,
  '/app/src/ui-plugins/official/install.ts': `import voids from '${nm('void-elements')}'; import { icon } from '/app/src/ui-kernel/icons.ts'; export default [voids, icon()];`,
  '/app/src/pages/Lazy.tsx': `import { icon } from '/app/src/ui-kernel/icons.ts'; export default icon;`,
};

describe('vite.config manualChunks: ui-boot never forms a static cycle with the vendor chunks', () => {
  it('keeps modules that a vendor package imports out of ui-boot, so ui-boot only imports vendor chunks', async () => {
    const chunks = await chunksOf(kernelGraph, '/app/src/main.tsx');
    expect(chunks['ui-boot']).toEqual({ modules: ['/app/src/ui-kernel/icons.ts'], imports: [expect.stringMatching(/^assets\/vendor-i18n-/)] });
    expect(chunks['vendor-i18n'].modules).toEqual([nm('react-i18next'), nm('void-elements')]);
    expect(chunks['vendor-i18n'].imports.some((file: string) => file.includes('ui-boot'))).toBe(false);
  });

  it('fails the build on a chunk cycle: void-elements in ui-boot (the rule before this one) makes ui-boot ⇄ vendor-i18n', async () => {
    const previousRule: ManualChunks = (id, meta) => (id === nm('void-elements') ? 'ui-boot' : manualChunks(id, meta));
    await expect(chunksOf(kernelGraph, '/app/src/main.tsx', previousRule)).rejects.toThrow(/Circular chunk: .*ui-boot.*vendor-i18n|Circular chunk: .*vendor-i18n.*ui-boot/);
  });

  it('pins the CommonJS helpers to vendor-react; left to Rollup they follow the first CJS vendor to run (vendor-micro ⇄ vendor-react)', async () => {
    const helpers = '\0commonjsHelpers.js';
    const cjsGraph: Record<string, string> = {
      '/app/src/main.tsx': `import { ok } from '${nm('invariant')}'; import { connect } from '${nm('react-redux')}'; export default [ok, connect()];`,
      [helpers]: `export function getDefaultExportFromCjs(x) { globalThis.cjs = x; return x; }`,
      [nm('invariant')]: `import { getDefaultExportFromCjs } from '\\0commonjsHelpers.js'; export const ok = getDefaultExportFromCjs({ ok: 1 });`,
      [nm('react')]: `import { getDefaultExportFromCjs } from '\\0commonjsHelpers.js'; export const React = getDefaultExportFromCjs({ react: 1 });`,
      [nm('react-redux')]: `import { React } from '${nm('react')}'; export const connect = () => (globalThis.redux = React);`,
    };
    const chunks = await chunksOf(cjsGraph, '/app/src/main.tsx');
    expect(chunks['vendor-react']).toEqual({ modules: ['/app/node_modules/react/index.js', 'commonjsHelpers.js'], imports: [] });
    expect(chunks['vendor-micro']).toEqual({ modules: [nm('invariant'), nm('react-redux')], imports: [expect.stringMatching(/^assets\/vendor-react-/)] });

    const unpinned: ManualChunks = (id, meta) => (id === helpers ? undefined : manualChunks(id, meta));
    await expect(chunksOf(cjsGraph, '/app/src/main.tsx', unpinned)).rejects.toThrow(/Circular chunk: .*vendor-(micro|react).*vendor-(micro|react)/);
  });
});
