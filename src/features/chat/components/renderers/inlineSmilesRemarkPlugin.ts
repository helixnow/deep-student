/**
 * 将正文中的 `\\smiles{...}` 标记转为受控的 span 占位符。
 *
 * 这一步在 remark AST 上完成，因而不会误处理 fenced code、inline code 或数学节点。
 * SMILES 经过 encodeURIComponent 后才进入 HTML 属性；后续仍须通过 rehype-sanitize。
 */
const INLINE_SMILES_RE = /\\smiles\{([^{}\r\n]+)\}/g;

function splitInlineSmiles(value: string): Array<{ type: 'text' | 'html'; value: string }> {
  const result: Array<{ type: 'text' | 'html'; value: string }> = [];
  let cursor = 0;

  for (const match of value.matchAll(INLINE_SMILES_RE)) {
    const index = match.index ?? 0;
    const smiles = match[1].trim();
    if (!smiles) continue;

    if (index > cursor) result.push({ type: 'text', value: value.slice(cursor, index) });
    result.push({
      type: 'html',
      value: `<span data-smiles="${encodeURIComponent(smiles)}"></span>`,
    });
    cursor = index + match[0].length;
  }

  if (cursor < value.length) result.push({ type: 'text', value: value.slice(cursor) });
  return result.length > 0 ? result : [{ type: 'text', value }];
}

/** remark 插件：仅替换普通 text 节点中的内联 SMILES。 */
export function inlineSmilesRemarkPlugin() {
  return (tree: any) => {
    const visit = (node: any) => {
      if (!Array.isArray(node?.children)) return;
      node.children = node.children.flatMap((child: any) => {
        if (child?.type === 'text' && typeof child.value === 'string') {
          return splitInlineSmiles(child.value);
        }
        visit(child);
        return child;
      });
    };
    visit(tree);
  };
}

