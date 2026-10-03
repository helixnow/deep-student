import { describe, expect, it } from 'vitest';
import type { MindMapNode } from '@/features/mindmap/types';
import { buildMindmapFromNoteMarkdown } from '../noteToMindmap';

const outline = (chapters: number, concepts: number, points: number) => Array.from({ length: chapters }, (_, c) => [
  `- 第 ${c + 1} 章`,
  ...Array.from({ length: concepts }, (_, k) => [
    `  - 概念 ${c + 1}.${k + 1}`,
    ...Array.from({ length: points }, (_, p) => `    - 结论 ${c + 1}.${k + 1}.${p + 1}`),
  ]).flat(),
]).flat().join('\n');

describe('buildMindmapFromNoteMarkdown', () => {
  it('多个顶级条目以笔记标题为根；单个顶级条目自身作根', () => {
    expect(buildMindmapFromNoteMarkdown('- 行列式\n  - 性质\n- 矩阵', '线代')?.root).toMatchObject({
      id: 'root', text: '线代', children: [{ text: '行列式' }, { text: '矩阵' }],
    });
    expect(buildMindmapFromNoteMarkdown('## 进程调度\n- FCFS\n- RR', '笔记')?.root).toMatchObject({
      id: 'root', text: '进程调度', children: [{ text: 'FCFS' }, { text: 'RR' }],
    });
  });

  it('没有大纲（纯一两行）返回 null', () => {
    expect(buildMindmapFromNoteMarkdown('', '空')).toBeNull();
    expect(buildMindmapFromNoteMarkdown('- 只有一条', '短')).toBeNull();
  });

  it('小图全部展开；超过 40 个节点时第 2 层起折叠', () => {
    const small = buildMindmapFromNoteMarkdown(outline(2, 2, 2), '小')!;
    expect(JSON.stringify(small)).not.toContain('collapsed');

    const big = buildMindmapFromNoteMarkdown(outline(4, 3, 3), '大')!; // 1 + 4 + 12 + 36 = 53
    const chapter = big.root.children[0];
    expect(big.root.collapsed).toBeUndefined();
    expect(chapter.collapsed).toBeUndefined();
    expect(chapter.children[0].collapsed).toBe(true);
    const leaf: MindMapNode = chapter.children[0].children[0];
    expect(leaf.collapsed).toBeUndefined();
  });
});
