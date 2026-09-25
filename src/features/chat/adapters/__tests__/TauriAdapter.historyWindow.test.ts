/**
 * TauriAdapter 反向历史窗口（historyWindowStartOffset）单测
 *
 * 覆盖 238be79a 引入的窗口化回填不变量：
 * - loadEarlierMessages 按窗口起点向更老一页取数，合并后窗口推进；
 * - backfillHistoryByPages 从尾窗倒序逐页推进、页数上限收尾为 'capped'；
 * - 竞态防御：空页按抵达最老端收尾、非最老端短页退回 'unsupported'；
 * - 'capped' 后 loadEarlierMessages 能无缝接续（窗口连续无空洞）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

vi.mock('../../core/middleware/eventBridge', () => ({
  handleBackendEventWithSequence: vi.fn(),
  flushPendingBackendEvents: vi.fn(),
  handleStreamComplete: vi.fn(() => Promise.resolve()),
  handleStreamAbort: vi.fn(() => Promise.resolve()),
  clearEventContext: vi.fn(),
  resetBridgeState: vi.fn(),
}));

vi.mock('../../core/middleware/autoSave', () => ({
  autoSave: { forceImmediateSave: vi.fn(() => Promise.resolve()), cleanup: vi.fn() },
  streamingBlockSaver: { cleanup: vi.fn() },
}));

import { invoke } from '@tauri-apps/api/core';
import { ChatV2TauriAdapter } from '../TauriAdapter';

const invokeMock = vi.mocked(invoke);

const SESSION_ID = 'sess_window_test';
const PAGE_SIZE = 100;

/** 造一页后端消息：id 按时间正序连续编号 */
function makeMessages(from: number, count: number) {
  return Array.from({ length: count }, (_, i) => {
    const seq = from + i;
    return {
      id: `msg_${seq}`,
      sessionId: SESSION_ID,
      role: seq % 2 === 0 ? 'user' : 'assistant',
      blockIds: [`blk_${seq}`],
      timestamp: 1000 + seq,
    };
  });
}

function makeBlocks(from: number, count: number) {
  return Array.from({ length: count }, (_, i) => {
    const seq = from + i;
    return {
      id: `blk_${seq}`,
      messageId: `msg_${seq}`,
      type: 'content',
      status: 'success',
      content: `content ${seq}`,
    };
  });
}

function pageResponse(offset: number, count: number, total: number) {
  return {
    messages: makeMessages(offset, count),
    blocks: makeBlocks(offset, count),
    totalMessageCount: total,
    offset,
    limit: PAGE_SIZE,
    nextOffset: null,
  };
}

interface Harness {
  adapter: ChatV2TauriAdapter;
  prepends: Array<{ offsetGuess: number; messages: unknown[]; total: number }>;
  store: Record<string, unknown>;
}

function createHarness(opts: {
  windowStartOffset: number;
  totalCount: number;
  initialLoadedCount: number;
}): Harness {
  const prepends: Harness['prepends'] = [];

  // 最小 ChatStore 面：被测方法只触碰这些字段/动作
  const store: Record<string, unknown> = {
    sessionId: SESSION_ID,
    isDataLoaded: true,
    messageMap: new Map(),
    blocks: new Map(),
    sessionStatus: 'idle',
    currentStreamingMessageId: null,
    getOrderedMessages: () => [],
    prependHistoryFromBackend: vi.fn((response: { messages: unknown[]; totalMessageCount?: number }) => {
      prepends.push({
        offsetGuess: -1,
        messages: response.messages,
        total: response.totalMessageCount ?? -1,
      });
    }),
  };

  const adapter = new ChatV2TauriAdapter(SESSION_ID, store as never);
  const internal = adapter as unknown as Record<string, unknown>;

  // 模拟 loadSession 尾窗恢复后的窗口起点
  internal.historyWindowStartOffset = opts.windowStartOffset;
  internal.lastLoadedSessionInfo = { id: SESSION_ID };
  internal.setupGeneration = 1;

  return { adapter, prepends, store };
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe('loadEarlierMessages（反向窗口续拉）', () => {
  it('按窗口起点向更老一页取数，合并后窗口推进', async () => {
    const { adapter, prepends } = createHarness({
      windowStartOffset: 350,
      totalCount: 450,
      initialLoadedCount: 100,
    });
    invokeMock.mockResolvedValueOnce(pageResponse(250, PAGE_SIZE, 450));

    await adapter.loadEarlierMessages();

    expect(invokeMock).toHaveBeenCalledWith('chat_v2_load_messages_page', {
      sessionId: SESSION_ID,
      offset: 250, // 350 - 100
      limit: PAGE_SIZE,
    });
    expect(prepends).toHaveLength(1);
    expect(prepends[0].messages).toHaveLength(PAGE_SIZE);
    expect(
      (adapter as unknown as Record<string, unknown>).historyWindowStartOffset,
    ).toBe(250);
  });

  it('窗口起点不足一页时 offset 截断到 0', async () => {
    const { adapter } = createHarness({
      windowStartOffset: 40,
      totalCount: 140,
      initialLoadedCount: 100,
    });
    invokeMock.mockResolvedValueOnce(pageResponse(0, 40, 140));

    await adapter.loadEarlierMessages();

    expect(invokeMock).toHaveBeenCalledWith('chat_v2_load_messages_page', {
      sessionId: SESSION_ID,
      offset: 0,
      limit: PAGE_SIZE,
    });
    expect(
      (adapter as unknown as Record<string, unknown>).historyWindowStartOffset,
    ).toBe(0);
  });

  it('窗口已抵达最老端（offset=0）时不再请求', async () => {
    const { adapter } = createHarness({
      windowStartOffset: 0,
      totalCount: 100,
      initialLoadedCount: 100,
    });

    await adapter.loadEarlierMessages();

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('空页不回推进窗口也不合并', async () => {
    const { adapter, prepends } = createHarness({
      windowStartOffset: 200,
      totalCount: 300,
      initialLoadedCount: 100,
    });
    invokeMock.mockResolvedValueOnce(pageResponse(100, 0, 300));

    await adapter.loadEarlierMessages();

    expect(prepends).toHaveLength(0);
    // 空页不推进窗口（与 backfill 空页收尾不同：手动路径保守不动）
    expect(
      (adapter as unknown as Record<string, unknown>).historyWindowStartOffset,
    ).toBe(200);
  });
});

describe('backfillHistoryByPages（倒序窗口回填）', () => {
  function runBackfill(adapter: ChatV2TauriAdapter): Promise<string> {
    const internal = adapter as unknown as {
      backfillHistoryByPages: (generation: number) => Promise<string>;
    };
    return internal.backfillHistoryByPages(1);
  }

  it('窗口在页数上限内抵达最老端 → done，倒序逐页推进', async () => {
    // 250 条更早历史 + 尾窗 100 = 350 总；3 页内可补完
    const { adapter, prepends } = createHarness({
      windowStartOffset: 250,
      totalCount: 350,
      initialLoadedCount: 100,
    });
    invokeMock
      .mockResolvedValueOnce(pageResponse(150, PAGE_SIZE, 350)) // W:250→150
      .mockResolvedValueOnce(pageResponse(50, PAGE_SIZE, 350)) // W:150→50
      .mockResolvedValueOnce(pageResponse(0, 50, 350)); // W:50→0（短页即最老端）

    const result = await runBackfill(adapter);

    expect(result).toBe('done');
    const offsets = invokeMock.mock.calls.map((c) => (c[1] as { offset: number }).offset);
    expect(offsets).toEqual([150, 50, 0]); // 倒序推进
    expect(prepends).toHaveLength(3);
    expect(
      (adapter as unknown as Record<string, unknown>).historyWindowStartOffset,
    ).toBe(0);
  });

  it('超过页数上限 → capped，窗口停在未达最老端处', async () => {
    // 1000 条更早历史，5 页（500 条）补不完
    const { adapter, prepends } = createHarness({
      windowStartOffset: 1000,
      totalCount: 1100,
      initialLoadedCount: 100,
    });
    for (let i = 0; i < 5; i += 1) {
      const start = 1000 - (i + 1) * PAGE_SIZE;
      invokeMock.mockResolvedValueOnce(pageResponse(start, PAGE_SIZE, 1100));
    }

    const result = await runBackfill(adapter);

    expect(result).toBe('capped');
    expect(prepends).toHaveLength(5);
    expect(
      (adapter as unknown as Record<string, unknown>).historyWindowStartOffset,
    ).toBe(500); // 1000 - 5*100
    // 关键：capped 不置 fullHistoryLoadComplete，滚动补页可接续
    expect(
      (adapter as unknown as Record<string, unknown>).fullHistoryLoadComplete,
    ).toBeFalsy();
  });

  it('capped 后 loadEarlierMessages 从窗口起点无缝续拉', async () => {
    const { adapter, prepends } = createHarness({
      windowStartOffset: 1000,
      totalCount: 1100,
      initialLoadedCount: 100,
    });
    for (let i = 0; i < 5; i += 1) {
      const start = 1000 - (i + 1) * PAGE_SIZE;
      invokeMock.mockResolvedValueOnce(pageResponse(start, PAGE_SIZE, 1100));
    }
    await runBackfill(adapter);
    expect(prepends).toHaveLength(5);

    // 滚动到顶触发手动补页：应从 W=500 继续向更老拉，而非从头或从已加载数
    invokeMock.mockResolvedValueOnce(pageResponse(400, PAGE_SIZE, 1100));
    await adapter.loadEarlierMessages();

    const offsets = invokeMock.mock.calls.map((c) => (c[1] as { offset: number }).offset);
    expect(offsets).toEqual([900, 800, 700, 600, 500, 400]); // 全程连续无重叠无空洞
    expect(prepends).toHaveLength(6);
    expect(
      (adapter as unknown as Record<string, unknown>).historyWindowStartOffset,
    ).toBe(400);
  });

  it('空页（总数与实际行数竞态收缩）→ 按抵达最老端 done 收尾', async () => {
    const { adapter } = createHarness({
      windowStartOffset: 300,
      totalCount: 400,
      initialLoadedCount: 100,
    });
    invokeMock
      .mockResolvedValueOnce(pageResponse(200, PAGE_SIZE, 400)) // W:300→200
      .mockResolvedValueOnce(pageResponse(100, 0, 150)); // 空页：实际已收缩

    const result = await runBackfill(adapter);

    expect(result).toBe('done');
    expect(
      (adapter as unknown as Record<string, unknown>).historyWindowStartOffset,
    ).toBe(0);
  });

  it('非最老端短页（页序竞态）→ unsupported 退回全量 fallback', async () => {
    const { adapter } = createHarness({
      windowStartOffset: 500,
      totalCount: 600,
      initialLoadedCount: 100,
    });
    // offset=400>0 却返回短页：中间会留空洞，必须退回全量
    invokeMock.mockResolvedValueOnce(pageResponse(400, 30, 600));

    const result = await runBackfill(adapter);

    expect(result).toBe('unsupported');
    // 短页未合并，窗口未推进（回退路径会整体重拉并置窗口为 0）
    expect(
      (adapter as unknown as Record<string, unknown>).historyWindowStartOffset,
    ).toBe(500);
  });
});
