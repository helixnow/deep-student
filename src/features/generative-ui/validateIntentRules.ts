/**
 * Generative UI — intent 规则校验（Rust `validate_genui_intent_rules` 的 TS 镜像）
 *
 * Rust（src-tauri/crates/dstu-agent/src/chat_v2/tools/genui_interaction.rs）为准；本文件用于：
 * - 客户端预校验 / 测试（mode='tool'，与 genui_intent_rules_fixtures.json 一致性测试锁住）；
 * - 正文内联 ```genui（mode='inline'）：额外拒绝 choice/form、followup:*、非 INLINE_SAFE action、
 *   researchSessionId、noteEdit、awaitAnswer。
 *
 * 只检查「规则」：交互块数量/id/props 约束、图片来源与计数、followup。
 * 块 type 白名单、版本、块数上限由 parseGenerativeUIIntent / Rust parse_intent 负责。
 */

import {
  choicePropsSchema,
  formPropsSchema,
  generativeImageSourceSchema,
  imageBlockPropsSchema,
  isFollowupActionId,
  type ChoiceProps,
  type FormProps,
} from './schema';
import {
  GENUI_FOLLOWUP_ACTION_ID_RE,
  GENUI_FOLLOWUP_PROMPT_MAX_CHARS,
  GENUI_INTERACTIVE_ID_RE,
  GENUI_MAX_FOLLOWUP_ACTIONS,
  GENUI_MAX_IMAGE_REFS,
  GENUI_MAX_INTERACTIVE_BLOCKS,
  countGenuiChars,
} from './interaction/limits';
import { sanitizeGenerativeTextLeaves } from './utils/sanitizeGenerativeText';

export type ValidateIntentRulesMode = 'tool' | 'inline';

export interface ValidateIntentRulesOptions {
  mode: ValidateIntentRulesMode;
  /** 仅 mode='tool'：工具参数 awaitAnswer（缺省 false） */
  awaitAnswer?: boolean;
}

export type InteractiveBlockSpec =
  | { type: 'choice'; blockId: string; props: ChoiceProps }
  | { type: 'form'; blockId: string; props: FormProps };

/** 对应 Rust GenUiAwaitSpec：按 intent 顺序的交互块（props 已套默认值） */
export interface GenUiAwaitSpec {
  blocks: InteractiveBlockSpec[];
}

export type GenUiIntentRuleCode =
  | 'intent_invalid'
  | 'interactive_requires_await'
  | 'await_requires_interactive'
  | 'too_many_interactive'
  | 'interactive_id_invalid'
  | 'interactive_id_duplicate'
  | 'interactive_props_invalid'
  | 'image_source_invalid'
  | 'image_props_invalid'
  | 'too_many_images'
  | 'followup_invalid'
  | 'too_many_followups'
  | 'inline_interactive_forbidden'
  | 'inline_action_forbidden'
  | 'inline_field_forbidden';

export type ValidateIntentRulesResult =
  | { ok: true; spec: GenUiAwaitSpec | null }
  | { ok: false; code: GenUiIntentRuleCode; error: string };

/** 内联只展示时允许的 action：copy-block、copy-intent、open-note:*、open-pdf:*（含 open-pdf-page:*） */
export const INLINE_SAFE_ACTION_IDS = ['copy-block', 'copy-intent'] as const;
export const INLINE_SAFE_ACTION_PREFIXES = ['open-note:', 'open-pdf:', 'open-pdf-page:'] as const;

export function isInlineSafeActionId(id: unknown): boolean {
  if (typeof id !== 'string') return false;
  if ((INLINE_SAFE_ACTION_IDS as readonly string[]).includes(id)) return true;
  return INLINE_SAFE_ACTION_PREFIXES.some((prefix) => id.startsWith(prefix) && id.length > prefix.length);
}

export const GENUI_INTERACTIVE_REQUIRES_AWAIT_MESSAGE = 'choice/form 仅在 awaitAnswer=true 时可用';
export const GENUI_AWAIT_REQUIRES_INTERACTIVE_MESSAGE =
  'awaitAnswer=true 时至少需要一个 choice/form 交互块';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(code: GenUiIntentRuleCode, error: string): ValidateIntentRulesResult {
  return { ok: false, code, error };
}

function zodIssuesToText(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

export function validateIntentRules(
  intent: unknown,
  options: ValidateIntentRulesOptions,
): ValidateIntentRulesResult {
  const inline = options.mode === 'inline';
  const awaitAnswer = !inline && options.awaitAnswer === true;

  if (!isRecord(intent) || !Array.isArray(intent.blocks)) {
    return fail('intent_invalid', 'intent 必须是带 blocks 数组的对象');
  }

  if (inline) {
    const meta = isRecord(intent.meta) ? intent.meta : undefined;
    if (intent.researchSessionId !== undefined || meta?.researchSessionId !== undefined) {
      return fail('inline_field_forbidden', '内联界面不支持 researchSessionId');
    }
    if (intent.noteEdit !== undefined || meta?.noteEdit !== undefined) {
      return fail('inline_field_forbidden', '内联界面不支持 noteEdit');
    }
    if (intent.awaitAnswer !== undefined) {
      return fail('inline_field_forbidden', '内联界面不支持 awaitAnswer');
    }
  }

  if (!intent.blocks.every(isRecord)) {
    return fail('intent_invalid', 'intent.blocks 的每一项都必须是对象');
  }
  const blocks = intent.blocks as Record<string, unknown>[];

  // ---- 交互块 ----
  const interactive = blocks.filter((b) => b.type === 'choice' || b.type === 'form');
  if (inline && interactive.length > 0) {
    return fail('inline_interactive_forbidden', '内联界面只做展示，不支持 choice/form');
  }
  if (!awaitAnswer && interactive.length > 0) {
    return fail('interactive_requires_await', GENUI_INTERACTIVE_REQUIRES_AWAIT_MESSAGE);
  }
  if (awaitAnswer && interactive.length === 0) {
    return fail('await_requires_interactive', GENUI_AWAIT_REQUIRES_INTERACTIVE_MESSAGE);
  }
  if (interactive.length > GENUI_MAX_INTERACTIVE_BLOCKS) {
    return fail(
      'too_many_interactive',
      `交互块（choice/form）最多 ${GENUI_MAX_INTERACTIVE_BLOCKS} 个，当前 ${interactive.length} 个`,
    );
  }

  const allIds = new Map<string, number>();
  for (const block of blocks) {
    if (typeof block.id === 'string') allIds.set(block.id, (allIds.get(block.id) ?? 0) + 1);
  }

  const specBlocks: InteractiveBlockSpec[] = [];
  for (const block of interactive) {
    const type = block.type as 'choice' | 'form';
    const id = block.id;
    if (typeof id !== 'string' || !GENUI_INTERACTIVE_ID_RE.test(id)) {
      return fail('interactive_id_invalid', `${type} 块必须有合法 id（^[A-Za-z0-9_-]{1,64}$）`);
    }
    if ((allIds.get(id) ?? 0) > 1) {
      return fail('interactive_id_duplicate', `交互块 id 重复：${id}`);
    }
    const props = sanitizeGenerativeTextLeaves(isRecord(block.props) ? block.props : {});
    if (type === 'choice') {
      const parsed = choicePropsSchema.safeParse(props);
      if (!parsed.success) {
        return fail('interactive_props_invalid', `choice 块 ${id} 不合法：${zodIssuesToText(parsed.error.issues)}`);
      }
      specBlocks.push({ type, blockId: id, props: parsed.data });
    } else {
      const parsed = formPropsSchema.safeParse(props);
      if (!parsed.success) {
        return fail('interactive_props_invalid', `form 块 ${id} 不合法：${zodIssuesToText(parsed.error.issues)}`);
      }
      specBlocks.push({ type, blockId: id, props: parsed.data });
    }
  }

  // ---- 图片来源与计数 ----
  let imageRefs = 0;
  const checkImageSource = (source: unknown, where: string): ValidateIntentRulesResult | null => {
    imageRefs += 1;
    const parsed = generativeImageSourceSchema.safeParse(source);
    if (!parsed.success) {
      return fail('image_source_invalid', `${where} 图片来源不合法：${zodIssuesToText(parsed.error.issues)}`);
    }
    return null;
  };
  for (const block of blocks) {
    const props = isRecord(block.props) ? block.props : {};
    if (block.type === 'image') {
      const where = `image 块${typeof block.id === 'string' ? ` ${block.id}` : ''}`;
      const err = checkImageSource(props.source, where);
      if (err) return err;
      const parsedImage = imageBlockPropsSchema.safeParse(sanitizeGenerativeTextLeaves(props));
      if (!parsedImage.success) {
        return fail('image_props_invalid', `${where} 不合法：${zodIssuesToText(parsedImage.error.issues)}`);
      }
    } else if (block.type === 'choice' && Array.isArray(props.options)) {
      for (const option of props.options) {
        if (isRecord(option) && option.image !== undefined) {
          const err = checkImageSource(option.image, `choice 选项${typeof option.id === 'string' ? ` ${option.id}` : ''}`);
          if (err) return err;
        }
      }
    }
  }
  if (imageRefs > GENUI_MAX_IMAGE_REFS) {
    return fail('too_many_images', `图片引用最多 ${GENUI_MAX_IMAGE_REFS} 个，当前 ${imageRefs} 个`);
  }

  // ---- action-bar：followup / 内联白名单 ----
  let followups = 0;
  for (const block of blocks) {
    if (block.type !== 'action-bar') continue;
    const props = isRecord(block.props) ? block.props : {};
    const actions = Array.isArray(props.actions) ? props.actions : [];
    for (const action of actions) {
      if (!isRecord(action)) continue;
      const id = action.id;
      if (inline && !isInlineSafeActionId(id)) {
        return fail('inline_action_forbidden', `内联界面不支持 action：${String(id)}`);
      }
      if (isFollowupActionId(id)) {
        followups += 1;
        if (!GENUI_FOLLOWUP_ACTION_ID_RE.test(id as string)) {
          return fail('followup_invalid', `followup action id 不合法：${String(id)}`);
        }
        const prompt = action.prompt;
        if (typeof prompt !== 'string' || prompt.trim().length === 0) {
          return fail('followup_invalid', `followup action ${String(id)} 必须带 prompt`);
        }
        if (countGenuiChars(prompt) > GENUI_FOLLOWUP_PROMPT_MAX_CHARS) {
          return fail(
            'followup_invalid',
            `followup action ${String(id)} 的 prompt 超过 ${GENUI_FOLLOWUP_PROMPT_MAX_CHARS} 字符`,
          );
        }
      } else if (action.prompt !== undefined) {
        return fail('followup_invalid', `只有 followup:* action 可以带 prompt：${String(id)}`);
      }
      if (action.confirm !== undefined && typeof action.confirm !== 'boolean') {
        return fail('followup_invalid', `action ${String(id)} 的 confirm 必须是布尔值`);
      }
    }
  }
  if (followups > GENUI_MAX_FOLLOWUP_ACTIONS) {
    return fail('too_many_followups', `followup action 最多 ${GENUI_MAX_FOLLOWUP_ACTIONS} 个，当前 ${followups} 个`);
  }

  return { ok: true, spec: awaitAnswer ? { blocks: specBlocks } : null };
}
