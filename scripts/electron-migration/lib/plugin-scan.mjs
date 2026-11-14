// 静态扫描 host/ 与 electron/ 中的插件声明与命令注册（不执行任何插件代码）：
//   - `definePlugin({ meta: { id, lane, commands: [...] } })`（commands 可为字面量数组或同文件 const 数组）；
//   - `<x>.commands.register('name', …)`：字面量命令名；
//   - 非字面量注册（如遍历处理函数表）：记为 dynamic，并收集同文件对象字面量的键作为候选命令名。
import ts from 'typescript';

function stringArray(node, consts) {
  if (!node) return null;
  let n = node;
  while (ts.isAsExpression(n) || ts.isSatisfiesExpression?.(n) || ts.isParenthesizedExpression(n)) n = n.expression;
  if (ts.isIdentifier(n) && consts.has(n.text)) return stringArray(consts.get(n.text), consts);
  if (!ts.isArrayLiteralExpression(n)) return null;
  const out = [];
  for (const e of n.elements) {
    if (ts.isStringLiteralLike(e)) out.push(e.text);
    else if (ts.isSpreadElement(e)) {
      const inner = stringArray(e.expression, consts);
      if (!inner) return null;
      out.push(...inner);
    } else return null;
  }
  return out;
}

function prop(obj, name) {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && ((ts.isIdentifier(p.name) && p.name.text === name) || (ts.isStringLiteral(p.name) && p.name.text === name))) return p.initializer;
  }
  return null;
}

/** 扫描单个文件。返回 { plugins: [{ id, lane, commands, line, unresolvedCommands }], registers: [{ command, line }], dynamicRegisters, objectKeys:Set }。 */
export function scanPluginFile(rel, text) {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const consts = new Map();
  const plugins = [];
  const registers = [];
  let dynamicRegisters = 0;
  const objectKeys = new Set();
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const collectConsts = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) consts.set(node.name.text, node.initializer);
    ts.forEachChild(node, collectConsts);
  };
  collectConsts(sf);
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === 'definePlugin' && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
        const meta = prop(node.arguments[0], 'meta');
        let m = meta;
        if (m && ts.isIdentifier(m) && consts.has(m.text)) m = consts.get(m.text);
        if (m && ts.isObjectLiteralExpression(m)) {
          const id = prop(m, 'id');
          const lane = prop(m, 'lane');
          const cmds = prop(m, 'commands');
          const list = cmds ? stringArray(cmds, consts) : [];
          plugins.push({
            id: id && ts.isStringLiteralLike(id) ? id.text : null,
            lane: lane && ts.isStringLiteralLike(lane) ? lane.text : null,
            commands: list ?? [],
            unresolvedCommands: list === null,
            line: line(node),
          });
        } else {
          plugins.push({ id: null, lane: null, commands: [], unresolvedCommands: true, line: line(node) });
        }
      }
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'register') {
        const target = callee.expression;
        const isCommands = (ts.isPropertyAccessExpression(target) && target.name.text === 'commands') || (ts.isIdentifier(target) && /commands$/i.test(target.text));
        if (isCommands) {
          const a = node.arguments[0];
          if (a && ts.isStringLiteralLike(a)) registers.push({ command: a.text, line: line(node) });
          else dynamicRegisters++;
        }
      }
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const p of node.properties) {
        const n = p.name;
        if (n && (ts.isIdentifier(n) || ts.isStringLiteral(n))) objectKeys.add(n.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { plugins, registers, dynamicRegisters, objectKeys };
}
