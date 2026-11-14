import { expect, it, vi } from 'vitest';
import { CREDENTIALS_KEY, IlinkBotPlugin } from '../src/bot.ts';
import { emptyCredentials, IlinkClient, type WeixinMessage } from '../src/client.ts';

it('persists the getupdates cursor only after dispatching the whole batch', async () => {
  const secrets = new Map<string, string>([
    [CREDENTIALS_KEY, JSON.stringify({ ...emptyCredentials(), accountId: 'account', token: 'token', userId: 'owner' })],
  ]);
  const settings = {
    get: () => null,
    save: () => undefined,
    delete: () => false,
    getSecret: async (key: string) => secrets.get(key) ?? null,
    saveSecret: async (key: string, value: string) => { secrets.set(key, value); },
    deleteSecret: async (key: string) => secrets.delete(key),
  };
  const savedCursor = () => {
    const raw = secrets.get(CREDENTIALS_KEY);
    return raw === undefined ? null : (JSON.parse(raw) as { getUpdatesBuf: string }).getUpdatesBuf;
  };
  // 派发时读到的已落盘游标：修复前这里已经是本批的新游标。
  const cursorAtDispatch: Array<string | null> = [];
  const dispatch = vi.fn(async (_input: { text: string }) => {
    cursorAtDispatch.push(savedCursor());
    return { kind: 'ignored' as const };
  });
  const messages: WeixinMessage[] = ['第一条', '第二条'].map((text, index) => ({
    message_id: index + 1,
    from_user_id: 'owner',
    session_id: 'session',
    context_token: 'context',
    item_list: [{ text_item: { text } }],
  }));
  const controller = new AbortController();
  const client = new IlinkClient();
  let polls = 0;
  const poll = vi.spyOn(client, 'getUpdates').mockImplementation(async () => {
    if (polls++ === 0) return { msgs: messages, get_updates_buf: 'cursor-1' };
    controller.abort();
    return { msgs: [] };
  });
  const plugin = new IlinkBotPlugin({
    client,
    events: { emit: () => undefined },
    log: () => undefined,
    tasks: { isControlMessage: () => false, dispatch, cancelSession: async () => true },
  });
  try {
    await plugin.run({ settings, signal: controller.signal, config: null, desktop: true });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(cursorAtDispatch).toEqual(['', '']);
    // 派发完成后游标仍会落盘，下一轮从新位置继续。
    expect(savedCursor()).toBe('cursor-1');
  } finally {
    poll.mockRestore();
  }
});
