/**
 * WP-146: the official profile registers exactly one SkillWorkshopExecutor and
 * L04 `registry.execute` + `chat.createExecutionContext` reach the WP-030
 * persisted-JSON decoders (`skill_workshop_executor.rs:1263-1342`, roster.rs:72).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { loadStartupProfile, OFFICIAL_PROFILE_PATH } from '../../../kernel/profile.ts';
import { PluginAdmin } from '../../../kernel/plugin-admin.ts';
import { UserProfileStore } from '../../../kernel/profile-store.ts';
import { MissingExecutorError } from '../../../kernel/api.ts';
import { BackendEventsSink, ChatV2Emitter, type BackendEvent, type ChatExecutionContext } from '../../chat/api.ts';
import { AGENT_INSTALLED_MARKER } from '../src/tools/skill-install-executor.ts';
import { SKILL_FILE_NAME } from '../src/tools/skill-workshop-package.ts';
import { PROPOSAL_META_FILE, PROPOSALS_SUBDIR } from '../src/tools/skill-workshop-proposals.ts';
import { SkillWorkshopToolExecutor } from '../src/tools/skill-workshop-tool-executor.ts';

const SKILL_TEXT = '---\nname: demo\n---\nbody';
const U64_MAX = '18446744073709551615';
const policy = { ignoresBroadApprovalBypassForArgs: () => false, neverRememberApprovalForArgs: () => false };

it('WP-146 official profile: one SkillWorkshopExecutor executes propose/list/reject/apply through L04 registry', async () => {
  const base = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp/opencode', 'l07-workshop-wiring-'));
  const home = path.join(base, 'home');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('XDG_DATA_HOME', path.join(base, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(base, 'config'));
  vi.stubEnv('XDG_CACHE_HOME', path.join(base, 'cache'));
  vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
  const host = await createTestHost({ app: { dataDir: path.join(base, 'app'), debug: true } });
  try {
    new PluginAdmin({ runtime: host.runtime, official: OFFICIAL_PROFILE_PATH,
      store: new UserProfileStore(path.join(host.app.dataDir, 'plugins/user.profile.json'), OFFICIAL_PROFILE_PATH) }).register();
    const loaded = await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH });
    expect(loaded.degraded).toEqual([]);
    expect(loaded.installed.map(entry => entry.id)).toEqual(expect.arrayContaining(['dstu.agent-skills', 'dstu.chat']));

    // Real Host roster: exactly one workshop contribution, builtin routing as in Rust.
    const contributions = host.ctx.agentTools.toolExecutors().filter(executor => executor.name() === 'SkillWorkshopExecutor');
    expect(contributions).toHaveLength(1);
    const contribution = contributions[0];
    if (!(contribution instanceof SkillWorkshopToolExecutor)) throw new Error('expected the production workshop contribution');
    for (const name of ['skill_workshop_propose', 'builtin-skill_workshop_propose', 'mcp_skill_workshop_apply']) {
      expect(contribution.canHandle(name)).toBe(true);
    }
    expect(contribution.canHandle('skill_install')).toBe(false);
    expect(contribution.sensitivityLevel('builtin-skill_workshop_propose')).toBe('medium');
    expect(contribution.sensitivityLevel('builtin-skill_workshop_apply')).toBe('high');
    try { host.ctx.chatSession.assembleExecutorRegistry([], policy, false); }
    catch (error) {
      if (!(error instanceof MissingExecutorError)) throw error;
      expect(error.names).not.toContain('SkillWorkshopExecutor');
    }

    const chat = host.ctx.chatSession;
    const registry = chat.createExecutorRegistry([contribution], policy);
    expect(registry.getExecutor('builtin-skill_workshop_apply')).toBe(contribution);
    expect(registry.getSensitivity('builtin-skill_workshop_apply')).toBe('high');
    expect(registry.getConcurrencyClass('skill_workshop_propose')).toBe('serial');
    const stamp = '2026-11-06T00:00:00Z';
    chat.createSession({ id: 'sess_wp146', mode: 'chat', titleLocked: false, persistStatus: 'active', createdAt: stamp, updatedAt: stamp });
    host.window({ window: 'main', webview: 'main' }, 'created');
    const emitter = ChatV2Emitter.withSinkAndBatching(new BackendEventsSink(host.ctx.backendEvents), 'sess_wp146', false);
    const mainDb = host.ctx.storage.database('mistakes');
    let sequence = 0;
    const context = (options: { window?: boolean; mainDb?: boolean } = {}): ChatExecutionContext => {
      const id = ++sequence;
      const value = chat.createExecutionContext({ sessionId: 'sess_wp146', messageId: `msg_wp146_${id}`, blockId: `blk_wp146_${id}`,
        emitter, services: host.ctx, window: options.window === false ? null : { window: 'main', webview: 'main' },
        toolRegistry: host.ctx.mcp.registry });
      value.chat_v2_db = chat.database;
      if (options.mainDb !== false) value.main_db = mainDb;
      return value;
    };
    const blockEvents = (blockId: string) => (host.eventsNamed('chat_v2_event_sess_wp146') as BackendEvent[])
      .filter(event => event.blockId === blockId);
    const persistedOutput = (blockId: string) => chat.database.getConnSafe()
      .get<{ tool_output_json: string | null }>('SELECT tool_output_json FROM chat_v2_blocks WHERE id = ?1', [blockId])?.tool_output_json;
    const proposalsRoot = path.join(host.ctx.paths.appDataDir, PROPOSALS_SUBDIR);
    const skillsBase = path.join(home, '.deep-student', 'skills');
    const warnings: string[] = [];
    host.ctx.logger.exporter({ levels: { default: 4 }, export(event) {
      if (event.type === 'warn') warnings.push(String(event.args[0]));
    } });

    // propose_create → rewrite PROPOSAL.json in WP-030 sequence form with u64::MAX.
    const createCtx = context();
    const created = await registry.execute({ id: 'create', name: 'builtin-skill_workshop_propose',
      arguments: { action: 'propose_create', skill_id: 'demo', content: SKILL_TEXT } }, createCtx);
    expect(created).toMatchObject({ success: true, toolCallId: 'create', blockId: createCtx.block_id,
      toolName: 'builtin-skill_workshop_propose', output: { action: 'propose_create', status: 'pending', package_version: 1 } });
    expect(created).not.toHaveProperty('error');
    expect(Number.isInteger(created.durationMs)).toBe(true);
    expect(created.durationMs).toBeGreaterThanOrEqual(0);
    expect(blockEvents(createCtx.block_id)).toMatchObject([
      { type: 'tool_call', phase: 'start', payload: { toolName: 'builtin-skill_workshop_propose', toolCallId: 'create' } },
      { type: 'tool_call', phase: 'end', result: { result: { proposal_id: (created.output as { proposal_id: string }).proposal_id }, durationMs: created.durationMs } },
    ]);
    expect(chat.getBlock(createCtx.block_id)).toMatchObject({ status: 'success', toolName: 'builtin-skill_workshop_propose' });
    const proposal = created.output as Record<string, string>;
    const dir = path.join(proposalsRoot, proposal.proposal_id!);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, PROPOSAL_META_FILE), 'utf8')) as Record<string, unknown>;
    const files = (meta.files as { path: string; sha256: string; size: number }[]).map(file => [file.path, file.sha256, file.size]);
    const head = JSON.stringify([meta.proposalId, meta.action, meta.skillId, meta.contentSha256, meta.createdAt, meta.sessionId,
      meta.status, null, meta.packageSha256, files, null, []]);
    fs.writeFileSync(path.join(dir, PROPOSAL_META_FILE), `${head.slice(0, -1)},${U64_MAX}]`);

    const listCtx = context();
    const listed = await registry.execute({ id: 'list', name: 'skill_workshop_propose', arguments: { action: 'list' } }, listCtx);
    expect(listed).toMatchObject({ success: true, output: { count: 1, pending: [{ proposal_id: proposal.proposal_id, files: [{ path: SKILL_FILE_NAME, size: SKILL_TEXT.length }] }] } });
    expect(persistedOutput(listCtx.block_id)).toContain(`"package_version":${U64_MAX}`);
    // Kernel wire: exact digits in payloadJson; `payload` is the frontend JSON.parse projection.
    const listEnd = host.events.find(event => event.event === 'chat_v2_event_sess_wp146'
      && (event.payload as BackendEvent).blockId === listCtx.block_id && (event.payload as BackendEvent).phase === 'end');
    expect(listEnd?.payloadJson).toContain(`"package_version":${U64_MAX}`);
    const revision = (listed.output as { pending: { proposal_revision: string }[] }).pending[0]!.proposal_revision;
    expect(revision).not.toBe(proposal.proposal_revision);

    const applyCtx = context();
    const applied = await registry.execute({ id: 'apply', name: 'builtin-skill_workshop_apply', arguments: {
      proposal_id: proposal.proposal_id, skill_id: 'demo', expected_content_sha256: proposal.content_sha256,
      expected_proposal_revision: revision } }, applyCtx);
    expect(applied).toMatchObject({ success: true, output: { applied: true, skill_id: 'demo', trust_status: 'untrusted' } });
    expect(JSON.stringify(applied.output)).toContain(`"package_version":${U64_MAX}`);
    expect(persistedOutput(applyCtx.block_id)).toContain(`"package_version":${U64_MAX}`);
    expect(fs.readFileSync(path.join(skillsBase, 'demo', SKILL_FILE_NAME), 'utf8')).toBe(SKILL_TEXT);
    expect(fs.readFileSync(path.join(skillsBase, 'demo', AGENT_INSTALLED_MARKER), 'utf8')).toContain(`"packageVersion": ${U64_MAX}`);
    expect(JSON.parse(fs.readFileSync(path.join(dir, PROPOSAL_META_FILE), 'utf8'))).toMatchObject({ status: 'applied' });
    expect(host.ctx.settings.getWithConn(mainDb, 'skill.provenance.demo')).toContain(`"packageVersion": ${U64_MAX}`);

    // Marker decode on propose_update: sequence form saturates u64::MAX → stays u64::MAX.
    fs.writeFileSync(path.join(skillsBase, 'demo', AGENT_INSTALLED_MARKER),
      `["agent_workshop","${proposal.proposal_id}","c","p",${U64_MAX},[["SKILL.md","h",1]],null,"t","sess"]`);
    const updateCtx = context();
    const updated = await registry.execute({ id: 'update', name: 'skill_workshop_propose',
      arguments: { action: 'propose_update', skill_id: 'demo', content: SKILL_TEXT } }, updateCtx);
    expect(updated).toMatchObject({ success: true, output: { action: 'propose_update', status: 'pending' } });
    expect(persistedOutput(updateCtx.block_id)).toContain(`"package_version":${U64_MAX}`);

    // Unknown field via IgnoredAny (deep nesting, lone surrogate) on reject; status rewrite persists.
    const updatedDir = path.join(proposalsRoot, (updated.output as { proposal_id: string }).proposal_id);
    const updatedText = fs.readFileSync(path.join(updatedDir, PROPOSAL_META_FILE), 'utf8');
    fs.writeFileSync(path.join(updatedDir, PROPOSAL_META_FILE),
      `${updatedText.trimEnd().slice(0, -1)},"extra":[${'['.repeat(200)}${']'.repeat(200)},"\\ud800"]}`);
    const rejected = await registry.execute({ id: 'reject', name: 'skill_workshop_propose',
      arguments: { action: 'reject', proposal_id: (updated.output as { proposal_id: string }).proposal_id } }, context());
    expect(rejected).toMatchObject({ success: true, output: { status: 'rejected', skill_id: 'demo' } });
    expect(JSON.parse(fs.readFileSync(path.join(updatedDir, PROPOSAL_META_FILE), 'utf8'))).toMatchObject({ status: 'rejected' });

    // Decode failure reaches ToolResultInfo.failure, error event and error block.
    fs.writeFileSync(path.join(dir, PROPOSAL_META_FILE), '[]');
    const badCtx = context();
    const bad = await registry.execute({ id: 'bad', name: 'skill_workshop_propose',
      arguments: { action: 'reject', proposal_id: proposal.proposal_id } }, badCtx);
    expect(bad).toMatchObject({ success: false, output: null, toolCallId: 'bad', blockId: badCtx.block_id,
      error: 'Invalid PROPOSAL.json: invalid length 0, expected struct ProposalMeta with 13 elements at line 1 column 2' });
    expect(blockEvents(badCtx.block_id)).toMatchObject([{ phase: 'start' }, { phase: 'error', error: bad.error }]);
    expect(chat.getBlock(badCtx.block_id)).toMatchObject({ status: 'error', error: bad.error });

    // Windowless: Rust window_ref() panics after the start event; no error event, no block.
    const windowless = context({ window: false });
    await expect(registry.execute({ id: 'windowless', name: 'skill_workshop_propose', arguments: { action: 'list' } }, windowless))
      .rejects.toThrow('ExecutionContext.window_ref() called without a Tauri window');
    expect(blockEvents(windowless.block_id)).toMatchObject([{ phase: 'start' }]);
    expect(chat.getBlock(windowless.block_id)).toBeNull();
    // Argument errors precede proposals_root and stay ordinary failures without a window.
    const noAction = context({ window: false });
    expect(await registry.execute({ id: 'no-action', name: 'skill_workshop_propose', arguments: {} }, noAction))
      .toMatchObject({ success: false, error: 'action is required (propose_create | propose_update | list | reject)' });

    // main_db None: Rust warn, apply still succeeds with marker-only provenance.
    const second = await registry.execute({ id: 'create-2', name: 'skill_workshop_propose',
      arguments: { action: 'propose_create', skill_id: 'second', content: SKILL_TEXT.replace('demo', 'second') } }, context());
    const secondProposal = second.output as Record<string, string>;
    expect(await registry.execute({ id: 'apply-2', name: 'skill_workshop_apply', arguments: {
      proposal_id: secondProposal.proposal_id, skill_id: 'second', expected_content_sha256: secondProposal.content_sha256,
      expected_proposal_revision: secondProposal.proposal_revision } }, context({ mainDb: false })))
      .toMatchObject({ success: true, output: { applied: true, skill_id: 'second' } });
    expect(warnings).toContain("[SkillWorkshopExecutor] main_db unavailable; provenance for 'second' written only to marker file");
    expect(host.ctx.settings.getWithConn(mainDb, 'skill.provenance.second')).toBeNull();

    // save_tool_block failure is a warn; the result is still returned.
    const unsaved = context();
    const getConnSafe = vi.spyOn(chat.database, 'getConnSafe').mockImplementation(() => { throw new Error('chat db locked'); });
    const unsavedResult = await registry.execute({ id: 'unsaved', name: 'skill_workshop_propose', arguments: { action: 'list' } }, unsaved);
    getConnSafe.mockRestore();
    expect(unsavedResult).toMatchObject({ success: true, output: { count: 0 } });
    expect(warnings).toContain('[SkillWorkshopExecutor] Failed to save tool block: chat db locked');
    expect(chat.getBlock(unsaved.block_id)).toBeNull();
  } finally {
    vi.restoreAllMocks();
    try { await host.dispose(); }
    finally { vi.unstubAllEnvs(); fs.rmSync(base, { recursive: true, force: true }); }
  }
}, 240_000);
