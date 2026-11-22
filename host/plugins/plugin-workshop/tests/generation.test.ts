import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AppInfo } from '../../../kernel/api.ts';
import type { ChatSessionService, ToolResultInfo } from '../../chat/api.ts';
import type { ChatPipelineService } from '../../chat-pipeline/api.ts';
import { WorkshopOperations } from '../src/operations.ts';
import { WorkshopCatalog } from '../src/catalog.ts';
import { WorkshopToolExecutor } from '../src/tools.ts';
import { PipelineWorkshopGeneration, extractAssistantAnswerText, validateVerificationResult, VERIFICATION_TOOLS } from '../src/generation.ts';
import type { WorkshopCard } from '../api.ts';

it('binds the existing pipeline/skill runtime without filesystem, install or global Agent authority', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dstu-generation-'));
  const ops = new WorkshopOperations({ dataDir, version: '0.20.0', debug: true } as AppInfo);
  const card = await ops.propose({ sessionId: 'parent', title: 'Test', description: 'Test', template: 'host-tool', changes: [], capabilities: [] });
  card.execution = { mode: 'delegated', stage: 'generating', modelId: 'current-conversation-model' };
  const chat = { createSession: vi.fn(), getMessageBlocks: vi.fn(() => [{ type: 'content', content: '{"files":[{"path":"answer.ts","content":"export const answer = 42;"}]}' }]) } as unknown as ChatSessionService;
  const execute = vi.fn(async () => 'msg_result');
  const pipeline = { execute } as unknown as ChatPipelineService;
  const generation = new PipelineWorkshopGeneration(chat, pipeline, new WorkshopToolExecutor(ops, new WorkshopCatalog(() => [])));
  const source = join(ops.store.directory(card.id), 'source');
  const controller = new AbortController();
  await generation.generate(card, source, controller.signal);
  const request = execute.mock.calls[0] as unknown as [unknown, { sessionId: string; options: Record<string, unknown> }, AbortSignal, unknown];
  expect(request[1].sessionId).not.toBe('parent');
  expect(request[1].options).toMatchObject({ modelId: 'current-conversation-model', strictModelId: true });
  expect(request[1].options.activeSkillIds).toEqual(['dstu-plugin-development']);
  expect(request[1].options.executionAllowedTools).toEqual(['dstu_plugin_api_list', 'dstu_plugin_api_read']);
  expect(request[2]).toBe(controller.signal);
  expect(await readFile(join(source, 'answer.ts'), 'utf8')).toContain('42');
});


async function verificationFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'dstu-verification-'));
  const ops = new WorkshopOperations({ dataDir, version: '0.20.0', debug: true } as AppInfo);
  const card = await ops.propose({ sessionId: 'parent', title: '公式表', description: '展示公式表', template: 'learning-tool', changes: ['展示面积公式'], capabilities: [] });
  card.version = '0.1.0';
  card.validation = { version: '0.1.0', revision: card.revision, status: 'pending' };
  card.execution = { mode: 'delegated', stage: 'validating', modelId: 'actual-parent-model' };
  const source = join(ops.store.directory(card.id), 'source');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'index.ts'), 'export const unchanged = true;');
  return { ops, card, source };
}
function observed(card: WorkshopCard): ToolResultInfo {
  return { toolCallId: 'observed-current', toolName: 'builtin-workbench_observe', input: { windowId: 'candidate-window' }, success: true,
    output: { windowId: 'candidate-window', typeId: 'plugin-view.formulas', revision: 'real-observation',
      state: { pluginId: card.pluginId, version: card.version, status: 'ready', text: '公式表 面积 = 长 × 宽' } } };
}
const passedAnswer = () => JSON.stringify({ status: 'passed', checks: [
  { criterion: 0, observed: '显示公式表标题', toolCallIds: ['observed-current'] },
  { criterion: 1, observed: '显示面积 = 长 × 宽', toolCallIds: ['observed-current'] },
] });

it('reports a concrete generation block without changing the existing source', async () => {
  const { ops, card, source } = await verificationFixture();
  const chat = { createSession: vi.fn(), getMessageBlocks: () => [{ type: 'content', content: '{"blockedReason":"需要用户提供课表地址"}' }] } as unknown as ChatSessionService;
  const generation = new PipelineWorkshopGeneration(chat, { execute: async () => 'blocked-result' } as unknown as ChatPipelineService,
    new WorkshopToolExecutor(ops, new WorkshopCatalog(() => [])));
  expect(await generation.generate(card, source, new AbortController().signal)).toEqual({ blockedReason: '需要用户提供课表地址' });
  expect(await readdir(source)).toEqual(['index.ts']);
  expect(await readFile(join(source, 'index.ts'), 'utf8')).toBe('export const unchanged = true;');
});

it('runs an independent read-only verification with the actual parent model and persisted observations', async () => {
  const { ops, card, source } = await verificationFixture();
  const chat = { createSession: vi.fn(), getMessageBlocks: () => [{ type: 'content', content: passedAnswer() }],
    getMessage: () => ({ _meta: { toolResults: [observed(card)] } }) } as unknown as ChatSessionService;
  const execute = vi.fn(async () => 'verification-result');
  const generation = new PipelineWorkshopGeneration(chat, { execute } as unknown as ChatPipelineService,
    new WorkshopToolExecutor(ops, new WorkshopCatalog(() => [])));
  const result = await generation.verify(card, source, new AbortController().signal);
  expect(result.status).toBe('passed');
  expect(result.evidence).toHaveLength(2);
  const request = execute.mock.calls[0] as unknown as [unknown, { sessionId: string; options: Record<string, unknown> }];
  expect(request[1].sessionId).not.toBe('parent');
  expect(request[1].options).toMatchObject({ modelId: 'actual-parent-model', strictModelId: true,
    schemaToolIds: [...VERIFICATION_TOOLS], executionAllowedTools: [...VERIFICATION_TOOLS], activeSkillIds: [],
    memoryEnabled: false, ragEnabled: false, webSearchEnabled: false });
  expect(request[1].options.executionAllowedTools).not.toContain('builtin-workbench_act');
});

it.each(['missing', 'wrong-version', 'wrong-plugin', 'failed-call', 'api-doc', 'visible-json', 'timed-out-wait'] as const)(
  'does not certify a candidate from %s evidence', async kind => {
    const { card } = await verificationFixture();
    const result = observed(card);
    const output = result.output as { state: Record<string, unknown> };
    if (kind === 'wrong-version') output.state.version = '0.0.9';
    if (kind === 'wrong-plugin') output.state.pluginId = 'another-plugin';
    if (kind === 'failed-call') result.success = false;
    if (kind === 'api-doc') result.toolName = 'dstu_plugin_api_read';
    if (kind === 'visible-json') result.output = { state: { pluginId: 'another-plugin', version: '0.0.9', status: 'ready', text: JSON.stringify(output.state) } };
    if (kind === 'timed-out-wait') {
      result.toolName = 'builtin-workbench_wait_for';
      result.output = { matched: false, timedOut: true, observation: output };
    }
    expect(validateVerificationResult(passedAnswer(), card, kind === 'missing' ? [] : [result]).status).toBe('blocked');
  },
);

it('accepts a successful wait observation but requires every requested criterion', async () => {
  const { card } = await verificationFixture();
  const result = observed(card);
  result.toolName = 'builtin-workbench_wait_for';
  result.output = { matched: true, timedOut: false, observation: result.output };
  expect(validateVerificationResult(passedAnswer(), card, [result]).status).toBe('passed');
  const partial = JSON.parse(passedAnswer());
  partial.checks.pop();
  expect(validateVerificationResult(JSON.stringify(partial), card, [result])).toMatchObject({ status: 'blocked', error: expect.stringContaining('criterion 1') });
});

it('keeps unsupported interaction tests blocked and rejects a self-reported pass without observations', async () => {
  const { card } = await verificationFixture();
  expect(validateVerificationResult('{"status":"blocked","error":"需在隔离数据上点击保存并读取结果"}', card, [])).toEqual({
    status: 'blocked', evidence: [], error: '需在隔离数据上点击保存并读取结果',
  });
  expect(validateVerificationResult('{"status":"passed"}', card, []).status).toBe('blocked');
  expect(validateVerificationResult('null', card, []).status).toBe('blocked');
});


it.each(['success', 'failed-block', 'missing-block', 'wrong-tool'] as const)(
  'verifies normalized tool metadata through its authoritative message block: %s', async kind => {
    const { ops, card, source } = await verificationFixture();
    const toolResult = { ...observed(card), blockId: 'real-tool-block', input: null, output: null };
    const block = { id: 'real-tool-block', messageId: 'verification-result', type: 'workbench_ops',
      status: kind === 'failed-block' ? 'error' : 'success', toolName: kind === 'wrong-tool' ? 'dstu_plugin_api_read' : 'workbench_observe',
      toolInput: { windowId: 'candidate-window' }, toolOutput: observed(card).output,
    };
    const chat = { createSession: vi.fn(), getMessageBlocks: () => [
      { type: 'content', content: passedAnswer() }, ...(kind === 'missing-block' ? [] : [block]),
    ], getMessage: () => ({ _meta: { toolResults: [toolResult] } }) } as unknown as ChatSessionService;
    const generation = new PipelineWorkshopGeneration(chat, { execute: async () => 'verification-result' } as unknown as ChatPipelineService,
      new WorkshopToolExecutor(ops, new WorkshopCatalog(() => [])));
    const result = await generation.verify(card, source, new AbortController().signal);
    expect(result.status).toBe(kind === 'success' ? 'passed' : 'blocked');
  },
);

it('extracts files and verification verdicts from successful attempt_completion blocks when content is empty', async () => {
  const { ops, card, source } = await verificationFixture();
  const genChat = {
    createSession: vi.fn(),
    getMessageBlocks: () => [
      { type: 'content', content: '' },
      {
        id: 'blk-gen-complete',
        messageId: 'gen-msg',
        type: 'mcp_tool',
        status: 'success',
        toolName: 'builtin-attempt_completion',
        toolOutput: { completed: true, result: '{"files":[{"path":"from-completion.ts","content":"export const ok = true;"}]}' },
      },
    ],
    getMessage: () => ({ _meta: {} }),
  } as unknown as ChatSessionService;
  const genPipeline = { execute: vi.fn(async () => 'gen-msg') } as unknown as ChatPipelineService;
  const generator = new PipelineWorkshopGeneration(genChat, genPipeline, new WorkshopToolExecutor(ops, new WorkshopCatalog(() => [])));
  await generator.generate(card, source, new AbortController().signal);
  expect(await readFile(join(source, 'from-completion.ts'), 'utf8')).toContain('export const ok = true;');

  // Also covers wrapped toolOutput.result.result and fallback to toolInput.result.
  expect(extractAssistantAnswerText([
    { type: 'content', content: '' },
    { type: 'mcp_tool', status: 'success', toolName: 'attempt_completion', toolOutput: { result: { result: '{"status":"passed"}' } } },
  ])).toBe('{"status":"passed"}');
  expect(extractAssistantAnswerText([
    { type: 'content', content: '' },
    { type: 'mcp_tool', status: 'success', toolName: 'builtin:attempt_completion', toolOutput: null, toolInput: { result: '{"status":"failed","error":"broken"}' } },
  ])).toBe('{"status":"failed","error":"broken"}');

  const toolResult = { ...observed(card), blockId: 'obs-block', input: null, output: null };
  const obsBlock = {
    id: 'obs-block',
    messageId: 'verify-msg',
    type: 'workbench_ops',
    status: 'success',
    toolName: 'workbench_observe',
    toolInput: { windowId: 'candidate-window' },
    toolOutput: observed(card).output,
  };
  const completionBlock = {
    id: 'complete-block',
    messageId: 'verify-msg',
    type: 'mcp_tool',
    status: 'success',
    toolName: 'attempt_completion',
    toolInput: { result: passedAnswer() },
    toolOutput: { completed: true, result: passedAnswer() },
  };
  const verifyExecute = vi.fn(async () => 'verify-msg');
  const verifyChat = {
    createSession: vi.fn(),
    getMessageBlocks: () => [{ type: 'content', content: '' }, obsBlock, completionBlock],
    getMessage: () => ({ _meta: { toolResults: [toolResult] } }),
  } as unknown as ChatSessionService;
  const verifier = new PipelineWorkshopGeneration(verifyChat, { execute: verifyExecute } as unknown as ChatPipelineService,
    new WorkshopToolExecutor(ops, new WorkshopCatalog(() => [])));
  const verified = await verifier.verify(card, source, new AbortController().signal);
  expect(verified.status).toBe('passed');
  expect(verified.evidence).toHaveLength(2);
  expect(String((verifyExecute.mock.calls[0] as unknown as [unknown, { content: string }])[1].content)).toContain('attempt_completion.result');
});

it('runs a 1-shot structured-JSON recovery turn when inventory succeeded but turn 1 returned prose', async () => {
  const { ops, card, source } = await verificationFixture();
  card.places = [{ kind: 'slashCommand', command: 'formula' }];
  card.template = 'host-tool';
  const inventoryBlock = {
    id: 'inv-block',
    messageId: 'verify-turn-1',
    type: 'workbench_ops',
    status: 'success',
    toolName: 'dstu_plugin_inventory',
    toolInput: {},
    toolOutput: {
      plugins: [{ id: card.pluginId, version: card.version, enabled: true, state: 'running' }],
    },
  };
  const inventoryResult: ToolResultInfo = {
    toolCallId: 'call-inv-1',
    blockId: 'inv-block',
    toolName: 'dstu_plugin_inventory',
    success: true,
    input: null,
    output: null,
  };
  const recoveryAnswer = JSON.stringify({
    status: 'passed',
    checks: [
      { criterion: 0, observed: 'plugin running in inventory', toolCallIds: ['call-inv-1'] },
      { criterion: 1, observed: 'version 0.1.0 enabled in inventory', toolCallIds: ['call-inv-1'] },
    ],
  });
  const execute = vi.fn<ChatPipelineService['execute']>()
    .mockResolvedValueOnce('verify-turn-1')
    .mockResolvedValueOnce('verify-turn-2');
  const createSession = vi.fn();
  const chat = {
    createSession,
    getMessageBlocks: (msgId: string) => msgId === 'verify-turn-1'
      ? [{ type: 'content', content: '插件已安装并处于 running 状态，验收通过。' }, inventoryBlock]
      : [{ type: 'content', content: recoveryAnswer }],
    getMessage: (msgId: string) => msgId === 'verify-turn-1' ? { _meta: { toolResults: [inventoryResult] } } : { _meta: {} },
  } as unknown as ChatSessionService;
  const generation = new PipelineWorkshopGeneration(chat, { execute } as unknown as ChatPipelineService,
    new WorkshopToolExecutor(ops, new WorkshopCatalog(() => [])));

  const result = await generation.verify(card, source, new AbortController().signal);
  expect(result.status).toBe('passed');
  expect(result.evidence).toHaveLength(2);
  expect(createSession).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenCalledTimes(2);
  const firstReq = execute.mock.calls[0]?.[1];
  const recoveryReq = execute.mock.calls[1]?.[1];
  expect(firstReq?.options.schemaToolIds).toEqual(['dstu_plugin_inventory']);
  expect(firstReq?.options.executionAllowedTools).toEqual(['dstu_plugin_inventory']);
  expect(recoveryReq?.sessionId).toBe(firstReq?.sessionId);
  expect(recoveryReq?.options).toMatchObject({
    schemaToolIds: [],
    executionAllowedTools: [],
    activeSkillIds: [],
    memoryEnabled: false,
    ragEnabled: false,
    webSearchEnabled: false,
  });

  // Also recovers when turn 1 returned incomplete checks after verified inventory.
  const incompleteExecute = vi.fn<ChatPipelineService['execute']>()
    .mockResolvedValueOnce('verify-turn-1')
    .mockResolvedValueOnce('verify-turn-2');
  const incompleteAnswer = JSON.stringify({
    status: 'passed',
    checks: [{ criterion: 0, observed: 'only criterion 0', toolCallIds: ['call-inv-1'] }],
  });
  const incompleteChat = {
    createSession: vi.fn(),
    getMessageBlocks: (msgId: string) => msgId === 'verify-turn-1'
      ? [{ type: 'content', content: incompleteAnswer }, inventoryBlock]
      : [{ type: 'content', content: recoveryAnswer }],
    getMessage: (msgId: string) => msgId === 'verify-turn-1' ? { _meta: { toolResults: [inventoryResult] } } : { _meta: {} },
  } as unknown as ChatSessionService;
  const incompleteGen = new PipelineWorkshopGeneration(incompleteChat, { execute: incompleteExecute } as unknown as ChatPipelineService,
    new WorkshopToolExecutor(ops, new WorkshopCatalog(() => [])));
  const incompleteRecovered = await incompleteGen.verify(card, source, new AbortController().signal);
  expect(incompleteRecovered.status).toBe('passed');
  expect(incompleteExecute).toHaveBeenCalledTimes(2);
  expect(String(incompleteExecute.mock.calls[1]?.[1]?.content)).toContain('WORKSHOP_VERIFICATION_INCOMPLETE');

  // Does not loop past 1 recovery turn when recovery also fails to return JSON.
  const failingExecute = vi.fn<ChatPipelineService['execute']>()
    .mockResolvedValueOnce('verify-turn-1')
    .mockResolvedValueOnce('verify-turn-bad');
  const failingChat = {
    createSession: vi.fn(),
    getMessageBlocks: (msgId: string) => msgId === 'verify-turn-1'
      ? [{ type: 'content', content: 'prose only' }, inventoryBlock]
      : [{ type: 'content', content: 'still not json' }],
    getMessage: (msgId: string) => msgId === 'verify-turn-1' ? { _meta: { toolResults: [inventoryResult] } } : { _meta: {} },
  } as unknown as ChatSessionService;
  const failingGen = new PipelineWorkshopGeneration(failingChat, { execute: failingExecute } as unknown as ChatPipelineService,
    new WorkshopToolExecutor(ops, new WorkshopCatalog(() => [])));
  const blocked = await failingGen.verify(card, source, new AbortController().signal);
  expect(blocked.status).toBe('blocked');
  expect(blocked.error).toContain('WORKSHOP_VERIFICATION_INVALID');
  expect(failingExecute).toHaveBeenCalledTimes(2);
});
