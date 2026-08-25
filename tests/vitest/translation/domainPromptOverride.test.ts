/**
 * 领域预设与 prompt_override 判定
 *
 * 约束（src/translation/promptPresets.ts）：
 * - 仅用户显式改过提示词才发 prompt_override；默认/模板文案交由后端按
 *   领域参数组装（不覆盖 domain_system_prompt）；
 * - 切换领域时默认文案跟随新领域模板，显式修改过的文案保留。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DOMAIN_DEFAULT_PROMPT_KEYS,
  isPromptCustomized,
  promptAfterDomainSwitch,
} from '@/translation/promptPresets';

// 模拟 i18n 展开后的已知默认/模板文案集合
const KNOWN_DEFAULTS = new Set([
  '通用默认提示词',
  '学术模板提示词',
  '技术模板提示词',
]);

describe('isPromptCustomized：仅显式修改视为自定义', () => {
  it('空文案不算自定义（不发 override）', () => {
    expect(isPromptCustomized('', KNOWN_DEFAULTS)).toBe(false);
    expect(isPromptCustomized('   \n', KNOWN_DEFAULTS)).toBe(false);
  });

  it('命中任一默认/模板文案不算自定义（含首尾空白差异）', () => {
    expect(isPromptCustomized('通用默认提示词', KNOWN_DEFAULTS)).toBe(false);
    expect(isPromptCustomized('  学术模板提示词  ', KNOWN_DEFAULTS)).toBe(false);
  });

  it('用户显式修改过的文案才算自定义', () => {
    expect(isPromptCustomized('请用鲁迅的口吻翻译', KNOWN_DEFAULTS)).toBe(true);
  });
});

describe('promptAfterDomainSwitch：切领域默认文案跟随', () => {
  it('提示词为空或仍是默认文案时，跟随新领域模板', () => {
    expect(promptAfterDomainSwitch('', '学术模板提示词', KNOWN_DEFAULTS)).toBe('学术模板提示词');
    expect(
      promptAfterDomainSwitch('通用默认提示词', '技术模板提示词', KNOWN_DEFAULTS)
    ).toBe('技术模板提示词');
  });

  it('用户显式修改过的提示词在切领域时保留', () => {
    expect(
      promptAfterDomainSwitch('请用鲁迅的口吻翻译', '学术模板提示词', KNOWN_DEFAULTS)
    ).toBe('请用鲁迅的口吻翻译');
  });
});

describe('领域模板 key 表', () => {
  it('五个领域各有默认文案 key 且互不相同', () => {
    const keys = Object.values(DOMAIN_DEFAULT_PROMPT_KEYS);
    expect(Object.keys(DOMAIN_DEFAULT_PROMPT_KEYS)).toEqual(
      expect.arrayContaining(['general', 'academic', 'technical', 'literary', 'casual'])
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('工作台接线（源码契约）', () => {
  const source = readFileSync(
    resolve(__dirname, '../../../src/components/TranslateWorkbench.tsx'),
    'utf-8'
  );

  it('prompt_override 仅在 isPromptCustomized 时发送', () => {
    expect(source).toMatch(/prompt_override:\s*isPromptCustomized\s*\?\s*customPrompt\s*:\s*undefined/);
  });

  it('持久化 customPrompt 同样受 isPromptCustomized 门控（默认文案不落盘）', () => {
    const gated = source.match(
      /customPrompt:\s*isPromptCustomized\s*\?\s*customPrompt\s*:\s*undefined/g
    ) ?? [];
    // 流式完成保存 / 编辑译文保存 / 评分保存 / 保存并关闭，至少 4 处
    expect(gated.length).toBeGreaterThanOrEqual(4);
    // 不允许任何未门控的 customPrompt 持久化写法
    expect(source).not.toMatch(/customPrompt:\s*customPrompt\s*[,}]/);
  });

  it('恢复默认提示词跟随当前领域模板（不是写死通用默认）', () => {
    expect(source).toMatch(/setCustomPrompt\(defaultPromptForDomain\(domain\)\)/);
  });

  it('切换领域走共享 promptAfterDomainSwitch 规则', () => {
    expect(source).toMatch(/promptAfterDomainSwitch\(/);
    expect(source).toMatch(/from '@\/translation\/promptPresets'/);
  });
});
