/**
 * Generative UI — Zod Schema 校验层
 *
 * 模型输出必须经过 schema 校验；不合法则拒绝或降级 fallback。
 */

import { z } from 'zod';

/** 块意图 schema */
export const generativeBlockIntentSchema = z.object({
  type: z.string().min(1).max(64),
  props: z.record(z.string(), z.unknown()).optional().default({}),
  id: z.string().max(128).optional(),
});

/** 完整 UI 意图文档 schema */
export const generativeUIIntentSchema = z.object({
  version: z.literal('1').optional().default('1'),
  blocks: z.array(generativeBlockIntentSchema).min(0).max(32),
  meta: z
    .object({
      title: z.string().max(200).optional(),
      description: z.string().max(1000).optional(),
    })
    .optional(),
});

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
export function parseGenerativeUIIntent(raw: string): {
  ok: true;
  intent: GenerativeUIIntentSchema;
} | {
  ok: false;
  errors: string[];
} {
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
  const result = schema.safeParse(props);
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
