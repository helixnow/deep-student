import { describe, expect, it, vi } from 'vitest';

const { mockGetToolDisplayNameKey } = vi.hoisted(() => ({
  mockGetToolDisplayNameKey: vi.fn(),
}));

vi.mock('@/mcp/builtinMcpServer', () => ({
  getToolDisplayNameKey: mockGetToolDisplayNameKey,
}));

import {
  getExternalToolProviderName,
  getReadableToolName,
  humanizeToolName,
  humanizeToolNameZh,
} from '../toolDisplayName';

describe('toolDisplayName', () => {
  it('humanizes registry names for unknown tools', () => {
    expect(humanizeToolName('tools.template_fork')).toBe('Tools / Template Fork');
    expect(humanizeToolName('builtin-web_search')).toBe('Web Search');
    expect(humanizeToolName('mcp_load_skills')).toBe('Load Skills');
  });

  it('uses i18n name when key exists', () => {
    mockGetToolDisplayNameKey.mockReturnValue('tools.web_search');

    const t = vi.fn((key: string) => {
      if (key === 'tools.web_search') {
        return '联网搜索';
      }
      return '';
    });
    (t as typeof t & { i18n?: { language: string } }).i18n = { language: 'zh-CN' };

    expect(getReadableToolName('builtin-web_search', t)).toBe('联网搜索');
    expect(t).toHaveBeenCalledWith('tools.web_search', { ns: 'mcp', defaultValue: '' });
  });

  it('falls back to humanized name when translation is missing', () => {
    mockGetToolDisplayNameKey.mockReturnValue('tools.template_fork');

    const t = vi.fn(() => '');
    (t as typeof t & { i18n?: { language: string } }).i18n = { language: 'en-US' };

    expect(getReadableToolName('tools.template_fork', t)).toBe('Tools / Template Fork');
  });

  it('falls back to chinese readable name in zh locale', () => {
    mockGetToolDisplayNameKey.mockReturnValue(undefined);

    const t = vi.fn(() => '');
    (t as typeof t & { i18n?: { language: string } }).i18n = { language: 'zh-CN' };

    expect(getReadableToolName('tools.template_fork', t)).toBe('模板复制');
    expect(getReadableToolName('qbank_get_question', t)).toBe('题库获取题目');
    expect(getReadableToolName('builtin-self_inspect', t)).toBe('环境自检');
    expect(getReadableToolName('review_custom_topic', t)).toBe('复习 custom topic');
  });

  it('keeps separators around untranslated tokens in chinese fallback', () => {
    expect(humanizeToolNameZh('skill_community_search')).toBe('技能 community 搜索');
  });

  it('does not map external MCP tools to builtin translations', () => {
    mockGetToolDisplayNameKey.mockReturnValue('tools.web_search');

    const t = vi.fn(() => '网络搜索');
    (t as typeof t & { i18n?: { language: string } }).i18n = { language: 'zh-CN' };

    expect(getReadableToolName('mcp_web_search', t)).toBe('MCP · Web Search');
    expect(t).not.toHaveBeenCalled();
  });

  it('uses the provider name for explicitly external bare tools', () => {
    const t = vi.fn(() => '网络搜索');

    expect(getReadableToolName('web_search', t, {
      source: 'external',
      providerName: 'Acme Search',
    })).toBe('Acme Search · Web Search');
    expect(t).not.toHaveBeenCalled();
  });

  it('reads external provider metadata from tool arguments', () => {
    expect(getExternalToolProviderName({ _serverId: ' Acme Search ' })).toBe('Acme Search');
    expect(getExternalToolProviderName({ serverId: 'fallback-provider' })).toBe('fallback-provider');
    expect(getExternalToolProviderName({ _serverId: 42 })).toBeUndefined();
  });

  it('resolves bare tool names via tools.* i18n keys', () => {
    mockGetToolDisplayNameKey.mockReturnValue(undefined);

    const t = vi.fn((key: string) => {
      if (key === 'tools.self_inspect') {
        return '环境自检';
      }
      return '';
    });
    (t as typeof t & { i18n?: { language: string } }).i18n = { language: 'zh-CN' };

    expect(getReadableToolName('self_inspect', t)).toBe('环境自检');
    expect(t).toHaveBeenCalledWith('tools.self_inspect', { ns: 'mcp', defaultValue: '' });
  });

  it('supports the legacy builtin: prefix without treating it as external MCP', () => {
    mockGetToolDisplayNameKey.mockReturnValue(undefined);

    const t = vi.fn((key: string) => key === 'tools.self_inspect' ? '环境自检' : '');
    (t as typeof t & { i18n?: { language: string } }).i18n = { language: 'zh-CN' };

    expect(getReadableToolName('builtin:self_inspect', t)).toBe('环境自检');
    expect(t).toHaveBeenCalledWith('tools.self_inspect', { ns: 'mcp', defaultValue: '' });
  });

  it('supports direct tools.* i18n keys without builtin prefix', () => {
    mockGetToolDisplayNameKey.mockReturnValue(undefined);

    const t = vi.fn((key: string) => {
      if (key === 'tools.template_fork') {
        return '复制模板';
      }
      return '';
    });
    (t as typeof t & { i18n?: { language: string } }).i18n = { language: 'zh-CN' };

    expect(getReadableToolName('tools.template_fork', t)).toBe('复制模板');
  });
});
