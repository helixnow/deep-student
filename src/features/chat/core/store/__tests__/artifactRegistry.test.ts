/**
 * artifactRegistry 单元测试 — P1 产物一等公民化
 *
 * 关键覆盖：
 * - generative_ui 块的 intent 从 toolInput 三级回退提取（真实重载路径，
 *   落库 intent 在 tool_input 而非 tool_output）
 * - 刷新快照前溯前一用户消息（live 路径 contextSnapshot 只建在用户消息上）
 * - 用户态元数据 read-modify-write（整体替换语义）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../session/sessionManager', () => ({
  sessionManager: {
    subscribe: vi.fn(() => () => {}),
  },
}));

import {
  deriveArtifactFromBlock,
  hydrateSessionArtifacts,
  getSessionArtifacts,
  clearSessionArtifacts,
  registerGenerativeUIArtifact,
  buildArtifactMetaPatch,
  getArtifactUserMeta,
  ARTIFACT_META_KEY,
  type ArtifactEntry,
} from '../artifactRegistry';
import type { Block } from '../../types/block';
import type { Message } from '../../types/message';

// ============================================================================
// 夹具
// ============================================================================

function makeBlock(overrides: Partial<Block>): Block {
  return {
    id: 'blk_1',
    type: 'tool_call',
    status: 'success',
    messageId: 'msg_a',
    startedAt: 1000,
    endedAt: 2000,
    ...overrides,
  } as Block;
}

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: 'msg_u',
    role: 'user',
    blockIds: [],
    timestamp: 500,
    ...overrides,
  } as Message;
}

function makeState(blocks: Block[], messages: Message[]) {
  return {
    blocks: new Map(blocks.map((b) => [b.id, b])),
    messageMap: new Map(messages.map((m) => [m.id, m])),
    messageOrder: messages.map((m) => m.id),
  };
}

const VALID_INTENT = {
  blocks: [{ type: 'markdown', props: { content: '# 周报' } }],
  meta: { title: '周度学习报告' },
};

describe('deriveArtifactFromBlock', () => {
  it('generative_ui 块：intent 从 toolInput 回退提取（真实重载路径）', () => {
    const block = makeBlock({
      id: 'blk_g',
      type: 'generative_ui',
      // 落库后 toolOutput 只有 status/blockCount，intent 在 toolInput
      toolOutput: { status: 'rendered', blockCount: 1 },
      toolInput: { intent: VALID_INTENT },
    });
    const entry = deriveArtifactFromBlock(block, makeState([block], []));
    expect(entry).not.toBeNull();
    expect(entry!.kind).toBe('generative-ui');
    expect(entry!.title).toBe('周度学习报告');
    expect(entry!.artifactId).toBe('blk_g');
    expect(entry!.createdAt).toBe(2000);
  });

  it('generative_ui 块：toolOutput 含 intent 时优先（live/demo 路径）', () => {
    const block = makeBlock({
      type: 'generative_ui',
      toolOutput: { intent: VALID_INTENT, isStreaming: false },
    });
    const entry = deriveArtifactFromBlock(block, makeState([block], []));
    expect(entry!.title).toBe('周度学习报告');
  });

  it('generative_ui 块：非 success 状态不登记', () => {
    const block = makeBlock({ type: 'generative_ui', status: 'running', toolInput: { intent: VALID_INTENT } });
    expect(deriveArtifactFromBlock(block, makeState([block], []))).toBeNull();
  });

  it('anki_cards 块 → anki-cards 产物', () => {
    const block = makeBlock({
      type: 'anki_cards',
      toolOutput: { cards: [{ id: 'c1' }, { id: 'c2' }] },
    });
    const entry = deriveArtifactFromBlock(block, makeState([block], []));
    expect(entry!.kind).toBe('anki-cards');
    expect(entry!.title).toContain('2');
  });

  it('note_create 工具块 → note 产物（targetId=noteId）', () => {
    const block = makeBlock({
      toolName: 'builtin-note_create',
      toolInput: { title: '错题整理' },
      toolOutput: { note_id: 'note_42', title: '错题整理' },
    });
    const entry = deriveArtifactFromBlock(block, makeState([block], []));
    expect(entry!.kind).toBe('note');
    expect(entry!.targetId).toBe('note_42');
    expect(entry!.title).toBe('错题整理');
  });

  it('docx_create 工具块 → file 产物', () => {
    const block = makeBlock({
      toolName: 'builtin-docx_create',
      toolOutput: { file_id: 'file_9', file_name: '报告.docx' },
    });
    const entry = deriveArtifactFromBlock(block, makeState([block], []));
    expect(entry!.kind).toBe('file');
    expect(entry!.targetId).toBe('file_9');
  });

  it('普通工具块不登记', () => {
    const block = makeBlock({ toolName: 'builtin-web_search', toolOutput: {} });
    expect(deriveArtifactFromBlock(block, makeState([block], []))).toBeNull();
  });

  it('刷新快照：前溯前一用户消息取文本与 userRefs', () => {
    const userContentBlock = makeBlock({ id: 'blk_uc', type: 'content', messageId: 'msg_u', content: '帮我生成本周学习报告' });
    const genBlock = makeBlock({
      id: 'blk_g',
      type: 'generative_ui',
      messageId: 'msg_a',
      toolInput: { intent: VALID_INTENT },
    });
    const userMsg = makeMessage({
      id: 'msg_u',
      blockIds: ['blk_uc'],
      _meta: {
        contextSnapshot: {
          userRefs: [{ resourceId: 'res_1', hash: 'h', typeId: 'note' }],
          retrievalRefs: [],
        },
      } as Message['_meta'],
    });
    const assistantMsg = makeMessage({ id: 'msg_a', role: 'assistant', blockIds: ['blk_g'], timestamp: 600 });

    const entry = deriveArtifactFromBlock(genBlock, makeState(
      [userContentBlock, genBlock],
      [userMsg, assistantMsg],
    ));
    expect(entry!.refreshPrompt).toBe('帮我生成本周学习报告');
    expect(entry!.contextRefs).toHaveLength(1);
    expect(entry!.contextRefs![0].resourceId).toBe('res_1');
  });

  it('前面没有用户消息时无刷新快照', () => {
    const genBlock = makeBlock({ type: 'generative_ui', messageId: 'msg_a', toolInput: { intent: VALID_INTENT } });
    const assistantMsg = makeMessage({ id: 'msg_a', role: 'assistant', blockIds: ['blk_1'], timestamp: 600 });
    const entry = deriveArtifactFromBlock(genBlock, makeState([genBlock], [assistantMsg]));
    expect(entry!.refreshPrompt).toBeUndefined();
    expect(entry!.contextRefs).toBeUndefined();
  });
});

describe('hydrateSessionArtifacts / getSessionArtifacts', () => {
  beforeEach(() => {
    clearSessionArtifacts('sess_t');
  });

  it('水合建立索引并按创建时间倒序', () => {
    const b1 = makeBlock({ id: 'b1', type: 'anki_cards', endedAt: 100, toolOutput: { cards: [] } });
    const b2 = makeBlock({ id: 'b2', type: 'generative_ui', endedAt: 200, toolInput: { intent: VALID_INTENT } });
    const added = hydrateSessionArtifacts('sess_t', makeState([b1, b2], []));
    expect(added).toBe(2);
    const list = getSessionArtifacts('sess_t');
    expect(list.map((a) => a.artifactId)).toEqual(['b2', 'b1']);
  });

  it('重复水合跳过已存在条目（保留 live 登记快照）', () => {
    const b1 = makeBlock({ id: 'b1', type: 'anki_cards', endedAt: 100, toolOutput: { cards: [] } });
    hydrateSessionArtifacts('sess_t', makeState([b1], []));
    const before = getSessionArtifacts('sess_t')[0];
    const added = hydrateSessionArtifacts('sess_t', makeState([b1], []));
    expect(added).toBe(0);
    expect(getSessionArtifacts('sess_t')[0]).toBe(before);
  });

  it('registerGenerativeUIArtifact 走 store 登记', () => {
    const block = makeBlock({ id: 'bg', type: 'generative_ui', toolInput: { intent: VALID_INTENT } });
    // eventBridge 传入的是 ChatStore 状态+动作对象本身（非 StoreApi）
    const store = { ...makeState([block], []), sessionId: 'sess_t' } as never;
    registerGenerativeUIArtifact(store, 'bg');
    const list = getSessionArtifacts('sess_t');
    expect(list).toHaveLength(1);
    expect(list[0].kind).toBe('generative-ui');
  });
});

describe('用户态元数据（read-modify-write）', () => {
  it('空 metadata 上 pin', () => {
    const next = buildArtifactMetaPatch(null, 'a1', { pinned: true });
    expect(next).toEqual({ [ARTIFACT_META_KEY]: { a1: { pinned: true } } });
  });

  it('保留 metadata 里已有的其他键（authorityMode 等）', () => {
    const existing = { authorityMode: 'auto', someOther: { x: 1 } };
    const next = buildArtifactMetaPatch(existing, 'a1', { pinned: true });
    expect(next).toMatchObject({ authorityMode: 'auto', someOther: { x: 1 } });
    expect(getArtifactUserMeta(next, 'a1').pinned).toBe(true);
  });

  it('取消 pin 且条目清空时移除条目；全空返回 undefined（清空态）', () => {
    const pinned = buildArtifactMetaPatch(null, 'a1', { pinned: true });
    const cleared = buildArtifactMetaPatch(pinned, 'a1', { pinned: false });
    expect(cleared).toBeUndefined();
  });

  it('多产物条目互不影响', () => {
    let meta = buildArtifactMetaPatch(null, 'a1', { pinned: true });
    meta = buildArtifactMetaPatch(meta, 'a2', { alias: '别名' });
    meta = buildArtifactMetaPatch(meta, 'a1', { pinned: false });
    expect(getArtifactUserMeta(meta, 'a1')).toEqual({});
    expect(getArtifactUserMeta(meta, 'a2').alias).toBe('别名');
  });
});
