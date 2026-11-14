/**
 * P3 契约测试：generative-ui 块类型白名单对齐
 *
 * 白名单有两处：① builtin skill content 硬编码清单（模型可见）、
 * ② 前端 generativeUIRegistry（渲染闸门）。两者漂移会导致
 * "模型按清单生成却无法渲染"。
 */

import { describe, expect, it } from 'vitest';

import { generativeUiSkill } from '../builtin-tools/generative-ui';
import { generativeUIRegistry } from '@/features/generative-ui/registry';
// 内置块 import 即注册
import '@/features/generative-ui/blocks';

/** 从 skill content 的「可用 block type」节提取逗号分隔清单 */
function extractSkillContentTypes(content: string): string[] {
  const match = content.match(/## 可用 block type\s*\n\s*\n([a-z0-9\-,，\s]+)\n/i);
  expect(match, 'skill content 应包含「可用 block type」清单节').toBeTruthy();
  return match![1]
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

describe('generative-ui 块类型白名单对齐', () => {
  const skillContentTypes = extractSkillContentTypes(generativeUiSkill.content);
  const registryTypes = generativeUIRegistry
    .getAll()
    .map((c) => c.type)
    .sort();

  it('skill content 清单 == 前端 registry', () => {
    expect([...skillContentTypes].sort()).toEqual(registryTypes);
  });

  it('清单非空（防退化）', () => {
    expect(skillContentTypes.length).toBeGreaterThanOrEqual(18);
  });
});
