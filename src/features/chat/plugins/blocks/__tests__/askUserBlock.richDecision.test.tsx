import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { AskUserBlockComponent, isValidPresentationHtml } from '../askUserBlock';
import type { Block } from '../../../core/types/block';

describe('AskUserBlockComponent rich decision surfaces (html & openui-lang)', () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue(null);
  });

  it('renders InteractiveHtmlCanvas when askInput.html is provided and submits via chat_v2_ask_user_respond', async () => {
    const block: Block = {
      id: 'blk-html-1',
      messageId: 'msg-1',
      type: 'ask_user',
      status: 'running',
      content: '',
      toolName: 'builtin-ask_user',
      toolCallId: 'call-html-1',
      toolInput: {
        question: 'Choose architecture layout',
        title: 'Architecture Canvas',
        html: '<div class="oc-box"><button class="oc-button">Select Layout A</button></div>',
      },
    };

    const { container } = render(<AskUserBlockComponent block={block} />);
    expect(screen.getByText('Architecture Canvas')).toBeInTheDocument();

    const canvasStage = container.querySelector('[data-interactive-html-canvas]') as HTMLElement;
    expect(canvasStage).not.toBeNull();
    const canvasId = canvasStage.getAttribute('data-canvas-id')!;

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'ds-canvas-submit',
            canvasId,
            data: { layout: 'hexagonal' },
            summary: 'Hexagonal Architecture',
          },
        }),
      );
    });

    expect(invokeMock).toHaveBeenCalledWith('chat_v2_ask_user_respond', {
      toolCallId: 'call-html-1',
      selectedTexts: ['Hexagonal Architecture'],
      selectedIndices: [],
      customText: JSON.stringify({ layout: 'hexagonal' }),
      source: 'mixed',
    });

    expect(screen.getByTestId('ask-user-rich-summary')).toHaveTextContent('Hexagonal Architecture');
  });

  it('renders OpenUILangRenderer when askInput.ui is provided and submits form values + note', async () => {
    const block: Block = {
      id: 'blk-ui-1',
      messageId: 'msg-1',
      type: 'ask_user',
      status: 'running',
      content: '',
      toolName: 'builtin-ask_user',
      toolCallId: 'call-ui-1',
      toolInput: {
        question: 'Configure study plan parameters',
        ui: `
          root = Stack([choiceDepth, btnGo])
          choiceDepth = Choice("depth", ["Concise", "Deep Dive"], "Study Depth", false)
          btnGo = Button("Start Plan", "primary", "start")
        `,
      },
    };

    render(<AskUserBlockComponent block={block} />);

    fireEvent.click(screen.getByRole('button', { name: 'Deep Dive' }));
    fireEvent.change(screen.getByTestId('openui-note-input'), {
      target: { value: 'Focus on proofs' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start Plan' }));
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const callArgs = invokeMock.mock.calls[0];
    expect(callArgs[0]).toBe('chat_v2_ask_user_respond');
    expect(callArgs[1].toolCallId).toBe('call-ui-1');
    expect(callArgs[1].source).toBe('mixed');
    expect(JSON.parse(callArgs[1].customText)).toEqual({
      button: 'Start Plan',
      value: 'start',
      values: { depth: 'Deep Dive' },
      note: 'Focus on proofs',
    });
    expect(screen.getByTestId('ask-user-rich-summary')).toHaveTextContent('Start Plan');
  });

  it('restores resolved custom_text back into answer prop and displays summary footer', () => {
    const savedAnswer = {
      button: 'Confirm',
      value: 'confirm',
      values: { format: 'PDF' },
      note: 'A4 size',
    };
    const block: Block = {
      id: 'blk-ui-restored',
      messageId: 'msg-2',
      type: 'ask_user',
      status: 'success',
      content: '',
      toolName: 'builtin-ask_user',
      toolCallId: 'call-ui-restored',
      toolInput: {
        question: 'Select export format',
        ui: `
          root = Stack([fmt, btn])
          fmt = Choice("format", ["PDF", "HTML"], "Format", false)
          btn = Button("Confirm", "primary", "confirm")
        `,
      },
      toolOutput: {
        result: {
          question: 'Select export format',
          selected: ['Confirm · format: PDF · A4 size'],
          selected_indices: [],
          custom_text: JSON.stringify(savedAnswer),
          source: 'mixed',
          options: [],
          multiple: false,
        },
        durationMs: 1200,
      },
    };

    render(<AskUserBlockComponent block={block} />);
    expect(screen.getByRole('button', { name: 'PDF' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('ask-user-rich-summary')).toHaveTextContent(
      'Confirm · format: PDF · A4 size',
    );
  });

  it('mounts isolated sandbox for valid presentation.html while keeping host options interactive, syncs draft, and requires host confirmation before submitting', async () => {
    const block: Block = {
      id: 'blk-pres-1',
      messageId: 'msg-pres-1',
      type: 'ask_user',
      status: 'running',
      content: '',
      toolName: 'builtin-ask_user',
      toolCallId: 'call-pres-1',
      toolInput: {
        question: '请选择复习侧重点',
        options: ['概念梳理', '推导证明', '真题演练'],
        presentation: {
          title: '复习权重画板',
          html: '<div class="ds-box"><button type="button" id="pick-proof">侧重推导证明</button></div>',
        },
      },
    };

    render(<AskUserBlockComponent block={block} />);

    // 1. 合法的 presentation.html 已挂载，同时原生选项依然存在且可用
    expect(screen.getByTestId('ask-user-presentation-sandbox')).toBeInTheDocument();
    expect(screen.getByText('复习权重画板')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '概念梳理' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '推导证明' })).toBeInTheDocument();

    // 2. 沙箱发送 wbw:set-answer-draft 仅同步宿主草稿，不弹确认栏、不直接提交
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'wbw:set-answer-draft',
            answer: {
              selected: ['推导证明'],
              customText: '重点关注拉格朗日中值定理',
            },
          },
        }),
      );
    });

    expect(invokeMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('ask-user-sandbox-confirm-bar')).toBeNull();
    expect(screen.getByRole('button', { name: '推导证明' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByDisplayValue('重点关注拉格朗日中值定理')).toBeInTheDocument();

    // 3. 沙箱请求提交（wbw:submit-answer 或 openchamber:submit）时，显示宿主可信确认栏，仍不直接调用后端
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'wbw:submit-answer',
            answer: {
              selected: ['推导证明'],
              customText: '重点关注拉格朗日中值定理',
            },
          },
        }),
      );
    });

    expect(invokeMock).not.toHaveBeenCalled();
    const confirmBar = screen.getByTestId('ask-user-sandbox-confirm-bar');
    expect(confirmBar).toHaveTextContent('画板已填入候选回答，请核对后确认提交');
    expect(screen.getByTestId('ask-user-sandbox-candidate-summary')).toHaveTextContent(
      '推导证明 · 重点关注拉格朗日中值定理',
    );

    // 4. 点击宿主「确认回答」后才真正提交
    await act(async () => {
      fireEvent.click(screen.getByTestId('ask-user-sandbox-confirm-btn'));
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('chat_v2_ask_user_respond', {
      toolCallId: 'call-pres-1',
      selectedTexts: ['推导证明'],
      selectedIndices: [1],
      customText: '重点关注拉格朗日中值定理',
      source: 'mixed',
    });
  });

  it('discards invalid presentation.html containing dangerous nested tags and falls back to native options without blocking user response', async () => {
    expect(isValidPresentationHtml('')).toBe(false);
    expect(isValidPresentationHtml('   ')).toBe(false);
    expect(isValidPresentationHtml('<div><iframe src="https://evil.test"></iframe></div>')).toBe(
      false,
    );
    expect(isValidPresentationHtml('<object data="movie.swf"></object>')).toBe(false);
    expect(isValidPresentationHtml('<embed src="plugin.swf" />')).toBe(false);
    expect(isValidPresentationHtml('<meta http-equiv="refresh" content="0;url=https://x" />')).toBe(
      false,
    );
    expect(isValidPresentationHtml('<base href="https://evil.test/" />')).toBe(false);
    expect(isValidPresentationHtml('<div class="ds-box"><p>合法内容</p></div>')).toBe(true);

    const block: Block = {
      id: 'blk-pres-invalid',
      messageId: 'msg-pres-2',
      type: 'ask_user',
      status: 'running',
      content: '',
      toolName: 'builtin-ask_user',
      toolCallId: 'call-pres-invalid',
      toolInput: {
        question: '选择章节测验模式',
        options: ['限时模式', '逐题解析模式'],
        presentation: {
          title: '非法嵌套画板',
          html: '<div><iframe src="https://example.com"></iframe></div>',
        },
      },
    };

    render(<AskUserBlockComponent block={block} />);

    // 非法 presentation.html 被静默丢弃，不渲染沙箱
    expect(screen.queryByTestId('ask-user-presentation-sandbox')).toBeNull();

    // 原生选项正常渲染且可直接点击提交
    const nativeBtn = screen.getByRole('button', { name: '逐题解析模式' });
    await act(async () => {
      fireEvent.click(nativeBtn);
    });

    expect(invokeMock).toHaveBeenCalledWith('chat_v2_ask_user_respond', {
      toolCallId: 'call-pres-invalid',
      selectedTexts: ['逐题解析模式'],
      selectedIndices: [1],
      customText: null,
      source: 'user_click',
    });
  });
});
