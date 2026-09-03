/**
 * 共享制卡入口：太短直接拒（不发任务）、失败 toast 报错、成功 toast 带「查看任务」跳转 action。
 * 笔记 / 错题本 / 作文批改都挂在这条链路上，行为回归会同时影响三处表面。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockStartGeneration, mockShowGlobalNotification, mockDispatchAppEvent } =
  vi.hoisted(() => ({
    mockStartGeneration: vi.fn(),
    mockShowGlobalNotification: vi.fn(),
    mockDispatchAppEvent: vi.fn(),
  }));

vi.mock('@/components/anki/cardforge', () => ({
  cardAgent: { startGeneration: mockStartGeneration },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: mockShowGlobalNotification,
}));

vi.mock('@/events', () => ({
  APP_EVENTS: { MOBILE_APP_NAVIGATE: 'deepstudent:mobile-sidebar-navigate' },
  dispatchAppEvent: mockDispatchAppEvent,
}));

import {
  MIN_CONTENT_LENGTH_FOR_CARDS,
  generateCardsFromText,
  type GenerateCardsFromTextInput,
} from '../generateCardsFromText';

const messages: GenerateCardsFromTextInput['messages'] = {
  tooShort: '内容太短',
  started: '已开始生成卡片',
  failed: '生成卡片失败',
  openTaskDashboard: '查看任务',
};

function input(overrides: Partial<GenerateCardsFromTextInput> = {}): GenerateCardsFromTextInput {
  return {
    content: '这是一段足够长的学习材料内容，用来生成记忆卡片。',
    deckName: '生物 · 第三章',
    messages,
    ...overrides,
  };
}

describe('generateCardsFromText', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStartGeneration.mockResolvedValue({ ok: true, documentId: 'doc-1' });
  });

  it('内容短于阈值时只 toast 警告，不发制卡任务', async () => {
    const short = 'x'.repeat(MIN_CONTENT_LENGTH_FOR_CARDS - 1);

    const result = await generateCardsFromText(input({ content: short }));

    expect(result).toEqual({ ok: false, reason: 'too_short' });
    expect(mockStartGeneration).not.toHaveBeenCalled();
    expect(mockShowGlobalNotification).toHaveBeenCalledWith('warning', '内容太短');
  });

  it('长度按 trim 后计算，只有空白的内容同样拒绝', async () => {
    const result = await generateCardsFromText(input({ content: '   \n\t  ' }));

    expect(result).toEqual({ ok: false, reason: 'too_short' });
    expect(mockStartGeneration).not.toHaveBeenCalled();
  });

  it('成功时 toast 带「查看任务」action，点击跳转任务面板', async () => {
    const result = await generateCardsFromText(
      input({ requirements: '保留原文术语', maxCards: 8 }),
    );

    expect(mockStartGeneration).toHaveBeenCalledTimes(1);
    expect(mockStartGeneration.mock.calls[0][0]).toMatchObject({
      content: '这是一段足够长的学习材料内容，用来生成记忆卡片。',
      maxCards: 8,
      options: {
        deckName: '生物 · 第三章',
        customRequirements: '保留原文术语',
      },
    });
    expect(result).toEqual({ ok: true, documentId: 'doc-1' });

    expect(mockShowGlobalNotification).toHaveBeenCalledWith(
      'success',
      '已开始生成卡片',
      undefined,
      expect.objectContaining({
        action: expect.objectContaining({ label: '查看任务' }),
      }),
    );

    const options4 = mockShowGlobalNotification.mock.calls[0][3] as {
      action: { onClick: () => void };
    };
    options4.action.onClick();
    expect(mockDispatchAppEvent).toHaveBeenCalledWith('deepstudent:mobile-sidebar-navigate', {
      view: 'task-dashboard',
    });
  });

  it('后端启动返回 ok:false 时回报 generate_failed 并 toast 原始错误', async () => {
    mockStartGeneration.mockResolvedValue({ ok: false, error: 'boom' });

    const result = await generateCardsFromText(input());

    expect(result).toEqual({ ok: false, reason: 'generate_failed', error: 'boom' });
    expect(mockShowGlobalNotification).toHaveBeenCalledWith('error', 'boom');
  });

  it('后端启动失败但没带错误文案时回退到调用方的 failed 文案', async () => {
    mockStartGeneration.mockResolvedValue({ ok: false });

    const result = await generateCardsFromText(input());

    expect(result).toEqual({ ok: false, reason: 'generate_failed', error: '生成卡片失败' });
    expect(mockShowGlobalNotification).toHaveBeenCalledWith('error', '生成卡片失败');
  });

  it('链路抛错时不外泄异常，转成 generate_failed 结果', async () => {
    mockStartGeneration.mockRejectedValue(new Error('network down'));

    const result = await generateCardsFromText(input());

    expect(result).toEqual({ ok: false, reason: 'generate_failed', error: 'network down' });
    expect(mockShowGlobalNotification).toHaveBeenCalledWith('error', 'network down');
  });
});
