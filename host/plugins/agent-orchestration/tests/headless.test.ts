import { describe, expect, it } from 'vitest';
import {
  clampSessionTurnTimeout, concludePipelineResult, filterHeadlessToolSchemas,
  headlessAllowedTools, headlessSystemPromptNote, HEADLESS_BLOCKED_TOOLS,
  installTrustedAutomationSession, isHeadlessAllowedTool, LEGACY_HEADLESS_ALLOWED_TOOLS,
  headlessToolSchemas, isToolAllowedByExecutionPolicy, isTrustedAutomationPreauthorized,
  MAX_HARD_TIMEOUT_SECS,
  panicMessage, parseHeadlessSessionMode, sessionAutoMemoryExtraction,
  summarizeAssistantBlocks, truncateChars, trustedWriteToolRollbackAvailable,
  validateTrustedAutomationToolCall, type HeadlessBlock,
} from '../src/headless.ts';
import { computedProfileHash, type TrustedAutomationProfile } from '../src/trusted-profile.ts';
import { BUILTIN_DESCRIPTORS } from '../src/tool-descriptors.ts';

function policyProfile(): TrustedAutomationProfile {
  const profile: TrustedAutomationProfile = {
    schemaVersion: 1,
    profileHash: '',
    allowedTools: ['builtin-local_shell_execute', 'builtin-workspace_change_revert'],
    runtimeRoots: [{ rootId: 'workspace', access: 'read_write' }],
    shellCommandPrefixes: ['curl', 'unzip'],
    networkDomains: ['example.com'],
    maxToolRounds: 8,
    timeoutSeconds: 300,
    maxOutputBytes: 65_536,
    rollbackRequired: true,
  };
  profile.profileHash = computedProfileHash(profile);
  return profile;
}

function completionBlock(status: string, result: string, blockType = 'tool'): HeadlessBlock {
  return {
    blockType, status, toolName: 'attempt_completion', content: null,
    toolOutput: { completed: status === 'success', result, command: null, task_completed: status === 'success' },
  };
}

describe('headless.rs helpers and trusted profile policy', () => {
  it('truncate_chars_handles_multibyte', () => {
    expect(truncateChars('你好世界', 10)).toBe('你好世界');
    expect(truncateChars('你好世界', 2)).toBe('你好…');
    expect(truncateChars('', 5)).toBe('');
  });

  it('session_mode_serde_and_parse', () => {
    expect(JSON.stringify('isolated')).toBe('"isolated"');
    expect(JSON.parse('"named"')).toBe('named');
    expect(parseHeadlessSessionMode('Named')).toBe('named');
    expect(parseHeadlessSessionMode('isolated')).toBe('isolated');
    expect(() => parseHeadlessSessionMode('bogus')).toThrow();
  });

  it('headless_system_prompt_mentions_constraints', () => {
    const note = headlessSystemPromptNote();
    expect(note).toContain('headless');
    expect(note).toContain('attempt_completion');
  });

  it('summary_uses_successful_completion_tool_without_content', () => {
    expect(summarizeAssistantBlocks([completionBlock('success', '已检查 3 项，均正常')]))
      .toBe('已检查 3 项，均正常');
  });

  it('completion_tool_heartbeat_result_remains_silent', () => {
    const summary = summarizeAssistantBlocks([completionBlock('success', 'HEARTBEAT_OK')]);
    expect(summary).toBe('HEARTBEAT_OK');
    expect(summary.trim()).toBe('HEARTBEAT_OK');
  });

  it('summary_ignores_failed_completion_tool_output', () => {
    const content: HeadlessBlock = {
      blockType: 'content', status: 'success', toolName: null,
      content: '可用的正文结果', toolOutput: null,
    };
    const failed = completionBlock('error', '不应展示的伪结果');
    expect(summarizeAssistantBlocks([content, failed])).toBe('可用的正文结果');
  });

  it('aut_06_trusted_profile_enforces_root_prefix_network_output_and_rollback', () => {
    const profile = policyProfile();
    const guard = installTrustedAutomationSession('aut-06', profile)!;
    expect(() => validateTrustedAutomationToolCall('aut-06', 'builtin-local_shell_execute', {
      root_id: 'workspace', command: 'unzip bundle.zip', track_file_changes: true, max_output_bytes: 4096,
    })).not.toThrow();
    expect(() => validateTrustedAutomationToolCall('aut-06', 'builtin-local_shell_execute', {
      root_id: 'temp', command: 'unzip bundle.zip', track_file_changes: true,
    })).toThrow();
    expect(() => validateTrustedAutomationToolCall('aut-06', 'builtin-local_shell_execute', {
      root_id: 'workspace', command: 'rm -rf out', track_file_changes: true,
    })).toThrow();
    expect(() => validateTrustedAutomationToolCall('aut-06', 'builtin-local_shell_execute', {
      root_id: 'workspace', command: 'curl https://evil.test/x', allow_network: true,
    })).toThrow();
    expect(() => validateTrustedAutomationToolCall('aut-06', 'builtin-local_shell_execute', {
      root_id: 'workspace', command: 'unzip bundle.zip', track_file_changes: true, max_output_bytes: 65_537,
    })).toThrow();
    guard.release();
  });

  it('aut_07_profile_constrains_web_fetch_and_reads_revert_root_from_receipt', () => {
    const profile = policyProfile();
    const guard = installTrustedAutomationSession('aut-07', profile)!;
    expect(() => validateTrustedAutomationToolCall('aut-07', 'builtin-web_fetch',
      { url: 'https://example.com/allowed' })).not.toThrow();
    expect(() => validateTrustedAutomationToolCall('aut-07', 'builtin-web_fetch',
      { url: 'https://outside.test/blocked' })).toThrow();
    expect(() => validateTrustedAutomationToolCall('aut-07', 'builtin-workspace_change_revert',
      { receipt: { root_id: 'workspace', path: 'notes/a.md' } })).not.toThrow();
    guard.release();
    expect(() => validateTrustedAutomationToolCall('ordinary-session', 'builtin-local_shell_execute', {}))
      .not.toThrow();
  });

  it('preauthorization_denies_sessions_without_trusted_profile', () => {
    expect(isTrustedAutomationPreauthorized('no-profile-session', 'builtin-local_shell_execute', {
      root_id: 'workspace', command: 'unzip bundle.zip', track_file_changes: true, max_output_bytes: 4096,
    })).toBe(false);
  });

  it('preauthorization_allows_fully_validated_profile_call', () => {
    const guard = installTrustedAutomationSession('preauth-ok', policyProfile())!;
    expect(isTrustedAutomationPreauthorized('preauth-ok', 'builtin-local_shell_execute', {
      root_id: 'workspace', command: 'unzip bundle.zip', track_file_changes: true, max_output_bytes: 4096,
    })).toBe(true);
    expect(isTrustedAutomationPreauthorized('preauth-ok', 'builtin-workspace_change_revert',
      { receipt: { root_id: 'workspace', path: 'notes/a.md' } })).toBe(true);
    guard.release();
  });

  it('preauthorization_denies_calls_outside_profile_allowed_tools', () => {
    const guard = installTrustedAutomationSession('preauth-scope', policyProfile())!;
    expect(isTrustedAutomationPreauthorized('preauth-scope', 'builtin-web_fetch',
      { url: 'https://example.com/x' })).toBe(false);
    guard.release();
  });

  it('preauthorization_denies_calls_failing_profile_validation', () => {
    const guard = installTrustedAutomationSession('preauth-invalid', policyProfile())!;
    expect(isTrustedAutomationPreauthorized('preauth-invalid', 'builtin-local_shell_execute', {
      root_id: 'temp', command: 'unzip bundle.zip', track_file_changes: true, max_output_bytes: 4096,
    })).toBe(false);
    expect(isTrustedAutomationPreauthorized('preauth-invalid', 'builtin-local_shell_execute', {
      root_id: 'workspace', command: 'rm -rf out', track_file_changes: true, max_output_bytes: 4096,
    })).toBe(false);
    guard.release();
  });

  it('preauthorization_requires_rollback_evidence_for_write_tools', () => {
    const profile = policyProfile();
    expect(profile.rollbackRequired).toBe(true);
    const guard = installTrustedAutomationSession('preauth-rollback', profile)!;
    expect(isTrustedAutomationPreauthorized('preauth-rollback', 'builtin-local_shell_execute', {
      root_id: 'workspace', command: 'unzip bundle.zip', max_output_bytes: 4096,
    })).toBe(false);
    guard.release();
  });

  it('session_turn_timeout_is_clamped_defensively', () => {
    expect(clampSessionTurnTimeout(0)).toBe(1);
    expect(clampSessionTurnTimeout(0.2)).toBe(1);
    expect(clampSessionTurnTimeout(300)).toBe(300);
    expect(clampSessionTurnTimeout(MAX_HARD_TIMEOUT_SECS + 1)).toBe(MAX_HARD_TIMEOUT_SECS);
  });

  it('panic_message_extracts_common_payload_types', () => {
    expect(panicMessage('static str panic')).toBe('static str panic');
    expect(panicMessage('owned panic')).toBe('owned panic');
    expect(panicMessage(42)).toBe('non-string panic payload');
  });

  it('conclude_pipeline_result_maps_all_terminations', () => {
    expect(concludePipelineResult({ ok: true, value: 'msg_1' })).toEqual({ status: 'completed' });
    expect(concludePipelineResult({ ok: false, cancelled: true })).toEqual({ status: 'cancelled' });
    expect(concludePipelineResult({ ok: false, cancelled: false, message: 'boom' }))
      .toEqual({ status: 'failed', message: 'boom' });
    const panicked = concludePipelineResult({ ok: false, panicked: 'pipeline exploded' });
    expect(panicked.status).toBe('failed');
    expect(panicked.status === 'failed' && panicked.message).toContain('panicked');
    expect(panicked.status === 'failed' && panicked.message).toContain('pipeline exploded');
  });

  it('rollback_availability_matrix_is_conservative', () => {
    expect(trustedWriteToolRollbackAvailable('workspace_file_write', {})).toBe(true);
    expect(trustedWriteToolRollbackAvailable('workspace_change_revert', {})).toBe(true);
    expect(trustedWriteToolRollbackAvailable('local_shell_execute', { track_file_changes: true })).toBe(true);
    expect(trustedWriteToolRollbackAvailable('local_shell_execute', {})).toBe(false);
    expect(trustedWriteToolRollbackAvailable('attachment_stage', {})).toBe(false);
  });
});

describe('headless.rs whitelist and execution policy', () => {
  it('superagent_sessions_opt_out_of_auto_memory_extraction', () => {
    expect(sessionAutoMemoryExtraction({ auto_memory_extraction: false })).toBe(false);
    expect(sessionAutoMemoryExtraction({ headless: true, superagent: 'worker' })).toBe(false);
    expect(sessionAutoMemoryExtraction({ headless: true })).toBeNull();
    expect(sessionAutoMemoryExtraction({ auto_memory_extraction: true })).toBeNull();
  });

  it('whitelist_excludes_all_blocked_tools', () => {
    const allowed = headlessAllowedTools();
    for (const [blocked, reason] of HEADLESS_BLOCKED_TOOLS) {
      const hit = allowed.some((entry) => {
        const short = entry.startsWith('builtin-') ? entry.slice('builtin-'.length) : entry;
        if (blocked.endsWith('*')) {
          const prefix = blocked.slice(0, -1);
          return short.startsWith(prefix) || entry.startsWith(prefix);
        }
        return short === blocked;
      });
      expect(hit, `blocked tool '${blocked}' (${reason}) must not be whitelisted`).toBe(false);
    }
  });

  it('filter_strips_frontend_bridge_and_interactive_tools', () => {
    const schemas = [
      { name: 'builtin-memory_read' },
      { name: 'builtin-ask_user' },
      { name: 'some_mcp_tool', serverId: 'srv-1' },
      { name: 'builtin-subagent_call' },
      { name: 'builtin-local_shell_execute' },
    ];
    expect(filterHeadlessToolSchemas(schemas).map((schema) => schema.name))
      .toEqual(['builtin-memory_read']);
  });

  it('execution_policy_blocks_non_whitelisted_calls_fail_closed', () => {
    const allowed = headlessAllowedTools();
    for (const blocked of ['builtin-ask_user', 'builtin-subagent_call',
      'builtin-local_shell_execute', 'mcp_web_search', 'builtin-memory_delete',
      'builtin-automation_propose', 'builtin-qbank_reset_progress', 'builtin-review_schedule']) {
      expect(isToolAllowedByExecutionPolicy(blocked, {}, allowed), blocked).toBe(false);
    }
    expect(isToolAllowedByExecutionPolicy('some_random_tool', { _serverId: 'srv-1' }, allowed))
      .toBe(false);
    for (const allowedName of ['builtin-memory_read', 'builtin-user_todo_search',
      'builtin-qbank_get_stats', 'builtin-review_get_due', 'attempt_completion']) {
      expect(isToolAllowedByExecutionPolicy(allowedName, {}, allowed), allowedName).toBe(true);
    }
    expect(isToolAllowedByExecutionPolicy('builtin-user_todo_create_item', {}, allowed)).toBe(false);
  });

  it('headless_todo_and_automation_surfaces_are_read_only', () => {
    const allowed = headlessAllowedTools();
    for (const readTool of ['builtin-user_todo_list_lists', 'builtin-user_todo_list_items',
      'builtin-user_todo_get_summary', 'builtin-user_todo_search',
      'builtin-user_todo_list_trash']) {
      expect(allowed, readTool).toContain(readTool);
    }
    for (const writeTool of ['builtin-user_todo_create_item', 'builtin-user_todo_complete_item',
      'builtin-user_todo_update_item', 'builtin-user_todo_delete_item',
      'builtin-user_todo_create_list', 'builtin-user_todo_update_list',
      'builtin-user_todo_delete_list', 'builtin-user_todo_restore',
      'builtin-user_todo_reorder', 'builtin-automation_propose',
      'builtin-automation_set_enabled', 'builtin-automation_update',
      'builtin-automation_delete', 'builtin-automation_run_now']) {
      expect(allowed, writeTool).not.toContain(writeTool);
    }
    expect(isHeadlessAllowedTool('user_todo_search')).toBe(true);
    expect(isHeadlessAllowedTool('automation_propose')).toBe(false);
  });
});

describe('headless.rs builtin schema surface', () => {
  function schemaFor(name: string): Record<string, unknown> {
    const schema = headlessToolSchemas().find((entry) => entry.name === name);
    expect(schema, `missing headless schema ${name}`).toBeDefined();
    return schema!.inputSchema;
  }

  function schemaNames(): string[] {
    return headlessToolSchemas().map((schema) => schema.name);
  }

  it('headless_read_schemas_match_production_pagination_contracts', () => {
    const memory = schemaFor('builtin-memory_list') as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(memory.properties.limit!.default).toBe(20);
    expect(memory.properties.limit!.maximum).toBe(20);

    const trash = schemaFor('builtin-dstu_list_trash') as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(trash.properties.limit!.default).toBe(20);
    expect(trash.properties.limit!.maximum).toBe(20);

    const banks = schemaFor('builtin-qbank_list') as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(banks.properties.limit!.maximum).toBe(20);
    const questions = schemaFor('builtin-qbank_list_questions') as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(questions.properties.page_size!.maximum).toBe(20);

    const next = schemaFor('builtin-qbank_get_next_question') as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(next.properties.review_only!.default).toBe(false);
    expect(typeof next.properties.current_card_id).toBe('object');

    const resourceRead = schemaFor('builtin-resource_read') as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(resourceRead.properties.offset!.minimum).toBe(0);
    expect(resourceRead.properties.offset!.default).toBe(0);
    expect(resourceRead.properties.max_bytes!.maximum).toBe(1_048_576);
    expect(typeof resourceRead.properties.expected_hash).toBe('object');
  });

  it('retired_frontend_anki_tool_stays_fail_closed', () => {
    const legacyTool = 'anki_generate_cards';
    expect(HEADLESS_BLOCKED_TOOLS.some(([tool, reason]) =>
      tool === legacyTool && reason === 'frontend-bridge')).toBe(true);
    expect(isHeadlessAllowedTool(legacyTool)).toBe(false);
    expect(schemaNames().some((name) =>
      (name.startsWith('builtin-') ? name.slice('builtin-'.length) : name) === legacyTool))
      .toBe(false);
  });

  it('headless_schemas_are_subset_of_whitelist', () => {
    const allowed = headlessAllowedTools();
    for (const schema of headlessToolSchemas()) {
      expect(allowed, `schema '${schema.name}'`).toContain(schema.name);
    }
    expect(headlessToolSchemas().length).toBeGreaterThanOrEqual(20);
  });

  it('headless_dstu_surface_is_strictly_read_only', () => {
    const allowed = headlessAllowedTools();
    expect(allowed).toContain('builtin-dstu_list_trash');
    for (const writeTool of ['builtin-dstu_folder_create', 'builtin-dstu_folder_rename',
      'builtin-dstu_rename', 'builtin-dstu_move', 'builtin-dstu_delete',
      'builtin-dstu_restore', 'builtin-dstu_set_favorite', 'builtin-dstu_purge',
      'builtin-dstu_upload_file']) {
      expect(allowed, writeTool).not.toContain(writeTool);
    }
    expect(schemaNames()).toContain('builtin-dstu_list_trash');
    expect(schemaNames()).not.toContain('builtin-dstu_set_favorite');
  });

  it('headless_memory_surface_is_strictly_read_only', () => {
    const allowed = headlessAllowedTools();
    for (const readTool of ['builtin-memory_read', 'builtin-memory_list']) {
      expect(allowed, readTool).toContain(readTool);
    }
    for (const writeTool of ['builtin-memory_write', 'builtin-memory_write_smart',
      'builtin-memory_write_batch', 'builtin-memory_update_by_id', 'builtin-memory_delete',
      'builtin-memory_batch_move', 'builtin-memory_add_relation',
      'builtin-memory_remove_relation', 'builtin-memory_update_tags',
      'builtin-memory_export_all']) {
      expect(allowed, writeTool).not.toContain(writeTool);
    }
    expect(schemaNames()).toContain('builtin-memory_read');
    expect(schemaNames()).not.toContain('builtin-memory_write_smart');
  });
});

describe('headless.rs registry-derived whitelist', () => {
  it('registry_driven_whitelist_matches_legacy_list', () => {
    const derived = new Set(headlessAllowedTools());
    const legacy = new Set<string>(LEGACY_HEADLESS_ALLOWED_TOOLS);
    expect([...derived].sort()).toEqual([...legacy].sort());

    for (const name of legacy) {
      expect(isHeadlessAllowedTool(name), `${name} should be allowed`).toBe(true);
      const bare = name.startsWith('builtin-') ? name.slice('builtin-'.length) : name;
      expect(isHeadlessAllowedTool(bare), `bare ${bare} should be allowed`).toBe(true);
    }

    for (const descriptor of BUILTIN_DESCRIPTORS) {
      if (descriptor.headlessAllowed) continue;
      expect(isHeadlessAllowedTool(descriptor.name), `${descriptor.name} must be rejected`).toBe(false);
      const prefixed = `builtin-${descriptor.name}`;
      expect(isHeadlessAllowedTool(prefixed), `${prefixed} must be rejected`).toBe(false);
    }

    for (const outsider of ['mcp_anything', 'builtin-mcp_foo', 'anki_generate_cards',
      'nonexistent_tool']) {
      expect(isHeadlessAllowedTool(outsider), `${outsider} must be rejected`).toBe(false);
    }
  });
});
