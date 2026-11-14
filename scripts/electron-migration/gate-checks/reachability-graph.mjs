import path from 'node:path';
import { files, production, ts } from './common.mjs';

const functionBody = n => (ts.isFunctionLike(n) && n.body) || ts.isFunctionDeclaration(n) && n.body;
const unit = n => functionBody(n) || ts.isVariableDeclaration(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n) || ts.isPropertyDeclaration(n) || ts.isSourceFile(n) || ts.isExportAssignment(n);
const typeOnly = n => ts.isTypeNode(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isImportDeclaration(n) || ts.isExportDeclaration(n);

// Symbol-resolved value/call graph. Function declarations are not edges merely because
// they share a file. Construction reaches constructor/initializers, publication exposes
// public methods, and direct calls reach the resolved method implementation.
export function graph(root) {
  const names = [...files(root, 'host'), ...files(root, 'contracts/ipc/generated')].filter(f => /\.tsx?$/.test(f));
  const compilerOptions = { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noLib: true, types: [], skipLibCheck: true, allowImportingTsExtensions: true };
  const host = ts.createCompilerHost(compilerOptions);
  host.resolveModuleNames = (specifiers, containing) => specifiers.map(s => {
    if (!s.startsWith('.')) return undefined;
    const base = path.resolve(path.dirname(containing), s);
    const file = [base, `${base}.ts`, path.join(base, 'index.ts')].find(f => host.fileExists(f));
    return file ? { resolvedFileName: file, extension: ts.Extension.Ts } : undefined;
  });
  const program = ts.createProgram(names.map(f => path.join(root, f)), compilerOptions, host);
  const checker = program.getTypeChecker();
  const rel = n => path.relative(root, n.getSourceFile().fileName).replaceAll('\\', '/');
  const edges = new Map(), publications = new Map(), dynamic = new Set();
  function symbol(n) {
    let s = checker.getSymbolAtLocation(n);
    if (s?.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
    return s;
  }
  function declarations(n) {
    return (symbol(n)?.declarations ?? []).filter(d => unit(d) && !d.getSourceFile().isDeclarationFile);
  }
  function members(expr, seen = new Set()) {
    const type = checker.getTypeAtLocation(expr);
    if (seen.has(type)) return [];
    seen.add(type);
    return checker.getPropertiesOfType(type).flatMap(s => s.declarations ?? []).filter(d =>
      rel(d).startsWith('host/plugins/') && !d.modifiers?.some(m => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword) && !(d.name && ts.isPrivateIdentifier(d.name)))
      .flatMap(d => functionBody(d) ? [d] : ts.isPropertyDeclaration(d) || ts.isPropertyAssignment(d) ? [d, ...members(d, seen)] : []);
  }
  function refs(n, set, owner, publish = false) {
    if (!n || typeOnly(n)) return;
    if (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) return;
    if (functionBody(n)) { set.add(n); return; }
    if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) {
      for (const d of declarations(ts.isPropertyAccessExpression(n) ? n.name : n)) if (d !== owner) set.add(d);
    }
    if (publish) for (const d of members(n)) set.add(d);
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const method = ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : '';
      const receiver = ts.isPropertyAccessExpression(n.expression) ? n.expression.expression.getText() : '';
      const registration = method === 'register' && /commands$/.test(receiver);
      const provided = method === 'provide';
      if (registration || provided) {
        const payload = n.arguments?.[1];
        if (payload) {
          const values = new Set(); refs(payload, values, owner, provided);
          if (!publications.has(owner)) publications.set(owner, new Set());
          for (const v of values) publications.get(owner).add(v);
        }
      }
      const resolved = checker.getResolvedSignature(n)?.declaration;
      if (resolved && functionBody(resolved)) set.add(resolved);
      else if (!registration && !provided && (ts.isElementAccessExpression(n.expression) || n.expression.kind === ts.SyntaxKind.ImportKeyword || resolved && ts.isMethodSignature(resolved))) dynamic.add(owner);
    }
    ts.forEachChild(n, c => { refs(c, set, owner); });
  }
  function outgoing(n) {
    if (edges.has(n)) return edges.get(n);
    const set = new Set(); edges.set(n, set);
    if (functionBody(n)) refs(n.body, set, n);
    else if (ts.isVariableDeclaration(n) || ts.isPropertyDeclaration(n)) refs(n.initializer, set, n);
    else if (ts.isExportAssignment(n)) refs(n.expression, set, n);
    else if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
      for (const member of n.members) if (ts.isConstructorDeclaration(member) || ts.isPropertyDeclaration(member)) set.add(member);
      // Cordis Service constructor super(ctx, serviceName) publishes the instance.
      const publishes = n.heritageClauses?.some(c => c.token === ts.SyntaxKind.ExtendsKeyword && c.types.some(t => /(?:^|\.)Service$/.test(t.expression.getText()))) && n.members.some(m => ts.isConstructorDeclaration(m) && /super\s*\(\s*ctx\s*,/.test(m.getText()));
      if (publishes) {
        publications.set(n, new Set(members(n)));
      }
    } else if (ts.isSourceFile(n)) {
      for (const statement of n.statements) {
        if (ts.isExportAssignment(statement)) set.add(statement);
        else if (ts.isExpressionStatement(statement)) refs(statement.expression, set, n);
      }
    }
    return set;
  }
  function closure(roots) {
    const seen = new Set(), queue = [...roots];
    while (queue.length) {
      const n = queue.pop(); if (!n || seen.has(n)) continue;
      seen.add(n); queue.push(...outgoing(n));
      if (publications.has(n)) queue.push(...publications.get(n));
    }
    return seen;
  }
  function plugin(plugin) {
    const sf = program.getSourceFile(path.join(root, `host/plugins/${plugin}/index.ts`));
    if (!sf) return { reachable: new Set(), initialization: new Set(), dynamic: true };
    const initialization = closure([sf]);
    const roots = [...initialization].flatMap(n => [...(publications.get(n) ?? [])]);
    const reachable = closure(roots);
    const loadedFiles = new Set();
    const load = sourceFile => {
      if (!sourceFile || loadedFiles.has(rel(sourceFile))) return;
      loadedFiles.add(rel(sourceFile));
      for (const s of sourceFile.statements) if ((ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) && s.moduleSpecifier && !(s.importClause?.isTypeOnly || s.isTypeOnly)) {
        const target = symbol(s.moduleSpecifier)?.declarations?.find(ts.isSourceFile);
        if (target) load(target);
      }
    };
    load(sf);
    return { reachable, initialization, loadedFiles, dynamic: [...initialization].some(n => dynamic.has(n)), roots: roots.length };
  }
  function testedSymbols(testFile) {
    const sf = program.getSourceFile(path.join(root, testFile));
    if (!sf) return [];
    const out = [];
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
      const clause = statement.importClause;
      const imports = [...(clause?.name ? [clause.name] : []), ...(clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements.filter(e => !e.isTypeOnly).map(e => e.name) : [])];
      for (const binding of imports) {
        const targets = declarations(binding).filter(d => production(rel(d)) && rel(d).startsWith('host/plugins/'));
        if (!targets.length) continue;
        // An unused import is not a tested symbol.
        const uses = [];
        const visit = n => {
          if (ts.isImportDeclaration(n) || typeOnly(n)) return;
          if (ts.isIdentifier(n) && n.text === binding.text && symbol(n) === symbol(binding)) uses.push(n.getStart(sf));
          ts.forEachChild(n, visit);
        };
        visit(sf);
        if (uses.length) out.push({ name: binding.text, targets, uses, file: rel(targets[0]), line: targets[0].getSourceFile().getLineAndCharacterOfPosition(targets[0].getStart()).line + 1 });
      }
    }
    return out;
  }
  return { program, checker, plugin, testedSymbols, rel };
}
