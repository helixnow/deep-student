import { expect, it } from 'vitest';
import { InboxManager } from '../src/inbox.ts';
import { INBOX_DRAIN_BATCH_SIZE, MAX_INBOX_SIZE } from '../src/config.ts';

it('test_push_and_drain', () => {
  const manager = new InboxManager();
  for (const id of ['msg1', 'msg2', 'msg3']) manager.push('agent1', id);
  expect(manager.len('agent1')).toBe(3);
  expect(manager.drain('agent1', 2)).toEqual(['msg1', 'msg2']);
  expect(manager.len('agent1')).toBe(1);
});
it('test_max_inbox_size_rejects_new_messages', () => {
  const manager = new InboxManager();
  for (let i = 0; i < MAX_INBOX_SIZE; i++) {
    const result = manager.push('agent1', `msg${i}`);
    expect(result.accepted).toBe(true);
    expect(result.rejectedMessageId).toBeNull();
  }
  const rejected = manager.push('agent1', 'msg_overflow');
  expect(rejected.accepted).toBe(false);
  expect(rejected.rejectedMessageId).toBe('msg_overflow');
  expect(manager.len('agent1')).toBe(MAX_INBOX_SIZE);
  const drained = manager.drain('agent1', MAX_INBOX_SIZE);
  expect(drained).toHaveLength(INBOX_DRAIN_BATCH_SIZE);
  expect(drained[0]).toBe('msg0');
  expect(drained.at(-1)).toBe(`msg${INBOX_DRAIN_BATCH_SIZE - 1}`);
  let total = drained.length;
  for (;;) {
    const batch = manager.drain('agent1', MAX_INBOX_SIZE);
    if (!batch.length) break;
    total += batch.length;
  }
  expect(total).toBe(MAX_INBOX_SIZE);
  expect(manager.len('agent1')).toBe(0);
});
it('test_multiple_agents', () => {
  const manager = new InboxManager();
  manager.push('agent1', 'msg1');
  manager.push('agent2', 'msg2');
  expect(manager.len('agent1')).toBe(1);
  expect(manager.len('agent2')).toBe(1);
  expect(manager.agentCount()).toBe(2);
});
