import { describe, expect, it } from 'vitest';

import { makeCitationRemarkPlugin } from '../citationRemarkPlugin';

function runPlugin(text: string) {
  const tree: any = {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [{ type: 'text', value: text }],
      },
    ],
  };

  const transformer = makeCitationRemarkPlugin()();
  transformer(tree);
  return tree.children[0].children;
}

describe('citationRemarkPlugin mindmap citations', () => {
  it('emits data-mindmap-id for mm_* citations', () => {
    const children = runPlugin('查看当前版 [思维导图:mm_abc123:当前版]');
    const htmlNode = children.find((node: any) => node.type === 'html');

    expect(htmlNode?.value).toContain('data-mindmap-id="mm_abc123"');
    expect(htmlNode?.value).not.toContain('data-mindmap-version-id=');
  });

  it('emits data-mindmap-version-id for mv_* citations', () => {
    const children = runPlugin('查看旧版 [思维导图:mv_old123:旧版]');
    const htmlNode = children.find((node: any) => node.type === 'html');

    expect(htmlNode?.value).toContain('data-mindmap-version-id="mv_old123"');
    expect(htmlNode?.value).not.toContain('data-mindmap-id=');
  });
});
