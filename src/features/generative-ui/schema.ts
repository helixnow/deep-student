/**
 * Generative UI — Zod Schema 校验层
 *
 * 模型输出必须经过 schema 校验；不合法则拒绝或降级 fallback。
 */

import { z } from 'zod';
import type { GenerativeLayoutMode, GenerativeLayoutUnit, GenerativeUIIntent } from './types';
import { sanitizeResearchSessionId } from './utils/extractResearchSessionId';
import { sanitizeGenerativeTextLeaves } from './utils/sanitizeGenerativeText';
import {
  MAX_GENERATIVE_UI_STREAM_CHARS,
  STREAM_BUFFER_CAPPED_WARNING,
  isStreamBufferOverCap,
} from './utils/streamBufferGuard';

export const GENERATIVE_UI_INTENT_VERSIONS = ['1', '1.1'] as const;
export const GENERATIVE_LAYOUT_UNITS = [1, 2, 3] as const;

/** 将任意输入钳制到 1|2|3（非法 / 缺失走 fallback） */
export function clampGenerativeLayoutUnit(
  value: unknown,
  fallback: GenerativeLayoutUnit = 1,
): GenerativeLayoutUnit {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 1) return 1;
  if (n >= 3) return 3;
  return 2;
}

const optionalLayoutUnitSchema = z
  .number()
  .optional()
  .transform((n) => (typeof n === 'number' ? clampGenerativeLayoutUnit(n) : undefined));

/** 顶层 layout：stack 单列 / grid 2–3 列 */
export const generativeLayoutSchema = z.object({
  mode: z.enum(['stack', 'grid']),
  columns: optionalLayoutUnitSchema,
});

/** 块意图 schema */
export const generativeBlockIntentSchema = z.object({
  type: z.string().min(1).max(64),
  props: z.record(z.string(), z.unknown()).optional().default({}),
  id: z.string().max(128).optional(),
  span: optionalLayoutUnitSchema,
});

/** 与 schema max 对齐的块数上限 */
export const MAX_GENERATIVE_UI_BLOCKS = 32;

const generativeUIMetaSchema = z
  .object({
    title: z.string().max(200).optional(),
    description: z.string().max(1000).optional(),
    researchSessionId: z
      .unknown()
      .optional()
      .transform((value) => sanitizeResearchSessionId(value) ?? undefined),
  })
  .optional();

/** 完整 UI 意图文档 schema（version 默认仍为 '1'；未知 version 失败） */
export const generativeUIIntentSchema = z.object({
  version: z.enum(GENERATIVE_UI_INTENT_VERSIONS).optional().default('1'),
  layout: generativeLayoutSchema.optional(),
  blocks: z.array(generativeBlockIntentSchema).min(0).max(MAX_GENERATIVE_UI_BLOCKS),
  meta: generativeUIMetaSchema,
});

/** 解析后的布局：无 layout 字段视为 stack / 1 列；grid 缺省 columns=2 */
export function resolveGenerativeLayout(intent: Pick<GenerativeUIIntent, 'layout'>): {
  mode: GenerativeLayoutMode;
  columns: GenerativeLayoutUnit;
} {
  const mode: GenerativeLayoutMode = intent.layout?.mode === 'grid' ? 'grid' : 'stack';
  const raw = intent.layout?.columns;
  const columns =
    raw === undefined ? (mode === 'grid' ? 2 : 1) : clampGenerativeLayoutUnit(raw);
  return { mode, columns };
}

/**
 * 仅允许受控 Tailwind token，不把模型 class 透传到 DOM。
 * compact=true（窄屏 < sm）强制单列 stack + gap-2，不输出 sm:grid-cols-*，桌面默认签名不变。
 */
export function layoutGridClassName(
  mode: GenerativeLayoutMode,
  columns: GenerativeLayoutUnit,
  compact = false,
): string {
  if (compact) return 'grid gap-2';
  if (mode === 'grid' && columns === 2) return 'grid gap-3 sm:grid-cols-2';
  if (mode === 'grid' && columns === 3) return 'grid gap-3 sm:grid-cols-3';
  return 'grid gap-3';
}

export function layoutSpanClassName(
  mode: GenerativeLayoutMode,
  span?: GenerativeLayoutUnit,
  compact = false,
): string | undefined {
  if (compact || mode !== 'grid') return undefined;
  if (span === 2) return 'sm:col-span-2';
  if (span === 3) return 'sm:col-span-3';
  return undefined;
}

export type GenerativeBlockIntentSchema = z.infer<typeof generativeBlockIntentSchema>;
export type GenerativeUIIntentSchema = z.infer<typeof generativeUIIntentSchema>;

/** 各内置组件 props schema — 在 blocks/ 中扩展 */

export const statCardPropsSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1).max(120),
  value: z.union([z.string(), z.number()]),
  subtitle: z.string().max(200).optional(),
  trend: z.enum(['up', 'down', 'neutral']).optional(),
  trendLabel: z.string().max(80).optional(),
});

export const alertBlockPropsSchema = z.object({
  id: z.string().optional(),
  variant: z.enum(['default', 'info', 'warning', 'destructive']).optional().default('default'),
  title: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
});

export const listBlockPropsSchema = z.object({
  id: z.string().optional(),
  title: z.string().max(120).optional(),
  items: z
    .array(
      z.object({
        id: z.string().optional(),
        label: z.string().min(1).max(200),
        description: z.string().max(300).optional(),
        badge: z.string().max(40).optional(),
      }),
    )
    .min(0)
    .max(50),
  emptyLabel: z.string().max(80).optional(),
});

export const progressBlockPropsSchema = z.object({
  id: z.string().optional(),
  title: z.string().max(120).optional(),
  current: z.number().min(0),
  total: z.number().min(1),
  label: z.string().max(80).optional(),
});

export const actionBarPropsSchema = z.object({
  id: z.string().optional(),
  actions: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        label: z.string().min(1).max(60),
        variant: z.enum(['default', 'primary', 'destructive']).optional().default('default'),
        riskLevel: z.enum(['low', 'medium', 'high']).optional().default('low'),
      }),
    )
    .min(1)
    .max(6),
});

export const textBlockPropsSchema = z.object({
  id: z.string().optional(),
  heading: z.string().max(120).optional(),
  body: z.string().min(1).max(4000),
  density: z.enum(['compact', 'normal']).optional().default('normal'),
});

export const keyValueGridPropsSchema = z.object({
  id: z.string().optional(),
  title: z.string().max(120).optional(),
  rows: z
    .array(
      z.object({
        key: z.string().min(1).max(80),
        value: z.string().min(1).max(300),
      }),
    )
    .min(1)
    .max(20),
});

export type StatCardProps = z.infer<typeof statCardPropsSchema>;
export type AlertBlockProps = z.infer<typeof alertBlockPropsSchema>;
export type ListBlockProps = z.infer<typeof listBlockPropsSchema>;
export type ProgressBlockProps = z.infer<typeof progressBlockPropsSchema>;
export type ActionBarProps = z.infer<typeof actionBarPropsSchema>;
export type TextBlockProps = z.infer<typeof textBlockPropsSchema>;
export type KeyValueGridProps = z.infer<typeof keyValueGridPropsSchema>;

/** 从 JSON 字符串解析并校验 UI 意图 */
export function parseGenerativeUIIntent(
  raw: string,
  maxChars: number = MAX_GENERATIVE_UI_STREAM_CHARS,
): {
  ok: true;
  intent: GenerativeUIIntentSchema;
} | {
  ok: false;
  errors: string[];
} {
  if (isStreamBufferOverCap(raw.length, maxChars)) {
    return { ok: false, errors: [STREAM_BUFFER_CAPPED_WARNING] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, errors: [`Invalid JSON: ${(e as Error).message}`] };
  }

  const result = generativeUIIntentSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }
  return { ok: true, intent: result.data };
}

/** 校验单个块的 props（需已注册 type 的 schema） */
export function validateBlockProps<T>(
  schema: z.ZodType<T>,
  props: unknown,
): { ok: true; props: T } | { ok: false; errors: string[] } {
  const result = schema.safeParse(sanitizeGenerativeTextLeaves(props));
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }
  return { ok: true, props: result.data };
}

export type ParseGenerativeUIIntentResult = ReturnType<typeof parseGenerativeUIIntent>;
export type ValidateBlockPropsResult<T> = ReturnType<typeof validateBlockProps<T>>;

export function isGenerativeUIParseFailure(
  result: ParseGenerativeUIIntentResult,
): result is Extract<ParseGenerativeUIIntentResult, { ok: false }> {
  return result.ok === false;
}

export function isBlockPropsValidationFailure<T>(
  result: ValidateBlockPropsResult<T>,
): result is Extract<ValidateBlockPropsResult<T>, { ok: false }> {
  return result.ok === false;
}

export interface RecoveredBlockList {
  blocks: GenerativeBlockIntentSchema[];
  dropped: number;
  truncated: boolean;
  warnings: string[];
}

export interface RecoveredGenerativeUIIntent {
  intent: GenerativeUIIntentSchema;
  dropped: number;
  truncated: boolean;
  warnings: string[];
}

/** 从未知块列表抽出合法块：丢弃非法、id 去重（先到优先）、超过上限截断 */
export function recoverGenerativeBlocks(rawBlocks: unknown[]): RecoveredBlockList {
  const warnings: string[] = [];
  const seenIds = new Set<string>();
  const blocks: GenerativeBlockIntentSchema[] = [];
  let dropped = 0;
  let truncated = false;

  for (const raw of rawBlocks) {
    const result = generativeBlockIntentSchema.safeParse(raw);
    if (!result.success) {
      dropped += 1;
      continue;
    }

    const block = result.data;
    if (block.id) {
      if (seenIds.has(block.id)) {
        dropped += 1;
        warnings.push(`duplicate-id:${block.id}`);
        continue;
      }
      seenIds.add(block.id);
    }

    if (blocks.length >= MAX_GENERATIVE_UI_BLOCKS) {
      truncated = true;
      if (!warnings.includes('blocks-truncated')) {
        warnings.push('blocks-truncated');
      }
      continue;
    }

    blocks.push(block);
  }

  return { blocks, dropped, truncated, warnings };
}

/** 从已解析对象恢复意图（不要求整份 schema 一次通过） */
export function recoverGenerativeUIIntent(value: unknown): RecoveredGenerativeUIIntent | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.blocks)) return null;

  const recovered = recoverGenerativeBlocks(obj.blocks);
  const metaResult = generativeUIMetaSchema.safeParse(obj.meta);
  const layoutResult =
    obj.layout === undefined
      ? { success: true as const, data: undefined }
      : generativeLayoutSchema.safeParse(obj.layout);
  const version = obj.version === '1.1' ? '1.1' : '1';

  return {
    intent: {
      version,
      layout: layoutResult.success ? layoutResult.data : undefined,
      blocks: recovered.blocks,
      meta: metaResult.success ? metaResult.data : undefined,
    },
    dropped: recovered.dropped,
    truncated: recovered.truncated,
    warnings: recovered.warnings,
  };
}

/** 宽松 parse helper：完整 JSON 失败时尽量保留合法 blocks */
export function parseGenerativeUIIntentRecovered(
  input: string | unknown,
  maxChars: number = MAX_GENERATIVE_UI_STREAM_CHARS,
):
  | {
      ok: true;
      intent: GenerativeUIIntentSchema;
      dropped: number;
      truncated: boolean;
      warnings: string[];
    }
  | {
      ok: false;
      errors: string[];
    } {
  let value: unknown = input;
  if (typeof input === 'string') {
    if (isStreamBufferOverCap(input.length, maxChars)) {
      return { ok: false, errors: [STREAM_BUFFER_CAPPED_WARNING] };
    }
    try {
      value = JSON.parse(input);
    } catch (e) {
      return { ok: false, errors: [`Invalid JSON: ${(e as Error).message}`] };
    }
  }

  const recovered = recoverGenerativeUIIntent(value);
  if (!recovered) {
    return { ok: false, errors: ['Unable to recover UI intent'] };
  }
  return {
    ok: true,
    intent: recovered.intent,
    dropped: recovered.dropped,
    truncated: recovered.truncated,
    warnings: recovered.warnings,
  };
}
