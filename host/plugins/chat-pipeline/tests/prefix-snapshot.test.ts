/**
 * chat_v2/pipeline/prefix_snapshot_tests.rs — cross-turn prompt-cache prefix
 * snapshots: stable system bytes, append-only tool order, combined prefix.
 */
import { describe, expect, it } from 'vitest';
import type { SourceInfo } from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import { CanvasNoteInfo, PromptBuilder, type SystemPromptParts } from '../src/prompt-builder.ts';
import {
  freezeToolSchemaOrderForPromptCache, mergeFrozenToolSchemaOrderBaseline, toolSchemaSortKey,
} from '../src/tool-face.ts';

function buildRound(round: number): SystemPromptParts {
  const rag: SourceInfo[] = [{
    title: `第${round}轮命中文档`, url: null, snippet: `第${round}轮检索命中内容`,
    score: 0.9, metadata: null,
  }];
  const canvas = new CanvasNoteInfo('note_1', `第${round}轮笔记`, `第${round}轮笔记内容`);
  return new PromptBuilder('你是稳定前缀测试助手')
    .withUserAppend('回答保持简洁')
    .withRagSources(rag)
    .withUserProfile(`第${round}轮画像`)
    .withActiveTodos(`1. 第${round}轮待办`)
    .withCanvasNote(canvas)
    .withContextTypeHints([`- <hint_round_${round}>`])
    .buildSplit();
}

function toolSchema(name: string, description: string): unknown {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties: {} },
    },
  };
}

/** Session baseline JSON persisted in `session.metadata.frozenToolSchemaOrder`. */
function persistRoundtrip(baseline: readonly string[]): string[] {
  return JSON.parse(JSON.stringify(baseline)) as string[];
}

function toolsBytes(tools: readonly unknown[]): Buffer {
  return Buffer.from(JSON.stringify(tools), 'utf8');
}

describe('chat_v2/pipeline/prefix_snapshot_tests.rs', () => {
  it('system_prefix_bytes_identical_across_rounds_while_volatile_inputs_change', () => {
    const rounds = [1, 2, 3].map(buildRound);

    for (let index = 0; index + 1 < rounds.length; index++) {
      expect(Buffer.from(rounds[index]!.stableSystem, 'utf8')
        .equals(Buffer.from(rounds[index + 1]!.stableSystem, 'utf8'))).toBe(true);
    }

    rounds.forEach((parts, index) => {
      const round = index + 1;
      const volatile = parts.turnVolatile;
      expect(volatile).not.toBeNull();
      expect(volatile).toContain(`1. 第${round}轮待办`);
      expect(volatile).toContain(`第${round}轮笔记`);
      expect(volatile).toContain(`第${round}轮检索命中内容`);
      expect(volatile).toContain(`第${round}轮画像`);
    });
    expect(rounds[0]!.turnVolatile).not.toBe(rounds[1]!.turnVolatile);
  });

  it('todos_and_canvas_never_leak_into_stable_system', () => {
    const parts = buildRound(1);
    for (const tag of ['<active_todos>', '<canvas_note>', '<user_profile>',
      '<learner_profile>', '<context>', '<user_message_format_guide>']) {
      expect(parts.stableSystem, `turn-volatile tag ${tag} leaked into stable system`)
        .not.toContain(tag);
    }
    expect(parts.stableSystem).not.toContain('第1轮待办');
    expect(parts.stableSystem).not.toContain('第1轮笔记');

    const volatile = parts.turnVolatile!;
    expect(volatile).toContain('<active_todos>');
    expect(volatile).toContain('<canvas_note>');
  });

  it('emitted_tools_serialization_is_strict_byte_prefix_of_later_rounds', () => {
    let sessionBaseline: string[] = [];

    // Round 1: alphabetical baseline, emitted.
    const round1Local = [...sessionBaseline];
    const round1Tools = [toolSchema('zeta_tool', 'Z'), toolSchema('alpha_tool', 'A')];
    freezeToolSchemaOrderForPromptCache(round1Tools, round1Local);
    mergeFrozenToolSchemaOrderBaseline(sessionBaseline, round1Local);
    const round1Bytes = toolsBytes(round1Tools);

    // Round 2: process restart (persisted roundtrip), reordered sources, and
    // an in-loop load_skills disclosure whose name sorts between emitted tools.
    const round2Local = persistRoundtrip(sessionBaseline);
    const round2Tools = [
      toolSchema('beta_tool', 'B'), toolSchema('alpha_tool', 'A'), toolSchema('zeta_tool', 'Z'),
    ];
    freezeToolSchemaOrderForPromptCache(round2Tools, round2Local);
    mergeFrozenToolSchemaOrderBaseline(sessionBaseline, round2Local);
    const round2Bytes = toolsBytes(round2Tools);

    const round1Prefix = round1Bytes.subarray(0, round1Bytes.length - 1);
    expect(round2Bytes.subarray(0, round1Prefix.length).equals(round1Prefix)).toBe(true);
    expect(round2Tools.map(tool => toolSchemaSortKey(tool)))
      .toEqual(['alpha_tool', 'zeta_tool', 'beta_tool']);

    // Round 3: same tools after another roundtrip — byte identical.
    const round3Local = persistRoundtrip(sessionBaseline);
    const round3Tools = [
      toolSchema('zeta_tool', 'Z'), toolSchema('beta_tool', 'B'), toolSchema('alpha_tool', 'A'),
    ];
    freezeToolSchemaOrderForPromptCache(round3Tools, round3Local);
    expect(toolsBytes(round3Tools).equals(round2Bytes)).toBe(true);
  });

  it('combined_request_prefix_only_grows_at_the_tail_across_rounds', () => {
    let sessionBaseline: string[] = [];

    const parts1 = buildRound(1);
    const local1 = [...sessionBaseline];
    const tools1 = [toolSchema('builtin-web_search', '搜索'), toolSchema('builtin-todo_update', '待办')];
    freezeToolSchemaOrderForPromptCache(tools1, local1);
    mergeFrozenToolSchemaOrderBaseline(sessionBaseline, local1);
    const prefix1 = Buffer.concat([Buffer.from(parts1.stableSystem, 'utf8'), toolsBytes(tools1)]);

    const parts2 = buildRound(2);
    const local2 = persistRoundtrip(sessionBaseline);
    const tools2 = [
      toolSchema('builtin-anki_generate', '制卡'),
      toolSchema('builtin-todo_update', '待办'),
      toolSchema('builtin-web_search', '搜索'),
    ];
    freezeToolSchemaOrderForPromptCache(tools2, local2);
    mergeFrozenToolSchemaOrderBaseline(sessionBaseline, local2);
    const prefix2 = Buffer.concat([Buffer.from(parts2.stableSystem, 'utf8'), toolsBytes(tools2)]);

    const comparable = prefix1.subarray(0, prefix1.length - 1);
    expect(prefix2.subarray(0, comparable.length).equals(comparable)).toBe(true);
  });
});
