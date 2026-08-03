/**
 * sessionExport —— 会话导出落盘流程单元测试
 *
 * 覆盖：
 * - 默认 markdown 导出：文件名 = 清洗后的标题 + .md，Markdown 过滤器
 * - json 导出：扩展名/过滤器切到 JSON
 * - 标题缺省 / 清洗后为空时回退到 sessionId
 * - 文件名清洗：路径分隔符等非法字符替换为下划线
 * - 用户取消保存对话框时静默返回（无通知）
 * - 导出成功 → success 通知；后端失败 → error 通知且不弹保存框
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('i18next', () => {
  const t = (_key: string, arg?: unknown) => {
    if (typeof arg === 'string') return arg;
    if (arg && typeof arg === 'object') {
      const opts = arg as Record<string, unknown>;
      let text = String(opts.defaultValue ?? _key);
      for (const [k, v] of Object.entries(opts)) {
        if (k === 'defaultValue') continue;
        text = text.replace(`{{${k}}}`, String(v));
      }
      return text;
    }
    return _key;
  };
  // src/i18n.ts 会对 i18next 实例做 use().use().init() 链式初始化，
  // mock 需保持链式接口可用（errorUtils → src/i18n.ts 传递依赖）
  const instance = {
    t,
    isInitialized: true,
    use: () => instance,
    init: async () => t,
    on: () => instance,
    language: 'zh',
  };
  return { default: instance };
});

vi.mock('@/utils/fileManager', () => ({
  fileManager: { saveTextFile: vi.fn() },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/features/chat/api/sessionBrowserApi', () => ({
  exportChatSession: vi.fn(),
}));

import { fileManager } from '@/utils/fileManager';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { exportChatSession } from '@/features/chat/api/sessionBrowserApi';
import { exportSessionToFile } from '@/features/chat/components/session-browser/sessionExport';

const mockedExport = vi.mocked(exportChatSession);
const mockedSave = vi.mocked(fileManager.saveTextFile);
const mockedNotify = vi.mocked(showGlobalNotification);

const exportResponse = (overrides: Partial<Awaited<ReturnType<typeof exportChatSession>>> = {}) => ({
  sessionId: 'sess-1',
  format: 'markdown' as const,
  content: '# Hello',
  messageCount: 4,
  ...overrides,
});

describe('exportSessionToFile', () => {
  beforeEach(() => {
    mockedExport.mockReset();
    mockedSave.mockReset();
    mockedNotify.mockReset();
  });

  it('exports markdown by default with sanitized title as file name', async () => {
    mockedExport.mockResolvedValue(exportResponse());
    mockedSave.mockResolvedValue({ canceled: false, path: '/tmp/out.md' });

    await exportSessionToFile({ sessionId: 'sess-1', title: 'My Session' });

    expect(mockedExport).toHaveBeenCalledWith({ sessionId: 'sess-1', format: 'markdown' });
    expect(mockedSave).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultFileName: 'My Session.md',
        filters: [{ name: 'Markdown', extensions: ['md'] }],
        content: '# Hello',
      })
    );
    expect(mockedNotify).toHaveBeenCalledWith('success', expect.stringContaining('/tmp/out.md'));
  });

  it('exports json with .json extension and JSON filter', async () => {
    mockedExport.mockResolvedValue(exportResponse({ format: 'json', content: '{"messages":[]}' }));
    mockedSave.mockResolvedValue({ canceled: false, path: '/tmp/out.json' });

    await exportSessionToFile({ sessionId: 'sess-1', title: 'Data', format: 'json' });

    expect(mockedExport).toHaveBeenCalledWith({ sessionId: 'sess-1', format: 'json' });
    expect(mockedSave).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultFileName: 'Data.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        content: '{"messages":[]}',
      })
    );
  });

  it('sanitizes illegal filename characters into underscores', async () => {
    mockedExport.mockResolvedValue(exportResponse());
    mockedSave.mockResolvedValue({ canceled: false, path: '/tmp/x.md' });

    await exportSessionToFile({ sessionId: 'sess-1', title: 'a/b\\c:d*e?f"g<h>i|j' });

    expect(mockedSave).toHaveBeenCalledWith(
      expect.objectContaining({ defaultFileName: 'a_b_c_d_e_f_g_h_i_j.md' })
    );
  });

  it('falls back to sessionId when title is missing or sanitizes to empty', async () => {
    mockedExport.mockResolvedValue(exportResponse());
    mockedSave.mockResolvedValue({ canceled: false, path: '/tmp/x.md' });

    await exportSessionToFile({ sessionId: 'sess-1' });
    expect(mockedSave).toHaveBeenLastCalledWith(
      expect.objectContaining({ defaultFileName: 'sess-1.md' })
    );

    // 纯空白标题 trim 后为空 → 回退 sessionId
    await exportSessionToFile({ sessionId: 'sess-3', title: '   ' });
    expect(mockedSave).toHaveBeenLastCalledWith(
      expect.objectContaining({ defaultFileName: 'sess-3.md' })
    );
  });

  it('silently returns when the user cancels the save dialog', async () => {
    mockedExport.mockResolvedValue(exportResponse());
    mockedSave.mockResolvedValue({ canceled: true });

    await exportSessionToFile({ sessionId: 'sess-1', title: 'T' });

    expect(mockedNotify).not.toHaveBeenCalled();
  });

  it('shows error notification and skips save dialog when export fails', async () => {
    mockedExport.mockRejectedValue(new Error('db locked'));

    await exportSessionToFile({ sessionId: 'sess-1', title: 'T' });

    expect(mockedSave).not.toHaveBeenCalled();
    expect(mockedNotify).toHaveBeenCalledWith('error', expect.stringContaining('db locked'));
  });

  it('shows error notification when writing the file fails after dialog', async () => {
    mockedExport.mockResolvedValue(exportResponse());
    mockedSave.mockRejectedValue(new Error('disk full'));

    await exportSessionToFile({ sessionId: 'sess-1', title: 'T' });

    expect(mockedNotify).toHaveBeenCalledWith('error', expect.stringContaining('disk full'));
  });
});
