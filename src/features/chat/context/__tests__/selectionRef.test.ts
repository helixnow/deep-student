/**
 * selectionRef / selection 定义 单元测试 — P0 选区即上下文
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/features/chat/pages/ensureActiveChatSession', () => ({
  ensureActiveChatSession: vi.fn(),
}));

vi.mock('@/features/chat/core/session/sessionManager', () => ({
  sessionManager: {
    has: vi.fn(),
    get: vi.fn(),
  },
}));

vi.mock('@/features/chat/resources', () => ({
  resourceStoreApi: {
    createOrReuse: vi.fn(),
  },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/utils/i18n', () => ({
  t: vi.fn((_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key),
}));

import {
  selectionToChat,
  buildSelectionDisplayName,
  serializeSelectionRefData,
  MAX_SELECTION_TEXT_CHARS,
  type SelectionRefData,
} from '../selectionRef';
import { selectionDefinition, SELECTION_TYPE_ID } from '../definitions/selection';
import { ensureActiveChatSession } from '@/features/chat/pages/ensureActiveChatSession';
import { sessionManager } from '@/features/chat/core/session/sessionManager';
import { resourceStoreApi } from '@/features/chat/resources';

const mockEnsure = vi.mocked(ensureActiveChatSession);
const mockHas = vi.mocked(sessionManager.has);
const mockGet = vi.mocked(sessionManager.get);
const mockCreateOrReuse = vi.mocked(resourceStoreApi.createOrReuse);

describe('buildSelectionDisplayName', () => {
  it('拼接 title 与 locator', () => {
    expect(buildSelectionDisplayName({
      kind: 'pdf', sourceId: 'tb_1', locator: 'page:47', title: '机器学习系统',
    })).toBe('机器学习系统 page:47');
  });

  it('无 title/locator 时回退默认名', () => {
    expect(buildSelectionDisplayName({ kind: 'message', messageId: 'm1' })).toBe('选区引用');
  });
});

describe('serializeSelectionRefData', () => {
  it('序列化为 JSON 字符串', () => {
    const data: SelectionRefData = { text: 'hello', source: { kind: 'note', sourceId: 'note_1' } };
    expect(JSON.parse(serializeSelectionRefData(data))).toEqual(data);
  });

  it('超长文本截断到上限并附加标记', () => {
    const data: SelectionRefData = {
      text: 'x'.repeat(MAX_SELECTION_TEXT_CHARS + 100),
      source: { kind: 'pdf', sourceId: 'tb_1' },
    };
    const parsed = JSON.parse(serializeSelectionRefData(data)) as SelectionRefData;
    expect(parsed.text.length).toBe(MAX_SELECTION_TEXT_CHARS + 2); // 截断 + '\n…'
    expect(parsed.text.endsWith('…')).toBe(true);
  });
});

describe('selectionDefinition.formatToBlocks', () => {
  it('输出 <selection> 标签块（含 source / source-id / locator）', () => {
    const data: SelectionRefData = {
      text: '选中文本',
      source: { kind: 'pdf', sourceId: 'tb_1', locator: 'page:47', title: '教材' },
    };
    const blocks = selectionDefinition.formatToBlocks(
      { data: serializeSelectionRefData(data), sourceId: 'tb_1' } as never,
    );
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('<selection');
    expect(text).toContain('source="教材 page:47"');
    expect(text).toContain('source-id="tb_1"');
    expect(text).toContain('locator="page:47"');
    expect(text).toContain('选中文本');
    expect(text).toContain('</selection>');
  });

  it('data 非法时回退为空文本块而不抛错', () => {
    const blocks = selectionDefinition.formatToBlocks(
      { data: '{broken json' } as never,
    );
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { text: string }).text).toContain('</selection>');
  });
});

describe('selectionToChat', () => {
  const addContextRef = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsure.mockResolvedValue('sess_1');
    mockHas.mockReturnValue(true);
    mockGet.mockReturnValue({ getState: () => ({ addContextRef }) } as never);
    mockCreateOrReuse.mockResolvedValue({ resourceId: 'res_1', hash: 'h1', isNew: true } as never);
  });

  it('空文本直接失败', async () => {
    const result = await selectionToChat({ text: '  ', source: { kind: 'note' } });
    expect(result.success).toBe(false);
    expect(mockCreateOrReuse).not.toHaveBeenCalled();
  });

  it('无会话时失败且不创建资源', async () => {
    mockEnsure.mockResolvedValue(null);
    const result = await selectionToChat({ text: 'abc', source: { kind: 'note' } });
    expect(result.success).toBe(false);
    expect(mockCreateOrReuse).not.toHaveBeenCalled();
  });

  it('成功路径：retrieval 快照 + selection typeId 的 contextRef 入 pending', async () => {
    const result = await selectionToChat({
      text: '关键段落',
      source: { kind: 'pdf', sourceId: 'tb_1', locator: 'page:47', title: '教材' },
    });
    expect(result.success).toBe(true);

    expect(mockCreateOrReuse).toHaveBeenCalledWith(expect.objectContaining({
      type: 'retrieval',
      sourceId: 'tb_1',
    }));
    const storedData = JSON.parse(mockCreateOrReuse.mock.calls[0][0].data as string) as SelectionRefData;
    expect(storedData.source.locator).toBe('page:47');

    expect(addContextRef).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: 'res_1',
      hash: 'h1',
      typeId: SELECTION_TYPE_ID,
      displayName: '教材 page:47',
    }));
  });

  it('createOrReuse 失败时返回错误', async () => {
    mockCreateOrReuse.mockRejectedValue(new Error('db down'));
    const result = await selectionToChat({ text: 'abc', source: { kind: 'note', sourceId: 'note_1' } });
    expect(result.success).toBe(false);
    expect(result.error).toContain('db down');
    expect(addContextRef).not.toHaveBeenCalled();
  });
});
