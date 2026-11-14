import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { customProfileSource, validatePersonaModelConfig, type JsonValue } from '../api.ts';
import {
  AgentProfileResolver, EXPLORER_PROFILE_ID, WORKER_PROFILE_ID,
  DEFAULT_PROFILE_ID, runtimeConfigFromProfile,
} from '../src/workspace/agent-profile.ts';
import { grantsScopeHint, isHeadlessAllowedTool } from '../src/workspace/tool-registry.ts';
import { newWorkspaceAgent } from '../src/workspace/types.ts';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-agent-profile-'));
}

describe('agent_profile', () => {
  it('legacy_skill_resolves_to_real_worker_profile', () => {
    const profile = AgentProfileResolver.resolve({ skillId: 'code_review' });
    expect(profile.id).toBe(WORKER_PROFILE_ID);
    expect(profile.skills).toEqual(['code_review']);
    expect(profile.allowedTools).toEqual([]);
  });

  it('built_in_tools_use_real_executor_names', () => {
    for (const id of [DEFAULT_PROFILE_ID, WORKER_PROFILE_ID, EXPLORER_PROFILE_ID]) {
      const profile = AgentProfileResolver.builtIn(id);
      expect(profile).not.toBeNull();
      expect(profile!.allowedTools.every(tool => tool.startsWith('builtin-'))).toBe(true);
      expect(profile!.allowedTools).not.toContain('builtin-workspace_send');
      expect(profile!.allowedTools).not.toContain('builtin-workspace_query');
    }
  });

  // G01-e：内建 profile 声明的每个工具必须是注册表已登记的内建工具。
  it('built_in_profile_tools_are_registry_builtins', () => {
    for (const id of [DEFAULT_PROFILE_ID, WORKER_PROFILE_ID, EXPLORER_PROFILE_ID]) {
      const profile = AgentProfileResolver.builtIn(id)!;
      for (const tool of profile.allowedTools) {
        expect(grantsScopeHint(tool), `profile ${id} 的工具 ${tool} 必须是注册表已登记的 Builtin 族内建工具`)
          .toBe('builtin');
      }
    }
  });

  it('explorer_extra_tools_are_headless_read_only_subset', () => {
    const profile = AgentProfileResolver.builtIn(EXPLORER_PROFILE_ID)!;
    for (const tool of profile.allowedTools.filter(item => !item.startsWith('builtin-workspace_'))) {
      expect(isHeadlessAllowedTool(tool), `explorer tool ${tool} must be part of the headless read-only whitelist`)
        .toBe(true);
    }
  });

  it('description_is_trimmed_and_empty_becomes_none', () => {
    const profile = AgentProfileResolver.builtIn(DEFAULT_PROFILE_ID)!;
    profile.description = '  一句话简介  ';
    AgentProfileResolver.validateAndNormalize(profile);
    expect(profile.description).toBe('一句话简介');

    profile.description = '   ';
    AgentProfileResolver.validateAndNormalize(profile);
    expect(profile.description).toBeNull();

    // 旧持久化 metadata 无 description 字段：缺失字段反序列化安全。
    const legacy: JsonValue = {
      agent_profile: {
        id: 'worker',
        instructions: 'legacy instructions',
      },
    };
    const restored = AgentProfileResolver.fromMetadata(legacy);
    expect(restored).not.toBeNull();
    expect(restored!.description).toBeNull();
  });

  it('persisted_profile_round_trips_as_runtime_config', () => {
    const profile = AgentProfileResolver.builtIn(EXPLORER_PROFILE_ID)!;
    const metadata = AgentProfileResolver.persistIntoMetadata(undefined, profile);
    const restored = AgentProfileResolver.fromMetadata(metadata);
    expect(restored).not.toBeNull();
    expect(runtimeConfigFromProfile(restored!).modelId).toBe(profile.model);
    expect(restored).toEqual(profile);
  });

  it('overrides_are_normalized_and_directly_consumable', () => {
    const profile = AgentProfileResolver.resolve({
      profileId: DEFAULT_PROFILE_ID,
      overrides: {
        model: ' model-config-1 ',
        allowedTools: ['builtin-web_search', 'builtin-web_search'],
      },
    });
    const runtime = runtimeConfigFromProfile(profile);
    expect(runtime.modelId).toBe('model-config-1');
    expect(runtime.allowedTools).toEqual(['builtin-web_search']);
  });

  it('resolve_with_custom_falls_back_to_directory_and_applies_overrides', () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, 'paper-summarizer.md'),
      '---\nname: paper-summarizer\nbase: explorer\nmodel: file-model\n---\nSummarize papers.\n',
    );

    // 内建优先：worker 不会被目录内容影响。
    const builtIn = AgentProfileResolver.resolveWithCustom(
      { profileId: WORKER_PROFILE_ID },
      customProfileSource(dir),
    );
    expect(builtIn.id).toBe(WORKER_PROFILE_ID);

    // 内建没有 → 查 custom；overrides（model）在 custom 上生效。
    const custom = AgentProfileResolver.resolveWithCustom(
      { profileId: 'paper-summarizer', overrides: { model: 'override-model' } },
      customProfileSource(dir),
    );
    expect(custom.id).toBe('paper-summarizer');
    expect(custom.instructions).toBe('Summarize papers.');
    expect(custom.model).toBe('override-model');

    // 都没有 → 错误信息列出内建 + 自定义全部可用 id。
    expect(() => AgentProfileResolver.resolveWithCustom({ profileId: 'nonexistent' }, customProfileSource(dir)))
      .toThrow(/default.*worker.*explorer.*paper-summarizer/);

    // customDir=null 等价原 resolve：仅列内建。
    expect(() => AgentProfileResolver.resolveWithCustom({ profileId: 'paper-summarizer' }, null))
      .toThrow(/Unknown agent profile/);
  });

  it('legacy_agent_row_is_runtime_consumable', () => {
    const agent = newWorkspaceAgent('agent-1', 'ws-1', 'worker');
    agent.skillId = 'research';
    const runtime = AgentProfileResolver.runtimeConfigForAgent(agent);
    expect(runtime.skillIds).toEqual(['research']);
    expect(runtime.allowedTools).toEqual([]);

    const explorer = newWorkspaceAgent('agent-2', 'ws-1', 'worker');
    explorer.skillId = 'explorer';
    const explorerRuntime = AgentProfileResolver.runtimeConfigForAgent(explorer);
    expect(explorerRuntime.allowedTools.length).toBeGreaterThan(0);
  });

  it('persona_model_validation_requires_exact_enabled_generation_config_id', () => {
    const configs = [
      { id: 'local-chat', enabled: true, model: 'shared-model-name' },
      { id: 'disabled-chat', enabled: false, model: 'disabled' },
      { id: 'embedding', enabled: true, isEmbedding: true, model: 'embedding' },
    ];

    expect(() => validatePersonaModelConfig('local-chat', configs)).not.toThrow();
    expect(() => validatePersonaModelConfig(' \u0085local-chat\u0085 ', configs)).not.toThrow();
    expect(() => validatePersonaModelConfig('shared-model-name', configs))
      .toThrow(new Error("PERSONA_MODEL_NOT_FOUND: model configuration id 'shared-model-name' does not exist"));
    expect(() => validatePersonaModelConfig('disabled-chat', configs))
      .toThrow(new Error("PERSONA_MODEL_DISABLED: model configuration 'disabled-chat' is disabled or has no usable authentication"));
    expect(() => validatePersonaModelConfig('embedding', configs))
      .toThrow(new Error("PERSONA_MODEL_UNSUPPORTED: model configuration 'embedding' is not a chat generation model"));
    for (const flag of ['isEmbedding', 'isReranker', 'isImageGeneration'] as const) {
      expect(() => validatePersonaModelConfig('non-chat', [{ id: 'non-chat', enabled: true, [flag]: true }]))
        .toThrow(new Error("PERSONA_MODEL_UNSUPPORTED: model configuration 'non-chat' is not a chat generation model"));
    }
    expect(() => validatePersonaModelConfig('first-match', [
      { id: 'first-match', enabled: false, isEmbedding: true },
      { id: 'first-match', enabled: true },
    ])).toThrow(new Error("PERSONA_MODEL_DISABLED: model configuration 'first-match' is disabled or has no usable authentication"));
  });

  it('computed_hash_is_stable_and_content_locked', () => {
    const profile = AgentProfileResolver.builtIn(EXPLORER_PROFILE_ID)!;
    const hashA = AgentProfileResolver.computedHash(profile);
    const hashB = AgentProfileResolver.computedHash(profile);
    expect(hashA).toBe(hashB);
    expect(hashA).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(hashA)).toBe(true);

    // 内容任何变化（含白名单顺序）必须改变哈希。
    const mutated = { ...profile, allowedTools: [...profile.allowedTools, 'builtin-memory_read'] };
    expect(AgentProfileResolver.computedHash(mutated)).not.toBe(hashA);

    const worker = AgentProfileResolver.builtIn(WORKER_PROFILE_ID)!;
    expect(AgentProfileResolver.computedHash(worker)).not.toBe(hashA);
  });
});
