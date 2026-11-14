import fs from 'node:fs'; import ts from 'typescript';
for (const f of process.argv.slice(2)) {
  const sf = ts.createSourceFile(f, fs.readFileSync(f,'utf8'), ts.ScriptTarget.Latest, true);
  const visit = (n) => {
    if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
      const ctor = n.members.find(ts.isConstructorDeclaration);
      if (ctor?.body) {
        const assigned = new Set(ctor.body.statements.filter(s=>ts.isExpressionStatement(s)&&ts.isBinaryExpression(s.expression)&&ts.isPropertyAccessExpression(s.expression.left)&&s.expression.left.expression.kind===ts.SyntaxKind.ThisKeyword).map(s=>s.expression.left.name.text));
        for (const m of n.members) if (ts.isPropertyDeclaration(m) && m.initializer && !(ts.getModifiers(m)??[]).some(x=>x.kind===ts.SyntaxKind.StaticKeyword)) {
          const txt = m.initializer.getText(sf);
          for (const a of assigned) if (new RegExp(`\\bthis\\.${a}\\b`).test(txt)) console.log(`${f}:${sf.getLineAndCharacterOfPosition(m.getStart(sf)).line+1} ${m.name.getText(sf)} uses this.${a}`);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
