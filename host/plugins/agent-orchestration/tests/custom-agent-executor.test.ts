/**
 * custom_agent_executor.rs:1005–1099 via the production chain:
 * official profile → L06 `agentTools.registerToolExecutors` → L04 `createExecutorRegistry` → `registry.execute`.
 * No CustomAgentStore is constructed here; directories come from the real L05 coordinator.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { loadStartupProfile, OFFICIAL_PROFILE_PATH } from '../../../kernel/profile.ts';
import { PluginAdmin } from '../../../kernel/plugin-admin.ts';
import { UserProfileStore } from '../../../kernel/profile-store.ts';
import { BackendEventsSink, ChatV2Emitter, type BackendEvent, type ChatExecutionContext } from '../../chat/api.ts';
import { ignoresBroadApprovalBypassForArgs, neverRememberApprovalForArgs } from '../../agent-workspace/api.ts';
import { CustomAgentExecutor, lockCustomAgentFiles } from '../api.ts';
import { sha256Hex } from '../src/custom-agent.ts';
import { setLocalNodeRuntime } from '../src/local-node-runtime.ts';
import { nodeLocalNodeRuntime } from '../src/local-node-runtime.node.ts';

type ToolExecutorRegistry = ReturnType<TestHost['ctx']['chatSession']['createExecutorRegistry']>;

// 人设提议走同步端口；夹具直接装同一份 `node:fs` 实现（桌面入口注入）。
beforeAll(() => { setLocalNodeRuntime(nodeLocalNodeRuntime); });
afterAll(() => { setLocalNodeRuntime(null); });

const SESSION = 'sess_custom_agent_wp155';
const VALID_PERSONA = '---\nname: paper-summarizer\ndescription: 论文摘要\nbase: explorer\n---\n# 论文摘要员\n正文。\n';
const MODEL_PERSONA = '---\nname: model-agent\nmodel: local-chat\n---\n# 模型\n';

let base: string;
let host: TestHost;
let registry: ToolExecutorRegistry;
let agentsDir: string;
let pendingDir: string;
let sequence = 0;

function context(llm: ChatExecutionContext['llm_manager'] = null): ChatExecutionContext {
  const id = ++sequence;
  const chat = host.ctx.chatSession;
  const value = chat.createExecutionContext({ sessionId: SESSION, messageId: `msg_ca_${id}`, blockId: `blk_ca_${id}`,
    emitter: ChatV2Emitter.withSinkAndBatching(new BackendEventsSink(host.ctx.backendEvents), SESSION, false),
    services: host.ctx, toolRegistry: host.ctx.mcp.registry });
  value.chat_v2_db = chat.database;
  value.llm_manager = llm;
  return value;
}

function blockEvents(blockId: string): BackendEvent[] {
  return (host.eventsNamed(`chat_v2_event_${SESSION}`) as BackendEvent[]).filter(event => event.blockId === blockId);
}

async function run(name: string, args: unknown, ctx = context()) {
  const result = await registry.execute({ id: `call_${sequence}`, name, arguments: args }, ctx);
  return { result, ctx, output: result.output as Record<string, unknown> };
}

async function propose(content: string, fileName: string) {
  const { output } = await run('builtin-custom_agent_propose', { file_name: fileName, content });
  return output;
}

function applyArgs(proposal: Record<string, unknown>) {
  return { proposal_id: proposal.proposal_id, file_name: proposal.file_name,
    expected_content_sha256: proposal.content_sha256, expected_proposal_revision: proposal.proposal_revision };
}

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp/opencode', 'l06-custom-agent-'));
  vi.stubEnv('XDG_DATA_HOME', path.join(base, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(base, 'config'));
  vi.stubEnv('XDG_CACHE_HOME', path.join(base, 'cache'));
  vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
  host = await createTestHost({ app: { dataDir: path.join(base, 'app'), debug: true } });
  new PluginAdmin({ runtime: host.runtime, official: OFFICIAL_PROFILE_PATH,
    store: new UserProfileStore(path.join(host.app.dataDir, 'plugins/user.profile.json'), OFFICIAL_PROFILE_PATH) }).register();
  const loaded = await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH });
  expect(loaded.degraded).toEqual([]);
  const contributed = host.ctx.agentTools.toolExecutors().filter(executor => executor.name() === 'CustomAgentExecutor');
  expect(contributed).toHaveLength(1);
  if (!(contributed[0] instanceof CustomAgentExecutor)) throw new Error('expected the production CustomAgentExecutor');
  registry = host.ctx.chatSession.createExecutorRegistry([contributed[0]],
    { ignoresBroadApprovalBypassForArgs, neverRememberApprovalForArgs });
  agentsDir = host.ctx.agentWorkspace.customAgentsDir();
  pendingDir = host.ctx.agentWorkspace.customAgentsPendingDir();
  const stamp = '2026-11-06T00:00:00Z';
  host.ctx.chatSession.createSession({ id: SESSION, mode: 'chat', titleLocked: false, persistStatus: 'active',
    createdAt: stamp, updatedAt: stamp });
}, 120_000);

afterAll(async () => {
  try { await host?.dispose(); }
  finally { vi.unstubAllEnvs(); fs.rmSync(base, { recursive: true, force: true }); }
});

describe('CustomAgentExecutor registered production chain (custom_agent_executor.rs:1005-1099)', () => {
  it('sensitivity_mapping_matches_governance_contract through the L04 registry, with apply/remove never-remember', () => {
    expect(registry.getSensitivity('builtin-custom_agent_list')).toBe('low');
    expect(registry.getSensitivity('builtin-custom_agent_get')).toBe('low');
    expect(registry.getSensitivity('builtin-custom_agent_propose')).toBe('medium');
    for (const name of ['builtin-custom_agent_apply', 'custom_agent_remove']) {
      expect(registry.describeRiskForCall(name, {})).toMatchObject({ baseSensitivity: 'high', neverRemember: true });
    }
    expect(registry.getExecutor('subagent_call')).toBeNull();
    expect(registry.getConcurrencyClass('custom_agent_list')).toBe('serial');
  });

  it('propose → list → apply → get → remove writes coordinator files, emits start/end and persists tool blocks', async () => {
    const proposed = await run('builtin-custom_agent_propose', { file_name: 'paper-summarizer.md', content: VALID_PERSONA });
    expect(proposed.result).toMatchObject({ success: true, toolCallId: expect.any(String), blockId: proposed.ctx.block_id,
      toolName: 'builtin-custom_agent_propose' });
    expect(Object.keys(proposed.output)).toEqual(['proposal_id', 'action', 'file_name', 'agent_name', 'description',
      'content_sha256', 'proposal_revision', 'previous_sha256', 'previous_bytes', 'new_bytes', 'previous_heading',
      'new_heading', 'change_summary', 'status', 'next_step']);
    expect(proposed.output).toMatchObject({ action: 'create', agent_name: 'paper-summarizer', description: '论文摘要',
      content_sha256: sha256Hex(VALID_PERSONA), previous_sha256: null, new_bytes: Buffer.byteLength(VALID_PERSONA),
      new_heading: '# 论文摘要员', status: 'pending',
      change_summary: `新建 paper-summarizer.md：${Buffer.byteLength(VALID_PERSONA)} 字节；标题 # 论文摘要员` });
    const proposalDir = path.join(pendingDir, proposed.output.proposal_id as string);
    expect(fs.readFileSync(path.join(proposalDir, 'persona.md'), 'utf8')).toBe(VALID_PERSONA);
    expect(JSON.parse(fs.readFileSync(path.join(proposalDir, 'PROPOSAL.json'), 'utf8'))).toMatchObject({ sessionId: SESSION, status: 'pending' });
    expect(blockEvents(proposed.ctx.block_id)).toMatchObject([
      { phase: 'start', payload: { toolName: 'builtin-custom_agent_propose', toolCallId: proposed.result.toolCallId } },
      { phase: 'end', result: { result: proposed.output, durationMs: proposed.result.durationMs } },
    ]);
    expect(host.ctx.chatSession.getBlock(proposed.ctx.block_id)).toMatchObject({ status: 'success', toolOutput: proposed.output });

    const listed = await run('custom_agent_propose', { action: 'list' });
    expect(listed.output).toMatchObject({ count: 1, pending: [{ proposal_id: proposed.output.proposal_id,
      proposal_revision: proposed.output.proposal_revision }] });

    const applied = await run('builtin-custom_agent_apply', applyArgs(proposed.output));
    expect(applied.output).toMatchObject({ applied: true, action: 'create', path: 'workspaces/agents/paper-summarizer.md' });
    expect(applied.output).not.toHaveProperty('warnings');
    expect(fs.readFileSync(path.join(agentsDir, 'paper-summarizer.md'), 'utf8')).toBe(VALID_PERSONA);

    const got = await run('custom_agent_get', { fileName: 'paper-summarizer.md' });
    expect(got.output).toEqual({ file_name: 'paper-summarizer.md', bytes: Buffer.byteLength(VALID_PERSONA),
      content_sha256: sha256Hex(VALID_PERSONA), frontmatter: { name: 'paper-summarizer', description: '论文摘要', base: 'explorer' },
      first_heading: '# 论文摘要员', content: VALID_PERSONA });
    const all = await run('custom_agent_list', {});
    expect(all.output).toMatchObject({ agents_dir: agentsDir, count: 1, personas: [{ file_name: 'paper-summarizer.md',
      bytes: Buffer.byteLength(VALID_PERSONA), modified_at: expect.stringMatching(/\+00:00$/) }] });

    const replay = await run('builtin-custom_agent_apply', applyArgs(proposed.output));
    expect(replay.result).toMatchObject({ success: false, output: null });
    expect(replay.result.error).toContain('status is \'applied\'');

    const removed = await run('builtin-custom_agent_remove', { file_name: 'paper-summarizer.md',
      expected_content_sha256: sha256Hex(VALID_PERSONA) });
    expect(removed.output).toMatchObject({ removed: true, first_heading: '# 论文摘要员' });
    expect(fs.existsSync(path.join(agentsDir, 'paper-summarizer.md'))).toBe(false);
  });

  it('X6-UD-0002 IgnoredAny: unknown 1e400 in PROPOSAL.json is ignored on the registered apply path', async () => {
    const proposal = await propose('---\nname: ignored-any\n---\n# A\n', 'ignored-any.md');
    const meta = path.join(pendingDir, proposal.proposal_id as string, 'PROPOSAL.json');
    fs.writeFileSync(meta, fs.readFileSync(meta, 'utf8').trimEnd().slice(0, -1) + ',"extra":1e400}');
    const applied = await run('builtin-custom_agent_apply', applyArgs(proposal));
    expect(applied.result.success).toBe(true);
    expect(fs.readFileSync(path.join(agentsDir, 'ignored-any.md'), 'utf8')).toBe('---\nname: ignored-any\n---\n# A\n');
  });

  it('X6-UD-0002 endArray: excess positional PROPOSAL.json field fails visibly and writes nothing', async () => {
    const proposal = await propose('---\nname: positional\n---\n# P\n', 'positional.md');
    const meta = path.join(pendingDir, proposal.proposal_id as string, 'PROPOSAL.json');
    const m = JSON.parse(fs.readFileSync(meta, 'utf8')) as Record<string, string>;
    const raw = JSON.stringify([m.proposalId, m.action, m.fileName, m.agentName, m.contentSha256,
      null, m.createdAt, m.sessionId, m.status]).slice(0, -1) + ', "extra"]';
    fs.writeFileSync(meta, raw);
    const column = Buffer.byteLength(raw.slice(0, raw.lastIndexOf('"extra"'))) + 1;
    const failed = await run('builtin-custom_agent_apply', applyArgs(proposal));
    const error = `Invalid PROPOSAL.json: trailing characters at line 1 column ${column}`;
    expect(failed.result).toMatchObject({ success: false, output: null, error });
    expect(blockEvents(failed.ctx.block_id)).toMatchObject([{ phase: 'start' }, { phase: 'error', error }]);
    expect(host.ctx.chatSession.getBlock(failed.ctx.block_id)).toMatchObject({ status: 'error', error });
    expect(fs.existsSync(path.join(agentsDir, 'positional.md'))).toBe(false);
    expect(fs.readFileSync(meta, 'utf8')).toBe(raw);
  });

  it('model validation: propose rejects an unknown model before staging; apply warns when the catalog is unavailable', async () => {
    const before = fs.readdirSync(pendingDir).length;
    const llm = { getApiConfigs: async () => [{ id: 'other', enabled: true }] } as unknown as ChatExecutionContext['llm_manager'];
    const rejected = await run('custom_agent_propose', { file_name: 'model-agent.md', content: MODEL_PERSONA }, context(llm));
    expect(rejected.result.error).toBe("PERSONA_MODEL_NOT_FOUND: model configuration id 'local-chat' does not exist");
    expect(fs.readdirSync(pendingDir)).toHaveLength(before);

    const proposal = await propose(MODEL_PERSONA, 'model-agent.md');
    expect(proposal.warnings).toMatchObject([{ code: 'PERSONA_MODEL_CATALOG_UNAVAILABLE', model_id: 'local-chat' }]);
    const failing = { getApiConfigs: async () => { throw new Error('catalog offline'); } } as unknown as ChatExecutionContext['llm_manager'];
    const applied = await run('custom_agent_apply', applyArgs(proposal), context(failing));
    expect(applied.output.warnings).toEqual([{ code: 'PERSONA_MODEL_CATALOG_UNAVAILABLE', model_id: 'local-chat',
      message: 'Failed to read the model catalog: catalog offline. Runtime will require the exact model configuration and will not fall back.' }]);
    expect(fs.existsSync(path.join(agentsDir, 'model-agent.md'))).toBe(true);
  });

  it('apply keeps Rust warning order when the applied marker cannot be written (warning, then warnings)', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const proposal = await propose(MODEL_PERSONA.replace('model-agent', 'marker-agent'), 'marker-agent.md');
    const dir = path.join(pendingDir, proposal.proposal_id as string);
    fs.chmodSync(dir, 0o555);
    try {
      const applied = await run('custom_agent_apply', applyArgs(proposal));
      expect(applied.result.success).toBe(true);
      expect(Object.keys(applied.output).slice(-2)).toEqual(['warning', 'warnings']);
      expect(applied.output.warning).toMatch(/^persona was written, but marking the proposal applied failed: Failed to create temporary file: Permission denied \(os error 13\)$/);
    } finally { fs.chmodSync(dir, 0o755); }
    expect(fs.existsSync(path.join(agentsDir, 'marker-agent.md'))).toBe(true);
    const replay = await run('custom_agent_apply', applyArgs(proposal));
    expect(replay.result.error).toContain('was created after this proposal was drafted');
  });

  it('apply_rejects_target_drift_toctou under the shared file lock held by the Settings path', async () => {
    const proposal = await propose('---\nname: drift-agent\n---\n# D\n', 'drift-agent.md');
    const release = await lockCustomAgentFiles();
    const pending = run('builtin-custom_agent_apply', applyArgs(proposal));
    await new Promise(resolve => setImmediate(resolve));
    fs.writeFileSync(path.join(agentsDir, 'drift-agent.md'), '---\nname: drift-agent\n---\nManual');
    release();
    const { result } = await pending;
    expect(result.success).toBe(false);
    expect(result.error).toContain('created after this proposal');
    expect(fs.readFileSync(path.join(agentsDir, 'drift-agent.md'), 'utf8')).toBe('---\nname: drift-agent\n---\nManual');
  });

  it('a failed tool-block save is logged and does not change the returned result', async () => {
    const warn = vi.spyOn(host.ctx.logger, 'warn');
    const ctx = context();
    ctx.chat_v2_db = { getConnSafe() { throw new Error('db gone'); } } as unknown as ChatExecutionContext['chat_v2_db'];
    const { result } = await run('custom_agent_get', { file_name: 'missing-agent.md' }, ctx);
    expect(result).toMatchObject({ success: false,
      error: "Persona 'missing-agent.md' does not exist. Use custom_agent_list to see available personas." });
    expect(warn.mock.calls.map(([line]) => String(line))).toContain('[CustomAgentExecutor] Failed to save tool block: db gone');
    warn.mockRestore();
  });

  it('unsupported propose action and tool names fail through ToolResultInfo.failure', async () => {
    const bad = await run('custom_agent_propose', { action: 'delete' });
    expect(bad.result.error).toBe("Unsupported action 'delete'. Allowed: propose, list, reject");
    const reject = await run('custom_agent_propose', { action: 'reject' });
    expect(reject.result.error).toBe('proposal_id is required for reject');
  });
});
