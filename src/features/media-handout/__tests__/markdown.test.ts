import { describe, expect, it } from 'vitest';
import { handoutToMarkdown, mediaAnchor } from '../markdown';

describe('handoutToMarkdown', () => {
  const sections = [
    {
      heading: '梯度下降',
      startSec: 65,
      blocks: [
        { type: 'lead' as const, text: '主旨' },
        { type: 'figure' as const, ts: 77, caption: '损失曲面' },
        { type: 'table' as const, header: ['a|b', 'c'], rows: [['1', '2']], caption: '对比' },
        { type: 'list' as const, ordered: false, items: ['x', 'y'] },
        { type: 'note' as const, text: '注意' },
      ],
    },
    { heading: '反向传播', startSec: 3700, blocks: [{ type: 'figure' as const, ts: 3710 }] },
  ];

  it('anchors every section and embeds only saved images', () => {
    const md = handoutToMarkdown({
      resourceId: 'file_abc',
      title: '讲义',
      summary: '概述',
      sections,
      lang: 'zh',
      images: new Map([[77, 'notes_assets/_global/note_1/a.jpg']]),
    });
    expect(md).toContain('# 讲义\n\n概述');
    expect(md).toContain('## 一、梯度下降\n\n[媒体@file_abc:01:05]');
    expect(md).toContain('## 二、反向传播\n\n[媒体@file_abc:1:01:40]');
    expect(md).toContain('![图 1 损失曲面](notes_assets/_global/note_1/a.jpg)\n\n*图 1 损失曲面*');
    expect(md).toContain('**表 1 对比**\n\n| a\\|b | c |\n| --- | --- |\n| 1 | 2 |');
    expect(md).toContain('- x\n- y');
    expect(md).toContain('> 注意');
    expect(md).not.toContain('3710'); // 未保存的图被省略
  });

  it('uses English numbering for en', () => {
    const md = handoutToMarkdown({ resourceId: 'r', title: 'T', summary: '', sections, lang: 'en' });
    expect(md).toContain('## 1. 梯度下降');
    expect(md).not.toContain('![');
  });

  it('mediaAnchor follows the citation contract', () => {
    expect(mediaAnchor('file_x', 59)).toBe('[媒体@file_x:00:59]');
  });
});
