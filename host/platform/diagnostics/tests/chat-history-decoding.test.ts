import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../storage/service.ts';
import diagnostics from '../index.ts';

const empty = { total_messages: 0, messages_with_images: 0, messages_with_thinking: 0,
  messages_with_rag_sources: 0, messages_with_memory_sources: 0, messages_with_web_sources: 0,
  messages_with_persistent_id: 0 };

async function setup(raw: string) {
  const host = await createTestHost();
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  host.ctx.provide('storage', storage);
  await host.install(diagnostics);
  const db = storage.database('mistakes');
  db.exec('CREATE TABLE mistakes (chat_history TEXT)');
  db.run('INSERT INTO mistakes VALUES (?)', [raw]);
  return { host, storage };
}

// debug_commands.rs:28-50 owns DebugRawChatMessage; :111-137 skips the entire history if its Vec decode fails.
it.each([
  '[{"role":"user","role":"assistant","content":"text","timestamp":"now"}]',
  '[{"role":"user","content":"text","timestamp":"now","rag_sources":"\\ud800"}]',
  '[{"role":"user","content":"text","timestamp":"now","thinking_content":null,"thinking_content":"text"}]',
  '[{"role":"user","content":"text","timestamp":"now"},{"role":"assistant","content":"text","timestamp":"now","_meta":"\\ud800"}]',
])('F4-V2-11 stats skip typed-invalid chat_history %s without changing the row', async raw => {
  const { host, storage } = await setup(raw);
  try {
    expect(await host.invoke('debug_get_database_stats')).toEqual({ total_mistakes: 1, mistakes_with_chat: 1, ...empty });
    expect(storage.database('mistakes').pluck('SELECT chat_history FROM mistakes')).toBe(raw);
  } finally { await host.dispose(); storage.dispose(); }
});

it('F4-V2-11 DebugRawChatMessage sequence counts the declared fields, including empty Some values', async () => {
  const raw = JSON.stringify([['user', 'content', 'now', '', [], [], null, {}, ['image'], null,
    null, null, null, null, null, 'id', null, null, null]]);
  const { host, storage } = await setup(raw);
  try {
    expect(await host.invoke('debug_get_database_stats')).toEqual({ total_mistakes: 1, mistakes_with_chat: 1,
      total_messages: 1, messages_with_images: 1, messages_with_thinking: 1, messages_with_rag_sources: 1,
      messages_with_memory_sources: 1, messages_with_web_sources: 1, messages_with_persistent_id: 1 });
  } finally { await host.dispose(); storage.dispose(); }
});

it('F4-V2-11 unknown history values are IgnoredAny, while known Value numbers keep arbitrary precision', async () => {
  const raw = '[{"role":"user","content":"text","timestamp":"now","rag_sources":{"n":1e400},"extension":{"s":"\\ud800","deep":'
    + '['.repeat(128) + ']'.repeat(128) + '}}]';
  const { host, storage } = await setup(raw);
  try {
    expect(await host.invoke('debug_get_database_stats')).toEqual({ total_mistakes: 1, mistakes_with_chat: 1,
      ...empty, total_messages: 1, messages_with_rag_sources: 1 });
  } finally { await host.dispose(); storage.dispose(); }
});
