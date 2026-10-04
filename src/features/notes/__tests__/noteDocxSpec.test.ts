import { describe, expect, it } from 'vitest';
import { markdownToDocxBlocks, markdownToDocxSpec, stripFrontMatter } from '../noteDocxSpec';
import { base64ToBytes, docxFileName } from '../noteDocxExport';

const handoutMd = `---
title: x
---

# 机器学习讲义

概述段落。

## 一、梯度下降

[媒体@file_abc:01:05]

主旨 **加粗** 与 \`代码\`。

### 学习率

![图 1 损失曲面](notes_assets/_global/note_1/a.jpg)

*图 1 损失曲面*

**表 1 对比**

| 方法 | 特点 |
| --- | --- |
| SGD | 快 |

1. 第一
2. 第二
   - 子项

> 注意事项

\`\`\`python
print(1)
\`\`\`
`;

describe('markdownToDocxBlocks', () => {
  it('maps headings, paragraphs, figures with captions, captioned tables, lists, notes and code', () => {
    const blocks = markdownToDocxBlocks(handoutMd);
    expect(blocks).toEqual([
      { type: 'heading', level: 1, text: '机器学习讲义' },
      { type: 'paragraph', text: '概述段落。' },
      { type: 'heading', level: 2, text: '一、梯度下降' },
      { type: 'paragraph', text: '[01:05]' },
      { type: 'paragraph', text: '主旨 加粗 与 代码。' },
      { type: 'heading', level: 3, text: '学习率' },
      {
        type: 'image',
        src: 'notes_assets/_global/note_1/a.jpg',
        alt: '图 1 损失曲面',
        caption: '图 1 损失曲面',
      },
      { type: 'table', header: true, caption: '表 1 对比', rows: [['方法', '特点'], ['SGD', '快']] },
      { type: 'list', ordered: true, items: ['第一', '第二', '    – 子项'] },
      { type: 'paragraph', role: 'note', text: '注意事项' },
      { type: 'code', text: 'print(1)' },
    ]);
  });

  it('inlines data URLs and keeps text around inline images', () => {
    const blocks = markdownToDocxBlocks('前文 ![](data:image/png;base64,AAAA) 后文');
    expect(blocks).toEqual([
      { type: 'paragraph', text: '前文  后文' },
      { type: 'image', data: 'data:image/png;base64,AAAA' },
    ]);
  });

  it('strips YAML front matter', () => {
    expect(stripFrontMatter('---\na: 1\n---\nbody')).toBe('body');
  });
});

describe('markdownToDocxSpec', () => {
  it('default template de-duplicates the leading H1 against the note title', () => {
    const spec = markdownToDocxSpec(handoutMd, { title: '机器学习讲义', template: 'default' });
    expect(spec.title).toBe('机器学习讲义');
    expect(spec.template).toBeUndefined();
    expect(spec.blocks[0]).toEqual({ type: 'paragraph', text: '概述段落。' });
  });

  it('handout template promotes headings so sections are level 1', () => {
    const spec = markdownToDocxSpec(handoutMd, { title: '机器学习讲义', template: 'handout', date: '2026年10月4日' });
    expect(spec.template).toBe('handout');
    expect(spec.date).toBe('2026年10月4日');
    const headings = spec.blocks.filter((b) => b.type === 'heading');
    expect(headings).toEqual([
      { type: 'heading', level: 1, text: '一、梯度下降' },
      { type: 'heading', level: 2, text: '学习率' },
    ]);
  });
});

describe('export helpers', () => {
  it('sanitises file names', () => {
    expect(docxFileName('a/b:c?')).toBe('a b c.docx');
    expect(docxFileName('  ')).toBe('note.docx');
  });
  it('decodes base64 to bytes', () => {
    expect(Array.from(base64ToBytes('AQID'))).toEqual([1, 2, 3]);
  });
});
