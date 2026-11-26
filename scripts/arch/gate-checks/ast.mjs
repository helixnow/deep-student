// 门禁共用的 TypeScript AST 小工具：具名函数识别、作用域内 const 解析、属性名。
import { ts } from './common.mjs';

export const isFunctionLike = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
export const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
export const hasExport = (n) => (ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Export) !== 0;

export function propName(p) {
  if (ts.isShorthandPropertyAssignment(p)) return p.name.text;
  if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.name) {
    if (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name) || ts.isNumericLiteral(p.name)) return p.name.text;
  }
  return null;
}

/** 最近的具名函数（声明、方法、赋给变量/属性的箭头函数）。 */
export function namedFunction(fn) {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) {
    const exported = ts.isFunctionDeclaration(fn) && hasExport(fn);
    return { name: fn.name.getText(), kind: ts.isMethodDeclaration(fn) ? 'method' : exported ? 'exported' : 'local' };
  }
  if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.parent) {
    const p = fn.parent;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
      const stmt = p.parent?.parent;
      return { name: p.name.text, kind: stmt && ts.isVariableStatement(stmt) && hasExport(stmt) ? 'exported' : 'local' };
    }
    if (ts.isPropertyAssignment(p) && p.name) return { name: p.name.getText(), kind: 'method' };
    if (ts.isPropertyDeclaration(p) && p.name) return { name: p.name.getText(), kind: 'method' };
  }
  return null;
}

export function enclosingFunctionNode(n) {
  for (let p = n.parent; p; p = p.parent) if (isFunctionLike(p)) return p;
  return null;
}

export function enclosingName(n) {
  for (let p = n.parent; p; p = p.parent) {
    if (!isFunctionLike(p)) continue;
    const named = namedFunction(p);
    if (named) return named.name;
  }
  return '<module>';
}

/** 向上逐层查找 const 声明（参数同名即视为遮蔽、不可静态解析）。 */
export function resolveConst(id) {
  const name = id.text;
  for (let p = id.parent; p; p = p.parent) {
    if (isFunctionLike(p) && p.parameters.some((x) => ts.isIdentifier(x.name) && x.name.text === name)) return null;
    const statements = ts.isSourceFile(p) || ts.isBlock(p) || ts.isModuleBlock(p) ? p.statements : ts.isCaseClause(p) || ts.isDefaultClause(p) ? p.statements : null;
    if (!statements) continue;
    for (const s of statements) {
      if (!ts.isVariableStatement(s) || !(s.declarationList.flags & ts.NodeFlags.Const)) continue;
      for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) return d.initializer ?? null;
    }
  }
  return null;
}
