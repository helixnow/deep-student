/** Explicit L03 adapter → L04 emitter bridge. Never pass an L04 emitter as a raw L03 sink. */
import type { ChatV2Emitter } from '../../chat/api.ts';
import type { StreamEventSink, StreamEventMeta } from './llm-adapter.ts';

export function bindStreamingSink(emitter: ChatV2Emitter): StreamEventSink {
  const register = (blockId: string | null, meta?: StreamEventMeta) => {
    if (blockId !== null && meta !== undefined) {
      emitter.registerBlockEventMeta(blockId, meta.variantId, meta.skillStateVersion, meta.roundId);
    }
  };
  return {
    emitStart(type, messageId, blockId, payload, meta) {
      register(blockId, meta);
      emitter.emitStartWithMeta(type, messageId, blockId, payload,
        meta?.variantId, meta?.skillStateVersion, meta?.roundId);
    },
    emitChunk(type, blockId, chunk, meta) {
      // WithMeta chunks bypass L04's text batcher; registered start metadata is inherited.
      emitter.emitChunk(type, blockId, chunk, meta?.variantId);
    },
    emitEnd(type, blockId, result, meta) {
      emitter.emitEndWithMeta(type, blockId, result, meta?.variantId, meta?.skillStateVersion, meta?.roundId);
    },
    emitError(type, blockId, error, meta) {
      emitter.emitErrorWithMeta(type, blockId, error, meta?.variantId, meta?.skillStateVersion, meta?.roundId);
    },
    emitToolCallPreparingStart(messageId, toolCallId, toolName, blockId, meta) {
      register(blockId, meta);
      emitter.emitToolCallPreparingWithMeta(messageId, toolCallId, toolName, blockId,
        meta?.variantId, meta?.skillStateVersion, meta?.roundId);
    },
  };
}
