/**
 * `AppError` / `CommandError` 位于叶子模块 `kernel/error-model.ts`：
 * kernel 与 `platform/errors` 都从这里取值，运行时 import 图中不再有
 * `kernel/api.ts → plugin-manager.ts → platform/errors/api.ts → kernel/api.ts` 的环；
 * 原有导出路径继续可用，且是同一个值。
 */
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as kernelApi from '../api.ts';
import * as errorsApi from '../../platform/errors/api.ts';
import * as errorsIndex from '../../platform/errors/index.ts';
import * as testing from '../testing.ts';
import * as leaf from '../error-model.ts';

const REPO = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const at = (path: string) => resolve(REPO, path);

/** 运行时（未被类型擦除的）相对 import / re-export。 */
function runtimeImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const out: string[] = [];
  for (const node of source.statements) {
    let specifier: ts.Expression | undefined;
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause?.isTypeOnly) continue;
      const named = clause?.namedBindings;
      if (clause && !clause.name && named && ts.isNamedImports(named) && named.elements.length > 0
        && named.elements.every((element) => element.isTypeOnly)) continue;
      specifier = node.moduleSpecifier;
    } else if (ts.isExportDeclaration(node)) {
      if (node.isTypeOnly) continue;
      const clause = node.exportClause;
      if (clause && ts.isNamedExports(clause) && clause.elements.length > 0
        && clause.elements.every((element) => element.isTypeOnly)) continue;
      specifier = node.moduleSpecifier;
    }
    if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
      out.push(resolve(dirname(file), specifier.text));
    }
  }
  return out;
}

function findCycles(entries: readonly string[]): string[] {
  const cycles: string[] = [];
  const stack: string[] = [];
  const onStack = new Set<string>();
  const done = new Set<string>();
  const visit = (file: string) => {
    if (onStack.has(file)) {
      cycles.push([...stack.slice(stack.indexOf(file)), file].map((f) => relative(REPO, f)).join(' -> '));
      return;
    }
    if (done.has(file)) return;
    onStack.add(file);
    stack.push(file);
    for (const dep of runtimeImports(file)) visit(dep);
    stack.pop();
    onStack.delete(file);
    done.add(file);
  };
  for (const entry of entries) visit(entry);
  return cycles;
}

describe('error model leaf module (W01)', () => {
  it('only depends on the import-free json.ts', () => {
    expect(runtimeImports(at('host/kernel/error-model.ts')).map((f) => relative(REPO, f))).toEqual(['host/kernel/json.ts']);
    expect(runtimeImports(at('host/kernel/json.ts'))).toEqual([]);
  });

  it('removes the kernel/api.ts ↔ platform/errors/api.ts runtime import cycle', () => {
    expect(findCycles([
      at('host/kernel/api.ts'),
      at('host/platform/errors/api.ts'),
      at('host/platform/errors/index.ts'),
      at('host/kernel/runtime.ts'),
      at('host/kernel/commands.ts'),
    ])).toEqual([]);
  });

  it('kernel files no longer reach into platform/errors for AppError', () => {
    for (const file of [
      'host/kernel/plugin-manager.ts',
      'host/kernel/runtime.ts',
      'host/plugins/ilink/src/client.ts',
      'host/plugins/ilink/src/bot.ts',
      'host/platform/util/qr.ts',
    ]) {
      const deps = runtimeImports(at(file)).map((f) => relative(REPO, f));
      expect(deps, file).not.toContain('host/platform/errors/api.ts');
    }
  });

  it('keeps every previous export path pointing at the same values', () => {
    expect(kernelApi.CommandError).toBe(leaf.CommandError);
    expect(errorsApi.CommandError).toBe(leaf.CommandError);
    expect(errorsIndex.CommandError).toBe(leaf.CommandError);
    expect(testing.CommandError).toBe(leaf.CommandError);
    expect(errorsApi.AppError).toBe(leaf.AppError);
    expect(errorsIndex.AppError).toBe(leaf.AppError);
    expect(errorsApi.AppErrorType).toBe(leaf.AppErrorType);
    expect(errorsApi.AppError.validation('x')).toEqual({ error_type: 'Validation', message: 'x', details: null });
    expect(new errorsApi.CommandError(errorsApi.AppError.not_found('gone')).value)
      .toEqual({ error_type: 'NotFound', message: 'gone', details: null });
  });
});
