import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const PROMPT_KEYS = ['ask', 'explain', 'translate', 'summarize', 'hint', 'content_separator'] as const;

function loadPrompts(locale: string): Record<string, string> {
  const raw = readFileSync(resolve(process.cwd(), `src/locales/${locale}/quickAssistant.json`), 'utf-8');
  return (JSON.parse(raw) as { prompts?: Record<string, string> }).prompts ?? {};
}

const serviceSource = readFileSync(resolve(process.cwd(), 'src/quick-assistant/service.ts'), 'utf-8');

describe('quick assistant prompts i18n locales', () => {
  it.each(['zh-CN', 'en-US'])('%s provides every prompt key with non-empty text', (locale) => {
    const prompts = loadPrompts(locale);
    for (const key of PROMPT_KEYS) {
      expect(prompts[key], `${locale} prompts.${key}`).toBeTypeOf('string');
      expect(prompts[key].trim().length, `${locale} prompts.${key}`).toBeGreaterThan(0);
    }
  });

  it('keeps zh-CN prompts identical to the original hardcoded text', () => {
    const prompts = loadPrompts('zh-CN');
    expect(prompts.ask).toBe('请直接回答下面的问题。先给结论，再给必要解释；如果信息不足，请明确指出。');
    expect(prompts.explain).toBe('请把下面内容讲明白。用直观语言说明核心概念、关键关系和一个简短例子，避免无关展开。');
    expect(prompts.translate).toBe('请判断原文语言并翻译成中文；如果原文是中文，则翻译成自然英文。保留术语、公式和段落结构，只输出译文。');
    expect(prompts.summarize).toBe('请总结下面内容，输出：一句话主旨、3-5 个要点、值得记忆的关键词。');
    expect(prompts.hint).toBe('把下面内容视为一道学习题。不要直接给最终答案，先指出考点，再给分层提示和下一步思路。');
    expect(prompts.content_separator).toBe('--- 学习内容 ---');
  });

  it('uses English instructions (no CJK) in en-US prompts', () => {
    const prompts = loadPrompts('en-US');
    for (const key of PROMPT_KEYS) {
      expect(prompts[key], `en-US prompts.${key}`).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });
});

describe('quick assistant service source guards', () => {
  it('resolves prompts through i18n instead of hardcoded Chinese literals', () => {
    expect(serviceSource).toContain("tt(`prompts.${action}`)");
    expect(serviceSource).toContain("tt('prompts.content_separator')");
    expect(serviceSource).not.toContain('请直接回答下面的问题');
    expect(serviceSource).not.toContain('--- 学习内容 ---');
    expect(serviceSource).not.toContain('ACTION_PROMPTS');
  });

  it('keeps bilingual literals for matching pre-existing quick learning groups', () => {
    expect(serviceSource).toContain("'快速学习'");
    expect(serviceSource).toContain("'Quick Learning'");
  });
});
