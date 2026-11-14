import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNodeFiles } from '../../../platform/files/index.ts';
import { CustomModeManager, sanitizeLoadedConfig } from '../src/essay_grading/custom_modes.ts';
import type { CreateModeInput } from '../src/essay_grading/custom_modes.ts';
import type { GradingMode } from '../src/essay_grading/types.ts';

function tempManager(tag: string): { manager: CustomModeManager; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), `essay_custom_modes_test_${tag}_`));
  return { manager: new CustomModeManager(dir, createNodeFiles({ roots: [{ name: 'temp', path: dir }] })), dir };
}

function sampleInput(name: string): CreateModeInput {
  return {
    name,
    description: '测试模式',
    systemPrompt: '按测试标准批改',
    scoreDimensions: [{ name: '内容', maxScore: 10, description: null }],
    totalMaxScore: 10,
  };
}

async function errorMessage(action: () => unknown): Promise<string> {
  try {
    await action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the call to throw');
}

describe('custom_modes.rs', () => {
  it('create_rejects_duplicate_and_builtin_names', async () => {
    const { manager, dir } = tempManager('dup');
    try {
      await manager.createMode(sampleInput('我的模式'));
      // trim + 大小写不敏感重名
      const duplicate = await errorMessage(() => manager.createMode(sampleInput('  我的模式  ')));
      expect(duplicate.includes('已存在')).toBe(true);
      // 与预置模式重名
      const builtin = await errorMessage(() => manager.createMode(sampleInput('高考作文')));
      expect(builtin.includes('预置')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('create_validates_prompt_and_scores', async () => {
    const { manager, dir } = tempManager('validate');
    try {
      // 空提示词允许（共享指令兜底），超长提示词拒绝
      await expect(manager.createMode({ ...sampleInput('空提示词'), systemPrompt: '' })).resolves.toBeDefined();
      await expect(manager.createMode({ ...sampleInput('超长提示词'), systemPrompt: '长'.repeat(20001) })).rejects.toThrow();

      await expect(manager.createMode({ ...sampleInput('非法总分'), totalMaxScore: Number.NaN })).rejects.toThrow();

      await expect(manager.createMode({
        ...sampleInput('维度重复'),
        scoreDimensions: [
          { name: '内容', maxScore: 5, description: null },
          { name: ' 内容 ', maxScore: 5, description: null },
        ],
      })).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('delete_protects_builtin_modes_and_removes_custom', async () => {
    const { manager, dir } = tempManager('delete');
    try {
      const created = await manager.createMode(sampleInput('可删除'));
      // 预置 ID（含别名）受保护
      await expect(manager.deleteMode('practice')).rejects.toThrow();
      await expect(manager.deleteMode('cet4')).rejects.toThrow();
      // 自定义模式可删除
      await expect(manager.deleteMode(created.id)).resolves.toBeUndefined();
      expect(await manager.getMode(created.id)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builtin_override_requires_real_builtin_and_canonicalizes_alias', async () => {
    const { manager, dir } = tempManager('override');
    try {
      const base = sampleInput('四六级微调');
      const missing = await errorMessage(() => manager.saveBuiltinOverride({
        builtinId: 'no_such_mode',
        name: base.name,
        description: base.description,
        systemPrompt: base.systemPrompt,
        scoreDimensions: base.scoreDimensions,
        totalMaxScore: base.totalMaxScore,
      }));
      expect(missing.includes('不存在')).toBe(true);

      const saved = await manager.saveBuiltinOverride({
        builtinId: 'cet4',
        name: base.name,
        description: base.description,
        systemPrompt: base.systemPrompt,
        scoreDimensions: base.scoreDimensions,
        totalMaxScore: base.totalMaxScore,
      });
      expect(saved.id).toBe('cet');
      expect(await manager.hasBuiltinOverride('cet6')).toBe(true);
      await manager.resetBuiltinMode('cet46');
      expect(await manager.hasBuiltinOverride('cet')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sanitize_drops_corrupted_entries_and_dedupes_by_id', () => {
    const now = new Date().toISOString();
    const valid = (id: string, name: string): GradingMode => ({
      id,
      name,
      description: '',
      systemPrompt: 'p',
      scoreDimensions: [{ name: '内容', maxScore: 10, description: null }],
      totalMaxScore: 10,
      isBuiltin: false,
      createdAt: now,
      updatedAt: now,
    });
    const broken = { ...valid('bad', '坏记录'), totalMaxScore: Number.NaN };
    const old = valid('dup', '旧版本');
    const fresh = valid('dup', '新版本');
    const keep = valid('ok', '正常');

    const config = sanitizeLoadedConfig({ modes: [broken, old, fresh, keep] });
    expect(config.modes.length).toBe(2);
    expect(config.modes[0]?.id).toBe('dup');
    expect(config.modes[0]?.name).toBe('新版本');
    expect(config.modes[1]?.id).toBe('ok');
  });

  it('save_config_writes_serde_pretty_with_f32_spelling', async () => {
    const { manager, dir } = tempManager('serde');
    try {
      const mode = await manager.createMode({ ...sampleInput('拼写模式'), scoreDimensions: [{ name: '内容', maxScore: 10, description: null },
        { name: '语言', maxScore: 7.5, description: '通顺' }], totalMaxScore: 17.5 });
      // custom_modes.rs:116 serde_json::to_string_pretty(CustomModesConfig); types.rs f32 fields keep `.0`.
      expect(readFileSync(join(dir, 'custom_grading_modes.json'), 'utf8')).toBe([
        '{', '  "modes": [', '    {',
        `    "id": ${JSON.stringify(mode.id)},`.replace(/^/, '  '),
        '      "name": "拼写模式",', '      "description": "测试模式",', '      "system_prompt": "按测试标准批改",',
        '      "score_dimensions": [',
        '        {', '          "name": "内容",', '          "max_score": 10.0,', '          "description": null', '        },',
        '        {', '          "name": "语言",', '          "max_score": 7.5,', '          "description": "通顺"', '        }',
        '      ],', '      "total_max_score": 17.5,', '      "is_builtin": false,',
        `      "created_at": ${JSON.stringify(mode.createdAt)},`, `      "updated_at": ${JSON.stringify(mode.updatedAt)}`,
        '    }', '  ]', '}',
      ].join('\n'));
      const reopened = new CustomModeManager(dir, createNodeFiles({ roots: [{ name: 'temp', path: dir }] }));
      expect((await reopened.getMode(mode.id))?.scoreDimensions[0]?.maxScore).toBe(10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
