/** Every original App hook/effect must retain a concrete source destination. */
import ts from 'typescript';
import fs from 'node:fs';
import { expect, it } from 'vitest';

const effects = [
  'onOpenReady?.(open)', 'checkAgreement()', 'syncNativeWindowAppearance(isDarkMode)',
  'setDesktopSidebarMotionWidth(null)', 'clearNativeTitlebarSidebarMaterial()',
  'isSmallScreenRef.current = isSmallScreen', 'rememberCardsHubView(currentView)',
  'textbookReturnContextRef.current = textbookReturnContext', 'openChatV2Test',
  'installAndroidBackBridge()', 'registerBackHandler(', 'debugLoadMistakeChat',
  'bindCurrentChatHeaderStore', 'Hooks+调度:',
];
function calls(file: string, text: string) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const result: { key: string; file: string; line: number; text: string }[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^use[A-Z]/.test(node.expression.text)) {
      const name = node.expression.text;
      let key = name;
      if (name === 'useEffect') {
        key += ':' + effects.find(anchor => node.getText(sf).includes(anchor));
      } else if (ts.isVariableDeclaration(node.parent) && name !== 'useDesktopTitlebarInteractions') {
        key += ':' + (ts.isVariableDeclaration(node.parent) ? node.parent.name.getText(sf).replaceAll(/\s/g, '') : '?');
        key = key.replace('handleDesktopSidebarToggle', 'toggleDesktopSidebar');
      } else if (name === 'useAppEvent' || name === 'useEventRegistry') {
        key += ':' + node.arguments[0].getText(sf).replaceAll(/\s/g, '');
      }
      result.push({ key, file, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.getText(sf) });
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return result;
}

it('accounts for every e73 App hook and inline effect after the split', () => {
  const original = calls('src/App.tsx', fs.readFileSync('tests/fixtures/plugin-consolidation/e73e0d98/src/App.tsx.txt', 'utf8'));
  const files: string[] = JSON.parse(fs.readFileSync('config/app-shell-sources.json', 'utf8')).files;
  const current = files.flatMap(file => calls(file, fs.readFileSync(file, 'utf8')));
  const rows = original.map(call => {
    expect(call.key).not.toContain('undefined');
    const target = current.find(candidate => candidate.key === call.key);
    expect(target, `${call.file}:${call.line} ${call.key}`).toBeDefined();
    return `| App:${call.line} \`${call.key}\` | \`${target!.file}:${target!.line}\` |`;
  });
  if (process.env.W38_HOOK_TABLE) {
    fs.writeFileSync(process.env.W38_HOOK_TABLE, `| e73 原调用 | 现位置 |\n|---|---|\n${rows.join('\n')}\n`);
  }
});
