import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import {
  createXmindImportReport,
  importFromXmindZip,
  MAX_IMPORT_IMAGE_COUNT,
  MAX_IMPORT_IMAGE_INLINE_TOTAL_BYTES,
  MAX_INLINE_IMAGE_BYTES,
  MAX_XMIND_ARCHIVE_BYTES,
  MAX_XMIND_CONTENT_BYTES,
} from '../importers';

// 让 i18n 插值在测试中确定可断言（labelsNote / markersNote / multiSheetNote 等）
vi.mock('i18next', () => ({
  default: {
    t: (key: string, params?: Record<string, unknown>) =>
      params
        ? `${key} ${Object.entries(params).map(([, v]) => String(v)).join(' | ')}`
        : key,
  },
}));

async function zipEntry(name: string, content: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(name, content);
  return zip.generateAsync({ type: 'uint8array' });
}

describe('importFromXmindZip', () => {
  it('imports .xmind attached topics into the existing tree model', async () => {
    const data = await zipEntry('content.json', JSON.stringify([{
      rootTopic: {
        id: 'zen-root',
        title: 'Biology',
        notes: { plain: { content: 'Course map' } },
        children: {
          attached: [{
            id: 'cell',
            title: 'Cell',
            children: { attached: [{ id: 'nucleus', title: 'Nucleus' }] },
          }],
        },
      },
    }]));

    const document = await importFromXmindZip(data);

    expect(document.root).toMatchObject({
      id: 'root',
      text: 'Biology',
      note: 'Course map',
      children: [{ id: 'cell', text: 'Cell', children: [{ id: 'nucleus', text: 'Nucleus' }] }],
    });
    expect(document.associations).toBeUndefined();
  });

  it('maps .xmind task markers and relationships onto the document', async () => {
    const data = await zipEntry('content.json', JSON.stringify([{
      rootTopic: {
        id: 'zen-root',
        title: 'Plan',
        children: {
          attached: [
            {
              id: 'todo',
              title: 'Todo',
              markers: [{ markerId: 'task-start' }],
            },
            {
              id: 'done',
              title: 'Done',
              markers: [{ markerId: 'task-done' }],
            },
          ],
        },
      },
      relationships: [
        { id: 'rel-1', end1Id: 'todo', end2Id: 'done', title: 'blocks' },
        { id: 'rel-dangling', end1Id: 'todo', end2Id: 'missing' },
        { id: 'rel-root', end1Id: 'zen-root', end2Id: 'done' },
      ],
    }]));

    const document = await importFromXmindZip(data);

    expect(document.root.children.map((node) => node.completed)).toEqual([false, true]);
    expect(document.root.completed).toBeUndefined();
    expect(document.associations).toHaveLength(2);
    expect(document.associations?.[0]).toMatchObject({
      source: 'todo',
      target: 'done',
      label: 'blocks',
    });
    expect(document.associations?.[0].id).toMatch(/^assoc_/);
    // forceRoot 后原始 root id 重映射到 'root'
    expect(document.associations?.[1]).toMatchObject({ source: 'root', target: 'done' });
  });

  it('imports XML attached topics and ignores detached topics', async () => {
    const data = await zipEntry('content.xml', `<?xml version="1.0" encoding="UTF-8"?>
      <xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0">
        <sheet id="sheet-1">
          <topic id="legacy-root">
            <title>Physics</title>
            <notes><plain>Exam review</plain></notes>
            <children>
              <topics type="attached"><topic id="waves"><title>Waves</title></topic></topics>
              <topics type="detached"><topic id="floating"><title>Floating</title></topic></topics>
            </children>
          </topic>
        </sheet>
      </xmap-content>`);

    const document = await importFromXmindZip(data);

    expect(document.root.text).toBe('Physics');
    expect(document.root.note).toBe('Exam review');
    expect(document.root.children.map((node) => node.text)).toEqual(['Waves']);
  });

  it('maps XML marker references and sheet relationships onto the document', async () => {
    const data = await zipEntry('content.xml', `<?xml version="1.0" encoding="UTF-8"?>
      <xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0">
        <sheet id="sheet-1">
          <topic id="legacy-root">
            <title>Plan</title>
            <children>
              <topics type="attached">
                <topic id="todo">
                  <title>Todo</title>
                  <marker-refs><marker-ref marker-id="task-start" /></marker-refs>
                </topic>
                <topic id="done">
                  <title>Done</title>
                  <marker-refs><marker-ref marker-id="task-done" /></marker-refs>
                </topic>
              </topics>
            </children>
          </topic>
          <relationships>
            <relationship id="rel-1" end1="todo" end2="done"><title>blocks</title></relationship>
            <relationship id="rel-dangling" end1="todo" end2="missing" />
          </relationships>
        </sheet>
      </xmap-content>`);

    const document = await importFromXmindZip(data);

    expect(document.root.children.map((node) => node.completed)).toEqual([false, true]);
    expect(document.associations).toHaveLength(1);
    expect(document.associations?.[0]).toMatchObject({
      source: 'todo',
      target: 'done',
      label: 'blocks',
    });
  });

  it('maps labels and non-task markers into note lines, priority into a text prefix', async () => {
    const data = await zipEntry('content.json', JSON.stringify([{
      rootTopic: {
        id: 'zen-root',
        title: 'Plan',
        children: {
          attached: [{
            id: 'rich',
            title: 'Rich topic',
            notes: { plain: { content: 'base note' } },
            labels: ['alpha', 'beta'],
            markers: [
              { markerId: 'priority-1' },
              { markerId: 'flag-red' },
              { markerId: 'task-done' },
            ],
          }],
        },
      },
    }]));

    const document = await importFromXmindZip(data);
    const rich = document.root.children[0];

    expect(rich.text).toBe('[P1] Rich topic');
    expect(rich.completed).toBe(true);
    // 备注 = 原始备注 + 标签附注行 + 非任务 marker 附注行
    const noteLines = (rich.note ?? '').split('\n');
    expect(noteLines[0]).toBe('base note');
    expect(noteLines[1]).toContain('alpha, beta');
    expect(noteLines[2]).toContain('flag-red');
    expect(noteLines[2]).not.toContain('task-done');
    expect(noteLines[2]).not.toContain('priority-1');
  });

  it('maps XML labels into note lines', async () => {
    const data = await zipEntry('content.xml', `<?xml version="1.0" encoding="UTF-8"?>
      <xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0">
        <sheet id="sheet-1">
          <topic id="legacy-root">
            <title>Plan</title>
            <children>
              <topics type="attached">
                <topic id="tagged">
                  <title>Tagged</title>
                  <labels><label>alpha</label><label>beta</label></labels>
                </topic>
              </topics>
            </children>
          </topic>
        </sheet>
      </xmap-content>`);

    const document = await importFromXmindZip(data);

    expect(document.root.children[0].text).toBe('Tagged');
    expect(document.root.children[0].note).toContain('alpha, beta');
  });

  it('records the sheet sources in the synthetic multi-sheet root note', async () => {
    const data = await zipEntry('content.json', JSON.stringify([
      { title: 'First sheet', rootTopic: { id: 'r1', title: 'Sheet A' } },
      { rootTopic: { id: 'r2', title: 'Sheet B' } },
    ]));

    const document = await importFromXmindZip(data);

    expect(document.root.note).toContain('2');
    expect(document.root.note).toContain('First sheet');
    // sheet 无标题时回退到该 sheet 根主题标题
    expect(document.root.note).toContain('Sheet B');
  });

  it('imports every valid JSON sheet under a synthetic root without root ID collisions', async () => {
    const data = await zipEntry('content.json', JSON.stringify([
      { rootTopic: { id: 'root', title: 'Sheet A' } },
      { ignored: true },
      { rootTopic: { id: 'root', title: 'Sheet B' } },
    ]));

    const document = await importFromXmindZip(data);
    const childIds = document.root.children.map((node) => node.id);

    expect(document.root.id).toBe('root');
    expect(document.root.children.map((node) => node.text)).toEqual(['Sheet A', 'Sheet B']);
    expect(childIds).not.toContain('root');
    expect(new Set(childIds).size).toBe(2);
  });

  it('imports every valid XML sheet under a synthetic root without root ID collisions', async () => {
    const data = await zipEntry('content.xml', `<?xml version="1.0" encoding="UTF-8"?>
      <xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0">
        <sheet id="sheet-a"><topic id="root"><title>Sheet A</title></topic></sheet>
        <sheet id="invalid" />
        <sheet id="sheet-b"><topic id="root"><title>Sheet B</title></topic></sheet>
      </xmap-content>`);

    const document = await importFromXmindZip(data);
    const childIds = document.root.children.map((node) => node.id);

    expect(document.root.id).toBe('root');
    expect(document.root.children.map((node) => node.text)).toEqual(['Sheet A', 'Sheet B']);
    expect(childIds).not.toContain('root');
    expect(new Set(childIds).size).toBe(2);
  });

  it('rejects an oversized compressed archive before opening it', async () => {
    const data = new Uint8Array(MAX_XMIND_ARCHIVE_BYTES + 1);
    await expect(importFromXmindZip(data)).rejects.toThrow('archive exceeds maximum size');
  });

  it('rejects oversized uncompressed content before JSON parsing', async () => {
    const zip = new JSZip();
    zip.file('content.json', `${JSON.stringify([{ rootTopic: { title: 'Large' } }])}${' '.repeat(MAX_XMIND_CONTENT_BYTES + 1)}`);
    const data = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });

    expect(data.byteLength).toBeLessThan(MAX_XMIND_ARCHIVE_BYTES);
    await expect(importFromXmindZip(data)).rejects.toThrow('content exceeds maximum size');
  });

  it('rejects archives without required content', async () => {
    const data = await zipEntry('metadata.json', '{}');
    await expect(importFromXmindZip(data)).rejects.toThrow('content.json or content.xml not found');
  });

  // ==========================================================================
  // 图片内联预算（单图上限 + 整次导入的数量/累计解压/累计内联预算）
  // ==========================================================================

  /** 生成含 n 个引用同一图片资源的 topic 的 .xmind zip */
  async function zipWithImageTopics(
    topicCount: number,
    imageBytes: Uint8Array,
  ): Promise<Uint8Array> {
    const zip = new JSZip();
    zip.file('content.json', JSON.stringify([{
      rootTopic: {
        id: 'r',
        title: 'Root',
        children: {
          attached: Array.from({ length: topicCount }, (_, i) => ({
            id: `t${i}`,
            title: `Topic ${i}`,
            image: { src: 'xap:resources/img.png' },
          })),
        },
      },
    }]));
    zip.file('resources/img.png', imageBytes);
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  }

  it('embeds a small referenced image as a data URL', async () => {
    const data = await zipWithImageTopics(1, new Uint8Array([137, 80, 78, 71, 13, 10]));
    const report = createXmindImportReport();

    const document = await importFromXmindZip(data, report);

    expect(document.root.children[0].images?.[0]?.src).toMatch(/^data:image\/png;base64,/);
    expect(report.embeddedImages).toBe(1);
    expect(report.droppedImages).toBe(0);
  });

  it('rejects a single image above the per-image cap before inlining it', async () => {
    // advertised uncompressed size 已超单图上限：解压前即被前置拒绝；
    // 即使头部被伪造，readZipEntryWithLimit 的流式累计也会在超限的第一个
    // chunk 处硬中断（该路径由 content.json 的超限测试共同覆盖）。
    const data = await zipWithImageTopics(1, new Uint8Array(MAX_INLINE_IMAGE_BYTES + 1));
    const report = createXmindImportReport();

    const document = await importFromXmindZip(data, report);

    expect(document.root.children[0].images).toBeUndefined();
    expect(document.root.children[0].note).toContain('imagePlaceholderNote');
    expect(report.embeddedImages).toBe(0);
    expect(report.droppedImages).toBe(1);
  });

  it('caps the number of inlined images per import', async () => {
    const extra = 5;
    const data = await zipWithImageTopics(
      MAX_IMPORT_IMAGE_COUNT + extra,
      new Uint8Array([1, 2, 3, 4]),
    );
    const report = createXmindImportReport();

    const document = await importFromXmindZip(data, report);

    expect(report.embeddedImages).toBe(MAX_IMPORT_IMAGE_COUNT);
    expect(report.droppedImages).toBe(extra);
    // 超出数量预算的引用仍保留备注占位（不是静默消失）
    const dropped = document.root.children.filter((node) => !node.images?.length);
    expect(dropped).toHaveLength(extra);
    expect(dropped[0].note).toContain('imagePlaceholderNote');
  });

  it('stops inlining once the cumulative inline budget is exhausted', async () => {
    // 每张 200 KiB（单图限内），但累计 data URL 字符量会先耗尽内联预算
    const imageBytes = 200 * 1024;
    const dataUrlLength = 'data:image/png;base64,'.length + Math.ceil(imageBytes / 3) * 4;
    const expectedEmbedded = Math.floor(MAX_IMPORT_IMAGE_INLINE_TOTAL_BYTES / dataUrlLength);
    const topicCount = expectedEmbedded + 10;
    const data = await zipWithImageTopics(topicCount, new Uint8Array(imageBytes));
    const report = createXmindImportReport();

    const document = await importFromXmindZip(data, report);

    expect(expectedEmbedded).toBeGreaterThan(0);
    expect(report.embeddedImages).toBe(expectedEmbedded);
    expect(report.droppedImages).toBe(topicCount - expectedEmbedded);
    const totalInlineChars = document.root.children
      .flatMap((node) => node.images ?? [])
      .reduce((sum, image) => sum + image.src.length, 0);
    expect(totalInlineChars).toBeLessThanOrEqual(MAX_IMPORT_IMAGE_INLINE_TOTAL_BYTES);
  });
});
