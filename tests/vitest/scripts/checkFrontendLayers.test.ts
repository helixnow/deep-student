/**
 * scripts/check-frontend-layers.mjs 的行为契约（内存 fixture，不读真实 src/）。
 * 层图真值见 config/frontend-layers.json，基线见 config/frontend-layers-baseline.json。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  checkFrontendLayers,
  diffBaseline,
  extractImports,
  isScannedSource,
  moduleOf,
  resolveImport,
  summarizePairs,
  // @ts-expect-error 脚本为无类型声明的 .mjs（与 CLI 共用同一实现）
} from '../../../scripts/check-frontend-layers.mjs';

const config = {
  layers: [
    { name: 'foundation', entries: ['types', 'lib'] },
    { name: 'platform', entries: ['utils', 'i18n.ts'] },
    { name: 'ui', entries: ['components'] },
    { name: 'feature', entries: ['features', 'translation'] },
    { name: 'app', entries: ['app', 'App.tsx'] },
  ],
};

const run = (files: Record<string, string>, extraFiles: string[] = []) =>
  checkFrontendLayers({ files, extraFiles, config });

describe('extractImports', () => {
  it('collects static, re-export, side-effect and dynamic imports', () => {
    const code = [
      "import a from '@/a';",
      "import * as b from './b';",
      "import { c, type C } from './c';",
      "import './side';",
      "export { d } from './d';",
      "export * from './e';",
      "const f = () => import('./f');",
      'const g = import(`./g`);',
    ].join('\n');
    expect(extractImports(code, 'x.ts')).toEqual(['@/a', './b', './c', './side', './d', './e', './f', './g']);
  });

  it('skips type-only imports/exports, vi.mock and require', () => {
    const code = [
      "import type { A } from './a';",
      "import { type B, type B2 } from './b';",
      "export type { C } from './c';",
      "export { type D } from './d';",
      "vi.mock('./e');",
      "const f = require('./f');",
      "type G = typeof import('./g');",
      "// import x from './comment';",
      "const s = \"import y from './string'\";",
    ].join('\n');
    expect(extractImports(code, 'x.tsx')).toEqual([]);
  });
});

describe('resolveImport', () => {
  const set = new Set(['utils/a.ts', 'utils/b/index.tsx', 'components/c.tsx', 'assets/v.mp4', 'lib/x.ts']);

  it('resolves alias, relative, extensionless, index, query suffix and .js→.ts', () => {
    expect(resolveImport('components/c.tsx', '@/utils/a', set)).toBe('utils/a.ts');
    expect(resolveImport('components/c.tsx', '../utils/b', set)).toBe('utils/b/index.tsx');
    expect(resolveImport('utils/a.ts', './b/', set)).toBe('utils/b/index.tsx');
    expect(resolveImport('components/c.tsx', '@/assets/v.mp4?url', set)).toBe('assets/v.mp4');
    expect(resolveImport('lib/y.ts', './x.js', set)).toBe('lib/x.ts');
  });

  it('returns null for bare packages, out-of-src and missing files', () => {
    expect(resolveImport('utils/a.ts', 'react', set)).toBeNull();
    expect(resolveImport('utils/a.ts', '../../scripts/x.json', set)).toBeNull();
    expect(resolveImport('utils/a.ts', './missing', set)).toBeNull();
  });
});

describe('moduleOf / isScannedSource', () => {
  it('groups features by name, everything else by top-level entry', () => {
    expect(moduleOf('features/chat/a/b.ts')).toBe('features/chat');
    expect(moduleOf('components/ui/x.tsx')).toBe('components');
    expect(moduleOf('App.tsx')).toBe('App.tsx');
  });

  it('excludes tests and non-code files', () => {
    expect(isScannedSource('utils/a.ts')).toBe(true);
    expect(isScannedSource('utils/__tests__/a.ts')).toBe(false);
    expect(isScannedSource('utils/a.test.tsx')).toBe(false);
    expect(isScannedSource('utils/a.spec.ts')).toBe(false);
    expect(isScannedSource('styles/a.css')).toBe(false);
  });
});

describe('checkFrontendLayers', () => {
  it('allows downward and same-layer imports', () => {
    const r = run({
      'types/t.ts': 'export const T = 1;',
      'utils/u.ts': "import { T } from '@/types/t';",
      'components/c.tsx': "import '@/utils/u'; import { T } from '../types/t';",
      'App.tsx': "import '@/components/c'; import '@/features/chat';",
      'features/chat/index.ts': "import '@/components/c';",
    });
    expect(r.keys).toEqual([]);
    expect(r.problems).toEqual([]);
  });

  it('flags upward imports with a stable module-level key, deduplicated', () => {
    const r = run({
      'utils/a.ts': "import '@/components/c'; import('@/components/c');",
      'utils/b.ts': "import { C } from '../components/c';",
      'utils/types.ts': "import type { C } from '@/components/c';",
      'components/c.tsx': "import '@/app/shell';",
      'app/shell.tsx': '',
    });
    expect(r.keys).toEqual(['components -> src/app/shell.tsx', 'utils -> src/components/c.tsx']);
    expect(r.totals).toEqual({ 'upward-layer': 2, 'cross-feature-deep': 0 });
    const utils = r.violations.find((v: { key: string }) => v.key.startsWith('utils'));
    expect(utils.occurrences).toBe(3);
    expect(utils.files).toEqual(['utils/a.ts', 'utils/b.ts']);
  });

  it('allows cross-feature imports only through the target index', () => {
    const r = run({
      'features/chat/index.ts': "export * from './deep';",
      'features/chat/deep.ts': '',
      'features/notes/a.ts': "import '@/features/chat'; import '@/features/chat/index';",
      'features/notes/b.ts': "import '@/features/chat/deep'; import './a';",
      'features/pdf/index.tsx': '',
      'features/pdf/x.ts': '',
      'features/notes/c.ts': "import '../pdf'; import '../pdf/x';",
    });
    expect(r.keys).toEqual([
      'features/notes -> src/features/chat/deep.ts',
      'features/notes -> src/features/pdf/x.ts',
    ]);
    expect(r.totals['cross-feature-deep']).toBe(2);
  });

  it('treats non-features feature-layer dirs as their own feature modules', () => {
    const r = run({
      'translation/index.ts': '',
      'translation/deep.ts': '',
      'translation/inner.ts': "import './deep';",
      'features/chat/a.ts': "import '@/translation'; import '@/translation/deep';",
      'translation/x.ts': "import '@/features/chat/a';",
    });
    expect(r.keys).toEqual([
      'features/chat -> src/translation/deep.ts',
      'translation -> src/features/chat/a.ts',
    ]);
  });

  it('fails on unassigned top-level entries, including non-code files', () => {
    const r = run({ 'newdir/a.ts': '', 'utils/u.ts': "import '@/newdir/a';" }, ['loose.css']);
    expect(r.problems).toEqual([
      'src/loose.css 未在 config/frontend-layers.json 中登记层级',
      'src/newdir 未在 config/frontend-layers.json 中登记层级',
    ]);
    expect(r.absentEntries).toContain('lib');
  });

  it('reports duplicate layer entries', () => {
    const r = checkFrontendLayers({
      files: {},
      config: { layers: [{ name: 'a', entries: ['x'] }, { name: 'b', entries: ['x'] }] },
    });
    expect(r.problems).toEqual(['层图重复登记：x（a / b）']);
  });
});

describe('diffBaseline / summarizePairs', () => {
  it('separates new keys from disappeared keys', () => {
    expect(diffBaseline(['a', 'c'], ['b', 'c'])).toEqual({ added: ['a'], removed: ['b'] });
  });

  it('aggregates by module pair', () => {
    const pairs = summarizePairs([
      { fromModule: 'x', toModule: 'y', occurrences: 2 },
      { fromModule: 'x', toModule: 'y', occurrences: 1 },
      { fromModule: 'x', toModule: 'z', occurrences: 5 },
    ]);
    expect(pairs[0]).toEqual({ pair: 'x → y', keys: 2, occurrences: 3 });
  });
});

describe('repo layer map', () => {
  it('assigns every current top-level src entry and the baseline is sorted', () => {
    const repoConfig = JSON.parse(readFileSync(resolve(process.cwd(), 'config/frontend-layers.json'), 'utf8'));
    expect(repoConfig.layers.map((l: { name: string }) => l.name)).toEqual(['foundation', 'platform', 'ui', 'feature', 'app']);
    const baseline = JSON.parse(
      readFileSync(resolve(process.cwd(), 'config/frontend-layers-baseline.json'), 'utf8'),
    ).violations as string[];
    expect([...baseline].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(baseline);
    expect(new Set(baseline).size).toBe(baseline.length);
  });
});
