import ts from 'typescript';
import path from 'node:path';
import fs from 'node:fs';
import { typeSchema, type Schema } from './schema.ts';

export type Kind = 'invoke' | 'listen' | 'once' | 'emit' | 'register' | 'host-emit' | 'host-listen';
interface Transport { kind: Kind; nameIndex: number; dataIndex: number; via: string; rawPayload?: boolean; reviewed?: boolean; payloadTransform?: string; boundShape?: Schema; boundTsType?: string }
export interface Site {
  file: string; line: number; column: number; kind: Kind; via: string;
  expression: string; names: string[]; dynamic: boolean; shape: Schema; tsType: string;
  nameIndex: number; dataIndex: number; test: boolean;
}
export interface Wrapper extends Transport { file: string; line: number; name: string }
export interface Scan { sites: Site[]; wrappers: Wrapper[]; forwarding: Site[]; candidates: { file: string; line: number; expression: string }[] }

export function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(e => e.isDirectory() ? walkFiles(path.join(dir, e.name)) : /\.[cm]?[jt]sx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [path.join(dir, e.name)] : []);
}

function unwrap(n: ts.Expression): ts.Expression {
  while (ts.isAsExpression(n) || ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n)) n = n.expression;
  return n;
}

export function scanProgram(program: ts.Program, root: string, scope: 'frontend' | 'host' = 'frontend'): Scan {
  const checker = program.getTypeChecker();
  const files = program.getSourceFiles().filter(f => !f.isDeclarationFile && (scope === 'frontend' ? path.relative(root, f.fileName).startsWith('src/') : /^(host|electron)\//.test(path.relative(root, f.fileName))));
  const calls: ts.CallExpression[] = [];
  const candidateNames = new Set(['invoke', 'listen', 'once', 'emit', 'emitTo', 'register']);
  const aliases: [string, string][] = [];
  for (const f of files) {
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) calls.push(n);
      if (ts.isImportSpecifier(n)) aliases.push([(n.propertyName ?? n.name).text, n.name.text]);
      if (ts.isBindingElement(n) && ts.isIdentifier(n.name)) aliases.push([(n.propertyName ?? n.name).getText(), n.name.text]);
      if ((ts.isVariableDeclaration(n) || ts.isParameter(n)) && ts.isIdentifier(n.name) && n.initializer) {
        const e = unwrap(n.initializer);
        if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) aliases.push([ts.isIdentifier(e) ? e.text : e.name.text, n.name.text]);
      }
      ts.forEachChild(n, visit);
    };
    visit(f);
  }
  const expandAliases = () => {
    let changed = true;
    while (changed) { changed = false; for (const [from, to] of aliases) if (candidateNames.has(from) && !candidateNames.has(to)) { candidateNames.add(to); changed = true; } }
  };
  expandAliases();
  const rel = (n: ts.Node) => path.relative(root, n.getSourceFile().fileName).replaceAll('\\', '/');
  const line = (n: ts.Node) => n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const symbol = (n: ts.Node): ts.Symbol | undefined => {
    let s = checker.getSymbolAtLocation(n);
    if (s?.flags && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
    return s;
  };
  const initializer = (n: ts.Expression): ts.Expression | undefined => {
    const s = symbol(ts.isPropertyAccessExpression(n) ? n.name : n);
    const d = s?.valueDeclaration;
    if (d && ts.isVariableDeclaration(d) && ts.isVariableDeclarationList(d.parent) && !(d.parent.flags & ts.NodeFlags.Const)) return;
    return d && (ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d) || ts.isPropertyDeclaration(d) || ts.isEnumMember(d)) ? d.initializer : undefined;
  };
  const names = (node: ts.Expression | undefined, seen = new Set<ts.Node>()): string[] => {
    if (!node || seen.has(node)) return ['{}'];
    node = unwrap(node); seen = new Set(seen).add(node);
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isTemplateExpression(node)) {
      let values = [node.head.text];
      for (const span of node.templateSpans) values = values.flatMap(p => names(span.expression, seen).map(v => p + v + span.literal.text)).slice(0, 100);
      return values;
    }
    if (ts.isConditionalExpression(node)) return [...new Set([...names(node.whenTrue, seen), ...names(node.whenFalse, seen)])];
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return names(node.left, seen).flatMap(a => names(node.right, seen).map(b => a + b)).slice(0, 100);
    if (ts.isElementAccessExpression(node)) {
      const init = initializer(node.expression);
      const object = init && unwrap(init);
      if (object && ts.isObjectLiteralExpression(object)) {
        const keys = names(node.argumentExpression, seen);
        const props = object.properties.filter(ts.isPropertyAssignment).filter(p => keys.includes('{}') || keys.includes(p.name.getText().replace(/^['"]|['"]$/g, '')));
        if (props.length) return [...new Set(props.flatMap(p => names(p.initializer, seen)))];
      }
    }
    if (ts.isCallExpression(node)) {
      const decl = checker.getResolvedSignature(node)?.declaration;
      if (decl && 'body' in decl && decl.body && ts.isBlock(decl.body as ts.Node)) {
        const statements = (decl.body as ts.Block).statements;
        const first = statements[0];
        if (statements.length === 1 && first && ts.isReturnStatement(first) && first.expression) return names(first.expression, seen);
      }
    }
    let init = initializer(node);
    if (ts.isPropertyAccessExpression(node)) {
      const receiver = unwrap(node.expression);
      const d = symbol(receiver)?.valueDeclaration;
      if (d && ts.isVariableDeclaration(d) && ts.isVariableDeclarationList(d.parent) && ts.isForOfStatement(d.parent.parent)) {
        const collection = initializer(d.parent.parent.expression);
        const array = collection && unwrap(collection);
        if (array && ts.isArrayLiteralExpression(array)) {
          const values = array.elements.flatMap(e => {
            const obj = unwrap(e);
            return ts.isObjectLiteralExpression(obj) ? obj.properties.filter(ts.isPropertyAssignment).filter(p => p.name.getText().replace(/^['"]|['"]$/g, '') === node.name.text).flatMap(p => names(p.initializer, seen)) : ['{}'];
          });
          if (values.length) return [...new Set(values)];
        }
      }
      // A synthetic property symbol for an array/union can point to just its
      // first element's initializer. Only fold a property of a known object.
      const object = initializer(receiver);
      if (!object || !ts.isObjectLiteralExpression(unwrap(object))) init = undefined;
    }
    if (init) return names(init, seen);
    const t = checker.getTypeAtLocation(node);
    if (t.isStringLiteral()) return [t.value];
    if (t.isUnion() && t.types.every(v => v.isStringLiteral())) return t.types.map(v => (v as ts.StringLiteralType).value);
    return ['{}'];
  };
  const wrappers = new Map<ts.Node, Transport>();
  const wrapperSymbols = new Map<ts.Symbol, Transport>();
  const wrapperList: Wrapper[] = [];
  // Reviewed indirection: eventHub stores eventName/handler in HubEntry before
  // ensureListening calls listen. There is no direct parameter-forwarding edge.
  // Evidence: eventHub.ts:106-117,153-157,171-184; HubHandler receives raw payload.
  if (scope === 'frontend') for (const f of files) if (['src/features/workbench/core/eventHub.ts', 'src/features/workbench/agent/domainEvents.ts'].includes(rel(f))) {
    for (const fn of f.statements) if (ts.isFunctionDeclaration(fn) && ['hubListen', 'hubListenKeyed', 'registerDomainListener'].includes(fn.name?.text ?? '')) {
      const w: Transport = { kind: 'listen', nameIndex: 0, dataIndex: fn.name!.text === 'hubListenKeyed' ? 2 : 1, via: fn.name!.text, rawPayload: true, reviewed: true };
      wrappers.set(fn, w);
      candidateNames.add(w.via);
      const s = symbol(fn.name!); if (s) wrapperSymbols.set(s, w);
      wrapperList.push({ ...w, file: rel(fn), line: line(fn), name: w.via });
    }
  }
  const nearestFunction = (n: ts.Node): ts.FunctionLikeDeclaration | undefined => {
    for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p) && 'body' in p) return p as ts.FunctionLikeDeclaration;
  };
  const callsByFunction = new Map<ts.FunctionLikeDeclaration, ts.CallExpression[]>();
  for (const call of calls) { const fn = nearestFunction(call); if (fn) { const group = callsByFunction.get(fn) ?? []; group.push(call); callsByFunction.set(fn, group); } }
  const moduleOf = (n: ts.Node): string => {
    for (let p: ts.Node | undefined = n; p; p = p.parent) {
      if (ts.isImportDeclaration(p) && ts.isStringLiteral(p.moduleSpecifier)) return p.moduleSpecifier.text;
      if (ts.isVariableDeclaration(p) && p.initializer) {
        const text = p.initializer.getText();
        const m = text.match(/import\(['"]([^'"]+)['"]\)/); if (m?.[1]) return m[1];
        let e = unwrap(p.initializer);
        if (ts.isAwaitExpression(e)) e = unwrap(e.expression);
        if (ts.isCallExpression(e)) {
          const factory = checker.getResolvedSignature(e)?.declaration;
          const imported = factory?.getText().match(/import\(['"](@tauri-apps\/api\/(?:event|core))['"]\)/);
          if (imported?.[1]) return imported[1];
        }
      }
      if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && p.expression.name.text === 'then') {
        const imported = p.expression.expression.getText().match(/^import\(['"]([^'"]+)['"]\)$/);
        if (imported?.[1]) return imported[1];
      }
    }
    return '';
  };
  const transport = (call: ts.CallExpression): Transport | undefined => {
    const expr = unwrap(call.expression);
    const short = ts.isPropertyAccessExpression(expr) ? expr.name.text : expr.getText();
    // Pure AST candidate closure (including aliases) avoids asking the TS checker
    // to instantiate every unrelated React/editor/library call in the project.
    if (!candidateNames.has(short)) return;
    const s = symbol(ts.isPropertyAccessExpression(expr) ? expr.name : expr);
    if (s && wrapperSymbols.has(s)) return wrapperSymbols.get(s);
    // Resolving every React/library call signature forces semantic checking of
    // the entire application. Only wrapper-shaped aliases need that fallback.
    const valueDecl = s?.valueDeclaration;
    if (wrappers.size && (wrapperList.some(w => w.name === short) || valueDecl && (ts.isVariableDeclaration(valueDecl) || ts.isBindingElement(valueDecl) || ts.isPropertyAssignment(valueDecl)))) {
      const decl = checker.getResolvedSignature(call)?.declaration;
      if (decl && wrappers.has(decl)) return wrappers.get(decl);
    }
    if (scope === 'host') {
      if (!ts.isPropertyAccessExpression(expr)) return;
      if (!['register', 'emit', 'emitTo', 'listen'].includes(short)) return;
      const receiver = expr.expression;
      const receiverType = checker.typeToString(checker.getTypeAtLocation(receiver));
      if (short === 'register' && (/commands/.test(receiver.getText()) || /CommandRegistry|CommandService/.test(receiverType))) return { kind: 'register', nameIndex: 0, dataIndex: 1, via: expr.getText() };
      if (/backendEvents/.test(receiver.getText()) || /BackendEvents|BackendEventService/.test(receiverType)) {
        if (short === 'emit' || short === 'emitTo') return { kind: 'host-emit', nameIndex: short === 'emitTo' ? 1 : 0, dataIndex: short === 'emitTo' ? 2 : 1, via: expr.getText() };
        if (short === 'listen') return { kind: 'host-listen', nameIndex: 0, dataIndex: 1, via: expr.getText() };
      }
      return;
    }
    let imported = '';
    let origin = expr;
    const aliasSeen = new Set<ts.Node>();
    while (!aliasSeen.has(origin)) {
      aliasSeen.add(origin);
      const d = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(origin) ? origin.name : origin)?.valueDeclaration;
      if (!d || !(ts.isVariableDeclaration(d) || ts.isParameter(d) || ts.isPropertyAssignment(d)) || !d.initializer) break;
      const value = unwrap(d.initializer);
      if (!ts.isIdentifier(value) && !ts.isPropertyAccessExpression(value)) break;
      origin = value;
    }
    let originalName = ts.isPropertyAccessExpression(origin) ? origin.name.text : origin.getText();
    // Static import aliases and `const { invoke: alias } = await import(...)`.
    const local = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(origin) ? origin.name : origin);
    for (const d of local?.declarations ?? []) {
      imported ||= moduleOf(d);
      if (ts.isImportSpecifier(d)) originalName = (d.propertyName ?? d.name).text;
      if (ts.isBindingElement(d)) originalName = (d.propertyName ?? d.name).getText();
    }
    if (ts.isPropertyAccessExpression(origin)) {
      const rs = checker.getSymbolAtLocation(origin.expression);
      for (const d of rs?.declarations ?? []) imported ||= moduleOf(d);
      if (/__TAURI(?:_INTERNALS__|__)|tauri\.core|tauri\.event/.test(origin.getText())) imported ||= '@tauri-apps/api/core';
    }
    for (const d of s?.declarations ?? []) {
      if (/node_modules\/@tauri-apps\/api\/(?:core|event|window|webviewWindow)\.d\.ts$/.test(d.getSourceFile().fileName)) imported ||= '@tauri-apps/api/core';
    }
    const callSignature = checker.getResolvedSignature(call);
    const calledFile = callSignature?.declaration?.getSourceFile().fileName ?? '';
    if (/node_modules\/@tauri-apps\/api\/(?:core|event|window|webviewWindow)\.d\.ts$/.test(calledFile)) {
      imported ||= '@tauri-apps/api/core';
      const declaration = callSignature?.declaration;
      originalName = declaration && 'name' in declaration ? declaration.name?.getText() ?? originalName : originalName;
    }
    if (imported.startsWith('@tauri-apps/') && ['invoke', 'listen', 'once', 'emit', 'emitTo'].includes(originalName)) return { kind: originalName === 'emitTo' ? 'emit' : originalName as Kind, nameIndex: originalName === 'emitTo' ? 1 : 0, dataIndex: originalName === 'emitTo' ? 2 : 1, via: expr.getText() };
    // Injectable invoke props use the same wire signature (ParamsTab, automation summaries).
    const promiseReturn = callSignature && /Promise</.test(checker.typeToString(checker.getReturnTypeOfSignature(callSignature)));
    if (short === 'invoke' && promiseReturn && !s?.declarations?.some(d => /crepe/.test(d.getSourceFile().fileName))) return { kind: 'invoke', nameIndex: 0, dataIndex: 1, via: expr.getText() };
    if (['listen', 'once'].includes(short) && promiseReturn && call.arguments[0] && names(call.arguments[0]).every(n => n.startsWith('tauri://'))) return { kind: short as Kind, nameIndex: 0, dataIndex: 1, via: expr.getText() };
  };
  const parameterIndex = (fn: ts.FunctionLikeDeclaration, expr: ts.Expression | undefined): number => {
    if (!expr) return -1;
    expr = unwrap(expr);
    if (!ts.isIdentifier(expr)) return -1;
    const s = symbol(expr);
    return fn.parameters.findIndex(p => symbol(p.name) === s);
  };
  // Fixed point over forwarding functions; argument offsets are inferred, never guessed from wrapper names.
  let changed = true;
  while (changed) {
    changed = false;
    for (const call of calls) {
      const t = transport(call); if (!t) continue;
      const fn = nearestFunction(call); if (!fn || wrappers.has(fn)) continue;
      const ni = parameterIndex(fn, call.arguments[t.nameIndex]); if (ni < 0) continue;
      const data = call.arguments[t.dataIndex];
      // Prefer a forwarded args branch over invoke(command) in wrappers like
      // invokeBrowser's args===undefined ? invoke(command) : invoke(command,args).
      if (!data && callsByFunction.get(fn)?.some(other => other !== call && other.arguments[t.dataIndex] && parameterIndex(fn, other.arguments[t.nameIndex]) === ni && transport(other)?.kind === t.kind)) continue;
      let di = parameterIndex(fn, data);
      const extra: Partial<Transport> = {};
      if (di < 0 && data) {
        const refs = new Set<number>();
        const visit = (n: ts.Node) => { if (ts.isIdentifier(n)) { const i = parameterIndex(fn, n); if (i >= 0) refs.add(i); } ts.forEachChild(n, visit); };
        visit(data);
        const firstRef = refs.values().next().value;
        if (refs.size === 1 && firstRef !== undefined) { di = firstRef; extra.payloadTransform = data.getText(); }
        else {
          let type: ts.Type | undefined = checker.getTypeAtLocation(data);
          if (['listen', 'once'].includes(t.kind)) {
            if (call.typeArguments?.[0]) type = checker.getTypeFromTypeNode(call.typeArguments[0]);
            else {
              const p = checker.getSignaturesOfType(type, ts.SignatureKind.Call)[0]?.parameters[0];
              const event = p && checker.getTypeOfSymbolAtLocation(p, data);
              const payload = event && checker.getPropertyOfType(event, 'payload');
              type = payload ? checker.getTypeOfSymbolAtLocation(payload, data) : undefined;
            }
          }
          extra.boundShape = type ? typeSchema(checker, type, data) : { 'x-ts': 'unknown' };
          extra.boundTsType = type ? checker.typeToString(type, data, ts.TypeFormatFlags.NoTruncation) : 'unknown';
        }
      }
      const w = { ...t, ...extra, nameIndex: ni, dataIndex: di, via: fn.name?.getText() ?? (ts.isVariableDeclaration(fn.parent) || ts.isPropertyAssignment(fn.parent) ? fn.parent.name.getText() : '<callback>') };
      wrappers.set(fn, w);
      candidateNames.add(w.via);
      if (fn.name) { const s = symbol(fn.name); if (s) wrapperSymbols.set(s, w); }
      if (ts.isVariableDeclaration(fn.parent)) { const s = symbol(fn.parent.name); if (s) wrapperSymbols.set(s, w); }
      wrapperList.push({ ...w, file: rel(fn), line: line(fn), name: w.via }); changed = true;
    }
    expandAliases();
  }
  const sites: Site[] = [], forwarding: Site[] = [], candidates: Scan['candidates'] = [];
  for (const call of calls) {
    const t = transport(call);
    if (!t) {
      if (/^(invoke|listen|once|emit)$/.test(ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : call.expression.getText())) candidates.push({ file: rel(call), line: line(call), expression: call.expression.getText() });
      continue;
    }
    const nameExpr = call.arguments[t.nameIndex]; if (!nameExpr) continue;
    const data = call.arguments[t.dataIndex];
    let type: ts.Type | undefined;
    if (data) {
      type = checker.getTypeAtLocation(data);
      if (['listen', 'once', 'host-listen', 'register'].includes(t.kind)) {
        const sig = checker.getSignaturesOfType(type, ts.SignatureKind.Call)[0];
        const p = sig?.parameters[0]; type = p ? checker.getTypeOfSymbolAtLocation(p, data) : undefined;
        if (type && ['listen', 'once'].includes(t.kind) && !t.rawPayload) {
          const payload = checker.getPropertyOfType(type, 'payload');
          type = payload ? checker.getTypeOfSymbolAtLocation(payload, data) : undefined;
        }
      }
    }
    if (['listen', 'once'].includes(t.kind) && call.typeArguments?.[0]) type = checker.getTypeFromTypeNode(call.typeArguments[0]);
    const found = [...new Set(names(nameExpr))].sort();
    const pos = call.getSourceFile().getLineAndCharacterOfPosition(call.getStart());
    const file = rel(call);
    const site: Site = { file, line: pos.line + 1, column: pos.character + 1, ...t, expression: nameExpr.getText(), names: found, dynamic: found.some(n => n.includes('{}')), shape: type ? typeSchema(checker, type, data ?? call) : (t.kind === 'invoke' ? { type: 'object', properties: {}, required: [] } : { 'x-ts': 'unknown' }), tsType: type ? checker.typeToString(type, data, ts.TypeFormatFlags.NoTruncation) : 'unknown', test: /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|tests)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) };
    if (t.boundShape) { site.shape = t.boundShape; site.tsType = t.boundTsType ?? 'unknown'; }
    if (t.payloadTransform) site.shape = { ...site.shape, 'x-open': true, 'x-transform': t.payloadTransform };
    const fn = nearestFunction(call);
    if (fn && wrappers.has(fn) && parameterIndex(fn, nameExpr) >= 0 || file === 'src/features/workbench/core/eventHub.ts' && nameExpr.getText() === 'entry.eventName') forwarding.push(site); else sites.push(site);
  }
  return { sites, wrappers: wrapperList.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line), forwarding, candidates };
}

export function createProgram(root: string): ts.Program {
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  return ts.createProgram([...walkFiles(path.join(root, 'src')), ...walkFiles(path.join(root, 'host')), ...walkFiles(path.join(root, 'electron'))], { ...parsed.options, strictNullChecks: true, noEmit: true, incremental: false });
}

/** Shell plugin commands are routed in Electron main, not the Host profile.
 * Read actual registerPlugin(factory()) AST edges; do not import electron/main.ts.
 */
export function shellRoutes(program: ts.Program, root: string): { command: string; file: string; line: number }[] {
  const checker = program.getTypeChecker();
  const main = program.getSourceFile(path.join(root, 'electron/main.ts'));
  if (!main) return [];
  const out: ReturnType<typeof shellRoutes> = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'registerPlugin' && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && n.arguments[1] && ts.isCallExpression(n.arguments[1])) {
      const plugin = n.arguments[0].text;
      const decl = checker.getResolvedSignature(n.arguments[1])?.declaration;
      if (decl && 'body' in decl && decl.body) {
        const find = (node: ts.Node) => {
          if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(unwrap(node.expression))) {
            for (const prop of (unwrap(node.expression) as ts.ObjectLiteralExpression).properties) if (prop.name && !ts.isComputedPropertyName(prop.name)) {
              out.push({ command: `plugin:${plugin}|${prop.name.getText().replace(/^['"]|['"]$/g, '')}`, file: path.relative(root, prop.getSourceFile().fileName), line: prop.getSourceFile().getLineAndCharacterOfPosition(prop.getStart()).line + 1 });
            }
          }
          if (node !== decl.body && ts.isFunctionLike(node)) return;
          ts.forEachChild(node, find);
        };
        find(decl.body as ts.Node);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(main);
  return out.sort((a, b) => a.command.localeCompare(b.command));
}
