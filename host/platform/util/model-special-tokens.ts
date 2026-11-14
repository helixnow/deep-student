/**
 * `src-tauri/crates/dstu-util/src/utils/model_special_tokens.rs` 的逐行移植。
 *
 * 保守的流式清理：只移除 GLM/Qwen 协议泄漏的包装 token，不做全局字符串替换。
 * 生产策略由 `for_provider_model` 决定（provider 或模型命中才启用），
 * 过滤器本身是跨 lane 的单一共享实现：L02 选择策略，L01/L03 消费。
 */
import { isRustWhitespace, rustTrim, rustTrimEnd } from './text.ts';

/** 与 Rust `MODEL_SPECIAL_TOKENS` 同源；L16 等消费方应引用本常量而不是复制。 */
export const MODEL_SPECIAL_TOKENS: readonly string[] = [
  '<|begin_of_box|>',
  '<|end_of_box|>',
  '<|im_start|>',
  '<|im_end|>',
  '<|endoftext|>',
];

/** ChatML 模板中跟在 `<|im_start|>` 后的角色词（仅用于续写头规则）。 */
const CONTINUATION_ROLE_WORDS: readonly string[] = ['assistant', 'user', 'system'];

function is_continuation_role_word(word: string): boolean {
  return CONTINUATION_ROLE_WORDS.includes(word);
}

export const ModelWrapTokenPolicy = {
  Disabled: 'Disabled',
  GlmOrQwen: 'GlmOrQwen',
} as const;
export type ModelWrapTokenPolicy = typeof ModelWrapTokenPolicy[keyof typeof ModelWrapTokenPolicy];

/** Rust `str::to_ascii_lowercase`：只折叠 ASCII A-Z，非 ASCII 原样保留。 */
function asciiLower(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    out += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : value[index];
  }
  return out;
}

/**
 * 只对已知会泄漏 GLM/Qwen chat-template token 的路由启用清理。
 *
 * `provider_type` 覆盖一方 `qwen`/`zhipu` 路由；模型名匹配覆盖 OpenAI 兼容
 * provider（SiliconFlow、自定义端点）背后的同类模型。
 */
export function for_provider_model(
  provider_type: string | null | undefined,
  provider_scope: string | null | undefined,
  model: string,
): ModelWrapTokenPolicy {
  const affected_provider = [provider_type, provider_scope]
    .filter((value): value is string => value !== null && value !== undefined)
    .map(value => asciiLower(rustTrim(value)))
    .some(value => ['qwen', 'dashscope', 'zhipu', 'bigmodel'].includes(value));

  const normalized_model = asciiLower(rustTrim(model));
  const affected_model = normalized_model.includes('qwen')
    || normalized_model.includes('chatglm')
    || normalized_model
      .split(/[^A-Za-z0-9]/)
      .some(part => part.startsWith('glm') || part.startsWith('qwq') || part.startsWith('qvq'));

  return affected_provider || affected_model
    ? ModelWrapTokenPolicy.GlmOrQwen
    : ModelWrapTokenPolicy.Disabled;
}

/** 单一组合入口：消费方不应再自行拼 policy + filter。 */
export function create_model_wrap_token_filter(
  provider_type: string | null | undefined,
  provider_scope: string | null | undefined,
  model: string,
): ModelWrapTokenStreamFilter {
  return new ModelWrapTokenStreamFilter(for_provider_model(provider_type, provider_scope, model));
}

function is_enabled(policy: ModelWrapTokenPolicy): boolean {
  return policy === ModelWrapTokenPolicy.GlmOrQwen;
}

type WrapperFamily = 'Box' | 'Im';

function opening_family(token: string): WrapperFamily | null {
  switch (token) {
    case '<|begin_of_box|>': return 'Box';
    case '<|im_start|>': return 'Im';
    default: return null;
  }
}

function closing_family(token: string): WrapperFamily | null {
  switch (token) {
    case '<|end_of_box|>': return 'Box';
    case '<|im_end|>': return 'Im';
    default: return null;
  }
}

function token_at_start(text: string): string | null {
  return MODEL_SPECIAL_TOKENS.find(token => text.startsWith(token)) ?? null;
}

function is_incomplete_token_prefix(text: string): boolean {
  return text.length > 0 && MODEL_SPECIAL_TOKENS.some(token => token.startsWith(text));
}

type MarkdownCode =
  | { kind: 'Inline'; ticks: number }
  | { kind: 'Fenced'; marker: string; width: number };

/**
 * 流式、Markdown-aware 的模型包装 token 过滤器。
 *
 * 普通文本立即输出；只有可能的特殊 token 前缀和“仅由空白/token 组成的行首”
 * 会被短暂扣留，避免把正常流式输出变成整段缓冲。
 */
export class ModelWrapTokenStreamFilter {
  private policy: ModelWrapTokenPolicy;
  private input: string;
  /**
   * `input` 中第一个未消费字符的 UTF-16 偏移。始终落在字符边界
   * （只按完整 token/字符推进）。已消费前缀每轮 `process_available` 回收一次。
   */
  private inputCursor: number;
  private lineCandidate: string;
  private lineCandidateTokens: string[];
  private lineIsCandidate: boolean;
  private streamHasSubstantiveText: boolean;
  private code: MarkdownCode | null;
  private boxWrapperOpen: boolean;
  private imWrapperOpen: boolean;
  /** 行首孤立 `<|im_start|>` 后暂扣的角色词字符（续写头候选）。 */
  private roleSuffix: string;
  /** 粘在文本中间、可能属于流尾的 closer token（连同其后空白）。 */
  private tailHoldRaw: string;
  /** 同一段暂扣文本去掉 token 后的空白；流尾/续写头确认时输出。 */
  private tailHoldStripped: string;

  constructor(policy: ModelWrapTokenPolicy = ModelWrapTokenPolicy.Disabled) {
    this.policy = policy;
    this.input = '';
    this.inputCursor = 0;
    this.lineCandidate = '';
    this.lineCandidateTokens = [];
    this.lineIsCandidate = true;
    this.streamHasSubstantiveText = false;
    this.code = null;
    this.boxWrapperOpen = false;
    this.imWrapperOpen = false;
    this.roleSuffix = '';
    this.tailHoldRaw = '';
    this.tailHoldStripped = '';
  }

  process(chunk: string): string {
    if (!is_enabled(this.policy)) return chunk;
    this.input += chunk;
    return this.process_available(false);
  }

  flush(): string {
    if (!is_enabled(this.policy)) return '';

    let output = this.process_available(true);
    // 流正好结束在续写头（`…\n<|im_start|>assistant`）：丢弃它，
    // 并丢弃紧挨其前暂扣的流尾 closer。
    if (this.lineIsCandidate && this.is_continuation_role_header()) {
      this.record_stripped_candidate_tokens();
      this.clear_line_candidate();
      this.roleSuffix = '';
      this.drop_tail_hold_tokens();
    }
    // 粘在流末尾的 closer 是 stop-token 失败产物：丢 token 文本，保留空白。
    output += this.tailHoldStripped;
    this.tailHoldRaw = '';
    this.tailHoldStripped = '';
    if (this.lineIsCandidate) {
      if (this.roleSuffix !== '') {
        // opener + 不完整角色词：无法确认是续写头，保守地原样输出。
        output += this.lineCandidate;
        output += this.roleSuffix;
      } else if (this.lineCandidateTokens.length === 0 || this.code !== null) {
        output += this.lineCandidate;
      } else {
        this.record_stripped_candidate_tokens();
      }
      this.clear_line_candidate();
      this.roleSuffix = '';
    }
    return output;
  }

  reset(): void {
    const policy = this.policy;
    this.policy = policy;
    this.input = '';
    this.inputCursor = 0;
    this.lineCandidate = '';
    this.lineCandidateTokens = [];
    this.lineIsCandidate = true;
    this.streamHasSubstantiveText = false;
    this.code = null;
    this.boxWrapperOpen = false;
    this.imWrapperOpen = false;
    this.roleSuffix = '';
    this.tailHoldRaw = '';
    this.tailHoldStripped = '';
  }

  private process_available(flushing: boolean): string {
    let output = '';

    while (this.pending_input() !== '') {
      if (this.pending_input().startsWith('<')) {
        const token = token_at_start(this.pending_input());
        if (token !== null) {
          this.consume_prefix(token.length);
          // token 结束了任何待定角色词（该行不再是 opener + role + EOL）。
          output += this.release_role_suffix();
          output += this.process_token(token);
          continue;
        }
        if (!flushing && is_incomplete_token_prefix(this.pending_input())) break;
      }

      const codePoint = this.pending_input().codePointAt(0);
      if (codePoint === undefined) break;
      const ch = String.fromCodePoint(codePoint);
      if (ch === '`' || ch === '~') {
        let width = 0;
        while (this.pending_input().charCodeAt(width) === ch.charCodeAt(0)) width++;
        if (!flushing && width === this.pending_input().length) break;
        this.consume_prefix(width);
        output += this.release_role_suffix();
        output += this.process_marker_run(ch, width);
        continue;
      }

      this.consume_prefix(ch.length);
      if (ch === '\n') {
        output += this.process_newline();
      } else if (this.roleSuffix !== '') {
        output += this.process_role_suffix_char(ch);
      } else if (isRustWhitespace(codePoint) && this.lineIsCandidate) {
        this.lineCandidate += ch;
      } else if (this.lineIsCandidate && this.can_start_role_hold(ch)) {
        this.roleSuffix += ch;
      } else if (isRustWhitespace(codePoint) && !this.lineIsCandidate && this.tailHoldRaw !== '') {
        // 暂扣 closer 后的空白：仍可能是流尾，继续扣留。
        this.tailHoldRaw += ch;
        this.tailHoldStripped += ch;
      } else {
        output += this.begin_literal_content();
        output += ch;
        if (!isRustWhitespace(codePoint)) this.streamHasSubstantiveText = true;
      }
    }

    this.compact_input();
    return output;
  }

  /** 未消费的输入剩余部分。 */
  private pending_input(): string {
    return this.input.slice(this.inputCursor);
  }

  private consume_prefix(length: number): void {
    this.inputCursor += length;
  }

  /** 一轮结束时一次性回收已消费前缀，只保留暂扣的剩余。 */
  private compact_input(): void {
    if (this.inputCursor === 0) return;
    this.input = this.input.slice(this.inputCursor);
    this.inputCursor = 0;
  }

  /** 行首 `<|im_start|>` 后紧接角色词首字符：开始暂扣续写头候选。 */
  private can_start_role_hold(ch: string): boolean {
    return this.code === null
      && this.lineCandidateTokens.length === 1
      && this.lineCandidateTokens[0] === '<|im_start|>'
      && this.lineCandidate.endsWith('<|im_start|>')
      && CONTINUATION_ROLE_WORDS.some(word => word.startsWith(ch));
  }

  /** 用下一个字符扩展或放弃待定角色词。 */
  private process_role_suffix_char(ch: string): string {
    const trimmed = rustTrimEnd(this.roleSuffix);
    const hasTrailingWhitespace = trimmed !== this.roleSuffix;
    const extend = isRustWhitespace(ch.codePointAt(0)!)
      // 只有完整角色词后才可能跟尾随空白。
      ? is_continuation_role_word(trimmed)
      : !hasTrailingWhitespace
        && CONTINUATION_ROLE_WORDS.some(word => word.startsWith(this.roleSuffix + ch));

    if (extend) {
      this.roleSuffix += ch;
      return '';
    }
    let output = this.release_role_suffix();
    output += ch;
    if (!isRustWhitespace(ch.codePointAt(0)!)) this.streamHasSubstantiveText = true;
    return output;
  }

  private is_continuation_role_header(): boolean {
    return this.code === null
      && this.lineCandidateTokens.length === 1
      && this.lineCandidateTokens[0] === '<|im_start|>'
      && this.lineCandidate.endsWith('<|im_start|>')
      && is_continuation_role_word(rustTrimEnd(this.roleSuffix));
  }

  /** 放弃待定角色词：把暂扣的行前缀和角色字符按普通字面量输出。 */
  private release_role_suffix(): string {
    if (this.roleSuffix === '') return '';
    const suffix = this.roleSuffix;
    this.roleSuffix = '';
    let output = this.begin_literal_content();
    output += suffix;
    this.streamHasSubstantiveText = true;
    return output;
  }

  /** 原样输出暂扣流尾（closer token + 空白）：后续还有内容，说明是流中字面量。 */
  private release_tail_hold(): string {
    if (this.tailHoldRaw === '') return '';
    const output = this.tailHoldRaw;
    this.tailHoldRaw = '';
    this.tailHoldStripped = '';
    this.streamHasSubstantiveText = true;
    return output;
  }

  /** 确认暂扣流尾是失败产物：丢 token 文本，保留空白（换行）供后续输出。 */
  private drop_tail_hold_tokens(): void {
    this.tailHoldRaw = this.tailHoldStripped;
  }

  private process_token(token: string): string {
    if (this.code !== null) {
      let output = this.begin_literal_content();
      output += token;
      this.streamHasSubstantiveText = true;
      return output;
    }

    if (this.lineIsCandidate) {
      this.lineCandidate += token;
      this.lineCandidateTokens.push(token);
      return '';
    }

    const closeFamily = closing_family(token);
    const matching_close = closeFamily !== null && this.wrapper_is_open(closeFamily);
    const wrapped_end_of_text = token === '<|endoftext|>'
      && (this.boxWrapperOpen || this.imWrapperOpen);
    if (matching_close || wrapped_end_of_text) {
      this.record_stripped_token(token);
      return '';
    }
    if (closeFamily !== null || token === '<|endoftext|>') {
      // 流中不匹配的 closer：先扣留——若流到此结束就是 stop-token 失败尾；
      // 若后面还有内容则原样释放为字面量。
      this.tailHoldRaw += token;
      return '';
    }
    let output = this.release_tail_hold();
    output += token;
    this.streamHasSubstantiveText = true;
    return output;
  }

  private process_newline(): string {
    // CommonMark 的流式近似：行内代码不跨行，单个未配对反引号不会让后续流失效。
    if (this.code !== null && this.code.kind === 'Inline') this.code = null;

    // `<|im_start|>assistant`（角色词后直接行尾）是 stop-token 失败续写头：
    // 整行（含换行）丢弃，并把 opener 记为已剥离，使失控轮的 `<|im_end|>` 一并移除。
    if (this.lineIsCandidate && this.is_continuation_role_header()) {
      this.record_stripped_candidate_tokens();
      this.clear_line_candidate();
      this.roleSuffix = '';
      this.drop_tail_hold_tokens();
      this.lineIsCandidate = true;
      return '';
    }

    // 暂扣 closer 后紧跟换行：仍可能是流尾，继续扣留（换行的行状态效果照常应用）。
    if (!this.lineIsCandidate && this.tailHoldRaw !== '') {
      this.tailHoldRaw += '\n';
      this.tailHoldStripped += '\n';
      this.lineIsCandidate = true;
      return '';
    }

    let output = this.release_role_suffix();
    if (this.lineIsCandidate) {
      if (this.lineCandidateTokens.length > 0 && this.code === null) {
        // 删除仅由 token 组成的逻辑行（含换行）。
        this.record_stripped_candidate_tokens();
      } else if (this.tailHoldRaw !== '') {
        // 暂扣 closer 后只来了空白行：仍可能是流尾——连行带换行继续扣留。
        this.tailHoldRaw += this.lineCandidate;
        this.tailHoldRaw += '\n';
        this.tailHoldStripped += this.lineCandidate;
        this.tailHoldStripped += '\n';
      } else {
        output += this.release_tail_hold();
        output += this.lineCandidate;
        output += '\n';
      }
      this.clear_line_candidate();
    } else {
      output += this.release_tail_hold();
      output += '\n';
    }
    this.lineIsCandidate = true;
    return output;
  }

  private process_marker_run(marker: string, width: number): string {
    const can_be_fence = this.lineIsCandidate
      && this.lineCandidateTokens.length === 0
      && [...this.lineCandidate].every(ch => ch === ' ')
      && this.lineCandidate.length <= 3
      && width >= 3;

    let output = this.begin_literal_content();
    if (this.code !== null && this.code.kind === 'Fenced'
      && marker === this.code.marker && width >= this.code.width && can_be_fence) {
      output += marker.repeat(width);
      this.code = null;
    } else if (this.code !== null && this.code.kind === 'Inline'
      && marker === '`' && width === this.code.ticks) {
      output += marker.repeat(width);
      this.code = null;
    } else if (this.code !== null) {
      output += marker.repeat(width);
    } else if (can_be_fence) {
      output += marker.repeat(width);
      this.code = { kind: 'Fenced', marker, width };
    } else {
      output += marker.repeat(width);
      if (marker === '`') this.code = { kind: 'Inline', ticks: width };
    }
    this.streamHasSubstantiveText = true;
    return output;
  }

  private begin_literal_content(): string {
    // 实质内容到达：暂扣的“流尾”其实是流中字面量——先按流顺序释放。
    let output = this.release_tail_hold();
    if (!this.lineIsCandidate) return output;

    const candidate_is_leading_wrapper = !this.streamHasSubstantiveText
      && this.lineCandidateTokens.length > 0
      && this.lineCandidateTokens.every(token => opening_family(token) !== null);

    if (candidate_is_leading_wrapper && this.code === null) {
      output += [...this.lineCandidate]
        .filter(ch => isRustWhitespace(ch.codePointAt(0)!))
        .join('');
      this.record_stripped_candidate_tokens();
    } else {
      output += this.lineCandidate;
      if (this.lineCandidateTokens.length > 0) this.streamHasSubstantiveText = true;
    }

    this.clear_line_candidate();
    this.lineIsCandidate = false;
    return output;
  }

  private record_stripped_candidate_tokens(): void {
    const tokens = this.lineCandidateTokens;
    this.lineCandidateTokens = [];
    for (const token of tokens) this.record_stripped_token(token);
  }

  private record_stripped_token(token: string): void {
    const opening = opening_family(token);
    if (opening !== null) {
      if (opening === 'Box') this.boxWrapperOpen = true;
      else this.imWrapperOpen = true;
      return;
    }
    const closing = closing_family(token);
    if (closing !== null) {
      if (closing === 'Box') this.boxWrapperOpen = false;
      else this.imWrapperOpen = false;
    } else if (token === '<|endoftext|>') {
      this.boxWrapperOpen = false;
      this.imWrapperOpen = false;
    }
  }

  private wrapper_is_open(family: WrapperFamily): boolean {
    return family === 'Box' ? this.boxWrapperOpen : this.imWrapperOpen;
  }

  private clear_line_candidate(): void {
    this.lineCandidate = '';
    this.lineCandidateTokens = [];
  }
}
