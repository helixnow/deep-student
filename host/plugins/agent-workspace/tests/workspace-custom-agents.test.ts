import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { AgentProfileResolver, EXPLORER_PROFILE_ID, WORKER_PROFILE_ID } from '../src/workspace/agent-profile.ts';
import {
  findCustomProfile, loadCustomProfiles, safeToolSet,
} from '../src/workspace/custom-agents.ts';
import { effectiveTools, scopeAllows, scopesFromAllowedTools } from '../src/workspace/grants.ts';
import { runtimeConfigFromProfile } from '../src/workspace/agent-profile.ts';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-custom-agents-'));
}

function writeAgentFile(dir: string, filename: string, content: string): void {
  fs.writeFileSync(path.join(dir, filename), content);
}

describe('custom_agents', () => {
  it('parses_regular_definition_with_comma_separated_tools', () => {
    const dir = tempDir();
    writeAgentFile(
      dir,
      'paper-summarizer.md',
      '---\nname: paper-summarizer\ndescription: 阅读论文并输出结构化摘要\nbase: explorer\nmodel: some-model-config-id\ntools: builtin-web_search, builtin-resource_read\n---\n阅读论文并输出结构化摘要。\n',
    );

    const profiles = loadCustomProfiles(dir);
    expect(profiles).toHaveLength(1);
    const profile = profiles[0]!;
    expect(profile.id).toBe('paper-summarizer');
    expect(profile.description).toBe('阅读论文并输出结构化摘要');
    expect(profile.model).toBe('some-model-config-id');
    expect(profile.instructions).toBe('阅读论文并输出结构化摘要。');
    expect(profile.allowedTools).toEqual([
      'builtin-web_search',
      'builtin-resource_read',
    ]);
    const base = AgentProfileResolver.builtIn(EXPLORER_PROFILE_ID)!;
    expect(profile.permissions).toEqual(base.permissions);
    expect(profile.contextInheritance).toEqual(base.contextInheritance);
  });

  it('parses_inline_array_tools', () => {
    const dir = tempDir();
    writeAgentFile(
      dir,
      'inline.md',
      '---\nname: inline-agent\ntools: [builtin-web_search, "builtin-web_fetch"]\n---\nBody.\n',
    );

    const profile = findCustomProfile(dir, 'inline-agent')!;
    // frontmatter 未写 description：不继承 base 的内建简介。
    expect(profile.description).toBeNull();
    expect(profile.allowedTools).toEqual([
      'builtin-web_search',
      'builtin-web_fetch',
    ]);
    const base = AgentProfileResolver.builtIn(WORKER_PROFILE_ID)!;
    expect(profile.permissions).toEqual(base.permissions);
  });

  it('out_of_whitelist_tools_are_dropped_not_fatal', () => {
    const dir = tempDir();
    writeAgentFile(
      dir,
      'risky.md',
      '---\nname: risky-agent\ntools: [builtin-web_search, builtin-dstu_delete, tool_pack]\n---\nBody.\n',
    );

    const profile = findCustomProfile(dir, 'risky-agent')!;
    expect(profile.allowedTools).toEqual([
      'builtin-web_search',
    ]);
  });

  // G02-P1：自定义 profile → grant 映射无损。
  it('custom_profile_maps_losslessly_to_grant_scopes', () => {
    const dir = tempDir();
    writeAgentFile(
      dir,
      'qa-reader.md',
      '---\nname: qa-reader\nbase: explorer\ntools: [builtin-web_search, builtin-resource_read, builtin-chatanki_get_cards, builtin-dstu_delete]\n---\nRead cards.\n',
    );

    const profile = findCustomProfile(dir, 'qa-reader')!;
    expect(profile.allowedTools).toEqual([
      'builtin-web_search',
      'builtin-resource_read',
      'builtin-chatanki_get_cards',
    ]);

    const scopes = AgentProfileResolver.grantToolScopes(profile);
    for (const tool of profile.allowedTools) {
      expect(scopes.some(scope => scopeAllows(scope, tool, null)), `scope set must allow whitelisted tool ${tool}`)
        .toBe(true);
    }
    expect(effectiveTools(scopes, profile.allowedTools)).toEqual(profile.allowedTools);
    for (const foreign of ['builtin-dstu_delete', 'builtin-chatanki_run']) {
      expect(scopes.some(scope => scopeAllows(scope, foreign, null)), `scope set must NOT allow ${foreign}`)
        .toBe(false);
    }
  });

  // Multi-agent Phase 2：chatanki 写工具与 workspace 文档读写工具不在安全全集内。
  it('chatanki_write_and_workspace_document_tools_stay_blocked_fail_closed', () => {
    const safe = safeToolSet();
    for (const tool of [
      'builtin-chatanki_run',
      'builtin-chatanki_start',
      'builtin-chatanki_import_apkg',
      'builtin-chatanki_update_card',
      'builtin-chatanki_batch_update_cards',
      'builtin-chatanki_delete_card',
      'builtin-chatanki_delete_cards',
      'builtin-chatanki_add_cards',
      'builtin-chatanki_enqueue_review',
      'builtin-chatanki_undo_last_review',
      'builtin-chatanki_set_suspended',
      'builtin-chatanki_update_library_card',
      'builtin-chatanki_enqueue_library_review',
      'builtin-chatanki_set_library_suspended',
      'builtin-chatanki_undo_library_last_review',
      'builtin-chatanki_delete_library_card',
      'builtin-chatanki_retemplate',
      'builtin-chatanki_transform',
      'builtin-chatanki_control',
      'builtin-chatanki_export',
      'builtin-chatanki_sync',
      'builtin-workspace_read_document',
      'builtin-workspace_update_document',
    ]) {
      expect(safe.has(tool), `safe tool set must not contain ${tool}`).toBe(false);
    }

    const dir = tempDir();
    writeAgentFile(
      dir,
      'escalating.md',
      '---\nname: escalating-agent\nbase: worker\ntools: [builtin-chatanki_run, builtin-chatanki_batch_update_cards, builtin-workspace_read_document, builtin-workspace_update_document, builtin-resource_read]\n---\nBody.\n',
    );

    const profile = findCustomProfile(dir, 'escalating-agent')!;
    expect(profile.allowedTools).toEqual([
      'builtin-resource_read',
    ]);
  });

  it('chatanki_mixed_readonly_and_write_declaration_keeps_only_readonly', () => {
    const dir = tempDir();
    writeAgentFile(
      dir,
      'qa-mixed.md',
      '---\nname: qa-mixed\nbase: worker\ntools: [builtin-chatanki_get_cards, builtin-chatanki_batch_update_cards, builtin-chatanki_status, builtin-chatanki_delete_cards, builtin-chatanki_analyze, builtin-chatanki_run, builtin-chatanki_list_templates, builtin-workspace_update_document]\n---\nBody.\n',
    );

    const profile = findCustomProfile(dir, 'qa-mixed')!;
    expect(profile.allowedTools).toEqual([
      'builtin-chatanki_get_cards',
      'builtin-chatanki_status',
      'builtin-chatanki_analyze',
      'builtin-chatanki_list_templates',
    ]);
  });

  it('built_in_name_conflict_is_skipped', () => {
    const dir = tempDir();
    writeAgentFile(dir, 'worker.md', '---\nname: worker\n---\nBody.\n');
    writeAgentFile(dir, 'ok.md', '---\nname: ok-agent\n---\nBody.\n');

    const profiles = loadCustomProfiles(dir);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.id).toBe('ok-agent');
  });

  it('missing_name_is_skipped', () => {
    const dir = tempDir();
    writeAgentFile(dir, 'noname.md', '---\nbase: worker\n---\nBody.\n');
    expect(loadCustomProfiles(dir)).toEqual([]);
  });

  it('invalid_name_characters_are_skipped', () => {
    const dir = tempDir();
    writeAgentFile(dir, 'bad1.md', '---\nname: Upper-Case\n---\nBody.\n');
    writeAgentFile(dir, 'bad2.md', '---\nname: has space\n---\nBody.\n');
    writeAgentFile(dir, 'bad3.md', '---\nname: under_score\n---\nBody.\n');
    expect(loadCustomProfiles(dir)).toEqual([]);
  });

  it('empty_body_keeps_base_instructions', () => {
    const dir = tempDir();
    writeAgentFile(
      dir,
      'empty-body.md',
      '---\nname: empty-body\nbase: explorer\n---\n   \n',
    );

    const profile = findCustomProfile(dir, 'empty-body')!;
    const base = AgentProfileResolver.builtIn(EXPLORER_PROFILE_ID)!;
    expect(profile.instructions).toBe(base.instructions);
  });

  it('invalid_base_is_skipped_and_missing_dir_is_empty', () => {
    const dir = tempDir();
    writeAgentFile(
      dir,
      'badbase.md',
      '---\nname: bad-base\nbase: not-a-builtin\n---\nBody.\n',
    );
    expect(loadCustomProfiles(dir)).toEqual([]);

    const missing = path.join(dir, 'does-not-exist');
    expect(loadCustomProfiles(missing)).toEqual([]);
    expect(findCustomProfile(missing, 'anything')).toBeNull();
  });

  it('skills_field_is_parsed_for_runtime_snapshot', () => {
    const dir = tempDir();
    writeAgentFile(
      dir,
      'with-skills.md',
      '---\nname: with-skills\nskills: [research, code-review]\n---\nBody.\n',
    );

    const profile = findCustomProfile(dir, 'with-skills')!;
    expect(profile.skills).toEqual(['research', 'code-review']);
  });

  it('reasoning_effort_is_parsed_for_runtime_use', () => {
    const dir = tempDir();
    writeAgentFile(
      dir,
      'reasoning.md',
      '---\nname: reasoning-agent\nreasoning_effort: xhigh\n---\nBody.\n',
    );

    const profile = findCustomProfile(dir, 'reasoning-agent')!;
    expect(profile.reasoningEffort).toBe('xhigh');
    expect(runtimeConfigFromProfile(profile).reasoningEffort).toBe('xhigh');
  });

  it('unsupported_permission_and_context_fields_are_rejected', () => {
    const dir = tempDir();
    writeAgentFile(
      dir,
      'permissions.md',
      '---\nname: permissions-agent\npermissions: workspace-write\n---\nBody.\n',
    );
    writeAgentFile(
      dir,
      'context.md',
      '---\nname: context-agent\ncontext_inheritance: full\n---\nBody.\n',
    );
    writeAgentFile(
      dir,
      'bad-reasoning.md',
      '---\nname: bad-reasoning\nreasoning_effort: unlimited\n---\nBody.\n',
    );

    expect(loadCustomProfiles(dir)).toEqual([]);
  });
});
