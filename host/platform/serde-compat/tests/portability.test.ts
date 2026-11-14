// serde-compat 要在移动端（Capacitor WebView）运行：生产源码不得依赖 Node 专有模块与全局量，
// 也不得假定 JSON.rawJSON 存在（toRustJson 自行拼接文本，只有 *Atom 辅助函数需要它）。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const DIR = join(import.meta.dirname, '..');
const SOURCES = readdirSync(DIR).filter((f) => f.endsWith('.ts'));
const NODE_GLOBALS = new Set(['Buffer', 'process', 'require', '__dirname', '__filename', 'global', 'setImmediate', 'NodeJS']);

function imports(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(join(DIR, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0]!)) out.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function identifiers(file: string): Set<string> {
  const sf = ts.createSourceFile(file, readFileSync(join(DIR, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const out = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) out.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe('serde-compat 可移植性', () => {
  it('有生产源码', () => {
    expect(SOURCES).toEqual(expect.arrayContaining(['index.ts', 'api.ts', 'number.ts', 'schema.ts', 'serialize.ts', 'contract.ts']));
  });

  it.each(SOURCES)('%s 只做相对导入，且不引用 Node 模块', (file) => {
    for (const spec of imports(file)) {
      expect(spec, `${file} imports ${spec}`).toMatch(/^\.\.?\//);
      expect(spec).not.toMatch(/^node:/);
    }
  });

  it.each(SOURCES)('%s 不使用 Node 全局量', (file) => {
    const used = [...identifiers(file)].filter((id) => NODE_GLOBALS.has(id));
    expect(used, file).toEqual([]);
  });

  it('传递依赖（kernel/serde.ts、util/f32-json.ts、util/json-exact.ts、time/index.ts）同样不导入 Node 模块', () => {
    const deps = new Set<string>();
    const walk = (abs: string) => {
      if (deps.has(abs)) return;
      deps.add(abs);
      const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true);
      for (const st of sf.statements) {
        if ((ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
          const spec = st.moduleSpecifier.text;
          expect(spec, `${abs} imports ${spec}`).toMatch(/^\.\.?\//);
          const typeOnly = ts.isImportDeclaration(st) ? st.importClause?.isTypeOnly === true : st.isTypeOnly;
          if (!typeOnly) walk(join(abs, '..', spec));
        }
      }
    };
    for (const file of SOURCES) walk(join(DIR, file));
    expect([...deps].some((d) => d.endsWith('f32-json.ts'))).toBe(true);
  });

  it('JSON.rawJSON 缺失时 toRustJson 仍可用', async () => {
    const json = JSON as unknown as Record<string, unknown>;
    const saved = { rawJSON: json.rawJSON, isRawJSON: json.isRawJSON };
    delete json.rawJSON;
    delete json.isRawJSON;
    try {
      const { rs, toRustJson } = await import('../index.ts');
      expect(toRustJson({ percent: 85, steps: [0.5, 525600] }, rs.struct({ percent: rs.f32, steps: rs.vec(rs.f64) }))).toBe('{"percent":85.0,"steps":[0.5,525600.0]}');
    } finally {
      Object.assign(json, saved);
    }
  });
});
