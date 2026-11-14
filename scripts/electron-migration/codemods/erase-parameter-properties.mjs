#!/usr/bin/env node
// 把 TS 构造函数参数属性（constructor(private readonly x: T)）改写为可擦除语法：
//   显式字段声明 + 构造函数内赋值（位于 super(...) 之后）。
// Node 的类型擦除（strip-only，Host 的运行方式）不支持参数属性。
//
//   node scripts/electron-migration/codemods/erase-parameter-properties.mjs <file...>
import fs from 'node:fs';
import ts from 'typescript';

const MOD_KINDS = new Set([
  ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.ProtectedKeyword,
  ts.SyntaxKind.ReadonlyKeyword, ts.SyntaxKind.OverrideKeyword,
]);

function rewrite(file) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits = []; // { start, end, insert }
  const visit = (node) => {
    if (ts.isConstructorDeclaration(node) && node.body) {
      const props = node.parameters.filter((p) => (ts.getModifiers(p) ?? []).some((m) => MOD_KINDS.has(m.kind)));
      if (props.length) {
        const classIndent = /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', node.getStart(sf)) + 1))[0];
        const decls = [];
        const assigns = [];
        for (const p of props) {
          const mods = ts.getModifiers(p).filter((m) => MOD_KINDS.has(m.kind));
          const name = p.name.getText(sf);
          const type = p.type ? `: ${p.type.getText(sf)}` : '';
          const q = p.questionToken ? '?' : '';
          decls.push(`${classIndent}${mods.map((m) => m.getText(sf)).join(' ')} ${name}${q}${type};`);
          assigns.push(name);
          // 删除参数上的修饰符（含其后的空白）
          for (const m of mods) {
            let end = m.getEnd();
            while (/\s/.test(text[end])) end++;
            edits.push({ start: m.getStart(sf), end, insert: '' });
          }
        }
        // 字段声明插在构造函数之前
        const ctorLineStart = text.lastIndexOf('\n', node.getStart(sf)) + 1;
        const jsdoc = ts.getJSDocCommentsAndTags(node);
        const declAt = jsdoc.length ? text.lastIndexOf('\n', jsdoc[0].getStart(sf)) + 1 : ctorLineStart;
        edits.push({ start: declAt, end: declAt, insert: `${decls.join('\n')}\n\n` });
        // 赋值插在 super(...) 之后，否则在函数体开头
        const stmts = node.body.statements;
        const superStmt = stmts.find((s) => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && s.expression.expression.kind === ts.SyntaxKind.SuperKeyword);
        const bodyIndent = `${classIndent}  `;
        const lines = assigns.map((n) => `${bodyIndent}this.${n} = ${n};`).join('\n');
        if (superStmt) {
          edits.push({ start: superStmt.getEnd(), end: superStmt.getEnd(), insert: `\n${lines}` });
        } else {
          const open = node.body.getStart(sf) + 1;
          edits.push({ start: open, end: open, insert: `\n${lines}` });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!edits.length) return false;
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  for (const e of edits) out = out.slice(0, e.start) + e.insert + out.slice(e.end);
  fs.writeFileSync(file, out);
  return true;
}

let n = 0;
for (const f of process.argv.slice(2)) if (rewrite(f)) n++;
console.log(`rewrote ${n} file(s)`);
