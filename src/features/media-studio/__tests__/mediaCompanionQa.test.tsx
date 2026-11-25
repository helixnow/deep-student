import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MediaStudyCompanionRenderContext } from '@/features/learning-hub/apps/views/media/mediaStudyCompanion';
import type { TranscriptSegment } from '@/features/learning-hub/apps/views/media/mediaTranscriptApi';
import { addAppEventListener, APP_EVENTS } from '@/events';
import { useSettingsShellStore } from '@/stores/settingsShellStore';

const {
  invokeMock,
  useGenerateHandoutMock,
  openHandoutNoteMock,
  useReferenceToChatMock,
  startMediaChatMock,
  showGlobalNotificationMock,
} = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  useGenerateHandoutMock: vi.fn(),
  openHandoutNoteMock: vi.fn(),
  useReferenceToChatMock: vi.fn(),
  startMediaChatMock: vi.fn(),
  showGlobalNotificationMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) => {
        if (options && typeof options.defaultValue === 'string') {
          return options.defaultValue.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) =>
            options[name] !== undefined && options[name] !== null ? String(options[name]) : '',
          );
        }
        return options ? `${key} ${JSON.stringify(options)}` : key;
      },
      i18n: { resolvedLanguage: 'zh-CN', language: 'zh-CN' },
    }),
  };
});

vi.mock('@/features/media-handout', () => ({
  useGenerateHandout: useGenerateHandoutMock,
  openHandoutNote: openHandoutNoteMock,
}));

vi.mock('@/features/learning-hub/useReferenceToChat', () => ({
  useReferenceToChat: useReferenceToChatMock,
}));

vi.mock('../mediaChat', () => ({
  startMediaChat: startMediaChatMock,
}));

vi.mock('@/components/UnifiedNotification', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/UnifiedNotification')>();
  return {
    ...actual,
    showGlobalNotification: showGlobalNotificationMock,
  };
});

import {
  askMediaCompanionQa,
  buildCompanionQaPrompt,
  extractCitationsFromText,
  isLlmAuthError,
  isLlmUnconfiguredError,
  selectRelevantTranscriptContext,
  tokenizeTimestampText,
  type CompanionQaContextInput,
} from '../mediaCompanionQa';
import { MediaAskTab } from '../components/MediaStudyTabs';

const LECTURE_SEGMENTS: TranscriptSegment[] = [
  {
    idx: 0,
    startMs: 1_000,
    endMs: 10_000,
    text: '大家好，今天我们学习拉格朗日中值定理的几何意义与严格证明。',
    status: 'done',
  },
  {
    idx: 1,
    startMs: 10_000,
    endMs: 19_000,
    text: '如果函数在闭区间连续且在开区间可导，那么至少存在一点导数等于弦斜率。',
    status: 'done',
  },
  {
    idx: 2,
    startMs: 185_000,
    endMs: 205_000,
    text: '证明的关键是构造辅助函数 φ(x) = f(x) - f(a) - [(f(b)-f(a))/(b-a)](x-a)，将其化归为罗尔定理。',
    status: 'done',
  },
  {
    idx: 3,
    startMs: 206_000,
    endMs: 225_000,
    text: '容易忽略的前提条件是端点连续性：若闭区间端点跳跃间断，结论将不再成立。',
    status: 'done',
  },
];

function createCompanionCtx(
  overrides: Partial<MediaStudyCompanionRenderContext> = {},
): MediaStudyCompanionRenderContext {
  return {
    resourceId: 'file_calc_05',
    kind: 'video',
    src: 'blob:calc-05',
    fileName: '高等数学第5讲-中值定理.mp4',
    transcriptStatus: 'done',
    hasTranscript: true,
    doneSegments: LECTURE_SEGMENTS.length,
    totalSegments: LECTURE_SEGMENTS.length,
    segments: LECTURE_SEGMENTS,
    chapters: [
      { seconds: 0, title: '中值定理几何直观' },
      { seconds: 180, title: '构造辅助函数与罗尔定理化归' },
    ],
    currentChapterIndex: 0,
    seekTo: vi.fn(),
    getCurrentTime: () => 12,
    ...overrides,
  };
}

describe('mediaCompanionQa core logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeMock.mockResolvedValue(null);
  });

  it('selects full grounded transcript for concise lectures and ranks keyword-matched fallback segments across timestamps', () => {
    const qaCtx: CompanionQaContextInput = {
      resourceId: 'file_calc_05',
      courseName: '高等数学第5讲-中值定理',
      hasTranscript: true,
      segments: LECTURE_SEGMENTS,
      chapters: [
        { seconds: 0, title: '中值定理几何直观' },
        { seconds: 180, title: '构造辅助函数与罗尔定理化归' },
      ],
      currentTimeSeconds: 12,
    };

    // Playhead is at 00:12, user asks about auxiliary function from 03:05
    const selection = selectRelevantTranscriptContext(qaCtx, '怎么构造辅助函数用到罗尔定理？');
    expect(selection.isFullTranscript).toBe(true);
    expect(selection.groundedSegments).toHaveLength(4);
    expect(selection.fallbackCitations.some((c) => c.label === '03:05')).toBe(true);
  });

  it('selects playhead window plus lexical matches within char budget for very long lectures', () => {
    const longSegments: TranscriptSegment[] = Array.from({ length: 180 }, (_, idx) => ({
      idx,
      startMs: idx * 20_000,
      endMs: (idx + 1) * 20_000,
      text:
        idx === 120
          ? '这里重点解释海森矩阵正定性与多元函数严格极小值的充分条件。'
          : `第 ${idx} 段常规推导过程与例题展开说明，补充背景步骤与计算细节演示内容文本。`,
      status: 'done',
    }));

    const selection = selectRelevantTranscriptContext(
      {
        resourceId: 'file_long',
        courseName: '多元微积分',
        hasTranscript: true,
        segments: longSegments,
        chapters: [],
        currentTimeSeconds: 40,
      },
      '海森矩阵正定性有什么作用？',
    );

    expect(selection.isFullTranscript).toBe(false);
    // Contains both near-playhead context and the matched distant segment at idx 120 (40:00)
    expect(selection.groundedSegments.some((s) => s.idx === 2)).toBe(true);
    expect(selection.groundedSegments.some((s) => s.idx === 120)).toBe(true);
    expect(selection.fallbackCitations.some((c) => c.label === '40:00')).toBe(true);
  });

  it('builds a grounded prompt containing user question, [mm:ss] transcript lines, history, and anti-echo rules', () => {
    const qaCtx: CompanionQaContextInput = {
      resourceId: 'file_calc_05',
      courseName: '高等数学第5讲-中值定理',
      hasTranscript: true,
      segments: LECTURE_SEGMENTS,
      chapters: [{ seconds: 0, title: '中值定理几何直观' }],
      currentTimeSeconds: 12,
    };
    const selection = selectRelevantTranscriptContext(qaCtx, '为什么需要闭区间连续？');
    const prompt = buildCompanionQaPrompt({
      ctx: qaCtx,
      question: '为什么需要闭区间连续？',
      selection,
      history: [
        { role: 'user', content: '拉格朗日中值定理的几何意义是什么？' },
        { role: 'assistant', content: '曲线上至少存在一点切线与割线平行 [00:10]。' },
      ],
    });

    expect(prompt).toContain('为什么需要闭区间连续？');
    expect(prompt).toContain('[00:01]');
    expect(prompt).toContain('[03:26]');
    expect(prompt).toContain('不要只是简单复读或照抄字幕原文');
    expect(prompt).toContain('不要催促用户切换或迁入主会话');
    expect(prompt).toContain('最近伴读对话记录');
    expect(prompt).toContain('拉格朗日中值定理的几何意义是什么？');
  });

  it('tokenizes [mm:ss], [h:mm:ss], [媒体@id:mm:ss], ▶ mm:ss, (mm:ss), and range citations accurately', () => {
    const text =
      '老师在 [00:10] 引入几何直观，于 [03:05–03:26] 构造辅助函数，也可回看 [媒体@file_calc_05:1:02:05] 与 ▶ 00:01（忽略 [99:99]）。';
    const tokens = tokenizeTimestampText(text);
    const citations = tokens.filter((t) => t.kind === 'citation');

    expect(citations.map((c) => [c.label, c.seconds])).toEqual([
      ['00:10', 10],
      ['03:05', 185],
      ['03:26', 206],
      ['1:02:05', 3725],
      ['00:01', 1],
    ]);
    expect(extractCitationsFromText(text).map((c) => c.seconds)).toEqual([10, 185, 206, 3725, 1]);
  });

  it('distinguishes unconfigured-model errors from HTTP 500/network and 401 auth errors', () => {
    expect(isLlmUnconfiguredError({ error_type: 'Configuration', message: '对话模型未配置' })).toBe(true);
    expect(isLlmUnconfiguredError(new Error('没有可用的模型候选（Failover 计划为空）'))).toBe(true);
    expect(isLlmUnconfiguredError(new Error('API 密钥未配置，请先配置 API 密钥'))).toBe(true);
    expect(isLlmUnconfiguredError(new Error('No API key configured'))).toBe(true);

    expect(isLlmUnconfiguredError({ error_type: 'Network', message: 'connection timed out' })).toBe(false);
    expect(isLlmUnconfiguredError({ error_type: 'LLM', message: 'RAW_PROMPT API请求失败: 500 Internal Server Error' })).toBe(false);

    const authErr = { error_type: 'Configuration', message: '模型二API认证失败: API Key 无效或已过期 (HTTP 401)' };
    expect(isLlmAuthError(authErr)).toBe(true);
    expect(isLlmUnconfiguredError(authErr)).toBe(false);
  });

  it('askMediaCompanionQa calls handout_llm_complete and never falls back to raw echo on transient 500 error', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'handout_llm_complete') {
        throw { error_type: 'LLM', message: 'HTTP 500 upstream unavailable' };
      }
      return null;
    });

    const result = await askMediaCompanionQa({
      ctx: {
        resourceId: 'file_calc_05',
        courseName: '高等数学第5讲',
        hasTranscript: true,
        segments: LECTURE_SEGMENTS,
        chapters: [],
        currentTimeSeconds: 12,
      },
      question: '为什么端点要连续？',
      requestId: 'req-500',
    });

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.retryable).toBe(true);
      expect(result.message).toContain('500');
      expect(result.message).not.toContain('迁入主会话');
    }
    expect(invokeMock).toHaveBeenCalledWith('handout_release', { requestId: 'req-500' });
  });
});

describe('MediaAskTab Companion QA UI integration', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    useSettingsShellStore.setState({ activeTab: 'general', dataGovernanceTabTarget: null });
    useGenerateHandoutMock.mockReturnValue({
      running: false,
      progress: null,
      result: null,
      start: vi.fn(),
      cancel: vi.fn(),
    });
    useReferenceToChatMock.mockReturnValue({
      referenceToChat: vi.fn().mockResolvedValue({ success: true }),
    });
    startMediaChatMock.mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
  });

  it('invokes real LLM completion with grounded transcript context, renders direct answer with clickable ▶ mm:ss jump citations, and supports multi-turn follow-ups', async () => {
    const prompts: string[] = [];
    invokeMock.mockImplementation(async (cmd: string, args?: { prompt?: string }) => {
      if (cmd === 'handout_llm_complete') {
        prompts.push(args?.prompt ?? '');
        if (prompts.length === 1) {
          return '因为辅助函数 φ(x) 把原曲线与割线做差，使两端点值相等从而套用罗尔定理 [03:05]；若端点不连续则割线斜率与局部极限脱节 [03:26]。';
        }
        return '例如取 f(x)=x (x∈[0,1)) 且 f(1)=5，在端点 x=1 跳跃间断，割线斜率为 5 但内部导数恒为 1 [03:26]。';
      }
      return null;
    });

    const seekTo = vi.fn();
    const ctx = createCompanionCtx({ seekTo, getCurrentTime: () => 12 });
    render(<MediaAskTab ctx={ctx} meta={{ name: '高等数学第5讲-中值定理.mp4', mimeType: 'video/mp4' }} />);

    // Turn 1: Ask a specific conceptual question while playhead is still at 00:12
    const input = screen.getByRole('textbox', { name: '伴读提问输入框' });
    fireEvent.change(input, { target: { value: '为什么要构造辅助函数 φ(x)？' } });
    fireEvent.click(screen.getByRole('button', { name: '发送伴读提问' }));

    await waitFor(() => {
      expect(prompts).toHaveLength(1);
    });
    expect(prompts[0]).toContain('为什么要构造辅助函数 φ(x)？');
    expect(prompts[0]).toContain('[03:05]');
    expect(prompts[0]).toContain('构造辅助函数 φ(x)');

    const msgList = screen.getByTestId('mini-chat-message-list');
    await waitFor(() => {
      expect(msgList.textContent).toContain('套用罗尔定理');
    });
    // Must NEVER parrot the old fallback copy telling configured users to migrate to main chat
    expect(msgList.textContent).not.toContain('迁入主会话');
    expect(screen.queryByTestId('media-qa-unconfigured-notice')).toBeNull();

    // Clicking clickable ▶ 03:05 and ▶ 03:26 pills jumps the player to exact seconds
    const cite1 = screen.getByRole('button', { name: '跳转到 03:05' });
    const cite2 = screen.getByRole('button', { name: '跳转到 03:26' });
    expect(cite1.textContent).toContain('▶');
    expect(cite2.textContent).toContain('▶');
    fireEvent.click(cite1);
    expect(seekTo).toHaveBeenCalledWith(185);
    fireEvent.click(cite2);
    expect(seekTo).toHaveBeenCalledWith(206);

    // Turn 2: Follow-up question includes previous turn history in prompt
    fireEvent.change(input, { target: { value: '能举一个端点不连续的反例吗？' } });
    fireEvent.click(screen.getByRole('button', { name: '发送伴读提问' }));

    await waitFor(() => {
      expect(prompts).toHaveLength(2);
    });
    expect(prompts[1]).toContain('为什么要构造辅助函数 φ(x)？');
    expect(prompts[1]).toContain('能举一个端点不连续的反例吗？');
    await waitFor(() => {
      expect(msgList.textContent).toContain('割线斜率为 5');
    });
  });

  it('appends clickable reference timestamp pills when LLM answer omits inline [mm:ss] markers', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'handout_llm_complete') {
        return '核心思想是用辅助函数把一般曲线切线问题化归为水平切线问题。';
      }
      return null;
    });

    const seekTo = vi.fn();
    const ctx = createCompanionCtx({ seekTo, getCurrentTime: () => 190 });
    render(<MediaAskTab ctx={ctx} meta={{ name: '高等数学第5讲-中值定理.mp4', mimeType: 'video/mp4' }} />);

    fireEvent.change(screen.getByRole('textbox', { name: '伴读提问输入框' }), {
      target: { value: '罗尔定理在这里起了什么作用？' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送伴读提问' }));

    const refBar = await screen.findByTestId('media-qa-reference-citations');
    expect(refBar.textContent).toContain('相关片段');
    const jumpBtn = refBar.querySelector('[data-media-qa-citation]') as HTMLElement;
    expect(jumpBtn).toBeTruthy();
    fireEvent.click(jumpBtn);
    expect(seekTo).toHaveBeenCalled();
  });

  it('handles missing API key / unconfigured LLM gracefully with explicit notice, clickable subtitle segments, and working Settings link', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'handout_llm_complete') {
        throw { error_type: 'Configuration', message: '对话模型未配置', details: null };
      }
      return null;
    });

    const navEvents: Array<{ type: string; detail: unknown }> = [];
    const unsubNavTab = addAppEventListener(APP_EVENTS.NAVIGATE_TO_TAB, (detail) => {
      navEvents.push({ type: APP_EVENTS.NAVIGATE_TO_TAB, detail });
    });
    const unsubSettingsTab = addAppEventListener(APP_EVENTS.SETTINGS_NAVIGATE_TAB, (detail) => {
      navEvents.push({ type: APP_EVENTS.SETTINGS_NAVIGATE_TAB, detail });
    });

    try {
      const seekTo = vi.fn();
      const ctx = createCompanionCtx({ seekTo, getCurrentTime: () => 12 });
      render(<MediaAskTab ctx={ctx} meta={{ name: '高等数学第5讲-中值定理.mp4', mimeType: 'video/mp4' }} />);

      fireEvent.change(screen.getByRole('textbox', { name: '伴读提问输入框' }), {
        target: { value: '怎么构造辅助函数？' },
      });
      fireEvent.click(screen.getByRole('button', { name: '发送伴读提问' }));

      const notice = await screen.findByTestId('media-qa-unconfigured-notice');
      expect(notice.textContent).toContain('未配置 AI 模型，已为您定位相关字幕片段');
      expect(notice.textContent).not.toContain('迁入主会话');

      // Clicking a located subtitle timestamp seeks directly
      const locatedCitation = screen.getByRole('button', { name: '跳转到 03:05' });
      fireEvent.click(locatedCitation);
      expect(seekTo).toHaveBeenCalledWith(185);

      // Clicking direct settings button opens Settings → APIs tab
      const settingsBtn = screen.getByTestId('media-qa-open-settings-btn');
      fireEvent.click(settingsBtn);

      expect(useSettingsShellStore.getState().activeTab).toBe('apis');
      expect(navEvents).toEqual(
        expect.arrayContaining([
          { type: APP_EVENTS.NAVIGATE_TO_TAB, detail: { tabName: 'settings' } },
          { type: APP_EVENTS.SETTINGS_NAVIGATE_TAB, detail: { tab: 'apis' } },
        ]),
      );
    } finally {
      unsubNavTab();
      unsubSettingsTab();
    }
  });

  it('shows honest retryable error (never fake transcript echo) on transient LLM failure and retries cleanly', async () => {
    let attempt = 0;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'handout_llm_complete') {
        attempt += 1;
        if (attempt === 1) {
          throw new Error('网络超时，请稍后重试');
        }
        return '重试成功：端点连续保证函数在闭区间两端无跳跃 [03:26]。';
      }
      return null;
    });

    const ctx = createCompanionCtx();
    render(<MediaAskTab ctx={ctx} meta={{ name: '高等数学第5讲-中值定理.mp4', mimeType: 'video/mp4' }} />);

    fireEvent.change(screen.getByRole('textbox', { name: '伴读提问输入框' }), {
      target: { value: '端点连续为什么重要？' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送伴读提问' }));

    const errCard = await screen.findByTestId('media-qa-error');
    expect(errCard.textContent).toContain('网络超时');
    expect(screen.queryByTestId('media-qa-unconfigured-notice')).toBeNull();
    // Never masquerades raw transcript echo as an AI answer
    expect(screen.getByTestId('mini-chat-message-list').textContent).not.toContain('大家好，今天我们学习');

    fireEvent.click(screen.getByTestId('media-qa-retry-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('mini-chat-message-list').textContent).toContain('重试成功');
    });
    expect(attempt).toBe(2);
  });

  it('shows thinking state and allows cancelling an in-flight LLM request via handout_cancel', async () => {
    let resolveLlm!: (value: string) => void;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'handout_llm_complete') {
        return new Promise<string>((resolve) => {
          resolveLlm = resolve;
        });
      }
      return null;
    });

    const ctx = createCompanionCtx();
    render(<MediaAskTab ctx={ctx} meta={{ name: '高等数学第5讲-中值定理.mp4', mimeType: 'video/mp4' }} />);

    fireEvent.change(screen.getByRole('textbox', { name: '伴读提问输入框' }), {
      target: { value: '请推导一遍' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送伴读提问' }));

    expect(await screen.findByTestId('media-qa-thinking')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('media-qa-cancel-btn'));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'handout_cancel',
        expect.objectContaining({ requestId: expect.stringMatching(/^media-qa-/) }),
      );
    });
    expect(screen.queryByTestId('media-qa-thinking')).toBeNull();

    // Late resolution after cancel must not inject stale reply
    resolveLlm('过期回答');
    await Promise.resolve();
    expect(screen.getByTestId('mini-chat-message-list').textContent).not.toContain('过期回答');
  });

  it('includes narrow ~460px split-window container query rules for MediaStudyPage and MediaLibraryPage', () => {
    const studyCss = fs.readFileSync(
      path.resolve(__dirname, '../components/MediaStudyPage.css'),
      'utf-8',
    );
    const libraryCss = fs.readFileSync(
      path.resolve(__dirname, '../components/MediaLibraryPage.css'),
      'utf-8',
    );

    expect(studyCss).toContain('container-type: inline-size;');
    expect(studyCss).toContain('@container media-study (width <= 540px)');
    expect(studyCss).toContain('[data-media-study-companion] [role="radiogroup"]');

    expect(libraryCss).toContain('container-type: inline-size;');
    expect(libraryCss).toContain('@container media-library (width <= 540px)');
    expect(libraryCss).toContain('[data-media-library-controls]');
  });
});
