/**
 * 共享层用户可见文案 i18n 契约：
 * - 模板渲染 issue（模板编辑器预览 / 卡面提示）
 * - 供应商品牌显示名（ProviderIcon tooltip / 文本）
 * - 内置 MCP 服务器显示名（设置页 / 输入栏 MCP 面板）
 *
 * 约束：英文界面取 en-US 译文；i18n 未就绪时与 zh-CN 原文逐字一致；
 * 标签字面量（含 {{ }}）作为变量传入，不被 i18next 插值吞掉。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import zhCommon from '@/locales/zh-CN/common.json';
import enCommon from '@/locales/en-US/common.json';
import zhMcp from '@/locales/zh-CN/mcp.json';
import enMcp from '@/locales/en-US/mcp.json';

const { state } = vi.hoisted(() => ({ state: { lang: null as null | 'en-US' | 'zh-CN' } }));

function lookup(lang: 'en-US' | 'zh-CN', fullKey: string): string | undefined {
  const [ns, key] = fullKey.split(':');
  const bundles: Record<string, Record<string, unknown>> = lang === 'en-US'
    ? { common: enCommon, mcp: enMcp }
    : { common: zhCommon, mcp: zhMcp };
  const value = key.split('.').reduce<unknown>(
    (acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined),
    bundles[ns],
  );
  return typeof value === 'string' ? value : undefined;
}

vi.mock('i18next', () => ({
  default: {
    get language() {
      return state.lang ?? undefined;
    },
    // 未设置语言时模拟 i18n 未初始化（返回 undefined）
    t: (key: string, options: Record<string, unknown> = {}) => {
      if (!state.lang) return undefined;
      const template = lookup(state.lang, key) ?? (options.defaultValue as string | undefined) ?? key;
      // 单遍插值，与 i18next skipOnVariables 行为一致
      return template.replace(/\{\{(\w+)\}\}/g, (m, name: string) =>
        name in options ? String(options[name]) : m,
      );
    },
  },
}));

import { compileAnkiTemplate, clearAnkiTemplateCache, renderAnkiTemplate } from '../ankiTemplateEngine';
import { getProviderInfo, getProviderDisplayName } from '@/utils/providerIconEngine';
import { getBuiltinServer, BUILTIN_SERVER_NAME } from '@/mcp/builtinMcpServer';

afterEach(() => {
  state.lang = null;
  clearAnkiTemplateCache();
});

describe('ankiTemplateEngine issue messages', () => {
  it('falls back to the zh-CN wording with tag literals intact when i18n is not ready', () => {
    const { issues } = compileAnkiTemplate('{{#A}}x{{/B}}{{=x=}}');
    expect(issues.map((issue) => issue.message)).toEqual([
      '结束标签 {{/B}} 与开始标签 {{#A}} 不匹配',
      '不支持的模板标签 {{=x=}}',
      '条件段 {{#A}} 缺少结束标签 {{/A}}',
    ]);
    const front = renderAnkiTemplate('{{FrontSide}}', {}, { side: 'front' });
    expect(front.issues[0].message).toBe('{{FrontSide}} 只能用于背面模板');
  });

  it('uses en-US wording and re-compiles after a language switch', () => {
    expect(compileAnkiTemplate('{{}}').issues[0].message).toBe('空的模板标签');
    state.lang = 'en-US';
    expect(compileAnkiTemplate('{{}}').issues[0].message).toBe('Empty template tag');
    expect(compileAnkiTemplate('{{#A}}').issues[0].message).toBe(
      'Conditional section {{#A}} is missing its closing tag {{/A}}',
    );
    const front = renderAnkiTemplate('{{FrontSide}}', {}, { side: 'front' });
    expect(front.issues[0].message).toBe('{{FrontSide}} can only be used in the back template');
  });

  it('zh-CN locale matches the original literals', () => {
    state.lang = 'zh-CN';
    expect(compileAnkiTemplate('{{nofilter:}}').issues[0].message).toBe('过滤器缺少字段名 {{nofilter:}}');
    expect(compileAnkiTemplate('{{bogus:Field}}').issues[0].message).toBe(
      '未知的模板过滤器「bogus」，已按普通字段渲染',
    );
  });
});

describe('provider brand display names', () => {
  it('keeps the Chinese brand name without i18n and localizes it in en-US', () => {
    expect(getProviderDisplayName('doubao-pro')).toBe('字节跳动');
    state.lang = 'en-US';
    expect(getProviderDisplayName('doubao-pro')).toBe('ByteDance');
    expect(getProviderInfo('deepseek-chat').displayName).toBe('DeepSeek');
  });
});

describe('builtin MCP server name', () => {
  it('resolves the server name at call time', () => {
    expect(getBuiltinServer().name).toBe(BUILTIN_SERVER_NAME);
    state.lang = 'en-US';
    const server = getBuiltinServer();
    expect(server.name).toBe('Built-in Tools');
    expect(server.tools.every((tool) => tool.serverName === 'Built-in Tools')).toBe(true);
  });
});
