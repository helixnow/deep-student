import { describe, expect, it } from 'vitest';
import type { Message } from '../../types/message';
import type { LoadSessionResponseType } from '../../types';
import type { ChatStoreState, GetState, SetState } from '../types';
import { createRestoreActions, mergeHistoryMessageOrder } from '../restoreActions';

function message(id: string, timestamp: number): Message {
  return { id, role: 'assistant', blockIds: [], timestamp };
}

function backendMessage(
  id: string,
  timestamp: number,
  blockIds: string[] = [],
): LoadSessionResponseType['messages'][number] {
  return { id, sessionId: 'sess_test', role: 'assistant', blockIds, timestamp };
}

function response(
  messages: LoadSessionResponseType['messages'],
  blocks: LoadSessionResponseType['blocks'] = [],
): LoadSessionResponseType {
  return {
    session: {
      id: 'sess_test',
      mode: 'chat',
      persistStatus: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    messages,
    blocks,
  };
}

function restoreLegacyToolName(
  toolName: string,
  runtime?: NonNullable<NonNullable<LoadSessionResponseType['messages'][number]['_meta']>['skillRuntimeAfter']>,
): string | undefined {
  const restoredMessage = backendMessage('m1', 100, ['b1']);
  if (runtime) {
    restoredMessage._meta = { skillRuntimeAfter: runtime };
  }
  let state = {
    sessionId: 'sess_test',
    isDataLoaded: true,
    messageMap: new Map<string, Message>(),
    messageOrder: [],
    blocks: new Map(),
  } as unknown as ChatStoreState;
  const set: SetState = (partial) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch } as ChatStoreState;
  };
  const actions = createRestoreActions(set, () => state as ReturnType<GetState>);

  actions.prependHistoryFromBackend(response(
    [restoredMessage],
    [{
      id: 'b1',
      messageId: 'm1',
      type: 'mcp_tool',
      status: 'success',
      toolName,
    }],
  ));

  return state.blocks.get('b1')?.toolName;
}

describe('mergeHistoryMessageOrder', () => {
  it('remaps legacy mcp_ builtins only with trusted local replay evidence', () => {
    expect(restoreLegacyToolName('mcp_web_search', {
      mcpToolSchemas: [{ name: 'web_search' }],
    })).toBe('builtin-web_search');

    expect(restoreLegacyToolName('mcp_web_search')).toBe('mcp_web_search');
  });

  it('does not remap a real external MCP tool that collides with a builtin', () => {
    expect(restoreLegacyToolName('mcp_web_search', {
      mcpToolSchemas: [{ name: 'web_search', serverId: 'external-search' }],
    })).toBe('mcp_web_search');

    expect(restoreLegacyToolName('mcp_web_search', {
      mcpToolSchemas: [
        { name: 'web_search' },
        { name: 'web_search', serverId: 'external-search' },
      ],
    })).toBe('mcp_web_search');
  });

  it('accepts a known builtin skill snapshot as legacy provenance', () => {
    expect(restoreLegacyToolName('mcp_web_search', {
      skillEmbeddedTools: {
        'knowledge-retrieval': [{ name: 'mcp_web_search' }],
      },
    })).toBe('builtin-web_search');
  });

  it('uses timestamps inside backend anchors instead of prepending every missing message', () => {
    const current = new Map([
      ['local_early', message('local_early', 50)],
      ['m3', message('m3', 300)],
      ['local_late', message('local_late', 400)],
    ]);

    const merged = mergeHistoryMessageOrder(
      ['local_early', 'm3', 'local_late'],
      current,
      [backendMessage('m1', 100), backendMessage('m2', 200), backendMessage('m3', 300)],
    );

    expect(merged).toEqual(['local_early', 'm1', 'm2', 'm3', 'local_late']);
  });

  it('preserves local messages between two backend anchors', () => {
    const current = new Map([
      ['m1', message('m1', 100)],
      ['local', message('local', 150)],
      ['m3', message('m3', 300)],
    ]);

    const merged = mergeHistoryMessageOrder(
      ['m1', 'local', 'm3'],
      current,
      [backendMessage('m1', 100), backendMessage('m2', 200), backendMessage('m3', 300)],
    );

    expect(merged).toEqual(['m1', 'local', 'm2', 'm3']);
  });

  it('falls back to backend anchors without reordering a legacy non-chronological live list', () => {
    const current = new Map([
      ['m1', message('m1', 300)],
      ['local', message('local', 50)],
      ['m3', message('m3', 100)],
    ]);

    const merged = mergeHistoryMessageOrder(
      ['m1', 'local', 'm3'],
      current,
      [backendMessage('m1', 300), backendMessage('m2', 200), backendMessage('m3', 100)],
    );

    expect(merged).toEqual(['m2', 'm1', 'local', 'm3']);
  });

  it('merges missing blocks even when every backend message is already present', () => {
    const existingMessage = message('m1', 100);
    let state = {
      sessionId: 'sess_test',
      isDataLoaded: true,
      messageMap: new Map([['m1', existingMessage]]),
      messageOrder: ['m1'],
      blocks: new Map(),
    } as unknown as ChatStoreState;
    const set: SetState = (partial) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };
    const getState: GetState = () => state as ReturnType<GetState>;
    const actions = createRestoreActions(set, getState);

    actions.prependHistoryFromBackend(response(
      [backendMessage('m1', 100, ['b1'])],
      [{ id: 'b1', messageId: 'm1', type: 'content', status: 'success', content: 'restored' }],
    ));

    expect(state.messageOrder).toEqual(['m1']);
    expect(state.blocks.get('b1')).toMatchObject({ content: 'restored', status: 'success' });
    expect(state.messageMap.get('m1')?.blockIds).toEqual(['b1']);
  });

  it('merges backend variant block references while preserving live-only block order', () => {
    const existingMessage: Message = {
      ...message('m1', 100),
      blockIds: ['live'],
      variants: [{
        id: 'v1',
        modelId: 'model',
        blockIds: ['v_live'],
        status: 'streaming',
        createdAt: 100,
      }],
    };
    let state = {
      sessionId: 'sess_test',
      isDataLoaded: true,
      messageMap: new Map([['m1', existingMessage]]),
      messageOrder: ['m1'],
      blocks: new Map([
        ['live', { id: 'live', messageId: 'm1', type: 'content', status: 'running' }],
        ['v_live', { id: 'v_live', messageId: 'm1', type: 'content', status: 'running' }],
      ]),
    } as unknown as ChatStoreState;
    const set: SetState = (partial) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };
    const actions = createRestoreActions(set, () => state as ReturnType<GetState>);
    const backend = backendMessage('m1', 100, ['b1']);
    backend.variants = [{
      id: 'v1',
      modelId: 'model',
      blockIds: ['vb1'],
      status: 'success',
      createdAt: 100,
    }];

    actions.prependHistoryFromBackend(response(
      [backend],
      [
        { id: 'b1', messageId: 'm1', type: 'content', status: 'success' },
        { id: 'vb1', messageId: 'm1', type: 'content', status: 'success' },
      ],
    ));

    expect(state.messageMap.get('m1')?.blockIds).toEqual(['b1', 'live']);
    expect(state.messageMap.get('m1')?.variants?.[0]?.blockIds).toEqual(['vb1', 'v_live']);
    // Live status wins over a stale full-history snapshot.
    expect(state.messageMap.get('m1')?.variants?.[0]?.status).toBe('streaming');
  });

  it('repairs an ID missing only from messageOrder', () => {
    let state = {
      sessionId: 'sess_test',
      isDataLoaded: true,
      messageMap: new Map([
        ['m1', message('m1', 100)],
        ['m2', message('m2', 200)],
      ]),
      messageOrder: ['m2'],
      blocks: new Map(),
    } as unknown as ChatStoreState;
    const set: SetState = (partial) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };
    const actions = createRestoreActions(set, () => state as ReturnType<GetState>);

    actions.prependHistoryFromBackend(response([
      backendMessage('m1', 100),
      backendMessage('m2', 200),
    ]));

    expect(state.messageOrder).toEqual(['m1', 'm2']);
  });

  it('does not resurrect messages or blocks deleted while full history is loading', () => {
    let state = {
      sessionId: 'sess_test',
      isDataLoaded: true,
      messageMap: new Map([['tail', message('tail', 300)]]),
      messageOrder: ['tail'],
      blocks: new Map(),
    } as unknown as ChatStoreState;
    const set: SetState = (partial) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };
    const actions = createRestoreActions(set, () => state as ReturnType<GetState>);

    actions.prependHistoryFromBackend(
      response(
        [
          backendMessage('old', 100, ['old_block']),
          backendMessage('deleted', 250, ['deleted_block']),
          backendMessage('tail', 300),
        ],
        [
          { id: 'old_block', messageId: 'old', type: 'content', status: 'success' },
          { id: 'deleted_block', messageId: 'deleted', type: 'content', status: 'success' },
        ],
      ),
      {
        messageIds: new Set(['deleted', 'tail']),
        blockIds: new Set(['deleted_block']),
        oldestMessageTimestamp: 250,
        sessionStatus: 'idle',
        currentStreamingMessageId: null,
      },
    );

    expect(state.messageOrder).toEqual(['old', 'tail']);
    expect(state.messageMap.has('deleted')).toBe(false);
    expect(state.blocks.has('deleted_block')).toBe(false);
    expect(state.messageMap.get('old')?.blockIds).toEqual(['old_block']);
  });

  it('preserves an autonomous stream that starts while initial restore is in flight', () => {
    const streamingMessage: Message = {
      ...message('live_assistant', 200),
      blockIds: ['live_block'],
    };
    let state = {
      sessionId: 'sess_test',
      mode: 'chat',
      title: '',
      description: '',
      groupId: null,
      sessionMetadata: null,
      sessionStatus: 'streaming',
      isDataLoaded: false,
      messageMap: new Map([['live_assistant', streamingMessage]]),
      messageOrder: ['live_assistant'],
      blocks: new Map([[
        'live_block',
        {
          id: 'live_block',
          messageId: 'live_assistant',
          type: 'content',
          status: 'running',
          content: 'already arrived',
        },
      ]]),
      currentStreamingMessageId: 'live_assistant',
      activeBlockIds: new Set(['live_block']),
      streamingVariantIds: new Set<string>(),
      pendingContextRefs: [],
      pendingContextRefsDirty: false,
      activeSkillIds: [],
      skillStateJson: null,
      chatParams: {},
      features: new Map(),
      modeState: null,
      inputValue: '',
      attachments: [],
      panelStates: {},
    } as unknown as ChatStoreState;
    const set: SetState = (partial) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };
    const actions = createRestoreActions(set, () => state as ReturnType<GetState>);

    actions.restoreFromBackend(
      response([backendMessage('persisted', 100)]),
      {
        messageIds: new Set(),
        blockIds: new Set(),
        sessionStatus: 'idle',
        currentStreamingMessageId: null,
      },
    );

    expect(state.sessionStatus).toBe('streaming');
    expect(state.currentStreamingMessageId).toBe('live_assistant');
    expect(state.messageOrder).toEqual(['persisted', 'live_assistant']);
    expect(state.blocks.get('live_block')).toMatchObject({
      status: 'running',
      content: 'already arrived',
    });
    expect(state.activeBlockIds.has('live_block')).toBe(true);
  });
});
