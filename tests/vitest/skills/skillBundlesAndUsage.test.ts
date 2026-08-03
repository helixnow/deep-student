/**
 * 技能 Bundles 与使用遥测存储模块单元测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getSkillBundles,
  saveSkillBundle,
  deleteSkillBundle,
} from '../../../src/features/chat/skills/skillBundles';
import {
  recordSkillActivation,
  recordSkillToolLoad,
  getSkillUsage,
  getSkillUsageScore,
  clearSkillUsage,
} from '../../../src/features/chat/skills/skillUsageStats';

beforeEach(() => {
  localStorage.clear();
});

describe('skillBundles', () => {
  it('保存并读取组合', () => {
    const bundle = saveSkillBundle('学习组合', ['skill-a', 'skill-b']);
    expect(bundle).not.toBeNull();
    const all = getSkillBundles();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('学习组合');
    expect(all[0].skillIds).toEqual(['skill-a', 'skill-b']);
  });

  it('同名组合替换（更新语义）', () => {
    saveSkillBundle('组合', ['skill-a']);
    saveSkillBundle('组合', ['skill-b', 'skill-c']);
    const all = getSkillBundles();
    expect(all).toHaveLength(1);
    expect(all[0].skillIds).toEqual(['skill-b', 'skill-c']);
  });

  it('技能 ID 去重', () => {
    const bundle = saveSkillBundle('去重', ['a', 'a', 'b']);
    expect(bundle?.skillIds).toEqual(['a', 'b']);
  });

  it('空名称或空技能列表返回 null', () => {
    expect(saveSkillBundle('  ', ['a'])).toBeNull();
    expect(saveSkillBundle('名称', [])).toBeNull();
    expect(getSkillBundles()).toHaveLength(0);
  });

  it('删除组合', () => {
    const bundle = saveSkillBundle('待删', ['a'])!;
    deleteSkillBundle(bundle.id);
    expect(getSkillBundles()).toHaveLength(0);
  });

  it('损坏的存储数据降级为空列表', () => {
    localStorage.setItem('skills.bundles.v1', '{not-json');
    expect(getSkillBundles()).toEqual([]);
  });
});

describe('skillUsageStats', () => {
  it('记录激活与工具加载', () => {
    recordSkillActivation('skill-x');
    recordSkillActivation('skill-x');
    recordSkillToolLoad('skill-x');
    const usage = getSkillUsage('skill-x');
    expect(usage?.activations).toBe(2);
    expect(usage?.toolLoads).toBe(1);
    expect(usage?.lastUsedAt).toBeGreaterThan(0);
  });

  it('使用分：激活权重高于工具加载', () => {
    recordSkillActivation('skill-a'); // 3 分
    recordSkillToolLoad('skill-b'); // 1 分
    recordSkillToolLoad('skill-b'); // 2 分
    expect(getSkillUsageScore('skill-a')).toBeGreaterThan(getSkillUsageScore('skill-b'));
    expect(getSkillUsageScore('unknown')).toBe(0);
  });

  it('清理指定技能的记录', () => {
    recordSkillActivation('skill-x');
    clearSkillUsage('skill-x');
    expect(getSkillUsage('skill-x')).toBeUndefined();
  });

  it('损坏的存储数据降级为空记录', () => {
    localStorage.setItem('skills.usage.stats.v1', 'null');
    expect(getSkillUsage('any')).toBeUndefined();
    // 降级后仍可正常写入
    recordSkillActivation('any');
    expect(getSkillUsage('any')?.activations).toBe(1);
  });
});
