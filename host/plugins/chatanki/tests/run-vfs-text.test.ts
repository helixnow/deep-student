// chatanki_executor.rs:526, :9053, :9719–9751, :9791–9832, :9882–9938, :9976–10154.
import { describe, expect, it } from 'vitest';
import type { VfsContextRefData, VfsResourceRef } from '../api.ts';
import {
  collectImagePayloads, effectiveMaxImages, extractTextFromRefs, looksLikeMaterialText, MAX_REF_TEXT_BYTES,
  mergeOptionalTexts, stripVlmChunkMarkers, textTruncatedWarning, type ChatAnkiRefBlock, type ChatAnkiRefContentSource,
} from '../src/run-vfs-text.ts';
import { createChatAnkiVlmExtractor } from '../src/vlm-extract.ts';

function ref(name: string, type: VfsResourceRef['type'] = 'file'): VfsResourceRef {
  return {
    sourceId: `file_${name}`, resourceHash: `h_${name}`, type, name, resourceId: `res_${name}`, snippet: null, injectModes: null,
  };
}

function refData(...refs: VfsResourceRef[]): VfsContextRefData {
  return { refs, truncated: false, totalCount: refs.length };
}

function source(overrides: Partial<ChatAnkiRefContentSource> & { texts?: Record<string, string> } = {}): ChatAnkiRefContentSource {
  const texts = overrides.texts ?? {};
  return {
    fileExtractedText: (id) => texts[id] ?? null,
    fileContentBase64: () => null,
    extractTextFromBase64: async () => '',
    prepareMediaText: (_id, text) => text,
    resolveRefBlocks: async () => [],
    ...overrides,
  };
}

describe('looks_like_material_text', () => {
  it('needs 120 chars, or 60 chars spanning lines', () => {
    expect(looksLikeMaterialText('继续')).toBe(false);
    expect(looksLikeMaterialText(' \n\t ')).toBe(false);
    expect(looksLikeMaterialText('材'.repeat(119))).toBe(false);
    expect(looksLikeMaterialText(`  ${'材'.repeat(120)}  `)).toBe(true);
    expect(looksLikeMaterialText(`${'材'.repeat(29)}\n${'料'.repeat(30)}`)).toBe(true);
    expect(looksLikeMaterialText(`${'材'.repeat(29)}\n${'料'.repeat(29)}`)).toBe(false);
  });
});

describe('effective_max_images', () => {
  it('keeps the route default without an override and clamps overrides to 1..=12', () => {
    expect(effectiveMaxImages(null, 6)).toBe(6);
    expect(effectiveMaxImages(0, 6)).toBe(1);
    expect(effectiveMaxImages(5, 12)).toBe(5);
    expect(effectiveMaxImages(40, 6)).toBe(12);
  });
});

describe('strip_vlm_chunk_markers', () => {
  it('returns marker-free output unchanged (no trim)', () => {
    expect(stripVlmChunkMarkers('  # 标题\n正文\n\n\n\n尾  ')).toBe('  # 标题\n正文\n\n\n\n尾  ');
  });

  it('drops id/summary lines, turns chunk ends into paragraph breaks and collapses blank runs', () => {
    const input = [
      '[CHUNK_ID]: file-001-chunk-0001', '# 细胞', '线粒体', '  [SUMMARY]: 摘要', '[CHUNK_END]',
      '[CHUNK_ID]: file-001-chunk-0002', '', '', '核糖体\r', '[CHUNK_END]', '',
    ].join('\n');
    expect(stripVlmChunkMarkers(input)).toBe('# 细胞\n线粒体\n\n核糖体');
  });

  it('CRLF-terminated lines come back LF-joined once a marker is present', () => {
    expect(stripVlmChunkMarkers('[CHUNK_ID]: x\r\nA\r\n\r\n\r\n\r\nB\r\n')).toBe('A\n\nB');
  });
});

describe('merge_optional_texts', () => {
  it('trims both sides and joins with a blank line', () => {
    expect(mergeOptionalTexts('  ', null)).toBe('');
    expect(mergeOptionalTexts(' a ', '  ')).toBe('a');
    expect(mergeOptionalTexts('', ' b ')).toBe('b');
    expect(mergeOptionalTexts(' a ', ' b ')).toBe('a\n\nb');
  });
});

describe('extract_text_from_refs', () => {
  it('files use extracted text, else the parsed blob; other refs use resolver text blocks', async () => {
    const parsed: string[] = [];
    const result = await extractTextFromRefs(source({
      texts: { file_a: '甲文本', file_b: '   ' },
      fileContentBase64: (id) => (id === 'file_b' ? 'YmFzZTY0' : null),
      extractTextFromBase64: async (name, base64) => { parsed.push(`${name}:${base64}`); return '乙解析'; },
      prepareMediaText: (id, text) => (id === 'file_b' ? `[媒体] ${text}` : text),
      resolveRefBlocks: async (target, multimodal) => (target.name === 'n'
        ? [{ type: 'text', text: '笔记' }, { type: 'image', mediaType: 'image/png', base64: 'x' }, { type: 'text', text: ' ' }]
        : []) as ChatAnkiRefBlock[],
    }), refData(ref('a'), ref('b'), ref('c'), ref('n', 'note')), () => undefined);
    expect(parsed).toEqual(['b:YmFzZTY0']);
    expect(result).toEqual({
      text: '# a\n\n甲文本\n\n# b\n\n[媒体] 乙解析\n\n笔记', truncated: false, includedFiles: ['a', 'b', 'n'], droppedFiles: [],
    });
  });

  it('a parser failure leaves the file out', async () => {
    const result = await extractTextFromRefs(source({
      fileContentBase64: () => 'eA==',
      extractTextFromBase64: async () => { throw new Error('unsupported'); },
    }), refData(ref('a')), () => undefined);
    expect(result).toEqual({ text: '', truncated: false, includedFiles: [], droppedFiles: [] });
  });

  it('a body cut by the 10 MB budget is both included and dropped; later refs are dropped', async () => {
    const warns: string[] = [];
    const result = await extractTextFromRefs(source({
      texts: { file_a: 'a'.repeat(MAX_REF_TEXT_BYTES - 21), file_b: '中'.repeat(10), file_c: 'c', file_d: 'd' },
    }), refData(ref('a'), ref('b'), ref('c'), ref('d')), (message) => { warns.push(message); });
    expect(result.truncated).toBe(true);
    expect(result.includedFiles).toEqual(['a', 'b']);
    expect(result.droppedFiles).toEqual(['b', 'c', 'd']);
    expect(result.text.endsWith('\n\n# b\n\n中中')).toBe(true);
    expect(warns).toEqual([`[ChatAnki] Truncated context refs text at ${MAX_REF_TEXT_BYTES} bytes; dropped file(s): b, c, d`]);
    expect(textTruncatedWarning(result)).toEqual({
      code: 'text_truncated', messageKey: 'blocks.ankiCards.warnings.textTruncated',
      messageParams: { limitMB: 10, droppedCount: 3, droppedFiles: ['b', 'c', 'd'] },
      includedFiles: ['a', 'b'], droppedFiles: ['b', 'c', 'd'],
    });
  });

  it('an exactly exhausted budget drops the next ref at the loop head', async () => {
    const result = await extractTextFromRefs(source({
      texts: { file_a: 'a'.repeat(MAX_REF_TEXT_BYTES - 21), file_b: '中中x', file_c: 'c', file_d: 'd' },
    }), refData(ref('a'), ref('b'), ref('c'), ref('d')), () => undefined);
    expect(result.includedFiles).toEqual(['a', 'b']);
    expect(result.droppedFiles).toEqual(['c', 'd']);
    expect(result.truncated).toBe(true);
  });
});

describe('collect_image_payloads', () => {
  it('keeps the first maxImages images and reports the total', async () => {
    const seen: boolean[] = [];
    const batch = await collectImagePayloads(source({
      resolveRefBlocks: async (target, multimodal) => {
        seen.push(multimodal);
        return [
          { type: 'image', mediaType: 'image/png', base64: `${target.name}1` },
          { type: 'text', text: 't' },
          { type: 'image', mediaType: 'image/jpeg', base64: `${target.name}2` },
        ];
      },
    }), [ref('p', 'image'), ref('q', 'image')], 3);
    expect(seen).toEqual([true, true]);
    expect(batch).toEqual({
      payloads: [{ mime: 'image/png', base64: 'p1' }, { mime: 'image/jpeg', base64: 'p2' }, { mime: 'image/png', base64: 'q1' }],
      totalImages: 4, truncated: true,
    });
  });
});

describe('call_vlm_extract', () => {
  const images = [{ mime: 'image/png', base64: 'AA==' }];

  function rawPrompt(calls: unknown[][], fail: { routed: boolean; model2: boolean }) {
    return {
      callAnkiRoutedRawPrompt: async (...args: unknown[]) => {
        calls.push(['routed', ...args]);
        if (fail.routed) throw new Error('vision offline');
        return { assistant_message: 'routed' } as never;
      },
      callModel2RawPrompt: async (...args: unknown[]) => {
        calls.push(['model2', ...args]);
        if (fail.model2) throw new Error('model2 offline');
        return { assistant_message: 'model2' } as never;
      },
    };
  }

  it('a Vlm decision goes through the routed exit with the task and images; a failed call retries model2 with the images once', async () => {
    const calls: unknown[][] = [];
    const warnings: string[] = [];
    const fail = { routed: false, model2: false };
    const roles: unknown[] = [];
    const decision = { role: 'vlm', configId: 'cfg-vision', model: 'vision' } as never;
    const extractor = createChatAnkiVlmExtractor(
      { resolveAnkiRoleDecision: async (role, mode) => { roles.push([role, mode]); return decision; } },
      rawPrompt(calls, fail), (message) => { warnings.push(message); },
    );
    expect(await extractor.callVlmExtract('chatanki.vlm_full_extract', 'P', images)).toBe('routed');
    expect(roles).toEqual([['vlm', 'auto']]);
    expect(calls).toEqual([['routed', decision, 'chatanki.vlm_full_extract', 'P', images]]);
    expect(warnings).toEqual([]);

    calls.length = 0;
    fail.routed = true;
    expect(await extractor.callVlmExtract('chatanki.vlm_light_extract', 'P', images)).toBe('model2');
    expect(calls).toEqual([
      ['routed', decision, 'chatanki.vlm_light_extract', 'P', images], ['model2', 'P', images, 'anki'],
    ]);
    expect(warnings).toEqual(['[chatanki] Vlm 槽调用失败，回退原 model2 图片提取路径: vision offline']);

    calls.length = 0; warnings.length = 0;
    fail.model2 = true;
    await expect(extractor.callVlmExtract('chatanki.vlm_light_extract', 'P', images)).rejects.toThrow('model2 offline');
    expect(calls.map(([kind]) => kind)).toEqual(['routed', 'model2']);
  });

  it('without a decision the routed exit is called with null and its failure is not retried', async () => {
    const calls: unknown[][] = [];
    const warnings: string[] = [];
    for (const routing of [null, { resolveAnkiRoleDecision: async () => null }]) {
      calls.length = 0;
      const extractor = createChatAnkiVlmExtractor(routing, rawPrompt(calls, { routed: true, model2: false }),
        (message) => { warnings.push(message); });
      await expect(extractor.callVlmExtract('chatanki.vlm_light_extract', 'P', images)).rejects.toThrow('vision offline');
      expect(calls).toEqual([['routed', null, 'chatanki.vlm_light_extract', 'P', images]]);
    }
    expect(warnings).toEqual([]);
  });
});
