/**
 * .xmind 图片内嵌导入测试（第二波：不只备注占位）：
 * - zip 内小图（≤ MAX_INLINE_IMAGE_BYTES）内联为 node.images 的 data URL；
 * - 超限 / 缺资源 / 空文件降级为既有备注占位 + droppedImages 计数；
 * - JSON（content.json image.src）与 XML（<xhtml:img>）两条路径都覆盖；
 * - 导入报告 embeddedImages / droppedImages 口径。
 */
import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';

// 与 importExportIo.test.ts 相同的 i18n mock：让占位文案确定可断言
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
  MAX_INLINE_IMAGE_BYTES,
  createXmindImportReport,
  importFromXmindZip,
} from '@/features/mindmap/utils/importers';

// 1x1 透明 PNG（67 字节）
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_PNG_BYTES = Uint8Array.from(atob(TINY_PNG_BASE64), (ch) => ch.charCodeAt(0));

async function zipBytes(build: (zip: JSZip) => void): Promise<Uint8Array> {
  const zip = new JSZip();
  build(zip);
  return zip.generateAsync({ type: 'uint8array' });
}

describe('importFromXmindZip image embedding (JSON path)', () => {
  it('inlines small zip-internal images as data URLs with dimensions', async () => {
    const report = createXmindImportReport();
    const bytes = await zipBytes((zip) => {
      zip.file('content.json', JSON.stringify([{
        rootTopic: {
          id: 'r',
          title: 'Root',
          children: {
            attached: [{
              id: 'c1',
              title: 'WithImage',
              image: { src: 'xap:resources/pic.png', width: 120, height: 80 },
            }],
          },
        },
      }]));
      zip.file('resources/pic.png', TINY_PNG_BYTES);
    });

    const imported = await importFromXmindZip(bytes, report);
    const node = imported.root.children[0];
    expect(node.images).toHaveLength(1);
    expect(node.images?.[0].src.startsWith('data:image/png;base64,')).toBe(true);
    // data URL 应能还原出原始字节
    expect(node.images?.[0].src.split(',')[1]).toBe(TINY_PNG_BASE64);
    expect(node.images?.[0]).toMatchObject({ name: 'pic.png', width: 120, height: 80 });
    // 内嵌成功不计丢弃、不加备注占位
    expect(node.note ?? '').not.toContain('imagePlaceholderNote');
    expect(report.embeddedImages).toBe(1);
    expect(report.droppedImages).toBe(0);
  });

  it('falls back to note placeholder for oversized images', async () => {
    const report = createXmindImportReport();
    const bytes = await zipBytes((zip) => {
      zip.file('content.json', JSON.stringify([{
        rootTopic: {
          id: 'r',
          title: 'Root',
          children: {
            attached: [{ id: 'c1', title: 'Big', image: { src: 'xap:resources/big.png' } }],
          },
        },
      }]));
      zip.file('resources/big.png', new Uint8Array(MAX_INLINE_IMAGE_BYTES + 1));
    });

    const imported = await importFromXmindZip(bytes, report);
    const node = imported.root.children[0];
    expect(node.images).toBeUndefined();
    expect(node.note).toContain('mindmap:import.imagePlaceholderNote 1');
    expect(report.embeddedImages).toBe(0);
    expect(report.droppedImages).toBe(1);
  });

  it('drops references to missing or empty resources', async () => {
    const report = createXmindImportReport();
    const bytes = await zipBytes((zip) => {
      zip.file('content.json', JSON.stringify([{
        rootTopic: {
          id: 'r',
          title: 'Root',
          children: {
            attached: [
              { id: 'c1', title: 'Missing', image: { src: 'xap:resources/nope.png' } },
              { id: 'c2', title: 'Empty', image: { src: 'xap:resources/empty.png' } },
            ],
          },
        },
      }]));
      zip.file('resources/empty.png', new Uint8Array(0));
    });

    const imported = await importFromXmindZip(bytes, report);
    expect(imported.root.children[0].images).toBeUndefined();
    expect(imported.root.children[1].images).toBeUndefined();
    expect(report.droppedImages).toBe(2);
    expect(report.embeddedImages).toBe(0);
  });

  it('aggregates multiple dropped images per node into a single placeholder line', async () => {
    const bytes = await zipBytes((zip) => {
      zip.file('content.json', JSON.stringify([{
        rootTopic: { id: 'r', title: 'Root', image: { src: 'xap:resources/a.png' } },
      }]));
    });
    const imported = await importFromXmindZip(bytes);
    expect(imported.root.note).toContain('mindmap:import.imagePlaceholderNote 1');
  });
});

describe('importFromXmindZip image embedding (legacy XML path)', () => {
  it('inlines <xhtml:img> references from content.xml', async () => {
    const report = createXmindImportReport();
    const bytes = await zipBytes((zip) => {
      zip.file('content.xml', `<?xml version="1.0" encoding="UTF-8"?>
<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <sheet id="s1">
    <topic id="t1">
      <title>Root</title>
      <children>
        <topics type="attached">
          <topic id="t2">
            <title>WithImage</title>
            <xhtml:img xhtml:src="xap:attachments/photo.png" svg:width="90" xmlns:svg="http://www.w3.org/2000/svg"/>
          </topic>
        </topics>
      </children>
    </topic>
  </sheet>
</xmap-content>`);
      zip.file('attachments/photo.png', TINY_PNG_BYTES);
    });

    const imported = await importFromXmindZip(bytes, report);
    const node = imported.root.children[0];
    expect(node.images).toHaveLength(1);
    expect(node.images?.[0].name).toBe('photo.png');
    expect(node.images?.[0].width).toBe(90);
    expect(node.images?.[0].src.startsWith('data:image/png;base64,')).toBe(true);
    expect(report.embeddedImages).toBe(1);
    expect(report.droppedImages).toBe(0);
  });
});
