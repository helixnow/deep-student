import { EventEmitter } from 'node:events';
import net from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import type { AnkiCard } from '../../../../contracts/ipc/generated/_shared.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

let env: AnkiTestEnv | undefined;

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await env?.dispose();
  env = undefined;
});

function portProbe(error?: NodeJS.ErrnoException): void {
  vi.spyOn(net, 'connect').mockImplementation((() => {
    const socket = new EventEmitter() as net.Socket;
    socket.destroy = () => socket;
    setImmediate(() => error === undefined ? socket.emit('connect') : socket.emit('error', error));
    return socket;
  }) as typeof net.connect);
}

function server(result: (action: string) => { result: unknown; error: string | null }): void {
  portProbe();
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return new Response('');
    const request = JSON.parse(String(init.body)) as { action: string };
    return new Response(JSON.stringify(result(request.action)));
  });
}

const nonNumericWarning = '⚠️ AnkiConnect version 返回非数字结果，跳过版本协商: Some(Number(5.0))';

// Rust anki_connect_service.rs:395-401 warns but returns Ok(true); each caller must
// retain the side effect, not merely the helper invoked with a test-only logger.
it.each(['check_anki_connect_status', 'check_anki_connect_availability', 'import_anki_package'])(
  'check_anki_connect_availability: %s preserves the non-u64 negotiation warning through Host',
  async (command) => {
    env = await createAnkiTestEnv({ migrate: false });
    const warn = vi.spyOn(env.host.ctx.logger, 'warn');
    server((action) => ({ result: action === 'version' ? 5.0 : null, error: null }));
    // Preserve the lexical 5.0 that serde_json arbitrary_precision distinguishes.
    const fetchBoundary = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && JSON.parse(String(init.body)).action === 'version') {
        return new Response('{"result":5.0,"error":null}');
      }
      return fetchBoundary(url, init);
    });
    await expect(env.host.invoke(command, command === 'import_anki_package' ? { path: '/tmp/input.apkg' } : {}))
      .resolves.toBe(true);
    expect(warn).toHaveBeenCalledExactlyOnceWith(nonNumericWarning);
  },
);

// Rust :319-321 logs before returning Err; the command still returns its original
// string error, not a panic or an AppError wrapper for the raw service command.
it('check_anki_connect_availability logs the port failure before rejecting the command', async () => {
  env = await createAnkiTestEnv({ migrate: false });
  const warn = vi.spyOn(env.host.ctx.logger, 'warn');
  const refused = Object.assign(new Error('refused'), { code: 'ECONNREFUSED', errno: -111 });
  portProbe(refused);
  const fetchBoundary = vi.fn();
  vi.stubGlobal('fetch', fetchBoundary);
  await expect(env.host.invoke('check_anki_connect_availability')).rejects.toContain(
    '端口8765无法访问: Connection refused (os error 111)',
  );
  expect(warn).toHaveBeenCalledExactlyOnceWith('❌ 端口8765无法访问: Connection refused (os error 111)');
  expect(fetchBoundary).not.toHaveBeenCalled();
});

// Rust :421-429 emits warn even when request classification has a user-friendly
// error. Network transport is the only replaced boundary.
it('check_anki_connect_availability logs the failed POST before returning the classified error', async () => {
  env = await createAnkiTestEnv({ migrate: false });
  const warn = vi.spyOn(env.host.ctx.logger, 'warn');
  portProbe();
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return new Response('');
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  });
  await expect(env.host.invoke('check_anki_connect_availability')).rejects.toBe(
    '无法连接到AnkiConnect服务器，请确保：1)Anki正在运行 2)AnkiConnect插件已安装并启用 3)端口8765未被占用',
  );
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('❌ AnkiConnect连接错误详情:'));
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('fetch failed'));
});

it('add_notes_to_anki_detailed preserves availability and precheck fallback warnings through the sync command', async () => {
  env = await createAnkiTestEnv();
  const warn = vi.spyOn(env.host.ctx.logger, 'warn');
  server((action) => {
    if (action === 'modelFieldNames') return { result: ['Front', 'Back'], error: null };
    if (action === 'canAddNotes') return { result: null, error: 'unsupported' };
    return { result: 1, error: null };
  });
  const fetchBoundary = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && JSON.parse(String(init.body)).action === 'version') {
      return new Response('{"result":5.0,"error":null}');
    }
    return fetchBoundary(url, init);
  });
  const card: AnkiCard = {
    id: 'card-logs', task_id: 'task-logs', front: 'Q', back: 'A', text: null,
    tags: [], images: [], is_error_card: false, error_content: null,
    created_at: '2026-11-04T00:00:00+00:00', updated_at: '2026-11-04T00:00:00+00:00',
    extra_fields: {}, template_id: null,
  };
  const report = await env.host.invoke<{ added: number; warnings: string[] }>('add_cards_to_anki_connect', {
    selectedCards: [card], deckName: 'Default', noteType: 'Basic',
  });
  expect(report.added).toBe(1);
  expect(report.warnings).toContain('canAddNotes 预检不可用，已降级为逐条 addNote: AnkiConnect错误(canAddNotes): unsupported');
  expect(warn).toHaveBeenCalledWith(nonNumericWarning);
  expect(warn).toHaveBeenCalledWith('⚠️ canAddNotes 预检不可用，降级为逐条 addNote: AnkiConnect错误(canAddNotes): unsupported');
}, 60_000);

it.each(['missing', 'read-error'] as const)(
  'X6-LP-0064 batch template %s emits only its Rust warning then syncs without local receipts',
  async (failure) => {
    env = await createAnkiTestEnv();
    const db = env.storage.database('mistakes');
    const templateId = 'batch-log-template';
    if (failure === 'read-error') db.run('DROP TABLE custom_anki_templates');
    const warn = vi.spyOn(env.host.ctx.logger, 'warn');
    server((action) => {
      if (action === 'version') return { result: 6, error: null };
      if (action === 'modelFieldNames') return { result: ['Front', 'Back'], error: null };
      if (action === 'canAddNotes') return { result: [true], error: null };
      if (action === 'addNotes') return { result: [42], error: null };
      return { result: 1, error: null };
    });
    const result = await env.host.invoke<string>('batch_export_cards', {
      notes: [{ fields: { Front: 'batch Q', Back: 'batch A' } }],
      format: 'anki-connect',
      options: { templateId, deckName: 'Default', noteType: 'Basic' },
    });
    expect(JSON.parse(result)).toMatchObject({ noteIds: [42], added: 1, duplicates: 0, failed: 0 });
    expect(warn.mock.calls.map(([message]) => message)).toEqual([failure === 'missing'
      ? `[batch_export_cards] 模板不存在: ${templateId}，将按 note_type 直接同步`
      : `[batch_export_cards] 读取模板失败: ${templateId}，将按 note_type 直接同步: no such table: custom_anki_templates`]);
    expect(db.pluck('SELECT COUNT(*) FROM anki_cards')).toBe(0);
  },
);
