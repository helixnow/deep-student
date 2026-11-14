/**
 * 流式单次补全的 sink 适配（model2_pipeline.rs 流式通路的 G01-b 语义）：
 * 事件只通过 `StreamEventSink` 发出，不依赖 Tauri 窗口；无窗口时使用
 * `NoopStreamSink` 丢弃事件，流式内容照常聚合返回。
 */
import type { StreamEventSink } from '../api.ts';
import type { ApiConfig } from '../api.ts';
import {
  runSingleShot,
  type DeltaCallback,
  type SingleShotCompletion,
  type SingleShotOptions,
  type SingleShotSender,
} from './single_shot_stream.ts';
import { logError, logWarn } from './logging.ts';

export interface StreamingSinkOptions {
  streamEvent: string;
  requestId: string;
  sink: StreamEventSink;
}

function emitChunk(
  sink: StreamEventSink,
  streamEvent: string,
  content: string,
  isComplete: boolean,
  chunkId: string,
): void {
  try {
    sink.emit(streamEvent, { content, is_complete: isComplete, chunk_id: chunkId });
  } catch (error) {
    const message = `[LLM Stream] failed to emit chunk on ${streamEvent}: ${error instanceof Error ? error.message : String(error)}`;
    // Rust 最终完成信号失败用 error!，普通分块失败用 warn!。
    if (isComplete) logError(message); else logWarn(message);
  }
}

/** 驱动一次流式补全并把文本增量/最终全文推给 sink。 */
export async function runStreamingCompletion(
  opts: SingleShotOptions,
  config: ApiConfig,
  send: SingleShotSender,
  streaming: StreamingSinkOptions,
): Promise<SingleShotCompletion> {
  let chunkCounter = 0;
  const onDelta: DeltaCallback = (delta) => {
    chunkCounter += 1;
    emitChunk(
      streaming.sink,
      streaming.streamEvent,
      delta,
      false,
      `${streaming.requestId}_chunk_${chunkCounter}`,
    );
    return true;
  };
  const completion = await runSingleShot(opts, config, send, onDelta);
  if (!completion.aborted) {
    emitChunk(
      streaming.sink,
      streaming.streamEvent,
      completion.content,
      true,
      `${streaming.requestId}_final_chunk_${chunkCounter + 1}`,
    );
  }
  return completion;
}
