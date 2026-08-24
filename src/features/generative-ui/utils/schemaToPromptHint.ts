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

  const candidate = schema as z.ZodType & {
    unwrap?: () => z.ZodType;
    innerType?: () => z.ZodType;
    def?: { innerType?: z.ZodType; schema?: z.ZodType };
    _def?: { innerType?: z.ZodType; schema?: z.ZodType };
  };
  if (!(schema instanceof z.ZodObject)) {
    if (typeof candidate.unwrap === 'function') {
      try {
        const inner = candidate.unwrap();
        if (inner && inner !== schema) return unwrapSchema(inner);
      } catch {
        /* ignore wrapper without unwrap */
      }
    }
    const inner = candidate.def?.innerType ?? candidate.def?.schema
      ?? candidate._def?.innerType ?? candidate._def?.schema;
    if (inner && inner !== schema) {
      return unwrapSchema(inner);
    }
  }
  return schema;
}

function isOptionalLike(schema: z.ZodType): boolean {
  return (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodDefault ||
    schema.safeParse(undefined).success
  );
}

function describeType(schema: z.ZodType, depth: number): string {
  const unwrapped = unwrapSchema(schema);

  if (unwrapped instanceof z.ZodEnum) {
    return unwrapped.options.join('|');
  }
  if (unwrapped instanceof z.ZodNumber) {
    return 'number';
  }
  if (unwrapped instanceof z.ZodBoolean) {
    return 'boolean';
  }
  if (unwrapped instanceof z.ZodString) {
    return 'string';
  }
  if (unwrapped instanceof z.ZodArray) {
    const itemHint = describeType(unwrapped.element as z.ZodType, depth + 1);
    return itemHint.startsWith('{') ? `[${itemHint}]` : `${itemHint}[]`;
  }
  if (unwrapped instanceof z.ZodObject) {
    if (depth >= 2) return 'object';
    return objectHint(unwrapped, depth);
  }
  if (unwrapped instanceof z.ZodUnion) {
    const options = (unwrapped.options as z.ZodType[]).map((option) => describeType(option, depth + 1));
    return options.join('|');
  }
  return 'object';
}

function objectHint(schema: z.ZodObject, depth: number): string {
  const entries = Object.entries(schema.shape).map(([key, fieldSchema]) => {
    const field = fieldSchema as z.ZodType;
    const optionalMark = isOptionalLike(field) ? '?' : '';
    const typeHint = describeType(field, depth + 1);
    return `${key}${optionalMark}: ${typeHint}`;
  });
  return `{ ${entries.join(', ')} }`;
}

/** 将 props schema 转为 prompt 字段摘要，如 `{ title: string, value: number, trend?: up|down|neutral }` */
export function schemaToPromptHint(schema: z.ZodType): string {
  const unwrapped = unwrapSchema(schema);
  if (!(unwrapped instanceof z.ZodObject)) {
    return describeType(schema, 0);
  }
  return objectHint(unwrapped, 0);
}
