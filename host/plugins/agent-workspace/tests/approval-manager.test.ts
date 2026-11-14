import { expect, it } from 'vitest';
import type { JsonValue } from '../api.ts';
import {
  ApprovalManager,
  ApprovalResponses,
} from '../src/approval-manager.ts';
import { PermissionPreset, ToolSensitivity } from '../src/approval-scope.ts';

it('media_transcription_approval_names_external_provider_and_file', () => {
  const description = ApprovalManager.generateDescription('builtin-media_transcribe', {
    source: { objectHandle: { displayName: 'lecture-01.mp3' } },
  });
  expect(description.includes('lecture-01.mp3')).toBe(true);
  expect(description.includes('SiliconFlow')).toBe(true);
  expect(description.includes('artifact')).toBe(true);
});

it('test_approval_flow', async () => {
  const manager = new ApprovalManager();
  const receiver = manager.registerWithScope('sess_1', 'call_123', 'test_tool', { a: 1 });
  const response = ApprovalResponses.approved('sess_1', 'call_123', 'test_tool');
  expect(manager.respond(response)).toBe(true);
  const result = await receiver;
  expect(result.approved).toBe(true);
});

it('dstu_purge_user_rejection_is_delivered_and_never_remembered', async () => {
  const manager = new ApprovalManager();
  const args = { path: '/_trash/note_executor_contract' };
  const receiver = manager.registerWithScope(
    'sess_dstu_rejection',
    'call_dstu_purge',
    'builtin-dstu_purge',
    args,
  );

  const response = ApprovalResponses.rejected(
    'sess_dstu_rejection',
    'call_dstu_purge',
    'builtin-dstu_purge',
    'keep this note',
  );
  response.remember = true;
  response.rememberSession = true;
  expect(manager.respond(response)).toBe(true);

  const rejected = await receiver;
  expect(rejected.approved).toBe(false);
  expect(rejected.reason).toBe('keep this note');
  expect(manager.pendingCount()).toBe(0);
  expect(manager.checkRemembered('builtin-dstu_purge', args),
    'permanent deletion approval must remain single-use').toBeNull();
  expect(
    manager.checkSessionRemembered('sess_dstu_rejection', 'builtin-dstu_purge', args),
    'session-level rejection must not bypass the next precise approval',
  ).toBeNull();
});

it('test_approval_timeout', async () => {
  const manager = new ApprovalManager();
  manager.registerWithScope('sess_1', 'call_456', 'test_tool', { a: 1 });

  // 取消（模拟超时）
  manager.cancelWithSession('sess_1', 'call_456');

  const response = ApprovalResponses.approved('sess_1', 'call_456', 'test_tool');
  expect(manager.respond(response)).toBe(false);
});

it('test_remembered_choices', () => {
  const manager = new ApprovalManager();
  expect(manager.checkRemembered('test_tool', { path: '/a' })).toBeNull();

  manager.registerWithScope('sess_1', 'call_789', 'test_tool', { path: '/a' });
  const response = ApprovalResponses.approved('sess_1', 'call_789', 'test_tool');
  response.remember = true;
  manager.respond(response);

  expect(manager.checkRemembered('test_tool', { path: '/a' })).toBe(true);
  expect(manager.checkRemembered('test_tool', { path: '/b' })).toBeNull();

  manager.clearRemembered('test_tool', { path: '/a' });
  expect(manager.checkRemembered('test_tool', { path: '/a' })).toBeNull();
});

it('reject_all_pending_drains_all_waiters_with_rejection', async () => {
  const manager = new ApprovalManager();
  const rxA = manager.registerWithScope('sess_ks_a', 'call_ks_a', 'note_set', { noteId: 'n1' });
  const rxB = manager.registerWithScope('sess_ks_b', 'call_ks_b', 'execute_command', {
    command: 'git status', root_id: 'workspace', cwd: '.',
  });
  expect(manager.pendingCount()).toBe(2);

  const rejected = manager.rejectAllPending('emergency_stop');
  expect(rejected, 'both pending approvals must be counted').toBe(2);
  expect(manager.pendingCount()).toBe(0);

  const respA = await rxA;
  expect(respA.approved).toBe(false);
  expect(respA.reason).toBe('emergency_stop');
  expect(respA.sessionId).toBe('sess_ks_a');
  expect(respA.toolCallId).toBe('call_ks_a');
  expect(respA.toolName).toBe('note_set');

  const respB = await rxB;
  expect(respB.approved).toBe(false);
  expect(respB.reason).toBe('emergency_stop');
  expect(respB.sessionId).toBe('sess_ks_b');
  expect(respB.toolCallId).toBe('call_ks_b');
  expect(respB.toolName).toBe('execute_command');

  const late = ApprovalResponses.approved('sess_ks_a', 'call_ks_a', 'note_set');
  expect(manager.respond(late)).toBe(false);
  expect(manager.rejectAllPending('emergency_stop')).toBe(0);
});

it('cancel_without_session_refuses_ambiguous_cross_session_match', async () => {
  const manager = new ApprovalManager();
  manager.registerWithScope('sess_a', 'call_dup', 'test_tool', null);
  manager.registerWithScope('sess_b', 'call_dup', 'test_tool', null);
  expect(manager.pendingCount()).toBe(2);

  expect(manager.cancel('call_dup')).toBe(false);
  expect(manager.pendingCount(), 'ambiguous cancel must be a no-op').toBe(2);

  expect(manager.cancelWithSession('sess_a', 'call_dup')).toBe(true);
  expect(manager.pendingCount()).toBe(1);

  expect(manager.cancel('call_dup')).toBe(true);
  expect(manager.pendingCount()).toBe(0);
});

it('cancel_delivers_explicit_cancellation_decision_to_waiter', async () => {
  const manager = new ApprovalManager();
  const rx = manager.registerWithScope('sess_c', 'call_c', 'note_set', { noteId: 'n1' });
  expect(manager.cancel('call_c')).toBe(true);
  const resp = await rx;
  expect(resp.approved).toBe(false);
  expect(resp.reason).toBe(ApprovalManager.CANCELLED_REASON);
  expect(resp.sessionId).toBe('sess_c');
  expect(resp.toolCallId).toBe('call_c');
  expect(resp.toolName).toBe('note_set');
  expect(manager.pendingCount()).toBe(0);

  expect(manager.cancel('call_missing')).toBe(false);
  expect(manager.cancelWithSession('sess_c', 'call_c')).toBe(false);
});

it('cancel_with_session_delivers_cancellation_decision', async () => {
  const manager = new ApprovalManager();
  const rx = manager.registerWithScope('sess_d', 'call_d', 'file_write', { path: 'a.txt' });
  expect(manager.cancelWithSession('sess_d', 'call_d')).toBe(true);
  const resp = await rx;
  expect(resp.approved).toBe(false);
  expect(resp.reason).toBe(ApprovalManager.CANCELLED_REASON);
  expect(resp.toolName).toBe('file_write');
  expect(manager.pendingCount()).toBe(0);
});

it('medium_readonly_shell_can_be_session_remembered_with_precise_scope', () => {
  const manager = new ApprovalManager();
  const approvedArgs = { command: 'git status --short', root_id: 'workspace', cwd: '.' };

  manager.registerWithScope('sess_1', 'call_shell', 'execute_command', approvedArgs);
  const response = ApprovalResponses.approved('sess_1', 'call_shell', 'execute_command');
  response.rememberSession = true;
  expect(manager.respond(response)).toBe(true);

  expect(manager.checkSessionRemembered('sess_1', 'execute_command', approvedArgs),
    'Medium readonly shell may be session-remembered').toBe(true);
  expect(
    manager.checkSessionRemembered('sess_1', 'execute_command', {
      command: 'git status --short', root_id: 'workspace', cwd: 'notes',
    }),
    'same command in another cwd must ask again',
  ).toBeNull();
  expect(
    manager.checkSessionRemembered('sess_1', 'execute_command', {
      command: 'git push origin main', root_id: 'workspace', cwd: '.',
    }),
    'different / High command must ask again',
  ).toBeNull();
});

it('remembered_shell_approval_cannot_change_operand_payload_or_environment', () => {
  const manager = new ApprovalManager();
  const approvedArgs = {
    command: 'rm -f harmless.txt', root_id: 'artifacts', cwd: '.', inherit_env: false,
  };
  manager.registerWithScope('sess_1', 'call_precise_shell', 'execute_command', approvedArgs);
  const response = ApprovalResponses.approved('sess_1', 'call_precise_shell', 'execute_command');
  response.remember = true;
  response.rememberSession = true;
  expect(manager.respond(response)).toBe(true);

  expect(manager.checkRemembered('execute_command', approvedArgs)).toBeNull();
  expect(manager.checkSessionRemembered('sess_1', 'execute_command', approvedArgs)).toBeNull();

  const attacks: JsonValue[] = [
    { command: 'rm -f /tmp/victim.txt', root_id: 'artifacts', cwd: '.', inherit_env: false },
    {
      command: 'curl https://example.com', root_id: 'artifacts', cwd: '.', inherit_env: false,
      allow_network: true,
    },
    {
      command: 'rm -f harmless.txt', root_id: 'artifacts', cwd: '.', inherit_env: false,
      env: { NODE_OPTIONS: '--require=/tmp/payload.js' },
    },
    {
      command: 'rm -f harmless.txt', root_id: 'artifacts', cwd: '.', inherit_env: false,
      env: { LD_PRELOAD: '/tmp/payload.so' },
    },
    {
      command: 'rm -f harmless.txt', root_id: 'artifacts', cwd: '.', inherit_env: false,
      timeout_ms: 120_000,
    },
    {
      command: 'rm -f harmless.txt', root_id: 'artifacts', cwd: '.', inherit_env: false,
      track_file_changes: false,
    },
  ];
  for (const attack of attacks) {
    expect(manager.checkRemembered('execute_command', attack),
      `persistent approval must not cover changed shell plan: ${JSON.stringify(attack)}`).toBeNull();
    expect(manager.checkSessionRemembered('sess_1', 'execute_command', attack),
      `session approval must not cover changed shell plan: ${JSON.stringify(attack)}`).toBeNull();
  }
});

it('remembered_wrapper_approval_cannot_swap_inner_command', () => {
  const manager = new ApprovalManager();
  const approvedArgs = {
    command: 'env MODE=test printf ok', rootId: 'artifacts', workingDir: '.', inheritEnv: false,
  };
  manager.registerWithScope('sess_1', 'call_wrapper', 'builtin-local_shell_execute', approvedArgs);
  const response = ApprovalResponses.approved('sess_1', 'call_wrapper', 'builtin-local_shell_execute');
  response.rememberSession = true;
  expect(manager.respond(response)).toBe(true);
  expect(manager.checkSessionRemembered('sess_1', 'builtin-local_shell_execute', approvedArgs)).toBeNull();

  for (const command of [
    'env MODE=test rm -rf notes',
    'env MODE=test curl https://example.com',
    'timeout 5 rm -rf notes',
    'npm exec -- arbitrary-package',
  ]) {
    const attack = { command, root_id: 'artifacts', cwd: '.', inherit_env: false };
    expect(manager.checkSessionRemembered('sess_1', 'builtin-local_shell_execute', attack),
      `wrapper payload swap must ask again: ${command}`).toBeNull();
  }
});

it('arbitrary_runner_and_path_executable_cannot_be_remembered', async () => {
  for (const [index, command] of ['python analyze.py', './run-analysis'].entries()) {
    const manager = new ApprovalManager();
    const args = { command, root_id: 'temp', cwd: '.', allow_network: true };
    const callId = `call_dynamic_${index}`;
    const rx = manager.registerWithScope('sess_1', callId, 'builtin-local_shell_execute', args);
    const response = ApprovalResponses.approved('sess_1', callId, 'builtin-local_shell_execute');
    response.remember = true;
    response.rememberSession = true;
    const result = manager.respondWithResult(response);
    expect(result.delivered).toBe(true);
    expect(result.settingKey).toBeNull();
    const delivered = await rx;
    expect(delivered.remember).toBe(false);
    expect(delivered.rememberSession).toBe(false);
    expect(manager.checkRemembered('builtin-local_shell_execute', args)).toBeNull();
    expect(manager.checkSessionRemembered('sess_1', 'builtin-local_shell_execute', args)).toBeNull();
  }
});

it('session_remember_for_regular_tools_keeps_tool_level_semantics', () => {
  const manager = new ApprovalManager();
  const firstArgs = { resourceId: 'r1', value: 'v1' };

  manager.registerWithScope('sess_1', 'call_regular', 'test_tool', firstArgs);
  const response = ApprovalResponses.approved('sess_1', 'call_regular', 'test_tool');
  response.rememberSession = true;
  expect(manager.respond(response)).toBe(true);

  expect(
    manager.checkSessionRemembered('sess_1', 'test_tool', { resourceId: 'r2', value: 'v2' }),
    'existing session-level tool approval semantics should remain unchanged for regular tools',
  ).toBe(true);
});

it('response_tool_name_cannot_poison_shell_session_or_setting_scope', async () => {
  const manager = new ApprovalManager();
  const shellArgs = { command: 'git status --short', root_id: 'workspace', cwd: '.' };

  const rx = manager.registerWithScope('sess_1', 'call_shell', 'execute_command', shellArgs);
  const response = ApprovalResponses.approved('sess_1', 'call_shell', 'note_set');
  response.remember = true;
  response.rememberSession = true;

  const result = manager.respondWithResult(response);
  expect(result.delivered).toBe(true);
  expect(result.settingKey,
    'shell approvals are single-use and must not return a persistence key').toBeNull();

  const delivered = await rx;
  expect(delivered.toolName,
    'waiting pipeline should receive the pending tool name, not client-supplied spoof').toBe('execute_command');
  expect(manager.checkSessionRemembered('sess_1', 'execute_command', shellArgs)).toBeNull();
  expect(
    manager.checkSessionRemembered('sess_1', 'note_set', { noteId: 'n1' }),
    'spoofed response tool_name must not create a broad regular-tool session approval',
  ).toBeNull();
});

it('file_manager_approval_descriptions_name_the_reviewed_action', () => {
  const commit = ApprovalManager.generateDescription('builtin-file_manager_commit', {
    plan_id: 'fileplan_123',
    root_id: 'workspace',
    preview_sha256: 'a'.repeat(64),
  });
  expect(commit.includes('workspace')).toBe(true);
  expect(commit.includes('fileplan_123')).toBe(true);

  const restore = ApprovalManager.generateDescription('builtin-file_manager_restore', {
    receipt: { originalPath: 'reports/a.json' },
  });
  expect(restore.includes('reports/a.json')).toBe(true);
});

it('skill_lifecycle_approval_descriptions_name_the_target_skill', () => {
  const disable = ApprovalManager.generateDescription('builtin-skill_set_enabled', {
    skill_id: 'pdf-tools', enabled: false,
  });
  expect(disable.includes('pdf-tools')).toBe(true);
  expect(disable.includes('停用')).toBe(true);

  const enable = ApprovalManager.generateDescription('builtin-skill_set_enabled', {
    skill_id: 'pdf-tools', enabled: true,
  });
  expect(enable.includes('启用')).toBe(true);

  const remove = ApprovalManager.generateDescription('builtin-skill_remove', {
    skill_id: 'external-tools',
  });
  expect(remove.includes('external-tools')).toBe(true);
  expect(remove.includes('删除')).toBe(true);

  const trust = ApprovalManager.generateDescription('builtin-skill_trust_request', {
    action: 'grant',
    skill_id: 'external-tools',
    reason: '需要运行包内脚本',
  });
  expect(trust.includes('external-tools')).toBe(true);
  expect(trust.includes('需要运行包内脚本')).toBe(true);
});

it('mcp_manage_approval_descriptions_name_server_and_transport', () => {
  const update = ApprovalManager.generateDescription('builtin-mcp_server_update', {
    server_id: 'brave',
    url: 'https://example.com/sse',
    transport: 'sse',
    reason: 'migrate',
  });
  expect(update.includes('brave')).toBe(true);
  expect(update.includes('url')).toBe(true);
  expect(update.includes('回滚')).toBe(true);
  expect(update.includes('reason')).toBe(false);

  const disable = ApprovalManager.generateDescription('builtin-mcp_server_set_enabled', {
    server_id: 'brave', enabled: false,
  });
  expect(disable.includes('brave')).toBe(true);
  expect(disable.includes('停用')).toBe(true);

  const enable = ApprovalManager.generateDescription('builtin-mcp_server_set_enabled', {
    server_id: 'brave', enabled: true,
  });
  expect(enable.includes('启用')).toBe(true);

  const remove = ApprovalManager.generateDescription('builtin-mcp_server_remove', {
    server_id: 'brave', expected_transport: 'stdio',
  });
  expect(remove.includes('brave')).toBe(true);
  expect(remove.includes('stdio')).toBe(true);
  expect(remove.includes('删除')).toBe(true);
});

it('custom_agent_approval_descriptions_name_the_target_persona', () => {
  const applyWithSummary = ApprovalManager.generateDescription('builtin-custom_agent_apply', {
    proposal_id: 'cap_1234567890_abcd',
    file_name: 'paper-summarizer.md',
    change_summary: '覆盖 paper-summarizer.md：980 → 1200 字节；标题 # 旧 → # 新',
  });
  expect(applyWithSummary.includes('paper-summarizer.md')).toBe(true);
  expect(applyWithSummary.includes('980 → 1200')).toBe(true);

  const applyBare = ApprovalManager.generateDescription('builtin-custom_agent_apply', {
    file_name: 'paper-summarizer.md',
  });
  expect(applyBare.includes('workspaces/agents/paper-summarizer.md')).toBe(true);

  const remove = ApprovalManager.generateDescription('builtin-custom_agent_remove', {
    file_name: 'paper-summarizer.md', title: '# 论文摘要员',
  });
  expect(remove.includes('paper-summarizer.md')).toBe(true);
  expect(remove.includes('论文摘要员')).toBe(true);
  expect(remove.includes('删除')).toBe(true);
});

it('permission_presets_only_remember_relaxed_medium_for_current_session', () => {
  const manager = new ApprovalManager();
  const args = { root_id: 'workspace', path: 'report.md' };
  manager.registerWithPermissionPreset(
    'sess-1',
    'call-1',
    'workspace_file_write',
    args,
    PermissionPreset.Relaxed,
    ToolSensitivity.Medium,
  );
  const result = manager.respondWithResult({
    sessionId: 'sess-1',
    toolCallId: 'call-1',
    toolName: 'workspace_file_write',
    approved: true,
    remember: true,
    rememberSession: true,
    reason: null,
  });
  expect(result.settingKey, 'preset must never persist globally').toBeNull();
  expect(manager.checkSessionRemembered('sess-1', 'workspace_file_write', args)).toBe(true);
  expect(manager.checkSessionRemembered('sess-2', 'workspace_file_write', args)).toBeNull();
});

it('high_and_cautious_approvals_cannot_be_remembered', () => {
  const cases: [PermissionPreset, ToolSensitivity][] = [
    [PermissionPreset.Relaxed, ToolSensitivity.High],
    [PermissionPreset.Cautious, ToolSensitivity.Medium],
  ];
  for (const [preset, sensitivity] of cases) {
    const manager = new ApprovalManager();
    const args = { path: '/safe/item' };
    manager.registerWithPermissionPreset('sess-1', 'call-1', 'test_tool', args, preset, sensitivity);
    manager.respond({
      sessionId: 'sess-1',
      toolCallId: 'call-1',
      toolName: 'test_tool',
      approved: true,
      remember: true,
      rememberSession: true,
      reason: null,
    });
    expect(manager.checkSessionRemembered('sess-1', 'test_tool', args),
      `${preset}/${sensitivity} must require confirmation again`).toBeNull();
  }
});
