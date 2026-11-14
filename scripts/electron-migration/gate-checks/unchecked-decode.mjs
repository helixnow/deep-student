import { ROOT, cli, files, location, production, read, report, selected, source, ts, unwrap, walk } from './common.mjs';

const assertion = n => ts.isAsExpression(n) || ts.isTypeAssertionExpression(n);
const jsonParse = n => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.getText() === 'JSON' && n.expression.name.text === 'parse';

/** Name of the innermost named function/method/variable-bound function enclosing `n`. */
function enclosingFunction(n) {
  for (let p = n.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) {
      const cls = ts.isMethodDeclaration(p) && p.parent && ts.isClassLike(p.parent) && p.parent.name ? `${p.parent.name.text}.` : '';
      return cls + p.name.getText();
    }
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) return p.parent.name.text;
  }
  return null;
}

export function scan(file, text) {
  const sf = source(file, text), findings = [];
  const emit = (n, rule, severity, message) => findings.push({ ...location(n), rule, severity, function: enclosingFunction(n), expression: normalize(n.getText(sf)), message });
  walk(sf, n => {
    if (assertion(n)) {
      const inner = (() => { let x = n.expression; while (ts.isParenthesizedExpression(x)) x = x.expression; return x; })();
      if (assertion(inner) && inner.type.kind === ts.SyntaxKind.UnknownKeyword && n.type.kind !== ts.SyntaxKind.UnknownKeyword) {
        // Direction is not decidable here: inbound decode bypass and outbound/internal
        // type-widening look identical. Reported for review, never blocks.
        const parsed = jsonParse(unwrap(inner.expression));
        emit(n, parsed ? 'json-parse-assertion' : 'double-assertion', parsed ? 'error' : 'info',
          parsed ? 'unchecked-assertion syntax risk: JSON.parse result asserted (via unknown) to a type; whether a later decoder validates it needs human review'
            : 'as unknown as: type-assertion risk candidate; direction (inbound decode vs outbound/internal) needs review');
      } else if (n.type.kind !== ts.SyntaxKind.UnknownKeyword && jsonParse(unwrap(n.expression))) {
        emit(n, 'json-parse-assertion', 'error', 'unchecked-assertion syntax risk: JSON.parse result asserted to a type; whether a later decoder validates it needs human review (removing `as` alone does not fix it)');
      }
    }
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
    const method = n.expression.name.text, receiver = n.expression.expression.getText();
    // ctx.commands.register is contract-decoded by host/kernel/commands.ts before invocation.
    // Raw Electron IPC and kernel-private registrations have no such guarantee.
    const raw = /(?:^|\.)ipcMain$/.test(receiver) && ['handle', 'handleOnce', 'on', 'once'].includes(method);
    const kernel = method === '_registerKernel';
    if (!raw && !kernel) return;
    const handler = n.arguments[1];
    if (!handler || !(ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) return;
    const parameter = handler.parameters[raw ? 1 : 0];
    if (!parameter) return;
    if (ts.isObjectBindingPattern(parameter.name) || ts.isArrayBindingPattern(parameter.name)) {
      emit(parameter, 'raw-ipc-destructure', 'error', 'raw IPC parameter destructured before a decoder can run');
      return;
    }
    if (!handler.body || !ts.isBlock(handler.body)) return;
    // Only straight-line direct destructures. Stop at control flow or calls that might validate
    // the raw argument; unknown validators are not certified, but are not false-positive errors.
    for (const statement of handler.body.statements) {
      if (!ts.isVariableStatement(statement)) break;
      let stop = false;
      for (const d of statement.declarationList.declarations) {
        if (!d.initializer) continue;
        const value = unwrap(d.initializer);
        if ((ts.isObjectBindingPattern(d.name) || ts.isArrayBindingPattern(d.name)) && ts.isIdentifier(value) && value.text === parameter.name.getText()) {
          emit(d, 'raw-ipc-destructure', 'error', 'raw IPC argument destructured without decoding');
        }
        if (ts.isCallExpression(value)) stop = true;
      }
      if (stop) break;
    }
  });
  return findings;
}

const normalize = s => s.replace(/\s+/g, ' ').trim();

/**
 * Approvals bind one reviewable assertion: exact file + enclosing function + rule + the
 * asserted expression's source text (whitespace-normalized), at most `sites` (default 1)
 * occurrences. A new or edited parse in the same function or file is still reported.
 */
export function loadApprovals(text) {
  const approvals = JSON.parse(text).approvals;
  for (const a of approvals) {
    if (!a.path || !a.function || !a.rule || !a.expression || !a.approvedBy || !a.evidence || /[*?]/.test(a.path + a.function)) {
      throw new Error('Decoder approvals require exact path, function, rule, expression, approvedBy and evidence');
    }
  }
  return approvals;
}
export function applyApprovals(findings, approvals, used = new Map()) {
  return findings.filter(f => {
    const a = approvals.find(x => x.path === f.file && x.function === f.function && x.rule === f.rule && normalize(x.expression) === f.expression);
    if (!a) return true;
    const n = (used.get(a) ?? 0) + 1;
    used.set(a, n);
    return n > (a.sites ?? 1);
  });
}
export function run(opts) {
  const approvals = loadApprovals(read(ROOT, 'scripts/electron-migration/gate-checks/approved-decoders.json'));
  const scanned = files(opts.root, 'host/plugins').filter(f => production(f) && selected(opts, f));
  const used = new Map();
  const findings = applyApprovals(scanned.flatMap(f => scan(f, read(opts.root, f))), approvals, used);
  // An approval matching nothing in a scanned file is stale (the assertion was fixed or edited).
  const staleApprovals = approvals.filter(a => scanned.includes(a.path) && !used.has(a)).map(a => ({ path: a.path, function: a.function, expression: a.expression }));
  const byRule = {};
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  return report('unchecked-decode', findings, { scannedFiles: scanned.length, byRule, approvals, staleApprovals, limits: [
    'json-parse-assertion / raw-ipc-destructure are inbound-decode candidates (severity error).',
    'double-assertion is a type-assertion risk candidate (severity info): direction is not decided statically; outbound/internal widening is reported too.',
    'Raw IPC: inline callbacks and straight-line direct destructures only; indirect handlers/guards need review.',
    'Kernel commands.register input is decoded by the kernel contract; nested persisted JSON still needs a decoder.',
  ] });
}
await cli(import.meta.url, run);
