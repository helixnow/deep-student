import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const nativePackages = new Set(['better-sqlite3', 'sqlite3', '@libsql/client', '@lancedb/lancedb']);
const sqlStart = /^\s*(?:SELECT\b[\s\S]*\bFROM\b|INSERT\s+(?:OR\s+\w+\s+)?INTO\b|UPDATE\b[\s\S]*\bSET\b|DELETE\s+FROM\b|CREATE\s+(?:TABLE|INDEX|TRIGGER)\b|ALTER\s+TABLE\b|PRAGMA\b)/i;

export function checkFile(relative, source) {
  const errors = [];
  const plugin = relative.startsWith('src/plugins/');
  const repository = /\/(repository|migrations)\//.test(relative);
  const ownPlugin = relative.split('/').slice(0, 3).join('/');
  const tree = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true);
  function checkImport(spec, typeOnly = false) {
    if (spec.startsWith('@tauri-apps/') || spec.startsWith('node:') || builtinModules.includes(spec)
        || [...nativePackages].some((pkg) => spec === pkg || spec.startsWith(pkg + '/'))) {
      if (plugin || !relative.startsWith('src/plugin-runtime/adapters/')) errors.push(`native capability import: ${spec}`);
    }
    if (spec.startsWith('.') || spec.startsWith('@/')) {
      const resolved = spec.startsWith('@/') ? `src/${spec.slice(2)}` : path.posix.normalize(path.posix.join(path.posix.dirname(relative), spec));
      if (plugin && !resolved.startsWith(ownPlugin + '/') && !resolved.startsWith('src/plugin-runtime/contracts/')
          && !(typeOnly && /src\/plugin-runtime\/host(?:\.[jt]s)?$/.test(resolved))) {
        errors.push(`plugin implementation dependency: ${spec}`);
      }
      if (!plugin && resolved.startsWith('src/plugins/')) errors.push(`kernel depends on a business plugin: ${spec}`);
    }
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec)) checkImport(spec.text, Boolean(node.isTypeOnly || node.importClause?.isTypeOnly));
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(tree) === 'require')) {
      if (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0])) errors.push('dynamic module loading belongs to the carrier');
      else checkImport(node.arguments[0].text);
    }
    if (plugin && !repository) {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && sqlStart.test(node.text)) errors.push('SQL outside repository/migrations');
      if (ts.isTaggedTemplateExpression(node) && node.tag.getText(tree) === 'sql') errors.push('SQL outside repository/migrations');
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return [...new Set(errors)];
}

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = [];
  for (const dir of ['src/plugins', 'src/plugin-runtime']) {
    for (const file of files(path.join(root, dir))) {
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (/\.(ts|tsx)$/.test(file) && !file.endsWith('.test.ts')) {
        for (const error of checkFile(relative, fs.readFileSync(file, 'utf8'))) violations.push(`${relative}: ${error}`);
      } else if (file.endsWith('.sql') && !/\/(repository|migrations)\//.test(relative)) violations.push(`${relative}: SQL outside repository/migrations`);
    }
  }
  if (violations.length) { console.error(violations.join('\n')); process.exitCode = 1; }
  else console.log('Plugin dependency and SQL boundaries passed');
}
