/** V01-02: the Super inbox delivery chain under the official desktop profile — `chat.send@1` (chat-pipeline) feeds
 * `chat_v2_super_deliver_inbox` (inbox.rs:900-973 → send_message.rs `run_send_message_pipeline_owned`).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { CapabilityAcl } from '../../../kernel/acl.ts';
import { loadStartupProfile, OFFICIAL_PROFILE_PATH } from '../../../kernel/profile.ts';
import { PluginAdmin } from '../../../kernel/plugin-admin.ts';
import { UserProfileStore } from '../../../kernel/profile-store.ts';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';

let root = '';
let host: TestHost;
let session = '';
let workspace = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dstu-super-inbox-profile-'));
  vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
  vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'));
  vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
  host = await createTestHost({ app: { dataDir: join(root, 'app'), platform: 'linux' }, acl: CapabilityAcl.fromDirectory('linux') });
  new PluginAdmin({ runtime: host.runtime, official: OFFICIAL_PROFILE_PATH,
    store: new UserProfileStore(join(host.app.dataDir, 'plugins/user.profile.json'), OFFICIAL_PROFILE_PATH) }).register();
  const loaded = await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH });
  expect(loaded.degraded).toEqual([]);
  host.ctx.settings.save('super_agent.enabled', 'true');
  const state = await host.invoke<{ enabled: boolean; sessionId: string; workspaceId: string }>('super_session_ensure');
  expect(state.enabled).toBe(true);
  session = state.sessionId;
  workspace = state.workspaceId;
}, 120_000);
afterAll(async () => {
  await host?.dispose();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

it('super inbox delivery is registered under the desktop profile', async () => {
  expect(host.ctx.get('chat.send@1')).toBeDefined();
  expect(typeof host.ctx.agentSubagent.deliverInbox).toBe('function');
  const outcome = await host.invoke('chat_v2_super_deliver_inbox', { request: { sessionId: session,
    userMessageId: 'u1', assistantMessageId: 'a1', options: {}, force: false } });
  expect(outcome).toMatchObject({ status: 'empty' }); // 收件箱为空时
  expect(host.ctx.chatState.hasActiveStream(session)).toBe(false);
});

it('a worker result is delivered as a Super turn: the real pipeline saves the user message and streams the reply', async () => {
  const requests: { body: { messages?: { role: string; content: unknown }[] }; userSaved: boolean }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      userSaved: host.ctx.chatSession.getMessage('msg_super_u2') !== null });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end([
      { choices: [{ index: 0, delta: { role: 'assistant', content: '已收到 12 道错题的整理结果。' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } },
    ].map(frame => `data: ${JSON.stringify({ id: 'chatcmpl-super', object: 'chat.completion.chunk', ...frame })}\n\n`).join('')
      + 'data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const logs: string[] = [];
  host.ctx.logger.exporter({ levels: { default: 4 }, export(message) { logs.push(String(message.args[0])); } });
  try {
    await host.ctx.llm.saveApiConfigurations([{ id: 'super-local-config', name: 'Super offline answer', apiKey: '', authMode: 'none',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, model: 'super-local-model',
      apiProtocol: 'openai_chat_completions', modelAdapter: 'general', enabled: true, supportsTools: false, isMultimodal: false,
      isReasoning: false, isEmbedding: false, isReranker: false, contextWindow: 32768, maxOutputTokens: 128 }]);
    await host.ctx.llm.saveModelAssignments({ model2_config_id: 'super-local-config' });

    const coordinator = host.ctx.agentWorkspace;
    coordinator.registerAgent(workspace, 'sess_worker_profile', 'worker', null,
      { super_agent: { title: '整理错题', dispatched_in_message_id: 'msg_dispatch' } });
    coordinator.updateAgentStatus(workspace, 'sess_worker_profile', 'running');
    coordinator.sendMessage(workspace, 'sess_worker_profile', session, 'result', JSON.stringify({
      type: 'agent_completion', workspace_id: workspace, agent_session_id: 'sess_worker_profile', parent_session_id: session,
      task_id: 'task_profile', run_id: 'run_profile', status: 'completed', final_output: '共 12 道错题',
      error: null, completed_at: '2026-11-07T00:00:00Z' }));
    expect(coordinator.pendingInboxCount(workspace, session)).toBe(1);

    const outcome = await host.invoke<{ status: string; userMessage: { id: string; content: string } }>(
      'chat_v2_super_deliver_inbox', { request: { sessionId: session, userMessageId: 'msg_super_u2',
        assistantMessageId: 'msg_super_a2', options: {}, force: false } });
    expect(outcome).toMatchObject({ status: 'started', assistantMessageId: 'msg_super_a2',
      userMessage: { id: 'msg_super_u2', inboundOrigin: { kind: 'super_inbox' } } });
    expect(outcome.userMessage.content).toContain('共 12 道错题');
    expect(coordinator.pendingInboxCount(workspace, session)).toBe(0);

    await vi.waitFor(() => { expect(host.ctx.chatState.trackedTaskCount(), logs.join('\n')).toBe(0); }, { timeout: 15_000 });
    expect(host.ctx.chatState.hasActiveStream(session)).toBe(false);
    expect(requests, logs.join('\n')).toHaveLength(1);
    expect(requests[0]!.userSaved).toBe(true);
    expect(JSON.stringify(requests[0]!.body.messages)).toContain('共 12 道错题');
    expect(host.ctx.chatSession.getMessage('msg_super_u2')).toMatchObject({ sessionId: session, role: 'user',
      _meta: { inboundOrigin: { kind: 'super_inbox' } } });
    expect(host.ctx.chatSession.getMessage('msg_super_a2'), logs.join('\n')).toMatchObject({ sessionId: session, role: 'assistant' });
    // The owned registration was released at turn end, so the next delivery is not refused as busy.
    await expect(host.invoke('chat_v2_super_deliver_inbox', { request: { sessionId: session,
      userMessageId: 'u3', assistantMessageId: 'a3', options: {}, force: false } })).resolves.toMatchObject({ status: 'empty' });
  } finally {
    server.close();
  }
});
