import { describe, expect, it } from 'vitest';
import {
  findMessageSearchMatches,
  findTextSearchOccurrences,
  getMessageSearchText,
  createMessageSearchIndex,
} from '../messageSearch';
import type { Block, Message } from '../../core/types';

const makeMessage = (id: string, blockIds: string[]): Message => ({
  id,
  role: 'assistant',
  blockIds,
  timestamp: 0,
});

const makeBlock = (id: string, messageId: string, content: string): Block => ({
  id,
  messageId,
  type: 'content',
  status: 'success',
  content,
});

describe('message search', () => {
  it('keeps worker counts equivalent to the current Unicode and non-overlap rules', () => {
    const samples = [
      ['ΟΣ', 'ΟΣ'], ['ΟΣ', 'ος'], ['ΟΣ', 'οσ'], ['ΑΣ\u0301', 'ΑΣ\u0301'],
      ['Cafe\u0301', 'Café'], ['oﬃce', 'office'], ['ＡＢＣ', 'abc'],
      ['İstanbul', 'i\u0307stanbul'], ['가', '가'], ['ｶﾞ', 'ガ'],
      ['a\u00a0b', 'a b'], ['😀中文😀', '😀'], ['👨‍👩‍👧家庭', '👨‍👩‍👧'],
      ['ﬃﬃﬃ', 'f'], ['aaaaa', 'aa'], ['  中文  ', ' 中文 '],
    ];
    const index = createMessageSearchIndex();
    const message = makeMessage('message', ['first', 'second', 'missing']);
    const messages = new Map([[message.id, message]]);
    for (const [text, query] of samples) {
      const blocks = new Map([
        ['first', makeBlock('first', 'message', text)],
        ['second', makeBlock('second', 'message', `${text} ${text}`)],
      ]);
      index.update({
        messages: [{ messageId: 'message', blockIds: message.blockIds }],
        blocks: [...blocks].map(([id, block]) => ({ id, content: block.content! })),
        removedBlockIds: [],
      });
      for (const search of [query, 'absent', query, '', '   ']) {
        expect(index.find(search)).toEqual(findMessageSearchMatches(['message'], messages, blocks, search));
      }
    }
  });

  it('updates only supplied blocks and removes deleted content while preserving message order', () => {
    const index = createMessageSearchIndex();
    index.update({
      messages: [
        { messageId: 'one', blockIds: ['a', 'b'] },
        { messageId: 'two', blockIds: ['c'] },
      ],
      blocks: [{ id: 'a', content: 'hit' }, { id: 'b', content: 'hit hit' }, { id: 'c', content: 'none' }],
      removedBlockIds: [],
    });
    expect(index.find('hit')).toHaveLength(3);
    index.update({ blocks: [{ id: 'c', content: 'hit' }], removedBlockIds: ['a'] });
    expect(index.find('hit')).toEqual([
      { messageId: 'one', occurrenceIndex: 0 }, { messageId: 'one', occurrenceIndex: 1 },
      { messageId: 'two', occurrenceIndex: 0 },
    ]);
    index.update({ messages: [{ messageId: 'two', blockIds: ['c'] }], blocks: [], removedBlockIds: ['b'] });
    expect(index.find('hit')).toEqual([{ messageId: 'two', occurrenceIndex: 0 }]);
  });

  it('searches message blocks in message order and normalizes case/full-width text', () => {
    const messages = [makeMessage('first', ['block-1']), makeMessage('second', ['block-2'])];
    const blocks = new Map([
      ['block-1', makeBlock('block-1', 'first', 'DeepStudent')],
      ['block-2', makeBlock('block-2', 'second', '学习记录')],
    ]);

    expect(findMessageSearchMatches(
      messages.map((message) => message.id),
      new Map(messages.map((message) => [message.id, message])),
      blocks,
      'ｄｅｅｐｓｔｕｄｅｎｔ',
    )).toEqual([{ messageId: 'first', occurrenceIndex: 0 }]);
    expect(findMessageSearchMatches(
      messages.map((message) => message.id),
      new Map(messages.map((message) => [message.id, message])),
      blocks,
      '学习',
    )).toEqual([{ messageId: 'second', occurrenceIndex: 0 }]);
  });

  it('counts each visible occurrence across blocks and ignores empty queries', () => {
    const message = makeMessage('message', ['block']);
    const block = makeBlock('block', 'message', 'Network failed. Network failed again.');
    const blocks = new Map([['block', block]]);
    const messages = new Map([[message.id, message]]);

    expect(getMessageSearchText(message, blocks)).toBe('Network failed. Network failed again.');
    expect(findMessageSearchMatches(['message'], messages, blocks, 'network')).toEqual([
      { messageId: 'message', occurrenceIndex: 0 },
      { messageId: 'message', occurrenceIndex: 1 },
    ]);
    expect(findMessageSearchMatches(['message'], messages, blocks, '   ')).toEqual([]);
  });

  it('maps normalized matches back to source text offsets for highlighting', () => {
    expect(findTextSearchOccurrences('Ａbc ABC', 'abc')).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ]);
    expect(findTextSearchOccurrences('e\u0301 and é', 'é')).toEqual([
      { start: 0, end: 2 },
      { start: 7, end: 8 },
    ]);
  });
});
