import { describe, expect, it, vi } from 'vitest';

const { mockGetToolDisplayNameKey } = vi.hoisted(() => ({
  mockGetToolDisplayNameKey: vi.fn(),
}));

vi.mock('@/mcp/builtinMcpServer', () => ({
  getToolDisplayNameKey: mockGetToolDisplayNameKey,
}));

import { getReadableToolName, humanizeToolName } from '../toolDisplayName';

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

    expect(getReadableToolName('tools.template_fork', t)).toBe('Tools / Template Fork');
  });

  it('falls back to chinese readable name in zh locale', () => {
    mockGetToolDisplayNameKey.mockReturnValue(undefined);

    const t = vi.fn(() => '');
    (t as typeof t & { i18n?: { language: string } }).i18n = { language: 'zh-CN' };

    expect(getReadableToolName('tools.template_fork', t)).toBe('模板复制');
    expect(getReadableToolName('qbank_get_question', t)).toBe('题库获取题目');
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
