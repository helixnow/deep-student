/**
 * WI-10: 内置 Skill 组 Token 预算基准测试
 *
 * 目标：为渐进披露架构下每个 builtin skill 组的 embeddedTools schema
 * 建立可回归的 token 预算基线，防止 schema 无节制膨胀吞掉上下文窗口。
 *
 * 测量口径：
 * - schema: JSON.stringify(skill.embeddedTools)，即技能激活后注入 LLM 请求的工具定义
 * - content: skill.content，即技能激活后注入 system prompt 的指令文本
 *
 * Token 估算说明：
 * `@dqbd/tiktoken` 不在项目 npm 依赖中（精确计数走 Rust 侧 tiktoken-rs 的
 * `estimate_tokens` Tauri 命令，测试环境不可用）。为保证测试离线、确定性且
 * 零新增依赖，这里采用 chars/4 的经典近似（OpenAI 对英文文本的经验值）。
 * 注意：schema/content 中的中文描述实际 token 密度更高（≈1 token/汉字），
 * 因此该估算是「下界」；但作为组间相对排序与回归护栏的基准足够稳定。
 *
 * 生成报告：设置环境变量 TOKEN_BUDGET_REPORT_PATH 指向输出文件后运行本测试，
 * 会写出完整排名的 markdown 表格（用于 docs/dev/optimization0824/progress/）。
 *
 * @see docs/dev/optimization0824/progress/R1-WI-10.md
 */

import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import * as builtinToolModules from '../../../src/features/chat/skills/builtin-tools';
import type { SkillDefinition, ToolSchema } from '../../../src/features/chat/skills/types';

// ============================================================================
// 技能收集：从模块命名导出收集全部 builtin skill，绕过 index.ts 里
// filterBuiltinToolSkillsForPlatform 的平台过滤（jsdom 下 browser-tools
// 会被滤掉），保证基线覆盖所有组且与运行平台无关。
// ============================================================================

function isSkillDefinition(value: unknown): value is SkillDefinition {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<SkillDefinition>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.content === 'string' &&
    typeof candidate.sourcePath === 'string'
  );
}

function collectBuiltinSkills(): SkillDefinition[] {
  const seen = new Map<string, SkillDefinition>();
  for (const exported of Object.values(builtinToolModules)) {
    if (isSkillDefinition(exported) && !seen.has(exported.id)) {
      seen.set(exported.id, exported);
    }
  }
  return [...seen.values()];
}

// ============================================================================
// Token 估算（chars/4 近似，理由见文件头注释）
// ============================================================================

const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function serializeSchemas(tools: readonly ToolSchema[] | undefined): string {
  return JSON.stringify(tools ?? []);
}

interface SkillTokenBudget {
  id: string;
  name: string;
  toolCount: number;
  schemaChars: number;
  schemaTokens: number;
  contentChars: number;
  contentTokens: number;
  totalTokens: number;
}

function measureSkill(skill: SkillDefinition): SkillTokenBudget {
  const schemaJson = serializeSchemas(skill.embeddedTools);
  const schemaTokens = estimateTokens(schemaJson);
  const contentTokens = estimateTokens(skill.content);
  return {
    id: skill.id,
    name: skill.name,
    toolCount: skill.embeddedTools?.length ?? 0,
    schemaChars: schemaJson.length,
    schemaTokens,
    contentChars: skill.content.length,
    contentTokens,
    totalTokens: schemaTokens + contentTokens,
  };
}

/** 按 schema token 降序排名；同分按 id 升序保证确定性。 */
function rankBySchemaTokens(budgets: readonly SkillTokenBudget[]): SkillTokenBudget[] {
  return [...budgets].sort(
    (a, b) => b.schemaTokens - a.schemaTokens || a.id.localeCompare(b.id),
  );
}

function formatMarkdownReport(ranked: readonly SkillTokenBudget[]): string {
  const total = ranked.reduce(
    (acc, b) => ({
      toolCount: acc.toolCount + b.toolCount,
      schemaChars: acc.schemaChars + b.schemaChars,
      schemaTokens: acc.schemaTokens + b.schemaTokens,
      contentTokens: acc.contentTokens + b.contentTokens,
      totalTokens: acc.totalTokens + b.totalTokens,
    }),
    { toolCount: 0, schemaChars: 0, schemaTokens: 0, contentTokens: 0, totalTokens: 0 },
  );
  const lines = [
    '| # | Skill 组 | 名称 | 工具数 | schema 字符 | schema tokens (est.) | content tokens (est.) | 合计 tokens (est.) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...ranked.map(
      (b, i) =>
        `| ${i + 1} | \`${b.id}\` | ${b.name} | ${b.toolCount} | ${b.schemaChars} | ${b.schemaTokens} | ${b.contentTokens} | ${b.totalTokens} |`,
    ),
    `| — | **合计** | — | ${total.toolCount} | ${total.schemaChars} | ${total.schemaTokens} | ${total.contentTokens} | ${total.totalTokens} |`,
  ];
  return lines.join('\n');
}

// ============================================================================
// 回归护栏基线（2026-08-24，chars/4 口径）
//
// R1 基线：最大单组 7389 / schema 合计 54050 / 总计 75689，护栏 9500/68000/95000
// （≈25% 余量）。R2-R4 三轮精简（全部 43 组 description slim）后实测：
// 最大单组 schema = 6172 tokens（qbank-tools），43 组 schema 合计 = 46671，
// schema+content 合计 = 68310。R4 起护栏按新总量收紧为 ≈10% 余量，
// 防止精简成果被增量回吃。若新增技能或 schema 合理增长导致越线，
// 请有意识地上调并在 docs/dev/optimization0824/progress/R4-WI-10-full.md 记录原因。
// ============================================================================

const MAX_SINGLE_GROUP_SCHEMA_TOKENS = 6_800;
const MAX_TOTAL_SCHEMA_TOKENS = 51_500;
const MAX_TOTAL_TOKENS = 75_500;

// ============================================================================
// 测试
// ============================================================================

describe('builtin skill schema token budget baseline (WI-10)', () => {
  const skills = collectBuiltinSkills();
  const budgets = skills.map(measureSkill);
  const ranked = rankBySchemaTokens(budgets);

  it('discovers all builtin skill groups with unique ids', () => {
    expect(skills.length).toBeGreaterThanOrEqual(40);
    const ids = skills.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('serializes every group schema to valid, round-trippable JSON', () => {
    for (const skill of skills) {
      const json = serializeSchemas(skill.embeddedTools);
      const parsed = JSON.parse(json) as ToolSchema[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(skill.embeddedTools?.length ?? 0);
      for (const tool of parsed) {
        expect(typeof tool.name).toBe('string');
        expect(tool.name.length).toBeGreaterThan(0);
        expect(typeof tool.description).toBe('string');
        expect(tool.inputSchema.type).toBe('object');
      }
    }
  });

  it('token estimator is deterministic and monotonic', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    for (const skill of skills) {
      const json = serializeSchemas(skill.embeddedTools);
      expect(estimateTokens(json)).toBe(estimateTokens(json));
    }
    const sample = serializeSchemas(skills[0]?.embeddedTools);
    expect(estimateTokens(sample + 'xxxx')).toBeGreaterThanOrEqual(estimateTokens(sample));
  });

  it('produces a deterministic Top 10 ranking sorted by schema tokens desc', () => {
    const top10 = ranked.slice(0, 10);
    expect(top10.length).toBe(10);
    for (let i = 1; i < top10.length; i++) {
      expect(top10[i - 1].schemaTokens).toBeGreaterThanOrEqual(top10[i].schemaTokens);
    }
    // 排名两次计算结果一致（防御排序不稳定）
    const rerank = rankBySchemaTokens(skills.map(measureSkill));
    expect(rerank.map((b) => b.id)).toEqual(ranked.map((b) => b.id));
  });

  it('every group stays within the single-group schema token budget', () => {
    const offenders = ranked.filter((b) => b.schemaTokens > MAX_SINGLE_GROUP_SCHEMA_TOKENS);
    expect(
      offenders.map((b) => `${b.id}=${b.schemaTokens}`),
      `以下 skill 组 schema 超出单组预算 ${MAX_SINGLE_GROUP_SCHEMA_TOKENS} tokens（chars/4 估算），` +
        '请精简 schema 或有意识地上调预算并在 R1-WI-10.md 记录',
    ).toEqual([]);
  });

  it('aggregate schema and total budgets stay within baseline ceilings', () => {
    const totalSchema = ranked.reduce((sum, b) => sum + b.schemaTokens, 0);
    const totalAll = ranked.reduce((sum, b) => sum + b.totalTokens, 0);
    expect(totalSchema).toBeGreaterThan(0);
    expect(totalSchema).toBeLessThanOrEqual(MAX_TOTAL_SCHEMA_TOKENS);
    expect(totalAll).toBeLessThanOrEqual(MAX_TOTAL_TOKENS);
  });

  it('emits markdown report when TOKEN_BUDGET_REPORT_PATH is set', () => {
    const reportPath = process.env.TOKEN_BUDGET_REPORT_PATH;
    if (!reportPath) return; // 仅作为报告生成入口，默认跳过
    const report = formatMarkdownReport(ranked);
    writeFileSync(reportPath, `${report}\n`, 'utf-8');
    expect(report.length).toBeGreaterThan(0);
  });
});
