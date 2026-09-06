/**
 * P3 契约测试：generative-ui 块类型白名单三处对齐
 *
 * 白名单实际有三处：① builtin skill content 硬编码清单（模型可见）、
 * ② 前端 generativeUIRegistry（渲染闸门）、③ Rust
 * ALLOWED_GENERATIVE_UI_BLOCK_TYPES（持久化闸门）。三者漂移会导致
 * "模型按清单生成却被闸门拒绝"或"闸门放行但前端无法渲染"。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { generativeUiSkill } from '../builtin-tools/generative-ui';
import { generativeUIRegistry } from '@/features/generative-ui/registry';
// 内置块 import 即注册
import '@/features/generative-ui/blocks';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXECUTOR_RS = join(
  HERE,
  '../../../../../src-tauri/src/chat_v2/tools/generative_ui_executor.rs',
);

/** 从 skill content 的「可用 block type」节提取逗号分隔清单 */
function extractSkillContentTypes(content: string): string[] {
  const match = content.match(/## 可用 block type\s*\n\s*\n([a-z0-9\-,，\s]+)\n/i);
  expect(match, 'skill content 应包含「可用 block type」清单节').toBeTruthy();
  return match![1]
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 从 Rust 源码提取 ALLOWED_GENERATIVE_UI_BLOCK_TYPES 数组元素 */
function extractRustAllowedTypes(source: string): string[] {
  const match = source.match(
    /ALLOWED_GENERATIVE_UI_BLOCK_TYPES: &\[&str\] = &\[([\s\S]*?)\];/,
  );
  expect(match, 'executor 应定义 ALLOWED_GENERATIVE_UI_BLOCK_TYPES').toBeTruthy();
  return [...match![1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
}

describe('generative-ui 块类型白名单三处对齐', () => {
  const skillContentTypes = extractSkillContentTypes(generativeUiSkill.content);
  const registryTypes = generativeUIRegistry
    .getAll()
    .map((c) => c.type)
    .sort();
  const rustTypes = extractRustAllowedTypes(readFileSync(EXECUTOR_RS, 'utf8')).sort();

  it('skill content 清单 == 前端 registry', () => {
    expect([...skillContentTypes].sort()).toEqual(registryTypes);
  });

  it('skill content 清单 == Rust ALLOWED 列表', () => {
    expect([...skillContentTypes].sort()).toEqual(rustTypes);
  });

  it('清单非空（防退化）', () => {
    expect(skillContentTypes.length).toBeGreaterThanOrEqual(18);
  });
});
