import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  importFromXMind,
  MAX_XMIND_ARCHIVE_BYTES,
  MAX_XMIND_CONTENT_BYTES,
} from '../importers';

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
