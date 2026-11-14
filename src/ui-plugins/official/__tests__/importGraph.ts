/**
 * Static import graph of `src/` as Rollup sees it: `import`/`export … from` and eager `import.meta.glob` are static
 * edges; `import()` and lazy globs start new chunks. Bare package imports are leaves. Used to prove which modules a
 * chunk drags in without running an 8 GiB production build.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve('src');
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js'];

export interface ModuleEdges {
  file: string;
  static: string[];
  dynamic: string[];
}

function resolveSpecifier(from: string, specifier: string): string | undefined {
  const clean = specifier.replace(/\?.*$/, '');
  let base: string;
  if (clean.startsWith('@/')) base = path.join(ROOT, clean.slice(2));
  else if (clean.startsWith('.')) base = path.resolve(path.dirname(from), clean);
  else return undefined;
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  for (const ext of EXTENSIONS) if (fs.existsSync(base + ext)) return base + ext;
  return undefined;
}

function walk(dir: string, out: string[]): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function globFiles(from: string, pattern: string): string[] {
  const absolute = pattern.startsWith('@/') ? path.join(ROOT, pattern.slice(2)) : path.resolve(path.dirname(from), pattern);
  const star = absolute.indexOf('*');
  const base = path.dirname(absolute.slice(0, star) + 'x');
  const regex = new RegExp(`^${absolute.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*/g, '[^/]*')}$`);
  return walk(base, []).filter((file) => regex.test(file)).sort();
}

const cache = new Map<string, ModuleEdges>();

export function moduleEdges(file: string): ModuleEdges {
  const cached = cache.get(file);
  if (cached) return cached;
  const edges: ModuleEdges = { file, static: [], dynamic: [] };
  cache.set(file, edges);
  if (!/\.(tsx?|jsx?|mjs)$/.test(file)) return edges;
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const add = (kind: 'static' | 'dynamic', specifier: string) => {
    const target = resolveSpecifier(file, specifier);
    if (target) edges[kind].push(target);
  };
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly : node.isTypeOnly;
      if (!typeOnly) add('static', node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const [arg, options] = node.arguments;
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && arg && ts.isStringLiteralLike(arg)) {
        add('dynamic', arg.text);
      } else if (ts.isPropertyAccessExpression(node.expression) && node.expression.getText() === 'import.meta.glob' && arg && ts.isStringLiteralLike(arg)) {
        const eager = !!options && ts.isObjectLiteralExpression(options) && options.properties.some((p) => p.getText().replace(/\s/g, '') === 'eager:true');
        for (const target of globFiles(file, arg.text)) edges[eager ? 'static' : 'dynamic'].push(target);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return edges;
}

/** Modules loaded together with `entries` (their static closure). */
export function staticClosure(entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = entries.map((entry) => path.resolve(entry));
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...moduleEdges(file).static);
  }
  return seen;
}

/** Repository-relative paths, sorted, for readable assertions and evidence files. */
export function relative(files: Iterable<string>): string[] {
  return [...files].map((file) => path.relative(process.cwd(), file).replace(/\\/g, '/')).sort();
}
