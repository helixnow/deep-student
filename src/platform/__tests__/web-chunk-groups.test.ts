// @vitest-environment node
import { build, type Plugin, type Rollup } from 'vite';
import { describe, expect, it } from 'vitest';
import {
  computeWebAppShellGroups,
  createManualChunks,
  failOnCircularChunk,
  manualChunks as desktopManualChunks,
} from '../chunk-strategy';

type ManualChunks = (id: string, meta: Rollup.ManualChunkMeta) => string | undefined;

function virtualGraph(modules: Record<string, string>): Plugin {
  return {
    name: 'web-chunk-groups-fixture',
    enforce: 'pre',
    resolveId: (id) => (id in modules ? id : null),
    load: (id) => modules[id] ?? null,
  };
}

interface ChunkInfo {
  modules: string[];
  imports: string[];
  dynamicImports: string[];
}

async function chunkGraph(
  modules: Record<string, string>,
  entry: string,
  chunks: ManualChunks,
  extraOutput: { experimentalMinChunkSize?: number } = {},
): Promise<Record<string, ChunkInfo>> {
  const output = (await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [virtualGraph(modules)],
    build: {
      write: false,
      minify: false,
      modulePreload: false,
      rollupOptions: {
        input: entry,
        output: { manualChunks: chunks, ...extraOutput },
        onLog: failOnCircularChunk,
      },
    },
  })) as Rollup.RollupOutput;
  const byFile = new Map<string, string>();
  for (const item of output.output) if (item.type === 'chunk') byFile.set(item.fileName, item.name);
  return Object.fromEntries(
    output.output.flatMap((item) =>
      item.type === 'chunk'
        ? [[item.name, {
          modules: Object.keys(item.modules).map((id) => id.replace(/^\0/, '')).sort(),
          imports: item.imports.map((file) => byFile.get(file) ?? file).sort(),
          dynamicImports: item.dynamicImports.map((file) => byFile.get(file) ?? file).sort(),
        }]]
        : [],
    ),
  );
}

const nm = (pkg: string) => `/app/node_modules/${pkg}/index.js`;

/**
 * The WebUI boot shape in miniature:
 * - the Rollup entry is `web/client/entry.ts`; `src/main.tsx` is only reachable through the
 *   dynamically imported virtual facade (`virtual:dstu-web-app-entry`), exactly like the real config;
 * - `src/shared/entry-bridge.ts` is used by both the HTML entry chunk and the app shell;
 * - `shared-store-a.ts` is used by the workbench closure and the chat page (one of the ~121 tiny
 *   shared store chunks in the measured build);
 * - `ChatV2Page` also reaches into the workbench closure (`wb-a.ts`) and both pages pull heavy
 *   vendor chunks (katex / i18next) that must never ride along with `app-main`.
 */
const webGraph: Record<string, string> = {
  '/app/web/client/entry.ts': `import { boot } from '/app/web/client/boot.ts'; import { bridge } from '/app/src/shared/entry-bridge.ts'; boot(bridge); void import('/app/virtual-app-entry.js');`,
  '/app/web/client/boot.ts': `import { bridge } from '/app/src/shared/entry-bridge.ts'; export const boot = (value) => { globalThis.__dstu_boot = [value, bridge]; };`,
  '/app/virtual-app-entry.js': `import '/app/src/main.tsx';`,
  '/app/src/main.tsx': `import { React } from '${nm('react')}'; import { shell } from '/app/src/shell.ts'; import { bridge } from '/app/src/shared/entry-bridge.ts'; export const app = [React, shell, bridge]; void import('/app/src/features/workbench/components/WorkbenchDesktop.tsx'); void import('/app/src/features/chat/pages/index.ts');`,
  '/app/src/shared/entry-bridge.ts': `export const bridge = 'bridge';`,
  '/app/src/shell.ts': `import { appStore } from '/app/src/shared/app-store.ts'; export const shell = appStore;`,
  '/app/src/shared/app-store.ts': `export const appStore = { windows: 0 };`,
  '/app/src/features/workbench/components/WorkbenchDesktop.tsx': `import { wbA } from '/app/src/features/workbench/wb-a.ts'; import { sharedA } from '/app/src/shared/shared-store-a.ts'; import { shell } from '/app/src/shell.ts'; export const WorkbenchDesktop = () => [wbA, sharedA, shell];`,
  '/app/src/features/workbench/wb-a.ts': `import { wbB } from '/app/src/features/workbench/wb-b.ts'; export const wbA = wbB + 1;`,
  '/app/src/features/workbench/wb-b.ts': `import { i18n } from '${nm('i18next')}'; export const wbB = i18n;`,
  '/app/src/shared/shared-store-a.ts': `export const sharedA = { pinned: ['a'] };`,
  '/app/src/features/chat/pages/index.ts': `export { ChatV2Page } from '/app/src/features/chat/pages/ChatV2Page.tsx';`,
  '/app/src/features/chat/pages/ChatV2Page.tsx': `import { chatA } from '/app/src/features/chat/chat-a.ts'; import { sharedA } from '/app/src/shared/shared-store-a.ts'; import { wbA } from '/app/src/features/workbench/wb-a.ts'; export const ChatV2Page = () => [chatA, sharedA, wbA];`,
  '/app/src/features/chat/chat-a.ts': `import { katex } from '${nm('katex')}'; export const chatA = katex;`,
  [nm('react')]: `export const React = 'react';`,
  [nm('i18next')]: `export const i18n = 'i18n';`,
  [nm('katex')]: `export const katex = 'katex';`,
};

const webShellChunks = createManualChunks({ groupLocaleChunks: true, groupWebAppShell: true });

/** Every chunk a chunk imports, directly or transitively, inside the bundle. */
function reachable(graph: Record<string, ChunkInfo>, start: string): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const name = stack.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    stack.push(...(graph[name]?.imports ?? []));
  }
  return seen;
}

describe('WebUI app-shell chunk groups: strict downward-only DAG', () => {
  it('app-main owns src/main.tsx and its static closure, so the boot path starts there', async () => {
    const chunks = await chunkGraph(webGraph, '/app/web/client/entry.ts', webShellChunks);
    expect(chunks['app-main']).toBeDefined();
    expect(chunks['app-main'].modules).toContain('/app/src/main.tsx');
    expect(chunks['app-main'].modules).toContain('/app/src/shell.ts');
    // the forwarding facade is claimed too, so `import('virtual:app-entry')` hits app-main.js
    expect(chunks['app-main'].modules).toContain('/app/virtual-app-entry.js');
    expect(chunks['entry'].dynamicImports).toContain('app-main');
    // a module shared with the HTML entry chunk is claimed by app-main, so the app chunk never
    // statically imports the entry chunk (the reverse import from the measured 3.7 MiB build)
    expect(chunks['app-main'].modules).toContain('/app/src/shared/entry-bridge.ts');
    expect(chunks['entry'].imports).toContain('app-main');
    expect(chunks['app-main'].imports).not.toContain('entry');
    // the shell groups stay out of the boot chunk
    expect(reachable(chunks, 'app-main').has('workbench-core')).toBe(false);
    expect(reachable(chunks, 'app-main').has('chat-core')).toBe(false);
  });

  it('app-main imports vendor chunks only (plus the Vite runtime helper)', async () => {
    const chunks = await chunkGraph(webGraph, '/app/web/client/entry.ts', webShellChunks);
    for (const imported of reachable(chunks, 'app-main')) {
      expect(imported).toMatch(/^(app-main|vendor-|vite-runtime)/);
    }
  });

  it('workbench-core absorbs the shared store chunk and imports only app-main / vendor chunks', async () => {
    const chunks = await chunkGraph(webGraph, '/app/web/client/entry.ts', webShellChunks);
    expect(chunks['workbench-core']).toBeDefined();
    expect(chunks['workbench-core'].modules).toEqual([
      '/app/src/features/workbench/components/WorkbenchDesktop.tsx',
      '/app/src/features/workbench/wb-a.ts',
      '/app/src/features/workbench/wb-b.ts',
      '/app/src/shared/shared-store-a.ts',
    ]);
    const closure = reachable(chunks, 'workbench-core');
    // one shared chunk (shared-store-a) plus one vendor chunk, instead of one chunk per module
    expect([...closure]).toContain('vendor-i18n');
    for (const name of closure) expect(name).toMatch(/^(workbench-core|app-main|vendor-|vite-runtime)/);
    // the heavy vendor chunk of the page behind it stays out of the workbench chunk
    expect(closure.has('vendor-katex')).toBe(false);
    expect(chunks['vendor-i18n'].modules).toEqual([nm('i18next')]);
  });

  it('chat-core keeps the chat closure out of workbench-core and only imports downward', async () => {
    const chunks = await chunkGraph(webGraph, '/app/web/client/entry.ts', webShellChunks);
    expect(chunks['chat-core']).toBeDefined();
    expect(chunks['chat-core'].modules).toEqual([
      '/app/src/features/chat/chat-a.ts',
      '/app/src/features/chat/pages/ChatV2Page.tsx',
      '/app/src/features/chat/pages/index.ts',
    ]);
    const closure = reachable(chunks, 'chat-core');
    // shared-store-a.ts sits in the workbench closure, so chat-core pulls workbench-core in
    expect([...closure]).toEqual(expect.arrayContaining(['workbench-core', 'app-main', 'vendor-katex']));
    for (const name of closure) {
      expect(name).toMatch(/^(chat-core|workbench-core|app-main|vendor-|vite-runtime)/);
    }
    expect(chunks['vendor-katex'].modules).toEqual([nm('katex')]);
  });

  it('never lets a vendor chunk import the app shell (vendor-* ← boot ← workbench-core ← chat-core)', async () => {
    const chunks = await chunkGraph(webGraph, '/app/web/client/entry.ts', webShellChunks);
    const shellChunks = ['app-main', 'workbench-core', 'chat-core', 'ui-boot'];
    for (const [name, chunk] of Object.entries(chunks)) {
      if (!name.startsWith('vendor-')) continue;
      for (const imported of chunk.imports) expect(shellChunks).not.toContain(imported);
    }
    // and the shell groups are not reachable in the wrong direction
    expect(reachable(chunks, 'app-main').has('workbench-core')).toBe(false);
    expect(reachable(chunks, 'app-main').has('chat-core')).toBe(false);
    expect(reachable(chunks, 'workbench-core').has('chat-core')).toBe(false);
  });

  it('keeps the groups even when experimentalMinChunkSize is set (manual chunks are not merged away)', async () => {
    const chunks = await chunkGraph(webGraph, '/app/web/client/entry.ts', webShellChunks, { experimentalMinChunkSize: 20_000 });
    expect(Object.keys(chunks)).toEqual(expect.arrayContaining(['app-main', 'workbench-core', 'chat-core']));
    expect(chunks['app-main'].modules).toContain('/app/src/main.tsx');
    expect(chunks['workbench-core'].modules).toContain('/app/src/features/workbench/wb-a.ts');
    expect(chunks['chat-core'].modules).toContain('/app/src/features/chat/pages/ChatV2Page.tsx');
  });
});

describe('computeWebAppShellGroups: disjoint, closure-partitioned groups', () => {
  interface FakeModule {
    importedIds?: string[];
    importers?: string[];
    dynamicImporters?: string[];
  }

  function groupsOf(graph: Record<string, FakeModule>) {
    const meta = {
      getModuleIds: () => Object.keys(graph),
      getModuleInfo: (id: string) => {
        const module = graph[id];
        if (!module) return null;
        return {
          id,
          importedIds: module.importedIds ?? [],
          importers: module.importers ?? [],
          dynamicImporters: module.dynamicImporters ?? [],
          isEntry: false,
          isExternal: false,
        };
      },
    } as unknown as Pick<Rollup.ManualChunkMeta, 'getModuleIds' | 'getModuleInfo'>;
    return computeWebAppShellGroups(meta);
  }

  // entry → (dynamic) virtual facade → (static) src/main.tsx → dynamic workbench + chat;
  // the chat page reaches a workbench module, and both pull a vendor package.
  const graph: Record<string, FakeModule> = {
    '/app/web/client/entry.ts': { importedIds: ['/app/web/virtual-entry.js'] },
    '/app/web/virtual-entry.js': { importedIds: ['/app/src/main.tsx'], dynamicImporters: ['/app/web/client/entry.ts'] },
    '/app/src/main.tsx': { importedIds: [], importers: ['/app/web/virtual-entry.js'], dynamicImporters: [] },
    '/app/src/features/workbench/components/WorkbenchDesktop.tsx': {
      importedIds: ['/app/src/features/workbench/wb-store.ts'],
      dynamicImporters: ['/app/src/main.tsx'],
    },
    '/app/src/features/workbench/wb-store.ts': {
      importers: ['/app/src/features/workbench/components/WorkbenchDesktop.tsx'],
      importedIds: [nm('i18next')],
    },
    [nm('i18next')]: {},
    '/app/src/features/chat/pages/index.ts': { importedIds: ['/app/src/features/chat/pages/ChatV2Page.tsx'] },
    '/app/src/features/chat/pages/ChatV2Page.tsx': {
      importers: ['/app/src/features/chat/pages/index.ts'],
      importedIds: ['/app/src/features/workbench/wb-store.ts'],
    },
  };

  it('claims the forwarding facade into app-main so the boot import has one hop', () => {
    const groups = groupsOf(graph);
    expect([...groups.appMain].sort()).toEqual(['/app/src/main.tsx', '/app/web/virtual-entry.js']);
  });

  it('keeps chat-core out of the whole workbench closure, so workbench-core never imports it', () => {
    const groups = groupsOf(graph);
    expect([...groups.workbenchCore].sort()).toEqual([
      '/app/src/features/workbench/components/WorkbenchDesktop.tsx',
      '/app/src/features/workbench/wb-store.ts',
    ]);
    expect([...groups.chatCore].sort()).toEqual([
      '/app/src/features/chat/pages/ChatV2Page.tsx',
      '/app/src/features/chat/pages/index.ts',
    ]);
    for (const id of groups.chatCore) {
      expect(groups.workbenchCore.has(id)).toBe(false);
    }
  });

  it('never claims a module a vendor chunk imports', () => {
    const groups = groupsOf(graph);
    expect(groups.workbenchCore.has(nm('i18next'))).toBe(false);
    expect(groups.chatCore.has(nm('i18next'))).toBe(false);
    expect(groups.appMain.has(nm('i18next'))).toBe(false);
  });
});

describe('desktop default manualChunks is untouched by the WebUI groups', () => {
  it('the exported desktop strategy never returns a WebUI app-shell chunk name', async () => {
    const chunks = await chunkGraph(webGraph, '/app/web/client/entry.ts', desktopManualChunks);
    for (const name of ['app-main', 'workbench-core', 'chat-core']) {
      expect(chunks[name]).toBeUndefined();
    }
    // same vendor / ui-boot rules as before
    expect(chunks['vendor-katex'].modules).toEqual([nm('katex')]);
    expect(chunks['vendor-i18n'].modules).toEqual([nm('i18next')]);
    expect(chunks['vendor-react'].modules).toEqual([nm('react')]);
  });

  it('createManualChunks() without options is the same function as the exported desktop strategy', async () => {
    const [withDefault, withDesktop] = await Promise.all([
      chunkGraph(webGraph, '/app/web/client/entry.ts', createManualChunks()),
      chunkGraph(webGraph, '/app/web/client/entry.ts', desktopManualChunks),
    ]);
    expect(withDefault).toEqual(withDesktop);
  });

  it('groupLocaleChunks alone still leaves the app shell ungrouped', async () => {
    const chunks = await chunkGraph(
      webGraph,
      '/app/web/client/entry.ts',
      createManualChunks({ groupLocaleChunks: true }),
    );
    expect(chunks['app-main']).toBeUndefined();
    expect(chunks['workbench-core']).toBeUndefined();
    expect(chunks['chat-core']).toBeUndefined();
  });
});
