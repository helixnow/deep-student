import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export { ts };
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const read = (root, file) => fs.readFileSync(path.resolve(root, file), 'utf8');
export function files(root, dir) {
  const full = path.resolve(root, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(e =>
    e.isDirectory() ? files(root, `${dir}/${e.name}`) : e.isFile() ? [`${dir}/${e.name}`] : []);
}
export const pluginOf = file => file.match(/^host\/plugins\/([^/]+)\//)?.[1] ?? 'other';
export const production = file => /\.[cm]?[jt]sx?$/.test(file) && !/(^|\/)(tests?|__tests__|fixtures|__fixtures__)(\/|$)|\.(test|spec|d)\.[cm]?tsx?$/.test(file);
export const source = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
export function walk(node, fn) { fn(node); ts.forEachChild(node, child => { walk(child, fn); }); }
export const location = node => ({ file: node.getSourceFile().fileName, line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1 });
export function unwrap(n) {
  while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isTypeAssertionExpression(n) || ts.isNonNullExpression(n))) n = n.expression;
  return n;
}
export function options(argv) {
  const out = { root: ROOT, check: false, json: false, changed: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') out.check = true;
    else if (argv[i] === '--json') out.json = true;
    else if (argv[i] === '--root') out.root = path.resolve(argv[++i]);
    else if (argv[i] === '--changed') {
      out.changed = [];
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) out.changed.push(argv[++i]);
    } else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (out.changed) out.changed = out.changed.map(f => path.relative(out.root, path.resolve(out.root, f)).replaceAll('\\', '/'));
  return out;
}
export const selected = (opts, file) => opts.changed === null || opts.changed.includes(file);
export function report(gate, findings, extra = {}) {
  const byPlugin = {};
  for (const f of findings) byPlugin[f.plugin ?? pluginOf(f.file)] = (byPlugin[f.plugin ?? pluginOf(f.file)] ?? 0) + 1;
  return { gate, findings, summary: { count: findings.length, byPlugin }, ...extra };
}
export async function cli(url, run, { blocking = true } = {}) {
  if (!process.argv[1] || path.resolve(process.argv[1]) !== fileURLToPath(url)) return;
  try {
    const opts = options(process.argv.slice(2));
    const result = await run(opts);
    console.log(opts.json ? JSON.stringify(result, null, 2) : `${result.gate}: ${result.summary.count} findings\n${result.findings.map(f => `${f.file}:${f.line ?? 1} [${f.rule}] ${f.message}`).join('\n')}`);
    if (opts.check && blocking && result.findings.some(f => f.severity !== 'info')) process.exitCode = 1;
  } catch (e) { console.error(e.stack); process.exitCode = 2; }
}
