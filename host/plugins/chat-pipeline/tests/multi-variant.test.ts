import { describe, expect, it } from 'vitest';
import { sourceUserCanonicalBeforeAssistant } from '../src/multi-variant.ts';
import type {
  CanonicalContentPart, ChatMessage, MessageRole,
} from '../../../../contracts/ipc/generated/L04-chat-session.ts';

function message(id: string, role: MessageRole,
  canonicalContent: CanonicalContentPart[] | null): ChatMessage {
  return {
    id,
    sessionId: 'session',
    role,
    blockIds: [],
    timestamp: 1,
    ...(canonicalContent === null
      ? {}
      : { _meta: { canonicalContent } }),
  };
}

describe('chat_v2/pipeline/multi_variant.rs::canonical_retry_tests', () => {
  it('retry_without_context_refs_recovers_original_blob_canonical', () => {
    const original: CanonicalContentPart[] = [
      { type: 'text', text: 'inspect this' },
      {
        type: 'image_ref',
        image_id: 'img-1',
        name: 'photo.jpg',
        resource_id: 'res-1',
        source_id: 'source-1',
        blob_hash: 'stable-original-blob',
        content_hash: null,
        mime_type: 'image/jpeg',
        pinned: false,
        retrieval_hit: false,
      },
    ];
    const messages = [
      message('user', 'user', original),
      message('assistant', 'assistant', null),
    ];

    expect(sourceUserCanonicalBeforeAssistant(messages, 'assistant')).toEqual(original);
    // Unknown assistant id yields nothing; the scan never crosses forward.
    expect(sourceUserCanonicalBeforeAssistant(messages, 'missing')).toBeNull();
  });
});
