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

  it('renders old citations exactly as before (no node attribute)', () => {
    const children = runPlugin('[思维导图:mm_abc123:C# 基础]');
    const htmlNode = children.find((node: any) => node.type === 'html');

    expect(htmlNode?.value).toBe(
      `<span data-mindmap-citation="true" data-mindmap-id="mm_abc123" data-mindmap-title="${encodeURIComponent('C# 基础')}" class="mindmap-citation-placeholder">[思维导图]</span>`,
    );
  });

  it('emits data-mindmap-node for #node hints', () => {
    const children = runPlugin('定位 [思维导图:mm_abc123#梯度同步:第 3 章] 末尾');
    const htmlNode = children.find((node: any) => node.type === 'html');

    expect(htmlNode?.value).toContain('data-mindmap-id="mm_abc123"');
    expect(htmlNode?.value).toContain(`data-mindmap-title="${encodeURIComponent('第 3 章')}"`);
    expect(htmlNode?.value).toContain(`data-mindmap-node="${encodeURIComponent('梯度同步')}"`);
    expect(children[children.length - 1]).toMatchObject({ type: 'text', value: ' 末尾' });
  });
});
