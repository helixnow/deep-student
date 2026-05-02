import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { createStore } from 'zustand/vanilla';
import { MessageList } from '../MessageList';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: Record<string, unknown>) => {
      const template =
        typeof options?.defaultValue === 'string' ? options.defaultValue : _key;
      return template
        .replace('{{from}}', String(options?.from ?? ''))
        .replace('{{to}}', String(options?.to ?? ''));
    },
  }),
}));

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
}));

vi.mock('@/components/custom-scroll-area', async () => {
  const ReactModule = await import('react');
  const CustomScrollArea = ReactModule.forwardRef<HTMLDivElement, any>(
    ({ children, viewportRef, className }, ref) => (
      <div ref={ref} className={className}>
        <div ref={viewportRef}>{children}</div>
      </div>
    )
  );
  CustomScrollArea.displayName = 'MockCustomScrollArea';

  return { CustomScrollArea };
});

vi.mock('../MessageItem', async () => {
  const ReactModule = await import('react');
  return {
    MessageItem: ({ messageId }: { messageId: string }) =>
      ReactModule.createElement(
        'div',
        { 'data-testid': `message-${messageId}` },
        messageId
      ),
  };
});

function createMessageListStore(
  currentModelId: string,
  options: { includeAssistantMeta?: boolean; includeTrailingUser?: boolean } = {}
) {
  const includeAssistantMeta = options.includeAssistantMeta ?? true;
  const messageOrder = options.includeTrailingUser
    ? ['msg-user', 'msg-assistant', 'msg-user-next']
    : ['msg-user', 'msg-assistant'];
  const messageMapEntries: Array<[string, any]> = [
    [
      'msg-user',
      {
        id: 'msg-user',
        role: 'user',
        blockIds: [],
        timestamp: 1,
      },
    ],
    [
      'msg-assistant',
      {
        id: 'msg-assistant',
        role: 'assistant',
        blockIds: [],
        timestamp: 2,
        ...(includeAssistantMeta
          ? {
              _meta: {
                modelId: 'deepseek-ai/DeepSeek-V3.2',
                chatParams: {
                  modelId: 'cfg-default',
                  model2OverrideId: 'cfg-old',
                },
              },
            }
          : {}),
      },
    ],
  ];
  if (options.includeTrailingUser) {
    messageMapEntries.push([
      'msg-user-next',
      {
        id: 'msg-user-next',
        role: 'user',
        blockIds: [],
        timestamp: 3,
      },
    ]);
  }

  return createStore<any>((set) => ({
    sessionStatus: 'idle',
    isDataLoaded: true,
    messageOrder,
    messageMap: new Map(messageMapEntries),
    blocks: new Map(),
    chatParams: {
      modelId: 'cfg-default',
      modelDisplayName: '',
      model2OverrideId: currentModelId,
    },
    setChatParams: (params: Record<string, unknown>) =>
      set((state: any) => ({
        chatParams: {
          ...state.chatParams,
          ...params,
        },
      })),
  }));
}

const availableModels = [
  {
    id: 'cfg-old',
    name: 'DeepSeek V3.2',
    model: 'deepseek-ai/DeepSeek-V3.2',
    aliases: ['deepseek-ai/deepseek-v3.2'],
  },
  {
    id: 'cfg-new',
    name: 'Qwen Max',
    model: 'qwen-max',
    aliases: ['qwen max'],
  },
  {
    id: 'cfg-third',
    name: 'Claude Sonnet',
    model: 'claude-sonnet-4.5',
  },
];

describe('MessageList model switch notice', () => {
  it('renders the model switch notice under the last message when the session model changed', () => {
    const store = createMessageListStore('cfg-new');

    render(
      <MessageList
        store={store as any}
        {...({ availableModels } as any)}
      />
    );

    const notice = screen.getByTestId('model-switch-notice');
    expect(notice).toHaveTextContent('模型已从 deepseek-ai/DeepSeek-V3.2 更改为qwen-max');
    expect(screen.getByRole('log').lastElementChild).toBe(notice);
  });

  it('inserts the model switch notice directly under the last assistant response', () => {
    const store = createMessageListStore('cfg-new', { includeTrailingUser: true });

    render(
      <MessageList
        store={store as any}
        {...({ availableModels } as any)}
      />
    );

    const children = Array.from(screen.getByRole('log').children);
    expect(children.map((child) => child.getAttribute('data-testid'))).toEqual([
      'message-msg-user',
      'message-msg-assistant',
      'model-switch-notice',
      'message-msg-user-next',
    ]);
  });

  it('anchors a runtime model switch after the current last message, even when it is a user message', () => {
    const store = createMessageListStore('cfg-old', {
      includeAssistantMeta: false,
      includeTrailingUser: true,
    });

    render(
      <MessageList
        store={store as any}
        {...({ availableModels } as any)}
      />
    );

    act(() => {
      store.getState().setChatParams({
        model2OverrideId: 'cfg-new',
        modelDisplayName: 'qwen-max',
      });
    });

    const children = Array.from(screen.getByRole('log').children);
    expect(children.map((child) => child.getAttribute('data-testid'))).toEqual([
      'message-msg-user',
      'message-msg-assistant',
      'message-msg-user-next',
      'model-switch-notice',
    ]);
  });

  it('does not render the model switch notice when the session model still matches', () => {
    const store = createMessageListStore('cfg-old');

    render(
      <MessageList
        store={store as any}
        {...({ availableModels } as any)}
      />
    );

    expect(screen.queryByTestId('model-switch-notice')).not.toBeInTheDocument();
  });

  it('appears immediately after the current dialog model changes', () => {
    const store = createMessageListStore('cfg-old');

    render(
      <MessageList
        store={store as any}
        {...({ availableModels } as any)}
      />
    );

    expect(screen.queryByTestId('model-switch-notice')).not.toBeInTheDocument();

    act(() => {
      store.getState().setChatParams({
        model2OverrideId: 'cfg-new',
        modelDisplayName: 'qwen-max',
      });
    });

    expect(screen.getByTestId('model-switch-notice')).toHaveTextContent(
      '模型已从 deepseek-ai/DeepSeek-V3.2 更改为qwen-max'
    );
  });

  it('appears after switching models even when the last assistant message has no model metadata', () => {
    const store = createMessageListStore('cfg-old', { includeAssistantMeta: false });

    render(
      <MessageList
        store={store as any}
        {...({ availableModels } as any)}
      />
    );

    expect(screen.queryByTestId('model-switch-notice')).not.toBeInTheDocument();

    act(() => {
      store.getState().setChatParams({
        model2OverrideId: 'cfg-new',
        modelDisplayName: 'qwen-max',
      });
    });

    expect(screen.getByTestId('model-switch-notice')).toHaveTextContent(
      '模型已从 deepseek-ai/DeepSeek-V3.2 更改为qwen-max'
    );
  });

  it('keeps each model switch notice fixed at the message where the switch happened', () => {
    const store = createMessageListStore('cfg-old', { includeAssistantMeta: false });

    render(
      <MessageList
        store={store as any}
        {...({ availableModels } as any)}
      />
    );

    act(() => {
      store.getState().setChatParams({
        model2OverrideId: 'cfg-new',
        modelDisplayName: 'qwen-max',
      });
    });

    act(() => {
      store.setState((state: any) => ({
        messageOrder: [...state.messageOrder, 'msg-user-second', 'msg-assistant-second'],
        messageMap: new Map(state.messageMap)
          .set('msg-user-second', {
            id: 'msg-user-second',
            role: 'user',
            blockIds: [],
            timestamp: 3,
          })
          .set('msg-assistant-second', {
            id: 'msg-assistant-second',
            role: 'assistant',
            blockIds: [],
            timestamp: 4,
          }),
      }));
    });

    act(() => {
      store.getState().setChatParams({
        model2OverrideId: 'cfg-third',
        modelDisplayName: 'claude-sonnet-4.5',
      });
    });

    const children = Array.from(screen.getByRole('log').children);
    expect(children.map((child) => child.getAttribute('data-testid'))).toEqual([
      'message-msg-user',
      'message-msg-assistant',
      'model-switch-notice',
      'message-msg-user-second',
      'message-msg-assistant-second',
      'model-switch-notice',
    ]);

    const notices = screen.getAllByTestId('model-switch-notice');
    expect(notices[0]).toHaveTextContent('模型已从 deepseek-ai/DeepSeek-V3.2 更改为qwen-max');
    expect(notices[1]).toHaveTextContent('模型已从 qwen-max 更改为claude-sonnet-4.5');
  });
});
