/**
 * EMPTY_RESOURCE_TEMPLATES 默认名 i18n 契约测试
 *
 * 约束：
 * 1. defaultName / mindmap content 的可本地化字段是 getter，按当前语言经 i18n 求值；
 *    无译文（仅 defaultValue 兜底）时必须与主干原文完全一致，不改产品文案。
 * 2. 无完全相等已有 key 的名称（新教材/新题目集/新翻译/新作文）保持字面量。
 * 3. factory.ts 不做任何改动：本地化通过 types.ts 的 getter 对 factory 透明生效。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_RESOURCE_TEMPLATES } from '../types';

const { translations } = vi.hoisted(() => ({
  translations: new Map<string, string>(),
}));

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string, options?: { defaultValue?: string }) =>
      translations.get(key) ?? options?.defaultValue ?? key,
  },
}));

afterEach(() => {
  translations.clear();
});

describe('EMPTY_RESOURCE_TEMPLATES defaultName i18n', () => {
  it('无译文时（defaultValue 兜底）与主干原文完全一致', () => {
    expect(EMPTY_RESOURCE_TEMPLATES.note.defaultName).toBe('无标题笔记');
    expect(EMPTY_RESOURCE_TEMPLATES.mindmap.defaultName).toBe('新思维导图');
    expect(EMPTY_RESOURCE_TEMPLATES.retrieval.defaultName).toBe('检索结果');
  });

  it('无完全相等已有 key 的名称保持字面量', () => {
    expect(EMPTY_RESOURCE_TEMPLATES.textbook.defaultName).toBe('新教材');
    expect(EMPTY_RESOURCE_TEMPLATES.exam.defaultName).toBe('新题目集');
    expect(EMPTY_RESOURCE_TEMPLATES.translation.defaultName).toBe('新翻译');
    expect(EMPTY_RESOURCE_TEMPLATES.essay.defaultName).toBe('新作文');
  });

  it('defaultName 是 getter：每次读取按当前语言重新求值', () => {
    translations.set('learningHub:contextMenu.untitledNote', 'Untitled Note');
    translations.set('mindmap:embed.newMindMap', 'New Mind Map');
    translations.set('enhanced_rag:rag_search.results_title', 'Search Results');

    expect(EMPTY_RESOURCE_TEMPLATES.note.defaultName).toBe('Untitled Note');
    expect(EMPTY_RESOURCE_TEMPLATES.mindmap.defaultName).toBe('New Mind Map');
    expect(EMPTY_RESOURCE_TEMPLATES.retrieval.defaultName).toBe('Search Results');

    translations.clear();
    expect(EMPTY_RESOURCE_TEMPLATES.note.defaultName).toBe('无标题笔记');
  });
});

describe('EMPTY_RESOURCE_TEMPLATES.mindmap.content i18n', () => {
  it('无译文时中心主题与主干原文一致，JSON 结构不变', () => {
    const parsed = JSON.parse(EMPTY_RESOURCE_TEMPLATES.mindmap.content ?? '');
    expect(parsed.version).toBe('1.0');
    expect(parsed.root).toMatchObject({ id: 'root', text: '中心主题', children: [] });
    expect(typeof parsed.meta.createdAt).toBe('string');
  });

  it('content 是 getter：stringify 时才取译文，语言切换后重新求值', () => {
    translations.set('mindmap:placeholder.root', 'Central Topic');
    const localized = JSON.parse(EMPTY_RESOURCE_TEMPLATES.mindmap.content ?? '');
    expect(localized.root.text).toBe('Central Topic');

    translations.clear();
    const fallback = JSON.parse(EMPTY_RESOURCE_TEMPLATES.mindmap.content ?? '');
    expect(fallback.root.text).toBe('中心主题');
  });
});

describe('factory.ts 未被改动（本地化对 factory 透明）', () => {
  // vitest 以项目根为 cwd 运行
  const factorySource = readFileSync(resolve(process.cwd(), 'src/dstu/factory.ts'), 'utf-8');

  it('factory.ts 直接读 template.defaultName，默认名不经 i18n 包装', () => {
    // 默认资源名是规范标识，本地化会导致不同 locale 下重复创建同名资源；
    // 错误消息允许本地化（stats:dstu.*），但 defaultName 必须原样使用。
    expect(factorySource).toContain('template.defaultName');
    expect(factorySource).not.toMatch(/i18n\.t\([^)]*defaultName/);
    expect(factorySource).not.toMatch(/defaultName\s*[:=]\s*i18n/);
  });
});
