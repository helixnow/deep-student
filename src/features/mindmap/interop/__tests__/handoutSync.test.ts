import { describe, expect, it } from 'vitest';
import type { SemanticAnchor } from '@/ui-kernel/contracts/interop';
import {
  compileMindMapSubtreeToHandoutMarkdown,
  parseHandoutMarkdownToMindMapDraft,
} from '@/ui-kernel/services/mindmapHandoutBridge';
import type { MindMapDocument, MindMapNode } from '../../types';
import { mergeHandoutDraftIntoMindMap } from '../handoutSync';

const MINDMAP_ID = 'mm_handout_sync';

const pdfAnchor: SemanticAnchor = {
  kind: 'pdf',
  resourceId: 'pdf_calculus',
  page: 3,
  quote: '导数定义',
};

function node(
  id: string,
  text: string,
  extra: Partial<MindMapNode> = {},
  children: MindMapNode[] = [],
): MindMapNode {
  return { id, text, children, ...extra };
}

function buildDocument(): MindMapDocument {
  return {
    version: '1.0',
    root: node('node_root', '高等数学', {
      children: [
        node(
          'node_a',
          '导数定义',
          {
            note: '导数就是瞬时变化率。',
            anchors: [pdfAnchor],
            excerpts: [
              {
                id: 'slot_existing',
                kind: 'text',
                text: '导数定义为差商的极限。',
                anchor: pdfAnchor,
              },
            ],
            priority: 2,
          },
          [node('node_a1', '极限定义'), node('node_a2', '左右导数')],
        ),
        node('node_b', '求导法则'),
        // 只在导图里存在、讲义里未提及：回写不得删除
        node('node_c', '导图独有分支'),
      ],
    }),
    meta: { title: '高等数学', createdAt: 1, updatedAt: 1 },
  } as unknown as MindMapDocument;
}

function handoutMarkdown(document: MindMapDocument): string {
  return compileMindMapSubtreeToHandoutMarkdown(
    {
      id: document.root.id,
      text: document.root.text,
      children: document.root.children.map((child) => ({
        id: child.id,
        text: child.text,
        note: child.note,
        anchors: child.anchors,
        children: child.children.map((grandchild) => ({
          id: grandchild.id,
          text: grandchild.text,
          children: [],
        })),
      })),
    },
    {
      mindmapId: MINDMAP_ID,
      mindmapTitle: '高等数学',
      baseHeadingLevel: 1,
      maxHeadingLevel: 4,
      includeMindMapNodeBacklinks: true,
    },
  );
}

describe('mergeHandoutDraftIntoMindMap', () => {
  it('updates matched nodes in place, keeps anchors and appends new sections', () => {
    const document = buildDocument();
    const markdown = handoutMarkdown(document).replace('导数定义', '导数与极限定义');
    const edited = `${markdown}\n\n## 高阶导数\n\n莱布尼茨公式。`;
    const draft = parseHandoutMarkdownToMindMapDraft(edited, {
      noteId: 'note_1',
      noteTitle: '高等数学精读讲义',
    });
    expect(draft).not.toBeNull();

    const result = mergeHandoutDraftIntoMindMap(document, draft!, { mindmapId: MINDMAP_ID });

    expect(result.document.root.id).toBe('node_root');
    expect(result.updated).toBeGreaterThan(0);
    expect(result.added).toBeGreaterThan(0);

    const mergedRoot = result.document.root;
    const mergedA = mergedRoot.children.find((child) => child.id === 'node_a')!;
    // 标题按笔记改写，节点 ID 与出处锚点保持稳定
    expect(mergedA.text).toContain('导数与极限定义');
    expect(mergedA.anchors?.some((anchor) => anchor.kind === 'pdf' && anchor.page === 3)).toBe(true);
    // 原有复合摘录槽与优先级不被笔记回写冲掉
    expect(mergedA.excerpts?.[0]?.id).toBe('slot_existing');
    expect(mergedA.priority).toBe(2);
    // 讲义未提及的导图独有分支必须保留
    expect(mergedRoot.children.some((child) => child.id === 'node_c')).toBe(true);

    const newSection = mergedRoot.children.find((child) => child.text === '高阶导数');
    expect(newSection).toBeTruthy();
    // 新增小节以全新 ID 加入，不复用原节点
    expect(newSection!.id).not.toBe('node_a');
    expect(mergedA.children.some((child) => child.id === 'node_a1')).toBe(true);
  });

  it('is idempotent when the handout did not change', () => {
    const document = buildDocument();
    const draft = parseHandoutMarkdownToMindMapDraft(handoutMarkdown(document), {
      noteId: 'note_1',
      noteTitle: '高等数学精读讲义',
    });

    const first = mergeHandoutDraftIntoMindMap(document, draft!, { mindmapId: MINDMAP_ID });
    const second = mergeHandoutDraftIntoMindMap(first.document, draft!, { mindmapId: MINDMAP_ID });

    expect(second.updated).toBe(0);
    expect(second.added).toBe(0);
    expect(second.document).toBe(first.document);
  });

  it('attaches a handout without provenance as a new root branch', () => {
    const document = buildDocument();
    const draft = parseHandoutMarkdownToMindMapDraft('# 全新讲义\n\n## 第一节\n\n正文。', {
      noteId: 'note_2',
    });

    const result = mergeHandoutDraftIntoMindMap(document, draft!, { mindmapId: MINDMAP_ID });

    expect(result.added).toBeGreaterThan(0);
    expect(result.document.root.children.length).toBe(document.root.children.length + 1);
    expect(result.document.root.children.at(-1)?.text).toBe('全新讲义');
  });

  it('still matches provenance when the editor escapes the ampersand in the link destination', () => {
    // Crepe 保存讲义时把 `?node=…&label=…` 序列化成 `?node=…\&label=…`；实测
    // 未还原转义会把 nodeId 读成 `node_a\`，同步于是新增重复节点而不是原地改名。
    const document = buildDocument();
    const markdown = [
      '# 导数与极限定义',
      '',
      '导数就是瞬时变化率。',
      '',
      '> — [高等数学](ds-anchor://v1/mindmap/mm_handout_sync?node=node_a\\&label=%E9%AB%98%E7%AD%89%E6%95%B0%E5%AD%A6)',
    ].join('\n');
    const draft = parseHandoutMarkdownToMindMapDraft(markdown, { noteId: 'note_1' });

    const result = mergeHandoutDraftIntoMindMap(document, draft!, { mindmapId: MINDMAP_ID });

    expect(result.added).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.document.root.children).toHaveLength(document.root.children.length);
    const mergedA = result.document.root.children.find((child) => child.id === 'node_a')!;
    expect(mergedA.text).toBe('导数与极限定义');
    // 原地改名不吞掉节点原有的出处与子节点
    expect(mergedA.anchors?.some((anchor) => anchor.kind === 'pdf' && anchor.page === 3)).toBe(true);
    expect(mergedA.children.map((child) => child.id)).toEqual(['node_a1', 'node_a2']);
  });
});
