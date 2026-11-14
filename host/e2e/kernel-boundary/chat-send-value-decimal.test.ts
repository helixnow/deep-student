/**
 * V08-01（V08-serialization.md 复现 2）：真实 chat 插件 + 生产 invoke 路径（Electron main 总带 argsJson）。
 * 用户接入的 MCP 工具 schema 里有 `default: 0.5`：修复前 kernel 把它解成 `JSON.rawJSON` 原子，
 * `send-message.ts` 的 `structuredClone` 抛 DataCloneError，命令 panic，前端看到 `[object Object] could not be cloned.`。
 * 只有 L03 execute 入口与 L02 模型查询是替身；chat 插件、数据库、流状态、kernel 解码与真实 backgroundTasks 都是生产代码。
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../kernel/testing.ts';
import { createBackgroundTasks, type BackgroundTasks } from '../../platform/diagnostics/api.ts';
import chat from '../../plugins/chat/index.ts';
import type { BackendSendRequest } from '../../plugins/chat/api.ts';
import { newSession } from '../../plugins/chat/src/types.ts';
import { databaseFixture, vfsStub } from '../../plugins/chat/tests/database-fixture.ts';

const SESSION = 'sess_v08_decimal';
const source = { window: 'main', webview: 'main' };

let f: ReturnType<typeof databaseFixture>;
let host: TestHost;
let background: BackgroundTasks;
let executed: BackendSendRequest[];

beforeEach(async () => {
  f = databaseFixture();
  background = createBackgroundTasks();
  executed = [];
  host = await createTestHost({ plugins: [chat], provide: {
    storage: f.storage, vfs: vfsStub, backgroundTasks: background,
    chatPipeline: { execute: async (_window: unknown, request: BackendSendRequest) => {
      executed.push(request);
      return request.assistantMessageId!;
    } },
    llm: {
      getApiConfigs: async () => [{ id: 'cfg', model: 'm', isMultimodal: false }],
      selectModelFor: async () => [{ isMultimodal: false }, false],
    },
  } });
  host.ctx.chatSession.createSession(newSession(SESSION, 'chat'));
});
afterEach(async () => { await background.shutdown(); await host.dispose(); f.dispose(); });

const args = {
  request: {
    sessionId: SESSION, content: 'hello', assistantMessageId: 'msg_v08',
    options: { mcpToolSchemas: [{
      name: 'mcp_weather', description: 'w',
      inputSchema: { type: 'object', properties: { threshold: { type: 'number', default: 0.5, minimum: 0.1, multipleOf: 0.01 } } },
    }] },
  },
};

it('V08-01: chat_v2_send_message over the argsJson path with a decimal in an MCP tool schema returns the assistant message id', async () => {
  const outcome = await host.runtime.dispatchInvoke({
    id: 'v08-send', cmd: 'chat_v2_send_message', args: {}, argsJson: JSON.stringify(args), source,
  });
  expect(outcome).toEqual({ kind: 'ok', value: 'msg_v08' });
  for (let i = 0; i < 200 && executed.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(executed).toHaveLength(1);
  const schema = executed[0]!.options?.mcpToolSchemas?.[0]?.inputSchema as { properties: { threshold: Record<string, unknown> } };
  expect(schema.properties.threshold).toEqual({ type: 'number', default: 0.5, minimum: 0.1, multipleOf: 0.01 });
  expect(JSON.stringify(executed[0]!.options?.mcpToolSchemas)).toBe(JSON.stringify(args.request.options.mcpToolSchemas));
});

it('V08-01: chat_v2_wake_session over the argsJson path with the same options does not panic', async () => {
  const wake = { sessionId: SESSION, content: 'wake', assistantMessageId: 'msg_v08_wake', options: args.request.options };
  const outcome = await host.runtime.dispatchInvoke({
    id: 'v08-wake', cmd: 'chat_v2_wake_session', args: {}, argsJson: JSON.stringify(wake), source,
  });
  expect(outcome).toEqual({ kind: 'ok', value: 'msg_v08_wake' });
});
