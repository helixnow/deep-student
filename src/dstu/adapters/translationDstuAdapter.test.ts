import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuNode } from '../types';

const dstuMocks = vi.hoisted(() => ({
  create: vi.fn(),
  delete: vi.fn(),
  get: vi.fn(),
  getContent: vi.fn(),
  list: vi.fn(),
  setFavorite: vi.fn(),
  setMetadata: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../api', () => ({ dstu: dstuMocks }));

import {
  TRANSLATION_CONTENT_SCHEMA_VERSION,
  buildTranslationContent,
  parseTranslationContent,
  translationDstuAdapter,
} from './translationDstuAdapter';

const node = (metadata: Record<string, unknown> = {}): DstuNode => ({
  id: 'tr_test',
  sourceId: 'tr_test',
  path: '/tr_test',
  name: 'test',
  type: 'translation',
  createdAt: 1,
  updatedAt: 2,
  metadata,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('translation v2 正文持久化', () => {
  it('构建并解析完整会话设置', () => {
    const raw = buildTranslationContent({
      id: 'tr_test',
      sourceText: 'source',
      translatedText: '译文',
      srcLang: 'en',
      tgtLang: 'zh-CN',
      formality: 'formal',
      domain: 'academic',
      glossary: [['term', '术语']],
      customPrompt: '保留公式编号',
      createdAt: 1,
      updatedAt: 2,
    });

    expect(parseTranslationContent(raw)).toEqual({
      source: 'source',
      translated: '译文',
      meta: {
        schemaVersion: TRANSLATION_CONTENT_SCHEMA_VERSION,
        srcLang: 'en',
        tgtLang: 'zh-CN',
        formality: 'formal',
        domain: 'academic',
        glossary: [['term', '术语']],
        customPrompt: '保留公式编号',
      },
    });
  });

  it('读取 v2 正文时清除节点 metadata 中已删除的术语表与自定义提示词', async () => {
    dstuMocks.get.mockResolvedValue({
      ok: true,
      value: node({
        sourceText: 'stale source',
        translatedText: 'stale target',
        domain: 'legal',
        glossary: [['old', '旧']],
        customPrompt: '旧覆盖',
      }),
    });
    dstuMocks.getContent.mockResolvedValue({
      ok: true,
      value: JSON.stringify({
        source: 'fresh source',
        translated: 'fresh target',
        meta: {
          schemaVersion: TRANSLATION_CONTENT_SCHEMA_VERSION,
          srcLang: 'en',
          tgtLang: 'zh-CN',
          formality: 'auto',
          domain: 'general',
        },
      }),
    });

    const result = await translationDstuAdapter.getTranslation('tr_test');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.metadata).toMatchObject({
      sourceText: 'fresh source',
      translatedText: 'fresh target',
      srcLang: 'en',
      tgtLang: 'zh-CN',
      formality: 'auto',
      domain: 'general',
    });
    expect(result.value.metadata).not.toHaveProperty('glossary');
    expect(result.value.metadata).not.toHaveProperty('customPrompt');
  });

  it('无 schemaVersion 的历史 meta 仍按增量覆盖，不误删节点设置', async () => {
    dstuMocks.get.mockResolvedValue({
      ok: true,
      value: node({ domain: 'medical', customPrompt: '历史提示词' }),
    });
    dstuMocks.getContent.mockResolvedValue({
      ok: true,
      value: JSON.stringify({
        source: 'source',
        translated: 'target',
        meta: { srcLang: 'en', tgtLang: 'zh-CN' },
      }),
    });

    const result = await translationDstuAdapter.getTranslation('tr_test');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.metadata).toMatchObject({
      domain: 'medical',
      customPrompt: '历史提示词',
      srcLang: 'en',
      tgtLang: 'zh-CN',
    });
  });

  it('创建后返回节点立即合并 v2 会话设置', async () => {
    dstuMocks.create.mockResolvedValue({ ok: true, value: node() });
    dstuMocks.update.mockResolvedValue({ ok: true, value: node() });

    const result = await translationDstuAdapter.createTranslation({
      id: 'temporary',
      sourceText: 'source',
      translatedText: 'target',
      srcLang: 'en',
      tgtLang: 'zh-CN',
      formality: 'formal',
      domain: 'technical',
      glossary: [['API', '接口']],
      customPrompt: '保留代码',
      createdAt: 1,
      updatedAt: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.metadata).toMatchObject({
      sourceText: 'source',
      translatedText: 'target',
      srcLang: 'en',
      tgtLang: 'zh-CN',
      formality: 'formal',
      domain: 'technical',
      glossary: [['API', '接口']],
      customPrompt: '保留代码',
    });
  });
});
