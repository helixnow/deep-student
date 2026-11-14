/**
 * `storage/api.ts`（冻结边界，类型 + 可移植值）与 `storage/node.ts`（依赖 Node 的值，仅桌面）。
 * api.ts 的运行时导出只来自可移植模块，插件经它不会把 Node 依赖带上移动端；依赖 Node 的值只从 node.ts 取。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';
import * as api from '../../storage/api.ts';
import * as journalOwner from '../../storage/deletion-journal-owner.ts';
import * as errors from '../../storage/errors.ts';
import * as queue from '../../storage/file-deletion-queue.ts';
import * as fileNames from '../../storage/file-names.ts';
import * as nodeOnly from '../../storage/node.ts';
import * as query from '../../storage/query.ts';
import * as workspaceOwner from '../../storage/workspace-deletion-owner.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
/** api.ts 在运行时加载的模块。 */
const PORTABLE_SOURCES = [
  'host/platform/storage/errors.ts',
  'host/platform/storage/query.ts',
  'host/platform/storage/file-names.ts',
  'host/platform/storage/workspace-deletion-owner.ts',
  'host/platform/storage/deletion-journal-owner.ts',
];
const PORTABLE_EXPORTS: Record<string, unknown> = { ...errors, ...query, ...fileNames, ...workspaceOwner, ...journalOwner };
const PORTABLE_VALUES = new Set(Object.values(PORTABLE_EXPORTS));
/** node.ts 里依赖 Node 的名字（node.ts 也转出 `file-names.ts` 的纯函数，那些不算）。 */
const NODE_NAMES = Object.entries(nodeOnly).filter(([, value]) => !PORTABLE_VALUES.has(value)).map(([name]) => name).sort();
const API_FILE = 'host/platform/storage/api.ts';

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* sourceFiles(full);
    else if (/\.(?:tsx?|mts|mjs)$/.test(name)) yield full;
  }
}

/** 相对说明符解析到仓库内路径；非相对说明符（包名、别名）返回 null。 */
function importTarget(file: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  return relative(ROOT, resolve(dirname(file), specifier)).split('\\').join('/');
}

describe('storage entries', () => {
  it('api.ts exports none of the Node-backed values, and its whole runtime closure is portable', () => {
    expect(NODE_NAMES.length).toBeGreaterThan(0);
    expect(NODE_NAMES.filter((name) => name in api)).toEqual([]);
    expect(checkModulesClosure(ROOT, [API_FILE])).toEqual([]);
  });

  it('node.ts publishes the notes asset deletion journal functions unchanged', () => {
    for (const name of ['assetLocalPathFromKey', 'deleteAssetWithJournal', 'finishAssetDeletionWithConn', 'prepareAssetDeletionWithConn', 'recoverAssetDeletions']) {
      expect((nodeOnly as Record<string, unknown>)[name], name).toBe((queue as Record<string, unknown>)[name]);
    }
  });

  it('defineQuery lives in the portable leaf query.ts; api.ts re-exports the same function', () => {
    expect(api.defineQuery).toBe(query.defineQuery);
    expect(query.defineQuery<{ id: string }>('SELECT 1 WHERE id = :id', { name: 'x.y' })).toEqual({ sql: 'SELECT 1 WHERE id = :id', name: 'x.y', options: undefined });
    expect(checkModulesClosure(ROOT, ['host/platform/storage/query.ts'])).toEqual([]);
  });

  it('api.ts values outside node.ts come only from portable modules', () => {
    const local = new Set(['DATABASE_NAMES']);
    for (const [name, value] of Object.entries(api)) {
      if (NODE_NAMES.includes(name) || local.has(name)) continue;
      expect(PORTABLE_EXPORTS[name], name).toBe(value);
    }
    expect(checkModulesClosure(ROOT, PORTABLE_SOURCES)).toEqual([]);
  });

  it('node.ts carries the Node dependencies', () => {
    const keys = checkModulesClosure(ROOT, ['host/platform/storage/node.ts']).map((violation) => violation.key);
    expect(keys).toContain('node-builtin:fs');
  });

  it('resolves relative specifiers, so importers inside host/platform/storage are covered too', () => {
    expect(importTarget(join(ROOT, 'host/platform/storage/tests/startup.test.ts'), '../api.ts')).toBe(API_FILE);
    expect(importTarget(join(ROOT, 'host/plugins/notes/src/x.ts'), '../../../platform/storage/api.ts')).toBe(API_FILE);
    expect(importTarget(join(ROOT, 'host/platform/storage/x.ts'), 'node:fs')).toBeNull();
  });

  it('no file asks storage/api.ts for a Node-backed value', () => {
    const found: Record<string, string[]> = {};
    const pattern = /(?:import|export)\s+\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g;
    for (const dir of ['host', 'electron', 'mobile/src', 'scripts']) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        const rel = relative(ROOT, file).split('\\').join('/');
        if (rel === API_FILE || rel === 'host/platform/storage/node.ts') continue;
        for (const match of readFileSync(file, 'utf8').matchAll(pattern)) {
          if (importTarget(file, match[2]!) !== API_FILE) continue;
          const names = match[1]!.split(',').map((part) => part.trim()).filter((part) => part && !part.startsWith('type '))
            .map((part) => part.split(/\s+as\s+/)[0]!);
          const nodeNames = names.filter((name) => NODE_NAMES.includes(name));
          if (nodeNames.length > 0) found[rel] = [...(found[rel] ?? []), ...nodeNames].sort();
        }
      }
    }
    expect(found, 'import these from platform/storage/node.ts').toEqual({});
  });
});
