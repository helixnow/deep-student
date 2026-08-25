/**
 * W08 导入导出增强测试：
 * - Markdown 文件导入与粘贴解析对齐（B5）
 * - .mm 大纲导入
 * - .xmind 导出（content.json 最小合法包）与导入往返
 * - 子树 Markdown 导出契约
 * - importFromFile 扩展名路由（B11）与 detectFormat 增强
 */
import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';

// 让 i18n 文案确定可断言（合成根标题 / 空导图等）。
// 注意：exporters 经 fileManager/store 链会连带加载 src/i18n.ts，
// 因此 mock 需带上 isInitialized/on/addResourceBundle 等最小实例面，避免真实 init 崩溃。
vi.mock('i18next', () => {
  const t = (key: string, params?: Record<string, unknown>) =>
    params
      ? `${key} ${Object.entries(params).map(([, v]) => String(v)).join(' | ')}`
      : key;
  const mock = {
    t,
    isInitialized: true,
    language: 'zh-CN',
    use: () => mock,
    init: () => Promise.resolve(t),
    on: () => mock,
    off: () => mock,
    changeLanguage: () => Promise.resolve(t),
    addResourceBundle: () => mock,
  };
  return { default: mock };
});

import {
  createXmindImportReport,
  detectFormat,
  importFromFile,
  importFromMmOutline,
  importFromMmapZip,
  importFromMarkdown,
  importFromXmindZip,
  importMindMap,
} from '@/features/mindmap/utils/importers';
import {
  buildXmindContentJson,
  exportNodesToMarkdown,
  exportSubtreeToMarkdown,
  exportToMarkdown,
  exportToXmindZip,
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

  it('parses indentation-only outlines', () => {
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

describe('importFromMmOutline', () => {
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
    const document = importFromMmOutline(SAMPLE);
    expect(document.root.id).toBe('root');
    expect(document.root.text).toBe('Biology');
    expect(document.root.children.map((n) => n.text)).toEqual(['Cell', 'Waves']);
    expect(document.root.children[0].children[0].note).toBe('Contains DNA');
  });

  it('maps button_ok icon to completed', () => {
    const document = importFromMmOutline(SAMPLE);
    expect(document.root.children[0].completed).toBe(true);
    expect(document.root.children[1].completed).toBeUndefined();
  });

  it('maps arrowlink to an association with remapped endpoints', () => {
    const document = importFromMmOutline(SAMPLE);
    expect(document.associations).toHaveLength(1);
    expect(document.associations?.[0]).toMatchObject({
      source: 'ID_wave',
      target: 'ID_cell',
    });
  });

  it('reads richcontent NODE body when TEXT attribute is missing', () => {
    const document = importFromMmOutline(`<map version="1.0.1">
      <node><richcontent TYPE="NODE"><html><body><p>Rich  title</p></body></html></richcontent></node>
    </map>`);
    expect(document.root.text).toBe('Rich title');
  });

  it('synthesizes a root for multiple top-level nodes', () => {
    const document = importFromMmOutline(
      '<map version="1.0.1"><node TEXT="A"/><node TEXT="B"/></map>',
    );
    expect(document.root.id).toBe('root');
    expect(document.root.children.map((n) => n.text)).toEqual(['A', 'B']);
  });

  it('rejects non-.mm XML and malformed input', () => {
    expect(() => importFromMmOutline('<opml version="2.0"><body/></opml>'))
      .toThrow('missing map element');
    expect(() => importFromMmOutline('<map version="1.0.1"></map>'))
      .toThrow('no node elements found');
  });
});

describe('.xmind export', () => {
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

  it('builds a minimal valid content.json', () => {
    const [sheet] = buildXmindContentJson(source) as Array<Record<string, unknown>>;
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
    const bytes = await exportToXmindZip(source);
    const zip = await JSZip.loadAsync(bytes);
    expect(zip.file('content.json')).toBeTruthy();
    expect(zip.file('metadata.json')).toBeTruthy();
    expect(zip.file('manifest.json')).toBeTruthy();
  });

  it('round-trips through .xmind import (titles, notes, completed, associations)', async () => {
    const bytes = await exportToXmindZip(source);
    const imported = await importFromXmindZip(bytes);

    expect(imported.root.text).toBe('Plan');
    expect(imported.root.note).toBe('root note');
    expect(imported.root.children.map((n) => [n.text, n.completed])).toEqual([
      ['Todo', false],
      ['Done', true],
    ]);
    expect(imported.associations).toHaveLength(1);
    expect(imported.associations?.[0]).toMatchObject({ label: 'blocks' });
  });

  it('maps node bgColor to topic fill (svg:fill), other styles omitted', () => {
    const styled = doc({
      id: 'root',
      text: 'Styled',
      children: [
        {
          id: 'c1',
          text: 'Colored',
          children: [],
          style: { bgColor: '#4FC3F7', fontWeight: 'bold' },
        },
        { id: 'c2', text: 'Plain', children: [] },
      ],
    });
    const [sheet] = buildXmindContentJson(styled) as Array<Record<string, unknown>>;
    const rootTopic = sheet.rootTopic as Record<string, unknown>;
    const attached = (rootTopic.children as { attached: Array<Record<string, unknown>> }).attached;
    expect(attached[0].style).toEqual({ properties: { 'svg:fill': '#4FC3F7' } });
    expect(attached[1].style).toBeUndefined();
    expect(rootTopic.style).toBeUndefined();
  });
});

describe('.xmind import report (P3, dropped items)', () => {
  it('counts dropped images and summaries from content.json', async () => {
    const zip = new JSZip();
    zip.file('content.json', JSON.stringify([{
      rootTopic: {
        id: 'r',
        title: 'Report',
        image: { src: 'xap:resources/pic.png' },
        summaries: [{ id: 's1' }],
        children: {
          attached: [
            { id: 'c1', title: 'child', image: { src: 'xap:resources/pic2.png' } },
          ],
          summary: [{ id: 'st1', title: 'summary topic' }],
        },
      },
    }]));
    const bytes = await zip.generateAsync({ type: 'uint8array' });

    const report = createXmindImportReport();
    const imported = await importFromXmindZip(bytes, report);

    expect(imported.root.text).toBe('Report');
    expect(report.droppedImages).toBe(2);
    // root 上 summaries 优先于 children.summary（同一份概要不重复计数）
    expect(report.droppedSummaries).toBe(1);
  });

  it('leaves report untouched when nothing is dropped', async () => {
    const zip = new JSZip();
    zip.file('content.json', JSON.stringify([{ rootTopic: { id: 'r', title: 'Clean' } }]));
    const bytes = await zip.generateAsync({ type: 'uint8array' });

    const report = createXmindImportReport();
    await importFromXmindZip(bytes, report);
    expect(report).toEqual({ droppedImages: 0, droppedSummaries: 0, embeddedImages: 0 });
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
  it('detects opml, mm, json, markdown and zip magic', () => {
    expect(detectFormat('<?xml version="1.0"?><opml version="2.0"></opml>')).toBe('opml');
    expect(detectFormat('<map version="1.0.1"><node TEXT="a"/></map>')).toBe('mm');
    expect(detectFormat('{"version":"1.0"}')).toBe('json');
    expect(detectFormat('- item')).toBe('markdown');
    expect(detectFormat('PK\u0003\u0004rest-of-zip')).toBe('xmind');
  });

  it('importMindMap routes mm and rejects string xmind/mmap', () => {
    const document = importMindMap('<map version="1.0.1"><node TEXT="a"/></map>');
    expect(document.root.text).toBe('a');
    expect(() => importMindMap('anything', 'xmind')).toThrow('binary data');
    expect(() => importMindMap('anything', 'mmap')).toThrow('binary data');
  });

  it('classifies non-opml XML as unknown-xml instead of falling back to opml', () => {
    expect(detectFormat('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')).toBe('unknown-xml');
    expect(detectFormat('<!DOCTYPE html><html><body>hi</body></html>')).toBe('unknown-xml');
    // 前置注释/声明不影响真实根元素识别
    expect(detectFormat('<?xml version="1.0"?><!-- exported --><opml version="2.0"><body/></opml>')).toBe('opml');
  });

  it('reports a clear error for unrecognized XML instead of "Invalid OPML"', () => {
    let message = '';
    try {
      importMindMap('<?xml version="1.0"?><workbook><sheet/></workbook>');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('Unrecognized XML');
    expect(message).not.toContain('Invalid OPML');
  });
});

describe('.mmap (MindManager) import', () => {
  const MMAP_DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
    <ap:Map xmlns:ap="http://schemas.mindjet.com/MindManager/Application/2003">
      <ap:OneTopic>
        <ap:Topic OId="r1">
          <ap:Text PlainText="MindManager Root"/>
          <ap:SubTopics>
            <ap:Topic OId="c1">
              <ap:Text PlainText="Child A"/>
              <ap:SubTopics>
                <ap:Topic OId="g1"><ap:Text PlainText="Grandchild"/></ap:Topic>
              </ap:SubTopics>
            </ap:Topic>
            <ap:Topic OId="c2"><ap:Text PlainText="Child B"/></ap:Topic>
          </ap:SubTopics>
        </ap:Topic>
      </ap:OneTopic>
    </ap:Map>`;

  async function buildMmapZip(documentXml: string = MMAP_DOCUMENT_XML): Promise<Uint8Array> {
    const zip = new JSZip();
    zip.file('Document.xml', documentXml);
    return zip.generateAsync({ type: 'uint8array' });
  }

  it('imports the OneTopic tree with the root promoted to id "root"', async () => {
    const document = await importFromMmapZip(await buildMmapZip());
    expect(document.root.id).toBe('root');
    expect(document.root.text).toBe('MindManager Root');
    expect(document.root.children.map((n) => n.text)).toEqual(['Child A', 'Child B']);
    expect(document.root.children[0].children[0].text).toBe('Grandchild');
  });

  it('rejects archives without Document.xml or OneTopic', async () => {
    const emptyZip = new JSZip();
    emptyZip.file('other.xml', '<x/>');
    await expect(importFromMmapZip(await emptyZip.generateAsync({ type: 'uint8array' })))
      .rejects.toThrow('Document.xml not found');

    await expect(importFromMmapZip(await buildMmapZip('<ap:Map xmlns:ap="urn:x"/>')))
      .rejects.toThrow('missing OneTopic');
  });

  it('routes .mmap files through importFromFile', async () => {
    const file = makeFile([await buildMmapZip()], 'plan.mmap');
    const document = await importFromFile(file);
    expect(document.root.text).toBe('MindManager Root');
  });

  it('falls back to .mmap parsing for extensionless zips that are not .xmind', async () => {
    const file = makeFile([await buildMmapZip()], 'exported-map-noext');
    const document = await importFromFile(file);
    expect(document.root.text).toBe('MindManager Root');
  });
});

describe('.xmind image placeholder + multi-sheet meta', () => {
  it('keeps a note placeholder for dropped images instead of silently discarding them', async () => {
    const zip = new JSZip();
    zip.file('content.json', JSON.stringify([{
      rootTopic: {
        id: 'r',
        title: 'WithImage',
        image: { src: 'xap:resources/pic.png' },
        notes: { plain: { content: 'existing note' } },
      },
    }]));
    const bytes = await zip.generateAsync({ type: 'uint8array' });

    const report = createXmindImportReport();
    const imported = await importFromXmindZip(bytes, report);
    expect(report.droppedImages).toBe(1);
    // mock t(key, params) => `${key} ${values}`：断言占位行进入备注且原备注保留
    expect(imported.root.note).toContain('existing note');
    expect(imported.root.note).toContain('mindmap:import.imagePlaceholderNote 1');
  });

  it('adds the image placeholder even without an import report', async () => {
    const zip = new JSZip();
    zip.file('content.json', JSON.stringify([{
      rootTopic: { id: 'r', title: 'NoReport', image: { src: 'xap:r.png' } },
    }]));
    const imported = await importFromXmindZip(await zip.generateAsync({ type: 'uint8array' }));
    expect(imported.root.note).toContain('mindmap:import.imagePlaceholderNote 1');
  });

  it('records per-sheet origins in meta.sheets when merging multi-sheet files', async () => {
    const zip = new JSZip();
    zip.file('content.json', JSON.stringify([
      { title: 'Sheet One', rootTopic: { id: 's1', title: 'Alpha' } },
      { title: 'Sheet Two', rootTopic: { id: 's2', title: 'Beta' } },
    ]));
    const imported = await importFromXmindZip(await zip.generateAsync({ type: 'uint8array' }));

    expect(imported.root.children.map((n) => n.text)).toEqual(['Alpha', 'Beta']);
    expect(imported.meta.sheets).toHaveLength(2);
    expect(imported.meta.sheets?.map((sheet) => sheet.title)).toEqual(['Sheet One', 'Sheet Two']);
    // sheet → 虚拟根一级子节点的对应关系必须闭合
    expect(imported.meta.sheets?.map((sheet) => sheet.rootNodeId))
      .toEqual(imported.root.children.map((n) => n.id));
    expect(new Set(imported.meta.sheets?.map((sheet) => sheet.id)).size).toBe(2);
  });

  it('keeps meta.sheets absent for single-sheet imports (single-tree model untouched)', async () => {
    const zip = new JSZip();
    zip.file('content.json', JSON.stringify([{ rootTopic: { id: 'r', title: 'Solo' } }]));
    const imported = await importFromXmindZip(await zip.generateAsync({ type: 'uint8array' }));
    expect(imported.meta.sheets).toBeUndefined();
  });
});

// jsdom 的 File/Blob 未实现 text()/arrayBuffer()/slice().arrayBuffer()，
// Node 的 File 返回的 ArrayBuffer 又与 jsdom 全局不同 realm（JSZip instanceof 判定失败），
// 因此用当前测试 realm 的字节直接构造 File 形状的最小桩。
function makeFile(parts: Array<string | Uint8Array>, name: string): File {
  const chunks = parts.map((p) => (typeof p === 'string' ? new TextEncoder().encode(p) : p));
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const toArrayBuffer = (view: Uint8Array): ArrayBuffer => {
    const copy = new Uint8Array(view.byteLength);
    copy.set(view);
    return copy.buffer;
  };
  return {
    name,
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => toArrayBuffer(bytes),
    slice: (start = 0, end = bytes.byteLength) => ({
      arrayBuffer: async () => toArrayBuffer(bytes.subarray(start, end)),
    }),
  } as unknown as File;
}

describe('importFromFile routing (B11)', () => {
  it('routes .mm files to the mm outline importer', async () => {
    const file = makeFile(
      ['<map version="1.0.1"><node TEXT="FM Root"/></map>'],
      'notes.mm',
    );
    const document = await importFromFile(file);
    expect(document.root.text).toBe('FM Root');
  });

  it('routes .xmind files to the binary .xmind importer', async () => {
    const zip = new JSZip();
    zip.file('content.json', JSON.stringify([{ rootTopic: { id: 'r', title: 'From Zip' } }]));
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const file = makeFile([bytes], 'map.xmind');

    const document = await importFromFile(file);
    expect(document.root.text).toBe('From Zip');
  });

  it('sniffs zip magic for extensionless files instead of corrupting bytes via text()', async () => {
    const zip = new JSZip();
    zip.file('content.json', JSON.stringify([{ rootTopic: { id: 'r', title: 'Sniffed' } }]));
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const file = makeFile([bytes], 'exported-map');

    const document = await importFromFile(file);
    expect(document.root.text).toBe('Sniffed');
  });

  it('keeps markdown extension routing', async () => {
    const file = makeFile(['- a\n  - b'], 'outline.md');
    const document = await importFromFile(file);
    expect(document.root.text).toBe('a');
    expect(document.root.children[0].text).toBe('b');
  });

  it('routes .txt files through the indentation-outline (markdown) parser', async () => {
    const file = makeFile(['Parent\n  Child\n    Deep'], 'outline.txt');
    const document = await importFromFile(file);
    expect(document.root.text).toBe('Parent');
    expect(document.root.children[0].text).toBe('Child');
    expect(document.root.children[0].children[0].text).toBe('Deep');
  });
});
