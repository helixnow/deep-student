// Runs only in a standalone Node process: TypeScript's synchronous checker must not block Vitest RPC.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DIRECTIVE = /^\s*\/\/ @ts-expect-error \[([a-z-]+)\]\s*$/;

function compilerOptions(configPath = path.join(root, 'tsconfig.json')) {
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  return ts.parseJsonConfigFileContent(config, ts.sys, root, undefined, configPath).options;
}

function createProgram(file, options, transformed, oldProgram) {
  const host = ts.createCompilerHost(options, true);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) => {
    if (transformed !== undefined && path.resolve(name) === file) return ts.createSourceFile(name, transformed, languageVersion, true);
    const previous = !shouldCreate && oldProgram?.getSourceFile(name);
    if (previous) return previous;
    return getSourceFile(name, languageVersion, onError, shouldCreate);
  };
  return ts.createProgram({ rootNames: [file], options, host, oldProgram });
}

// Only real single-line comment trivia, not template/string/JSDoc text.
function directives(source) {
  const comments = new Map();
  const visit = (node) => {
    if (ts.isJSDoc(node) || node.kind === ts.SyntaxKind.JsxText) return;
    const children = node.getChildren(source);
    if (children.length) children.forEach(visit);
    else for (const comment of ts.getLeadingCommentRanges(source.text, node.pos) ?? []) {
      if (comment.kind === ts.SyntaxKind.SingleLineCommentTrivia) comments.set(comment.pos, comment);
    }
  };
  visit(source);
  const expected = new Map();
  const ranges = [];
  const starts = source.getLineStarts();
  for (const comment of [...comments.values()].sort((a, b) => a.pos - b.pos)) {
    const line = source.getLineAndCharacterOfPosition(comment.pos).line;
    const match = DIRECTIVE.exec(source.text.slice(starts[line], starts[line + 1] ?? source.text.length));
    if (match) {
      expected.set(line + 2, match[1]);
      ranges.push(comment);
    }
  }
  let stripped = source.text;
  for (const { pos, end } of ranges.reverse()) {
    stripped = stripped.slice(0, pos) + ' '.repeat(end - pos) + stripped.slice(end);
  }
  return { expected, stripped };
}

const lineOf = (d) => d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1;
const describe = (d) =>
  `${d.file ? `${path.relative(root, d.file.fileName)}:${lineOf(d)}` : '<global>'} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;

function runTypeTest(file, configPath) {
  const options = compilerOptions(configPath);
  const cleanProgram = createProgram(file, options);
  const clean = ts.getPreEmitDiagnostics(cleanProgram).filter((d) => d.category === ts.DiagnosticCategory.Error);
  const { expected, stripped } = directives(cleanProgram.getSourceFile(file));
  const strippedProgram = createProgram(file, options, stripped, cleanProgram);
  // Only comments changed: retain every dependency/global diagnostic from the complete clean pass.
  const isRoot = (d) => !!d.file && path.resolve(d.file.fileName) === file;
  const strippedDiagnostics = [
    ...clean.filter((d) => !isRoot(d)),
    ...ts.getPreEmitDiagnostics(strippedProgram, strippedProgram.getSourceFile(file))
      .filter((d) => d.category === ts.DiagnosticCategory.Error && isRoot(d)),
  ];
  const errors = {};
  const unexpected = [];
  for (const d of ts.sortAndDeduplicateDiagnostics(strippedDiagnostics)) {
    const tag = d.file && path.resolve(d.file.fileName) === file ? expected.get(lineOf(d)) : undefined;
    if (!tag) unexpected.push(describe(d));
    else errors[tag] = [errors[tag], ts.flattenDiagnosticMessageText(d.messageText, '\n')].filter(Boolean).join('\n');
  }
  return {
    clean: clean.map(describe),
    tags: [...expected.values()],
    unexpected,
    missing: [...expected.values()].filter((tag) => !(tag in errors)),
    errors,
  };
}

function runOwnedTypecheck(rootNames) {
  const program = ts.createProgram({ rootNames, options: compilerOptions() });
  return ts.getPreEmitDiagnostics(program)
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .map((d) => `${d.file ? path.relative(root, d.file.fileName) : '<global>'} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
}

function runNodeConfigTypecheck(configPath) {
  const configErrors = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => configErrors.push(diagnostic),
  });
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, projectReferences: parsed.projectReferences });
  return {
    noEmit: parsed.options.noEmit,
    files: program.getSourceFiles().map((file) => path.relative(root, file.fileName).replace(/\\/g, '/')),
    errors: [...configErrors, ...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
      .filter((d) => d.category === ts.DiagnosticCategory.Error)
      .map((d) => `${d.file ? path.relative(root, d.file.fileName) : '<config>'} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`),
  };
}

try {
  const request = JSON.parse(process.argv[2]);
  let result;
  switch (request.kind) {
    case 'contract': result = runTypeTest(request.file, request.configPath); break;
    case 'owned': result = runOwnedTypecheck(request.rootNames); break;
    case 'node-config': result = runNodeConfigTypecheck(request.configPath); break;
    default: throw new Error(`Unknown typecheck request: ${request.kind}`);
  }
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
