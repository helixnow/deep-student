/** WP-182: budget.rs:23-117 keeps Value::Number untouched in every branch;
 * native JSON.rawJSON atoms carry that Number at the Host tool-output boundary. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost } from '../testing.ts';
import { applyToolResultBudget, serializedCharLen, TRUNCATION_MARKER, type AgentJson } from '../api.ts';
import chat from '../../plugins/chat/index.ts';
import { ChatV2Emitter, type ToolExecutorRegistry } from '../../plugins/chat/api.ts';

const nativeJson = JSON as typeof JSON & {
  rawJSON(text: string): Readonly<{ rawJSON: string }>;
  isRawJSON(value: unknown): boolean;
};
const ABOVE_2_53 = '9007199254740993';
const U64_MAX = '18446744073709551615';
const raw = (token: string) => nativeJson.rawJSON(token) as unknown as AgentJson;
const atomsAt = (value: unknown, path: (string | number)[]) => path.reduce<unknown>((v, k) => (v as Record<string | number, unknown>)[k], value);
const NOTE_PREVIEW = 'Tool output exceeded the result budget; showing a JSON preview. The full output was persisted before truncation.';

function nested() {
  return { id: raw(ABOVE_2_53), stats: { max: raw(U64_MAX), list: [raw(ABOVE_2_53), { deep: raw(U64_MAX) }] } };
}
const NESTED_TEXT = `{"id":${ABOVE_2_53},"stats":{"max":${U64_MAX},"list":[${ABOVE_2_53},{"deep":${U64_MAX}}]}}`;

function expectAtoms(value: unknown, paths: [(string | number)[], string][]) {
  for (const [path, token] of paths) {
    const atom = atomsAt(value, path);
    expect(nativeJson.isRawJSON(atom), path.join('.')).toBe(true);
    expect((atom as { rawJSON: string }).rawJSON).toBe(token);
  }
}
const NESTED_PATHS: [(string | number)[], string][] = [
  [['id'], ABOVE_2_53], [['stats', 'max'], U64_MAX], [['stats', 'list', 0], ABOVE_2_53], [['stats', 'list', 1, 'deep'], U64_MAX],
];

describe('applyToolResultBudget keeps raw JSON number atoms (budget.rs:23-117)', () => {
  it('result_budget_is_noop_within_budget with nested raw u64/above-2^53 numbers', () => {
    const output = nested() as AgentJson;
    const budgeted = applyToolResultBudget(output, 30_000);
    expect(budgeted).toBe(output);
    expect(JSON.stringify(budgeted)).toBe(NESTED_TEXT);
  });

  it('result_budget_shrinks_long_string_leaves_but_keeps_structure: object root keeps atoms and metadata', () => {
    const content = 'x'.repeat(50_000);
    const output = { ...nested(), content } as AgentJson;
    const original = serializedCharLen(output);
    expect(original).toBe(NESTED_TEXT.length - 1 + `,"content":"${content}"}`.length);
    const budgeted = applyToolResultBudget(output, 2048);
    expectAtoms(budgeted, NESTED_PATHS);
    const leaf = 'x'.repeat(256) + TRUNCATION_MARKER;
    expect(JSON.stringify(budgeted)).toBe(`${NESTED_TEXT.slice(0, -1)},"content":${JSON.stringify(leaf)},"truncated":true,`
      + `"original_chars":${original},"truncation_note":"Tool output exceeded the 2048-char result budget; long string fields were shortened. The full output was persisted before truncation."}`);
  });

  it('result_budget_shrinks_long_string_leaves_but_keeps_structure: array root wraps result and counts chars, not UTF-16 units', () => {
    const content = '😀'.repeat(40_000);
    const output = [raw(U64_MAX), content, { n: raw(ABOVE_2_53) }] as AgentJson;
    const original = serializedCharLen(output);
    expect(original).toBe([...`[${U64_MAX},"${content}",{"n":${ABOVE_2_53}}]`].length);
    expect(original).toBeLessThan(`[${U64_MAX},"${content}",{"n":${ABOVE_2_53}}]`.length);
    const budgeted = applyToolResultBudget(output, 4096);
    expectAtoms(budgeted, [[['result', 0], U64_MAX], [['result', 2, 'n'], ABOVE_2_53]]);
    expect(JSON.stringify(budgeted)).toBe(`{"truncated":true,"original_chars":${original},"truncation_note":"Tool output exceeded the 4096-char result budget; `
      + `long string content was shortened. The full output was persisted before truncation.","result":[${U64_MAX},${JSON.stringify('😀'.repeat(512) + TRUNCATION_MARKER)},{"n":${ABOVE_2_53}}]}`);
  });

  it('result_budget_falls_back_to_preview_for_huge_arrays of raw atoms without rawJSON wrappers', () => {
    const output = Array.from({ length: 3_000 }, (_, i) => (i % 2 ? { v: raw(U64_MAX) } : [raw(ABOVE_2_53)])) as AgentJson;
    const text = JSON.stringify(output);
    const budgeted = applyToolResultBudget(output, 2048);
    expect(budgeted).toEqual({ truncated: true, original_chars: [...text].length, budget_chars: 2048, truncation_note: NOTE_PREVIEW, preview: text.slice(0, 2048) });
    expect((budgeted as Record<string, string>).preview).not.toContain('rawJSON');
  });

  it('preview after shrinking still serializes the shrunk working value with original atoms', () => {
    const output = { text: 'y'.repeat(5_000), rows: Array.from({ length: 200 }, () => ({ big: raw(U64_MAX), at: raw(ABOVE_2_53) })) } as AgentJson;
    const original = serializedCharLen(output);
    const budgeted = applyToolResultBudget(output, 1024) as Record<string, AgentJson>;
    const expected = JSON.stringify({ text: 'y'.repeat(256) + TRUNCATION_MARKER, rows: Array.from({ length: 200 }, () => ({ big: raw(U64_MAX), at: raw(ABOVE_2_53) })) });
    expect(expected).toContain(`{"big":${U64_MAX},"at":${ABOVE_2_53}}`);
    expect(budgeted).toEqual({ truncated: true, original_chars: original, budget_chars: 1024, truncation_note: NOTE_PREVIEW, preview: expected.slice(0, 1024) });
  });

  it('a root raw scalar over budget is previewed as its number token, not {rawJSON}', () => {
    const digits = '9'.repeat(40_000);
    const budgeted = applyToolResultBudget(raw(digits), 30_000);
    expect(budgeted).toEqual({ truncated: true, original_chars: 40_000, budget_chars: 30_000, truncation_note: NOTE_PREVIEW, preview: digits.slice(0, 30_000) });
  });
});

describe('ToolExecutorRegistry.execute default budget keeps raw atoms (executor_registry.rs:404-412)', () => {
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let registry: ToolExecutorRegistry;
  beforeAll(async () => {
    host = await createTestHost({ plugins: [chat], provide: { storage: {}, vfs: { version: 1, database: { getConnSafe(): never { throw new Error('vfs is not used by the budget path'); } } } } });
    registry = host.ctx.chatSession.createExecutorRegistry([], { ignoresBroadApprovalBypassForArgs: () => false, neverRememberApprovalForArgs: () => false });
  });
  afterAll(async () => { await host.dispose(); });

  async function run(output: unknown): Promise<unknown> {
    const name = `raw_budget_${registry.len()}`;
    registry.register({ name: () => 'RawBudgetExecutor', canHandle: tool => tool === name,
      async execute(call) { return { toolCallId: call.id, toolName: call.name, input: call.arguments, output, success: true }; } });
    const context = host.ctx.chatSession.createExecutionContext({ sessionId: 'sess_wp182', messageId: 'msg_wp182', blockId: 'blk_wp182',
      services: host.ctx, emitter: ChatV2Emitter.newHeadless('sess_wp182'), blockTypeForTool: () => 'mcp_tool',
      toolRegistry: { async detectToolConflicts() { return []; }, stripMcpNamespace: n => n,
        async callTool() { throw new Error('MCP dispatch is not used by the budget path'); } } });
    return (await registry.execute({ id: 'call_wp182', name, arguments: {} }, context)).output;
  }

  it('within budget returns the same output', async () => {
    const output = nested();
    expect(await run(output)).toBe(output);
  });

  it('over 30000 chars shrinks strings and keeps nested atoms', async () => {
    const output = { ...nested(), content: 'z'.repeat(40_000) };
    const budgeted = await run(output);
    expectAtoms(budgeted, NESTED_PATHS);
    expect(JSON.stringify(budgeted)).toContain(`${NESTED_TEXT.slice(0, -1)},"content":"${'z'.repeat(3_750)}${TRUNCATION_MARKER}","truncated":true,`);
  });

  it('over 30000 chars without shrinkable strings previews digits verbatim', async () => {
    const output = Array.from({ length: 2_000 }, () => ({ v: [raw(U64_MAX), raw(ABOVE_2_53)] }));
    const text = JSON.stringify(output);
    expect(await run(output)).toEqual({ truncated: true, original_chars: text.length, budget_chars: 30_000, truncation_note: NOTE_PREVIEW, preview: text.slice(0, 30_000) });
  });
});
