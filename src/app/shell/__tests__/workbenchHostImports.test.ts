/**
 * W38 — App / main / command-palette 对 `src/features/workbench/**` 的静态依赖基线。
 *
 * 目标：移动端构建不应包含桌面工作台模块。这里把宿主文件对 workbench 的
 * 静态 import（非 type-only）全部登记；任何新增都会红，删除则要求在同一提交
 * 更新基线（只减不增）。动态 import（lazy / 平台门控）单独记录，允许存在。
 *
 * 基线文件：`src/app/shell/__golden__/workbench-host-imports.json`
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_SHELL_SOURCE_FILES } from '@/app/__tests__/appShellSources';

const GOLDEN = resolve(process.cwd(), 'src/app/shell/__golden__/workbench-host-imports.json');

/** Host files that W38 owns outside the app-shell source list (brief §7/§48). */
const HOST_FILES = [
  'src/main.tsx',
  'src/command-palette/CommandPaletteProvider.tsx',
  'src/command-palette/hooks/useResourceSearch.ts',
  'src/command-palette/modules/automation.commands.ts',
  'src/command-palette/modules/notes.commands.ts',
];

const WORKBENCH_PREFIX = 'features/workbench/';

interface Imports {
  static: string[];
  dynamic: string[];
}

function normalizeSpecifier(specifier: string): string | null {
  if (specifier.startsWith('@/features/workbench/')) return specifier.slice(2);
  if (specifier.startsWith('./features/workbench/')) return specifier.slice(2);
  if (specifier.startsWith('features/workbench/')) return specifier;
  return null;
}

const STATIC_IMPORT_RE = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^'";]*?)\bfrom\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

export function readHostImports(source: string): Imports {
  const statics = new Set<string>();
  const dynamics = new Set<string>();
  for (const match of source.matchAll(STATIC_IMPORT_RE)) {
    if (match[2]) continue; // `import type` / `export type`
    const specifier = normalizeSpecifier(match[4]);
    if (specifier) statics.add(specifier);
  }
  for (const match of source.matchAll(SIDE_EFFECT_IMPORT_RE)) {
    const specifier = normalizeSpecifier(match[1]);
    if (specifier) statics.add(specifier);
  }
  for (const match of source.matchAll(DYNAMIC_IMPORT_RE)) {
    const specifier = normalizeSpecifier(match[1]);
    if (specifier) dynamics.add(specifier);
  }
  return {
    static: [...statics].sort(),
    dynamic: [...dynamics].sort(),
  };
}

function collect(): Record<string, Imports> {
  const files = [...new Set([...APP_SHELL_SOURCE_FILES, ...HOST_FILES])].sort();
  const out: Record<string, Imports> = {};
  for (const file of files) {
    const imports = readHostImports(readFileSync(resolve(process.cwd(), file), 'utf8'));
    if (imports.static.length || imports.dynamic.length) out[file] = imports;
  }
  return out;
}

describe('host → workbench import boundary', () => {
  it('matches the recorded static-import baseline (only removals are allowed)', () => {
    const actual = collect();
    if (process.env.W38_UPDATE_GOLDEN === '1') {
      writeFileSync(GOLDEN, `${JSON.stringify({
        $comment: 'W38 host → src/features/workbench import baseline. Static imports may only be removed; update this file in the same commit. Dynamic imports are recorded separately and are allowed.',
        files: actual,
      }, null, 2)}\n`);
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { files: Record<string, Imports> };
    expect(actual).toEqual(golden.files);
  });

  it('keeps the direct-import surface confined to the documented host files', () => {
    const actual = collect();
    for (const [file, imports] of Object.entries(actual)) {
      expect(APP_SHELL_SOURCE_FILES.includes(file) || HOST_FILES.includes(file)).toBe(true);
      if (imports.static.length) {
        expect(file === 'src/main.tsx' || APP_SHELL_SOURCE_FILES.includes(file) || file.startsWith('src/command-palette/')).toBe(true);
      }
    }
  });
});

export { WORKBENCH_PREFIX };
