import { afterEach, describe, expect, it } from 'vitest';

import { skillRegistry } from '../registry';
import {
  clearSessionAvailableSkillsSnapshot,
  clearSessionSkills,
  DEFAULT_PROGRESSIVE_DISCLOSURE_CONFIG,
  generateAvailableSkillsPrompt,
  getLoadedSkills,
  getProgressiveDisclosureConfig,
  getSessionAvailableSkillsPrompt,
  handleLoadSkillsToolCall,
  hasSessionAvailableSkillsSnapshot,
  hydrateSessionAvailableSkillsSnapshot,
} from '../progressiveDisclosure';
import { setSkillDisabled } from '../skillEnableStorage';
import { __setRequiresGateForTest } from '../requiresGating';
import type { SkillDefinition } from '../types';

describe('progressive disclosure defaults', () => {
  afterEach(() => {
    for (const id of [
      'legacy-load-test-skill',
      'untrusted-runtime-skill',
      'disabled-runtime-skill',
      'gated-runtime-skill',
      'snapshot-base-skill',
      'snapshot-installed-mid-session-skill',
    ]) {
      skillRegistry.unregister(id);
      setSkillDisabled(id, false);
      __setRequiresGateForTest(id, null);
    }
    clearSessionSkills('legacy-load-test-session');
    clearSessionAvailableSkillsSnapshot('snapshot-session-a');
    clearSessionAvailableSkillsSnapshot('snapshot-session-b');
    clearSessionAvailableSkillsSnapshot('snapshot-empty-session');
    clearSessionAvailableSkillsSnapshot('restart-session');
    clearSessionAvailableSkillsSnapshot('restart-fresh-session');
  });

  it('does not auto-load skills by default', () => {
    expect(DEFAULT_PROGRESSIVE_DISCLOSURE_CONFIG.autoLoadSkills).toEqual([]);
    expect(getProgressiveDisclosureConfig().autoLoadSkills).toEqual([]);
  });

  it('legacy load_skills handler returns light metadata without skill instructions', () => {
    const skill: SkillDefinition = {
      id: 'legacy-load-test-skill',
      name: 'Legacy Load Test Skill',
      description: 'Ensures legacy tool result stays lightweight',
      location: 'builtin',
      sourcePath: 'builtin://legacy-load-test-skill',
      content: 'private legacy skill instructions',
      embeddedTools: [
        {
          name: 'builtin-legacy_test_tool',
          description: 'Legacy test tool',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    };
    skillRegistry.register(skill);

    const result = handleLoadSkillsToolCall('legacy-load-test-session', {
      skills: ['legacy-load-test-skill'],
    });

    expect(result).not.toContain('<skill_loaded');
    expect(result).not.toContain('<instructions>');
    expect(result).not.toContain('private legacy skill instructions');
    expect(JSON.parse(result)).toMatchObject({
      result: {
        status: 'success',
        loaded_skill_ids: ['legacy-load-test-skill'],
        loaded_tool_names: ['builtin-legacy_test_tool'],
        loaded_tools: [{
          name: 'builtin-legacy_test_tool',
          skill_id: 'legacy-load-test-skill',
        }],
      },
    });
  });

  it('keeps the available_skills catalog constant after load_skills (loaded state lives in the tool result)', () => {
    // 缓存前缀约束（ROUND-01-cache-prefix R1 / ROUND-02-synthesis P1-8）：
    // 技能加载后目录不得从 system 收缩，否则 system 前缀从第 0 字节变化，
    // 整段历史 prompt cache 失效。已加载状态由 tool result 表达。
    const skill: SkillDefinition = {
      id: 'legacy-load-test-skill',
      name: 'Legacy Load Test Skill',
      description: 'Catalog must stay constant across loads',
      location: 'builtin',
      sourcePath: 'builtin://legacy-load-test-skill',
      content: '# body',
      embeddedTools: [
        {
          name: 'builtin-legacy_test_tool',
          description: 'Legacy test tool',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    };
    skillRegistry.register(skill);

    const promptBefore = generateAvailableSkillsPrompt();
    expect(promptBefore).toContain('id="legacy-load-test-skill"');

    const result = JSON.parse(handleLoadSkillsToolCall('legacy-load-test-session', {
      skills: ['legacy-load-test-skill'],
    }));
    expect(result.result.loaded_skill_ids).toContain('legacy-load-test-skill');

    // 目录恒定：加载前后逐字节一致，已加载技能不从 system 目录剔除
    const promptAfter = generateAvailableSkillsPrompt();
    expect(promptAfter).toBe(promptBefore);
    expect(promptAfter).toContain('id="legacy-load-test-skill"');
  });

  it('freezes the available_skills catalog per session across mid-session skill_install', () => {
    // P0 回归（会话目录快照）：目录直接拼进 system（第 0 字节前缀）。
    // 会话中途 skill_install 改写 live registry 后，同一 session 已发出的
    // available_skills 必须逐字节不变（新技能由 tool result / 瞬态消息表达）；
    // 新 session 首次生成时才看到新技能。
    skillRegistry.register({
      id: 'snapshot-base-skill',
      name: 'Snapshot Base Skill',
      description: 'Catalog snapshot regression: pre-existing skill',
      location: 'builtin',
      sourcePath: 'builtin://snapshot-base-skill',
      content: '# base',
    });

    const firstCatalog = getSessionAvailableSkillsPrompt('snapshot-session-a');
    expect(firstCatalog).toContain('id="snapshot-base-skill"');
    expect(firstCatalog).not.toContain('snapshot-installed-mid-session-skill');

    // 模拟会话中途 skill_install：live registry 变化
    skillRegistry.register({
      id: 'snapshot-installed-mid-session-skill',
      name: 'Snapshot Mid-Session Skill',
      description: 'Catalog snapshot regression: installed mid-session',
      location: 'global',
      sourcePath: '/tmp/snapshot/SKILL.md',
      trustStatus: 'trusted',
      content: '# installed',
    });

    // live 目录已经能看到新技能（证明变化确实发生了）
    expect(generateAvailableSkillsPrompt()).toContain(
      'id="snapshot-installed-mid-session-skill"'
    );

    // 同一 session：install 前后逐字节一致，新技能不进已发出的 system 目录
    const sameSessionCatalog = getSessionAvailableSkillsPrompt('snapshot-session-a');
    expect(sameSessionCatalog).toBe(firstCatalog);
    expect(sameSessionCatalog).not.toContain('snapshot-installed-mid-session-skill');

    // 新 session：首次生成时按当前 live registry 建立快照，能看到新技能
    const newSessionCatalog = getSessionAvailableSkillsPrompt('snapshot-session-b');
    expect(newSessionCatalog).toContain('id="snapshot-installed-mid-session-skill"');
    expect(newSessionCatalog).toContain('id="snapshot-base-skill"');
  });

  it('freezes an empty available_skills catalog for sessions that started before any install', () => {
    // 空目录同样冻结：目录为空时 system 没有 available_skills 段，
    // 中途安装若追加目录会改写 system 尾部、打碎该会话已积累的缓存前缀。
    const emptyCatalog = getSessionAvailableSkillsPrompt('snapshot-empty-session');

    skillRegistry.register({
      id: 'snapshot-installed-mid-session-skill',
      name: 'Snapshot Mid-Session Skill',
      description: 'Catalog snapshot regression: installed mid-session',
      location: 'global',
      sourcePath: '/tmp/snapshot/SKILL.md',
      trustStatus: 'trusted',
      content: '# installed',
    });

    expect(getSessionAvailableSkillsPrompt('snapshot-empty-session')).toBe(emptyCatalog);
  });

  it('restores the persisted catalog snapshot byte-for-byte after a simulated app restart', () => {
    // P0 回归（快照跨进程）：重启 ≠ provider 冷缓存。写快照 → 清内存 Map
    // （模拟重启）→ 用 session.metadata 持久化值 hydrate → 同一 session
    // 读回字节不变，即使重启前 live registry 已装入新技能；新 session
    // 仍按当前 live 目录建立快照。
    skillRegistry.register({
      id: 'snapshot-base-skill',
      name: 'Snapshot Base Skill',
      description: 'Catalog snapshot restart regression: pre-existing skill',
      location: 'builtin',
      sourcePath: 'builtin://snapshot-base-skill',
      content: '# base',
    });

    // 首次生成 = 写快照（真实流程中 TauriAdapter 同步持久化到 metadata）
    const firstCatalog = getSessionAvailableSkillsPrompt('restart-session');
    expect(firstCatalog).toContain('id="snapshot-base-skill"');
    const persistedSnapshot = firstCatalog;

    // 重启前中途装过技能：live registry 变化
    skillRegistry.register({
      id: 'snapshot-installed-mid-session-skill',
      name: 'Snapshot Mid-Session Skill',
      description: 'Catalog snapshot restart regression: installed pre-restart',
      location: 'global',
      sourcePath: '/tmp/snapshot/SKILL.md',
      trustStatus: 'trusted',
      content: '# installed',
    });

    // 模拟应用重启：内存 Map 清空
    clearSessionAvailableSkillsSnapshot('restart-session');
    expect(hasSessionAvailableSkillsSnapshot('restart-session')).toBe(false);

    // session 加载路径：用持久化快照回灌内存（不重算 live 目录）
    hydrateSessionAvailableSkillsSnapshot('restart-session', persistedSnapshot);
    expect(hasSessionAvailableSkillsSnapshot('restart-session')).toBe(true);

    const restoredCatalog = getSessionAvailableSkillsPrompt('restart-session');
    expect(restoredCatalog).toBe(persistedSnapshot);
    expect(restoredCatalog).not.toContain('snapshot-installed-mid-session-skill');

    // 新 session 无持久化快照：仍按当前 live registry 建立
    const freshCatalog = getSessionAvailableSkillsPrompt('restart-fresh-session');
    expect(freshCatalog).toContain('id="snapshot-installed-mid-session-skill"');
    expect(freshCatalog).toContain('id="snapshot-base-skill"');
  });

  it('keeps untrusted descriptions and embedded schemas out of every runtime path', () => {
    const secret = 'UNTRUSTED_SECRET_DESCRIPTION';
    skillRegistry.register({
      id: 'untrusted-runtime-skill',
      name: 'Untrusted Runtime Skill',
      description: secret,
      location: 'global',
      sourcePath: '/tmp/untrusted/SKILL.md',
      trustStatus: 'untrusted',
      content: 'UNTRUSTED_SECRET_BODY',
      embeddedTools: [{
        name: 'builtin-untrusted_secret_tool',
        description: 'UNTRUSTED_SECRET_SCHEMA',
        inputSchema: { type: 'object', properties: {} },
      }],
    });

    expect(generateAvailableSkillsPrompt()).not.toContain('untrusted-runtime-skill');
    expect(generateAvailableSkillsPrompt()).not.toContain(secret);
    expect(skillRegistry.generateMetadataPrompt()).not.toContain(secret);

    const result = JSON.parse(handleLoadSkillsToolCall('legacy-load-test-session', {
      skills: ['untrusted-runtime-skill'],
    }));
    expect(result.result).toMatchObject({
      status: 'error',
      loaded_skill_ids: [],
      loaded_tool_names: [],
      rejected_skills: [{
        skillId: 'untrusted-runtime-skill',
        code: 'untrusted',
      }],
    });
    expect(getLoadedSkills('legacy-load-test-session')).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('UNTRUSTED_SECRET_BODY');
    expect(JSON.stringify(result)).not.toContain('UNTRUSTED_SECRET_SCHEMA');
  });

  it('rejects disabled skills with an explicit disabled result', () => {
    skillRegistry.register({
      id: 'disabled-runtime-skill',
      name: 'Disabled Runtime Skill',
      description: 'Disabled load admission regression test',
      location: 'builtin',
      sourcePath: 'builtin://disabled-runtime-skill',
      trustStatus: 'builtin',
      content: '# disabled',
    });
    setSkillDisabled('disabled-runtime-skill', true);

    const result = JSON.parse(handleLoadSkillsToolCall('legacy-load-test-session', {
      skills: ['disabled-runtime-skill'],
    }));
    expect(result.result.status).toBe('error');
    expect(result.result.rejected_skills).toEqual([
      expect.objectContaining({
        skillId: 'disabled-runtime-skill',
        code: 'disabled',
        message: expect.stringMatching(/disabled/i),
      }),
    ]);
    expect(generateAvailableSkillsPrompt()).not.toContain('disabled-runtime-skill');
  });

  it('rejects manual load when requires are unsatisfied', () => {
    skillRegistry.register({
      id: 'gated-runtime-skill',
      name: 'Gated Runtime Skill',
      description: 'Requires gate load admission regression test',
      location: 'builtin',
      sourcePath: 'builtin://gated-runtime-skill',
      trustStatus: 'builtin',
      content: '# gated',
      requires: { bins: ['missing-tool'] },
    });
    __setRequiresGateForTest('gated-runtime-skill', {
      satisfied: false,
      missingBins: ['missing-tool'],
      missingEnv: [],
      missingPythonPackages: [],
    });

    const result = JSON.parse(handleLoadSkillsToolCall('legacy-load-test-session', {
      skills: ['gated-runtime-skill'],
    }));
    expect(result.result.status).toBe('error');
    expect(result.result.rejected_skills).toEqual([
      expect.objectContaining({
        skillId: 'gated-runtime-skill',
        code: 'requires_unsatisfied',
        message: expect.stringContaining('missing command missing-tool'),
      }),
    ]);
    expect(getLoadedSkills('legacy-load-test-session')).toEqual([]);
  });
});
