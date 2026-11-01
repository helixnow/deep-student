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
// 交互式块（choice/form/image）在 dstu-agent 的 genui_interaction.rs 中登记，
// executor 的 is_allowed_block_type = ALLOWED_GENERATIVE_UI_BLOCK_TYPES ∪ GENUI_NEW_BLOCK_TYPES。
const GENUI_INTERACTION_RS = join(
  HERE,
  '../../../../../src-tauri/crates/dstu-agent/src/chat_v2/tools/genui_interaction.rs',
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

/** 从 genui_interaction.rs 提取 GENUI_NEW_BLOCK_TYPES，并确认 executor 确实把它并入白名单 */
function extractRustInteractiveTypes(interactionSource: string, executorSource: string): string[] {
  const match = interactionSource.match(/GENUI_NEW_BLOCK_TYPES: &\[&str\] = &\[([\s\S]*?)\];/);
  expect(match, 'genui_interaction.rs 应定义 GENUI_NEW_BLOCK_TYPES').toBeTruthy();
  expect(executorSource, 'executor 应把 GENUI_NEW_BLOCK_TYPES 并入白名单').toContain(
    'GENUI_NEW_BLOCK_TYPES',
  );
  return [...match![1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
}

describe('generative-ui 块类型白名单三处对齐', () => {
  const skillContentTypes = extractSkillContentTypes(generativeUiSkill.content);
  const registryTypes = generativeUIRegistry
    .getAll()
    .map((c) => c.type)
    .sort();
  const executorSource = readFileSync(EXECUTOR_RS, 'utf8');
  const rustTypes = [
    ...extractRustAllowedTypes(executorSource),
    ...extractRustInteractiveTypes(readFileSync(GENUI_INTERACTION_RS, 'utf8'), executorSource),
  ].sort();

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
