/**
 * Web 演示壳 - 剧本播放器（真链路）
 *
 * 把 DemoBlocks 剧本编译成 BackendEvent 事件序列，通过
 * @tauri-apps/api/event 的 emit 推到真实 TauriAdapter 监听的 channel：
 * - `chat_v2_event_{sessionId}`   block 级事件（thinking/content/web_search...）
 * - `chat_v2_session_{sessionId}` 会话级事件（stream_start/stream_complete/...）
 *
 * 前提：mockIPC 以 { shouldMockEvents: true } 安装，emit 会直接触达
 * adapter 通过 listen() 注册的回调（官方 mocks 的内存事件闭环）。
 *
 * 事件序列与真实后端对齐：
 *   stream_start → (start → chunk* → end)×N → stream_complete
 * 事件不带 streamGeneration：isStaleByStreamGeneration 对 undefined 直接放行。
 */

import { emit } from '@tauri-apps/api/event';
import type { BackendEvent } from '@/features/chat/core/middleware/eventBridge';
import type { SessionEventPayload } from '@/features/chat/adapters/types';
import type { DemoBlocks } from './fixtures';

const LOG = '[demo-player]';

const players = new Map<string, AbortController>();

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/** 把长文本切成流式 chunk（4~10 字符随机，模拟 token 节奏） */
function* chunkText(text: string): Generator<string> {
  let pos = 0;
  while (pos < text.length) {
    const size = 4 + Math.floor(Math.random() * 7);
    yield text.slice(pos, pos + size);
    pos += size;
  }
}

/** 中断某会话正在播放的剧本；返回是否中断了进行中的播放 */
export function abortScript(sessionId: string): boolean {
  const ctrl = players.get(sessionId);
  if (!ctrl) return false;
  ctrl.abort();
  players.delete(sessionId);
  return true;
}

export function isPlaying(sessionId: string): boolean {
  return players.has(sessionId);
}

/**
 * 播放一轮助手回复剧本。由 mock 的 chat_v2_send_message 触发。
 * 从不 reject（abort/异常都在内部吞掉，保证 adapter 的 send 路径干净）。
 */
export async function playReplyScript(opts: {
  sessionId: string;
  assistantMessageId: string;
  blocks: DemoBlocks;
}): Promise<void> {
  const { sessionId, assistantMessageId, blocks } = opts;

  abortScript(sessionId);
  const ctrl = new AbortController();
  players.set(sessionId, ctrl);
  const { signal } = ctrl;

  const blockChannel = `chat_v2_event_${sessionId}`;
  const sessionChannel = `chat_v2_session_${sessionId}`;
  const startedAt = Date.now();
  let sequenceId = 0;

  const emitBlock = (event: BackendEvent) =>
    emit(blockChannel, { sessionId, ...event });
  const emitSession = (event: Omit<SessionEventPayload, 'sessionId' | 'timestamp'>) =>
    emit(sessionChannel, { sessionId, timestamp: Date.now(), ...event });

  try {
    await emitSession({ eventType: 'stream_start', messageId: assistantMessageId });

    for (let i = 0; i < blocks.length; i++) {
      const def = blocks[i];
      if (signal.aborted) return;
      await sleep(def.delay ?? 240, signal);

      const blockId = `${assistantMessageId}-sb${i}`;
      await emitBlock({
        type: def.type,
        phase: 'start',
        messageId: assistantMessageId,
        blockId,
        sequenceId: sequenceId++,
        payload: {
          ...(def.toolName ? { toolName: def.toolName } : {}),
          ...(def.toolInput ? { toolInput: def.toolInput } : {}),
        },
      });

      if (def.streaming && def.content) {
        for (const chunk of chunkText(def.content)) {
          if (signal.aborted) return;
          await emitBlock({
            type: def.type,
            phase: 'chunk',
            blockId,
            chunk,
            sequenceId: sequenceId++,
          });
          await sleep(12 + Math.random() * 30, signal);
        }
      } else {
        // 检索/工具类：无 chunk，停留一段模拟执行耗时
        await sleep(700, signal);
      }

      if (signal.aborted) return;
      await emitBlock({
        type: def.type,
        phase: 'end',
        blockId,
        result: def.toolOutput,
        sequenceId: sequenceId++,
      });
    }

    await emitSession({
      eventType: 'stream_complete',
      messageId: assistantMessageId,
      durationMs: Date.now() - startedAt,
    });
  } catch (e) {
    if ((e as Error).name !== 'AbortError') {
      console.warn(LOG, 'script playback failed:', e);
    }
    // abort 路径：由 mock 的 cancel 命令另行补发 stream_cancelled
  } finally {
    if (players.get(sessionId) === ctrl) players.delete(sessionId);
  }
}
