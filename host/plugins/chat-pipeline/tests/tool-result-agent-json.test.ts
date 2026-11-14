import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import chatPlugin from '../../chat/index.ts';
import { ChatV2Emitter, type ToolExecutor, type ToolResultInfo } from '../../chat/api.ts';
import { toolResultsToMessages } from '../src/history.ts';

const ID = 'RF-W02-agent-json-bigint';
const vfsStub = { version: 1 as const, database: { getConnSafe(): never { throw new Error('vfs is not exercised here'); } } };

describe('V08-06: the executor registry hands the loop JSON-safe tool output', () => {
  let host: Awaited<ReturnType<typeof createTestHost>>;
  beforeAll(async () => { host = await createTestHost({ plugins: [chatPlugin], provide: { storage: {}, vfs: vfsStub } }); });
  afterAll(async () => { await host.dispose(); });

  async function run(output: unknown, budget?: number | null): Promise<ToolResultInfo> {
    const executor: ToolExecutor = {
      name: () => 'BigintProbe', canHandle: tool => tool === 'probe',
      ...(budget === undefined ? {} : { resultCharBudget: () => budget }),
      async execute(call) { return { toolCallId: call.id, toolName: call.name, input: call.arguments, output, success: true }; },
    };
    const registry = host.ctx.chatSession.createExecutorRegistry([executor], {
      ignoresBroadApprovalBypassForArgs: () => false, neverRememberApprovalForArgs: () => false,
    });
    const context = host.ctx.chatSession.createExecutionContext({ sessionId: 'sess_bigint', messageId: 'msg_bigint', blockId: 'blk_bigint',
      services: host.ctx, emitter: ChatV2Emitter.newHeadless('sess_bigint'), blockTypeForTool: () => 'mcp_tool',
      toolRegistry: { async detectToolConflicts() { return []; }, stripMcpNamespace: name => name,
        async callTool() { throw new Error('MCP dispatch is not exercised here'); } } });
    return registry.execute({ id: 'call_bigint', name: 'probe', arguments: {} }, context);
  }

  it(`${ID}: bigint leaves become numbers under the default budget and with budgeting disabled`, async () => {
    for (const budget of [undefined, null]) {
      const result = await run({ note_id: 1730000000000123n, rows: [{ count: 3n }], label: 'x' }, budget);
      expect(result.output).toEqual({ note_id: 1730000000000123, rows: [{ count: 3 }], label: 'x' });
      const tool = toolResultsToMessages([result]).find(message => message.role === 'tool');
      expect(tool?.content).toBe('{"note_id":1730000000000123,"rows":[{"count":3}],"label":"x"}');
    }
  });

  it(`${ID}: integers beyond 2^53 round like the frontend's JSON.parse; raw atoms and bigint-free output are untouched`, async () => {
    const atom = (JSON as typeof JSON & { rawJSON(text: string): unknown }).rawJSON('1.0');
    expect((await run({ id: 1730000000000123456n, ratio: atom })).output).toEqual({ id: 1730000000000123500, ratio: atom });
    const plain = { content: 'short', nested: [{ n: 1 }] };
    expect((await run(plain)).output).toBe(plain);
  });
});
