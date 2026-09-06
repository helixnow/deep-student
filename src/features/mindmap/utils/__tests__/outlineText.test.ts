/**
 * outlineText 单元测试 — P0 选区即上下文：导图节点子树 → 大纲文本序列化
 */

import { describe, it, expect } from 'vitest';
import { serializeNodesToOutlineText } from '../node/outlineText';
import type { MindMapNode } from '../../../types';

function node(id: string, text: string, children: MindMapNode[] = [], note?: string): MindMapNode {
  return { id, text, note, children } as MindMapNode;
}

describe('serializeNodesToOutlineText', () => {
  it('序列化单节点（无子树）', () => {
    expect(serializeNodesToOutlineText([node('a', '根')])).toBe('- 根');
  });

  it('序列化子树为缩进大纲', () => {
    const tree = node('a', '根', [
      node('b', '子一', [node('d', '孙一')]),
      node('c', '子二'),
    ]);
    expect(serializeNodesToOutlineText([tree])).toBe(
      ['- 根', '  - 子一', '    - 孙一', '  - 子二'].join('\n'),
    );
  });

  it('多个选中节点并列输出', () => {
    const result = serializeNodesToOutlineText([node('a', '甲'), node('b', '乙', [node('c', '乙子')])]);
    expect(result).toBe(['- 甲', '- 乙', '  - 乙子'].join('\n'));
  });

  it('附带备注并截断超长备注', () => {
    const longNote = 'x'.repeat(200);
    const withNote = node('a', '根', [], longNote);
    const result = serializeNodesToOutlineText([withNote], { maxNoteChars: 10 });
    expect(result).toBe(`- 根（备注：${'x'.repeat(10)}…）`);
  });

  it('maxNoteChars=0 时不带备注', () => {
    const result = serializeNodesToOutlineText([node('a', '根', [], '备注内容')], { maxNoteChars: 0 });
    expect(result).toBe('- 根');
  });

  it('超过最大深度时截断并追加标记', () => {
    const deep = node('a', 'L1', [node('b', 'L2', [node('c', 'L3', [node('d', 'L4')])])]);
    const result = serializeNodesToOutlineText([deep], { maxDepth: 2 });
    expect(result).toBe(['- L1', '  - L2', '- …（已截断，尚有 2 个节点）'].join('\n'));
  });

  it('超过最大节点数时截断并追加标记', () => {
    const wide = node('a', '根', [
      node('b', '子一'),
      node('c', '子二'),
      node('d', '子三'),
    ]);
    const result = serializeNodesToOutlineText([wide], { maxNodes: 2 });
    expect(result).toBe(['- 根', '  - 子一', '- …（已截断，尚有 2 个节点）'].join('\n'));
  });

  it('超过最大字符数时截断并追加标记', () => {
    const result = serializeNodesToOutlineText(
      [node('a', '一'.repeat(50), [node('b', '二'.repeat(50))])],
      { maxChars: 60 },
    );
    expect(result).toBe(`- ${'一'.repeat(50)}\n- …（已截断，尚有 1 个节点）`);
  });

  it('空输入返回空字符串', () => {
    expect(serializeNodesToOutlineText([])).toBe('');
  });
});
