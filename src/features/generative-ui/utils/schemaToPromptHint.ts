/**
 * 从 Zod props schema 提取 prompt 可读字段摘要（registry ↔ prompt 同步）
 */

import { z } from 'zod';

function unwrapSchema(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return unwrapSchema(schema.unwrap() as z.ZodType);
  }
  if (schema instanceof z.ZodNullable) {
    return unwrapSchema(schema.unwrap() as z.ZodType);
  }
  return schema;
}

function fieldSuffix(schema: z.ZodType): string {
  const unwrapped = unwrapSchema(schema);
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return '?';
  }
  if (unwrapped instanceof z.ZodEnum) {
    return `: ${unwrapped.options.join('|')}`;
  }
  if (unwrapped instanceof z.ZodNumber) {
    return ': number';
  }
  if (unwrapped instanceof z.ZodBoolean) {
    return ': boolean';
  }
  if (unwrapped instanceof z.ZodString) {
    return ': string';
  }
  if (unwrapped instanceof z.ZodArray) {
    return ': array';
  }
  if (unwrapped instanceof z.ZodObject) {
    return ': object';
  }
  return '';
}

/** 将 props schema 转为 prompt 字段摘要，如 `{ title: string, value: number, trend?: up|down|neutral }` */
export function schemaToPromptHint(schema: z.ZodType): string {
  const unwrapped = unwrapSchema(schema);
  if (!(unwrapped instanceof z.ZodObject)) {
    return 'object';
  }

  const entries = Object.entries(unwrapped.shape).map(([key, fieldSchema]) => {
    const optional =
      fieldSchema instanceof z.ZodOptional ||
      fieldSchema instanceof z.ZodDefault ||
      (fieldSchema as z.ZodType).safeParse(undefined).success;
    const suffix = fieldSuffix(fieldSchema as z.ZodType);
    return `${key}${optional ? '?' : ''}${suffix}`;
  });

  return `{ ${entries.join(', ')} }`;
}
