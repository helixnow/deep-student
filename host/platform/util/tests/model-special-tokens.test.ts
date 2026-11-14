/**
 * `crates/dstu-util/src/utils/model_special_tokens.rs::tests` 的逐条移植。
 *
 * 生产代码：`host/platform/util/model-special-tokens.ts`（F4 单一共享实现）。
 * 每个测试标题保留 Rust 测试函数名，断言与 Rust 原测试一一对应。
 */
import { describe, expect, it } from 'vitest';
import type { ModelWrapTokenPolicy as PublishedPolicy } from '../api.ts';
import type { WrapTokenFilter } from '../../../plugins/chat-pipeline/api.ts';
import {
  ModelWrapTokenPolicy,
  ModelWrapTokenStreamFilter,
  create_model_wrap_token_filter,
  for_provider_model,
} from '../model-special-tokens.ts';

function enabled_filter(): ModelWrapTokenStreamFilter {
  return new ModelWrapTokenStreamFilter(ModelWrapTokenPolicy.GlmOrQwen);
}

function filter_chunks(chunks: readonly string[]): string {
  const filter = enabled_filter();
  let output = '';
  for (const chunk of chunks) output += filter.process(chunk);
  output += filter.flush();
  return output;
}

/** 不切开 UTF-16 surrogate pair 的中点。 */
function charBoundaryMid(value: string): number {
  let mid = Math.floor(value.length / 2);
  const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
  while (mid < value.length && isLowSurrogate(value.charCodeAt(mid))) mid++;
  return mid;
}

describe('dstu-util model_special_tokens.rs::tests', () => {
  it('policy_is_limited_to_glm_and_qwen_routes', () => {
    expect(for_provider_model('qwen', null, 'custom')).toBe(ModelWrapTokenPolicy.GlmOrQwen);
    expect(for_provider_model('openai', 'siliconflow', 'Qwen/Qwen3-8B'))
      .toBe(ModelWrapTokenPolicy.GlmOrQwen);
    expect(for_provider_model('openai', null, 'THUDM/glm-4-9b'))
      .toBe(ModelWrapTokenPolicy.GlmOrQwen);
    expect(for_provider_model('openai', null, 'gpt-5.6'))
      .toBe(ModelWrapTokenPolicy.Disabled);
  });

  it('policy_uses_ascii_only_lowercase_and_rust_trim', () => {
    // Rust `trim` 去 U+00A0；`to_ascii_lowercase` 只折叠 ASCII。
    expect(for_provider_model(' \tQWEN\u00a0', null, 'custom'))
      .toBe(ModelWrapTokenPolicy.GlmOrQwen);
    for (const provider of ['dashscope', 'zhipu', 'bigmodel']) {
      expect(for_provider_model(provider, null, 'custom'))
        .toBe(ModelWrapTokenPolicy.GlmOrQwen);
    }
    // 全角字符不是 ASCII 字母数字，不能被 Unicode lower 折叠成 qwen。
    expect(for_provider_model('openai', null, 'ｑｗｅｎ'))
      .toBe(ModelWrapTokenPolicy.Disabled);
    // 分段前缀：glm/qwq/qvq 必须在 ASCII 字母数字段首。
    expect(for_provider_model('openai', null, 'qwq-32b'))
      .toBe(ModelWrapTokenPolicy.GlmOrQwen);
    expect(for_provider_model('openai', null, 'qvq-max'))
      .toBe(ModelWrapTokenPolicy.GlmOrQwen);
    expect(for_provider_model('openai', null, 'xglm-4'))
      .toBe(ModelWrapTokenPolicy.Disabled);
  });

  it('disabled_policy_preserves_even_a_token_only_stream', () => {
    const filter = new ModelWrapTokenStreamFilter();
    expect(filter.process('<|im_end|>')).toBe('<|im_end|>');
    expect(filter.flush()).toBe('');
  });

  it('strips_token_only_stream_and_standalone_residual_line', () => {
    expect(filter_chunks(['<|end_of_box|>'])).toBe('');
    expect(filter_chunks(['答案\n', '<|end_of_box|>\n', '补充'])).toBe('答案\n补充');
  });

  it('strips_torn_outer_wrappers', () => {
    expect(filter_chunks(['<|begin_', 'of_box|>最终', '答案<|end', '_of_box|>']))
      .toBe('最终答案');
    expect(filter_chunks(['<|im_start|>\n', '回答\n', '<|im_end|>'])).toBe('回答\n');
  });

  it('preserves_literal_tokens_in_prose', () => {
    const prose = '请解释 <|im_end|> 的含义；<|begin_of_box|> 也可能是用户正文。';
    expect(filter_chunks([prose])).toBe(prose);
    expect(filter_chunks(['这一行以字面量 <|im_end|> 结尾']))
      .toBe('这一行以字面量 <|im_end|> 结尾');
  });

  it('preserves_literal_tokens_in_inline_and_fenced_code', () => {
    const markdown = '行内代码 `<|im_end|>` 保留。\n'
      + '```text\n'
      + '<|begin_of_box|>\n'
      + '<|im_end|>\n'
      + '```\n'
      + '~~~\n'
      + '<|endoftext|>\n'
      + '~~~';
    const chunks = [...markdown];
    expect(filter_chunks(chunks)).toBe(markdown);
  });

  it('reset_discards_partial_candidate_from_failed_attempt', () => {
    const filter = enabled_filter();
    expect(filter.process('<|im_')).toBe('');
    filter.reset();
    let output = filter.process('正常回答');
    output += filter.flush();
    expect(output).toBe('正常回答');
  });

  // ------------------------------------------------------------------
  // Stop-token failure: continuation header `<|im_start|>assistant`
  // ------------------------------------------------------------------

  it('strips_continuation_header_after_substantive_text', () => {
    // 典型失控轮形状：粘连 closer、续写头行、更多正文。
    expect(filter_chunks(['正文<|im_end|>\n', '<|im_start|>assistant\n', '继续的正文']))
      .toBe('正文\n继续的正文');
    // 按任意字符边界切块也必须一致。
    const full = '正文<|im_end|>\n<|im_start|>assistant\n继续的正文';
    expect(filter_chunks([...full])).toBe('正文\n继续的正文');
  });

  it('strips_continuation_header_for_all_known_roles', () => {
    for (const role of ['assistant', 'user', 'system']) {
      const input = `回答\n<|im_start|>${role}\n多余的续写`;
      expect(filter_chunks([input]), `role: ${role}`).toBe('回答\n多余的续写');
    }
  });

  it('strips_continuation_header_at_stream_head_and_at_flush', () => {
    // 流首整行头消失（旧实现会把角色词漏成正文）。
    expect(filter_chunks(['<|im_start|>assistant\n你好'])).toBe('你好');
    // 流正好结束在头上（stop 最终命中）：丢弃。
    expect(filter_chunks(['正文\n', '<|im_start|>assistant'])).toBe('正文\n');
    // 角色词后的尾随空白仍视为续写头。
    expect(filter_chunks(['正文\n<|im_start|>assistant \n续写'])).toBe('正文\n续写');
  });

  it('stripped_continuation_header_opens_wrapper_for_its_closer', () => {
    // 失控轮自己的 `<|im_end|>` 与被剥离的头配对。
    expect(filter_chunks(['正文\n<|im_start|>assistant\n续写<|im_end|>']))
      .toBe('正文\n续写');
  });

  it('preserves_role_word_lines_that_are_not_bare_headers', () => {
    // 行中提及：不是行首，原样保留。
    const prose = '标记 <|im_start|>assistant 用于协议说明。';
    expect(filter_chunks(['前文\n', prose])).toBe(`前文\n${prose}`);
    // 行首但角色词后还有内容：字面量。
    expect(filter_chunks(['前文\n<|im_start|>assistant 是协议头\n后文']))
      .toBe('前文\n<|im_start|>assistant 是协议头\n后文');
    // 角色词被扩展成更长的词：字面量。
    expect(filter_chunks(['前文\n<|im_start|>assistants\n后文']))
      .toBe('前文\n<|im_start|>assistants\n后文');
    // 流尾只有部分角色词：无法确认，原样输出。
    expect(filter_chunks(['前文\n<|im_start|>assi'])).toBe('前文\n<|im_start|>assi');
  });

  // ------------------------------------------------------------------
  // Stop-token failure: closer glued to the end of the stream
  // ------------------------------------------------------------------

  it('strips_tail_glued_closer_at_flush', () => {
    expect(filter_chunks(['回答完毕<|im_end|>'])).toBe('回答完毕');
    expect(filter_chunks(['回答完毕<|im_end|>', '<|endoftext|>'])).toBe('回答完毕');
    // closer 之间/之后的空白保留；token 文本不保留。
    expect(filter_chunks(['回答完毕<|im_end|>\n'])).toBe('回答完毕\n');
    expect(filter_chunks(['回答完毕<|end_of_box|> '])).toBe('回答完毕 ');
  });

  it('strips_tail_glued_closer_followed_by_blank_lines_at_flush', () => {
    // 回归：暂扣 closer 后第一个换行继续扣留，但后续空白行曾原样释放而泄漏 token。
    expect(filter_chunks(['回答完毕<|im_end|>\n\n'])).toBe('回答完毕\n\n');
    expect(filter_chunks(['回答完毕<|im_end|>\n \n'])).toBe('回答完毕\n \n');
    // 空白行后还有实质内容：仍按字面量释放。
    expect(filter_chunks(['字面<|im_end|>\n\n下一段正文']))
      .toBe('字面<|im_end|>\n\n下一段正文');
  });

  it('preserves_mid_stream_glued_closer_when_content_follows', () => {
    // 字面提及后还有正文：原样释放。
    expect(filter_chunks(['字面 <|im_end|> 后还有字'])).toBe('字面 <|im_end|> 后还有字');
    expect(filter_chunks(['字面<|im_end|>\n下一段正文']))
      .toBe('字面<|im_end|>\n下一段正文');
  });

  // ------------------------------------------------------------------
  // Inline-code state resets at end of line
  // ------------------------------------------------------------------

  it('unpaired_backtick_does_not_disable_filtering_past_the_line', () => {
    // 回归：孤立反引号曾永久锁住 Inline 状态，让后续所有 token 当代码内容放过。
    expect(filter_chunks(['看 `代码\n', '<|im_end|>\n', '尾行'])).toBe('看 `代码\n尾行');
    // 同一行的行内代码仍保护其 token。
    expect(filter_chunks(['行内 `<|im_end|>` 保留\n<|im_end|>\n尾行']))
      .toBe('行内 `<|im_end|>` 保留\n尾行');
  });

  // ------------------------------------------------------------------
  // Cursor-based input consumption (large-chunk regression)
  // ------------------------------------------------------------------

  it('large_single_chunk_keeps_semantics_with_cursor_consumption', () => {
    // 大块输入的游标消费回归：语义不变——前导包装及其配对 closer 仍被剥离，
    // 行中字面 token 后还有正文时仍原样保留。
    let body = '';
    for (let index = 0; index < 2_000; index++) {
      body += '第';
      body += String(index);
      body += '行正文，字面 <|im_end|> 保留。\n';
    }
    const input = `<|begin_of_box|>${body}<|end_of_box|>`;

    expect(filter_chunks([input])).toBe(body);

    // 同一流切成两个大块（切点不破坏字符边界）必须与单块结果一致。
    const mid = charBoundaryMid(input);
    expect(filter_chunks([input.slice(0, mid), input.slice(mid)])).toBe(body);
  });
});

describe('model wrap-token cross-lane contract', () => {
  it('published_chat_pipeline_wrap_token_interface_is_satisfied', () => {
    // `util/api.ts` 同时发布策略值与其类型；消费方可用 type-only import。
    const publishedPolicy: PublishedPolicy = ModelWrapTokenPolicy.GlmOrQwen;
    expect(publishedPolicy).toBe(ModelWrapTokenPolicy.GlmOrQwen);

    // L03 `chat-pipeline/api.ts::WrapTokenFilter` 是消费方公开面；F4 实现必须可直接注入。
    const enabled: WrapTokenFilter = create_model_wrap_token_filter('openai', null, 'Qwen/Qwen3-8B');
    expect(enabled.process('正常')).toBe('正常');
    expect(enabled.process('<|im_end|>')).toBe('');
    expect(enabled.flush()).toBe('');

    const disabled: WrapTokenFilter = new ModelWrapTokenStreamFilter();
    expect(disabled.process('<|im_end|>')).toBe('<|im_end|>');
    expect(disabled.flush()).toBe('');
  });
});
