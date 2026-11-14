// Read-only compiler probe: repository inputs come from a fixed git tree, while
// dependency reads are pinned in memory across fresh, non-incremental programs.
import ts from 'typescript';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { format } from 'node:util';

const cwd = process.cwd();
const revision = process.argv[3] ?? '0a51a244c';
const names = execFileSync('git', ['ls-tree', '-r', '--name-only', revision], {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
}).trim().split('\n').filter(file => /\.(?:[cm]?tsx?|json)$/.test(file));
const batch = execFileSync('git', ['cat-file', '--batch'], {
  input: names.map(file => `${revision}:${file}`).join('\n') + '\n', maxBuffer: 256 * 1024 * 1024,
});
const frozen = new Map();
let offset = 0;
for (const name of names) {
  const end = batch.indexOf(10, offset);
  const header = batch.subarray(offset, end).toString();
  const size = Number(header.split(' ').at(-1));
  if (!Number.isFinite(size)) throw new Error(header);
  frozen.set(path.join(cwd, name), batch.subarray(end + 1, end + 1 + size).toString());
  offset = end + size + 2;
}
const directories = new Map();
for (const file of frozen.keys()) {
  let child = file, parent = path.dirname(child);
  let isFile = true;
  while (child !== cwd && parent !== child) {
    if (!directories.has(parent)) directories.set(parent, { files: new Set(), directories: new Set() });
    directories.get(parent)[isFile ? 'files' : 'directories'].add(path.basename(child));
    child = parent; parent = path.dirname(child); isFile = false;
  }
}
const configHost = { ...ts.sys, readDirectory: (root, extensions, excludes, includes, depth) => ts.matchFiles(
  root, extensions, excludes, includes, ts.sys.useCaseSensitiveFileNames, cwd, depth,
  directory => {
    const entries = directories.get(path.resolve(directory));
    return { files: [...(entries?.files ?? [])].sort(), directories: [...(entries?.directories ?? [])].sort() };
  }, file => file,
) };
const parsed = ts.parseJsonConfigFileContent(JSON.parse(frozen.get(path.join(cwd, 'tsconfig.host.json'))), configHost, cwd);
if (parsed.errors.length) throw new Error('config errors');
const roots = parsed.fileNames;
const dependencies = new Map(), existence = new Map();
process.stdout.write(format('FIXED_INPUT %s typescript %s roots %d incremental=false\n', revision, ts.version, roots.length));
process.stdout.write(format('ROOT_ORDER %o\n', roots.slice(0, 5).map(file => path.relative(cwd, file))));
if (process.argv.length < 3 || process.argv.length > 4) throw new Error('Run one compiler variant per process to release the full compiler graph.');
for (const mode of process.argv.slice(2, 3)) {
  const overlay = new Map(frozen);
  const prefixes = {
    'native-api-type-import': 'host/platform/native/api.ts',
    'electron-api-type-import': 'electron/api.ts',
  };
  if (prefixes[mode]) {
    const file = path.join(cwd, prefixes[mode]);
    overlay.set(file, `import type { Context } from '@deepseek-ai/cordis';\n${overlay.get(file)}`);
  }
  if (mode === 'secrets-api-hoist') {
    const file = path.join(cwd, 'host/platform/secrets/api.ts');
    const declaration = "import type { Context } from '@deepseek-ai/cordis';";
    const text = overlay.get(file);
    if (text.split(declaration).length !== 2) throw new Error('Expected exactly one existing Context import');
    overlay.set(file, `${declaration}\n${text.replace(declaration, '')}`);
  }
  const host = ts.createCompilerHost({ ...parsed.options, incremental: false });
  const read = host.readFile.bind(host), exists = host.fileExists.bind(host);
  host.readFile = file => {
    const key = path.resolve(file);
    if (overlay.has(key)) return overlay.get(key);
    if (!dependencies.has(key)) dependencies.set(key, read(file));
    return dependencies.get(key);
  };
  host.fileExists = file => {
    const key = path.resolve(file);
    if (overlay.has(key)) return true;
    if (!existence.has(key)) existence.set(key, exists(file));
    return existence.get(key);
  };
  const program = ts.createProgram(roots, { ...parsed.options, incremental: false }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  process.stdout.write(format('MODE %s DIAGNOSTICS %d FILES %d\n', mode, diagnostics.length, new Set(diagnostics.map(d => d.file?.fileName)).size));
  for (const d of diagnostics.length < 30 ? diagnostics : diagnostics.slice(0, 3)) {
    const loc = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null;
    process.stdout.write(format('%s %s %d %s\n', d.file ? path.relative(cwd, d.file.fileName) : 'global',
      loc ? `${loc.line + 1}:${loc.character + 1}` : '', d.code, ts.flattenDiagnosticMessageText(d.messageText, '\n')));
  }
  const checker = program.getTypeChecker();
  for (const suffix of ['/@deepseek-ai/cordis/lib/types/index.d.ts', '/@deepseek-ai/cordis/lib/types/context.d.ts']) {
    const source = program.getSourceFiles().find(file => file.fileName.endsWith(suffix));
    const context = checker.getExportsOfModule(checker.getSymbolAtLocation(source)).find(symbol => symbol.name === 'Context');
    const target = context.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(context) : context;
    process.stdout.write(format('CONTEXT_SYMBOL %s declarations %d %o\n', suffix, target.declarations.length,
      target.declarations.slice(0, 8).map(d => d.getSourceFile().fileName)));
  }
}
