import { describe, expect, it } from 'vitest';
import {
  findMessageSearchMatches,
  findTextSearchOccurrences,
  getMessageSearchText,
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
