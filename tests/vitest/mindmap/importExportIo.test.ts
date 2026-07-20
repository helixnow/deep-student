/**
 * W08 导入导出增强测试：
 * - Markdown 文件导入与粘贴解析对齐（B5）
 * - FreeMind .mm 导入
 * - XMind 导出（Zen content.json 最小合法包）与导入往返
 * - 子树 Markdown 导出契约
 * - importFromFile 扩展名路由（B11）与 detectFormat 增强
 */
import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';

// 让 i18n 文案确定可断言（合成根标题 / 空导图等）
vi.mock('i18next', () => ({
  default: {
    t: (key: string, params?: Record<string, unknown>) =>
      params
        ? `${key} ${Object.entries(params).map(([, v]) => String(v)).join(' | ')}`
        : key,
  },
}));

import {
  detectFormat,
  importFromFile,
  importFromFreeMind,
  importFromMarkdown,
  importFromXMind,
  importMindMap,
} from '@/features/mindmap/utils/importers';
import {
  buildXMindContentJson,
  exportNodesToMarkdown,
  exportSubtreeToMarkdown,
  exportToMarkdown,
  exportToXMind,
} from '@/features/mindmap/utils/exporters';
import { markdownListToNodes } from '@/features/mindmap/utils/pasteMarkdown';
import type { MindMapDocument, MindMapNode } from '@/features/mindmap/types';

function doc(root: MindMapNode, associations?: MindMapDocument['associations']): MindMapDocument {
  return {
    version: '1.0',
    root,
    meta: { createdAt: '2026-01-01T00:00:00.000Z' },
    ...(associations ? { associations } : {}),
  };
}

describe('importFromMarkdown (aligned with paste parser, B5)', () => {
  it('parses ordered lists into hierarchy', () => {
    const document = importFromMarkdown('1. root\n   1. child\n   2. sibling');
    expect(document.root.id).toBe('root');
    expect(document.root.text).toBe('root');
    expect(document.root.children.map((n) => n.text)).toEqual(['child', 'sibling']);
  });

  it('parses • bullets', () => {
    const document = importFromMarkdown('• parent\n  • child');
    expect(document.root.text).toBe('parent');
    expect(document.root.children[0].text).toBe('child');
  });

  it('parses indentation-only outlines (Mubu-style export)', () => {
    const document = importFromMarkdown('Parent\n  Child\n    Deep');
    expect(document.root.text).toBe('Parent');
    expect(document.root.children[0].text).toBe('Child');
    expect(document.root.children[0].children[0].text).toBe('Deep');
  });

  it('synthesizes a root for multi-root forests instead of forcing the first line', () => {
    const document = importFromMarkdown('- a\n- b');
    expect(document.root.id).toBe('root');
    expect(document.root.children.map((n) => n.text)).toEqual(['a', 'b']);
  });

  it('keeps heading + list structure as a single root', () => {
    const document = importFromMarkdown('# Title\n- item\n  - nested');
    expect(document.root.text).toBe('Title');
    expect(document.root.children[0].text).toBe('item');
    expect(document.root.children[0].children[0].text).toBe('nested');
  });

  it('parses GFM task markers into completed state', () => {
    const document = importFromMarkdown('- [ ] todo\n  - [x] done');
    expect(document.root.completed).toBe(false);
    expect(document.root.children[0].completed).toBe(true);
  });

  it('returns the empty-map placeholder for blank input', () => {
    const document = importFromMarkdown('   \n  ');
    expect(document.root.id).toBe('root');
    expect(document.root.children).toEqual([]);
  });

  it('round-trips exportToMarkdown output including escaped note lines', () => {
    const source = doc({
      id: 'root',
      text: 'Root',
      note: '- note that looks like a bullet\n> quoted note line',
      children: [
        { id: 'c1', text: 'Child', note: 'plain note', children: [], completed: true },
      ],
    });
    const markdown = exportToMarkdown(source);
    const imported = importFromMarkdown(markdown);

    expect(imported.root.text).toBe('Root');
    expect(imported.root.note).toBe('- note that looks like a bullet\n> quoted note line');
    expect(imported.root.children[0].text).toBe('Child');
    expect(imported.root.children[0].note).toBe('plain note');
    expect(imported.root.children[0].completed).toBe(true);
  });
});

describe('importFromFreeMind', () => {
  const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
    <map version="1.0.1">
      <node ID="ID_root" TEXT="Biology">
        <node ID="ID_cell" TEXT="Cell">
          <icon BUILTIN="button_ok"/>
          <node ID="ID_nucleus" TEXT="Nucleus">
            <richcontent TYPE="NOTE"><html><body><p>Contains DNA</p></body></html></richcontent>
          </node>
        </node>
        <node ID="ID_wave" TEXT="Waves">
          <arrowlink DESTINATION="ID_cell"/>
        </node>
      </node>
    </map>`;

  it('imports text + note hierarchy with root promoted to id "root"', () => {
    const document = importFromFreeMind(SAMPLE);
    expect(document.root.id).toBe('root');
    expect(document.root.text).toBe('Biology');
    expect(document.root.children.map((n) => n.text)).toEqual(['Cell', 'Waves']);
    expect(document.root.children[0].children[0].note).toBe('Contains DNA');
  });

  it('maps button_ok icon to completed', () => {
    const document = importFromFreeMind(SAMPLE);
    expect(document.root.children[0].completed).toBe(true);
    expect(document.root.children[1].completed).toBeUndefined();
  });

  it('maps arrowlink to an association with remapped endpoints', () => {
    const document = importFromFreeMind(SAMPLE);
    expect(document.associations).toHaveLength(1);
    expect(document.associations?.[0]).toMatchObject({
      source: 'ID_wave',
      target: 'ID_cell',
    });
  });

  it('reads richcontent NODE body when TEXT attribute is missing', () => {
    const document = importFromFreeMind(`<map version="1.0.1">
      <node><richcontent TYPE="NODE"><html><body><p>Rich  title</p></body></html></richcontent></node>
    </map>`);
    expect(document.root.text).toBe('Rich title');
  });

  it('synthesizes a root for multiple top-level nodes', () => {
    const document = importFromFreeMind(
      '<map version="1.0.1"><node TEXT="A"/><node TEXT="B"/></map>',
    );
    expect(document.root.id).toBe('root');
    expect(document.root.children.map((n) => n.text)).toEqual(['A', 'B']);
  });

  it('rejects non-FreeMind XML and malformed input', () => {
    expect(() => importFromFreeMind('<opml version="2.0"><body/></opml>'))
      .toThrow('missing map element');
    expect(() => importFromFreeMind('<map version="1.0.1"></map>'))
      .toThrow('no node elements found');
  });
});

describe('XMind export', () => {
  const source = doc(
    {
      id: 'root',
      text: 'Plan',
      note: 'root note',
      children: [
        { id: 'todo', text: 'Todo', children: [], completed: false },
        { id: 'done', text: 'Done', children: [], completed: true },
      ],
    },
    [{ id: 'assoc_1', source: 'todo', target: 'done', label: 'blocks' }],
  );

  it('builds a minimal valid Zen content.json', () => {
    const [sheet] = buildXMindContentJson(source) as Array<Record<string, unknown>>;
    expect(sheet.class).toBe('sheet');
    expect(sheet.title).toBe('Plan');
    const rootTopic = sheet.rootTopic as Record<string, unknown>;
    expect(rootTopic.title).toBe('Plan');
    expect(rootTopic.notes).toEqual({ plain: { content: 'root note' } });
    const attached = (rootTopic.children as { attached: Array<Record<string, unknown>> }).attached;
    expect(attached.map((t) => t.markers)).toEqual([
      [{ markerId: 'task-start' }],
      [{ markerId: 'task-done' }],
    ]);
    expect(sheet.relationships).toEqual([
      { id: 'assoc_1', end1Id: 'todo', end2Id: 'done', title: 'blocks' },
    ]);
  });

  it('produces a zip archive containing content.json + metadata + manifest', async () => {
    const bytes = await exportToXMind(source);
    const zip = await JSZip.loadAsync(bytes);
    expect(zip.file('content.json')).toBeTruthy();
    expect(zip.file('metadata.json')).toBeTruthy();
    expect(zip.file('manifest.json')).toBeTruthy();
  });

  it('round-trips through importFromXMind (titles, notes, completed, associations)', async () => {
    const bytes = await exportToXMind(source);
    const imported = await importFromXMind(bytes);

    expect(imported.root.text).toBe('Plan');
    expect(imported.root.note).toBe('root note');
    expect(imported.root.children.map((n) => [n.text, n.completed])).toEqual([
      ['Todo', false],
      ['Done', true],
    ]);
    expect(imported.associations).toHaveLength(1);
    expect(imported.associations?.[0]).toMatchObject({ label: 'blocks' });
  });
});

describe('subtree markdown export contract', () => {
  const subtree: MindMapNode = {
    id: 'n1',
    text: 'Parent',
    note: 'a note',
    children: [
      { id: 'n2', text: 'Done child', children: [], completed: true },
      { id: 'n3', text: 'Plain child', children: [] },
    ],
  };

  it('emits the root as a top-level list item by default', () => {
    const markdown = exportSubtreeToMarkdown(subtree);
    const lines = markdown.trimEnd().split('\n');
    expect(lines[0]).toBe('- Parent');
    expect(lines).toContain('  - [x] Done child');
    expect(lines).toContain('  - Plain child');
  });

  it('emits the root as a heading with rootAsHeading', () => {
    expect(exportSubtreeToMarkdown(subtree, { rootAsHeading: true }).startsWith('# Parent\n')).toBe(true);
  });

  it('round-trips through markdownListToNodes', () => {
    const forest = markdownListToNodes(exportSubtreeToMarkdown(subtree));
    expect(forest).toHaveLength(1);
    expect(forest[0].text).toBe('Parent');
    expect(forest[0].note).toBe('a note');
    expect(forest[0].children.map((n) => [n.text, n.completed])).toEqual([
      ['Done child', true],
      ['Plain child', undefined],
    ]);
  });

  it('exports a forest of top-level subtrees', () => {
    const markdown = exportNodesToMarkdown([
      { id: 'a', text: 'A', children: [] },
      { id: 'b', text: 'B', children: [] },
    ]);
    expect(markdown.trimEnd().split('\n')).toEqual(['- A', '- B']);
  });
});

describe('detectFormat / importMindMap routing', () => {
  it('detects opml, freemind, json, markdown and zip magic', () => {
    expect(detectFormat('<?xml version="1.0"?><opml version="2.0"></opml>')).toBe('opml');
    expect(detectFormat('<map version="1.0.1"><node TEXT="a"/></map>')).toBe('freemind');
    expect(detectFormat('{"version":"1.0"}')).toBe('json');
    expect(detectFormat('- item')).toBe('markdown');
    expect(detectFormat('PK\u0003\u0004rest-of-zip')).toBe('xmind');
  });

  it('importMindMap routes freemind and rejects string xmind', () => {
    const document = importMindMap('<map version="1.0.1"><node TEXT="a"/></map>');
    expect(document.root.text).toBe('a');
    expect(() => importMindMap('anything', 'xmind')).toThrow('binary data');
  });
});

describe('importFromFile routing (B11)', () => {
  it('routes .mm files to the FreeMind importer', async () => {
    const file = new File(
      ['<map version="1.0.1"><node TEXT="FM Root"/></map>'],
      'notes.mm',
      { type: 'application/xml' },
    );
    const document = await importFromFile(file);
    expect(document.root.text).toBe('FM Root');
  });

  it('routes .xmind files to the binary XMind importer', async () => {
    const zip = new JSZip();
    zip.file('content.json', JSON.stringify([{ rootTopic: { id: 'r', title: 'From XMind' } }]));
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const file = new File([bytes as unknown as BlobPart], 'map.xmind');

    const document = await importFromFile(file);
    expect(document.root.text).toBe('From XMind');
  });

  it('sniffs zip magic for extensionless files instead of corrupting bytes via text()', async () => {
    const zip = new JSZip();
    zip.file('content.json', JSON.stringify([{ rootTopic: { id: 'r', title: 'Sniffed' } }]));
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const file = new File([bytes as unknown as BlobPart], 'exported-map');

    const document = await importFromFile(file);
    expect(document.root.text).toBe('Sniffed');
  });

  it('keeps markdown extension routing', async () => {
    const file = new File(['- a\n  - b'], 'outline.md', { type: 'text/markdown' });
    const document = await importFromFile(file);
    expect(document.root.text).toBe('a');
    expect(document.root.children[0].text).toBe('b');
  });
});
