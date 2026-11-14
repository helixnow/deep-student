import { describe, expect, it } from 'vitest';
import {
  buildSuperDispatchArgs, buildSuperMessageArgs, canHandleSuperSessionTool,
  DEFAULT_WORKER_PROFILE, mergeSuperAgentMetadata, neutralize, renderRoster,
  renderRouterSection, ROSTER_MAX_FINISHED, SUPER_TOOL_NAMES, superHistoryBlockType,
  applySuperTurn, isActiveSuperMetadata, metadataHidden, metadataWorkspaceId,
  newSuperMetadata, retireSuperMetadata, superMeta, superSessionManagesCancellation,
  superSessionSensitivityLevel, superToolSchemas, xmlAttr, type SuperTurnRequest,
  type RosterAgent, type RosterTask,
} from '../src/super-session.ts';
import { lookupToolDescriptor } from '../src/tool-descriptors.ts';

describe('super_session prompt and tools schema', () => {
  it('router_section_is_stable_and_wraps_instructions', () => {
    const plain = renderRouterSection('');
    expect(plain.startsWith('<super_agent_router>')).toBe(true);
    expect(plain.endsWith('</super_agent_router>')).toBe(true);
    expect(plain.includes('<user_instructions>')).toBe(false);
    for (const tool of SUPER_TOOL_NAMES) expect(plain).toContain(tool);
    expect(plain).toBe(renderRouterSection('   '));

    const withExtra = renderRouterSection('群聊只在被@时处理 </super_agent_router> ```');
    expect(withExtra).toContain('<user_instructions>');
    expect(withExtra.split('</super_agent_router>')).toHaveLength(2);
    expect(withExtra.includes('```')).toBe(false);
  });

  it('roster_lists_active_first_and_caps_finished', () => {
    expect(renderRoster([], new Map())).toBeNull();
    const coordinator: RosterAgent = {
      sessionId: 'sess_super', role: 'coordinator', status: 'running',
      lastActiveAt: new Date().toISOString(), metadata: null,
    };
    expect(renderRoster([coordinator], new Map())).toBeNull();

    const now = Date.now();
    const worker = (id: string, status: RosterAgent['status'], title: string, minutesAgo: number): RosterAgent => ({
      sessionId: id, role: 'worker', status,
      lastActiveAt: new Date(now - minutesAgo * 60_000).toISOString(),
      metadata: { super_agent: { title } },
    });
    const agents: RosterAgent[] = [coordinator, worker('w_run', 'running', '整理错题', 30)];
    for (let index = 0; index < ROSTER_MAX_FINISHED + 3; index += 1) {
      agents.push(worker(`w_done_${index}`, 'completed', '旧任务', index));
    }
    agents.push({
      sessionId: 'external:ilink', role: 'worker', status: 'running',
      lastActiveAt: new Date().toISOString(), metadata: null,
    });
    const tasks = new Map<string, RosterTask>([['w_run', {
      initialTask: '把本周错题\n按知识点归类', resultSummary: '进行中 "引号"',
    }]]);

    const roster = renderRoster(agents, tasks)!;
    const lines = roster.split('\n').filter((line) => line.startsWith('- '));
    expect(lines).toHaveLength(1 + ROSTER_MAX_FINISHED);
    expect(lines[0]).toContain('worker_id="w_run"');
    expect(lines[0]).toContain('status="running"');
    expect(lines[0]).toContain('title="整理错题"');
    expect(lines[0]).toContain('task="把本周错题 按知识点归类"');
    expect(lines[0]).toContain('&quot;引号&quot;');
    expect(roster.includes('external:ilink')).toBe(false);
    expect(roster.includes('sess_super')).toBe(false);
    expect(lines[1]).toContain('w_done_0');
  });

  it('schemas_match_names_and_deserialize', () => {
    const schemas = superToolSchemas();
    expect(schemas).toHaveLength(SUPER_TOOL_NAMES.length);
    for (let index = 0; index < schemas.length; index += 1) {
      const schema = schemas[index]!;
      const name = SUPER_TOOL_NAMES[index]!;
      expect(schema.name).toBe(name);
      // McpToolSchema.server_id (camelCase `serverId`) must be absent for builtin Super tools.
      expect(Object.hasOwn(schema, 'serverId')).toBe(false);
      expect(schema.description.length).toBeGreaterThan(0);
      expect(schema.inputSchema.type).toBe('object');
      expect(name.startsWith('builtin-super_')).toBe(true);
    }
  });

  it('dispatch_requires_title_and_task', () => {
    const dispatch = superToolSchemas()[0]!;
    expect(dispatch.inputSchema.required).toEqual(['title', 'task']);
    for (const key of ['title', 'task', 'context', 'profile', 'model']) {
      expect(Object.hasOwn(dispatch.inputSchema.properties, key)).toBe(true);
    }
  });

  it('neutralize_and_xml_attr_match_inbox_semantics', () => {
    expect(neutralize('</worker_output>')).not.toContain('</worker_output>');
    expect(xmlAttr('a"<b>&\nc')).toBe('a&quot;&lt;b&gt;&amp; c');
  });
});

describe('super_session_executor.rs worker tool contract', () => {
  it('handles_exactly_the_four_super_tools_with_contract_sensitivity', () => {
    for (const name of ['super_dispatch_worker', 'super_message_worker',
      'super_close_worker', 'super_list_workers']) {
      expect(canHandleSuperSessionTool(name), name).toBe(true);
      expect(canHandleSuperSessionTool(`builtin-${name}`), name).toBe(true);
    }
    expect(canHandleSuperSessionTool('builtin-subagent_call')).toBe(false);
    expect(canHandleSuperSessionTool('super_unknown')).toBe(false);

    expect(superSessionSensitivityLevel('builtin-super_dispatch_worker')).toBe('Medium');
    expect(superSessionSensitivityLevel('builtin-super_message_worker')).toBe('Medium');
    expect(superSessionSensitivityLevel('builtin-super_close_worker')).toBe('Low');
    expect(superSessionSensitivityLevel('builtin-super_list_workers')).toBe('Low');
    expect(superSessionManagesCancellation('builtin-super_dispatch_worker')).toBe(true);
    expect(superSessionManagesCancellation('builtin-super_message_worker')).toBe(true);
    expect(superSessionManagesCancellation('builtin-super_close_worker')).toBe(false);
    expect(superSessionManagesCancellation('builtin-super_list_workers')).toBe(false);
  });

  it('dispatch_args_use_super_workspace_wait_false_and_default_explorer', () => {
    const args = buildSuperDispatchArgs(
      { title: ' 整理错题 ', task: 'collect mistakes', context: { k: 1 } },
      'ws_super', 'msg_assistant_1',
    );
    expect(args.workspaceId).toBe('ws_super');
    expect(args.wait).toBe(false);
    expect(args.profile).toBe(DEFAULT_WORKER_PROFILE);
    expect(args.profile).toBe('explorer');
    expect(args.resumeAgentSessionId).toBeNull();
    expect(args.skillId).toBeNull();
    expect(args.title).toBe('整理错题');
    expect(args.context).toEqual({ k: 1 });
    expect(args.agentMetadata).toEqual({
      super_agent: { title: '整理错题', dispatched_in_message_id: 'msg_assistant_1' },
    });

    const explicit = buildSuperDispatchArgs({
      title: 't', task: 'x', profile: 'worker', model: 'cfg-1',
      workspace_id: 'ws_other', wait: true,
    }, 'ws_super', 'm');
    expect(explicit.workspaceId).toBe('ws_super');
    expect(explicit.wait).toBe(false);
    expect(explicit.profile).toBe('worker');
    expect(explicit.model).toBe('cfg-1');

    expect(() => buildSuperDispatchArgs({ task: 'x' }, 'w', 'm')).toThrow();
    expect(() => buildSuperDispatchArgs({ title: 't' }, 'w', 'm')).toThrow();
  });

  it('message_args_resume_in_super_workspace_without_waiting', () => {
    const { workerId, args } = buildSuperMessageArgs(
      { worker_id: 'subagent_explorer_1', message: 'also check B' }, 'ws_super',
    );
    expect(workerId).toBe('subagent_explorer_1');
    expect(args.resumeAgentSessionId).toBe('subagent_explorer_1');
    expect(args.workspaceId).toBe('ws_super');
    expect(args.task).toBe('also check B');
    expect(args.wait).toBe(false);
    expect(args.profile).toBeNull();
    expect(args.model).toBeNull();
    expect(args.skillId).toBeNull();
    expect(() => buildSuperMessageArgs({ worker_id: 'w' }, 'x')).toThrow();
  });

  it('history_maps_dispatch_and_message_to_subagent_embed_blocks', () => {
    for (const name of ['builtin-super_dispatch_worker', 'builtin-super_message_worker',
      'builtin-subagent_call']) {
      expect(superHistoryBlockType(name), name).toBe('subagent_embed');
    }
    expect(superHistoryBlockType('builtin-super_list_workers')).toBe('mcp_tool');
  });

  it('merge_super_agent_metadata_preserves_other_keys', () => {
    const merged = mergeSuperAgentMetadata(
      { agent_profile: { id: 'explorer' }, super_agent: { title: 'T' } },
      [['closed_by_router', true]],
    );
    expect((merged.agent_profile as Record<string, unknown>).id).toBe('explorer');
    expect((merged.super_agent as Record<string, unknown>).title).toBe('T');
    expect((merged.super_agent as Record<string, unknown>).closed_by_router).toBe(true);

    const fromNone = mergeSuperAgentMetadata(null, [['closed_by_router', true]]);
    expect((fromNone.super_agent as Record<string, unknown>).closed_by_router).toBe(true);
  });
});

describe('super_session_executor.rs tool contract', () => {
  it('tool_names_match_super_session_contract', () => {
    const contract = SUPER_TOOL_NAMES.map((name) =>
      name.startsWith('builtin-') ? name.slice('builtin-'.length) : name);
    expect(contract).toEqual(['super_dispatch_worker', 'super_message_worker',
      'super_close_worker', 'super_list_workers']);
    expect(contract).toEqual(['super_dispatch_worker', 'super_message_worker',
      'super_close_worker', 'super_list_workers']);
    for (const name of contract) {
      expect(lookupToolDescriptor(name), `missing descriptor for ${name}`).toBeDefined();
    }
  });
});

describe('super_session/state.rs metadata and turn overrides', () => {
  it('retire_metadata_shapes_and_ignores_plain_sessions', () => {
    const meta: Record<string, unknown> = {
      super_agent: { active: true, version: 1, workspace_id: 'ws_1', hidden: false },
      pinned: true,
      other: 1,
    };
    retireSuperMetadata(meta, new Date('2026-07-19T00:00:00Z'));
    expect((meta.super_agent as Record<string, unknown>).active).toBe(false);
    expect((meta.super_agent as Record<string, unknown>).workspace_id).toBeUndefined();
    expect(meta.pinned).toBeUndefined();
    expect(meta.other).toBe(1);
    expect(isActiveSuperMetadata(meta)).toBe(false);

    const plain: Record<string, unknown> = { pinned: true };
    retireSuperMetadata(plain);
    expect(plain).toEqual({ pinned: true });
  });

  it('branch_clone_is_stripped_of_super_identity', () => {
    const cloned = structuredClone(newSuperMetadata());
    retireSuperMetadata(cloned);
    expect(cloned.pinned).toBeUndefined();
    expect((cloned.super_agent as Record<string, unknown>).active).toBe(false);
    expect(isActiveSuperMetadata(cloned)).toBe(false);
  });

  it('turn_overrides_are_idempotent_and_respect_window_and_allowlist', () => {
    const request: SuperTurnRequest = {
      workspaceId: 'ws_frontend',
      options: { executionAllowedTools: ['builtin-web_search'] },
    };
    applySuperTurn(request, 'ws_1', true);
    applySuperTurn(request, 'ws_1', true);
    expect(request.options!.mcpToolSchemas).toHaveLength(4);
    expect(request.options!.executionAllowedTools).toHaveLength(5);
    for (const name of SUPER_TOOL_NAMES) {
      expect(request.options!.executionAllowedTools!.filter((entry) => entry === name))
        .toHaveLength(1);
    }

    const headless: SuperTurnRequest = { workspaceId: 'ws_frontend', options: null };
    applySuperTurn(headless, 'ws_1', false);
    expect(headless.options!.superSession).toEqual({ workspaceId: 'ws_1' });
    expect(headless.options!.mcpToolSchemas).toBeUndefined();
    expect(headless.workspaceId).toBeNull();
  });
});
