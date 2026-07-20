import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import {
  importFromXMind,
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

describe('importFromXMind', () => {
  it('imports XMind Zen attached topics into the existing tree model', async () => {
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

    const document = await importFromXMind(data);

    expect(document.root).toMatchObject({
      id: 'root',
      text: 'Biology',
      note: 'Course map',
      children: [{ id: 'cell', text: 'Cell', children: [{ id: 'nucleus', text: 'Nucleus' }] }],
    });
    expect(document.associations).toBeUndefined();
  });

  it('maps XMind Zen task markers and relationships onto the document', async () => {
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

    const document = await importFromXMind(data);

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

  it('imports XMind 8 attached topics and ignores detached topics', async () => {
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

    const document = await importFromXMind(data);

    expect(document.root.text).toBe('Physics');
    expect(document.root.note).toBe('Exam review');
    expect(document.root.children.map((node) => node.text)).toEqual(['Waves']);
  });

  it('maps XMind 8 marker-refs and sheet relationships onto the document', async () => {
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

    const document = await importFromXMind(data);

    expect(document.root.children.map((node) => node.completed)).toEqual([false, true]);
    expect(document.associations).toHaveLength(1);
    expect(document.associations?.[0]).toMatchObject({
      source: 'todo',
      target: 'done',
      label: 'blocks',
    });
  });

  it('maps Zen labels and non-task markers into note lines, priority into a text prefix', async () => {
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

    const document = await importFromXMind(data);
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

  it('maps XMind 8 labels into note lines', async () => {
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

    const document = await importFromXMind(data);

    expect(document.root.children[0].text).toBe('Tagged');
    expect(document.root.children[0].note).toContain('alpha, beta');
  });

  it('records the sheet sources in the synthetic multi-sheet root note', async () => {
    const data = await zipEntry('content.json', JSON.stringify([
      { title: 'First sheet', rootTopic: { id: 'r1', title: 'Sheet A' } },
      { rootTopic: { id: 'r2', title: 'Sheet B' } },
    ]));

    const document = await importFromXMind(data);

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

    const document = await importFromXMind(data);
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

    const document = await importFromXMind(data);
    const childIds = document.root.children.map((node) => node.id);

    expect(document.root.id).toBe('root');
    expect(document.root.children.map((node) => node.text)).toEqual(['Sheet A', 'Sheet B']);
    expect(childIds).not.toContain('root');
    expect(new Set(childIds).size).toBe(2);
  });

  it('rejects an oversized compressed archive before opening it', async () => {
    const data = new Uint8Array(MAX_XMIND_ARCHIVE_BYTES + 1);
    await expect(importFromXMind(data)).rejects.toThrow('archive exceeds maximum size');
  });

  it('rejects oversized uncompressed content before JSON parsing', async () => {
    const zip = new JSZip();
    zip.file('content.json', `${JSON.stringify([{ rootTopic: { title: 'Large' } }])}${' '.repeat(MAX_XMIND_CONTENT_BYTES + 1)}`);
    const data = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });

    expect(data.byteLength).toBeLessThan(MAX_XMIND_ARCHIVE_BYTES);
    await expect(importFromXMind(data)).rejects.toThrow('content exceeds maximum size');
  });

  it('rejects archives without XMind content', async () => {
    const data = await zipEntry('metadata.json', '{}');
    await expect(importFromXMind(data)).rejects.toThrow('content.json or content.xml not found');
  });
});
