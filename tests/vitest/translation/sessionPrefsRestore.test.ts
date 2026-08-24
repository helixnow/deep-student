/**
 * 新建翻译的语向/正式度偏好恢复
 *
 * 两层保障：
 * 1. 适配器（dstuNodeToTranslationSession）对缺失字段不注入幽灵
 *    'auto'/'zh-CN' 默认值 —— 否则工作台永远看不到「会话未持久化语向」；
 * 2. 工作台解析链（resolveSessionPrefs）：会话值 → 用户偏好 → 内建默认。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  dstuNodeToTranslationSession,
  parseTranslationContent,
} from '@/dstu/adapters/translationDstuAdapter';
import { resolveSessionPrefs } from '@/translation/sessionPrefs';
import type { DstuNode } from '@/dstu/types';

const makeNode = (metadata: Record<string, unknown>): DstuNode => ({
  id: 'tr_test',
  path: '/tr_test',
  name: 'test',
  type: 'translation',
  createdAt: 1,
  updatedAt: 2,
  metadata,
});

describe('适配器不注入幽灵语向默认值', () => {
  it('metadata 缺语向/正式度时保持 undefined（不再是 auto/zh-CN）', () => {
    const session = dstuNodeToTranslationSession(makeNode({}));
    expect(session.srcLang).toBeUndefined();
    expect(session.tgtLang).toBeUndefined();
    expect(session.formality).toBeUndefined();
  });

  it('metadata 有语向时正常透传并 normalize（zh → zh-CN）', () => {
    const session = dstuNodeToTranslationSession(
      makeNode({ srcLang: 'en', tgtLang: 'zh', formality: 'formal' })
    );
    expect(session.srcLang).toBe('en');
    expect(session.tgtLang).toBe('zh-CN');
    expect(session.formality).toBe('formal');
  });

  it('非法 formality 值不透传', () => {
    const session = dstuNodeToTranslationSession(makeNode({ formality: 'shouty' }));
    expect(session.formality).toBeUndefined();
  });
});

describe('resolveSessionPrefs 解析链：会话值 → 用户偏好 → 内建默认', () => {
  it('新建空翻译（会话无语向）落到用户偏好', () => {
    const resolved = resolveSessionPrefs(
      { srcLang: undefined, tgtLang: undefined, formality: undefined },
      { srcLang: 'en', tgtLang: 'ja', formality: 'formal' }
    );
    expect(resolved).toEqual({ srcLang: 'en', tgtLang: 'ja', formality: 'formal' });
  });

  it('会话已持久化的值优先于偏好', () => {
    const resolved = resolveSessionPrefs(
      { srcLang: 'fr', tgtLang: 'de', formality: 'casual' },
      { srcLang: 'en', tgtLang: 'ja', formality: 'formal' }
    );
    expect(resolved).toEqual({ srcLang: 'fr', tgtLang: 'de', formality: 'casual' });
  });

  it('会话与偏好都缺失时回落内建默认 auto/zh-CN/auto', () => {
    expect(resolveSessionPrefs(null, {})).toEqual({
      srcLang: 'auto',
      tgtLang: 'zh-CN',
      formality: 'auto',
    });
  });

  it('会话字段部分缺失时逐字段独立回落', () => {
    const resolved = resolveSessionPrefs(
      { srcLang: 'en', tgtLang: undefined, formality: undefined },
      { tgtLang: 'ko' }
    );
    expect(resolved).toEqual({ srcLang: 'en', tgtLang: 'ko', formality: 'auto' });
  });
});

describe('正文 v2 meta 的语向持久化（round-trip 前置）', () => {
  it('v2 正文的 meta 语向可解析（zh normalize 为 zh-CN）', () => {
    const parsed = parseTranslationContent(
      JSON.stringify({
        source: 'hello',
        translated: '你好',
        meta: { schemaVersion: 2, srcLang: 'en', tgtLang: 'zh', formality: 'casual' },
      })
    );
    expect(parsed.meta?.srcLang).toBe('en');
    expect(parsed.meta?.tgtLang).toBe('zh-CN');
    expect(parsed.meta?.formality).toBe('casual');
  });

  it('v1 正文（无 meta）不虚构语向', () => {
    const parsed = parseTranslationContent(
      JSON.stringify({ source: 'hello', translated: '你好' })
    );
    expect(parsed.meta).toBeNull();
  });
});

describe('工作台消费解析链（源码契约）', () => {
  it('TranslateWorkbench 从共享模块导入 resolveSessionPrefs，且状态初始化/会话恢复/持久化快照都走它', () => {
    const source = readFileSync(
      resolve(__dirname, '../../../src/components/TranslateWorkbench.tsx'),
      'utf-8'
    );
    expect(source).toMatch(/from '@\/translation\/sessionPrefs'/);
    // 三个关键消费点：初值 memo、会话恢复 effect、持久化快照
    const usages = source.match(/resolveSessionPrefs\(/g) ?? [];
    expect(usages.length).toBeGreaterThanOrEqual(3);
    // 不允许残留私有实现
    expect(source).not.toMatch(/function resolveSessionPrefs/);
  });
});
